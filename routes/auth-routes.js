const crypto = require('crypto');
const path = require('path');
const {
    SESSION_MS,
    TRUSTED_DEVICE_MS,
    generateTotpSecret
} = require('../scripts/security/auth-service');

function registerAuthRoutes(app, context) {
    const {
        originValidationMiddleware,
        getClientIp,
        publicDir,
        pin: PIN,
        cookieName: COOKIE_NAME,
        cookieMaxAge,
        baseUrl: BASE_URL,
        nodeEnv: NODE_ENV,
        siteTitle: SITE_TITLE,
        buildVersion: BUILD_VERSION,
        highlightLanguages: HIGHLIGHT_LANGUAGES,
        authService = null,
        auditLogger = null
    } = context;
    const v2Enabled = Boolean(authService);
    const sessionCookieName = `${COOKIE_NAME}_session`;
    const deviceCookieName = `${COOKIE_NAME}_device`;
    const loginAttempts = new Map();
    const pendingSetups = new Map();
    const pendingRecoveries = new Map();
    const maxAttempts = Number(process.env.MAX_ATTEMPTS || 5);
    const lockoutMs = Number(process.env.LOCKOUT_TIME || 15) * 60 * 1000;
    const bootstrapToken = String(process.env.AUTH_BOOTSTRAP_TOKEN || '');

    function isValidPin(pin) {
        return typeof pin === 'string' && /^\d{4,10}$/.test(pin);
    }

    function secureCompare(left, right) {
        if (typeof left !== 'string' || typeof right !== 'string') return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
        } catch {
            return false;
        }
    }

    function isLockedOut(ip) {
        const attempts = loginAttempts.get(ip);
        if (!attempts) return false;
        if (attempts.count < maxAttempts) return false;
        if (Date.now() - attempts.lastAttempt < lockoutMs) return true;
        loginAttempts.delete(ip);
        return false;
    }

    function recordAttempt(ip) {
        const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
        attempts.count += 1;
        attempts.lastAttempt = Date.now();
        loginAttempts.set(ip, attempts);
    }

    function resetAttempts(ip) {
        loginAttempts.delete(ip);
    }

    function validRedirect(value) {
        if (!value || typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
        return !value.includes('\\') && !/%2f|%5c/i.test(value);
    }

    function redirectTarget(req) {
        const requested = req.query?.redirect ? decodeURIComponent(req.query.redirect) : '/';
        return validRedirect(requested) ? requested : '/';
    }

    function cookieOptions(maxAge) {
        return {
            httpOnly: true,
            secure: Boolean(NODE_ENV === 'production' && String(BASE_URL || '').startsWith('https')),
            sameSite: 'strict',
            maxAge
        };
    }

    function sendAuthError(res, error) {
        const status = error?.status || 500;
        if (status >= 500) console.error('Authentication error:', error);
        res.status(status).json({ error: error?.message || 'Authentication failed', code: error?.code || 'AUTH_ERROR' });
    }

    function audit(type, req, outcome = 'success', details = {}) {
        if (!auditLogger) return;
        auditLogger.append({ type, actor: req.auth?.session?.sessionId || null, ip: getClientIp(req), outcome, details }).catch(error => {
            console.warn('Audit logging failed:', error.message);
        });
    }

    async function browserSession(req, { requireElevation = false } = {}) {
        if (!v2Enabled) return null;
        const token = req.cookies?.[sessionCookieName];
        const session = await authService.authorizeSession(token, { requireElevation });
        return { ...session, token };
    }

    async function authorizeRequest(req) {
        if (!v2Enabled) return { kind: 'legacy' };
        const authorization = String(req.headers.authorization || '');
        if (authorization.startsWith('Bearer ')) {
            const token = authorization.slice(7);
            const apiToken = await authService.authorizeApiToken(token);
            const needsWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
            const accepted = needsWrite
                ? apiToken.scopes.some(scope => scope === 'content:write' || scope === 'thoughts:write')
                : apiToken.scopes.some(scope => scope === 'content:read' || scope === 'thoughts:read');
            if (!accepted) {
                const error = new Error('API token does not include the required content scope');
                error.code = 'INSUFFICIENT_API_TOKEN_SCOPE';
                error.status = 403;
                throw error;
            }
            return { kind: 'api-token', apiToken };
        }
        return { kind: 'session', session: await browserSession(req) };
    }

    function setV2Cookies(res, result) {
        res.cookie(sessionCookieName, result.sessionToken, cookieOptions(SESSION_MS));
        if (result.deviceToken) res.cookie(deviceCookieName, result.deviceToken, cookieOptions(TRUSTED_DEVICE_MS));
    }

    function clearV2Cookies(res) {
        res.clearCookie(sessionCookieName, cookieOptions(0));
        res.clearCookie(deviceCookieName, cookieOptions(0));
    }

    function validateRateLimit(req, res) {
        const ip = getClientIp(req);
        if (!ip) {
            res.status(500).json({ error: 'Unable to determine client IP address' });
            return null;
        }
        if (isLockedOut(ip)) {
            res.status(429).json({ error: 'Too many attempts. Please try again later.' });
            return null;
        }
        return ip;
    }

    setInterval(() => {
        const now = Date.now();
        for (const [ip, attempts] of loginAttempts.entries()) {
            if (now - attempts.lastAttempt >= lockoutMs) loginAttempts.delete(ip);
        }
        for (const [id, setup] of pendingSetups.entries()) {
            if (setup.expiresAt <= now) pendingSetups.delete(id);
        }
        for (const [id, recovery] of pendingRecoveries.entries()) {
            if (recovery.expiresAt <= now) pendingRecoveries.delete(id);
        }
    }, 60000).unref();

    app.get('/', originValidationMiddleware, async (req, res) => {
        if (v2Enabled) {
            try {
                await browserSession(req);
                return res.sendFile(path.join(publicDir, 'index.html'));
            } catch {
                return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
            }
        }
        if (!PIN || !isValidPin(PIN)) return res.sendFile(path.join(publicDir, 'index.html'));
        if (!secureCompare(req.cookies?.[COOKIE_NAME], PIN)) {
            return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
        }
        return res.sendFile(path.join(publicDir, 'index.html'));
    });

    app.get('/login', async (req, res) => {
        if (v2Enabled) {
            try {
                await browserSession(req);
                return res.redirect(redirectTarget(req));
            } catch {}
            return res.sendFile(path.join(publicDir, 'login.html'));
        }
        if (!PIN || !isValidPin(PIN) || secureCompare(req.cookies?.[COOKIE_NAME], PIN)) {
            return res.redirect(redirectTarget(req));
        }
        return res.sendFile(path.join(publicDir, 'login.html'));
    });

    app.post('/api/verify-pin', (req, res) => {
        if (v2Enabled) return res.status(410).json({ error: 'PIN login has been replaced by the configured authentication flow' });
        const ip = validateRateLimit(req, res);
        if (!ip) return;
        const pin = req.body?.pin;
        if (!PIN) return res.json({ success: true });
        if (!isValidPin(pin) || !secureCompare(pin, PIN)) {
            recordAttempt(ip);
            return res.status(401).json({ success: false, error: 'Invalid PIN', attemptsLeft: Math.max(0, maxAttempts - (loginAttempts.get(ip)?.count || 0)) });
        }
        resetAttempts(ip);
        res.cookie(COOKIE_NAME, pin, cookieOptions(cookieMaxAge));
        return res.json({ success: true });
    });

    app.get('/api/pin-required', (req, res) => {
        if (v2Enabled) return res.json({ required: false, mode: 'v2', locked: false });
        const ip = getClientIp(req);
        return res.json({ required: Boolean(PIN && isValidPin(PIN)), length: PIN ? PIN.length : 0, locked: ip ? isLockedOut(ip) : true });
    });

    app.get('/api/auth/status', async (req, res) => {
        if (!v2Enabled) return res.json({ mode: 'legacy', initialized: false, siteTitle: SITE_TITLE });
        const status = await authService.status();
        return res.json({ mode: status.initialized ? 'login' : 'setup', initialized: status.initialized, siteTitle: SITE_TITLE });
    });

    app.post('/api/auth/setup/start', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        const ip = validateRateLimit(req, res);
        if (!ip) return;
        try {
            const status = await authService.status();
            if (status.initialized) return res.status(409).json({ error: 'Authentication is already initialized' });
            const validLegacyPin = PIN && secureCompare(String(req.body?.legacyPin || ''), PIN);
            const validBootstrap = bootstrapToken && secureCompare(String(req.body?.bootstrapToken || ''), bootstrapToken);
            if (!validLegacyPin && !validBootstrap) {
                recordAttempt(ip);
                return res.status(401).json({ error: 'Legacy PIN or bootstrap token is required' });
            }
            const secret = generateTotpSecret();
            const id = crypto.randomUUID();
            pendingSetups.set(id, {
                password: req.body?.password,
                totpSecret: secret,
                deviceLabel: req.body?.deviceLabel,
                expiresAt: Date.now() + 10 * 60 * 1000
            });
            resetAttempts(ip);
            return res.json({
                setupId: id,
                totpSecret: secret,
                otpAuthUri: `otpauth://totp/${encodeURIComponent(SITE_TITLE)}:administrator?secret=${secret}&issuer=${encodeURIComponent(SITE_TITLE)}&algorithm=SHA1&digits=6&period=30`
            });
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.post('/api/auth/setup/confirm', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        const setup = pendingSetups.get(String(req.body?.setupId || ''));
        if (!setup || setup.expiresAt <= Date.now()) return res.status(400).json({ error: 'Authentication setup has expired' });
        try {
            const initialized = await authService.initialize({ password: setup.password, totpSecret: setup.totpSecret, totpCode: req.body?.totpCode });
            const login = await authService.authenticate({
                password: setup.password,
                totpCode: req.body?.totpCode,
                deviceLabel: setup.deviceLabel
            });
            pendingSetups.delete(String(req.body?.setupId || ''));
            setV2Cookies(res, login);
            audit('auth.setup', req);
            return res.json({
                success: true,
                recoveryCodes: initialized.recoveryCodes,
                expiresAt: login.expiresAt,
                deviceTrustLimited: login.deviceTrustLimited
            });
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.post('/api/auth/login', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        const ip = validateRateLimit(req, res);
        if (!ip) return;
        try {
            const login = await authService.authenticate({
                password: req.body?.password,
                totpCode: req.body?.totpCode,
                trustedDeviceToken: req.cookies?.[deviceCookieName],
                trustDevice: req.body?.trustDevice !== false,
                deviceLabel: req.body?.deviceLabel
            });
            resetAttempts(ip);
            setV2Cookies(res, login);
            audit('auth.login', req);
            return res.json({
                success: true,
                expiresAt: login.expiresAt,
                deviceExpiresAt: login.deviceExpiresAt,
                deviceTrustLimited: login.deviceTrustLimited
            });
        } catch (error) {
            recordAttempt(ip);
            return sendAuthError(res, error);
        }
    });

    app.post('/api/auth/recovery/start', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        const ip = validateRateLimit(req, res);
        if (!ip) return;
        try {
            await authService.validateRecovery({ password: req.body?.password, recoveryCode: req.body?.recoveryCode });
            const id = crypto.randomUUID();
            const secret = generateTotpSecret();
            pendingRecoveries.set(id, {
                password: req.body?.password,
                recoveryCode: req.body?.recoveryCode,
                totpSecret: secret,
                deviceLabel: req.body?.deviceLabel,
                expiresAt: Date.now() + 10 * 60 * 1000
            });
            resetAttempts(ip);
            return res.json({
                recoveryId: id,
                totpSecret: secret,
                otpAuthUri: `otpauth://totp/${encodeURIComponent(SITE_TITLE)}:administrator?secret=${secret}&issuer=${encodeURIComponent(SITE_TITLE)}&algorithm=SHA1&digits=6&period=30`
            });
        } catch (error) {
            recordAttempt(ip);
            return sendAuthError(res, error);
        }
    });

    app.post('/api/auth/recovery/confirm', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        const recovery = pendingRecoveries.get(String(req.body?.recoveryId || ''));
        if (!recovery || recovery.expiresAt <= Date.now()) return res.status(400).json({ error: 'Recovery setup has expired' });
        try {
            const login = await authService.recover({
                password: recovery.password,
                recoveryCode: recovery.recoveryCode,
                totpSecret: recovery.totpSecret,
                totpCode: req.body?.totpCode,
                deviceLabel: recovery.deviceLabel
            });
            pendingRecoveries.delete(String(req.body?.recoveryId || ''));
            setV2Cookies(res, login);
            audit('auth.recovery', req);
            return res.json({ success: true, expiresAt: login.expiresAt, deviceTrustLimited: login.deviceTrustLimited });
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.post('/api/auth/elevate', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        try {
            const result = await authService.elevate(req.cookies?.[sessionCookieName], req.body?.totpCode);
            audit('auth.elevate', req);
            return res.json({ success: true, ...result });
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.post('/api/auth/logout', (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        authService.revokeSession(req.cookies?.[sessionCookieName]).catch(error => console.warn('Authentication logout cleanup failed:', error.message));
        audit('auth.logout', req);
        clearV2Cookies(res);
        return res.json({ success: true });
    });

    app.post('/api/auth/api-tokens', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        try {
            const result = await authService.createApiToken(req.cookies?.[sessionCookieName], req.body || {});
            audit('auth.api-token.create', req, 'success', { tokenId: result.id });
            return res.status(201).json(result);
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.get('/api/auth/api-tokens', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        try {
            return res.json({ tokens: await authService.listApiTokens(req.cookies?.[sessionCookieName]) });
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.delete('/api/auth/api-tokens/:tokenId', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        try {
            const result = await authService.revokeApiToken(req.cookies?.[sessionCookieName], req.params.tokenId);
            audit('auth.api-token.revoke', req, 'success', { tokenId: req.params.tokenId });
            return res.json(result);
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.get('/api/auth/devices', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        try {
            return res.json({ devices: await authService.listDevices(req.cookies?.[sessionCookieName]) });
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.delete('/api/auth/devices/:deviceId', async (req, res) => {
        if (!v2Enabled) return res.status(404).json({ error: 'Authentication V2 is disabled' });
        try {
            const result = await authService.revokeDevice(req.cookies?.[sessionCookieName], req.params.deviceId);
            audit('auth.device.revoke', req, 'success', { deviceId: req.params.deviceId });
            return res.json(result);
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.get('/api/config', (req, res) => {
        res.json({
            siteTitle: SITE_TITLE,
            baseUrl: process.env.BASE_URL,
            version: BUILD_VERSION,
            highlightLanguages: HIGHLIGHT_LANGUAGES,
            authMode: v2Enabled ? 'v2' : 'legacy'
        });
    });

    app.use('/api', async (req, res, next) => {
        if (req.path === '/verify-pin' || req.path === '/pin-required' || req.path === '/config' || req.path.startsWith('/auth/')) return next();
        try {
            if (!v2Enabled) {
                if (PIN && isValidPin(PIN)) {
                    const authorization = String(req.headers.authorization || '');
                    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
                    if (!secureCompare(bearer, PIN) && !secureCompare(req.cookies?.[COOKIE_NAME], PIN)) {
                        return res.status(401).json({ error: 'Unauthorized' });
                    }
                }
                req.auth = { kind: 'legacy' };
            } else {
                req.auth = await authorizeRequest(req);
            }
            return next();
        } catch (error) {
            return sendAuthError(res, error);
        }
    });

    app.use('/api/data-management', async (req, res, next) => {
        if (!v2Enabled) return next();
        if (req.auth?.kind !== 'session') return res.status(403).json({ error: 'A browser session with recent verification is required' });
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        try {
            await browserSession(req, { requireElevation: true });
            return next();
        } catch (error) {
            return sendAuthError(res, error);
        }
    });
}

module.exports = { registerAuthRoutes };
