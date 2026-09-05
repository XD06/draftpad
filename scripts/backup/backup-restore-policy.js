const { cleanPrefix } = require('./s3-object-store');

function policyError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isPresent(value) {
    return String(value || '').trim().length > 0;
}

function sameCredentials(leftAccess, leftSecret, rightAccess, rightSecret) {
    return isPresent(leftAccess) && isPresent(leftSecret) &&
        String(leftAccess) === String(rightAccess) && String(leftSecret) === String(rightSecret);
}

function restoreS3ConfigFromEnv(env = {}) {
    const config = {
        endpoint: env.RESTORE_S3_ENDPOINT,
        region: env.RESTORE_S3_REGION || 'auto',
        bucket: env.RESTORE_S3_BUCKET,
        accessKeyId: env.RESTORE_S3_ACCESS_KEY,
        secretAccessKey: env.RESTORE_S3_SECRET_KEY
    };
    if (![config.endpoint, config.bucket, config.accessKeyId, config.secretAccessKey].every(isPresent)) {
        throw policyError('RESTORE_CONFIGURATION_INCOMPLETE', 'Independent restore target configuration is incomplete');
    }
    return config;
}

function prefixesOverlap(left, right) {
    const a = cleanPrefix(left);
    const b = cleanPrefix(right);
    if (!a || !b) return false;
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function assertRestoreTargetIsolation(env = {}, targetPrefix = '') {
    const config = restoreS3ConfigFromEnv(env);
    const cleanTargetPrefix = cleanPrefix(targetPrefix);
    if (!cleanTargetPrefix) {
        throw policyError('RESTORE_TARGET_PREFIX_REQUIRED', 'A non-empty isolated restore prefix is required');
    }

    if (String(config.bucket) === String(env.S3_BUCKET) && prefixesOverlap(cleanTargetPrefix, env.S3_PREFIX)) {
        throw policyError('RESTORE_TARGET_OVERLAPS_ACTIVE_DATA', 'Restore target overlaps the active data space');
    }
    if (isPresent(env.BACKUP_S3_BUCKET) && String(config.bucket) === String(env.BACKUP_S3_BUCKET)) {
        throw policyError('RESTORE_TARGET_USES_BACKUP_BUCKET', 'Restore target must not use the backup repository bucket');
    }
    if (sameCredentials(config.accessKeyId, config.secretAccessKey, env.S3_ACCESS_KEY, env.S3_SECRET_KEY || env.S3_API_KEY)) {
        throw policyError('RESTORE_CREDENTIAL_NOT_ISOLATED', 'Restore credentials must be isolated from the active data credentials');
    }
    if (sameCredentials(config.accessKeyId, config.secretAccessKey, env.BACKUP_S3_ACCESS_KEY, env.BACKUP_S3_SECRET_KEY)) {
        throw policyError('RESTORE_CREDENTIAL_NOT_ISOLATED', 'Restore credentials must be isolated from the backup repository credentials');
    }

    return { targetPrefix: cleanTargetPrefix };
}

module.exports = {
    assertRestoreTargetIsolation,
    prefixesOverlap,
    restoreS3ConfigFromEnv
};
