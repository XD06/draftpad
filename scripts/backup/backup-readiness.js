const path = require('path');
const { parseMasterKey } = require('./backup-crypto');

const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;

function isTrue(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function isPresent(value) {
    return String(value || '').trim().length > 0;
}

function isAbsoluteDirectory(value) {
    const candidate = String(value || '').trim();
    if (!candidate || !(
        path.isAbsolute(candidate) ||
        path.posix.isAbsolute(candidate) ||
        path.win32.isAbsolute(candidate)
    )) return false;
    const resolved = path.resolve(candidate);
    return path.parse(resolved).root !== resolved;
}

function hasValidMasterKey(value, variableName) {
    try {
        parseMasterKey(value, variableName);
        return true;
    } catch {
        return false;
    }
}

function resolveBackupMaxBytes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return MAX_BACKUP_BYTES;
    return Math.min(Math.floor(parsed), MAX_BACKUP_BYTES);
}

function backupPolicyError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function assertBackupRuntimeSafety(env = {}) {
    const configuredCapacity = Number(env.BACKUP_MAX_BYTES || MAX_BACKUP_BYTES);
    if (!Number.isFinite(configuredCapacity) || configuredCapacity <= 0 || configuredCapacity > MAX_BACKUP_BYTES) {
        throw backupPolicyError('BACKUP_CAPACITY_INVALID', 'Backup capacity is outside the enforced safety limit');
    }

    const backend = String(env.STORAGE_BACKEND || 'local').trim().toLowerCase();
    if (backend !== 's3') return { maxBytes: resolveBackupMaxBytes(configuredCapacity) };

    const sourceConfigured = [
        env.S3_ENDPOINT,
        env.S3_BUCKET,
        env.S3_ACCESS_KEY,
        env.S3_SECRET_KEY || env.S3_API_KEY,
        env.S3_PREFIX
    ].every(isPresent);
    const backupConfigured = [
        env.BACKUP_S3_ENDPOINT,
        env.BACKUP_S3_BUCKET,
        env.BACKUP_S3_ACCESS_KEY,
        env.BACKUP_S3_SECRET_KEY,
        env.BACKUP_S3_PREFIX
    ].every(isPresent);
    if (!sourceConfigured || !backupConfigured) {
        throw backupPolicyError('BACKUP_CONFIGURATION_INCOMPLETE', 'S3 backup source and repository configuration must be complete');
    }
    if (String(env.S3_BUCKET) === String(env.BACKUP_S3_BUCKET)) {
        throw backupPolicyError('BACKUP_REPOSITORY_NOT_ISOLATED', 'Backup repository must be isolated from active data');
    }
    if (
        String(env.S3_ACCESS_KEY) === String(env.BACKUP_S3_ACCESS_KEY) &&
        String(env.S3_SECRET_KEY || env.S3_API_KEY) === String(env.BACKUP_S3_SECRET_KEY)
    ) {
        throw backupPolicyError('BACKUP_CREDENTIAL_NOT_ISOLATED', 'Backup credentials must be isolated from active data credentials');
    }
    return { maxBytes: resolveBackupMaxBytes(configuredCapacity) };
}

