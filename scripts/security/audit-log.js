const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

function canonicalRecord(record) {
    return JSON.stringify({
        timestamp: record.timestamp,
        type: record.type,
        actor: record.actor || null,
        ip: record.ip || null,
        outcome: record.outcome || 'success',
        details: record.details || {},
        previousHash: record.previousHash || ''
    });
}

function hashRecord(record, key) {
    return crypto.createHmac('sha256', key).update(canonicalRecord(record)).digest('hex');
}

function safeDetails(value) {
    const source = value && typeof value === 'object' ? value : {};
    const details = {};
    for (const key of ['action', 'method', 'path', 'prefix', 'objectCount', 'totalBytes', 'snapshotId', 'tokenId', 'deviceId', 'reason']) {
        if (source[key] === undefined || source[key] === null) continue;
        details[key] = typeof source[key] === 'string' ? source[key].slice(0, 180) : source[key];
    }
    return details;
}

class AuditLogger {
    constructor({ directory, key }) {
        if (!directory) throw new Error('An audit log directory is required');
        if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('An audit log key is required');
        this.directory = path.resolve(directory);
        this.key = key;
        this.statePath = path.join(this.directory, 'audit-state.json');
        this.queue = Promise.resolve();
    }

    async readState() {
        try {
            return JSON.parse(await fs.readFile(this.statePath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return { lastHash: '' };
            throw error;
        }
    }

    async append({ type, actor = null, ip = null, outcome = 'success', details = {} } = {}) {
        const operation = this.queue.then(async () => {
            if (!type) throw new Error('An audit event type is required');
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            const state = await this.readState();
            const timestamp = new Date().toISOString();
            const record = {
                timestamp,
                type: String(type).slice(0, 100),
                actor: actor ? String(actor).slice(0, 100) : null,
                ip: ip ? String(ip).slice(0, 100) : null,
                outcome: String(outcome).slice(0, 30),
                details: safeDetails(details),
                previousHash: state.lastHash || ''
            };
            record.hash = hashRecord(record, this.key);
            const day = timestamp.slice(0, 10);
            await fs.appendFile(path.join(this.directory, `${day}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
            await fs.writeFile(this.statePath, JSON.stringify({ lastHash: record.hash }), { encoding: 'utf8', mode: 0o600 });
            return record;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }
}

module.exports = { AuditLogger, canonicalRecord, hashRecord };
