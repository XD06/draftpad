require('dotenv').config();
const express = require('express');
const compression = require('compression');
const { marked } = require('marked');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { generatePWAManifest } = require("./scripts/pwa-manifest-generator")
const { originValidationMiddleware, getCorsOptions, validateOrigin } = require('./scripts/cors');
const { 
    sanitizeFilename, 
    getNotepadFilePath, 
    migrateAllNotepadsToNameBasedFiles, 
    migrateDefaultNotepad 
} = require('./scripts/notepad-migration');
const { TRUST_PROXY, TRUSTED_PROXY_IPS } = require('./config');
const { getClientIp } = require('./utils/ipExtractor');
const { createSearchIndex } = require('./server/indexing');
const { createWebSocketHub } = require('./server/websocket');
const storage = require('./scripts/storage');
const aiQueue = require('./scripts/ai-queue');
const s3PrefixTools = require('./scripts/s3-prefix-tools');
const localToS3Migration = require('./scripts/migrate-local-to-s3');
const s3Service = require('./scripts/s3-service');
const { registerAuthRoutes } = require('./routes/auth-routes');
const { registerAssetRoutes } = require('./routes/asset-routes');
const { registerDataManagementRoutes } = require('./routes/data-management-routes');
const { registerNoteRoutes } = require('./routes/note-routes');
const { registerNotepadRoutes } = require('./routes/notepad-routes');
const { registerSearchRoutes } = require('./routes/search-routes');
const { registerShareRoutes } = require('./routes/share-routes');
const { registerStaticRoutes } = require('./routes/static-routes');
const { registerThoughtRoutes } = require('./routes/thought-routes');
const { registerTrashRoutes } = require('./routes/trash-routes');
const ipaddr = require('ipaddr.js');

function getAvailableHighlightLanguages() {
    const languagesDir = path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/es/languages');
    try {
        return fsSync.readdirSync(languagesDir)
            .filter(file => file.endsWith('.min.js'))
            .map(file => file.replace(/\.min\.js$/, ''))
            .filter(Boolean)
            .sort();
    } catch (err) {
        console.warn('Unable to read highlight.js language directory:', err.message);
        return ['javascript', 'json', 'markdown', 'plaintext'];
    }
}

const HIGHLIGHT_LANGUAGES = process.env.HIGHLIGHT_LANGUAGES
    ? process.env.HIGHLIGHT_LANGUAGES.split(',').map(lang => lang.trim())
    : getAvailableHighlightLanguages();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development'
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "Assets");
const NOTEPADS_FILE = path.join(DATA_DIR, 'notepads.json');
const THOUGHTS_FILE = path.join(DATA_DIR, 'thoughts.json');
const SITE_TITLE = process.env.SITE_TITLE || 'DumbPad';
const PIN = process.env.DUMBPAD_PIN;

const COOKIE_NAME = 'dumbpad_auth';
const COOKIE_MAX_AGE = process.env.COOKIE_MAX_AGE || 24; // default 24 in hours
const cookieMaxAge = COOKIE_MAX_AGE * 60 * 60 * 1000; // in hours
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PAGE_HISTORY_COOKIE = 'dumbpad_page_history';
const PAGE_HISTORY_COOKIE_AGE = process.env.PAGE_HISTORY_COOKIE_AGE || 365; // defaults to 1 Year in days
const pageHistoryCookieAge = PAGE_HISTORY_COOKIE_AGE * 24 * 60 * 60 * 1000;
const MAX_FILENAME_COLLISION_ATTEMPTS = 100; // Maximum attempts to resolve filename collisions
const DEBUG_WS = process.env.DEBUG_WS === 'true';
const SHARE_SECRET = process.env.SHARE_SECRET || PIN || 'dumbpad_default_secret_9988';
if (!process.env.SHARE_SECRET) {
    console.warn('SECURITY: SHARE_SECRET is not set — falling back to PIN or a hardcoded default. Set a dedicated high-entropy SHARE_SECRET env var in production so share tokens cannot be derived from the PIN.');
}

function getShareToken(id) {
    return crypto.createHmac('sha256', SHARE_SECRET).update(id).digest('hex').substring(0, 16);
}

const packageJson = require('./package.json');
const VERSION = packageJson.version || '1.0.0';
let BUILD_VERSION = VERSION;

