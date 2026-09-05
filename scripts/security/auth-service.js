const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { parseMasterKey } = require('../backup/backup-crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TRUSTED_DEVICE_MS = 60 * 24 * 60 * 60 * 1000;
const ELEVATION_MS = 10 * 60 * 1000;
const ACTIVITY_TOUCH_MS = 5 * 60 * 1000;
const MAX_TRUSTED_DEVICES = 5;

class AuthServiceError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function base32Encode(buffer) {
    let bits = '';
    for (const byte of Buffer.from(buffer)) bits += byte.toString(2).padStart(8, '0');
    let output = '';
    for (let index = 0; index < bits.length; index += 5) {
        const chunk = bits.slice(index, index + 5).padEnd(5, '0');
        output += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
    }
    return output;
}

function base32Decode(value) {
    const normalized = String(value || '').toUpperCase().replace(/[\s-]/g, '');
    if (!normalized || /[^A-Z2-7]/.test(normalized)) throw new AuthServiceError('INVALID_TOTP_SECRET', 'Invalid TOTP secret');
    let bits = '';
    for (const character of normalized) bits += BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, '0');
    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
    return Buffer.from(bytes);
}

function generateTotpSecret() {
    return base32Encode(crypto.randomBytes(20));
}

function generateTotpCode(secret, now = Date.now()) {
    const counter = Math.floor(now / 30000);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const integer = ((digest[offset] & 0x7f) << 24)
        | (digest[offset + 1] << 16)
        | (digest[offset + 2] << 8)
        | digest[offset + 3];
    return String(integer % 1000000).padStart(6, '0');
}

function verifyTotpCode(secret, code, now = Date.now()) {
    const normalized = String(code || '').trim();
    if (!/^\d{6}$/.test(normalized)) return false;
    for (const offset of [-30000, 0, 30000]) {
        const expected = generateTotpCode(secret, now + offset);
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) return true;
    }
    return false;
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
    const value = String(password || '');
    if (value.length < 12) throw new AuthServiceError('WEAK_PASSWORD', 'Master password must contain at least 12 characters');
    return {
        algorithm: 'scrypt',
        salt: Buffer.from(salt).toString('base64'),
        hash: crypto.scryptSync(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64')
    };
}

