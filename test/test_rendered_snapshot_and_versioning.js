const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const { getBuildVersion, collectBuildFingerprintStats } = require('../scripts/build-version');
const { createAssetVersioning } = require('../scripts/asset-versioning');

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) console.log(`PASS ${name}`);
    else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
    }
};

function testBuildVersionContentStability() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-bv-'));
    try {
        const publicSub = path.join(tmpRoot, 'public');
        fs.mkdirSync(path.join(publicSub, 'Assets'), { recursive: true });
        fs.writeFileSync(path.join(publicSub, 'app.js'), 'console.log("hello");\n', 'utf8');
        fs.writeFileSync(path.join(publicSub, 'Assets', 'styles.css'), 'body { color: #111; }\n', 'utf8');

        const v1 = getBuildVersion(publicSub, '1.0.0');
        const future = new Date(Date.now() + 120000);
        fs.utimesSync(path.join(publicSub, 'app.js'), future, future);
        fs.utimesSync(path.join(publicSub, 'Assets', 'styles.css'), future, future);
        const v2 = getBuildVersion(publicSub, '1.0.0');
        check('BUILD_VERSION stays identical when only mtime changes', v1 === v2, { v1, v2 });

        fs.writeFileSync(path.join(publicSub, 'app.js'), 'console.log("hello!");\n', 'utf8');
        const v3 = getBuildVersion(publicSub, '1.0.0');
        check('BUILD_VERSION changes when file content changes', v3 !== v1, { v1, v3 });

        const stats = collectBuildFingerprintStats(path.join(ROOT, 'public'));
        check('collectBuildFingerprintStats includes font/ assets and package manifests',
            stats.some(s => s.startsWith('font/changerwencai.woff2:')) &&
            stats.some(s => s.startsWith('package.json:')) &&
            stats.some(s => s.startsWith('package-lock.json:')));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

function testAssetVersioning() {
    const av = createAssetVersioning({
        rootDir: ROOT,
        publicDir: path.join(ROOT, 'public'),
        nodeEnv: 'test',
    });

    const html = av.renderIndexHtml();
    const importMapPos = html.indexOf('<script type="importmap">');
    const firstPreloadPos = html.indexOf('<link rel="modulepreload"');
    const appScriptMatch = html.match(/<script\s+src="([^"]+)"\s+type="module"><\/script>/);
    const appScriptPos = appScriptMatch ? html.indexOf(appScriptMatch[0]) : -1;

    check('importmap is injected before every modulepreload and module script',
        importMapPos > 0 && importMapPos < firstPreloadPos && firstPreloadPos < appScriptPos,
        { importMapPos, firstPreloadPos, appScriptPos });

    const importMapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    const importMap = importMapMatch ? JSON.parse(importMapMatch[1]) : null;
    check('importmap covers core ESM entries and dynamic lazy modules with ?v= hashes',
        Boolean(
            importMap?.imports?.['/app.js']?.includes('?v=') &&
            importMap?.imports?.['/tiptap-editor.js']?.includes('?v=') &&
            importMap?.imports?.['/managers/rendered-snapshot-cache.js']?.includes('?v=') &&
            importMap?.imports?.['/managers/thoughts.js']?.includes('?v=') &&
            importMap?.imports?.['/js/marked/marked.esm.js']?.includes('?v=') &&
            !importMap?.imports?.['/vendor/tiptap/tiptap.bundle.js']
        ));

    const closure = av.collectStaticModuleGraph(['/app.js', '/tiptap-editor.js']);
    const preloadedHrefs = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]);
    check('modulepreload covers full static closure of /app.js and /tiptap-editor.js',
        closure.length >= 40 && closure.every(mod => preloadedHrefs.includes(av.versionedUrl(mod))),
        { closureCount: closure.length, preloadCount: preloadedHrefs.length });

    check('CSS links receive ?v= hashes while /vendor/vditor/index.css and manifest keep clean URLs',
        html.includes(`href="${av.versionedUrl('/Assets/styles.css')}"`) &&
        html.includes(`href="${av.versionedUrl('/Assets/ios-theme.css')}"`) &&
        html.includes(`href="${av.versionedUrl('/css/@highlightjs/github.min.css')}"`) &&
        html.includes('href="/vendor/vditor/index.css"') &&
        html.includes('href="Assets/manifest.json?v=3"'));

    const sw = av.renderServiceWorker('1.1.0-test');
    check('renderServiceWorker injects APP_VERSION, RUNTIME_FINGERPRINT, and hashed CORE_ASSETS',
        sw.includes('let APP_VERSION = "1.1.0-test";') &&
        /let RUNTIME_FINGERPRINT = "[0-9a-f]{12}";/.test(sw) &&
        sw.includes(`"${av.versionedUrl('/app.js')}"`) &&
        sw.includes(`"${av.versionedUrl('/managers/rendered-snapshot-cache.js')}"`) &&
        sw.includes('"/index.html"') &&
        sw.includes('"/Assets/dumbpad-icon-192.png"'));

    const headersHit = {};
    av.immutableStaticMiddleware(
        { method: 'GET', path: '/app.js', query: { v: av.getHash('/app.js') } },
        { setHeader: (k, v) => { headersHit[k] = v; } },
        () => {}
    );
    check('immutableStaticMiddleware sets max-age=31536000, immutable on matching ?v= hash',
        headersHit['Cache-Control'] === 'public, max-age=31536000, immutable', headersHit);

    const headersMiss = {};
    av.immutableStaticMiddleware(
        { method: 'GET', path: '/app.js', query: { v: 'deadbeef' } },
        { setHeader: (k, v) => { headersMiss[k] = v; } },
        () => {}
    );
    check('immutableStaticMiddleware withholds immutable when ?v= hash mismatches',
        !headersMiss['Cache-Control'], headersMiss);
}

