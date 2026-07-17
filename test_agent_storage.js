const { spawnSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const contracts = require('./scripts/agent/agent-contracts');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createSourceRef() {
    return contracts.createSourceRef({
        kind: 'thought',
        id: 'thought-storage-source',
        version: 2,
        label: '存储来源 Thought',
        location: { start: 0, end: 8 },
        excerpt: 'AgentRun 存储来源'
    });
}

function createRun(id, now, key = '') {
    const sourceRef = createSourceRef();
    const run = contracts.createAgentRun({
        id,
        actorId: 'local-owner',
        objectScope: 'local-all',
        primarySource: sourceRef,
        allowedReadSet: [sourceRef],
        sourceSnapshot: {
            id: sourceRef.id,
            version: sourceRef.version,
            hash: 'b'.repeat(64)
        },
        now
    });
    return key ? { ...run, idempotencyKey: key } : run;
}

function completedRun(run, now) {
    return {
        ...run,
        status: 'completed',
        updatedAt: now,
        finishedAt: now,
        result: {
            summary: '相关内容已找到。',
            claims: [{ text: '来源来自本次受控读取。', citationIds: ['src_1'] }],
            citations: [{ citationId: 'src_1', sourceRef: run.primarySource }]
        }
    };
}

async function assertDedicatedLock(storage) {
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 5 }, () => storage.withAgentRunWriteLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active--;
    })));
    assert(maxActive === 1, 'AgentRun mutex must serialize only AgentRun tasks');
}

async function exerciseStorage(storage, {
    readText,
    writeText,
    exists,
    expectedRunPath,
    activeIndexPath,
    label
}) {
    await storage.init();
    const thoughtsBefore = await readText('thoughts.json');
    const notepadsBefore = await readText('notepads.json');
    const rawKey = `${label}-raw-idempotency-key`;
    const first = await storage.saveAgentRun(createRun(`agr_${label}_one`, 100, rawKey));

    assert(await exists(expectedRunPath(first.id)), `${label}: AgentRun must be saved under its dedicated safe path`);
    assert(!Object.hasOwn(first, 'idempotencyKey'), `${label}: save must strip raw idempotency keys`);
    assert(contracts.isSha256(first.idempotencyKeyHash), `${label}: save must retain an idempotency hash`);
    assert(first.sourceSnapshot?.hash === 'b'.repeat(64), `${label}: compact source snapshot must persist`);
    const storedText = await readText(expectedRunPath(first.id));
    assert(!storedText.includes(rawKey), `${label}: AgentRun record must not persist raw idempotency key`);

    let activeIndex = await storage.readAgentRunActiveIndex();
    assert(await storage.hasAgentRunActiveIndex(), `${label}: saving a run should create the active index`);
    assert(activeIndex.items.length === 1, `${label}: active index should include queued run`);
    assert(activeIndex.items[0].id === first.id, `${label}: active index should point at the saved run`);
    assert(!JSON.stringify(activeIndex).includes(rawKey), `${label}: active index must not contain raw idempotency key`);

    const running = await storage.saveAgentRun({
        ...first,
        status: 'running',
        startedAt: 120,
        updatedAt: 120,
        sourceStale: true
    });
    const terminal = await storage.saveAgentRun(completedRun(running, 140));
    assert(terminal.status === 'completed', `${label}: terminal AgentRun should save`);
    assert(terminal.sourceStale === true, `${label}: derived source stale flag should persist`);
    assert((await storage.readAgentRun(first.id)).status === 'completed', `${label}: terminal record should remain readable`);
    activeIndex = await storage.readAgentRunActiveIndex();
    assert(activeIndex.items.length === 0, `${label}: terminal AgentRun must be removed from active index`);

    const parallelRuns = await Promise.all([2, 3, 4].map(index => (
        storage.saveAgentRun(createRun(`agr_${label}_${index}`, 200 + index, `${label}-key-${index}`))
    )));
    const activeRuns = await storage.listActiveAgentRuns();
    assert(activeRuns.length === parallelRuns.length, `${label}: nonterminal list should return all active records`);
    assert(activeRuns.every(run => run.status === 'queued'), `${label}: active list must exclude completed record`);

    await writeText(activeIndexPath, JSON.stringify({
        version: 1,
        items: [{ idempotencyKey: rawKey, id: 'bogus' }]
    }));
    const rebuilt = await storage.rebuildAgentRunActiveIndex();
    assert(rebuilt.items.length === parallelRuns.length, `${label}: rebuild must scan nonterminal records and omit terminal runs`);
    const rebuiltText = await readText(activeIndexPath);
    assert(!rebuiltText.includes(rawKey), `${label}: rebuilt index must discard raw idempotency keys`);

    assert(await readText('thoughts.json') === thoughtsBefore, `${label}: AgentRun storage must not write Thought data`);
    assert(await readText('notepads.json') === notepadsBefore, `${label}: AgentRun storage must not write Notepad data`);
    await assertDedicatedLock(storage);
}

