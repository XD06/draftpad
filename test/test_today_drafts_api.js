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

function dayOffset(offset) {
    const shifted = new Date();
    shifted.setDate(shifted.getDate() + offset);
    return localDayKey(shifted);
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
        { id: 'out-of-window-draft', text: 'four days ago', completed: false, day: dayOffset(-3), version: 1, createdAt: now, updatedAt: now },
        { id: 'yesterday-draft', text: 'kept', completed: false, day: dayOffset(-1), version: 1, createdAt: now - 1, updatedAt: now - 1 },
        { id: 'day-before-draft', text: 'also kept', completed: true, day: dayOffset(-2), version: 1, createdAt: now - 2, updatedAt: now - 2 },
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
        assert(result.response.ok, 'GET /api/today-drafts should list the retention window');
        assert(result.body.day === today && Array.isArray(result.body.items), 'today draft list should be date-scoped and object-shaped');
        assert(!result.body.items.some(item => item.id === 'expired-draft'), 'a list request should purge expired drafts');
        assert(!result.body.items.some(item => item.id === 'out-of-window-draft'), 'drafts older than the 3-day window should be purged');
        assert(!result.body.items.some(item => item.id === 'bad id'), 'a list request should purge invalid persisted draft identifiers');
        const keptIds = result.body.items.map(item => item.id);
        assert(keptIds.includes('yesterday-draft') && keptIds.includes('day-before-draft'),
            'yesterday and the day before yesterday should survive inside the window');
        const yesterday = dayOffset(-1);
        assert(result.body.items.find(item => item.id === 'yesterday-draft')?.day === yesterday,
            'a kept draft should retain its own historical day');

        result = await request('/api/today-drafts/yesterday-draft');
        assert(result.response.ok && result.body.day === yesterday, 'a historical draft inside the window should be readable');

        result = await request('/api/today-drafts/yesterday-draft', {
            method: 'PUT',
            body: JSON.stringify({ text: 'edited two days later', baseVersion: 1 })
        });
        assert(result.response.ok && result.body.draft.day === yesterday && result.body.draft.version === 2,
            'updating a historical draft should keep its original day');

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
        assert(result.body.draft.day === today, 'a create without a day should be stamped with today');
        const created = result.body.draft;
        const event = await createEvent;
        assert(event.payload?.id === created.id, 'today draft create should broadcast the affected record');

        result = await request('/api/today-drafts/offline-create-1', {
            method: 'PUT',
            body: JSON.stringify({ text: 'created yesterday, synced today', day: yesterday })
        });
        assert(result.response.status === 201 && result.body.draft.day === yesterday,
            'a create may carry its original day when that day is inside the window');

        result = await request('/api/today-drafts/offline-create-2', {
            method: 'PUT',
            body: JSON.stringify({ text: 'stale day falls back', day: '2000-01-01' })
        });
        assert(result.response.status === 201 && result.body.draft.day === today,
            'a create with an out-of-window day should fall back to the server day');

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

        result = await request('/api/today-drafts/yesterday-draft', {
            method: 'DELETE',
            body: JSON.stringify({ baseVersion: 2 })
        });
        assert(result.response.ok && result.body.draft.day === yesterday,
            'DELETE should remove a historical draft inside the window');
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
