const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Locks the share-token secret hardening. Share tokens are HMAC(secret, id).
// A world-known hardcoded secret would let anyone who has read the source forge
// valid tokens for any notepad id on a deployment that configured neither
// SHARE_SECRET nor DUMBPAD_PIN. These checks keep that constant from returning.
(() => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    assert(
        !source.includes('dumbpad_default_secret_9988'),
        'the previously hardcoded share secret constant must not return'
    );

    const secretLine = source.split('\n').find(line => line.includes('const SHARE_SECRET =')) || '';
    assert(
        /process\.env\.SHARE_SECRET\s*\|\|\s*PIN\s*\|\|\s*crypto\.randomBytes\(/.test(secretLine),
        'SHARE_SECRET must fall back to a random per-boot secret, not a fixed string'
    );

    assert(
        /crypto\.createHmac\('sha256',\s*SHARE_SECRET\)/.test(source),
        'share tokens must stay bound to SHARE_SECRET via HMAC-SHA256'
    );

    console.log('Share secret hardening checks passed');
})();
