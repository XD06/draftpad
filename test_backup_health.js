const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMasterKey } = require('./scripts/backup/backup-crypto');
const { LocalBackupRepository } = require('./scripts/backup/local-backup-repository');
const {
    DAY_MS,
    createLocalSnapshot,
    inspectBackupRepository,
    verifySnapshot
} = require('./scripts/backup/backup-service');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function expectIntegrityFailure(callback) {
    let thrown = null;
    try {
        await callback();
    } catch (error) {
        thrown = error;
    }
    assert(thrown?.code === 'BACKUP_INTEGRITY_FAILED', 'corrupt backup data must produce a stable integrity error');
    assert(!/default\.txt|source|repository/i.test(String(thrown?.message || '')), 'integrity errors must not expose source paths');
}

(async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-backup-health-'));
    const sourceDirectory = path.join(root, 'source');
    const repositoryDirectory = path.join(root, 'repository');
    const emptyRepositoryDirectory = path.join(root, 'empty-repository');
    const masterKey = parseMasterKey(crypto.randomBytes(32).toString('base64'));
    const createdAt = Date.UTC(2026, 6, 19, 2, 0, 0);

    try {
        await fs.promises.mkdir(sourceDirectory, { recursive: true });
        await fs.promises.writeFile(path.join(sourceDirectory, 'notepads.json'), '{"notepads":[]}');
        await fs.promises.writeFile(path.join(sourceDirectory, 'default.txt'), 'health check note');

        const repository = new LocalBackupRepository(repositoryDirectory);
        const snapshot = await createLocalSnapshot({
            sourceDirectory,
            repository,
            masterKey,
            maxBytes: 1024 * 1024,
            createdAt
        });

        const verified = await verifySnapshot({ repository, masterKey, snapshotId: snapshot.id });
        assert(verified.valid === true, 'a complete encrypted snapshot should pass integrity verification');
        assert(verified.verifiedFiles === 2 && verified.verifiedBlocks === 2, 'verification should report files and encrypted blocks checked');

        const healthy = await inspectBackupRepository({
            repository,
            masterKey,
            maxBytes: 1024 * 1024,
            now: createdAt + 60 * 60 * 1000
        });
        assert(healthy.status === 'healthy' && healthy.healthy === true, 'a recent valid snapshot should report a healthy repository');
        assert(healthy.latestSnapshot.id === snapshot.id, 'health should identify the latest verified snapshot');
        assert(healthy.integrity.valid === true, 'health should include the latest snapshot integrity result');

        const stale = await inspectBackupRepository({
            repository,
            masterKey,
            maxBytes: 1024 * 1024,
            now: createdAt + 3 * DAY_MS,
            staleAfterMs: 2 * DAY_MS
        });
        assert(stale.status === 'warning' && stale.warnings.some(item => item.id === 'snapshot_stale'), 'an old latest snapshot should be visible as a health warning');

        const empty = await inspectBackupRepository({
            repository: new LocalBackupRepository(emptyRepositoryDirectory),
            masterKey,
            maxBytes: 1024 * 1024,
            now: createdAt
        });
        assert(empty.status === 'empty' && empty.healthy === false, 'a repository without snapshots must not look healthy');

        const firstBlock = (await repository.listBlocks())[0];
        await fs.promises.writeFile(repository.blockPath(firstBlock.id), Buffer.from('corrupt'));
        await expectIntegrityFailure(() => verifySnapshot({ repository, masterKey, snapshotId: snapshot.id }));

        const corruptBlockHealth = await inspectBackupRepository({
            repository,
            masterKey,
            maxBytes: 1024 * 1024,
            now: createdAt + 60 * 60 * 1000
        });
        assert(
            corruptBlockHealth.status === 'unhealthy' &&
                corruptBlockHealth.healthy === false &&
                corruptBlockHealth.warnings.some(item => item.id === 'integrity_failed'),
            'health must turn corrupt encrypted blocks into a controlled unhealthy report'
        );

        await fs.promises.writeFile(repository.manifestPath(snapshot.id), Buffer.from('corrupt-manifest'));
        const corruptManifestHealth = await inspectBackupRepository({
            repository,
            masterKey,
            maxBytes: 1024 * 1024,
            now: createdAt + 60 * 60 * 1000
        });
        assert(
            corruptManifestHealth.status === 'unhealthy' &&
                corruptManifestHealth.healthy === false &&
                corruptManifestHealth.warnings.some(item => item.id === 'manifest_corrupt'),
            'health must report a corrupt newest manifest without throwing raw crypto errors'
        );

        console.log('Backup health checks passed');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
