const crypto = require('crypto');
const {
    assertBackupRuntimeSafety,
    evaluateBackupReadiness,
    MAX_BACKUP_BYTES,
    resolveBackupMaxBytes
} = require('./scripts/backup/backup-readiness');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function validProductionEnv() {
    return {
        NODE_ENV: 'production',
        STORAGE_BACKEND: 's3',
        STORAGE_LAYOUT: 'split',
        S3_ENDPOINT: 'https://runtime.invalid',
        S3_REGION: 'auto',
        S3_BUCKET: 'runtime-private-bucket',
        S3_ACCESS_KEY: 'runtime-read-only-access',
        S3_SECRET_KEY: 'runtime-read-only-secret',
        S3_PREFIX: 'runtime-private-prefix',
        BACKUP_DIR: '/var/lib/dumbpad-backups',
        BACKUP_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
        BACKUP_MAX_BYTES: String(MAX_BACKUP_BYTES),
        BACKUP_S3_ENDPOINT: 'https://backup.invalid',
        BACKUP_S3_REGION: 'auto',
        BACKUP_S3_BUCKET: 'backup-private-bucket',
        BACKUP_S3_ACCESS_KEY: 'backup-only-access',
        BACKUP_S3_SECRET_KEY: 'backup-only-secret',
        BACKUP_S3_PREFIX: 'encrypted-snapshots',
        DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS: 'false',
        AUTH_V2_ENABLED: 'true',
        AUTH_STATE_DIR: '/var/lib/dumbpad-security',
        AUTH_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
        SHARE_SECRET: crypto.randomBytes(32).toString('hex'),
        DUMBPAD_PIN: 'legacy-bootstrap-pin'
    };
}

function hasIssue(report, id) {
    return report.checks.some(check => check.id === id && check.status === 'fail');
}

function expectRuntimePolicyError(env, code) {
    let thrown = null;
    try {
        assertBackupRuntimeSafety(env);
    } catch (error) {
        thrown = error;
    }
    assert(thrown?.code === code, `backup write path must enforce ${code}`);
    const serialized = String(thrown?.message || '');
    Object.values(env).filter(value => typeof value === 'string' && value.length > 8).forEach(value => {
        assert(!serialized.includes(value), 'backup policy errors must not expose configured values');
    });
}

(() => {
    const env = validProductionEnv();
    const report = evaluateBackupReadiness(env);
    assert(report.ready === true && report.status === 'ready', 'an isolated production backup configuration should be ready');
    assert(report.checks.length >= 8, 'readiness should report the important production safety checks');

    const serialized = JSON.stringify(report);
    const privateValues = [
        env.S3_ENDPOINT,
        env.S3_BUCKET,
        env.S3_ACCESS_KEY,
        env.S3_SECRET_KEY,
        env.S3_PREFIX,
        env.BACKUP_MASTER_KEY,
        env.BACKUP_S3_ENDPOINT,
        env.BACKUP_S3_BUCKET,
        env.BACKUP_S3_ACCESS_KEY,
        env.BACKUP_S3_SECRET_KEY,
        env.BACKUP_S3_PREFIX,
        env.AUTH_MASTER_KEY,
        env.SHARE_SECRET,
        env.DUMBPAD_PIN
    ];
    privateValues.forEach(value => {
        assert(!serialized.includes(value), 'readiness output must not expose configured values or credentials');
    });

    const sharedBucket = evaluateBackupReadiness({ ...env, BACKUP_S3_BUCKET: env.S3_BUCKET });
    assert(!sharedBucket.ready && hasIssue(sharedBucket, 'backup.repository_isolation'), 'runtime and backup data must use different buckets');
    expectRuntimePolicyError({ ...env, BACKUP_S3_BUCKET: env.S3_BUCKET }, 'BACKUP_REPOSITORY_NOT_ISOLATED');

    const sharedCredentials = evaluateBackupReadiness({
        ...env,
        BACKUP_S3_ACCESS_KEY: env.S3_ACCESS_KEY,
        BACKUP_S3_SECRET_KEY: env.S3_SECRET_KEY
    });
    assert(!sharedCredentials.ready && hasIssue(sharedCredentials, 'backup.credential_isolation'), 'runtime and backup buckets must not share credentials');
    expectRuntimePolicyError({
        ...env,
        BACKUP_S3_ACCESS_KEY: env.S3_ACCESS_KEY,
        BACKUP_S3_SECRET_KEY: env.S3_SECRET_KEY
    }, 'BACKUP_CREDENTIAL_NOT_ISOLATED');

    const destructiveEnabled = evaluateBackupReadiness({ ...env, DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS: 'true' });
    assert(!destructiveEnabled.ready && hasIssue(destructiveEnabled, 'runtime.destructive_operations'), 'production readiness must reject enabled destructive operations');

    const weakAuth = evaluateBackupReadiness({ ...env, AUTH_V2_ENABLED: 'false', AUTH_MASTER_KEY: '', SHARE_SECRET: '' });
    assert(!weakAuth.ready && hasIssue(weakAuth, 'auth.v2') && hasIssue(weakAuth, 'auth.share_secret'), 'production readiness must require personal authentication and a dedicated share secret');

    const oversized = evaluateBackupReadiness({ ...env, BACKUP_MAX_BYTES: String(MAX_BACKUP_BYTES + 1) });
    assert(!oversized.ready && hasIssue(oversized, 'backup.capacity'), 'configured backup capacity above 1 GiB must fail readiness');
    expectRuntimePolicyError({ ...env, BACKUP_MAX_BYTES: String(MAX_BACKUP_BYTES + 1) }, 'BACKUP_CAPACITY_INVALID');
    assert(resolveBackupMaxBytes(String(MAX_BACKUP_BYTES + 12345)) === MAX_BACKUP_BYTES, 'runtime backup capacity must be clamped to the 1 GiB hard limit');
    assert(resolveBackupMaxBytes('invalid') === MAX_BACKUP_BYTES, 'invalid capacity should use the safe 1 GiB default');

    const rootDirectory = evaluateBackupReadiness({ ...env, BACKUP_DIR: require('path').parse(process.cwd()).root });
    assert(!rootDirectory.ready && hasIssue(rootDirectory, 'backup.directory'), 'a filesystem root must never be accepted as the backup repository');

    console.log('Backup production readiness checks passed');
})();
