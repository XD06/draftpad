require('dotenv').config();

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        prefix: process.env.S3_PREFIX || '',
        limit: Infinity,
        force: false,
        concurrency: Number(process.env.AI_QUEUE_CONCURRENCY || 3),
        timeoutMs: Number(process.env.AI_BACKFILL_TIMEOUT_MS || 15 * 60 * 1000)
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--prefix') {
            args.prefix = argv[++i] || '';
        } else if (arg.startsWith('--prefix=')) {
            args.prefix = arg.slice('--prefix='.length);
        } else if (arg === '--limit') {
            args.limit = Number(argv[++i]);
        } else if (arg.startsWith('--limit=')) {
            args.limit = Number(arg.slice('--limit='.length));
        } else if (arg === '--force') {
            args.force = true;
        } else if (arg === '--concurrency') {
            args.concurrency = Number(argv[++i]);
        } else if (arg.startsWith('--concurrency=')) {
            args.concurrency = Number(arg.slice('--concurrency='.length));
        } else if (arg === '--timeout-ms') {
            args.timeoutMs = Number(argv[++i]);
        } else if (arg.startsWith('--timeout-ms=')) {
            args.timeoutMs = Number(arg.slice('--timeout-ms='.length));
        }
    }

    if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = Infinity;
    if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) args.concurrency = 3;
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = 15 * 60 * 1000;
    args.prefix = String(args.prefix || '').replace(/^\/+|\/+$/g, '');
    return args;
}

function stableThoughtSnapshot(thoughts = []) {
    return JSON.stringify(
        thoughts
            .map(thought => ({
                id: thought.id,
                text: thought.text || '',
                subItems: Array.isArray(thought.subItems) ? thought.subItems : [],
                tags: Array.isArray(thought.tags) ? thought.tags : [],
                completed: !!thought.completed,
                version: thought.version || 0,
                createdAt: thought.createdAt || 0,
                updatedAt: thought.updatedAt || 0
            }))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    );
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForQueue(aiQueue, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = aiQueue.getQueueStatus();
        if (!status.processing && status.queueSize === 0 && !status.currentJob) return status;
        await sleep(1000);
    }
    throw new Error(`Timed out waiting for AI queue after ${timeoutMs}ms`);
}

async function summarize(storage, thoughts) {
    const summary = {
        ready: 0,
        pending: 0,
        error: 0,
        empty: 0,
        missing: 0,
        relationFilesWithEdges: 0,
        totalRelationEdges: 0
    };

    for (const thought of thoughts) {
        const meta = await storage.readThoughtMeta(thought.id);
        const status = meta?.status || 'missing';
        if (Object.prototype.hasOwnProperty.call(summary, status)) {
            summary[status]++;
        } else {
            summary.missing++;
        }

        const relationCount = await storage.readRelationCount(thought.id);
        if (relationCount > 0) summary.relationFilesWithEdges++;
        summary.totalRelationEdges += relationCount;
    }

    return summary;
}

async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (!args.prefix) throw new Error('A non-empty --prefix is required');

    process.env.STORAGE_BACKEND = 's3';
    process.env.STORAGE_LAYOUT = 'split';
    process.env.S3_PREFIX = args.prefix;
    process.env.AI_QUEUE_CONCURRENCY = String(args.concurrency);

    const storage = require('./storage');
    const aiQueue = require('./ai-queue');

    aiQueue.init({ storage });

    const beforeThoughts = await storage.readThoughts();
    const beforeSnapshot = stableThoughtSnapshot(beforeThoughts);
    const queued = await aiQueue.backfillMissingMeta({ limit: args.limit, force: args.force });
    await waitForQueue(aiQueue, args.timeoutMs);

    const afterThoughts = await storage.readThoughts();
    const afterSnapshot = stableThoughtSnapshot(afterThoughts);
    const summary = await summarize(storage, afterThoughts);

    const result = {
        prefix: args.prefix,
        thoughtCountBefore: beforeThoughts.length,
        thoughtCountAfter: afterThoughts.length,
        queued: queued.queued,
        force: args.force,
        concurrency: args.concurrency,
        thoughtsUnchanged: beforeSnapshot === afterSnapshot,
        summary
    };

    console.log(JSON.stringify(result, null, 2));
    return result;
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    stableThoughtSnapshot,
    run
};
