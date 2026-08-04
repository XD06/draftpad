const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19021;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function localDayKey(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

async function request(route, options = {}) {
    const response = await fetch(`${BASE_URL}${route}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
}

async function waitForServer(child) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Server exited early: ${child.exitCode}`);
        try {
            const { response } = await request('/health');
            if (response.ok) return;
        } catch (_error) {
            // The server is still starting.
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Timed out waiting for the today drafts test server');
}

function openWebSocket() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(BASE_URL.replace(/^http/, 'ws'));
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function nextSocketMessage(ws, predicate) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off('message', onMessage);
            reject(new Error('Timed out waiting for today draft WebSocket update'));
        }, 3000);
        function onMessage(raw) {
            const message = JSON.parse(String(raw));
            if (!predicate(message)) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(message);
        }
        ws.on('message', onMessage);
    });
}

function prepareDataDir() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-today-drafts-'));
    const now = Date.now();
    fs.writeFileSync(path.join(dataDir, 'notepads.json'), JSON.stringify({
        notepads: [{ id: 'default', name: 'Default Notepad', createdAt: now, updatedAt: now }]
    }));
    fs.writeFileSync(path.join(dataDir, 'default.txt'), '');
    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), '[]');
    fs.writeFileSync(path.join(dataDir, 'today-drafts.json'), JSON.stringify([
        { id: 'expired-draft', text: 'expired', completed: false, day: '2000-01-01', version: 1, createdAt: now, updatedAt: now },
        { id: 'bad id', text: 'invalid', completed: false, day: localDayKey(), version: 1, createdAt: now, updatedAt: now }
    ]));
    return dataDir;
}

function startServer(dataDir) {
    return spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            BASE_URL,
            DATA_DIR: dataDir,
            STORAGE_BACKEND: 'local',
            STORAGE_LAYOUT: 'legacy',
            DUMBPAD_PIN: '',
            AI_API_KEY: '',
            AI_INSIGHT_API_KEY: '',
            AI_INSIGHT_MODEL: '',
            AI_EMBEDDING_API_KEY: '',
            OPENCODE_API_KEY: '',
            SILICON_API_KEY: '',
            NODE_ENV: 'test'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

async function run() {
    const dataDir = prepareDataDir();
    const child = startServer(dataDir);
    try {
        await waitForServer(child);
        const today = localDayKey();

        let result = await request('/api/today-drafts');
        assert(result.response.ok, 'GET /api/today-drafts should list the current day');
        assert(result.body.day === today && Array.isArray(result.body.items), 'today draft list should be date-scoped and object-shaped');
        assert(!result.body.items.some(item => item.id === 'expired-draft'), 'a list request should purge expired drafts');
        assert(!result.body.items.some(item => item.id === 'bad id'), 'a list request should purge invalid persisted draft identifiers');

        result = await request('/api/today-drafts/x');
        assert(result.response.status === 400 && result.body.code === 'INVALID_TODAY_DRAFT_ID', 'single-draft endpoints should reject unsafe identifiers');

        const ws = await openWebSocket();
        const createEvent = nextSocketMessage(ws, message => message.type === 'today_drafts_update' && message.action === 'create');
        result = await request('/api/today-drafts/client-draft-1', {
            method: 'PUT',
            body: JSON.stringify({ text: 'reply to the team', completed: false })
        });
        assert(result.response.status === 201, 'PUT /api/today-drafts/:id should create a client-identified draft');
        assert(result.body.success === true && result.body.draft.version === 1, 'a created draft should include its initial version');
        assert(result.body.draft.day === today, 'the server should own the active day partition');
        const created = result.body.draft;
        const event = await createEvent;
        assert(event.payload?.id === created.id, 'today draft create should broadcast the affected record');

        result = await request(`/api/today-drafts/${created.id}`, {
            method: 'PUT',
            body: JSON.stringify({ text: 'reply to the whole team', completed: true, baseVersion: created.version })
        });
        assert(result.response.ok && result.body.draft.version === 2, 'PUT should update one draft with optimistic concurrency');
        const updated = result.body.draft;

        result = await request(`/api/today-drafts/${created.id}`, {
            method: 'PUT',
            body: JSON.stringify({ text: 'missing version' })
        });
        assert(result.response.status === 400 && result.body.code === 'BASE_VERSION_REQUIRED', 'updates should require the current draft version');

        result = await request(`/api/today-drafts/${created.id}`, {
            method: 'PUT',
            body: JSON.stringify({ text: 'stale edit', baseVersion: 1 })
        });
        assert(result.response.status === 409 && result.body.currentVersion === updated.version, 'stale draft edits should expose the current version');

        result = await request(`/api/today-drafts/${created.id}`, {
            method: 'DELETE',
            body: JSON.stringify({ baseVersion: updated.version })
        });
        assert(result.response.ok && result.body.deleted === true, 'DELETE should remove one current-day draft');

        result = await request(`/api/today-drafts/${created.id}`);
        assert(result.response.status === 404, 'a deleted today draft should not be readable');
        ws.close();
        console.log('Today drafts API checks passed');
    } finally {
        child.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
