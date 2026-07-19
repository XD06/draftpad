const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { collectCanonicalLocalFiles } = require('./canonical-local-source');
const { MAX_BACKUP_BYTES } = require('./backup-readiness');
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
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BACKUP_BYTES) {
        const error = new Error('Backup capacity is outside the enforced safety limit');
        error.code = 'BACKUP_CAPACITY_INVALID';
        throw error;
    }
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

async function verifySnapshot({ repository, masterKey, snapshotId } = {}) {
    if (!repository) throw new Error('A backup repository is required');
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('A parsed 32-byte backup master key is required');
    if (!snapshotId) throw new Error('A backup snapshot id is required');

    try {
        const manifest = await readManifest(repository, snapshotId, masterKey);
        const verifiedBlocks = new Map();
        let verifiedBytes = 0;

        for (const file of manifest.files || []) {
            const originalBytes = Number(file.originalBytes);
            if (!file.blockId || !Number.isInteger(originalBytes) || originalBytes < 0) {
                throw new Error('Invalid backup manifest entry');
            }
            let raw = verifiedBlocks.get(file.blockId);
            if (!raw) {
                raw = decodeBlock(await repository.readBlock(file.blockId), originalBytes, masterKey);
                if (blockIdForBuffer(raw, masterKey) !== file.blockId) {
                    throw new Error('Backup block content verification failed');
                }
                verifiedBlocks.set(file.blockId, raw);
            } else if (raw.length !== originalBytes) {
                throw new Error('Backup manifest block size mismatch');
            }
            verifiedBytes += originalBytes;
        }

        return {
            valid: true,
            snapshot: snapshotSummary(manifest),
            verifiedFiles: (manifest.files || []).length,
            verifiedBlocks: verifiedBlocks.size,
            verifiedBytes
        };
    } catch (cause) {
        const error = new Error('Backup snapshot integrity verification failed');
        error.code = 'BACKUP_INTEGRITY_FAILED';
        throw error;
    }
}

