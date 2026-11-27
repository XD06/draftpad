/**
 * 零构建静态资源内容哈希、Import Map 与 Service Worker 版本清单装配器。
 * 为无构建步骤的原生 ES Module 与样式注入 ?v=<sha1>、扁平化 modulepreload 与
 * 精准 immutable HTTP 缓存头，确保冷重启 0ms 缓存直出且发版自动精准失效。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HASH_QUERY_LENGTH = 8;
const STATIC_IMPORT_RE = /^\s*import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/gm;

const EXCLUDED_PUBLIC_REL_PATHS = new Set([
    'index.html',
    'login.html',
    'service-worker.js',
    'Assets/manifest.json',
    'Assets/asset-manifest.json',
]);

function isExcludedPublicPath(relPosix) {
    if (EXCLUDED_PUBLIC_REL_PATHS.has(relPosix)) return true;
    if (relPosix.startsWith('vendor/')) return true;
    if (/^Assets\/dumbpad-.*\.png$/i.test(relPosix)) return true;
    return false;
}

function sha1Hex(buffer, length = HASH_QUERY_LENGTH) {
    return crypto.createHash('sha1').update(buffer).digest('hex').slice(0, length);
}

function walkFiles(dirPath, onFile) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            walkFiles(fullPath, onFile);
        } else if (entry.isFile()) {
            onFile(fullPath);
        }
    }
}

function createAssetVersioning({ rootDir, publicDir, nodeEnv = 'production' } = {}) {
    const resolvedRoot = path.resolve(rootDir || path.join(__dirname, '..'));
    const resolvedPublic = path.resolve(publicDir || path.join(resolvedRoot, 'public'));
    const isProduction = nodeEnv === 'production';

    /** @type {Map<string, { filePath: string, size: number, mtimeMs: number, hash: string }>} */
    const entries = new Map();
    let cachedIndexHtml = null;
    let cachedServiceWorker = new Map();

    const mountedMounts = [
        { urlPrefix: '/js/marked/', dirPath: path.join(resolvedRoot, 'node_modules/marked/lib') },
        { urlPrefix: '/js/marked-extended-tables/', dirPath: path.join(resolvedRoot, 'node_modules/marked-extended-tables/src') },
        { urlPrefix: '/js/marked-alert/', dirPath: path.join(resolvedRoot, 'node_modules/marked-alert/dist') },
        { urlPrefix: '/js/marked-highlight/', dirPath: path.join(resolvedRoot, 'node_modules/marked-highlight/src') },
    ];
    const mountedSingleFiles = [
        ['/js/@highlightjs/highlight.min.js', path.join(resolvedRoot, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')],
        ['/css/@highlightjs/github.min.css', path.join(resolvedRoot, 'node_modules/@highlightjs/cdn-assets/styles/github.min.css')],
        ['/css/@highlightjs/github-dark.min.css', path.join(resolvedRoot, 'node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css')],
    ];

    function recordFile(urlPath, filePath) {
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) return null;
            const prev = entries.get(urlPath);
            if (prev && prev.filePath === filePath && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
                return prev;
            }
            const hash = sha1Hex(fs.readFileSync(filePath));
            const next = { filePath, size: stat.size, mtimeMs: stat.mtimeMs, hash };
            entries.set(urlPath, next);
            return next;
        } catch (_error) {
            return null;
        }
    }

    function scanAllAssets() {
        const nextSeen = new Set();
        walkFiles(resolvedPublic, (fullPath) => {
            const relPosix = path.relative(resolvedPublic, fullPath).replace(/\\/g, '/');
            if (isExcludedPublicPath(relPosix)) return;
            const urlPath = `/${relPosix}`;
            nextSeen.add(urlPath);
            recordFile(urlPath, fullPath);
        });
        for (const { urlPrefix, dirPath } of mountedMounts) {
            walkFiles(dirPath, (fullPath) => {
                const relPosix = path.relative(dirPath, fullPath).replace(/\\/g, '/');
                const urlPath = `${urlPrefix}${relPosix}`;
                nextSeen.add(urlPath);
                recordFile(urlPath, fullPath);
            });
        }
        for (const [urlPath, filePath] of mountedSingleFiles) {
            if (fs.existsSync(filePath)) {
                nextSeen.add(urlPath);
                recordFile(urlPath, filePath);
            }
        }
        for (const key of entries.keys()) {
            if (!nextSeen.has(key)) entries.delete(key);
        }
    }

    scanAllAssets();

    function refreshIfDev() {
        if (isProduction) return;
        const prevHashes = new Map();
        for (const [k, v] of entries) prevHashes.set(k, v.hash);
        scanAllAssets();
        let changed = prevHashes.size !== entries.size;
        if (!changed) {
            for (const [k, v] of entries) {
                if (prevHashes.get(k) !== v.hash) { changed = true; break; }
            }
        }
        if (changed) {
            cachedIndexHtml = null;
            cachedServiceWorker.clear();
        }
    }

    function getHash(pathname) {
        const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
        const existing = entries.get(normalized);
        if (!existing) return null;
        if (!isProduction) {
            const refreshed = recordFile(normalized, existing.filePath);
            return refreshed ? refreshed.hash : null;
        }
        return existing.hash;
    }

    function versionedUrl(rawPath) {
        const clean = String(rawPath || '').split('?')[0];
        const pathname = clean.startsWith('/') ? clean : `/${clean}`;
        const hash = getHash(pathname);
        return hash ? `${pathname}?v=${hash}` : rawPath;
    }

    function collectStaticModuleGraph(entryUrls = ['/app.js', '/tiptap-editor.js']) {
        const visited = new Set();
        const queue = [...entryUrls];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || visited.has(current)) continue;
            visited.add(current);
            const entry = entries.get(current);
            if (!entry) continue;
            let content = '';
            try {
                content = fs.readFileSync(entry.filePath, 'utf8');
            } catch (_error) {
                continue;
            }
            STATIC_IMPORT_RE.lastIndex = 0;
            let match;
            while ((match = STATIC_IMPORT_RE.exec(content)) !== null) {
                const spec = match[1];
                if (!spec || (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/'))) continue;
                const resolved = spec.startsWith('/')
                    ? spec
                    : path.posix.resolve(path.posix.dirname(current), spec);
                if (!visited.has(resolved) && resolved.endsWith('.js')) {
                    queue.push(resolved);
                }
            }
        }
        return [...visited];
    }

    function buildImportMapObject() {
        const imports = {};
        const sortedPaths = [...entries.keys()]
            .filter(pathname => pathname.endsWith('.js'))
            .sort();
        for (const pathname of sortedPaths) {
            const hash = entries.get(pathname)?.hash;
            if (hash) {
                imports[pathname] = `${pathname}?v=${hash}`;
            }
        }
        return { imports };
    }

    function computeRuntimeFingerprint() {
        const hash = crypto.createHash('sha1');
        const runtimeFiles = [];
        walkFiles(path.join(resolvedPublic, 'vendor'), (filePath) => runtimeFiles.push(filePath));
        walkFiles(path.join(resolvedRoot, 'font'), (filePath) => runtimeFiles.push(filePath));
        const vditorCss = path.join(resolvedRoot, 'node_modules/vditor/dist/index.css');
        if (fs.existsSync(vditorCss)) runtimeFiles.push(vditorCss);
        runtimeFiles.sort();
        for (const filePath of runtimeFiles) {
            const rel = path.relative(resolvedRoot, filePath).replace(/\\/g, '/');
            hash.update(rel);
            hash.update(':');
            hash.update(sha1Hex(fs.readFileSync(filePath), 12));
            hash.update('|');
        }
        return hash.digest('hex').slice(0, 12);
    }

    function renderIndexHtml() {
        refreshIfDev();
        const indexPath = path.join(resolvedPublic, 'index.html');
        let htmlStat = null;
        try {
            htmlStat = fs.statSync(indexPath);
        } catch (_error) {}
        if (cachedIndexHtml && (isProduction || (htmlStat && cachedIndexHtml.mtimeMs === htmlStat.mtimeMs && cachedIndexHtml.size === htmlStat.size))) {
            return cachedIndexHtml.html;
        }

        let html = fs.readFileSync(indexPath, 'utf8');

        // 1. Version CSS stylesheet & noscript links (keep /vendor/vditor/index.css and manifest/icons untouched)
        html = html.replace(
            /(<link\b[^>]*\bhref=["'])(Assets\/[^"']+\.css|\/css\/[^"']+\.css)(["'][^>]*>)/g,
            (_full, prefix, href, suffix) => `${prefix}${versionedUrl(href)}${suffix}`
        );

        // 2. Build importmap + flattened static modulepreload closure
        const importMapJson = JSON.stringify(buildImportMapObject());
        const importMapTag = `<script type="importmap">${importMapJson}</script>`;
        const closure = collectStaticModuleGraph(['/app.js', '/tiptap-editor.js']);
        const preloadTags = closure
            .map((modPath) => `    <link rel="modulepreload" href="${versionedUrl(modPath)}">`)
            .join('\n');

        // Replace existing <link rel="modulepreload" ...> block in <head>; place <script type="importmap">
        // strictly BEFORE every <link rel="modulepreload"> and <script type="module">.
        const modulepreloadBlockRe = /(?:[ \t]*<link\s+rel=["']modulepreload["'][^>]*>\r?\n?)+/;
        if (modulepreloadBlockRe.test(html)) {
            html = html.replace(modulepreloadBlockRe, `    ${importMapTag}\n${preloadTags}\n`);
        } else {
            html = html.replace(
                '</head>',
                `    ${importMapTag}\n${preloadTags}\n</head>`
            );
        }

        // 3. Version app.js entry script tag
        html = html.replace(
            /(<script\s+src=["'])app\.js(["']\s+type=["']module["']><\/script>)/,
            (_full, prefix, suffix) => `${prefix}${versionedUrl('/app.js')}${suffix}`
        );

        cachedIndexHtml = {
            html,
            mtimeMs: htmlStat?.mtimeMs || 0,
            size: htmlStat?.size || html.length,
        };
        return html;
    }

    function renderServiceWorker(buildVersion) {
        refreshIfDev();
        const swPath = path.join(resolvedPublic, 'service-worker.js');
        let swStat = null;
        try {
            swStat = fs.statSync(swPath);
        } catch (_error) {}
        const cacheKey = String(buildVersion || '');
        const existing = cachedServiceWorker.get(cacheKey);
        if (existing && (isProduction || (swStat && existing.mtimeMs === swStat.mtimeMs && existing.size === swStat.size))) {
            return existing.content;
        }

        let sw = fs.readFileSync(swPath, 'utf8');
        const runtimeFingerprint = computeRuntimeFingerprint();
        sw = sw.replace(/let APP_VERSION = ".*?";/, `let APP_VERSION = "${buildVersion}";`);
        sw = sw.replace(/let RUNTIME_FINGERPRINT = ".*?";/, `let RUNTIME_FINGERPRINT = "${runtimeFingerprint}";`);

        const unversionedCoreEntries = new Set([
            '/index.html',
            '/Assets/manifest.json',
            '/Assets/dumbpad-icon-192.png',
        ]);
        sw = sw.replace(/(const CORE_ASSETS = \[[\s\S]*?\];)/, (block) =>
            block.replace(/"(\/[^"]+)"/g, (full, assetPath) => {
                if (unversionedCoreEntries.has(assetPath)) return full;
                const hash = getHash(assetPath);
                return hash ? `"${assetPath}?v=${hash}"` : full;
            })
        );

        cachedServiceWorker.set(cacheKey, {
            content: sw,
            mtimeMs: swStat?.mtimeMs || 0,
            size: swStat?.size || sw.length,
        });
        return sw;
    }

    const immutableStaticMiddleware = (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const rawV = req.query?.v;
        if (typeof rawV !== 'string' || !rawV) return next();
        const currentHash = getHash(req.path);
        if (currentHash && rawV === currentHash) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        return next();
    };

    return {
        getHash,
        versionedUrl,
        collectStaticModuleGraph,
        buildImportMapObject,
        computeRuntimeFingerprint,
        renderIndexHtml,
        renderServiceWorker,
        immutableStaticMiddleware,
    };
}

module.exports = { createAssetVersioning };
