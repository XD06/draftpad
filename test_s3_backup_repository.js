const crypto = require('crypto');
const { parseMasterKey } = require('./scripts/backup/backup-crypto');
const { S3BackupRepository } = require('./scripts/backup/s3-backup-repository');
const { createSnapshot, restoreS3Snapshot } = require('./scripts/backup/backup-service');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function createMemoryObjectStore(initial = {}) {
    const objects = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
    return {
        async list(prefix = '') {
            return [...objects.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({ key, size: value.length }));
        },
        async has(key) {
            return objects.has(key);
        },
        async get(key) {
            if (!objects.has(key)) throw new Error(`Missing object: ${key}`);
            return Buffer.from(objects.get(key));
        },
        async put(key, value) {
            objects.set(key, Buffer.from(value));
        },
        async delete(key) {
            objects.delete(key);
        },
        async copy(source, target) {
            objects.set(target, Buffer.from(objects.get(source)));
        }
    };
}

(async () => {
    const backupStore = createMemoryObjectStore();
    const repository = new S3BackupRepository({ objectStore: backupStore, prefix: 'private-backups' });
    const masterKey = parseMasterKey(crypto.randomBytes(32).toString('hex'));
    const contents = [
        { path: 'notepads.json', buffer: Buffer.from('{"notepads":[]}') },
        { path: 'default.txt', buffer: Buffer.from('S3 backup source') },
        { path: 'assets/asset-a/original', buffer: Buffer.from('original bytes') }
    ];

    const snapshot = await createSnapshot({
        collectFiles: async () => contents,
        repository,
        masterKey,
        maxBytes: 1024 * 1024,
        createdAt: Date.UTC(2026, 6, 15)
    });
    assert(snapshot.fileCount === contents.length, 'S3 backup snapshot should store every supplied canonical file');
    assert((await backupStore.list('private-backups/blocks/')).length === contents.length, 'S3 backup should store encrypted block objects');
    assert((await backupStore.list('private-backups/manifests/')).length === 1, 'S3 backup should store one encrypted manifest');

    const restoreTarget = createMemoryObjectStore();
    const restored = await restoreS3Snapshot({
        repository,
        masterKey,
        snapshotId: snapshot.id,
        targetObjectStore: restoreTarget,
        targetPrefix: 'dumbpad-restored'
    });
    assert(restored.restoredFiles === contents.length, 'S3 restore should reconstruct every canonical file');
    assert(
        (await restoreTarget.get('dumbpad-restored/default.txt')).toString('utf8') === 'S3 backup source',
        'S3 restore should preserve text bytes'
    );
    assert(
        (await restoreTarget.get('dumbpad-restored/assets/asset-a/original')).toString('utf8') === 'original bytes',
        'S3 restore should preserve original asset bytes'
    );

    let refused = false;
    try {
        await restoreS3Snapshot({
            repository,
            masterKey,
            snapshotId: snapshot.id,
            targetObjectStore: restoreTarget,
            targetPrefix: 'dumbpad-restored'
        });
    } catch (error) {
        refused = /must be empty/.test(error.message);
    }
    assert(refused, 'S3 restore should refuse to overwrite a non-empty prefix');

    console.log('S3 backup repository checks passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