function collectPublicAssetStats(dir, baseDir = dir, stats = []) {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectPublicAssetStats(fullPath, baseDir, stats);
            continue;
        }
        const stat = fsSync.statSync(fullPath);
        stats.push([
            path.relative(baseDir, fullPath).replace(/\\/g, '/'),
            stat.size,
            Math.floor(stat.mtimeMs),
        ].join(':'));
    }
    return stats;
}

function collectBuildFingerprintStats() {
    const stats = collectPublicAssetStats(PUBLIC_DIR);
    for (const fileName of ['package.json', 'package-lock.json']) {
        const filePath = path.join(__dirname, fileName);
        if (!fsSync.existsSync(filePath)) continue;
        const stat = fsSync.statSync(filePath);
        stats.push([
            fileName,
            stat.size,
            Math.floor(stat.mtimeMs),
        ].join(':'));
    }
    return stats;
}

function getBuildVersion() {
    try {
        const hash = crypto
            .createHash('sha1')
            .update(collectBuildFingerprintStats().sort().join('|'))
            .digest('hex')
            .slice(0, 10);
        return `${VERSION}-${hash}`;
    } catch (error) {
        console.warn('Unable to compute asset build version:', error);
        return VERSION;
    }
}

const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Version: ${VERSION}`);
});

// Configure proxy trust for secure IP extraction and cookie handling
// Only enable trust proxy when TRUSTED_PROXY_IPS is properly configured
if (TRUST_PROXY) {
    if (!TRUSTED_PROXY_IPS || TRUSTED_PROXY_IPS.trim() === '') {
        // Critical security issue: TRUST_PROXY enabled without specifying trusted proxy IPs
        app.set('trust proxy', false);
        console.error('CRITICAL WARNING: TRUST_PROXY=true but TRUSTED_PROXY_IPS is not set or empty.');
        console.error('Trust proxy is disabled for security. Set TRUSTED_PROXY_IPS to enable proxy trust.');
        console.error('Example: TRUSTED_PROXY_IPS="127.0.0.1 # localhost, ::1 # IPv6 localhost, 10.0.0.0/8 # internal"');
    } else {
        // Parse and validate TRUSTED_PROXY_IPS (comma-separated list with optional inline comments)
        // Supports shell-style inline comments: "172.17.0.1 # Docker gateway, 10.0.0.0/8 # Internal"
        const trustedProxies = TRUSTED_PROXY_IPS
            .split(',')
            .map(entry => {
                // Strip inline comments (anything after '#')
                const withoutComment = entry.split('#')[0];
                return withoutComment.trim();
            })
            .filter(ip => ip.length > 0)
            .filter(ip => {
                // Validate IP/CIDR using ipaddr.js for proper format checking
                // This prevents malformed IPs like 999.999.999.999 or :::::::: from being accepted
                // Also accepts 'loopback', 'linklocal', 'uniquelocal' keywords supported by Express
                const keywordPattern = /^(loopback|linklocal|uniquelocal)$/i;
                
                // Check if it's a valid Express keyword
                if (keywordPattern.test(ip)) {
                    return true;
                }
                
                try {
                    // Check if it contains CIDR notation
                    if (ip.includes('/')) {
                        const [addr, prefix] = ip.split('/');
                        const prefixNum = parseInt(prefix, 10);
                        
                        // Validate the address part
                        const parsed = ipaddr.process(addr);
                        
                        // Validate prefix length based on IP version
                        if (parsed.kind() === 'ipv4') {
                            if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 32) {
                                throw new Error('Invalid IPv4 prefix length');
                            }
                        } else if (parsed.kind() === 'ipv6') {
                            if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 128) {
                                throw new Error('Invalid IPv6 prefix length');
                            }
                        }
                        
                        return true;
                    } else {
                        // Validate as individual IP address
                        ipaddr.process(ip);
                        return true;
                    }
                } catch (e) {
                    console.warn(`Ignoring invalid proxy IP/CIDR entry: "${ip}" - ${e.message}`);
                    return false;
                }
            });
        
        if (trustedProxies.length === 0) {
            app.set('trust proxy', false);
            console.error('CRITICAL WARNING: TRUSTED_PROXY_IPS provided but contains no valid entries after parsing.');
            console.error('Trust proxy is disabled for security.');
        } else {
            // Configure Express to trust only specified proxy IPs
            app.set('trust proxy', trustedProxies);
            console.log('Proxy trust enabled for the following IPs/CIDRs:');
            trustedProxies.forEach(ip => console.log(`  - ${ip}`));
        }
    }
} else {
    app.set('trust proxy', false);
    console.log('Proxy trust disabled (secure default)');
}

// CORS setup
const corsOptions = getCorsOptions(BASE_URL);

// Middleware setup
app.use(cors(corsOptions));
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Serve static files
app.use('/js/marked', express.static(
    path.join(__dirname, 'node_modules/marked/lib')
));
app.use('/js/marked-extended-tables', express.static(
    path.join(__dirname, 'node_modules/marked-extended-tables/src')
));
app.use('/js/marked-alert', express.static(
    path.join(__dirname, 'node_modules/marked-alert/dist')
));
app.use('/js/marked-highlight', express.static(
    path.join(__dirname, 'node_modules/marked-highlight/src')
));
app.use('/js/@highlightjs/highlight.min.js', express.static(
    path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')
));
app.use('/vendor/vditor', express.static(
    path.join(__dirname, 'node_modules/vditor/dist')
));
app.use('/vendor/vditor-package', express.static(
    path.join(__dirname, 'node_modules/vditor')
));
app.use('/font', express.static(
    path.join(__dirname, 'font'),
    { maxAge: '30d', immutable: true }
));
// Dynamically serve highlight.js languages
HIGHLIGHT_LANGUAGES.forEach(lang => {
    if (lang) {
        app.use(`/js/@highlightjs/languages/${lang}.min.js`, express.static(
            path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/es/languages', `${lang}.min.js`)
        ));
    }
});
app.use('/css/@highlightjs/github-dark.min.css', express.static(
    path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css')
));
app.use('/css/@highlightjs/github.min.css', express.static(
    path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/styles/github.min.css')
));

// Future enhancement: Support for all highlight.js themes
// Currently only serving light/dark GitHub themes for consistency
// To enable all themes, uncomment the following line and update theme selection logic:
// app.use('/css/@highlightjs', express.static(
//     path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/styles')
// ));


generatePWAManifest(SITE_TITLE);
BUILD_VERSION = getBuildVersion();

// Security headers (lightweight helmet replacement — no extra dependency).
// Applied before any route so static, API, and share pages all get them.
// CSP allows unsafe-inline for scripts/styles to stay compatible with the
// existing inline scripts in the share page and login page; XSS is mitigated
// at the source (escapeHtml + sanitizeHtml) rather than relying on CSP alone.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:;");
    next();
});

registerStaticRoutes(app, {
    publicDir: PUBLIC_DIR,
    assetsDir: ASSETS_DIR,
    buildVersion: BUILD_VERSION
});

app.use(express.static(path.join(__dirname, 'public'), {
    index: false
}));

const { broadcastWebSocketMessage, broadcastUpdate } = createWebSocketHub({
    server,
    validateOrigin,
    pin: PIN,
    cookieName: COOKIE_NAME,
    debug: DEBUG_WS
});

aiQueue.init({ storage, broadcast: broadcastWebSocketMessage });
setTimeout(() => {
    aiQueue.recoverStalePendingMeta()
        .catch(error => console.warn('[thought-ai] pending recovery failed:', error.message));
}, 1000);

registerAuthRoutes(app, {
    originValidationMiddleware,
    getClientIp,
    publicDir: PUBLIC_DIR,
    pin: PIN,
    cookieName: COOKIE_NAME,
    cookieMaxAge,
    baseUrl: BASE_URL,
    nodeEnv: NODE_ENV,
    siteTitle: SITE_TITLE,
    buildVersion: BUILD_VERSION,
    highlightLanguages: HIGHLIGHT_LANGUAGES
});

registerShareRoutes(app, {
    storage,
    marked,
    baseUrl: BASE_URL,
    getShareToken
});

// Ensure data directory exists
async function ensureDataDir() {
    try {
        // Create data directory if it doesn't exist
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        // Create notepads.json if it doesn't exist
        try {
            await fs.access(NOTEPADS_FILE);
            // If file exists, validate its structure
            const content = await fs.readFile(NOTEPADS_FILE, 'utf8');
            try {
                const data = JSON.parse(content);
                if (!data.notepads || !Array.isArray(data.notepads)) {
                    throw new Error('Invalid notepads structure');
                }
            } catch (err) {
                console.error('Invalid notepads.json detected. Backing up and rebuilding:', err);
                
                // 1) Backup the corrupted file to avoid silent data loss
                try {
                    const backupPath = path.join(DATA_DIR, `notepads.json.bak-${Date.now()}`);
                    await fs.rename(NOTEPADS_FILE, backupPath);
                    console.log(`Backed up corrupted notepads.json -> ${backupPath}`);
                } catch (backupErr) {
                    console.warn('Failed to backup corrupted notepads.json:', backupErr);
                }
                
                // 2) Best-effort rebuild from existing .txt files
                const notepads = [];
                const now = Date.now();
                notepads.push({ id: 'default', name: 'Default Notepad', createdAt: now, updatedAt: now });
                try {
                    const dataFiles = await fs.readdir(DATA_DIR);
                    const txtFiles = dataFiles
                        .filter(f => f.endsWith('.txt'))
                        .map(f => path.parse(f).name);
                    
                    for (const base of txtFiles) {
                        if (!base || base === 'default') continue;
                        let stats;
                        try {
                            stats = await fs.stat(path.join(DATA_DIR, `${base}.txt`));
                        } catch {
                            stats = { birthtimeMs: now, mtimeMs: now };
                        }
                        notepads.push({
                            id: base,
                            name: base,
                            createdAt: Math.floor(stats.birthtimeMs || now),
                            updatedAt: Math.floor(stats.mtimeMs || now),
                        });
                    }
                } catch (rebuildErr) {
                    console.warn('Failed to rebuild notepads list from data directory:', rebuildErr);
                }
                
                await fs.writeFile(NOTEPADS_FILE, JSON.stringify({ notepads }, null, 2), 'utf8');
            }
        } catch (err) {
            // File doesn't exist or can't be accessed, create it
            console.log('Creating new notepads.json');
            await fs.writeFile(NOTEPADS_FILE, JSON.stringify({
                notepads: [{ id: 'default', name: 'Default Notepad', createdAt: Date.now(), updatedAt: Date.now() }]
            }, null, 2), 'utf8');
        }

        // Ensure default notepad file exists
        await migrateDefaultNotepad(DATA_DIR);
    } catch (err) {
        console.error('Error initializing data directory:', err);
        throw err;
    }
}

async function loadNotepadsList() {
    const notepadsList = await getNotepadsFromDir();
    return notepadsList || [];
}

async function getNotepadsFromDir() {
    if (storage.backend === 's3') {
        const data = await storage.readNotepadsMeta();
        return data.notepads || [];
    }

    await ensureDataDir();
    let notepadsData = { notepads: [] };
    try {
        const fileContent = await fs.readFile(NOTEPADS_FILE, 'utf8');
        notepadsData = JSON.parse(fileContent);
    } catch (readError) {
        // If notepads.json doesn't exist or is invalid, start with an empty array
        if (readError.code !== 'ENOENT') {
            console.error('Error reading notepads.json:', readError);
        }
    }

    const notepads = notepadsData.notepads || [];

    const dataFiles = await fs.readdir(DATA_DIR);
    const txtFiles = dataFiles
        .filter(file => file.endsWith('.txt'))
        .map(file => path.parse(file).name); // Extract filename without extension

    // Find new files that don't match existing notepad IDs or sanitized names
    const newNotepads = [];
    for (const txtFile of txtFiles) {
        const matchesId = notepads.some(notepad => notepad.id === txtFile);
        const matchesSanitizedName = notepads.some(notepad => {
            const sanitizedName = sanitizeFilename(notepad.name);
            return sanitizedName === txtFile;
        });
        
        if (!matchesId && !matchesSanitizedName) {
            const uniqueName = generateUniqueName(txtFile, notepads);
            let stats;
            try {
                stats = await fs.stat(path.join(DATA_DIR, `${txtFile}.txt`));
            } catch (e) {
                stats = { birthtimeMs: Date.now(), mtimeMs: Date.now() };
            }
            newNotepads.push({ 
                id: txtFile, 
                name: uniqueName, 
                createdAt: Math.floor(stats.birthtimeMs || Date.now()), 
                updatedAt: Math.floor(stats.mtimeMs || Date.now())
            });
        }
    }

    // Self-heal (orphan .txt files + missing timestamps) inside the notepad
    // write lock with atomic write. The lock prevents a race with concurrent
    // DELETE (which removes meta then deletes the .txt file): without it, this
    // self-heal could re-add a notepad mid-deletion, resurrecting it as an
    // orphan meta entry pointing at a deleted file. We re-read the latest meta
    // inside the lock and re-check orphans against it.
    let resultNotepads = notepadsData.notepads;
    if (newNotepads.length > 0 || notepads.some(n => !n.createdAt || !n.updatedAt)) {
        resultNotepads = await storage.withNotepadWriteLock(async () => {
            const latest = await storage.readNotepadsMeta();
            const list = latest.notepads || [];
            const existingIds = new Set(list.map(n => n.id));
            const existingNames = new Set(list.map(n => sanitizeFilename(n.name)));
            const trulyOrphan = newNotepads.filter(n =>
                !existingIds.has(n.id) && !existingNames.has(n.id)
            );

            let changed = false;
            for (const notepad of list) {
                if (!notepad.createdAt || !notepad.updatedAt) {
                    try {
                        const filePath = await getNotepadFilePath(notepad, DATA_DIR);
                        const stats = await fs.stat(filePath);
                        notepad.createdAt = notepad.createdAt || Math.floor(stats.birthtimeMs || Date.now());
                        notepad.updatedAt = notepad.updatedAt || Math.floor(stats.mtimeMs || Date.now());
                    } catch (e) {
                        notepad.createdAt = notepad.createdAt || Date.now();
                        notepad.updatedAt = notepad.updatedAt || Date.now();
                    }
                    changed = true;
                }
            }

            if (trulyOrphan.length > 0) {
                console.log(`Added orphan notepads: ${trulyOrphan.map(n => n.id).join(', ')}`);
                latest.notepads = [...list, ...trulyOrphan];
                changed = true;
            }

            if (changed) {
                await storage.saveNotepadsMeta(latest);
            }
            return latest.notepads;
        });
    }

    return resultNotepads;
}

// Helper function to generate unique notepad name
function generateUniqueName(desiredName, existingNotepads) {
    let uniqueName = desiredName;
    let counter = 1;
    
    // Check if name already exists or if sanitized name would conflict with default.txt
    while (existingNotepads.some(notepad => notepad.name === uniqueName) || 
           sanitizeFilename(uniqueName).toLowerCase() === 'default') {
        uniqueName = `${desiredName}-${counter}`;
        counter++;
    }
    
    return uniqueName;
}

const {
    indexNotepads,
    scheduleIndexNotepads,
    searchNotepads,
    watchSearchDocuments
} = createSearchIndex({
    storage,
    dataDir: DATA_DIR,
    notepadsFile: NOTEPADS_FILE
});

// Migrate existing ID-based files to name-based files
(async () => {
    console.log('Checking for notepad files to migrate...');
    const notepads = await loadNotepadsList();
    await migrateAllNotepadsToNameBasedFiles(notepads, DATA_DIR);
    
    // Initial indexing after migration is complete
    indexNotepads();
    watchSearchDocuments();
})();

/* API Endpoints */
registerDataManagementRoutes(app, {
    storage,
    s3PrefixTools,
    localToS3Migration,
    s3Service
});

registerAssetRoutes(app, {
    storage,
    originValidationMiddleware
});

registerThoughtRoutes(app, {
    storage,
    aiQueue,
    scheduleIndexNotepads,
    broadcastWebSocketMessage
});

registerTrashRoutes(app, {
    storage,
    scheduleIndexNotepads,
    broadcastWebSocketMessage
});

registerNoteRoutes(app, {
    storage,
    dataDir: DATA_DIR,
    baseUrl: BASE_URL,
    nodeEnv: NODE_ENV,
    pageHistoryCookie: PAGE_HISTORY_COOKIE,
    pageHistoryCookieAge,
    findNotepadById,
    broadcastUpdate,
    scheduleIndexNotepads
});

registerNotepadRoutes(app, {
    storage,
    baseUrl: BASE_URL,
    nodeEnv: NODE_ENV,
    pageHistoryCookie: PAGE_HISTORY_COOKIE,
    pageHistoryCookieAge,
    loadNotepadsList,
    generateUniqueName,
    findNotepadById,
    broadcastUpdate,
    scheduleIndexNotepads
});

registerSearchRoutes(app, {
    searchNotepads
});

// Helper function to find a notepad by ID
async function findNotepadById(id) {
    try {
        const data = await storage.readNotepadsMeta();
        const notepad = data.notepads.find(n => n.id === id);
        return { data, notepad };
    } catch (err) {
        throw new Error(`Error reading notepads file: ${err.message}`);
    }
}
