// Regression for the /api/data-management/s3/backup overwrite guard:
//   - backup into an EMPTY prefix stays a non-destructive operation
//   - backup onto a NON-EMPTY prefix (overwrite risk, possibly another data
//     space) requires the global destructive flag AND confirmBackupPrefix
//   - dry-run is always allowed and never requires either
// Plus the s3-overwrite-local binary-exact restore. Drives the route
// handlers directly with stub context (no server, no S3).

const assert = require('assert');
const { registerDataManagementRoutes } = require('../routes/data-management-routes');

const DESTRUCTIVE_ENV = 'DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS';

function createContext({ spaceObjectCounts }) {
    const auditEvents = [];
    const backupCalls = [];
    const context = {
        storage: {
            backend: 's3',
            paths: { DATA_DIR: '/tmp/dumbpad-guard-test' },
            getS3Prefix: () => 'dumbpad/test'
        },
        s3PrefixTools: {
            inventoryPrefix: async (prefix) => ({
                prefix,
                objectCount: spaceObjectCounts[prefix] || 0,
                totalBytes: 0,
                groups: {}
            }),
            backupPrefix: async (source, target, { dryRun }) => {
                backupCalls.push({ source, target, dryRun });
                return {
                    action: 'backup',
                    sourcePrefix: source,
                    backupPrefix: target,
                    objectCount: 2,
                    totalBytes: 9,
                    dryRun,
                    copied: []
                };
            }
        },
        localToS3Migration: {},
        s3Service: {},
        auditLogger: { append: async (event) => { auditEvents.push(event); } }
    };
    return { context, auditEvents, backupCalls };
}

function createApp() {
    const routes = new Map();
    const app = {
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler)
    };
    return { app, routes };
}

function fakeRes() {
    const res = {
        statusCode: 200,
        body: null
    };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
}

async function callBackup({ context, routes }, body) {
    const handler = routes.get('POST /api/data-management/s3/backup');
    const req = { body, auth: { kind: 'legacy' }, ip: '127.0.0.1', path: '/api/data-management/s3/backup' };
    const res = fakeRes();
    await handler(req, res);
    return res;
}

