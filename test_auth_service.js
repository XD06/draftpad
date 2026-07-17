const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    AuthService,
    ELEVATION_MS,
    generateTotpCode,
    generateTotpSecret
} = require('./scripts/security/auth-service');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function expectError(callback, code, message) {
    let thrown = null;
    try {
        await callback();
    } catch (error) {
        thrown = error;
    }
    assert(thrown, message);
    assert(thrown.code === code, `${message}: expected ${code}, received ${thrown.code}`);
}

(async () => {
    const stateDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-auth-service-'));
    let now = Date.UTC(2026, 6, 17, 3, 0, 0);
    const options = {
        stateDirectory,
        masterKey: crypto.randomBytes(32),
        now: () => now
    };
    const service = new AuthService(options);
    const secret = generateTotpSecret();

    try {
        assert(!(await service.status()).initialized, 'auth service should begin uninitialized');
        await expectError(
            () => service.initialize({ password: 'a strong password', totpSecret: secret, totpCode: '000000' }),
            'INVALID_TOTP_CODE',
            'setup should require a valid TOTP code'
        );
        const initialized = await service.initialize({
            password: 'a strong password',
            totpSecret: secret,
            totpCode: generateTotpCode(secret, now)
        });
        assert(initialized.recoveryCodes.length === 10, 'setup should return ten one-time recovery codes');
        assert((await service.status()).initialized, 'auth service should persist setup state');

        await expectError(
            () => service.authenticate({ password: 'a strong password' }),
            'TOTP_REQUIRED',
            'an unknown device should require TOTP after password verification'
        );
        const firstLogin = await service.authenticate({
            password: 'a strong password',
            totpCode: generateTotpCode(secret, now),
            deviceLabel: 'Test browser'
        });
        assert(firstLogin.sessionToken && firstLogin.deviceToken, 'first login should create a session and trusted-device token');
        await service.authorizeSession(firstLogin.sessionToken);

        now += 1000;
        const trustedLogin = await service.authenticate({
            password: 'a strong password',
            trustedDeviceToken: firstLogin.deviceToken
        });
        assert(trustedLogin.sessionToken, 'a trusted device should skip routine TOTP after password verification');
        await expectError(
            () => service.authorizeSession(trustedLogin.sessionToken, { requireElevation: true }),
            'ELEVATION_REQUIRED',
            'high-risk operations should require a fresh TOTP elevation'
        );
        const elevation = await service.elevate(trustedLogin.sessionToken, generateTotpCode(secret, now));
        assert(elevation.elevatedUntil === now + ELEVATION_MS, 'elevation should last for the configured short window');
        await service.authorizeSession(trustedLogin.sessionToken, { requireElevation: true });

        const apiToken = await service.createApiToken(trustedLogin.sessionToken, {
            name: 'automation',
            scopes: ['content:read', 'content:write']
        });
        assert(apiToken.token && apiToken.scopes.length === 2, 'elevated sessions should mint scoped API tokens');
        assert((await service.listApiTokens(trustedLogin.sessionToken)).length === 1, 'elevated sessions should list API token metadata without secrets');
        await service.authorizeApiToken(apiToken.token, 'content:write');
        await expectError(
            () => service.authorizeApiToken(apiToken.token, 'storage:admin'),
            'UNAUTHORIZED',
            'API tokens must not gain data-admin permissions'
        );
        await service.revokeApiToken(trustedLogin.sessionToken, apiToken.id);
        await expectError(
            () => service.authorizeApiToken(apiToken.token, 'content:read'),
            'UNAUTHORIZED',
            'revoked API tokens should stop authorizing immediately'
        );
        assert((await service.listDevices(trustedLogin.sessionToken)).length >= 1, 'elevated sessions should list trusted devices without token hashes');

        // Concurrent trusted-device logins must append sessions instead of
        // racing through the file-backed auth state and losing one another.
        const concurrentLogins = await Promise.all(Array.from({ length: 3 }, () => service.authenticate({
            password: 'a strong password',
            trustedDeviceToken: firstLogin.deviceToken
        })));
        await Promise.all(concurrentLogins.map(login => service.authorizeSession(login.sessionToken)));
        const persistedState = await service.loadState();
        assert(
            new Set(persistedState.sessions.map(session => session.id)).size === persistedState.sessions.length,
            'concurrent logins should leave a readable, non-duplicated authentication state'
        );
        assert(persistedState.sessions.length >= 5, 'concurrent logins should retain every issued session');

        const newDeviceLogins = [];
        for (let index = 0; index < 5; index++) {
            newDeviceLogins.push(await service.authenticate({
                password: 'a strong password',
                totpCode: generateTotpCode(secret, now),
                trustedDeviceToken: `unknown-device-${index}`,
                deviceLabel: `New device ${index}`
            }));
        }
        const trustedDevices = await service.loadState();
        assert(trustedDevices.devices.length === 5, 'trusted device records should never exceed the configured maximum');
        assert(
            newDeviceLogins.some(login => login.deviceTrustLimited && !login.deviceToken),
            'a sixth device should still log in with TOTP without displacing an existing trusted device'
        );

        const replacementSecret = generateTotpSecret();
        const recovered = await service.recover({
            password: 'a strong password',
            recoveryCode: initialized.recoveryCodes[0],
            totpSecret: replacementSecret,
            totpCode: generateTotpCode(replacementSecret, now),
            deviceLabel: 'Recovered browser'
        });
        assert(recovered.sessionToken, 'a valid recovery code should reset TOTP and create a new session');
        await expectError(
            () => service.authenticate({ password: 'a strong password', totpCode: generateTotpCode(secret, now) }),
            'TOTP_REQUIRED',
            'the previous authenticator secret should stop working after recovery'
        );

        const reloaded = new AuthService(options);
        await reloaded.authorizeSession(firstLogin.sessionToken);
        console.log('Authentication service checks passed');
    } finally {
        await fs.promises.rm(stateDirectory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
