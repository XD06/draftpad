const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.STORAGE_BACKEND = 's3';
process.env.STORAGE_LAYOUT = 'split';
process.env.S3_BUCKET = 'dumbpad-test';
process.env.S3_ACCESS_KEY = 'test-access-key';
process.env.S3_SECRET_KEY = 'test-secret-key';
process.env.S3_REGION = 'us-east-1';
process.env.S3_PREFIX = '';
process.env.AI_API_KEY = '';
process.env.AI_INSIGHT_API_KEY = '';
process.env.AI_INSIGHT_MODEL = '';
process.env.AI_EMBEDDING_API_KEY = '';
process.env.AI_RERANK_API_KEY = '';
process.env.OPENCODE_API_KEY = '';
process.env.SILICON_API_KEY = '';
process.env.PORT = process.env.TEST_PORT || '19009';
process.env.BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.DUMBPAD_PIN = 'x';
process.env.NODE_ENV = 'development';
process.env.DATA_DIR = path.join(os.tmpdir(), `dumbpad-s3-api-${Date.now()}`);

const consoleErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => {
    consoleErrors.push(args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' '));
    originalConsoleError(...args);
};

const objects = new Map();
const fakeS3 = {
    async send(command) {
        const name = command.constructor.name;
        const input = command.input;

        if (name === 'HeadObjectCommand') {
            if (!objects.has(input.Key)) {
                const error = new Error('S3-compatible missing object');
                error.name = 'Unknown';
                error.$metadata = { httpStatusCode: 400 };
                throw error;
            }
            return { ContentLength: Buffer.byteLength(objects.get(input.Key)) };
        }

        if (name === 'PutObjectCommand') {
            objects.set(input.Key, Buffer.isBuffer(input.Body) ? input.Body.toString('utf8') : String(input.Body || ''));
            return {};
        }

        if (name === 'GetObjectCommand') {
            if (!objects.has(input.Key)) {
                const error = new Error('S3-compatible missing object');
                error.name = 'Unknown';
                error.$metadata = { httpStatusCode: 400 };
                throw error;
            }
            return { Body: Buffer.from(objects.get(input.Key)) };
        }

        if (name === 'DeleteObjectCommand') {
            objects.delete(input.Key);
            return {};
        }

        if (name === 'ListObjectsV2Command') {
            return {
                Contents: [...objects.keys()]
                    .filter(key => key.startsWith(input.Prefix || ''))
                    .map(key => ({ Key: key, Size: Buffer.byteLength(objects.get(key)) }))
            };
        }

        if (name === 'CopyObjectCommand') {
            const sourceKey = decodeURI(input.CopySource).replace(/^dumbpad-test\//, '');
            objects.set(input.Key, objects.get(sourceKey) || '');
            return {};
        }

        throw new Error(`Unhandled fake S3 command: ${name}`);
    }
};

const s3 = require('./scripts/s3-service');
s3.initS3({ client: fakeS3, bucket: 'dumbpad-test' });
s3.initS3 = () => fakeS3;

require('./server');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertDataCloudUiWiring() {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    assert(
        html.includes('id="settings-local-overwrite-cloud-dry-run"'),
        'settings UI should expose local-overwrite S3 dry-run button'
    );
    assert(
        appJs.includes("runCloudAction('local-overwrite-s3:dry-run')"),
        'settings UI should wire local-overwrite S3 dry-run action'
    );
    assert(
        html.includes('class="settings-cloud-main-actions"') &&
        html.includes('id="settings-auto-sync-status"') &&
        html.includes('<summary>高级维护</summary>'),
        'settings UI should keep primary cloud actions simple and fold maintenance controls'
    );
    assert(
        appJs.includes("runGuidedCloudAction('local-overwrite-s3:run'") &&
        appJs.includes("runGuidedCloudAction('s3-overwrite-local:run'"),
        'primary overwrite actions should preview before running'
    );
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(route, options = {}) {
    const response = await fetch(`${process.env.BASE_URL}${route}`, {
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

async function waitForServer() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try {
            const { response } = await request('/health');
            if (response.ok) return;
        } catch {
            await sleep(150);
        }
    }
    throw new Error('Timed out waiting for S3 regression server');
}

async function waitForSearch(query) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const result = await request(`/api/search?q=${encodeURIComponent(query)}`);
        if (result.response.ok && result.body.results?.length) return result.body;
        await sleep(200);
    }
    throw new Error('Timed out waiting for search index');
}

(async () => {
    assertDataCloudUiWiring();
    await waitForServer();

    const sourceDir = path.join(process.env.DATA_DIR, 'import-source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'notepads.json'), JSON.stringify({
        notepads: [{ id: 'default', name: 'Default Notepad' }]
    }));
    fs.writeFileSync(path.join(sourceDir, 'thoughts.json'), JSON.stringify([
        { id: 'source-thought', text: 'source thought' }
    ]));
    fs.writeFileSync(path.join(sourceDir, 'default.txt'), 'source note');
    const localRestoreDir = path.join(process.env.DATA_DIR, 'restore-target', 'data');
    fs.mkdirSync(localRestoreDir, { recursive: true });
    objects.set('restore-prefix/notepads.json', JSON.stringify({ notepads: [] }));
    objects.set('restore-prefix/default.txt', 'restore note');

    let result = await request('/api/data-management/status');
    assert(result.response.ok, 'S3 data-management status should succeed');
    assert(result.body.backend === 's3', 'data-management status should expose s3 backend');
    assert(result.body.s3.bucket === 'dumbpad-test', 'data-management status should expose bucket');

    result = await request('/api/data-management/s3/delete', {
        method: 'POST',
        body: JSON.stringify({ prefix: 'dumbpad', dryRun: false, confirmPrefix: 'wrong' })
    });
    assert(result.response.status === 400, 'confirmed S3 delete should reject mismatched confirm prefix');
    assert(
        !consoleErrors.some(line => line.includes('Confirm prefix must be exactly "dumbpad"')),
        'expected data-management 400 errors should not print server error stacks'
    );

    result = await request('/api/data-management/import-local-to-s3', {
        method: 'POST',
        body: JSON.stringify({
            sourceDataDir: sourceDir,
            prefix: 'preview-prefix',
            dryRun: true
        })
    });
    assert(result.response.ok, 'S3 import dry-run should succeed');
    assert(result.body.dryRun === true, 'S3 import dry-run should report dryRun');
    assert(result.body.sourceSummary.notepadCount === 1, 'S3 import dry-run should count notepads');
    assert(result.body.sourceSummary.thoughtCount === 1, 'S3 import dry-run should count thoughts');
    assert(!objects.has('preview-prefix/notepads.json'), 'S3 import dry-run should not upload objects');

    result = await request('/api/data-management/local-overwrite-s3', {
        method: 'POST',
        body: JSON.stringify({
            sourceDataDir: sourceDir,
            prefix: 'dumbpad',
            backupPrefix: 'dumbpad-backup',
            dryRun: true
        })
    });
    assert(result.response.ok, 'local overwrite S3 dry-run should succeed');
    assert(result.body.dryRun === true, 'local overwrite S3 dry-run should report dryRun');

    result = await request('/api/data-management/local-overwrite-s3', {
        method: 'POST',
        body: JSON.stringify({
            sourceDataDir: sourceDir,
            prefix: 'dumbpad',
            backupPrefix: 'dumbpad-backup',
            dryRun: false,
            confirmPrefix: 'wrong'
        })
    });
    assert(result.response.status === 400, 'local overwrite S3 should reject mismatched confirm prefix');
    assert(
        !consoleErrors.some(line => line.includes('Error overwriting S3 from local data')),
        'local overwrite S3 confirmation rejection should not log as server error'
    );

    result = await request('/api/data-management/s3-overwrite-local', {
        method: 'POST',
        body: JSON.stringify({
            prefix: 'restore-prefix',
            targetDataDir: localRestoreDir,
            dryRun: true
        })
    });
    assert(result.response.ok, 'S3 overwrite local dry-run should succeed');
    assert(result.body.inventory.objectCount === 2, 'S3 overwrite local dry-run should report prefix inventory');

    result = await request('/api/data-management/s3-overwrite-local', {
        method: 'POST',
        body: JSON.stringify({
            prefix: 'restore-prefix',
            targetDataDir: localRestoreDir,
            dryRun: false,
            confirmPrefix: 'wrong'
        })
    });
    assert(result.response.status === 400, 'S3 overwrite local should reject mismatched confirm prefix');
    assert(
        !consoleErrors.some(line => line.includes('Error overwriting local data from S3')),
        'S3 overwrite local confirmation rejection should not log as server error'
    );

    result = await request('/api/notepads', {
        method: 'POST',
        body: JSON.stringify({ name: 'S3 Regression', content: 'needle content' })
    });
    assert(result.response.ok, 'S3 POST /api/notepads should succeed');
    const notepadId = result.body.id;

    result = await request(`/api/notes/${notepadId}`);
    assert(result.response.ok, 'S3 GET /api/notes/:id should succeed');
    assert(result.body.content === 'needle content', 'S3 note content should be readable');

    await waitForSearch('needle');

    result = await request(`/api/share/${notepadId}`);
    assert(result.response.ok, 'S3 GET /api/share/:id should succeed');
    const sharePath = new URL(result.body.shareUrl).pathname + new URL(result.body.shareUrl).search;
    result = await request(sharePath);
    assert(result.response.ok, 'S3 public share route should render');
    assert(String(result.body).includes('needle content'), 'S3 share route should include note content');

    result = await request(`/api/notepads/${notepadId}`, { method: 'DELETE' });
    assert(result.response.ok, 'S3 DELETE notepad should succeed');
    assert(result.body.trashItem?.type === 'notepad', 'S3 DELETE notepad should create trash item');
    const trashIndex = JSON.parse(objects.get('trash/index.json'));
    const trashEntry = trashIndex.items.find(item => item.trashId === result.body.trashItem.trashId);
    assert(trashEntry, 'S3 trash index should include deleted notepad');
    assert(objects.has(trashEntry.payloadKey), 'S3 trash payload should be written separately');
    result = await request(`/api/trash/${trashEntry.trashId}/restore`, {
        method: 'POST',
        body: JSON.stringify({})
    });
    assert(result.response.ok, 'S3 trash restore should succeed');
    const restoredNotepadId = result.body.restored.item.id;
    result = await request(`/api/notes/${restoredNotepadId}`);
    assert(result.response.ok, 'S3 restored notepad should be readable');
    assert(result.body.content === 'needle content', 'S3 restored notepad should keep content');

    result = await request('/api/thoughts', {
        method: 'POST',
        body: JSON.stringify({ text: 'S3 thought source', subItems: [] })
    });
    assert(result.response.ok, 'S3 POST /api/thoughts source should succeed');
    const sourceId = result.body.id;

    result = await request('/api/thoughts', {
        method: 'POST',
        body: JSON.stringify({ text: 'S3 thought target', subItems: [] })
    });
    assert(result.response.ok, 'S3 POST /api/thoughts target should succeed');
    const targetId = result.body.id;

    objects.set(`thoughts.meta/${sourceId}.json`, JSON.stringify({ id: sourceId, status: 'ready' }));
    objects.set(`relations/${sourceId}.json`, JSON.stringify({
        id: sourceId,
        edges: [{
            targetId,
            score: 0.88,
            confidence: 0.77,
            relationType: 'supports',
            method: 'test',
            reasons: ['s3'],
            signals: { reranker: 0.9 }
        }]
    }));

    result = await request(`/api/thoughts/${sourceId}/relations`);
    assert(result.response.ok, 'S3 GET relations should succeed');
    assert(result.body.relations.length === 1, 'S3 relations should be readable');
    assert(result.body.relations[0].relationType === 'supports', 'S3 relations should expose relationType');
    assert(result.body.relations[0].signals.reranker === 0.9, 'S3 relations should expose signals');

    result = await request(`/api/thoughts/${sourceId}/relations/${targetId}`, { method: 'DELETE' });
    assert(result.response.ok, 'S3 DELETE relation should succeed');
    assert(result.body.removed === true, 'S3 DELETE relation should report removed');
    const suppressed = JSON.parse(objects.get(`relations.suppressed/${sourceId}.json`));
    assert(
        suppressed.edges.some(edge => edge.targetId === targetId && edge.reason === 'user_deleted'),
        'S3 DELETE relation should record suppressed edge'
    );

    result = await request('/api/thoughts/ai-backfill', {
        method: 'POST',
        body: JSON.stringify({ limit: 5 })
    });
    assert(result.response.status === 202, 'S3 AI backfill without AI key should not block core API');

    console.log('S3 storage regression checks passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
