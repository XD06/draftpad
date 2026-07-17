require('dotenv').config();

const path = require('path');
const { collectCanonicalLocalFiles } = require('./canonical-local-source');
const { collectCanonicalS3Files } = require('./canonical-s3-source');
const { parseMasterKey } = require('./backup-crypto');
const { LocalBackupRepository } = require('./local-backup-repository');
const {
    createSnapshot,
    listSnapshotManifests,
    pruneRepository,
    restoreLocalSnapshot,
    restoreS3Snapshot
} = require('./backup-service');
const { S3BackupRepository } = require('./s3-backup-repository');
const { cleanPrefix, createS3ObjectStore } = require('./s3-object-store');

const DEFAULT_BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

function parseArgs(argv = process.argv.slice(2)) {
    const args = { command: argv[0] || 'snapshot', kind: 'scheduled', repository: 'local', snapshotId: '', targetDirectory: '', targetPrefix: '' };
    for (let index = 1; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--kind') args.kind = argv[++index] || '';
        else if (value.startsWith('--kind=')) args.kind = value.slice(7);
        else if (value === '--repository') args.repository = argv[++index] || '';
        else if (value.startsWith('--repository=')) args.repository = value.slice(13);
        else if (value === '--snapshot') args.snapshotId = argv[++index] || '';
        else if (value.startsWith('--snapshot=')) args.snapshotId = value.slice(11);
        else if (value === '--target-directory') args.targetDirectory = argv[++index] || '';
        else if (value.startsWith('--target-directory=')) args.targetDirectory = value.slice(19);
        else if (value === '--target-prefix') args.targetPrefix = argv[++index] || '';
        else if (value.startsWith('--target-prefix=')) args.targetPrefix = value.slice(16);
    }
    return args;
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function localRepositoryFromEnv(env = process.env) {
    return new LocalBackupRepository(path.resolve(env.BACKUP_DIR || '/var/lib/dumbpad-backups'));
}

function backupS3RepositoryFromEnv(env = process.env) {
    if (!env.BACKUP_S3_BUCKET) return null;
    const objectStore = createS3ObjectStore({
        endpoint: env.BACKUP_S3_ENDPOINT,
        region: env.BACKUP_S3_REGION || 'auto',
        bucket: env.BACKUP_S3_BUCKET,
        accessKeyId: env.BACKUP_S3_ACCESS_KEY,
        secretAccessKey: env.BACKUP_S3_SECRET_KEY
    });
    return new S3BackupRepository({ objectStore, prefix: env.BACKUP_S3_PREFIX || 'dumbpad-backup' });
}

function sourceS3ObjectStoreFromEnv(env = process.env) {
    return createS3ObjectStore({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION || 'auto',
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY || env.S3_API_KEY
    });
}

async function snapshotTargets({ args, env, masterKey }) {
    const maxBytes = positiveNumber(env.BACKUP_MAX_BYTES, DEFAULT_BACKUP_MAX_BYTES);
    const createdAt = Date.now();
    const localRepository = localRepositoryFromEnv(env);
    const sourceIsS3 = env.STORAGE_BACKEND === 's3';
    const sourceFiles = sourceIsS3
        ? await collectCanonicalS3Files({ objectStore: sourceS3ObjectStoreFromEnv(env), prefix: cleanPrefix(env.S3_PREFIX) })
        : await collectCanonicalLocalFiles(env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
    // Both repositories receive the same source set. A file edited halfway
    // through a dual backup cannot make matching snapshot ids diverge.
    const collectFiles = () => sourceFiles;
    const localResult = await createSnapshot({ collectFiles, repository: localRepository, masterKey, maxBytes, kind: args.kind, createdAt });
    const remoteRepository = backupS3RepositoryFromEnv(env);
    let remoteResult = null;
    if (sourceIsS3 && !remoteRepository) {
        throw new Error('S3-backed data requires BACKUP_S3_* to create an independent backup copy');
    }
    if (remoteRepository) {
        remoteResult = await createSnapshot({ collectFiles, repository: remoteRepository, masterKey, maxBytes, kind: args.kind, createdAt, snapshotId: localResult.id });
    }
    return { local: localResult, remote: remoteResult, remoteConfigured: Boolean(remoteRepository) };
}

async function run(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    const masterKey = parseMasterKey(env.BACKUP_MASTER_KEY);
    const localRepository = localRepositoryFromEnv(env);
    const remoteRepository = backupS3RepositoryFromEnv(env);

    if (args.command === 'snapshot') {
        if (!['scheduled', 'high-risk'].includes(args.kind)) throw new Error('Snapshot kind must be scheduled or high-risk');
        return snapshotTargets({ args, env, masterKey });
    }

    const repository = args.repository === 's3' ? remoteRepository : localRepository;
    if (!repository) throw new Error('The selected backup repository is not configured');
    if (args.command === 'list') {
        return listSnapshotManifests(repository, masterKey).then(manifests => manifests.map(manifest => ({
            id: manifest.id,
            createdAt: manifest.createdAt,
            kind: manifest.kind,
            fileCount: manifest.files.length,
            sourceBytes: manifest.sourceBytes
        })));
    }
    if (args.command === 'prune') return pruneRepository(repository, masterKey);
    if (args.command === 'restore-local') {
        if (!args.snapshotId || !args.targetDirectory) throw new Error('restore-local requires --snapshot and --target-directory');
        return restoreLocalSnapshot({ repository, masterKey, snapshotId: args.snapshotId, targetDirectory: args.targetDirectory });
    }
    if (args.command === 'restore-s3') {
        if (!args.snapshotId || !args.targetPrefix) throw new Error('restore-s3 requires --snapshot and --target-prefix');
        return restoreS3Snapshot({
            repository,
            masterKey,
            snapshotId: args.snapshotId,
            targetObjectStore: sourceS3ObjectStoreFromEnv(env),
            targetPrefix: args.targetPrefix
        });
    }
    throw new Error(`Unknown backup command: ${args.command}`);
}

if (require.main === module) {
    run().then(result => {
        console.log(JSON.stringify(result, null, 2));
    }).catch(error => {
        console.error(error.message || error);
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_BACKUP_MAX_BYTES,
    backupS3RepositoryFromEnv,
    localRepositoryFromEnv,
    parseArgs,
    run,
    sourceS3ObjectStoreFromEnv
};
