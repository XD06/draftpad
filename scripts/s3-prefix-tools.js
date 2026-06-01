require('dotenv').config();

const path = require('path');
const s3 = require('./s3-service');

function cleanPrefix(prefix) {
    return String(prefix || '').replace(/^\/+|\/+$/g, '');
}

function cleanSpaceRoot(root) {
    return cleanPrefix(root || process.env.S3_SPACE_ROOT || 'dumbpad');
}

function ensurePrefix(prefix) {
    const clean = cleanPrefix(prefix);
    if (!clean) {
        throw new Error('A non-empty --prefix is required');
    }
    return clean;
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        action: 'inventory',
        prefix: process.env.S3_PREFIX || '',
        backupPrefix: '',
        dryRun: false,
        confirmPrefix: ''
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (['inventory', 'backup', 'delete'].includes(arg)) {
            args.action = arg;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--action') {
            args.action = argv[++i] || '';
        } else if (arg.startsWith('--action=')) {
            args.action = arg.slice('--action='.length);
        } else if (arg === '--prefix') {
            args.prefix = argv[++i] || '';
        } else if (arg.startsWith('--prefix=')) {
            args.prefix = arg.slice('--prefix='.length);
        } else if (arg === '--backup-prefix') {
            args.backupPrefix = argv[++i] || '';
        } else if (arg.startsWith('--backup-prefix=')) {
            args.backupPrefix = arg.slice('--backup-prefix='.length);
        } else if (arg === '--confirm-prefix') {
            args.confirmPrefix = argv[++i] || '';
        } else if (arg.startsWith('--confirm-prefix=')) {
            args.confirmPrefix = arg.slice('--confirm-prefix='.length);
        }
    }

    return args;
}

function groupForKey(key, prefix) {
    const relative = key.slice(prefix.length + 1);
    const parts = relative.split('/');
    if (parts.length < 2) return '(root)';
    return parts[0] || '(root)';
}

async function inventoryPrefix(prefix) {
    const clean = ensurePrefix(prefix);
    const objects = await s3.listObjects(`${clean}/`);
    const groups = {};
    let totalBytes = 0;

    for (const object of objects) {
        totalBytes += object.size || 0;
        const group = groupForKey(object.key, clean);
        if (!groups[group]) groups[group] = { count: 0, bytes: 0 };
        groups[group].count++;
        groups[group].bytes += object.size || 0;
    }

    return {
        prefix: clean,
        objectCount: objects.length,
        totalBytes,
        groups,
        objects
    };
}

function ensureSpace(spaces, { name, prefix, layout }) {
    if (!spaces.has(prefix)) {
        spaces.set(prefix, {
            name,
            prefix,
            layout,
            objectCount: 0,
            totalBytes: 0,
            lastModified: null,
            hasNotepads: false,
            hasThoughts: false,
            hasRelations: false
        });
    }
    return spaces.get(prefix);
}

const RESERVED_SPACE_DIRS = new Set([
    'thoughts',
    'thoughts.meta',
    'relations',
    'relations.suppressed',
    'indexes'
]);

function resolveSpaceForKey(key, root) {
    const normalized = String(key || '').replace(/^\/+/, '');
    if (!normalized) return null;

    if (normalized === root || normalized.startsWith(`${root}/`)) {
        const relative = normalized === root ? '' : normalized.slice(root.length + 1);
        const slashIndex = relative.indexOf('/');
        if (slashIndex > 0) {
            const name = relative.slice(0, slashIndex);
            if (RESERVED_SPACE_DIRS.has(name)) {
                return { name: root, prefix: root, layout: 'legacy-root', relative };
            }
            return { name, prefix: `${root}/${name}`, layout: 'nested', relative: relative.slice(slashIndex + 1) };
        }
        return { name: root, prefix: root, layout: 'legacy-root', relative };
    }

    if (normalized.startsWith(`${root}-`)) {
        const slashIndex = normalized.indexOf('/');
        const prefix = slashIndex === -1 ? normalized : normalized.slice(0, slashIndex);
        return {
            name: prefix.slice(root.length + 1) || prefix,
            prefix,
            layout: 'legacy-prefix',
            relative: slashIndex === -1 ? '' : normalized.slice(slashIndex + 1)
        };
    }

    return null;
}

