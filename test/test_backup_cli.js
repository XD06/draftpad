const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatCliError, parseArgs, run } = require('../scripts/backup/backup-cli');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

(async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-backup-cli-'));
    const dataDirectory = path.join(root, 'data');
    const backupDirectory = path.join(root, 'backups');
    const restoreDirectory = path.join(root, 'restore');
    const emptyBackupDirectory = path.join(root, 'empty-backups');
    const env = {
        STORAGE_BACKEND: 'local',
        DATA_DIR: dataDirectory,
        BACKUP_DIR: backupDirectory,
        BACKUP_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
        BACKUP_MAX_BYTES: String(1024 * 1024)
    };

    try {
        assert(parseArgs([]).command === 'health', 'backup CLI must default to the read-only health command');
        await fs.promises.mkdir(dataDirectory, { recursive: true });
        await fs.promises.writeFile(path.join(dataDirectory, 'notepads.json'), '{"notepads":[]}');
        await fs.promises.writeFile(path.join(dataDirectory, 'default.txt'), 'CLI backup note');

        const snapshot = await run(['snapshot'], env);
        assert(snapshot.local.fileCount === 2, 'backup CLI should snapshot local canonical data');
        assert(snapshot.remoteConfigured === false, 'local backup CLI should report an optional remote repository as absent');

        const listed = await run(['list'], env);
        assert(listed.length === 1 && listed[0].id === snapshot.local.id, 'backup CLI should list the snapshot it created');

        const health = await run(['health'], env);
        assert(health.status === 'healthy' && health.integrity.valid === true, 'backup CLI should verify the latest local snapshot without restoring it');

        const restored = await run([
            'restore-local',
            '--snapshot', snapshot.local.id,
            '--target-directory', restoreDirectory
        ], env);
        assert(restored.restoredFiles === 2, 'backup CLI should restore local snapshots to an empty directory');
        assert(await fs.promises.readFile(path.join(restoreDirectory, 'default.txt'), 'utf8') === 'CLI backup note', 'backup CLI restore should preserve note contents');

        const readiness = await run(['readiness'], {
            ...env,
            NODE_ENV: 'production',
            AUTH_V2_ENABLED: 'true',
            AUTH_STATE_DIR: path.join(root, 'security'),
            AUTH_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
            SHARE_SECRET: crypto.randomBytes(32).toString('hex'),
            DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS: 'false'
        });
        assert(readiness.ready === true, 'backup CLI should expose the offline production readiness report');

        const emptyHealth = await run([], {
            STORAGE_BACKEND: 'local',
            BACKUP_DIR: emptyBackupDirectory,
            BACKUP_MASTER_KEY: env.BACKUP_MASTER_KEY,
            BACKUP_MAX_BYTES: env.BACKUP_MAX_BYTES
        });
        assert(emptyHealth.status === 'empty', 'the default command should report an empty repository without creating a snapshot');
        assert(!fs.existsSync(emptyBackupDirectory), 'read-only health must not create the configured backup directory');

        let unsafeRemotePruneRefused = false;
        try {
            await run(['prune', '--repository', 's3'], {
                ...env,
                STORAGE_BACKEND: 's3',
                S3_ENDPOINT: 'https://runtime.invalid',
                S3_BUCKET: 'shared-bucket',
                S3_ACCESS_KEY: 'runtime-access',
                S3_SECRET_KEY: 'runtime-secret',
                S3_PREFIX: 'active-space',
                BACKUP_S3_ENDPOINT: 'https://backup.invalid',
                BACKUP_S3_BUCKET: 'shared-bucket',
                BACKUP_S3_ACCESS_KEY: 'backup-access',
                BACKUP_S3_SECRET_KEY: 'backup-secret',
                BACKUP_S3_PREFIX: 'snapshots'
            });
        } catch (error) {
            unsafeRemotePruneRefused = error?.code === 'BACKUP_REPOSITORY_NOT_ISOLATED';
        }
        assert(unsafeRemotePruneRefused, 'remote prune must enforce repository isolation before any S3 request');

        const privateFailure = formatCliError(Object.assign(new Error('request failed for private-endpoint.invalid/private-bucket'), {
            code: 'NetworkingError'
        }));
        assert(privateFailure.code === 'BACKUP_COMMAND_FAILED', 'unknown provider failures should use a controlled public error code');
        assert(!JSON.stringify(privateFailure).includes('private-endpoint') && !JSON.stringify(privateFailure).includes('private-bucket'), 'CLI errors must not expose provider endpoints or bucket names');

        console.log('Backup CLI checks passed');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
