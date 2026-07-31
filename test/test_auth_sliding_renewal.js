'use strict';
// Regression coverage for the legacy PIN sliding-renewal behaviour. An active
// browser session must never expire mid-use: every cookie-authenticated /api
// request re-issues the auth cookie with a fresh lifetime, while stateless
// bearer/API-token clients are intentionally left untouched.
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const path = require('path');
const { registerAuthRoutes } = require('../routes/auth-routes');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function setCookieList(response) {
    if (typeof response.headers.getSetCookie === 'function') {
        return response.headers.getSetCookie();
    }
    const raw = response.headers.get('set-cookie');
    return raw ? [raw] : [];
}

(async () => {
    const publicDirectory = path.join(__dirname, '..', 'public');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());

    const pin = '123456';
    const cookieName = 'dumbpad_auth';
    const cookieMaxAge = 720 * 60 * 60 * 1000; // 30 days in ms -> Max-Age=2592000

    // No authService => legacy PIN mode (v2Enabled === false).
    registerAuthRoutes(app, {
        originValidationMiddleware: (req, res, next) => next(),
        getClientIp: () => '127.0.0.1',
        publicDir: publicDirectory,
        pin,
        cookieName,
        cookieMaxAge,
        baseUrl: 'http://127.0.0.1',
        nodeEnv: 'test',
        siteTitle: 'DumbPad',
        buildVersion: 'test',
        highlightLanguages: [],
        assetMaxFileBytes: 20 * 1024 * 1024
    });
    app.get('/api/secure', (req, res) => res.json({ kind: req.auth.kind }));

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const request = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });

    try {
        // 1. No credentials -> rejected.
        let response = await request('/api/secure');
        assert(response.status === 401, 'legacy API without a PIN cookie or bearer must be rejected');

        // 2. verify-pin issues the auth cookie.
        response = await request('/api/verify-pin', { method: 'POST', body: JSON.stringify({ pin }) });
        assert(response.ok, 'correct PIN should be accepted by verify-pin');
        const loginCookies = setCookieList(response);
        assert(loginCookies.some(c => c.startsWith(`${cookieName}=`)), 'verify-pin should set the auth cookie');
        const authCookie = `${cookieName}=${pin}`;

        // 3. Cookie-authenticated activity -> allowed AND the cookie is sliding-renewed.
        response = await request('/api/secure', { headers: { Cookie: authCookie } });
        assert(response.ok && (await response.json()).kind === 'legacy', 'valid PIN cookie should pass the legacy /api guard');
        const renewed = setCookieList(response);
        const renewedCookie = renewed.find(c => c.startsWith(`${cookieName}=`));
        assert(renewedCookie, 'cookie-authenticated activity should sliding-renew the auth cookie');
        assert(/Max-Age=2592000\b/.test(renewedCookie), 'renewed cookie should carry the configured 30-day lifetime');

        // 4. Bearer-authenticated activity -> allowed but stateless (no cookie re-issued).
        response = await request('/api/secure', { headers: { Authorization: `Bearer ${pin}` } });
        assert(response.ok, 'valid PIN bearer token should pass the legacy /api guard');
        const bearerCookies = setCookieList(response);
        assert(!bearerCookies.some(c => c.startsWith(`${cookieName}=`)), 'bearer/API clients must not receive a sliding-renewal cookie');

        // 5. Wrong cookie -> rejected (and must not be renewed).
        response = await request('/api/secure', { headers: { Cookie: `${cookieName}=000000` } });
        assert(response.status === 401, 'an incorrect PIN cookie must be rejected');
        assert(!setCookieList(response).some(c => c.startsWith(`${cookieName}=`)), 'a rejected request must not issue an auth cookie');

        console.log('Legacy sliding-renewal auth checks passed');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
