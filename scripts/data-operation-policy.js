const DESTRUCTIVE_OPERATIONS_ENV = 'DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS';
const CLI_CONFIRM_PREFIX_ENV = 'DUMBPAD_DESTRUCTIVE_S3_CONFIRM_PREFIX';

function cleanPrefix(value) {
    return String(value || '').replace(/^\/+|\/+$/g, '');
}

function destructiveDataOperationsEnabled(env = process.env) {
    return String(env?.[DESTRUCTIVE_OPERATIONS_ENV] || '').toLowerCase() === 'true';
}

function createOperationDisabledError(operation) {
    const error = new Error(
        `${operation} is disabled. Set ${DESTRUCTIVE_OPERATIONS_ENV}=true only for a reviewed recovery operation.`
    );
    error.code = 'DESTRUCTIVE_DATA_OPERATION_DISABLED';
    error.status = 403;
    return error;
}

function assertDestructiveDataOperationEnabled(operation, { env = process.env } = {}) {
    if (!destructiveDataOperationsEnabled(env)) {
        throw createOperationDisabledError(operation);
    }
}

function assertCliDestructivePrefix(operation, prefix, { env = process.env } = {}) {
    assertDestructiveDataOperationEnabled(operation, { env });
    const clean = cleanPrefix(prefix);
    if (!clean || clean !== cleanPrefix(env?.[CLI_CONFIRM_PREFIX_ENV])) {
        const error = new Error(
            `${operation} requires ${CLI_CONFIRM_PREFIX_ENV} to exactly match the target prefix.`
        );
        error.code = 'DESTRUCTIVE_DATA_PREFIX_NOT_CONFIRMED';
        error.status = 400;
        throw error;
    }
}

module.exports = {
    CLI_CONFIRM_PREFIX_ENV,
    DESTRUCTIVE_OPERATIONS_ENV,
    assertCliDestructivePrefix,
    assertDestructiveDataOperationEnabled,
    cleanPrefix,
    destructiveDataOperationsEnabled
};