async function testBackupGuard() {
    const { app, routes } = createApp();
    const { context, auditEvents, backupCalls } = createContext({
        spaceObjectCounts: { 'dumbpad/existing-space': 7 }
    });
    registerDataManagementRoutes(app, context);
    const previousFlag = process.env[DESTRUCTIVE_ENV];
    try {
        delete process.env[DESTRUCTIVE_ENV];

        // 1. dry-run onto an existing space: always allowed, no flag needed.
        let res = await callBackup({ routes }, { prefix: 'dumbpad/test', backupPrefix: 'dumbpad/existing-space', dryRun: true });
        if (res.statusCode !== 200 || res.body.dryRun !== true) throw new Error('dry-run backup should succeed');

        // 2. non-dry-run into an empty prefix: allowed without the flag.
        res = await callBackup({ routes }, { prefix: 'dumbpad/test', backupPrefix: 'dumbpad/fresh-backup', dryRun: false, confirmPrefix: 'dumbpad/test' });
        if (res.statusCode !== 200) throw new Error(`backup into empty prefix should succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`);

        // 3. non-dry-run onto a non-empty prefix without the flag: 403.
        res = await callBackup({ routes }, { prefix: 'dumbpad/test', backupPrefix: 'dumbpad/existing-space', dryRun: false, confirmPrefix: 'dumbpad/test' });
        if (res.statusCode !== 403) throw new Error(`overwrite backup without flag should be 403, got ${res.statusCode}`);

        // 4. flag on but backup prefix not confirmed: 400.
        process.env[DESTRUCTIVE_ENV] = 'true';
        res = await callBackup({ routes }, { prefix: 'dumbpad/test', backupPrefix: 'dumbpad/existing-space', dryRun: false, confirmPrefix: 'dumbpad/test', confirmBackupPrefix: 'dumbpad/other' });
        if (res.statusCode !== 400) throw new Error(`overwrite backup without confirmBackupPrefix should be 400, got ${res.statusCode}`);

        // 5. flag on + confirmBackupPrefix matches: succeeds and audits.
        const auditCountBefore = auditEvents.length;
        res = await callBackup({ routes }, { prefix: 'dumbpad/test', backupPrefix: 'dumbpad/existing-space', dryRun: false, confirmPrefix: 'dumbpad/test', confirmBackupPrefix: 'dumbpad/existing-space' });
        if (res.statusCode !== 200) throw new Error(`overwrite backup with flag+confirm should succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        if (auditEvents.length !== auditCountBefore + 1 || auditEvents[auditEvents.length - 1].details?.action !== 's3.backup-prefix') {
            throw new Error('overwrite backup must append an s3.backup-prefix audit event');
        }
        if (!backupCalls.some(call => call.target === 'dumbpad/existing-space' && call.dryRun === false)) {
            throw new Error('overwrite backup must actually run backupPrefix with dryRun=false');
        }

        console.log('Data management backup guard checks passed');
    } finally {
        if (previousFlag === undefined) delete process.env[DESTRUCTIVE_ENV];
        else process.env[DESTRUCTIVE_ENV] = previousFlag;
    }
}

// s3-overwrite-local must restore binary assets (assets/<id>/original) byte
// for byte. getObject-as-utf8 corrupts non-UTF-8 bytes into U+FFFD, so the
// payload here deliberately contains bytes that are invalid UTF-8.
async function testBinaryRestore() {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const dataDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-dm-restore-')), 'data');
    await fs.promises.mkdir(dataDir, { recursive: true });

    const binaryPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const prefix = 'dumbpad/test';
    const assetKey = `${prefix}/assets/abc123/original`;
    const context = {
        storage: {
            backend: 's3',
            paths: { DATA_DIR: dataDir },
            getS3Prefix: () => prefix
        },
        s3PrefixTools: {
            inventoryPrefix: async () => ({ prefix, objectCount: 1, totalBytes: binaryPayload.length, groups: {} })
        },
        localToS3Migration: {},
        s3Service: {
            listObjects: async () => [{ key: assetKey, size: binaryPayload.length, lastModified: null, etag: '' }],
            getObject: async () => { throw new Error('restore must not decode objects as utf8 strings'); },
            getObjectBuffer: async () => binaryPayload
        },
        auditLogger: { append: async () => {} }
    };

    const routes = new Map();
    registerDataManagementRoutes({
        get: () => {},
        post: (p, h) => routes.set(`POST ${p}`, h)
    }, context);

    const previousFlag = process.env[DESTRUCTIVE_ENV];
    process.env[DESTRUCTIVE_ENV] = 'true';
    try {
        const handler = routes.get('POST /api/data-management/s3-overwrite-local');
        const res = { statusCode: 200, body: null };
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => { res.body = payload; return res; };
        await handler({
            body: { prefix, targetDataDir: dataDir, dryRun: false, confirmPrefix: prefix },
            auth: { kind: 'legacy' },
            ip: '127.0.0.1',
            path: '/api/data-management/s3-overwrite-local'
        }, res);
        if (res.statusCode !== 200) throw new Error(`s3-overwrite-local should succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`);

        const restored = await fs.promises.readFile(path.join(dataDir, 'assets', 'abc123', 'original'));
        assert(restored.equals(binaryPayload), `restored asset must be byte-identical, got ${restored.toString('hex')}`);
        console.log('Data management binary restore checks passed');
    } finally {
        if (previousFlag === undefined) delete process.env[DESTRUCTIVE_ENV];
        else process.env[DESTRUCTIVE_ENV] = previousFlag;
    }
}

async function main() {
    await testBackupGuard();
    await testBinaryRestore();
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
