const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { collectCanonicalLocalFiles } = require('./canonical-local-source');
const {
    blockIdForBuffer,
    decodeBlock,
    decodeJson,
    encodeBlock,
    encodeJson
} = require('./backup-crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_RETENTION_MS = 14 * DAY_MS;
const HIGH_RISK_RETENTION_MS = 14 * DAY_MS;

function createSnapshotId(createdAt) {
    return `snap_${String(createdAt).padStart(13, '0')}_${crypto.randomBytes(6).toString('hex')}`;
}

function snapshotSummary(manifest) {
    return {
        id: manifest.id,
        createdAt: manifest.createdAt,
        kind: manifest.kind,
        fileCount: manifest.files.length,
        sourceBytes: manifest.sourceBytes
    };
}

async function readManifest(repository, snapshotId, masterKey, { trash = false } = {}) {
    return decodeJson(await repository.readManifest(snapshotId, { trash }), masterKey);
}

async function listSnapshotManifests(repository, masterKey, { trash = false } = {}) {
    const ids = await repository.listManifestIds({ trash });
    const manifests = await Promise.all(ids.map(snapshotId => readManifest(repository, snapshotId, masterKey, { trash })));
    return manifests.sort((left, right) => right.createdAt - left.createdAt);
}

function keepByUniquePeriod(snapshots, periodKey, count, kept) {
    const periods = new Set();
    for (const snapshot of snapshots) {
        const key = periodKey(snapshot.createdAt);
        if (periods.has(key) || periods.size >= count) continue;
        periods.add(key);
        kept.add(snapshot.id);
    }
}

function utcDay(createdAt) {
    return new Date(createdAt).toISOString().slice(0, 10);
}

function utcWeek(createdAt) {
    const date = new Date(createdAt);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    return date.toISOString().slice(0, 10);
}

function utcMonth(createdAt) {
    return new Date(createdAt).toISOString().slice(0, 7);
}

function retainedSnapshotIds(snapshots, now = Date.now()) {
    const kept = new Set();
    const scheduled = snapshots.filter(snapshot => snapshot.kind === 'scheduled');
    const highRisk = snapshots.filter(snapshot => snapshot.kind === 'high-risk');
    keepByUniquePeriod(scheduled, utcDay, 3, kept);
    keepByUniquePeriod(scheduled, utcWeek, 4, kept);
    keepByUniquePeriod(scheduled, utcMonth, 6, kept);
    for (const snapshot of highRisk.slice(0, 3)) {
        if (now - snapshot.createdAt <= HIGH_RISK_RETENTION_MS) kept.add(snapshot.id);
    }
    return kept;
}

async function collectReferencedBlockIds(repository, masterKey) {
    const manifests = [
        ...await listSnapshotManifests(repository, masterKey),
        ...await listSnapshotManifests(repository, masterKey, { trash: true })
    ];
    return new Set(manifests.flatMap(manifest => manifest.files.map(file => file.blockId)));
}

async function pruneRepository(repository, masterKey, { now = Date.now() } = {}) {
    const active = await listSnapshotManifests(repository, masterKey);
    const kept = retainedSnapshotIds(active, now);
    const movedToTrash = [];
    for (const snapshot of active) {
        if (kept.has(snapshot.id)) continue;
        await repository.moveManifestToTrash(snapshot.id, { trashedAt: now });
        movedToTrash.push(snapshot.id);
    }

    const trash = await listSnapshotManifests(repository, masterKey, { trash: true });
    const deletedManifests = [];
    for (const snapshot of trash) {
        const trashedAt = await repository.getManifestTrashTimestamp(snapshot.id) || snapshot.createdAt;
        if (now - trashedAt <= TRASH_RETENTION_MS) continue;
        await repository.deleteManifest(snapshot.id, { trash: true });
        deletedManifests.push(snapshot.id);
    }

    const referenced = await collectReferencedBlockIds(repository, masterKey);
    const deletedBlocks = [];
    for (const block of await repository.listBlocks()) {
        if (referenced.has(block.id)) continue;
        await repository.deleteBlock(block.id);
        deletedBlocks.push(block.id);
    }

    return { movedToTrash, deletedManifests, deletedBlocks, retainedSnapshotIds: [...kept].sort() };
}

function assertTargetDirectory(targetDirectory) {
    const target = path.resolve(targetDirectory);
    if (path.parse(target).root === target) throw new Error('Backup restore target cannot be a filesystem root');
    return target;
}

async function assertEmptyDirectory(targetDirectory) {
    const target = assertTargetDirectory(targetDirectory);
    const entries = await fs.readdir(target).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    if (entries.length) throw new Error('Backup restore target must be empty');
    await fs.mkdir(target, { recursive: true });
    return target;
}

function resolveRestorePath(targetDirectory, relativePath) {
    const target = path.resolve(targetDirectory, ...String(relativePath || '').split('/'));
    if (!target.startsWith(`${targetDirectory}${path.sep}`)) throw new Error('Unsafe backup restore path');
    return target;
}

async function createLocalSnapshot({
    sourceDirectory,
    repository,
    masterKey,
    maxBytes,
    kind = 'scheduled',
    createdAt = Date.now(),
    snapshotId = ''
} = {}) {
    return createSnapshot({
        collectFiles: () => collectCanonicalLocalFiles(sourceDirectory),
        repository,
        masterKey,
        maxBytes,
        kind,
        createdAt,
        snapshotId
    });
}

async function createSnapshot({
    collectFiles,
    repository,
    masterKey,
    maxBytes,
    kind = 'scheduled',
    createdAt = Date.now(),
    snapshotId = ''
} = {}) {
    if (!repository) throw new Error('A backup repository is required');
    if (typeof collectFiles !== 'function') throw new Error('A canonical backup source is required');
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('A parsed 32-byte backup master key is required');
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('A positive backup capacity is required');
    if (!['scheduled', 'high-risk'].includes(kind)) throw new Error('Backup kind must be scheduled or high-risk');

    await repository.initialize();
    await pruneRepository(repository, masterKey, { now: createdAt });
    const sourceFiles = await collectFiles();
    const files = [];
    const newBlocks = new Map();
    let sourceBytes = 0;

    for (const file of sourceFiles) {
        const blockId = blockIdForBuffer(file.buffer, masterKey);
        sourceBytes += file.buffer.length;
        files.push({ path: file.path, blockId, originalBytes: file.buffer.length });
        if (!newBlocks.has(blockId) && !await repository.hasBlock(blockId)) {
            newBlocks.set(blockId, encodeBlock(file.buffer, masterKey));
        }
    }

    const manifest = {
        version: 1,
        id: snapshotId || createSnapshotId(createdAt),
        createdAt,
        kind,
        sourceBytes,
        files
    };
    const encryptedManifest = encodeJson(manifest, masterKey);
    const newBytes = [...newBlocks.values()].reduce((total, block) => total + block.encrypted.length, encryptedManifest.length);
    const usageBefore = await repository.usageBytes();
    if (usageBefore + newBytes > maxBytes) {
        const error = new Error('Backup capacity would be exceeded');
        error.code = 'BACKUP_CAPACITY_EXCEEDED';
        error.details = { usageBefore, newBytes, maxBytes };
        throw error;
    }

    for (const [blockId, block] of newBlocks) {
        await repository.writeBlock(blockId, block.encrypted);
    }
    await repository.writeManifest(manifest.id, encryptedManifest);
    const retention = await pruneRepository(repository, masterKey, { now: createdAt });

    return {
        ...snapshotSummary(manifest),
        newBlockCount: newBlocks.size,
        newBytes,
        usageBytes: await repository.usageBytes(),
        retention
    };
}

async function restoreLocalSnapshot({ repository, masterKey, snapshotId, targetDirectory } = {}) {
    if (!repository) throw new Error('A backup repository is required');
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('A parsed 32-byte backup master key is required');
    const target = await assertEmptyDirectory(targetDirectory);
    const manifest = await readManifest(repository, snapshotId, masterKey);
    let restoredBytes = 0;

    for (const file of manifest.files.slice().sort((left, right) => left.path.localeCompare(right.path))) {
        const block = await repository.readBlock(file.blockId);
        const raw = decodeBlock(block, file.originalBytes, masterKey);
        if (blockIdForBuffer(raw, masterKey) !== file.blockId) throw new Error('Backup block integrity verification failed');
        const targetPath = resolveRestorePath(target, file.path);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, raw, { flag: 'wx' });
        restoredBytes += raw.length;
    }

    return {
        snapshot: snapshotSummary(manifest),
        targetDirectory: target,
        restoredFiles: manifest.files.length,
        restoredBytes
    };
}

