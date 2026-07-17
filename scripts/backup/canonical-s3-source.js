const { isCanonicalRelativePath } = require('./canonical-local-source');
const { cleanPrefix, joinKey } = require('./s3-object-store');

function canonicalInventory(entries, root) {
    return entries
        .map(entry => {
            const relativePath = String(entry.key || '').slice(root.length);
            return {
                path: relativePath,
                size: Number(entry.size || 0),
                lastModified: entry.lastModified ? new Date(entry.lastModified).toISOString() : ''
            };
        })
        .filter(entry => isCanonicalRelativePath(entry.path))
        .sort((left, right) => left.path.localeCompare(right.path));
}

function sameInventory(left, right) {
    return left.length === right.length && left.every((entry, index) => {
        const other = right[index];
        return entry.path === other.path && entry.size === other.size && entry.lastModified === other.lastModified;
    });
}

async function collectCanonicalS3Files({ objectStore, prefix = '', maxAttempts = 3 } = {}) {
    if (!objectStore) throw new Error('An S3 source object store is required');
    const clean = cleanPrefix(prefix);
    const root = clean ? `${clean}/` : '';
    const attempts = Math.max(1, Number(maxAttempts) || 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
        const before = canonicalInventory(await objectStore.list(root), root);
        const files = [];
        for (const entry of before) {
            files.push({ path: entry.path, buffer: await objectStore.get(joinKey(root, entry.path)) });
        }
        const after = canonicalInventory(await objectStore.list(root), root);
        if (sameInventory(before, after)) return files;
    }

    const error = new Error('S3 source changed while collecting a backup snapshot; retry later');
    error.code = 'BACKUP_SOURCE_CHANGED';
    throw error;
}

module.exports = { canonicalInventory, collectCanonicalS3Files, sameInventory };
