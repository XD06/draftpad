const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generatePWAManifest } = require('../scripts/pwa-manifest-generator');

const root = path.resolve(__dirname, '..');
const serviceWorker = fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const requiredCoreAssets = [
    '/managers/note-sync-controller.js',
    '/managers/settings-data-panel.js',
    '/managers/thought-ai-status.js',
    '/managers/thought-api-client.js',
    '/managers/asset-api-client.js',
    '/managers/article-file-command.js',
    '/managers/thought-attachments.js',
    '/managers/thought-card-renderer.js',
    '/managers/thought-editor.js',
    '/managers/thought-outbox.js',
    '/managers/thought-quick-add.js',
    '/managers/thought-relations-panel.js',
    '/managers/thought-relations-state.js',
    '/managers/thought-swipe.js',
    '/managers/thought-renderer.js',
    '/managers/thought-tags.js',
    '/managers/thought-text-formatting.js',
    '/managers/time-command.js',
    '/tiptap-editor.js',
    '/managers/tiptap-runtime.js',
    '/managers/tiptap-extensions.js'
];

const deferredAssets = [
    '/font/changerwencai.woff2',
    '/font/FiraCode-Regular.ttf',
    '/hybrid-editor.js',
    '/vendor/tiptap/tiptap.bundle.js',
    '/vendor/vditor/index.css',
    '/vendor/vditor/index.min.js',
    '/vendor/vditor-package/dist/js/lute/lute.min.js'
];

for (const asset of requiredCoreAssets) {
    assert(serviceWorker.includes(asset), `service worker should cache split module ${asset}`);
}

for (const asset of deferredAssets) {
    assert(!serviceWorker.includes(asset), `service worker should defer optional asset ${asset} until first use`);
}

assert(serviceWorker.includes('const WARM_ASSETS = [];'), 'service worker should not prefetch optional heavy assets during installation');

assert(serviceWorker.includes('cacheFirst'), 'service worker should use cache-first for static assets');
// Immutable vendor/font runtime (tiptap.bundle.js ~843KB) is cache-first:
// BUILD_VERSION fingerprints public/ into the cache name, so a vendor change
// always creates a new cache — staleness is impossible within a version.
// App code stays network-first (no content hash in URL).
assert(
    serviceWorker.includes("CACHE_FIRST_PATH_PREFIXES") &&
    serviceWorker.includes("'/vendor/'") &&
    serviceWorker.includes("'/font/'") &&
    serviceWorker.includes('isCacheFirstPath(requestUrl.pathname)'),
    'service worker should serve versioned vendor/font runtime cache-first for instant PWA warm starts'
);
assert(
    serviceWorker.includes('NETWORK_FIRST_STATIC_EXTENSIONS') &&
    serviceWorker.includes('fetchOptions: { cache: "no-cache" }'),
    'service worker should refresh unversioned JS/CSS/JSON from network before falling back to cache'
);
assert(
    serviceWorker.includes('navigationPreload') &&
    serviceWorker.includes('preloadResponse: event.preloadResponse'),
    'service worker should use navigation preload to reduce installed PWA cold-start latency'
);
assert(
    serviceWorker.includes('NAVIGATION_NETWORK_TIMEOUT = 600') &&
    serviceWorker.includes('STATIC_NETWORK_TIMEOUT = 450'),
    'service worker should use short cached-fallback windows for warm PWA starts'
);
assert(
    serviceWorker.includes('getCacheState') &&
    serviceWorker.includes('hasAnyAppCache') &&
    serviceWorker.includes('await cleanupOldCaches(appVersion)'),
    'service worker should treat an older app cache as an update and clean it after installing the current cache'
);
assert(serviceWorker.includes('requestUrl.pathname.startsWith("/api/")'), 'service worker should bypass API requests');
assert(
    serverSource.includes('collectBuildFingerprintStats') &&
    serverSource.includes("'package.json', 'package-lock.json'"),
    'build version should include dependency manifests so warmed vendor assets are invalidated after dependency updates'
);

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

const pwaManifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'Assets', 'manifest.json'), 'utf8'));
// Edge Android 对 display_override 取「第一个被支持的模式」，minimal-ui 会让
// 安装出的应用带标题栏退化为浏览器观感——manifest 必须保持纯 standalone。
assert.strictEqual(pwaManifest.display, 'standalone');
assert(!('display_override' in pwaManifest), 'manifest must not set display_override: Edge Android resolves it to minimal-ui and adds a title bar');
assert.strictEqual(pwaManifest.id, '/');
assert.strictEqual(pwaManifest.scope, '/');
assert.strictEqual(pwaManifest.theme_color, '#f2f2f7');
assert.strictEqual(pwaManifest.background_color, '#f2f2f7');
assert(
    pwaManifest.icons.some(icon => icon.purpose === 'any' && icon.sizes === '192x192') &&
    pwaManifest.icons.some(icon => icon.purpose === 'any' && icon.sizes === '512x512') &&
    pwaManifest.icons.some(icon => icon.purpose === 'maskable' && icon.sizes === '512x512'),
    'manifest should carry true-size any 192/512 icons plus a maskable 512 icon'
);
assert(
    pwaManifest.shortcuts.some(shortcut => shortcut.url === '/#today') &&
    pwaManifest.shortcuts.some(shortcut => shortcut.url === '/?action=search'),
    'manifest shortcuts must point at routes the frontend actually handles'
);
for (const staleIcon of ['/Assets/dumbpad.png', '/Assets/dumbpad-192.png', '/Assets/dumbpad-512.png', '/Assets/favicon-512.png']) {
    assert(!serviceWorker.includes(staleIcon), `service worker should not precache the odd-sized legacy icon ${staleIcon}`);
}
assert(serviceWorker.includes('/Assets/dumbpad-icon-192.png'), 'service worker should precache the normalized favicon referenced by index.html');

const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
assert(indexHtml.includes('viewport-fit=cover'), 'index.html must opt into notch safe-area insets via viewport-fit=cover');
assert(
    (indexHtml.match(/<meta name="theme-color"/g) || []).length === 2,
    'index.html should carry light/dark theme-color metas for status bar tinting'
);

console.log('PWA cache regression checks passed');