async function restoreS3Snapshot({ repository, masterKey, snapshotId, targetObjectStore, targetPrefix = '' } = {}) {
    if (!repository) throw new Error('A backup repository is required');
    if (!targetObjectStore) throw new Error('An S3 restore target is required');
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('A parsed 32-byte backup master key is required');
    const cleanPrefix = String(targetPrefix || '').replace(/^\/+|\/+$/g, '');
    if (!cleanPrefix) throw new Error('A non-empty S3 restore prefix is required');
    if ((await targetObjectStore.list(`${cleanPrefix}/`)).length) throw new Error('Backup restore target prefix must be empty');

    const manifest = await readManifest(repository, snapshotId, masterKey);
    let restoredBytes = 0;
    for (const file of manifest.files.slice().sort((left, right) => left.path.localeCompare(right.path))) {
        const block = await repository.readBlock(file.blockId);
        const raw = decodeBlock(block, file.originalBytes, masterKey);
        if (blockIdForBuffer(raw, masterKey) !== file.blockId) throw new Error('Backup block integrity verification failed');
        await targetObjectStore.put(`${cleanPrefix}/${file.path}`, raw);
        restoredBytes += raw.length;
    }

    return {
        snapshot: snapshotSummary(manifest),
        targetPrefix: cleanPrefix,
        restoredFiles: manifest.files.length,
        restoredBytes
    };
}

module.exports = {
    DAY_MS,
    HIGH_RISK_RETENTION_MS,
    TRASH_RETENTION_MS,
    createSnapshot,
    createLocalSnapshot,
    listSnapshotManifests,
    pruneRepository,
    retainedSnapshotIds,
    restoreLocalSnapshot,
    restoreS3Snapshot
};