async function listSpaces({ root = process.env.S3_SPACE_ROOT || 'dumbpad' } = {}) {
    const spaceRoot = cleanSpaceRoot(root);
    const objects = await s3.listObjects('');
    const spaces = new Map();

    for (const object of objects) {
        const resolved = resolveSpaceForKey(object.key, spaceRoot);
        if (!resolved) continue;

        const space = ensureSpace(spaces, resolved);
        space.objectCount++;
        space.totalBytes += object.size || 0;
        if (!space.lastModified || (object.lastModified && new Date(object.lastModified) > new Date(space.lastModified))) {
            space.lastModified = object.lastModified;
        }
        if (resolved.relative === 'notepads.json') space.hasNotepads = true;
        if (resolved.relative === 'thoughts.json' || resolved.relative.startsWith('thoughts/')) space.hasThoughts = true;
        if (resolved.relative.startsWith('relations/')) space.hasRelations = true;
    }

    return {
        root: spaceRoot,
        spaces: [...spaces.values()]
        .sort((a, b) => {
            if (a.prefix === spaceRoot) return -1;
            if (b.prefix === spaceRoot) return 1;
            return String(a.name || a.prefix).localeCompare(String(b.name || b.prefix));
        })
    };
}

async function backupPrefix(prefix, backupPrefix, { dryRun = true } = {}) {
    const source = ensurePrefix(prefix);
    const target = ensurePrefix(backupPrefix);
    if (source === target) {
        throw new Error('Backup prefix must be different from source prefix');
    }

    const inventory = await inventoryPrefix(source);
    const copied = [];

    for (const object of inventory.objects) {
        const relative = object.key.slice(source.length + 1);
        const destKey = `${target}/${relative}`;
        copied.push({
            sourceKey: object.key,
            destKey,
            bytes: object.size || 0,
            dryRun
        });
        if (!dryRun) {
            await s3.copyObject(object.key, destKey);
        }
    }

    return {
        action: 'backup',
        sourcePrefix: source,
        backupPrefix: target,
        objectCount: copied.length,
        totalBytes: inventory.totalBytes,
        dryRun,
        copied
    };
}

async function deletePrefix(prefix, { dryRun = true, confirmPrefix = '' } = {}) {
    const clean = ensurePrefix(prefix);
    if (!dryRun && cleanPrefix(confirmPrefix) !== clean) {
        throw new Error(`Refusing to delete ${clean}/ without --confirm-prefix ${clean}`);
    }

    const inventory = await inventoryPrefix(clean);
    const deleted = [];

    for (const object of inventory.objects) {
        deleted.push({
            key: object.key,
            bytes: object.size || 0,
            dryRun
        });
        if (!dryRun) {
            await s3.deleteObject(object.key);
        }
    }

    return {
        action: 'delete',
        prefix: clean,
        objectCount: deleted.length,
        totalBytes: inventory.totalBytes,
        dryRun,
        deleted
    };
}

async function runCli(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    s3.initS3();

    let result;
    if (args.action === 'inventory') {
        result = await inventoryPrefix(args.prefix);
    } else if (args.action === 'backup') {
        result = await backupPrefix(args.prefix, args.backupPrefix, { dryRun: args.dryRun });
    } else if (args.action === 'delete') {
        result = await deletePrefix(args.prefix, {
            dryRun: args.dryRun,
            confirmPrefix: args.confirmPrefix
        });
    } else {
        throw new Error(`Unknown action: ${args.action}`);
    }

    console.log(JSON.stringify(result, null, 2));
    return result;
}

if (require.main === module) {
    runCli().catch((error) => {
        console.error(error.message || error);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    cleanPrefix,
    cleanSpaceRoot,
    listSpaces,
    inventoryPrefix,
    backupPrefix,
    deletePrefix,
    runCli
};