async function testRenderedSnapshotCache() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;

    const mod = await import(pathToFileURL(path.join(ROOT, 'public/managers/rendered-snapshot-cache.js')).href);
    const {
        computeContentSignature,
        serializeEditorRenderedHtml,
        saveRenderedSnapshot,
        loadRenderedSnapshot,
        removeRenderedSnapshot,
    } = mod;

    // Parity check with index.html inline computeSig
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const inlineSigMatch = indexHtml.match(/var computeSig = (function \(text\) \{[\s\S]*?\});/);
    check('index.html inline computeSig matches rendered-snapshot-cache signature', Boolean(inlineSigMatch));
    if (inlineSigMatch) {
        const inlineFn = vm.runInNewContext(`(${inlineSigMatch[1]})`);
        for (const sample of ['', '# 中文标题\n\n- [~] task', 'hello 😊 world\n\n> quote']) {
            check(`signature parity for sample (${sample.length} chars)`,
                inlineFn(sample) === computeContentSignature(sample));
        }
    }

    const root = document.createElement('div');
    root.className = 'tiptap ProseMirror vditor-reset';
    root.setAttribute('contenteditable', 'true');
    root.innerHTML = [
        '<h1 class="article-jump-target">标题</h1>',
        '<p class="ProseMirror-selectednode" onclick="alert(1)"><br class="ProseMirror-trailingBreak"></p>',
        '<blockquote><p>引用 <a href="javascript:alert(1)">坏链接</a> <span contenteditable="false">ok</span></p></blockquote>',
        '<ul data-type="taskList">',
        '<li data-type="taskItem" data-checked="true" data-doing="false"><label><input type="checkbox"><span></span></label><div><p>done</p></div></li>',
        '<li data-type="taskItem" data-checked="false" data-doing="true"><label><input type="checkbox"><span></span></label><div><p>doing</p></div></li>',
        '</ul>',
        '<script>window.__xss = 1;</script>',
        '<div class="ProseMirror-gapcursor"></div>',
    ].join('');
    const inputs = root.querySelectorAll('input[type="checkbox"]');
    inputs[0].checked = true;
    inputs[1].indeterminate = true;

    const sanitized = serializeEditorRenderedHtml(root);
    check('serializeEditorRenderedHtml strips script/events/javascript URLs/transient classes & contenteditable',
        !sanitized.includes('<script') &&
        !sanitized.includes('onclick') &&
        !sanitized.includes('javascript:') &&
        !sanitized.includes('ProseMirror-selectednode') &&
        !sanitized.includes('article-jump-target') &&
        !sanitized.includes('ProseMirror-gapcursor') &&
        !sanitized.includes('contenteditable'),
        sanitized);
    check('serializeEditorRenderedHtml preserves empty-line trailingBreak and 3-state task checkboxes',
        sanitized.includes('ProseMirror-trailingBreak') &&
        sanitized.includes('checked=""') &&
        sanitized.includes('disabled=""') &&
        sanitized.includes('data-doing="true"'),
        sanitized);

    const oversize = document.createElement('div');
    oversize.innerHTML = `<p>${'a'.repeat(260000)}</p>`;
    check('serializeEditorRenderedHtml skips snapshots exceeding 250K chars',
        serializeEditorRenderedHtml(oversize) === null);

    const store = new Map();
    const mockStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
    };

    check('saveRenderedSnapshot stores and loadRenderedSnapshot hits on matching Markdown',
        saveRenderedSnapshot('n1', '# 标题', root, mockStorage) &&
        Boolean(loadRenderedSnapshot('n1', '# 标题', mockStorage)?.html));
    check('loadRenderedSnapshot returns null on 1-char Markdown mismatch',
        loadRenderedSnapshot('n1', '# 标题!', mockStorage) === null);

    saveRenderedSnapshot('n2', '2', root, mockStorage);
    saveRenderedSnapshot('n3', '3', root, mockStorage);
    saveRenderedSnapshot('n4', '4', root, mockStorage);
    check('LRU eviction keeps at most 3 articles (n1 evicted, n4 retained)',
        loadRenderedSnapshot('n1', '# 标题', mockStorage) === null &&
        Boolean(loadRenderedSnapshot('n4', '4', mockStorage)));
    check('removeRenderedSnapshot deletes an article entry cleanly',
        removeRenderedSnapshot('n4', mockStorage) &&
        loadRenderedSnapshot('n4', '4', mockStorage) === null);
}