function verifyPassword(password, record) {
    if (!record?.salt || !record?.hash) return false;
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(record.salt, 'base64'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const expected = Buffer.from(record.hash, 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function encryptSecret(value, masterKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function decryptSecret(value, masterKey) {
    const buffer = Buffer.from(String(value || ''), 'base64');
    if (buffer.length < 28) throw new AuthServiceError('AUTH_STATE_INVALID', 'Stored authentication secret is invalid', 500);
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

function createRecoveryCodes(count = 10) {
    return Array.from({ length: count }, () => `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase());
}

function defaultState() {
    return {
        version: 1,
        initialized: false,
        password: null,
        totp: null,
        recoveryCodes: [],
        sessions: [],
        devices: [],
        apiTokens: []
    };
}

function safeLabel(value, fallback) {
    return String(value || fallback).replace(/[\r\n]/g, ' ').trim().slice(0, 100) || fallback;
}

function allowedScopes(scopes) {
    const allowed = new Set(['content:read', 'content:write', 'thoughts:read', 'thoughts:write']);
    const unique = [...new Set((Array.isArray(scopes) ? scopes : []).filter(scope => allowed.has(scope)))];
    if (!unique.length) throw new AuthServiceError('INVALID_API_TOKEN_SCOPE', 'At least one content scope is required');
    return unique;
}

class AuthService {
    constructor({ stateDirectory, masterKey, now = () => Date.now() } = {}) {
        if (!stateDirectory) throw new Error('AUTH_STATE_DIR is required');
        this.stateDirectory = path.resolve(stateDirectory);
        this.statePath = path.join(this.stateDirectory, 'auth-state.json');
        this.masterKey = Buffer.isBuffer(masterKey) ? masterKey : parseMasterKey(masterKey, 'AUTH_MASTER_KEY');
        if (this.masterKey.length !== 32) throw new Error('AUTH_MASTER_KEY must be 32 bytes');
        this.now = now;
        // The state file is an atomic single-file store. Serialize mutations in
        // this process so simultaneous logins/revocations cannot lose records.
        this.stateMutationQueue = Promise.resolve();
    }

    runStateMutation(operation) {
        const pending = this.stateMutationQueue.then(operation);
        this.stateMutationQueue = pending.catch(() => {});
        return pending;
    }

    async loadState() {
        try {
            const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
            return { ...defaultState(), ...parsed };
        } catch (error) {
            if (error.code === 'ENOENT') return defaultState();
            throw new AuthServiceError('AUTH_STATE_INVALID', 'Authentication state cannot be read', 500);
        }
    }

    async saveState(state) {
        await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryPath, this.statePath);
    }

    async status() {
        const state = await this.loadState();
        return { initialized: Boolean(state.initialized) };
    }

    requireSession(state, sessionToken, { requireElevation = false, now = this.now() } = {}) {
        const session = state.sessions.find(item => item.tokenHash === hashToken(sessionToken) && item.expiresAt > now);
        if (!session) throw new AuthServiceError('UNAUTHORIZED', 'Authentication is required', 401);
        if (requireElevation && session.elevatedUntil <= now) {
            throw new AuthServiceError('ELEVATION_REQUIRED', 'Recent authenticator verification is required', 403);
        }
        return session;
    }

    validateRecoveryState(state, { password, recoveryCode } = {}) {
        if (!state.initialized) throw new AuthServiceError('AUTH_NOT_INITIALIZED', 'Authentication setup is required', 503);
        if (!verifyPassword(password, state.password)) throw new AuthServiceError('INVALID_CREDENTIALS', 'Invalid credentials', 401);
        const index = state.recoveryCodes.indexOf(hashToken(String(recoveryCode || '').toUpperCase()));
        if (index < 0) throw new AuthServiceError('INVALID_RECOVERY_CODE', 'Recovery code is invalid', 401);
        return { index };
    }

    authenticateState(state, { password, totpCode, trustedDeviceToken, trustDevice = true, deviceLabel = 'Unknown device' } = {}) {
        if (!state.initialized) throw new AuthServiceError('AUTH_NOT_INITIALIZED', 'Authentication setup is required', 503);
        if (!verifyPassword(password, state.password)) throw new AuthServiceError('INVALID_CREDENTIALS', 'Invalid credentials', 401);

        const now = this.now();
        state.devices = state.devices.filter(device => device.expiresAt > now);
        let device = state.devices.find(item => item.tokenHash === hashToken(trustedDeviceToken));
        const totpSecret = decryptSecret(state.totp, this.masterKey);
        if (!device && !verifyTotpCode(totpSecret, totpCode, now)) {
            throw new AuthServiceError('TOTP_REQUIRED', 'A valid authenticator code is required', 401);
        }

        let deviceToken = null;
        let deviceTrustLimited = false;
        if (!device && trustDevice) {
            if (state.devices.length >= MAX_TRUSTED_DEVICES) {
                deviceTrustLimited = true;
            } else {
                deviceToken = randomToken();
                device = {
                    id: crypto.randomUUID(),
                    tokenHash: hashToken(deviceToken),
                    label: safeLabel(deviceLabel, 'Trusted device'),
                    createdAt: now,
                    lastSeenAt: now,
                    expiresAt: now + TRUSTED_DEVICE_MS
                };
                state.devices.push(device);
            }
        } else if (device) {
            device.lastSeenAt = now;
        }

        const sessionToken = randomToken();
        state.sessions = state.sessions.filter(session => session.expiresAt > now);
        state.sessions.push({
            id: crypto.randomUUID(),
            tokenHash: hashToken(sessionToken),
            deviceId: device?.id || null,
            createdAt: now,
            lastSeenAt: now,
            expiresAt: now + SESSION_MS,
            elevatedUntil: 0
        });
        return {
            sessionToken,
            deviceToken,
            deviceTrustLimited,
            expiresAt: now + SESSION_MS,
            deviceExpiresAt: device?.expiresAt || null
        };
    }

    async initialize({ password, totpSecret, totpCode } = {}) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            if (state.initialized) throw new AuthServiceError('AUTH_ALREADY_INITIALIZED', 'Authentication is already initialized', 409);
            if (!verifyTotpCode(totpSecret, totpCode, this.now())) {
                throw new AuthServiceError('INVALID_TOTP_CODE', 'The authenticator code is invalid', 401);
            }
            const recoveryCodes = createRecoveryCodes();
            const next = {
                ...defaultState(),
                initialized: true,
                initializedAt: this.now(),
                password: hashPassword(password),
                totp: encryptSecret(totpSecret, this.masterKey),
                recoveryCodes: recoveryCodes.map(code => hashToken(code)),
                sessions: [],
                devices: [],
                apiTokens: []
            };
            await this.saveState(next);
            return { recoveryCodes };
        });
    }

    async validateRecovery({ password, recoveryCode } = {}) {
        const state = await this.loadState();
        return this.validateRecoveryState(state, { password, recoveryCode });
    }

    async recover({ password, recoveryCode, totpSecret, totpCode, deviceLabel = 'Recovered device' } = {}) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            const validation = this.validateRecoveryState(state, { password, recoveryCode });
            if (!verifyTotpCode(totpSecret, totpCode, this.now())) {
                throw new AuthServiceError('INVALID_TOTP_CODE', 'The authenticator code is invalid', 401);
            }
            state.totp = encryptSecret(totpSecret, this.masterKey);
            state.recoveryCodes.splice(validation.index, 1);
            const login = this.authenticateState(state, { password, totpCode, trustedDeviceToken: '', trustDevice: true, deviceLabel });
            await this.saveState(state);
            return login;
        });
    }

    async authenticate({ password, totpCode, trustedDeviceToken, trustDevice = true, deviceLabel = 'Unknown device' } = {}) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            const login = this.authenticateState(state, { password, totpCode, trustedDeviceToken, trustDevice, deviceLabel });
            await this.saveState(state);
            return login;
        });
    }

    async authorizeSession(sessionToken, { requireElevation = false } = {}) {
        const state = await this.loadState();
        const now = this.now();
        const session = this.requireSession(state, sessionToken, { requireElevation, now });
        const response = { sessionId: session.id, deviceId: session.deviceId, elevatedUntil: session.elevatedUntil, expiresAt: session.expiresAt };
        if (now - Number(session.lastSeenAt || 0) < ACTIVITY_TOUCH_MS) return response;
        return this.runStateMutation(async () => {
            const current = await this.loadState();
            const active = this.requireSession(current, sessionToken, { requireElevation, now: this.now() });
            active.lastSeenAt = this.now();
            await this.saveState(current);
            return { sessionId: active.id, deviceId: active.deviceId, elevatedUntil: active.elevatedUntil, expiresAt: active.expiresAt };
        });
    }

    async elevate(sessionToken, totpCode) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            const now = this.now();
            const session = this.requireSession(state, sessionToken, { now });
            if (!verifyTotpCode(decryptSecret(state.totp, this.masterKey), totpCode, now)) {
                throw new AuthServiceError('INVALID_TOTP_CODE', 'The authenticator code is invalid', 401);
            }
            session.elevatedUntil = now + ELEVATION_MS;
            await this.saveState(state);
            return { elevatedUntil: session.elevatedUntil };
        });
    }

    async revokeSession(sessionToken) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            const tokenHash = hashToken(sessionToken);
            const before = state.sessions.length;
            state.sessions = state.sessions.filter(session => session.tokenHash !== tokenHash);
            if (state.sessions.length !== before) await this.saveState(state);
            return { revoked: state.sessions.length !== before };
        });
    }

    async listDevices(sessionToken) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            const now = this.now();
            this.requireSession(state, sessionToken, { requireElevation: true, now });
            return state.devices
                .filter(device => device.expiresAt > now)
                .map(({ tokenHash, ...device }) => ({ ...device }));
        });
    }

    async revokeDevice(sessionToken, deviceId) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            this.requireSession(state, sessionToken, { requireElevation: true });
            const id = String(deviceId || '');
            const before = state.devices.length;
            state.devices = state.devices.filter(device => device.id !== id);
            state.sessions = state.sessions.filter(session => session.deviceId !== id);
            if (state.devices.length === before) throw new AuthServiceError('DEVICE_NOT_FOUND', 'Trusted device was not found', 404);
            await this.saveState(state);
            return { revoked: true };
        });
    }

    async createApiToken(sessionToken, { name, scopes, expiresAt = null } = {}) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            const now = this.now();
            this.requireSession(state, sessionToken, { requireElevation: true, now });
            const token = randomToken();
            const parsedExpiresAt = expiresAt === null ? null : Number(expiresAt);
            if (parsedExpiresAt !== null && (!Number.isFinite(parsedExpiresAt) || parsedExpiresAt <= now)) {
                throw new AuthServiceError('INVALID_API_TOKEN_EXPIRY', 'API token expiry must be in the future');
            }
            const record = {
                id: crypto.randomUUID(),
                tokenHash: hashToken(token),
                name: safeLabel(name, 'API token'),
                scopes: allowedScopes(scopes),
                createdAt: now,
                expiresAt: parsedExpiresAt,
                lastUsedAt: null
            };
            state.apiTokens.push(record);
            await this.saveState(state);
            return { token, id: record.id, name: record.name, scopes: record.scopes, expiresAt: record.expiresAt };
        });
    }

    async listApiTokens(sessionToken) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            this.requireSession(state, sessionToken, { requireElevation: true });
            return state.apiTokens.map(({ tokenHash, ...token }) => ({ ...token }));
        });
    }

    async revokeApiToken(sessionToken, tokenId) {
        return this.runStateMutation(async () => {
            const state = await this.loadState();
            this.requireSession(state, sessionToken, { requireElevation: true });
            const id = String(tokenId || '');
            const before = state.apiTokens.length;
            state.apiTokens = state.apiTokens.filter(token => token.id !== id);
            if (state.apiTokens.length === before) throw new AuthServiceError('API_TOKEN_NOT_FOUND', 'API token was not found', 404);
            await this.saveState(state);
            return { revoked: true };
        });
    }

    async authorizeApiToken(token, requiredScope) {
        const state = await this.loadState();
        const now = this.now();
        const record = state.apiTokens.find(item => item.tokenHash === hashToken(token) && (!item.expiresAt || item.expiresAt > now));
        if (!record || (requiredScope && !record.scopes.includes(requiredScope))) {
            throw new AuthServiceError('UNAUTHORIZED', 'Authentication is required', 401);
        }
        const response = { id: record.id, scopes: [...record.scopes] };
        if (now - Number(record.lastUsedAt || 0) < ACTIVITY_TOUCH_MS) return response;
        return this.runStateMutation(async () => {
            const current = await this.loadState();
            const active = current.apiTokens.find(item => item.tokenHash === hashToken(token) && (!item.expiresAt || item.expiresAt > this.now()));
            if (!active || (requiredScope && !active.scopes.includes(requiredScope))) {
                throw new AuthServiceError('UNAUTHORIZED', 'Authentication is required', 401);
            }
            active.lastUsedAt = this.now();
            await this.saveState(current);
            return { id: active.id, scopes: [...active.scopes] };
        });
    }
}

function createAuthServiceFromEnv(env = process.env) {
    if (String(env.AUTH_V2_ENABLED || '').toLowerCase() !== 'true') return null;
    return new AuthService({
        stateDirectory: env.AUTH_STATE_DIR,
        masterKey: env.AUTH_MASTER_KEY
    });
}

module.exports = {
    AuthService,
    AuthServiceError,
    ELEVATION_MS,
    SESSION_MS,
    TRUSTED_DEVICE_MS,
    MAX_TRUSTED_DEVICES,
    createAuthServiceFromEnv,
    generateTotpCode,
    generateTotpSecret,
    parseMasterKey,
    verifyTotpCode
};
