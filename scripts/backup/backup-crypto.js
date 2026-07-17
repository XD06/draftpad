const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('DPB1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseMasterKey(value, variableName = 'BACKUP_MASTER_KEY') {
    const source = String(value || '').trim();
    if (!source) throw new Error(`${variableName} is required`);

    const key = /^[a-f0-9]{64}$/i.test(source)
        ? Buffer.from(source, 'hex')
        : Buffer.from(source, 'base64');
    if (key.length !== 32) throw new Error(`${variableName} must be 32 bytes encoded as base64 or 64 hexadecimal characters`);
    return key;
}

function deriveKey(masterKey, label) {
    return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(label, 'utf8'), 32));
}

function blockIdForBuffer(buffer, masterKey) {
    return crypto
        .createHmac('sha256', deriveKey(masterKey, 'dumbpad-backup-dedup-v1'))
        .update(buffer)
        .digest('hex');
}

function compressBuffer(buffer) {
    const compressed = zlib.brotliCompressSync(buffer, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4
        }
    });
    if (compressed.length + 32 < buffer.length) {
        return { algorithm: 'brotli', buffer: compressed };
    }
    return { algorithm: 'none', buffer };
}

function decompressBuffer(buffer, algorithm) {
    if (algorithm === 'none') return buffer;
    if (algorithm === 'brotli') return zlib.brotliDecompressSync(buffer);
    throw new Error(`Unsupported backup compression algorithm: ${algorithm}`);
}

function encryptBuffer(buffer, masterKey) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(masterKey, 'dumbpad-backup-encryption-v1'), iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(envelope, masterKey) {
    const buffer = Buffer.from(envelope);
    const minimumLength = MAGIC.length + IV_BYTES + TAG_BYTES;
    if (buffer.length < minimumLength || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('Invalid encrypted backup envelope');
    }
    const ivStart = MAGIC.length;
    const tagStart = ivStart + IV_BYTES;
    const contentStart = tagStart + TAG_BYTES;
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        deriveKey(masterKey, 'dumbpad-backup-encryption-v1'),
        buffer.subarray(ivStart, tagStart)
    );
    decipher.setAuthTag(buffer.subarray(tagStart, contentStart));
    return Buffer.concat([decipher.update(buffer.subarray(contentStart)), decipher.final()]);
}

function encodeBlock(buffer, masterKey) {
    const compressed = compressBuffer(buffer);
    const algorithm = compressed.algorithm === 'brotli' ? 1 : 0;
    return {
        encrypted: Buffer.concat([Buffer.from([algorithm]), encryptBuffer(compressed.buffer, masterKey)]),
        originalBytes: buffer.length
    };
}

function decodeBlock(encrypted, originalBytes, masterKey) {
    const envelope = Buffer.from(encrypted);
    const algorithmCode = envelope.at(0);
    const algorithm = algorithmCode === 1 ? 'brotli' : algorithmCode === 0 ? 'none' : '';
    if (!algorithm) throw new Error('Unsupported backup block encoding');
    const raw = decompressBuffer(decryptBuffer(envelope.subarray(1), masterKey), algorithm);
    if (raw.length !== originalBytes) throw new Error('Backup block size verification failed');
    return raw;
}

function encodeJson(value, masterKey) {
    return encryptBuffer(Buffer.from(JSON.stringify(value), 'utf8'), masterKey);
}

function decodeJson(encrypted, masterKey) {
    return JSON.parse(decryptBuffer(encrypted, masterKey).toString('utf8'));
}

module.exports = {
    blockIdForBuffer,
    decodeBlock,
    decodeJson,
    deriveKey,
    encodeBlock,
    encodeJson,
    parseMasterKey
};