async function testServiceWorkerColdStartPaths() {
    const av = createAssetVersioning({
        rootDir: ROOT,
        publicDir: path.join(ROOT, 'public'),
        nodeEnv: 'test',
    });
    const swCode = av.renderServiceWorker('1.1.0-swtest');

    const listeners = {};
    const cacheEntries = new Map();
    const createMockCache = (name) => {
        if (!cacheEntries.has(name)) cacheEntries.set(name, new Map());
        const map = cacheEntries.get(name);
        return {
            match: async (req) => {
                const key = typeof req === 'string' ? req : req?.url;
                if (map.has(key)) return map.get(key);
                if (key && key.startsWith('https://draft.example.test')) {
                    const rel = key.slice('https://draft.example.test'.length);
                    if (map.has(rel)) return map.get(rel);
                }
                return null;
            },
            put: async (req, res) => {
                const key = typeof req === 'string' ? req : req?.url;
                map.set(key, res);
            },
            add: async (req) => {
                const key = typeof req === 'string' ? req : req?.url;
                map.set(key, { ok: true, status: 200, redirected: false, body: `ADDED:${key}`, clone() { return this; } });
            },
            delete: async (req) => {
                const key = typeof req === 'string' ? req : req?.url;
                map.delete(key);
                if (key && key.startsWith('https://draft.example.test')) {
                    map.delete(key.slice('https://draft.example.test'.length));
                }
            },
            keys: async () => [...map.keys()].filter(k => k.startsWith('/') && !k.startsWith('/__')).map(k => ({ url: `https://draft.example.test${k}` })),
        };
    };

    const currentBucket = 'DUMBPAD_CACHE_1.1.0-swtest';
    const currentCache = createMockCache(currentBucket);
    await currentCache.put('/index.html', { ok: true, status: 200, redirected: false, body: '__CACHED_SHELL__', clone() { return this; } });
    const appVersioned = av.versionedUrl('/app.js');
    await currentCache.put(appVersioned, { ok: true, status: 200, redirected: false, body: '__CACHED_HASHED_APP__', clone() { return this; } });
    await currentCache.put('/app.js', { ok: true, status: 200, redirected: false, body: '__CACHED_BARE_APP__', clone() { return this; } });

    let navFetchMode = 'fresh';
    const swContext = {
        URL,
        Promise,
        Response: class MockResponse {
            constructor(body, init = {}) {
                this.body = String(body ?? '');
                this.status = init.status || 200;
                this.ok = this.status >= 200 && this.status < 300;
            }
            async text() { return this.body; }
            clone() { return this; }
        },
        caches: {
            match: async (req) => currentCache.match(req),
            open: async (name) => createMockCache(name),
            keys: async () => [...cacheEntries.keys()],
            delete: async (name) => cacheEntries.delete(name),
        },
        self: {
            location: { origin: 'https://draft.example.test' },
            registration: {},
            clients: { claim: async () => {}, matchAll: async () => [] },
            addEventListener: (type, handler) => { listeners[type] = handler; },
        },
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout,
        clearTimeout,
        fetch: async (req) => {
            const urlStr = typeof req === 'string' ? req : req.url;
            if (urlStr.includes('/api/config')) {
                return { ok: true, status: 200, json: async () => ({ version: '1.1.0-swtest' }) };
            }
            await new Promise(r => setTimeout(r, 700));
            if (navFetchMode === 'redirected') {
                return { ok: true, status: 200, redirected: true, body: '__LOGIN_HTML__', clone() { return this; } };
            }
            return { ok: true, status: 200, redirected: false, body: `__NETWORK_${urlStr}__`, clone() { return this; } };
        },
    };

    vm.runInNewContext(swCode, swContext);

    const dispatchFetch = (request) => {
        const bgTasks = [];
        let responded = null;
        listeners.fetch({
            request: { method: 'GET', ...request },
            preloadResponse: null,
            waitUntil: (p) => bgTasks.push(Promise.resolve(p)),
            respondWith: (p) => { responded = Promise.resolve(p); },
        });
        return { promise: responded, bgTasks };
    };

    // 1. Versioned static asset -> 0ms cacheFirst even with 700ms network stall
    const t0 = Date.now();
    const hashedRes = await dispatchFetch({ url: `https://draft.example.test${appVersioned}` }).promise;
    const hashedElapsed = Date.now() - t0;
    check('versioned ?v=<hash> asset resolves via 0ms cacheFirst without waiting on network',
        hashedRes?.body === '__CACHED_HASHED_APP__' && hashedElapsed < 150,
        { body: hashedRes?.body, elapsedMs: hashedElapsed });

    // 2. Unversioned static asset -> waits ~450ms STATIC_NETWORK_TIMEOUT
    const t1 = Date.now();
    const bareRes = await dispatchFetch({ url: 'https://draft.example.test/app.js' }).promise;
    const bareElapsed = Date.now() - t1;
    check('unversioned .js still preserves ~450ms network-first timeout fallback',
        bareRes?.body === '__CACHED_BARE_APP__' && bareElapsed >= 350,
        { body: bareRes?.body, elapsedMs: bareElapsed });

    // 3. App Shell default cold launch -> 0ms SWR + background auth redirect cleanup
    navFetchMode = 'fresh';
    const t2 = Date.now();
    const swr = dispatchFetch({ mode: 'navigate', url: 'https://draft.example.test/' });
    const swrRes = await swr.promise;
    const swrElapsed = Date.now() - t2;
    check('cached App Shell cold launch resolves in 0ms via SWR',
        swrRes?.body === '__CACHED_SHELL__' && swrElapsed < 150,
        { body: swrRes?.body, elapsedMs: swrElapsed });
    await Promise.all(swr.bgTasks);
    const updatedShell = await currentCache.match('/index.html');
    check('App Shell background revalidation refreshes cached HTML',
        updatedShell?.body === '__NETWORK_https://draft.example.test/__', updatedShell?.body);

    // 4. Explicit reload -> waits for fresh network HTML
    navFetchMode = 'fresh';
    const reloadRes = await dispatchFetch({ mode: 'navigate', cache: 'reload', url: 'https://draft.example.test/' }).promise;
    check('explicit browser reload bypasses SWR instant cache and fetches network',
        reloadRes?.body === '__NETWORK_https://draft.example.test/__', reloadRes?.body);

    // 5. Redirected auth expiration in background clears cached shell
    navFetchMode = 'redirected';
    const expiredSwr = dispatchFetch({ mode: 'navigate', url: 'https://draft.example.test/' });
    await expiredSwr.promise;
    await Promise.all(expiredSwr.bgTasks);
    check('redirected background revalidation clears cached /index.html on session expiry',
        (await currentCache.match('/index.html')) === null);
}

(async () => {
    testBuildVersionContentStability();
    testAssetVersioning();
    await testRenderedSnapshotCache();
    await testServiceWorkerColdStartPaths();
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll cold-start snapshot & versioning checks passed');
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