function evaluateBackupReadiness(env = {}) {
    const checks = [];
    const add = (id, passed, message, { warning = false } = {}) => {
        checks.push({
            id,
            status: passed ? 'pass' : (warning ? 'warn' : 'fail'),
            message
        });
    };

    const backend = String(env.STORAGE_BACKEND || 'local').trim().toLowerCase();
    add('runtime.production_mode', String(env.NODE_ENV || '').trim().toLowerCase() === 'production', 'NODE_ENV 必须为 production');
    add('runtime.storage_backend', backend === 'local' || backend === 's3', '存储模式必须为 local 或 s3');
    add(
        'runtime.destructive_operations',
        !isTrue(env.DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS),
        '日常运行必须关闭危险数据操作总开关'
    );

    add('backup.directory', isAbsoluteDirectory(env.BACKUP_DIR), '备份目录必须是宿主机绝对路径');
    add('backup.master_key', hasValidMasterKey(env.BACKUP_MASTER_KEY, 'BACKUP_MASTER_KEY'), '备份主密钥必须是有效的独立 32 字节密钥');

    const configuredCapacity = Number(env.BACKUP_MAX_BYTES || MAX_BACKUP_BYTES);
    add(
        'backup.capacity',
        Number.isFinite(configuredCapacity) && configuredCapacity > 0 && configuredCapacity <= MAX_BACKUP_BYTES,
        '单个备份仓库容量必须在 1 字节到 1 GiB 之间'
    );

    if (backend === 'local') {
        add('runtime.local_data_directory', isAbsoluteDirectory(env.DATA_DIR), '生产本地数据目录必须是绝对路径');
    }

    if (backend === 's3') {
        const sourceConfigured = [
            env.S3_ENDPOINT,
            env.S3_BUCKET,
            env.S3_ACCESS_KEY,
            env.S3_SECRET_KEY || env.S3_API_KEY,
            env.S3_PREFIX
        ].every(isPresent);
        const backupConfigured = [
            env.BACKUP_S3_ENDPOINT,
            env.BACKUP_S3_BUCKET,
            env.BACKUP_S3_ACCESS_KEY,
            env.BACKUP_S3_SECRET_KEY,
            env.BACKUP_S3_PREFIX
        ].every(isPresent);
        add('runtime.s3_source', sourceConfigured, 'S3 运行源配置必须完整');
        add('runtime.split_layout', String(env.STORAGE_LAYOUT || '').trim().toLowerCase() === 'split', 'S3 生产数据应使用 split 布局');
        add('backup.s3_repository', backupConfigured, 'S3 数据必须配置独立的远端备份仓库');
        add(
            'backup.repository_isolation',
            sourceConfigured && backupConfigured && String(env.S3_BUCKET) !== String(env.BACKUP_S3_BUCKET),
            '运行数据与备份必须位于不同 bucket'
        );
        add(
            'backup.credential_isolation',
            sourceConfigured && backupConfigured && !(
                String(env.S3_ACCESS_KEY) === String(env.BACKUP_S3_ACCESS_KEY) &&
                String(env.S3_SECRET_KEY || env.S3_API_KEY) === String(env.BACKUP_S3_SECRET_KEY)
            ),
            '运行源凭证与备份仓库凭证必须相互独立'
        );
        add('runtime.source_scope_review', false, '仍需人工确认运行源凭证只有读取备份所需的最小权限', { warning: true });
        add('backup.repository_scope_review', false, '仍需人工确认备份凭证不能访问运行数据 bucket', { warning: true });
    }

    const authEnabled = isTrue(env.AUTH_V2_ENABLED);
    add('auth.v2', authEnabled, '生产环境必须启用个人密码、TOTP 与可信设备认证');
    add('auth.state_directory', authEnabled && isAbsoluteDirectory(env.AUTH_STATE_DIR), '认证状态必须使用宿主机绝对持久目录');
    add('auth.master_key', authEnabled && hasValidMasterKey(env.AUTH_MASTER_KEY, 'AUTH_MASTER_KEY'), '认证主密钥必须是有效的独立 32 字节密钥');
    const shareSecret = String(env.SHARE_SECRET || '').trim();
    add(
        'auth.share_secret',
        shareSecret.length >= 32 && shareSecret !== String(env.DUMBPAD_PIN || ''),
        '分享签名必须使用独立的高熵密钥'
    );

    const ready = checks.every(check => check.status !== 'fail');
    return {
        status: ready ? 'ready' : 'blocked',
        ready,
        mode: backend,
        maxBackupBytes: MAX_BACKUP_BYTES,
        checks
    };
}

module.exports = {
    assertBackupRuntimeSafety,
    evaluateBackupReadiness,
    MAX_BACKUP_BYTES,
    resolveBackupMaxBytes
};
