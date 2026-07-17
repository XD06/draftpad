const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMasterKey } = require('./scripts/backup/backup-crypto');
const { LocalBackupRepository } = require('./scripts/backup/local-backup-repository');
const {
    DAY_MS,
    createLocalSnapshot,
    listSnapshotManifests,
    pruneRepository,
    restoreLocalSnapshot
} = require('./scripts/backup/backup-service');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function writeFile(root, relativePath, contents) {
    const target = path.join(root, ...relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, contents);
}

async function fileExists(root, relativePath) {
    try {
        await fs.promises.access(path.join(root, ...relativePath.split('/')));
        return true;
    } catch {
        return false;
    }
}

async function expectError(callback, code, message) {
    let thrown = null;
    try {
        await callback();
    } catch (error) {
        thrown = error;
    }
    assert(thrown, message);
    assert(thrown.code === code, `${message}: expected ${code}, received ${thrown.code}`);
}

(async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-backup-test-'));
    const sourceDirectory = path.join(tempRoot, 'source');
    const repositoryDirectory = path.join(tempRoot, 'repository');
    const restoreDirectory = path.join(tempRoot, 'restore');
    const capacityRepositoryDirectory = path.join(tempRoot, 'capacity-repository');
    const masterKey = parseMasterKey(crypto.randomBytes(32).toString('base64'));

    try {
        await writeFile(sourceDirectory, 'notepads.json', JSON.stringify({ notepads: [{ id: 'default', name: 'Default' }] }));
        await writeFile(sourceDirectory, 'default.txt', 'first note');
        await writeFile(sourceDirectory, 'thoughts/idea.json', JSON.stringify({ id: 'idea', text: 'important thought' }));
        await writeFile(sourceDirectory, 'relations/idea.json', JSON.stringify({ id: 'idea', edges: [] }));
        await writeFile(sourceDirectory, 'assets/image-a/original', Buffer.from('original-image-bytes'));
        await writeFile(sourceDirectory, 'assets/image-a/meta.json', JSON.stringify({ id: 'image-a', type: 'image/png' }));
        await writeFile(sourceDirectory, 'assets/image-a/preview', Buffer.from('derived-preview'));
        await writeFile(sourceDirectory, 'indexes/notepads.json', JSON.stringify({ stale: true }));
        await writeFile(sourceDirectory, 'thoughts.meta/idea.json', JSON.stringify({ stale: true }));
        await writeFile(sourceDirectory, 'agent-runs/run.json', JSON.stringify({ stale: true }));

        const repository = new LocalBackupRepository(repositoryDirectory);
        const initial = await createLocalSnapshot({
            sourceDirectory,
            repository,
            masterKey,
            maxBytes: 1024 * 1024,
            createdAt: Date.UTC(2026, 6, 10)
        });
        const initialBlocks = await repository.listBlocks();
        assert(initial.fileCount === 6, 'snapshot should include canonical content and skip derived files');
        assert(initialBlocks.length === 6, 'each initial unique canonical payload should produce one encrypted block');

        await writeFile(sourceDirectory, 'default.txt', 'second note');
        const updated = await createLocalSnapshot({
            sourceDirectory,
            repository,
            masterKey,
            maxBytes: 1024 * 1024,
            createdAt: Date.UTC(2026, 6, 11)
        });
        const updatedBlocks = await repository.listBlocks();
        assert(updated.newBlockCount === 1, 'changing one note should write only one new encrypted block');
        assert(updatedBlocks.length === initialBlocks.length + 1, 'unchanged images and metadata should be deduplicated');

        const restored = await restoreLocalSnapshot({
            repository,
            masterKey,
            snapshotId: updated.id,
            targetDirectory: restoreDirectory
        });
        assert(restored.restoredFiles === 6, 'restore should write every canonical file');
        assert(await fs.promises.readFile(path.join(restoreDirectory, 'default.txt'), 'utf8') === 'second note', 'restore should preserve latest text');
        assert(await fs.promises.readFile(path.join(restoreDirectory, 'assets', 'image-a', 'original'), 'utf8') === 'original-image-bytes', 'restore should preserve original attachment bytes');
        assert(!await fileExists(restoreDirectory, 'assets/image-a/preview'), 'restore should omit regenerable image previews');
        assert(!await fileExists(restoreDirectory, 'indexes/notepads.json'), 'restore should omit regenerable search indexes');
        assert(!await fileExists(restoreDirectory, 'thoughts.meta/idea.json'), 'restore should omit derived AI metadata');

        await createLocalSnapshot({ sourceDirectory, repository, masterKey, maxBytes: 1024 * 1024, createdAt: Date.UTC(2026, 6, 12) });
        await createLocalSnapshot({ sourceDirectory, repository, masterKey, maxBytes: 1024 * 1024, createdAt: Date.UTC(2026, 6, 13) });
        const snapshots = await listSnapshotManifests(repository, masterKey);
        assert(snapshots.length === 3, 'scheduled retention should keep only the three newest daily snapshots in the active set');
        const trashSnapshots = await listSnapshotManifests(repository, masterKey, { trash: true });
        assert(trashSnapshots.length === 1, 'expired scheduled snapshots should move to backup trash before block cleanup');
        await pruneRepository(repository, masterKey, { now: Date.UTC(2026, 6, 20) });
        assert(
            (await listSnapshotManifests(repository, masterKey, { trash: true })).length === 1,
            'backup trash should retain an old snapshot for fourteen days after it is moved, not after it was created'
        );
        await pruneRepository(repository, masterKey, { now: Date.UTC(2026, 6, 28) });
        assert(
            (await listSnapshotManifests(repository, masterKey, { trash: true })).length === 0,
            'backup trash should remove an expired snapshot after its fourteen-day recovery window'
        );

        const capacityRepository = new LocalBackupRepository(capacityRepositoryDirectory);
        await writeFile(sourceDirectory, 'large.bin', crypto.randomBytes(8192));
        await expectError(
            () => createLocalSnapshot({
                sourceDirectory,
                repository: capacityRepository,
                masterKey,
                maxBytes: 128,
                createdAt: Date.UTC(2026, 6, 14) + DAY_MS
            }),
            'BACKUP_CAPACITY_EXCEEDED',
            'a snapshot should fail before writing when it would exceed the repository capacity'
        );
        assert((await capacityRepository.listManifestIds()).length === 0, 'capacity failure should not create a manifest');
        assert((await capacityRepository.listBlocks()).length === 0, 'capacity failure should not create partial blocks');

        console.log('Backup repository checks passed');
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