async function inspectBackupRepository({
    repository,
    masterKey,
    maxBytes,
    now = Date.now(),
    staleAfterMs = 48 * 60 * 60 * 1000,
    snapshotId = ''
} = {}) {
    if (!repository) throw new Error('A backup repository is required');
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('A parsed 32-byte backup master key is required');
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BACKUP_BYTES) {
        const error = new Error('Backup capacity is outside the enforced safety limit');
        error.code = 'BACKUP_CAPACITY_INVALID';
        throw error;
    }

    const [manifestIds, usageBytes] = await Promise.all([
        repository.listManifestIds(),
        repository.usageBytes()
    ]);
    const orderedIds = manifestIds.slice().sort().reverse();
    const manifestResults = await Promise.all(orderedIds.map(async id => {
        try {
            return { id, manifest: await readManifest(repository, id, masterKey), valid: true };
        } catch {
            return { id, manifest: null, valid: false };
        }
    }));
    const corruptManifestCount = manifestResults.filter(item => !item.valid).length;
    const manifests = manifestResults
        .filter(item => item.valid)
        .map(item => item.manifest)
        .sort((left, right) => right.createdAt - left.createdAt);
    const usageRatio = usageBytes / maxBytes;
    if (!manifestResults.length) {
        return {
            status: 'empty',
            healthy: false,
            snapshotCount: 0,
            usageBytes,
            maxBytes,
            usageRatio,
            latestSnapshot: null,
            integrity: null,
            warnings: [{ id: 'no_snapshots', message: '备份仓库中没有可恢复快照' }]
        };
    }

    const selectedManifestResult = snapshotId
        ? manifestResults.find(item => item.id === snapshotId)
        : manifestResults[0];
    if (!selectedManifestResult) throw new Error('The selected backup snapshot was not found');
    if (!selectedManifestResult.valid) {
        return {
            status: 'unhealthy',
            healthy: false,
            snapshotCount: manifestResults.length,
            validSnapshotCount: manifests.length,
            corruptManifestCount,
            usageBytes,
            maxBytes,
            usageRatio,
            latestSnapshot: manifests[0] ? snapshotSummary(manifests[0]) : null,
            integrity: { valid: false },
            warnings: [{ id: 'manifest_corrupt', message: '待检查的备份清单无法通过解密校验' }]
        };
    }

    const selected = selectedManifestResult.manifest;
    const warnings = [];
    if (corruptManifestCount) {
        warnings.push({ id: 'manifest_corrupt', message: '备份仓库中存在无法通过解密校验的清单' });
    }
    const ageMs = Math.max(0, Number(now) - Number(manifests[0].createdAt));
    let integrity;
    try {
        integrity = await verifySnapshot({ repository, masterKey, snapshotId: selected.id });
    } catch (error) {
        if (error?.code !== 'BACKUP_INTEGRITY_FAILED') throw error;
        return {
            status: 'unhealthy',
            healthy: false,
            snapshotCount: manifestResults.length,
            validSnapshotCount: manifests.length,
            corruptManifestCount,
            usageBytes,
            maxBytes,
            usageRatio,
            latestSnapshot: snapshotSummary(manifests[0]),
            checkedSnapshot: snapshotSummary(selected),
            ageMs,
            integrity: { valid: false },
            warnings: [...warnings, { id: 'integrity_failed', message: '备份快照内容完整性校验失败' }]
        };
    }
    if (Number.isFinite(staleAfterMs) && staleAfterMs > 0 && ageMs > staleAfterMs) {
        warnings.push({ id: 'snapshot_stale', message: '最新备份已超过允许的新鲜度窗口' });
    }
    if (usageRatio >= 0.9) {
        warnings.push({ id: 'capacity_critical', message: '备份仓库容量已达到 90% 或更高' });
    } else if (usageRatio >= 0.7) {
        warnings.push({ id: 'capacity_warning', message: '备份仓库容量已达到 70% 或更高' });
    }

    return {
        status: warnings.length ? 'warning' : 'healthy',
        healthy: true,
        snapshotCount: manifestResults.length,
        validSnapshotCount: manifests.length,
        corruptManifestCount,
        usageBytes,
        maxBytes,
        usageRatio,
        latestSnapshot: snapshotSummary(manifests[0]),
        checkedSnapshot: snapshotSummary(selected),
        ageMs,
        integrity,
        warnings
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

    let verifiedFiles = 0;
    let verifiedBytes = 0;
    try {
        for (const file of manifest.files.slice().sort((left, right) => left.path.localeCompare(right.path))) {
            const restored = await fs.readFile(resolveRestorePath(target, file.path));
            if (restored.length !== Number(file.originalBytes) || blockIdForBuffer(restored, masterKey) !== file.blockId) {
                throw new Error('Restore target content mismatch');
            }
            verifiedFiles += 1;
            verifiedBytes += restored.length;
        }
    } catch (cause) {
        const error = new Error('Restored local data failed post-write verification');
        error.code = 'BACKUP_RESTORE_VERIFICATION_FAILED';
        throw error;
    }

    return {
        snapshot: snapshotSummary(manifest),
        targetDirectory: target,
        restoredFiles: manifest.files.length,
        restoredBytes,
        verifiedFiles,
        verifiedBytes
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

    let verifiedFiles = 0;
    let verifiedBytes = 0;
    try {
        const expected = manifest.files.slice().sort((left, right) => left.path.localeCompare(right.path));
        const inventory = (await targetObjectStore.list(`${cleanPrefix}/`))
            .slice()
            .sort((left, right) => String(left.key || '').localeCompare(String(right.key || '')));
        if (inventory.length !== expected.length) throw new Error('Restore target object count mismatch');

        for (let index = 0; index < expected.length; index++) {
            const file = expected[index];
            const expectedKey = `${cleanPrefix}/${file.path}`;
            const item = inventory[index];
            if (String(item?.key || '') !== expectedKey || Number(item?.size) !== Number(file.originalBytes)) {
                throw new Error('Restore target inventory mismatch');
            }
            const restored = await targetObjectStore.get(expectedKey);
            if (restored.length !== Number(file.originalBytes) || blockIdForBuffer(restored, masterKey) !== file.blockId) {
                throw new Error('Restore target content mismatch');
            }
            verifiedFiles += 1;
            verifiedBytes += restored.length;
        }
    } catch (cause) {
        const error = new Error('Restored S3 data failed post-write verification');
        error.code = 'BACKUP_RESTORE_VERIFICATION_FAILED';
        throw error;
    }

    return {
        snapshot: snapshotSummary(manifest),
        targetPrefix: cleanPrefix,
        restoredFiles: manifest.files.length,
        restoredBytes,
        verifiedFiles,
        verifiedBytes
    };
}

module.exports = {
    DAY_MS,
    HIGH_RISK_RETENTION_MS,
    TRASH_RETENTION_MS,
    createSnapshot,
    createLocalSnapshot,
    inspectBackupRepository,
    listSnapshotManifests,
    pruneRepository,
    retainedSnapshotIds,
    restoreLocalSnapshot,
    restoreS3Snapshot,
    verifySnapshot
};
