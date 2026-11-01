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
const buildVersionSource = fs.readFileSync(path.join(root, 'scripts', 'build-version.js'), 'utf8');
assert(
    buildVersionSource.includes('collectBuildFingerprintStats') &&
    buildVersionSource.includes("'package.json', 'package-lock.json'"),
    'build version should include dependency manifests so warmed vendor assets are invalidated after dependency updates'
);

// 启动时会重写两个 manifest 产物（writeFileSync 刷新 mtime）。它们必须留在
// 指纹之外，否则每次服务重启都换缓存名：所有客户端判定"有新版本"、重下整套
// 预缓存（约 80 项）、弹一条假的「新版本可用」，cache-first 的 vendor/字体
// 缓存也一并失效。
const { getBuildVersion } = require('../scripts/build-version');
const buildVersionBeforeRegenerate = getBuildVersion(path.join(root, 'public'), 'fingerprint-test');
generatePWAManifest('DumbPad');
const buildVersionAfterRegenerate = getBuildVersion(path.join(root, 'public'), 'fingerprint-test');
assert.strictEqual(
    buildVersionAfterRegenerate,
    buildVersionBeforeRegenerate,
    'regenerating the PWA manifests must not change BUILD_VERSION, or every server restart busts the whole precache'
);

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

// 预缓存必须逐项 add：cache.addAll 是全有或全无，任一 404 会让整个 activate
// 抛出，而 install 里的 skipWaiting 已生效、旧 SW 已让位 —— 离线会整段失效。
assert(
    serviceWorker.includes('const coreResults = await Promise.allSettled(') &&
    serviceWorker.includes('await cache.add(asset)'),
    'service worker must cache core assets one by one so a single 404 cannot abort the whole install'
);

