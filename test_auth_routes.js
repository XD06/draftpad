const crypto = require('crypto');
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerAuthRoutes } = require('./routes/auth-routes');
const { AuthService, generateTotpCode } = require('./scripts/security/auth-service');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function cookieHeader(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') || ''];
    return raw.filter(Boolean).map(item => item.split(';')[0]).join('; ');
}

(async () => {
    const stateDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-auth-routes-'));
    const publicDirectory = path.join(__dirname, 'public');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const authService = new AuthService({ stateDirectory, masterKey: crypto.randomBytes(32) });
    const auditEvents = [];
    const pin = '123456';
    registerAuthRoutes(app, {
        originValidationMiddleware: (req, res, next) => next(),
        getClientIp: () => '127.0.0.1',
        publicDir: publicDirectory,
        pin,
        cookieName: 'dumbpad_auth',
        cookieMaxAge: 60 * 60 * 1000,
        baseUrl: 'http://127.0.0.1',
        nodeEnv: 'test',
        siteTitle: 'DumbPad',
        buildVersion: 'test',
        highlightLanguages: [],
        assetMaxFileBytes: 80 * 1024 * 1024,
        authService,
        auditLogger: {
            append(event) {
                auditEvents.push(event);
                return Promise.resolve();
            }
        }
    });
    app.get('/api/secure', (req, res) => res.json({ kind: req.auth.kind }));
    app.post('/api/data-management/check', (req, res) => res.json({ allowed: true }));
    const server = http.createServer(app);

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const request = async (route, options = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        });
        const text = await response.text();
        return { response, body: text ? JSON.parse(text) : null };
    };

    try {
        let result = await request('/api/config');
        assert(result.body.assetMaxFileBytes === 80 * 1024 * 1024, 'public runtime config should expose the effective attachment limit');
        result = await request('/api/auth/status');
        assert(result.body.mode === 'setup', 'V2 auth should begin with one-time setup');

        result = await request('/api/auth/setup/start', {
            method: 'POST',
            body: JSON.stringify({ legacyPin: pin, password: 'a strong master password', deviceLabel: 'Route test browser' })
        });
        assert(result.response.ok && result.body.totpSecret, 'legacy PIN should unlock one-time TOTP setup');
        const setup = result.body;

        result = await request('/api/auth/setup/confirm', {
            method: 'POST',
            body: JSON.stringify({ setupId: setup.setupId, totpCode: generateTotpCode(setup.totpSecret) })
        });
        assert(result.response.ok && result.body.recoveryCodes.length === 10, 'setup confirmation should return recovery codes once');
        const browserCookies = cookieHeader(result.response);
        assert(browserCookies.includes('dumbpad_auth_session='), 'setup should create an opaque session cookie');

        result = await request('/api/secure', { headers: { Cookie: browserCookies } });
        assert(result.response.ok && result.body.kind === 'session', 'session cookie should access normal API routes');

        result = await request('/api/data-management/check', { method: 'POST', headers: { Cookie: browserCookies }, body: '{}' });
        assert(result.response.status === 403, 'data-management writes should require a recent TOTP elevation');

        result = await request('/api/auth/elevate', {
            method: 'POST',
            headers: { Cookie: browserCookies },
            body: JSON.stringify({ totpCode: generateTotpCode(setup.totpSecret) })
        });
        assert(result.response.ok, 'valid TOTP should elevate the browser session');

        result = await request('/api/data-management/check', { method: 'POST', headers: { Cookie: browserCookies }, body: '{}' });
        assert(result.response.ok, 'elevated browser sessions should access data-management writes');

        result = await request('/api/auth/api-tokens', {
            method: 'POST',
            headers: { Cookie: browserCookies },
            body: JSON.stringify({ name: 'Route token', scopes: ['content:read'] })
        });
        assert(result.response.status === 201 && result.body.token, 'elevated sessions should create scoped API tokens');
        const apiToken = result.body.token;
        assert(
            auditEvents.some(event => event.type === 'auth.api-token.create' && event.details?.tokenId),
            'creating an API token should write a safe audit event without the token value'
        );

        result = await request('/api/secure', { headers: { Authorization: `Bearer ${apiToken}` } });
        assert(result.response.ok && result.body.kind === 'api-token', 'scoped token should access read API routes');

        result = await request('/api/data-management/check', { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` }, body: '{}' });
        assert(result.response.status === 403, 'API tokens must not access data-management writes');
        result = await request('/api/data-management/status', { headers: { Authorization: `Bearer ${apiToken}` } });
        assert(result.response.status === 403, 'API tokens must not access data-management reads');

        console.log('Authentication route checks passed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.promises.rm(stateDirectory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
