const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AuditLogger, hashRecord } = require('./scripts/security/audit-log');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

(async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-audit-'));
    const key = crypto.randomBytes(32);
    try {
        const logger = new AuditLogger({ directory, key });
        const first = await logger.append({ type: 'auth.login', actor: 'session-1', ip: '127.0.0.1', details: { path: '/api/auth/login', text: 'must not persist' } });
        const second = await logger.append({ type: 'data.operation', actor: 'session-1', details: { prefix: 'dumbpad-prod', objectCount: 3, totalBytes: 42 } });
        assert(second.previousHash === first.hash, 'audit entries should form a hash chain');
        assert(hashRecord(first, key) === first.hash, 'audit hashes should verify against the audit key');
        const log = await fs.promises.readFile(path.join(directory, `${first.timestamp.slice(0, 10)}.jsonl`), 'utf8');
        assert(!log.includes('must not persist'), 'audit logs must omit arbitrary content fields');
        assert(log.includes('dumbpad-prod'), 'audit logs should retain safe operation identifiers');
        console.log('Audit log checks passed');
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