async function runLocal() {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dumbpad-agent-storage-local-'));
    process.env.DATA_DIR = dataDir;
    process.env.STORAGE_BACKEND = 'local';
    process.env.STORAGE_LAYOUT = 'legacy';
    const storage = require('./scripts/storage');

    try {
        await exerciseStorage(storage, {
            label: 'local',
            readText: relativePath => fsp.readFile(path.join(dataDir, relativePath), 'utf8'),
            writeText: (relativePath, content) => fsp.writeFile(path.join(dataDir, relativePath), content, 'utf8'),
            exists: relativePath => fs.existsSync(path.join(dataDir, relativePath)),
            expectedRunPath: id => path.join('agent-runs', `${id}.json`),
            activeIndexPath: path.join('agent-runs', 'active-index.json')
        });
    } finally {
        await fsp.rm(dataDir, { recursive: true, force: true });
    }
}

function createFakeS3() {
    const objects = new Map();
    return {
        objects,
        client: {
            async send(command) {
                const name = command.constructor.name;
                const input = command.input;
                if (name === 'PutObjectCommand') {
                    objects.set(input.Key, Buffer.isBuffer(input.Body) ? input.Body.toString('utf8') : String(input.Body || ''));
                    return {};
                }
                if (name === 'GetObjectCommand') {
                    if (!objects.has(input.Key)) {
                        const error = new Error('missing object');
                        error.name = 'NoSuchKey';
                        error.$metadata = { httpStatusCode: 404 };
                        throw error;
                    }
                    return { Body: Buffer.from(objects.get(input.Key)) };
                }
                if (name === 'HeadObjectCommand') {
                    if (!objects.has(input.Key)) {
                        const error = new Error('missing object');
                        error.name = 'NotFound';
                        error.$metadata = { httpStatusCode: 404 };
                        throw error;
                    }
                    return { ContentLength: Buffer.byteLength(objects.get(input.Key)) };
                }
                if (name === 'DeleteObjectCommand') {
                    objects.delete(input.Key);
                    return {};
                }
                if (name === 'ListObjectsV2Command') {
                    return {
                        Contents: Array.from(objects.entries())
                            .filter(([key]) => key.startsWith(input.Prefix || ''))
                            .map(([Key, value]) => ({ Key, Size: Buffer.byteLength(value) }))
                    };
                }
                throw new Error(`Unhandled fake S3 command: ${name}`);
            }
        }
    };
}

async function runS3() {
    const prefix = 'agent-storage-test';
    process.env.STORAGE_BACKEND = 's3';
    process.env.STORAGE_LAYOUT = 'legacy';
    process.env.S3_BUCKET = 'agent-storage-test';
    process.env.S3_ACCESS_KEY = 'test-access';
    process.env.S3_SECRET_KEY = 'test-secret';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_PREFIX = prefix;

    const fake = createFakeS3();
    const s3 = require('./scripts/s3-service');
    s3.initS3({ client: fake.client, bucket: process.env.S3_BUCKET });
    s3.initS3 = () => fake.client;
    const storage = require('./scripts/storage');

    await exerciseStorage(storage, {
        label: 's3',
        readText: async relativePath => {
            const value = fake.objects.get(`${prefix}/${relativePath.replace(/\\/g, '/')}`);
            if (value === undefined) throw new Error(`s3: missing object ${relativePath}`);
            return value;
        },
        writeText: async (relativePath, content) => {
            fake.objects.set(`${prefix}/${relativePath.replace(/\\/g, '/')}`, String(content));
        },
        exists: async relativePath => fake.objects.has(`${prefix}/${relativePath.replace(/\\/g, '/')}`),
        expectedRunPath: id => path.posix.join('agent-runs', `${id}.json`),
        activeIndexPath: path.posix.join('agent-runs', 'active-index.json')
    });
}

async function main() {
    if (process.env.DUMBPAD_AGENT_STORAGE_S3_CHILD === '1') {
        await runS3();
        console.log('AgentRun S3 storage checks passed');
        return;
    }

    await runLocal();
    const child = spawnSync(process.execPath, [__filename], {
        cwd: __dirname,
        env: { ...process.env, DUMBPAD_AGENT_STORAGE_S3_CHILD: '1' },
        encoding: 'utf8'
    });
    if (child.status !== 0) {
        throw new Error(`AgentRun S3 storage child failed: ${child.stderr || child.stdout}`);
    }
    process.stdout.write(child.stdout);
    console.log('AgentRun local storage checks passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