// 清单里的每个路径都必须真的能取到（public/ 下，或由 server.js 从 node_modules /
// font/ 挂载的等价路径）。改名、删文件、写错前缀都该在这里失败，而不是等到
// 真机离线时才发现。
const NODE_MODULES_ASSET_ROOTS = [
    ['/js/marked/', 'node_modules/marked/lib'],
    ['/css/@highlightjs/', 'node_modules/@highlightjs/cdn-assets/styles'],
    ['/font/', 'font'],
];
function resolveCoreAsset(asset) {
    const local = path.join(root, 'public', asset);
    if (fs.existsSync(local)) return local;
    for (const [prefix, dir] of NODE_MODULES_ASSET_ROOTS) {
        if (!asset.startsWith(prefix)) continue;
        const candidate = path.join(root, dir, asset.slice(prefix.length));
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}
const coreAssetsBlock = serviceWorker.match(/const CORE_ASSETS = \[([\s\S]*?)\];/);
assert(coreAssetsBlock, 'service worker must declare CORE_ASSETS');
const coreAssets = [...coreAssetsBlock[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
assert(coreAssets.length > 50, `CORE_ASSETS 条目数量异常：${coreAssets.length}`);
const missingCoreAssets = coreAssets.filter(asset => !resolveCoreAsset(asset));
assert.deepStrictEqual(
    missingCoreAssets,
    [],
    `CORE_ASSETS 里有取不到的路径（改名/删除后离线会 404）：${missingCoreAssets.join(', ')}`
);

const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
assert(indexHtml.includes('viewport-fit=cover'), 'index.html must opt into notch safe-area insets via viewport-fit=cover');
const themeColorMetas = [...indexHtml.matchAll(/<meta[^>]*name="theme-color"[^>]*>/g)].map(match => match[0]);
assert(themeColorMetas.length >= 2, 'index.html should carry light/dark theme-color metas for status bar tinting');
assert(
    themeColorMetas.some(tag => tag.includes('prefers-color-scheme: light')) &&
    themeColorMetas.some(tag => tag.includes('prefers-color-scheme: dark')),
    'theme-color metas must cover both light and dark color schemes'
);
// 首帧背景：styles.css 到达前画布是 UA 默认白底，必须由内联样式兜住，
// 且亮色值要和 manifest 的 background_color 同源（启动屏 → 首帧不跳色）。
assert(
    indexHtml.includes(`html { background: ${pwaManifest.background_color}; }`) &&
    indexHtml.includes('html[data-theme="dark"] { background: #1c1c1e; }'),
    'index.html must paint the first frame background from the inline theme style block'
);

// viewport-fit=cover 只是「允许内容铺到状态栏下面」；固定定位的 header 不参与
// 文档流，必须自己把 safe-area-inset-top 吃进 top，否则会被系统状态栏或
// body::before 的假状态栏带盖住（inset=0 时行为不变，所以普通机型看不出来）。
const iosThemeCss = fs.readFileSync(path.join(root, 'public', 'Assets', 'ios-theme.css'), 'utf8');
assert(
    iosThemeCss.includes('top: calc(12px + env(safe-area-inset-top, 0px));') &&
    iosThemeCss.includes('top: calc(8px + env(safe-area-inset-top, 0px));') &&
    iosThemeCss.includes('padding-top: calc(76px + env(safe-area-inset-top, 0px)) !important;') &&
    iosThemeCss.includes('padding-top: calc(60px + env(safe-area-inset-top, 0px)) !important;'),
    '固定 header 与 .container 必须把 safe-area-inset-top 吃进布局，否则 viewport-fit=cover 下会被状态栏盖住'
);
assert(
    indexHtml.includes('name="apple-mobile-web-app-capable"') &&
    indexHtml.includes('name="apple-mobile-web-app-status-bar-style" content="default"'),
    'iOS 需要 apple-mobile-web-app-capable 才进 standalone；浅色 UI 下状态栏样式必须用 default（black-translucent 是白字）'
);

// 快捷方式入口清参只能摘 action：用 pathname+hash 重建 URL 会把 ?id= 一起
// 抹掉（深链 /?id=xxx&action=search 会丢文章），且面板不可用时不该动 URL。
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
assert(
    appSource.includes("url.searchParams.delete('action')"),
    '?action=search 清参必须只摘 action 参数，不能用 pathname + hash 重建 URL'
);
assert(
    !appSource.includes("history.replaceState(null, '', window.location.pathname + (window.location.hash || ''))"),
    '?action=search 清参不得再用 pathname + hash 重建 URL（会丢掉 ?id= 等其它 query）'
);


// 图标必须是"声明即真实"的方形。只断言 manifest 里的 sizes 抓不到这类失真：
// 改动前 dumbpad-192.png 实际 118x109、dumbpad-512.png 实际 608x558，而
// manifest 声明 192x192/512x512 —— 旧断言同样全绿。
(async () => {
    const sharp = require('sharp');
    const assetsDir = path.join(root, 'public', 'Assets');

    for (const icon of pwaManifest.icons) {
        const filePath = path.join(assetsDir, icon.src);
        const meta = await sharp(filePath).metadata();
        const [declaredWidth, declaredHeight] = icon.sizes.split('x').map(Number);
        assert.strictEqual(meta.width, declaredWidth, `${icon.src} 实际宽度 ${meta.width} 与声明的 ${icon.sizes} 不符`);
        assert.strictEqual(meta.height, declaredHeight, `${icon.src} 实际高度 ${meta.height} 与声明的 ${icon.sizes} 不符`);
        // 图标是渐变+噪点的照片质感图，调色板量化后 512 约 70KB；超过 120KB
        // 说明又退回了未压缩的真彩色 PNG（曾达 247KB）。
        const { size } = fs.statSync(filePath);
        assert(size < 120 * 1024, `${icon.src} 体积 ${Math.round(size / 1024)}KB 超出 120KB 预算，图标应走调色板 PNG`);
    }

    // maskable 四角必须是不透明的 background_color：Edge 的启动屏把图标按正方形
    // 原样画出（不套蒙版），底色只要和启动屏底色差一级，就会显出一块砖。
    const maskable = pwaManifest.icons.find(icon => icon.purpose === 'maskable');
    const { data, info } = await sharp(path.join(assetsDir, maskable.src))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const expected = pwaManifest.background_color.replace('#', '').match(/../g).map(part => parseInt(part, 16));
    const corners = [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]];
    for (const [x, y] of corners) {
        const offset = (y * info.width + x) * info.channels;
        assert.strictEqual(data[offset + 3], 255, 'maskable 四角必须不透明，否则启动屏/蒙版下会露出透明角');
        for (let channel = 0; channel < 3; channel += 1) {
            assert(
                Math.abs(data[offset + channel] - expected[channel]) <= 1,
                `maskable 底色 rgb(${data[offset]},${data[offset + 1]},${data[offset + 2]}) 必须等于 background_color ${pwaManifest.background_color}`
            );
        }
    }

    console.log('PWA cache regression checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

