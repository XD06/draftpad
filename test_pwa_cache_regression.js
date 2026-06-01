const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generatePWAManifest } = require('./scripts/pwa-manifest-generator');

const root = __dirname;
const serviceWorker = fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8');

const requiredCoreAssets = [
    '/managers/note-sync-controller.js',
    '/managers/settings-data-panel.js',
    '/managers/thought-ai-status.js',
    '/managers/thought-api-client.js',
    '/managers/thought-card-renderer.js',
    '/managers/thought-editor.js',
    '/managers/thought-outbox.js',
    '/managers/thought-quick-add.js',
    '/managers/thought-relations-panel.js',
    '/managers/thought-relations-state.js',
    '/managers/thought-renderer.js',
    '/managers/thought-tags.js',
    '/managers/thought-text-formatting.js'
];

const requiredWarmAssets = [
    '/font/LXGWWenKai-Regular.ttf',
    '/font/FiraCode-Regular.ttf',
    '/js/@highlightjs/highlight.min.js'
];

for (const asset of requiredCoreAssets) {
    assert(serviceWorker.includes(asset), `service worker should cache split module ${asset}`);
}

for (const asset of requiredWarmAssets) {
    assert(serviceWorker.includes(asset), `service worker should warm-cache stable heavy asset ${asset}`);
}

assert(serviceWorker.includes('cacheFirst'), 'service worker should use cache-first for static assets');
assert(
    serviceWorker.includes('NETWORK_FIRST_STATIC_EXTENSIONS') &&
    serviceWorker.includes('fetchOptions: { cache: "no-cache" }'),
    'service worker should refresh unversioned JS/CSS/JSON from network before falling back to cache'
);
assert(serviceWorker.includes('requestUrl.pathname.startsWith("/api/")'), 'service worker should bypass API requests');

generatePWAManifest('DumbPad');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'Assets', 'asset-manifest.json'), 'utf8'));
const excludedAssets = [
    '/Assets/1.png',
    '/Assets/2.png',
    '/Assets/12.png',
    '/Assets/22.png',
    '/Assets/test.png',
    '/Assets/2_64x64.ico',
    '/Assets/2_256x256.ico',
    '/Assets/manifest.json',
    '/Assets/asset-manifest.json'
];

for (const asset of excludedAssets) {
    assert(!manifest.includes(asset), `asset manifest should not include local candidate asset ${asset}`);
}

console.log('PWA cache regression checks passed');
