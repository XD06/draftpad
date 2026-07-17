const fs = require('fs').promises;
const path = require('path');

const DERIVED_PREFIXES = [
    'agent-runs/',
    'indexes/',
    'thoughts.meta/'
];

function normalizeRelativePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isCanonicalRelativePath(value) {
    const relative = normalizeRelativePath(value);
    if (!relative || relative.includes('..')) return false;
    if (DERIVED_PREFIXES.some(prefix => relative.startsWith(prefix))) return false;
    if (/^assets\/[^/]+\/preview$/i.test(relative)) return false;
    return relative !== 'storage-state.json';
}

async function walkCanonicalFiles(rootDirectory, relative = '') {
    const entries = await fs.readdir(path.join(rootDirectory, relative), { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const nextRelative = normalizeRelativePath(relative ? `${relative}/${entry.name}` : entry.name);
        if (!isCanonicalRelativePath(nextRelative) && !entry.isDirectory()) continue;
        const absolute = path.join(rootDirectory, ...nextRelative.split('/'));
        if (entry.isDirectory()) {
            if (DERIVED_PREFIXES.some(prefix => nextRelative === prefix.slice(0, -1) || nextRelative.startsWith(prefix))) continue;
            files.push(...await walkCanonicalFiles(rootDirectory, nextRelative));
        } else if (entry.isFile() && isCanonicalRelativePath(nextRelative)) {
            files.push({ path: nextRelative, buffer: await fs.readFile(absolute) });
        }
    }
    return files;
}

async function collectCanonicalLocalFiles(sourceDirectory) {
    const root = path.resolve(sourceDirectory);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('Backup source must be a directory');
    return walkCanonicalFiles(root);
}

module.exports = {
    collectCanonicalLocalFiles,
    isCanonicalRelativePath,
    normalizeRelativePath
};
