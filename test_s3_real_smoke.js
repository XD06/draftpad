const { spawn } = require('child_process');
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const s3 = require('./scripts/s3-service');

const PORT = Number(process.env.TEST_PORT || 19010);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REQUIRED_ENV = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_PREFIX'];
const REAL_SMOKE_CONFIRM_ENV = 'DUMBPAD_REAL_S3_SMOKE_CONFIRM_PREFIX';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function s3Key(key) {
    const prefix = String(process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
    const cleanKey = String(key || '').replace(/^\/+/, '');
    return prefix ? `${prefix}/${cleanKey}` : cleanKey;
}

async function request(route, options = {}) {
    const response = await fetch(`${BASE_URL}${route}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
    }
    return { response, body };
}

async function waitForServer(child) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Server exited early: ${child.exitCode}`);
        try {
            const { response } = await request('/health');
            if (response.ok) return;
        } catch {
            await sleep(200);
        }
    }
    throw new Error('Timed out waiting for real S3 smoke server');
}

async function waitForSearch(query) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
        const result = await request(`/api/search?q=${encodeURIComponent(query)}`);
        if (result.response.ok && result.body.results?.length) return result.body;
        await sleep(250);
    }
    throw new Error('Timed out waiting for real S3 search index');
}

async function cleanupPrefix() {
    s3.initS3();
    const entries = await s3.listObjects(s3Key(''));
    for (const entry of entries) {
        await s3.deleteObject(entry.key);
    }
}

async function run() {
    const missing = REQUIRED_ENV.filter(name => !process.env[name]);
    if (!process.env.S3_SECRET_KEY && !process.env.S3_API_KEY) missing.push('S3_SECRET_KEY or S3_API_KEY');
    if (missing.length) {
        throw new Error(`Missing required env for real S3 smoke: ${missing.join(', ')}`);
    }
    if (String(process.env[REAL_SMOKE_CONFIRM_ENV] || '').trim() !== String(process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '')) {
        throw new Error(
            `Real S3 smoke is destructive and requires ${REAL_SMOKE_CONFIRM_ENV} to exactly match S3_PREFIX.`
        );
    }

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-real-s3-'));
    const child = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            PORT: String(PORT),
            BASE_URL,
            DATA_DIR: dataDir,
            STORAGE_BACKEND: 's3',
            STORAGE_LAYOUT: 'split',
            DUMBPAD_PIN: 'x',
            NODE_ENV: 'development'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const logs = [];
    child.stdout.on('data', chunk => logs.push(String(chunk)));
    child.stderr.on('data', chunk => logs.push(String(chunk)));

    try {
        await waitForServer(child);

        let result = await request('/api/notepads', {
            method: 'POST',
            body: JSON.stringify({ name: 'Real S3 Smoke', content: 'real-s3-needle' })
        });
        assert(result.response.ok, 'real S3 POST /api/notepads should succeed');
        const notepadId = result.body.id;

        result = await request(`/api/notes/${notepadId}`);
        assert(result.response.ok, 'real S3 GET /api/notes/:id should succeed');
        assert(result.body.content === 'real-s3-needle', 'real S3 note content should roundtrip');

        await waitForSearch('real-s3-needle');

        result = await request(`/api/share/${notepadId}`);
        assert(result.response.ok, 'real S3 share API should succeed');
        const shareUrl = new URL(result.body.shareUrl);
        result = await request(`${shareUrl.pathname}${shareUrl.search}`);
        assert(result.response.ok, 'real S3 public share should render');
        assert(String(result.body).includes('real-s3-needle'), 'real S3 public share should include content');

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'real S3 thought source', subItems: [] })
        });
        assert(result.response.ok, 'real S3 source thought should save');
        const sourceId = result.body.id;

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'real S3 thought target', subItems: [] })
        });
        assert(result.response.ok, 'real S3 target thought should save');
        const targetId = result.body.id;

        await s3.putObject(s3Key(`thoughts.meta/${sourceId}.json`), JSON.stringify({ id: sourceId, status: 'ready' }), 'application/json');
        await s3.putObject(s3Key(`relations/${sourceId}.json`), JSON.stringify({
            id: sourceId,
            edges: [{
                targetId,
                score: 0.9,
                confidence: 0.8,
                relationType: 'supports',
                method: 'real-s3-smoke',
                reasons: ['smoke'],
                signals: { reranker: 0.91 }
            }]
        }), 'application/json');

        result = await request(`/api/thoughts/${sourceId}/relations`);
        assert(result.response.ok, 'real S3 relations should load');
        assert(result.body.relations.length === 1, 'real S3 relation should be visible');
        assert(result.body.relations[0].relationType === 'supports', 'real S3 relation should expose relationType');
        assert(result.body.relations[0].signals.reranker === 0.91, 'real S3 relation should expose signals');

        result = await request(`/api/thoughts/${sourceId}/relations/${targetId}`, { method: 'DELETE' });
        assert(result.response.ok, 'real S3 relation delete should succeed');
        assert(result.body.removed === true, 'real S3 relation delete should report removed');
        const suppressed = await s3.getJSONObject(s3Key(`relations.suppressed/${sourceId}.json`), null);
        assert(
            suppressed?.edges?.some(edge => edge.targetId === targetId && edge.reason === 'user_deleted'),
            'real S3 relation delete should record suppressed edge'
        );

        result = await request('/api/thoughts/ai-backfill', {
            method: 'POST',
            body: JSON.stringify({ limit: 3 })
        });
        assert(result.response.status === 202, 'real S3 core API should not depend on AI availability');

        console.log('Real S3 smoke checks passed');
    } catch (error) {
        console.error(logs.join(''));
        throw error;
    } finally {
        child.kill();
        await cleanupPrefix().catch(error => console.error('S3 cleanup failed:', error.message));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
