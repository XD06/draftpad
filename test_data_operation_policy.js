const {
    CLI_CONFIRM_PREFIX_ENV,
    DESTRUCTIVE_OPERATIONS_ENV,
    assertCliDestructivePrefix,
    assertDestructiveDataOperationEnabled,
    destructiveDataOperationsEnabled
} = require('./scripts/data-operation-policy');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function expectError(callback, code, message) {
    let thrown = null;
    try {
        callback();
    } catch (error) {
        thrown = error;
    }
    assert(thrown, message);
    assert(thrown.code === code, `${message}: expected ${code}, received ${thrown.code}`);
    return thrown;
}

const disabled = {};
const enabled = { [DESTRUCTIVE_OPERATIONS_ENV]: 'true' };

assert(!destructiveDataOperationsEnabled(disabled), 'destructive operations must be disabled by default');
assert(!destructiveDataOperationsEnabled({ [DESTRUCTIVE_OPERATIONS_ENV]: 'TRUE ' }), 'only an exact true value should enable destructive operations');
assert(destructiveDataOperationsEnabled(enabled), 'explicit true should enable destructive operations');

const disabledError = expectError(
    () => assertDestructiveDataOperationEnabled('delete S3 data space', { env: disabled }),
    'DESTRUCTIVE_DATA_OPERATION_DISABLED',
    'a disabled destructive operation should be rejected'
);
assert(disabledError.status === 403, 'disabled destructive operations should be forbidden');

expectError(
    () => assertCliDestructivePrefix('delete S3 data space', 'dumbpad-prod', { env: enabled }),
    'DESTRUCTIVE_DATA_PREFIX_NOT_CONFIRMED',
    'CLI deletion should require an explicit exact prefix confirmation'
);

expectError(
    () => assertCliDestructivePrefix('delete S3 data space', 'dumbpad-prod', {
        env: { ...enabled, [CLI_CONFIRM_PREFIX_ENV]: 'dumbpad-other' }
    }),
    'DESTRUCTIVE_DATA_PREFIX_NOT_CONFIRMED',
    'CLI deletion should reject a different prefix confirmation'
);

assertCliDestructivePrefix('delete S3 data space', 'dumbpad-prod', {
    env: { ...enabled, [CLI_CONFIRM_PREFIX_ENV]: 'dumbpad-prod' }
});

console.log('Data operation policy checks passed');
