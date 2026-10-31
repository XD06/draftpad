// Regression for getClientIp (utils/ipExtractor.js):
//   - X-Forwarded-For must never become the rate-limit key unless the socket
//     peer is an explicitly trusted proxy
//   - TRUST_PROXY=true without TRUSTED_PROXY_IPS fails closed to socket IP
//   - with a trusted list, the chain is walked right-to-left so a client
//     cannot forge its apparent address by prepending entries
// config/ caches env at require time, so each case reloads both modules.

const assert = require('assert');

function reloadWith(env) {
    for (const key of ['TRUST_PROXY', 'TRUSTED_PROXY_IPS']) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
    }
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../utils/ipExtractor')];
    return require('../utils/ipExtractor');
}

function fakeReq({ socketIp, xff }) {
    return {
        socket: { remoteAddress: socketIp },
        headers: xff === undefined ? {} : { 'x-forwarded-for': xff }
    };
}

function main() {
    const socketIp = '203.0.113.5';

    // 1. Proxy trust disabled: XFF is ignored even when present.
    let { getClientIp } = reloadWith({ TRUST_PROXY: 'false' });
    assert.strictEqual(getClientIp(fakeReq({ socketIp, xff: '1.2.3.4' })), socketIp, 'TRUST_PROXY=false must ignore XFF');

    // 2. TRUST_PROXY=true without a trusted list: fail closed to socket IP.
    ({ getClientIp } = reloadWith({ TRUST_PROXY: 'true' }));
    assert.strictEqual(getClientIp(fakeReq({ socketIp, xff: '1.2.3.4' })), socketIp, 'no trusted list must ignore client-forged XFF');

    // 3. Trusted proxy + forged leftmost entry: rightmost untrusted wins, so
    // the proxy-appended real client IP is used, not the prepended fake.
    ({ getClientIp } = reloadWith({ TRUST_PROXY: 'true', TRUSTED_PROXY_IPS: '10.0.0.0/8' }));
    const trustedSocket = fakeReq({ socketIp: '10.1.1.1', xff: '6.6.6.6, 198.51.100.7, 10.2.2.2' });
    assert.strictEqual(getClientIp(trustedSocket), '198.51.100.7', 'rightmost non-trusted chain entry must win over the forged leftmost');

    // 4. Chain of multiple trusted hops: keep walking right-to-left.
    const chained = fakeReq({ socketIp: '10.1.1.1', xff: '198.51.100.9, 10.2.2.2, 10.3.3.3' });
    assert.strictEqual(getClientIp(chained), '198.51.100.9', 'multi-hop trusted chains must resolve to the first untrusted hop');

    // 5. Untrusted socket peer: XFF ignored even with a configured list.
    const untrusted = fakeReq({ socketIp, xff: '1.2.3.4' });
    assert.strictEqual(getClientIp(untrusted), socketIp, 'untrusted socket peer must not enable XFF');

    // 6. Trusted proxy without XFF header: fall back to socket IP.
    const noXff = fakeReq({ socketIp: '10.1.1.1' });
    assert.strictEqual(getClientIp(noXff), '10.1.1.1', 'missing XFF must fall back to socket IP');

    // 7. Fully trusted chain (every entry is a trusted proxy): leftmost claim
    // as last resort rather than null.
    const allTrusted = fakeReq({ socketIp: '10.1.1.1', xff: '10.2.2.2, 10.3.3.3' });
    assert.strictEqual(getClientIp(allTrusted), '10.2.2.2', 'fully trusted chain falls back to leftmost entry');

    console.log('IP extractor checks passed');
}

main();
