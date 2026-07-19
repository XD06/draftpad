const {
    assertRestoreTargetIsolation,
    restoreS3ConfigFromEnv
} = require('./scripts/backup/backup-restore-policy');
const { sourceS3ObjectStoreFromEnv } = require('./scripts/backup/backup-cli');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function expectPolicyError(callback, code, privateValues = []) {
    let thrown = null;
    try {
        callback();
    } catch (error) {
        thrown = error;
    }
    assert(thrown?.code === code, `expected restore policy error ${code}`);
    privateValues.forEach(value => {
        assert(!String(thrown.message || '').includes(value), 'restore policy errors must not expose configured values');
    });
}

(() => {
    const env = {
        S3_ENDPOINT: 'https://runtime.invalid',
        S3_REGION: 'auto',
        S3_BUCKET: 'runtime-private-bucket',
        S3_ACCESS_KEY: 'runtime-read-only-access',
        S3_SECRET_KEY: 'runtime-read-only-secret',
        S3_PREFIX: 'active-space',
        BACKUP_S3_BUCKET: 'backup-private-bucket',
        RESTORE_S3_ENDPOINT: 'https://restore.invalid',
        RESTORE_S3_REGION: 'auto',
        RESTORE_S3_BUCKET: 'restore-private-bucket',
        RESTORE_S3_ACCESS_KEY: 'one-time-restore-access',
        RESTORE_S3_SECRET_KEY: 'one-time-restore-secret'
    };

    const source = sourceS3ObjectStoreFromEnv(env);
    assert(typeof source.list === 'function' && typeof source.get === 'function', 'backup source should expose read capabilities');
    assert(source.put === undefined && source.copy === undefined && source.delete === undefined, 'backup source must not expose write or delete capabilities');

    const safe = assertRestoreTargetIsolation(env, 'isolated-recovery');
    assert(safe.targetPrefix === 'isolated-recovery', 'a separate restore target should pass the offline policy');

    const config = restoreS3ConfigFromEnv(env);
    assert(config.bucket === env.RESTORE_S3_BUCKET, 'restore should use the explicit one-time target configuration');

    expectPolicyError(
        () => assertRestoreTargetIsolation({ ...env, RESTORE_S3_BUCKET: env.S3_BUCKET }, env.S3_PREFIX),
        'RESTORE_TARGET_OVERLAPS_ACTIVE_DATA',
        [env.S3_BUCKET, env.S3_PREFIX]
    );
    expectPolicyError(
        () => assertRestoreTargetIsolation({ ...env, RESTORE_S3_BUCKET: env.S3_BUCKET }, `${env.S3_PREFIX}/child`),
        'RESTORE_TARGET_OVERLAPS_ACTIVE_DATA',
        [env.S3_BUCKET, env.S3_PREFIX]
    );
    expectPolicyError(
        () => assertRestoreTargetIsolation({ ...env, RESTORE_S3_BUCKET: env.BACKUP_S3_BUCKET }, 'isolated-recovery'),
        'RESTORE_TARGET_USES_BACKUP_BUCKET',
        [env.BACKUP_S3_BUCKET]
    );
    expectPolicyError(
        () => assertRestoreTargetIsolation({
            ...env,
            RESTORE_S3_ACCESS_KEY: env.S3_ACCESS_KEY,
            RESTORE_S3_SECRET_KEY: env.S3_SECRET_KEY
        }, 'isolated-recovery'),
        'RESTORE_CREDENTIAL_NOT_ISOLATED',
        [env.S3_ACCESS_KEY, env.S3_SECRET_KEY]
    );
    expectPolicyError(
        () => restoreS3ConfigFromEnv({ ...env, RESTORE_S3_SECRET_KEY: '' }),
        'RESTORE_CONFIGURATION_INCOMPLETE',
        [env.RESTORE_S3_ACCESS_KEY]
    );

    console.log('Backup restore policy checks passed');
})();
