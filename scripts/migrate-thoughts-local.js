const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const storage = require('./storage');
const aiQueue = require('./ai-queue');

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        source: '',
        dryRun: false,
        backfill: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--backfill') args.backfill = true;
        else if (arg === '--source') args.source = argv[++i] || '';
        else if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    }

    return args;
}

function hashText(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function safeId(id) {
    return String(id || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

function normalizeTimestamp(value, fallback = Date.now()) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    return fallback;
}

function normalizeTag(value) {
    return String(value || '')
        .replace(/^#+/, '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 24);
}

function normalizeSubItems(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item, index) => {
            if (typeof item === 'string') {
                const text = item.trim();
                return text ? {
                    id: `legacy-sub-${index}-${hashText(text)}`,
                    text,
                    completed: false
                } : null;
            }

            const text = String(item?.text || item?.title || item?.content || '').trim();
            if (!text) return null;
            return {
                id: safeId(item?.id) || `legacy-sub-${index}-${hashText(text)}`,
                text,
                completed: !!(item?.completed || item?.done || item?.checked)
            };
        })
        .filter(Boolean);
}

function normalizeThought(raw, index) {
    const text = String(raw?.text || raw?.content || raw?.title || '').trim();
    const subItems = normalizeSubItems(raw?.subItems || raw?.subtasks || raw?.tasks || raw?.children);
    if (!text && subItems.length === 0) return null;

    const createdAt = normalizeTimestamp(raw?.createdAt || raw?.created_at || raw?.time || raw?.date, Date.now() + index);
    const updatedAt = normalizeTimestamp(raw?.updatedAt || raw?.updated_at || raw?.modifiedAt, createdAt);
    const id = safeId(raw?.id || raw?._id || raw?.uuid) || `legacy-${createdAt}-${hashText(`${text}:${index}`)}`;
    const tags = Array.from(new Map(
        (Array.isArray(raw?.tags) ? raw.tags : [])
            .map(normalizeTag)
            .filter(Boolean)
            .map(tag => [tag.toLowerCase(), tag])
    ).values());

    return {
        id,
        text,
        subItems,
        tags,
        completed: !!(raw?.completed || raw?.done),
        version: Number.isFinite(Number(raw?.version)) ? Number(raw.version) : 1,
        createdAt,
        updatedAt
    };
}

async function readSourceThoughts(sourcePath) {
    const raw = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    const thoughts = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.thoughts)
            ? raw.thoughts
            : Array.isArray(raw?.items)
                ? raw.items
                : null;

    if (!thoughts) {
        throw new Error('Source must be a JSON array, or an object with thoughts/items array');
    }

    return thoughts;
}

function thoughtFingerprint(thought) {
    return [
        String(thought.text || '').trim(),
        String(thought.createdAt || ''),
        (thought.tags || []).map(tag => tag.toLowerCase()).sort().join(',')
    ].join('\n');
}

async function backupCurrentThoughts(existingThoughts) {
    if (storage.backend !== 'local') return null;
    const legacyDir = path.join(storage.paths.DATA_DIR, 'legacy');
    await fs.mkdir(legacyDir, { recursive: true });
    const backupPath = path.join(legacyDir, `thoughts-before-import-${Date.now()}.json`);
    await fs.writeFile(backupPath, JSON.stringify(existingThoughts, null, 2), 'utf8');
    return backupPath;
}

async function migrate(options = {}) {
    const args = {
        ...parseArgs([]),
        ...options
    };
    const sourcePath = path.resolve(args.source || path.join(storage.paths.DATA_DIR, 'thoughts.json'));
    const sourceThoughts = await readSourceThoughts(sourcePath);
    const normalized = [];
    const invalid = [];

    sourceThoughts.forEach((thought, index) => {
        const next = normalizeThought(thought, index);
        if (next) normalized.push(next);
        else invalid.push({ index });
    });

    const existingThoughts = await storage.readThoughts();
    const existingIds = new Set(existingThoughts.map(thought => thought.id));
    const existingFingerprints = new Set(existingThoughts.map(thoughtFingerprint));
    const imported = [];
    const skipped = [];
    const seenIds = new Set();

    for (const thought of normalized) {
        const fingerprint = thoughtFingerprint(thought);
        if (existingIds.has(thought.id) || existingFingerprints.has(fingerprint) || seenIds.has(thought.id)) {
            skipped.push(thought.id);
            continue;
        }
        seenIds.add(thought.id);
        imported.push(thought);
    }

    const report = {
        source: sourcePath,
        dataDir: storage.paths.DATA_DIR,
        dryRun: !!args.dryRun,
        total: sourceThoughts.length,
        valid: normalized.length,
        invalid: invalid.length,
        imported: imported.length,
        skipped: skipped.length,
        backup: null,
        backfillProcessed: 0
    };

    if (args.dryRun) {
        console.log(JSON.stringify(report, null, 2));
        return report;
    }

    report.backup = await backupCurrentThoughts(existingThoughts);
    const nextThoughts = [...imported, ...existingThoughts]
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    await storage.saveThoughts(nextThoughts);
    await storage.rebuildIndexes();

    if (args.backfill && imported.length > 0) {
        aiQueue.init({ storage });
        for (const thought of imported) {
            await aiQueue.processThought(thought.id);
            report.backfillProcessed++;
        }
    }

    console.log(JSON.stringify(report, null, 2));
    return report;
}

if (require.main === module) {
    migrate(parseArgs()).catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    migrate,
    normalizeThought,
    parseArgs
};
