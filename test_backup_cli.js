const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./scripts/backup/backup-cli');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

(async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-backup-cli-'));
    const dataDirectory = path.join(root, 'data');
    const backupDirectory = path.join(root, 'backups');
    const restoreDirectory = path.join(root, 'restore');
    const env = {
        STORAGE_BACKEND: 'local',
        DATA_DIR: dataDirectory,
        BACKUP_DIR: backupDirectory,
        BACKUP_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
        BACKUP_MAX_BYTES: String(1024 * 1024)
    };

    try {
        await fs.promises.mkdir(dataDirectory, { recursive: true });
        await fs.promises.writeFile(path.join(dataDirectory, 'notepads.json'), '{"notepads":[]}');
        await fs.promises.writeFile(path.join(dataDirectory, 'default.txt'), 'CLI backup note');

        const snapshot = await run(['snapshot'], env);
        assert(snapshot.local.fileCount === 2, 'backup CLI should snapshot local canonical data');
        assert(snapshot.remoteConfigured === false, 'local backup CLI should report an optional remote repository as absent');

        const listed = await run(['list'], env);
        assert(listed.length === 1 && listed[0].id === snapshot.local.id, 'backup CLI should list the snapshot it created');

        const restored = await run([
            'restore-local',
            '--snapshot', snapshot.local.id,
            '--target-directory', restoreDirectory
        ], env);
        assert(restored.restoredFiles === 2, 'backup CLI should restore local snapshots to an empty directory');
        assert(await fs.promises.readFile(path.join(restoreDirectory, 'default.txt'), 'utf8') === 'CLI backup note', 'backup CLI restore should preserve note contents');

        console.log('Backup CLI checks passed');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
