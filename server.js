require('dotenv').config();
const express = require('express');
const { marked } = require('marked');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const WebSocket = require('ws');
const Fuse = require('fuse.js');
const { generatePWAManifest } = require("./scripts/pwa-manifest-generator")
const { originValidationMiddleware, getCorsOptions, validateOrigin } = require('./scripts/cors');
const { getHighlightLanguages } = require('./constants');
const { 
    sanitizeFilename, 
    getNotepadFilePath, 
    migrateAllNotepadsToNameBasedFiles, 
    migrateDefaultNotepad 
} = require('./scripts/notepad-migration');
const { TRUST_PROXY, TRUSTED_PROXY_IPS } = require('./config');
const { getClientIp } = require('./utils/ipExtractor');
const storage = require('./scripts/storage');
const aiQueue = require('./scripts/ai-queue');
const s3PrefixTools = require('./scripts/s3-prefix-tools');
const localToS3Migration = require('./scripts/migrate-local-to-s3');
const s3Service = require('./scripts/s3-service');
const { registerDataManagementRoutes } = require('./routes/data-management-routes');
const ipaddr = require('ipaddr.js');
const HIGHLIGHT_LANGUAGES = process.env.HIGHLIGHT_LANGUAGES
    ? process.env.HIGHLIGHT_LANGUAGES.split(',').map(lang => lang.trim())
    : getHighlightLanguages();

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

function getShareToken(id) {
    return crypto.createHmac('sha256', SHARE_SECRET).update(id).digest('hex').substring(0, 16);
}

let notepads_cache = {
    documents: [],
    index: null,
};
let indexTimer = null;
let indexingPromise = null;
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

function getBuildVersion() {
    try {
        const hash = crypto
            .createHash('sha1')
            .update(collectPublicAssetStats(PUBLIC_DIR).sort().join('|'))
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

// Dynamic service worker with correct version (must be before static middleware)
app.get('/service-worker.js', async (req, res) => {
    // Set proper MIME type and cache headers to prevent caching
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    try {
        let swContent = await fs.readFile(path.join(PUBLIC_DIR, 'service-worker.js'), 'utf8');
        
        // Replace the version initialization with the actual version from package.json
        swContent = swContent.replace(
            /let APP_VERSION = ".*?";/,
            `let APP_VERSION = "${BUILD_VERSION}";`
        );
        
        res.send(swContent);
    } catch (error) {
        console.error('Error reading service-worker.js:', error);
        res.status(500).send('Error loading service worker');
    }
});

app.use(express.static(path.join(__dirname, 'public'), {
    index: false
}));

// Set up WebSocket server
const wss = new WebSocket.Server({ server, verifyClient: (info, done) => {
    const origin = info.req.headers.origin;
    const isOriginValid = validateOrigin(origin);
    if (isOriginValid) done(true); // allow the connection
    else {
        console.warn("Blocked connection from origin:", {origin});
        done(false, 403, 'Forbidden'); // reject the connection
    }
}});

// Store all active lightweight WebSocket connections.
const clients = new Map();

function broadcastWebSocketMessage(message) {
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

aiQueue.init({ storage, broadcast: broadcastWebSocketMessage });
setTimeout(() => {
    aiQueue.recoverStalePendingMeta()
        .catch(error => console.warn('[thought-ai] pending recovery failed:', error.message));
}, 1000);

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');
    const clientId = crypto.randomUUID();
    clients.set(clientId, ws);
    let userId = null;

    // Handle incoming messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (DEBUG_WS) console.log('Received WebSocket message:', {
                type: data.type,
                userId: data.userId,
                notepadId: data.notepadId,
                contentLength: typeof data.content === 'string' ? data.content.length : undefined
            });
            if (data.userId && !userId) userId = data.userId;

            if (data.type === 'update' && data.notepadId) {
                if (DEBUG_WS) console.log('Content update from user:', userId, 'notepad:', data.notepadId);
                clients.forEach((client, clientId) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'notes_update',
                            notepadId: data.notepadId,
                            content: data.content,
                            userId: data.userId
                        }));
                    }
                });
            }
            else if (['thoughts_update', 'notes_update', 'relations_update', 'notepad_change'].includes(data.type)) {
                if (DEBUG_WS) console.log('Broadcasting lightweight message type:', data.type);
                clients.forEach((client, clientId) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    // Handle client disconnection
    ws.on('close', () => {
        clients.delete(clientId);
        if (DEBUG_WS) console.log('WebSocket client disconnected:', userId || clientId);
    });
});

// Helper function to broadcast content updates to all connected clients
function broadcastUpdate(notepadId, content, senderId = 'api') {
    clients.forEach((client, clientId) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'notes_update',
                notepadId: notepadId,
                content: content,
                userId: senderId
            }));
        }
    });
}


// Brute force protection
const loginAttempts = new Map();
const MAX_ATTEMPTS = process.env.MAX_ATTEMPTS || 5; // default to 5
const LOCKOUT_TIME = process.env.LOCKOUT_TIME || 15; // default 15 minutes
const lockOutTime = LOCKOUT_TIME * 60 * 1000; // in milliseconds

// Reset attempts for an IP
function resetAttempts(ip) {
    loginAttempts.delete(ip);
}

// Check if an IP is locked out
function isLockedOut(ip) {
    const attempts = loginAttempts.get(ip);
    if (!attempts) return false;
    
    if (attempts.count >= MAX_ATTEMPTS) {
        const timeElapsed = Date.now() - attempts.lastAttempt;
        if (timeElapsed < lockOutTime) {
            return true;
        }
        resetAttempts(ip);
    }
    return false;
}

// Record an attempt for an IP
function recordAttempt(ip) {
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count += 1;
    attempts.lastAttempt = Date.now();
    loginAttempts.set(ip, attempts);
}

// Cleanup old lockouts periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts.entries()) {
        if (now - attempts.lastAttempt >= lockOutTime) {
            loginAttempts.delete(ip);
        }
    }
}, 60000); // Clean up every minute

// Validate PIN format
function isValidPin(pin) {
    return typeof pin === 'string' && /^\d{4,10}$/.test(pin);
}

// Constant-time string comparison to prevent timing attacks
function secureCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    
    // Use Node's built-in constant-time comparison
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (err) {
        return false;
    }
}

// Main app route with PIN & CORS check
app.get('/', originValidationMiddleware, (req, res) => {
    const pin = process.env.DUMBPAD_PIN;
    
    // Skip PIN if not configured
    if (!pin || !isValidPin(pin)) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }

    // Check PIN cookie
    const authCookie = req.cookies[COOKIE_NAME];
    if (!authCookie || !secureCompare(authCookie, pin)) {
        // Preserve the original URL with query parameters
        const originalUrl = req.originalUrl;
        const redirectParam = encodeURIComponent(originalUrl);
        return res.redirect(`/login?redirect=${redirectParam}`);
    }

    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the pwa/asset manifest
app.get("/asset-manifest.json", (req, res) => {
    // generated in pwa-manifest-generator and fetched from service-worker.js
    res.sendFile(path.join(ASSETS_DIR, "asset-manifest.json"));
});
app.get("/manifest.json", (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, "manifest.json"));
});

// Helper function to validate redirect URLs for security
function isValidRedirectUrl(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }
    
    // Must start with "/" (relative path)
    if (!url.startsWith('/')) {
        return false;
    }
    
    // Must not start with "//" (protocol-relative URL that could redirect externally)
    if (url.startsWith('//')) {
        return false;
    }
    
    // Must not contain backslashes (could be used for bypasses)
    if (url.includes('\\')) {
        return false;
    }
    
    // Must not contain encoded characters that could be used for bypasses
    if (url.includes('%2f') || url.includes('%2F') || url.includes('%5c') || url.includes('%5C')) {
        return false;
    }
    
    return true;
}

// Login page route
app.get('/login', (req, res) => {
    // If no PIN is required or user is already authenticated, redirect to main app
    const pin = process.env.DUMBPAD_PIN;
    if (!pin || !isValidPin(pin) || (req.cookies[COOKIE_NAME] && secureCompare(req.cookies[COOKIE_NAME], pin))) {
        // If user is already authenticated, redirect to the original URL if provided
        const redirectParam = req.query.redirect;
        if (redirectParam) {
            const decodedRedirect = decodeURIComponent(redirectParam);
            if (isValidRedirectUrl(decodedRedirect)) {
                return res.redirect(decodedRedirect);
            } else {
                console.warn('Invalid redirect parameter blocked:', redirectParam);
                return res.redirect('/');
            }
        }
        return res.redirect('/');
    }
    
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Pin verification endpoint
app.post('/api/verify-pin', (req, res) => {
    const { pin } = req.body;
    
    // If no PIN is set in env, always return success
    if (!PIN) {
        return res.json({ success: true });
    }

    const ip = getClientIp(req);
    
    // Security: Validate that we have a valid client IP for rate-limiting
    // Reject requests with null IPs to prevent shared rate-limit counter exploitation
    if (!ip) {
        console.error('Unable to determine client IP address for rate-limiting');
        return res.status(500).json({ error: 'Unable to determine client IP address' });
    }
    
    // Check if IP is locked out
    if (isLockedOut(ip)) {
        const attempts = loginAttempts.get(ip);
        const timeLeft = Math.ceil((lockOutTime - (Date.now() - attempts.lastAttempt)) / 1000 / 60);
        return res.status(429).json({ 
            error: `Too many attempts. Please try again in ${timeLeft} minute(s).`
        });
    }

    // Validate PIN format
    if (!isValidPin(pin)) {
        recordAttempt(ip);
        return res.status(400).json({ success: false, error: 'Invalid PIN format' });
    }

    // Verify the PIN using constant-time comparison
    if (pin && secureCompare(pin, PIN)) {
        // Reset attempts on successful login
        resetAttempts(ip);

        // Set secure HTTP-only cookie
        res.cookie(COOKIE_NAME, pin, {
            httpOnly: true,
            secure: req.secure || (BASE_URL.startsWith("https") && NODE_ENV === 'production'),
            sameSite: 'strict',
            maxAge: cookieMaxAge
        });
        res.json({ success: true });
    } else {
        // Record failed attempt
        recordAttempt(ip);
        
        const attempts = loginAttempts.get(ip);
        const attemptsLeft = MAX_ATTEMPTS - attempts.count;
        
        res.status(401).json({ 
            success: false, 
            error: 'Invalid PIN',
            attemptsLeft: Math.max(0, attemptsLeft)
        });
    }
});

// Check if PIN is required
app.get('/api/pin-required', (req, res) => {
    const ip = getClientIp(req);
    
    // Security: Validate that we have a valid client IP for rate-limiting
    // If IP is null, fail-secure by treating the client as locked out
    if (!ip) {
        console.error('SECURITY: Unable to determine client IP address for /api/pin-required endpoint - treating as locked');
    }
    
    res.json({ 
        required: !!PIN && isValidPin(PIN),
        length: PIN ? PIN.length : 0,
        locked: ip ? isLockedOut(ip) : true
    });
});

// Get site configuration
app.get('/api/config', (req, res) => {
    res.json({
        siteTitle: SITE_TITLE,
        baseUrl: process.env.BASE_URL,
        version: BUILD_VERSION,
        highlightLanguages: HIGHLIGHT_LANGUAGES,
    });
});

// Pin protection middleware
const requirePin = (req, res, next) => {
    // Check for PIN in Authorization header first (for API calls)
    if (PIN) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            if (secureCompare(token, PIN)) {
                return next();
            }
        }
    }

    if (!PIN || !isValidPin(PIN)) {

        return next();
    }

    const authCookie = req.cookies[COOKIE_NAME];
    if (!authCookie || !secureCompare(authCookie, PIN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Apply pin protection to all /api routes except pin verification
app.use('/api', (req, res, next) => {
    if (req.path === '/verify-pin' || req.path === '/pin-required' || req.path === '/config') {
        return next();
    }
    requirePin(req, res, next);
});

// Secure Sharing API
app.get('/api/share/:id', (req, res) => {
    const { id } = req.params;
    const token = getShareToken(id);
    const shareUrl = `${BASE_URL}/s/${id}?t=${token}`;
    res.json({ shareUrl });
});

// Public Share Route (Read-only)
app.get('/s/:id', async (req, res) => {
    const { id } = req.params;
    const { t } = req.query;

    if (!t || t !== getShareToken(id)) {
        return res.status(403).send('<h1>Invalid or expired share link.</h1>');
    }

    try {
        const data = await storage.readNotepadsMeta();
        const notepad = data.notepads.find(n => n.id === id);
        if (!notepad) return res.status(404).send('<h1>Notepad not found.</h1>');

        const content = await storage.readNoteContent(notepad);

        // --- PHASE 1: Tokenize Special Marks (Matches HybridMarkdownEditor logic) ---
        let marks = [];
        let textForMarked = content;
        
        const replaceMark = (regex, type) => {
            textForMarked = textForMarked.replace(regex, (match, ...groups) => {
                let id = marks.length;
                marks.push({ type, raw: match, groups });
                return `@@MARK_TOKEN_${id}@@`;
            });
        };

        replaceMark(/<mark note="([^"]+)">(.+?)<\/mark>/g, 'annotation');
        replaceMark(/==(.+?)==\{(?:用户批注:\s*)?(.*?)\}/g, 'annotation_legacy');
        replaceMark(/==(.+?)==/g, 'highlight');
        replaceMark(/<mark>(.+?)<\/mark>/g, 'mark');

        // --- PHASE 2: Markdown Parsing ---
        let htmlBody = marked.parse(textForMarked);

        // --- PHASE 3: Rehydrate Tokens ---
        htmlBody = htmlBody.replace(/@@MARK_TOKEN_(\d+)@@/g, (match, idStr) => {
            let m = marks[parseInt(idStr, 10)];
            if (!m) return match;

            if (m.type === 'annotation' || m.type === 'annotation_legacy') {
                const comment = encodeURIComponent(m.type === 'annotation' ? m.groups[0] : m.groups[1]);
                const textInner = m.type === 'annotation' ? m.groups[1] : m.groups[0];
                const badge = `<span class="annotation-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>`;
                const decoded = decodeURIComponent(comment);
                const note = decoded ? `<span class="annotation-note">（${decoded}）</span>` : '';
                return `<span class="has-annotation" data-comment="${comment}"><span style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">${textInner}</span>${badge}${note}</span>`;
            } else if (m.type === 'highlight') {
                return `<span style="text-decoration:underline blue;text-decoration-thickness:2px;">${m.groups[0]}</span>`;
            } else if (m.type === 'mark') {
                return `<mark class="md-mark">${m.groups[0]}</mark>`;
            }
            return match;
        });

        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${notepad.name} - DumbPad Shared</title>
    <link rel="stylesheet" href="/Assets/styles.css">
    <link rel="stylesheet" href="/Assets/preview-styles.css">
    <style>
        :root { --max-width: 760px; }
        
        /* AGGRESSIVE SCROLL LOCK REMOVAL */
        html, body { 
            overflow: visible !important; 
            height: auto !important; 
            position: static !important;
            background: #f8fafc !important; 
        }

        body { 
            padding: 40px 15px 120px !important; 
            max-width: var(--max-width); 
            margin: 0 auto; 
            color: #334155;
            line-height: 1.6;
            font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            -webkit-font-smoothing: antialiased;
        }

        .shared-card {
            background: #ffffff;
            border-radius: 12px;
            padding: 50px 70px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 10px 40px -10px rgba(0,0,0,0.02);
            border: 1px solid #e2e8f0;
        }

        .shared-title {
            font-size: 2.2rem;
            font-weight: 900;
            line-height: 1.25;
            margin-bottom: 40px;
            color: #0f172a;
            letter-spacing: -0.04em;
            text-align: left;
            border-bottom: 2px solid #f1f5f9;
            padding-bottom: 25px;
        }

        .markdown-body {
            font-size: 15.5px;
            color: #475569; /* Slightly muted for body */
            line-height: 1.75;
        }
        
        /* Heading Hierarchy */
        .markdown-body h1 { font-size: 1.8rem; color: #0f172a; margin-top: 2em; margin-bottom: 1em; font-weight: 800; }
        .markdown-body h2 { font-size: 1.5rem; color: #0f172a; margin-top: 1.8em; margin-bottom: 0.8em; font-weight: 800; }
        .markdown-body h3 { font-size: 1.25rem; color: #0f172a; margin-top: 1.6em; margin-bottom: 0.6em; font-weight: 800; }
        .markdown-body h4 { font-size: 1.1rem; color: #0f172a; margin-top: 1.4em; margin-bottom: 0.5em; font-weight: 800; }

        .markdown-body p { margin-bottom: 1.3em; }
        .markdown-body ul, .markdown-body ol { 
            padding-left: 1.4em; 
            margin-bottom: 1.5em; 
            color: #475569;
        }
        .markdown-body li { margin-bottom: 0.8em; }
        .markdown-body li > p { margin-bottom: 0.5em; }

        /* Annotation/Highlight consistency */
        .md-mark { background-color: #fcfdbf; color: #000; padding: 0 2px; border-radius: 2px; font-weight: 500; }
        .has-annotation { position: relative; cursor: default; }
        .annotation-note { color: #e74c3c; font-size: 0.72em; vertical-align: super; white-space: nowrap; }
        .annotation-badge { position: absolute; right: -18px; bottom: -10px; color: #ff4d4f; cursor: pointer; }

        /* Popover Styles (Read-only) */
        .shared-popover {
            position: absolute;
            background: rgba(255, 255, 255, 0.98);
            backdrop-filter: blur(25px);
            padding: 14px 18px;
            border-radius: 14px;
            border: 1px solid rgba(0,0,0,0.06);
            filter: drop-shadow(0 15px 35px rgba(0, 0, 0, 0.12));
            max-width: 340px;
            font-size: 14px;
            z-index: 1000;
            animation: popReveal 0.25s cubic-bezier(0.19, 1, 0.22, 1);
        }
        .shared-popover::after {
            content: ''; position: absolute; width: 10px; height: 10px; background: inherit;
            clip-path: polygon(50% 100%, 0 0, 100% 0); bottom: -9px; left: calc(50% - 5px);
        }
        @keyframes popReveal { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

        .watermark { 
            margin-top: 80px; text-align: center; color: #94a3b8; font-size: 13px; font-weight: 500;
        }
        .watermark a { color: var(--primary-color); text-decoration: none; font-weight: bold; }

        @media (max-width: 600px) {
            body { padding: 20px 10px !important; }
            .shared-card { padding: 35px 20px; border-radius: 8px; }
            .shared-title { font-size: 1.8rem; margin-bottom: 30px; }
        }
    </style>
</head>
<body data-theme="light">
    <div class="shared-card">
        <h1 class="shared-title">${notepad.name}</h1>
        <article class="markdown-body">
            ${htmlBody}
        </article>
        <footer class="watermark">
            PUBLISHED WITH <a href="/">DUMBPAD</a>
        </footer>
    </div>

    <script>
        // Theme sync
        const theme = localStorage.getItem('dumbpad_theme') ? JSON.parse(localStorage.getItem('dumbpad_theme')) : 'light';
        document.documentElement.setAttribute('data-theme', theme);

        // Read-only Popover logic
        let currentPopover = null;
        document.addEventListener('click', (e) => {
            const annotation = e.target.closest('.has-annotation');
            if (currentPopover) {
                currentPopover.remove();
                currentPopover = null;
            }
            if (annotation) {
                const comment = decodeURIComponent(annotation.dataset.comment);
                const popover = document.createElement('div');
                popover.className = 'shared-popover';
                popover.innerHTML = \`<div class="mark-popover-inline-content" style="display:flex;gap:10px;align-items:flex-start">
                    <div style="color:#ff4d4f;margin-top:2px;flex-shrink:0"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></div>
                    <div style="font-size:14px;line-height:1.6;color:#334155;white-space:pre-wrap;word-break:break-word">\${comment}</div>
                </div>\`;
                document.body.appendChild(popover);
                
                const rect = annotation.getBoundingClientRect();
                const popRect = popover.getBoundingClientRect();
                popover.style.left = (rect.left + rect.width/2 - popRect.width/2) + 'px';
                popover.style.top = (rect.top - popRect.height - 12 + window.scrollY) + 'px';
                currentPopover = popover;
                e.stopPropagation();
            }
        });
    </script>
</body>
</html>`;
        res.send(htmlContent);
    } catch (err) {
        console.error('Share rendering error:', err);
        res.status(500).send('<h1>Error rendering shared content.</h1>');
    }
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

    let needsSave = false;
    if (newNotepads.length > 0) {
        notepadsData.notepads = [...notepads, ...newNotepads];
        console.log(`Added new notepads: ${newNotepads.map(n => n.id).join(', ')}`);
        needsSave = true;
    }

    // Ensure all notepads have timestamps
    for (const notepad of notepadsData.notepads) {
        if (!notepad.createdAt || !notepad.updatedAt) {
            try {
                let filePath = await getNotepadFilePath(notepad, DATA_DIR);
                const stats = await fs.stat(filePath);
                notepad.createdAt = notepad.createdAt || Math.floor(stats.birthtimeMs || Date.now());
                notepad.updatedAt = notepad.updatedAt || Math.floor(stats.mtimeMs || Date.now());
            } catch (e) {
                notepad.createdAt = notepad.createdAt || Date.now();
                notepad.updatedAt = notepad.updatedAt || Date.now();
            }
            needsSave = true;
        }
    }

    if (needsSave) {
        await fs.writeFile(NOTEPADS_FILE, JSON.stringify(notepadsData, null, 2), 'utf8');
    }

    return notepadsData.notepads;
}

/* Notepad Search Functionality */
// Load and index text files
async function indexNotepads() {
    if (indexingPromise) return indexingPromise;
    console.log("Indexing search documents...");
    indexingPromise = (async () => {
    const items = await storage.getSearchDocuments();
    notepads_cache.documents = items;
    
    notepads_cache.index = new Fuse(items, { 
        keys: ["title", "content", "tags"],
        threshold: 0.38,        // lower thresholds mean stricter matching
        minMatchCharLength: 1,  // Ensures partial words can be matched
        ignoreLocation: true,    // Allows searching across larger texts
        includeScore: true,      // Useful for debugging relevance 
        includeMatches: true
    });

    // console.log(notepads_cache); // uncomment to debug
    console.log("Indexing complete. Search documents indexed:", notepads_cache.documents.length);
    indexingPromise = null;
    })().catch(error => {
        indexingPromise = null;
        console.error('Error indexing notepads:', error);
    });
    return indexingPromise;
}

function scheduleIndexNotepads(delay = 1500) {
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
        indexNotepads();
    }, delay);
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

// Search function using cache
async function searchNotepads(query) {
    if (!notepads_cache.index) await indexNotepads();
    if (!notepads_cache.index) return [];
    
    const results = notepads_cache.index.search(query).map(({ item }) => {
        const title = item.title || '';
        const content = item.content || '';
        const isFilenameMatch = title.toLowerCase().includes(query.toLowerCase());
        let truncatedContent = content;
        
        if (!isFilenameMatch) {
            const lowerContent = content.toLowerCase();
            const matchIndex = lowerContent.indexOf(query.toLowerCase());

            if (matchIndex !== -1) {
                let start = matchIndex;
                let end = matchIndex + query.length;

                // Move start back up to 3 spaces before
                let spaceCount = 0;
                while (start > 0 && spaceCount < 3) {
                    if (lowerContent[start] === ' ') spaceCount++;
                    start--;
                }
                start = Math.max(0, start); // Ensure start doesn't go negative

                // Move end forward until at least 25 characters are reached
                while (end < lowerContent.length && (end - start) < 25) {
                    end++;
                }

                // Extract snippet
                truncatedContent = content.substring(start, end).trim();
                // Add ellipsis to beginning if we truncated from somewhere
                if (start > 0) truncatedContent = `...${truncatedContent}`;
                // Add ellipsis to end if there is more content after the snippet
                if (end < content.length) truncatedContent = `${truncatedContent}...`;
            } else {
                truncatedContent = content.substring(0, 20).trim() + "..."; // Fallback if no match is found
            }
        }

        let truncatedName = title.substring(0, 20).trim();
        if(title.length >= 20) {
            truncatedName += "...";
        }

        return {
            id: item.id,
            type: item.type,
            title,
            name: isFilenameMatch ? truncatedName : (truncatedContent || content.substring(0, 50)),
            snippet: truncatedContent || "",
            matchType: isFilenameMatch ? "title" : "content"
        };
    });

    return results;
}

// Watch for changes in notepads.json or .txt files
fs.watch(DATA_DIR, (eventType, filename) => {
    if (filename && filename.endsWith(".txt")) scheduleIndexNotepads();
});
fs.watch(NOTEPADS_FILE, () => scheduleIndexNotepads());

// Migrate existing ID-based files to name-based files
(async () => {
    console.log('Checking for notepad files to migrate...');
    const notepads = await loadNotepadsList();
    await migrateAllNotepadsToNameBasedFiles(notepads, DATA_DIR);
    
    // Initial indexing after migration is complete
    indexNotepads();
})();

/* API Endpoints */
registerDataManagementRoutes(app, {
    storage,
    s3PrefixTools,
    localToS3Migration,
    s3Service
});

// Get list of notepads
app.get('/api/notepads', async (req, res) => {
    try {
        let notepadsList = await loadNotepadsList();
        
        // Filtering by title
        if (req.query.title) {
            const titleQuery = req.query.title.toLowerCase();
            notepadsList = notepadsList.filter(n => n.name.toLowerCase().includes(titleQuery));
        }

        // Sorting
        const sortBy = req.query.sortBy || 'updatedAt';
        const order = req.query.order === 'asc' ? 1 : -1;

        notepadsList.sort((a, b) => {
            const valA = a[sortBy] || 0;
            const valB = b[sortBy] || 0;
            if (typeof valA === 'string') {
                return valA.localeCompare(valB) * order;
            }
            return (valA - valB) * order;
        });

        // Return the existing cookie value along with notes
        const note_history = req.cookies.dumbpad_page_history || 'default';
        res.json({'notepads_list': notepadsList, 'note_history': note_history});
    } catch (err) {
        res.status(500).json({ error: 'Error reading notepads list' });
    }
});

// Create new notepad
app.post('/api/notepads', async (req, res) => {
    try {
        const { name, content } = req.body || {};
        await storage.init();

        const data = await storage.readNotepadsMeta();
        const id = Date.now().toString();
        const desiredName = name || `Notepad ${data.notepads.length + 1}`;
        const uniqueName = generateUniqueName(desiredName, data.notepads);
        
        const newNotepad = {
            id,
            name: uniqueName,
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        data.notepads.push(newNotepad);

        // Set new notes as the current page in cookies.
        res.cookie(PAGE_HISTORY_COOKIE, id, {
            httpOnly: true,
            secure: req.secure || (BASE_URL.startsWith("https") && NODE_ENV === 'production'),
            sameSite: 'strict',
            maxAge: pageHistoryCookieAge
        });

        await storage.saveNotepadsMeta(data);
        await storage.writeNoteContent(newNotepad, content || '');
        
        scheduleIndexNotepads(250); // update searching index
        res.json(newNotepad);
    } catch (err) {
        console.error('Error creating new notepad:', err);
        res.status(500).json({ error: 'Error creating new notepad' });
    }
});

// Direct file upload (Binary/Raw)
app.post('/api/upload', async (req, res) => {
    try {
        const filename = Buffer.from(req.headers['x-filename'] || `Upload-${Date.now()}.md`, 'latin1').toString('utf8');
        const name = filename.replace(/\.[^/.]+$/, ""); // Remove extension for title
        
        let body = [];
        req.on('data', (chunk) => body.push(chunk));
        req.on('end', async () => {
            try {
                const content = Buffer.concat(body).toString('utf8');
                
                const data = await storage.readNotepadsMeta();
                const id = Date.now().toString();
                const uniqueName = generateUniqueName(name, data.notepads);
                
                const newNotepad = {
                    id,
                    name: uniqueName,
                    version: 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                data.notepads.push(newNotepad);
                await storage.saveNotepadsMeta(data);
                await storage.writeNoteContent(newNotepad, content);
                
                broadcastUpdate(id, content);
                scheduleIndexNotepads(250);
                res.json(newNotepad);
            } catch (err) {
                console.error('Save upload error:', err);
                res.status(500).json({ error: 'Error saving uploaded content' });
            }
        });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Error uploading file' });
    }
});

// Rename notepad   
app.put('/api/notepads/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, baseVersion } = req.body;
        const { data, notepad } = await findNotepadById(id);
        if (!notepad) {
            return res.status(404).json({ error: 'Notepad not found' });
        }

        const clientVersion = Number(baseVersion);
        if (Number.isFinite(clientVersion) && (notepad.version || 1) > clientVersion) {
            return res.status(409).json({
                error: 'Notepad has been updated on another device',
                currentVersion: notepad.version || 1
            });
        }
        
        // Generate unique name (excluding current notepad from check)
        const otherNotepads = data.notepads.filter(n => n.id !== id);
        const uniqueName = generateUniqueName(name, otherNotepads);
        
        // Skip file renaming for default notepad - it should always remain default.txt
        const shouldRenameFile = id !== 'default' && notepad.name !== uniqueName;
        
        // Rename the file if needed (but skip for default notepad)
        if (shouldRenameFile) {
            try {
                await storage.renameNoteContent(notepad, { ...notepad, name: uniqueName });
            } catch (err) {
                console.warn(`Failed to rename notepad file for ${notepad.name}:`, err);
                // File rename failed - do not update the notepad name to maintain consistency
                return res.status(500).json({ error: 'Failed to rename notepad file. Please try a different name.' });
            }
        }
        
        notepad.name = uniqueName;
        notepad.updatedAt = Date.now();
        notepad.version = (notepad.version || 1) + 1;
        await storage.saveNotepadsMeta(data);
        scheduleIndexNotepads(250); // update searching index
        res.json({ ...notepad, nameChanged: uniqueName !== name });
    } catch (err) {
        res.status(500).json({ error: 'Error renaming notepad' });
    }
});

// Get notes for a specific notepad
app.get('/api/notes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Find the notepad to get its current name
        const { notepad } = await findNotepadById(id);
        
        let notes;
        if (notepad) {
            notes = await storage.readNoteContent(notepad);
        } else {
            // Fallback to ID-based path for backwards compatibility (sanitize id for security)
            const sanitizedId = sanitizeFilename(id);
            const notePath = path.join(DATA_DIR, `${sanitizedId}.txt`);
            notes = await fs.readFile(notePath, 'utf8').catch(() => '');
        }
        
        // Set loaded notes as the current page in cookies.
        res.cookie(PAGE_HISTORY_COOKIE, id, {
            httpOnly: true,
            secure: req.secure || (BASE_URL.startsWith("https") && NODE_ENV === 'production'),
            sameSite: 'strict',
            maxAge: pageHistoryCookieAge
        });

        res.json({ content: notes, version: notepad?.version || 1 });
    } catch (err) {
        res.status(500).json({ error: 'Error reading notes' });
    }
});

// Save notes for a specific notepad
app.post('/api/notes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || id === 'undefined' || id === 'null') {
            return res.status(400).json({ error: 'Invalid notepad id' });
        }
        await storage.init();
        
        // Find the notepad to get its current name
        const { notepad } = await findNotepadById(id);
        const clientVersion = Number(req.body.baseVersion);
        if (notepad && Number.isFinite(clientVersion) && (notepad.version || 1) > clientVersion) {
            return res.status(409).json({
                error: 'Notepad has been updated on another device',
                currentVersion: notepad.version || 1
            });
        }
        
        if (!notepad) {
            // Fallback to ID-based path for backwards compatibility (sanitize id for security)
            const sanitizedId = sanitizeFilename(id);
            const notePath = path.join(DATA_DIR, `${sanitizedId}.txt`);
            await fs.writeFile(notePath, req.body.content);
        } else {
            await storage.writeNoteContent(notepad, req.body.content);
        }
        
        const content = req.body.content;
        const senderId = req.body.userId || 'api';

        // Update notepad updatedAt timestamp
        const data = await storage.readNotepadsMeta();
        const targetNotepad = data.notepads.find(n => n.id === id);
        if (targetNotepad) {
            targetNotepad.updatedAt = Date.now();
            if (!targetNotepad.createdAt) targetNotepad.createdAt = Date.now();
            targetNotepad.version = (targetNotepad.version || 1) + 1;
            await storage.saveNotepadsMeta(data);
        }

        broadcastUpdate(id, content, senderId);
        scheduleIndexNotepads(); // update searching index
        res.json({ success: true, version: targetNotepad?.version || 1 });
    } catch (err) {
        res.status(500).json({ error: 'Error saving notes' });
    }
});
// Patch notes (append, prepend, replace)
app.patch('/api/notes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { action, text, target, replacement, userId, baseVersion } = req.body;
        const senderId = userId || 'api';
        
        const { notepad } = await findNotepadById(id);
        if (!notepad) {
            return res.status(404).json({ error: 'Notepad not found' });
        }

        const clientVersion = Number(baseVersion);
        if (Number.isFinite(clientVersion) && (notepad.version || 1) > clientVersion) {
            return res.status(409).json({
                error: 'Notepad has been updated on another device',
                currentVersion: notepad.version || 1
            });
        }
        
        let content = await storage.readNoteContent(notepad);
        
        let modified = false;
        switch (action) {
            case 'append':
                if (text !== undefined) {
                    content += text;
                    modified = true;
                }
                break;
            case 'prepend':
                if (text !== undefined) {
                    content = text + content;
                    modified = true;
                }
                break;
            case 'replace':
                if (target) {
                    if (content.includes(target)) {
                        content = content.split(target).join(replacement || '');
                        modified = true;
                    } else {
                        return res.status(400).json({ 
                            success: false, 
                            error: 'Target text not found in document',
                            target: target
                        });
                    }
                } else {
                    return res.status(400).json({ success: false, error: 'Replace action requires a non-empty target' });
                }
                break;
            case 'replace_first':
                if (target) {
                    if (content.includes(target)) {
                        content = content.replace(target, replacement || '');
                        modified = true;
                    } else {
                        return res.status(400).json({ success: false, error: 'Target text not found' });
                    }
                }
                break;
            case 'overwrite':
                content = text || '';
                modified = true;
                break;
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        
        if (modified) {
            await storage.writeNoteContent(notepad, content);
            
            // Update updatedAt
            const data = await storage.readNotepadsMeta();
            const targetNotepad = data.notepads.find(n => n.id === id);
            let savedVersion = notepad.version || 1;
            if (targetNotepad) {
                targetNotepad.updatedAt = Date.now();
                targetNotepad.version = (targetNotepad.version || 1) + 1;
                savedVersion = targetNotepad.version;
                await storage.saveNotepadsMeta(data);
            }
            
            broadcastUpdate(id, content, senderId);
            scheduleIndexNotepads();
            return res.json({ success: true, content, modified, version: savedVersion });
        }
        
        res.json({ success: true, content, modified, version: notepad.version || 1 });
    } catch (err) {
        console.error('Error patching notes:', err);
        res.status(500).json({ error: 'Error patching notes' });
    }
});


// Delete notepad
// --- Quick Thoughts API ---

async function readThoughts() {
    return storage.readThoughts();
}

async function saveThoughts(thoughts) {
    await storage.saveThoughts(thoughts);
}

function broadcastThoughtsUpdate(action, payload) {
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'thoughts_update',
                action,
                payload
            }));
        }
    });
}

app.get('/api/thoughts/:id/relations', async (req, res) => {
    try {
        const { id } = req.params;
        const thought = await storage.readThought(id);
        if (!thought) {
            return res.json({
                id,
                status: 'missing',
                relations: []
            });
        }

        const meta = await storage.readThoughtMeta(id);
        const relations = await storage.readRelations(id);
        const responseRelations = [];
        const responseSuggestions = [];

        async function edgeToResponse(edge) {
            const target = await storage.readThought(edge.targetId);
            if (!target) return null;
            return {
                thought: {
                    id: target.id,
                    text: target.text || '',
                    tags: Array.isArray(target.tags) ? target.tags : [],
                    completed: !!target.completed,
                    createdAt: target.createdAt || 0
                },
                score: edge.score || 0,
                confidence: edge.confidence || 0,
                relationType: edge.relationType || '',
                method: edge.method || 'unknown',
                reasons: Array.isArray(edge.reasons) ? edge.reasons : [],
                signals: edge.signals || null
            };
        }

        for (const edge of relations.edges || []) {
            const item = await edgeToResponse(edge);
            if (item) responseRelations.push(item);
        }

        for (const edge of relations.suggestions || []) {
            const item = await edgeToResponse(edge);
            if (item) responseSuggestions.push(item);
        }

        res.json({
            id,
            status: meta?.status || 'missing',
            relations: responseRelations,
            suggestions: responseSuggestions
        });
    } catch (err) {
        console.error('Error fetching thought relations:', err);
        res.status(500).json({ error: 'Error fetching thought relations' });
    }
});

app.delete('/api/thoughts/:id/relations/:targetId', async (req, res) => {
    try {
        const { id, targetId } = req.params;
        const result = await withRelationWriteLock(async () => {
            const relations = await storage.readRelations(id);
            const originalLength = Array.isArray(relations.edges) ? relations.edges.length : 0;
            relations.edges = (relations.edges || []).filter(edge => edge.targetId !== targetId);
            relations.suggestions = (relations.suggestions || []).filter(edge => edge.targetId !== targetId);
            relations.computedAt = Date.now();
            await storage.writeRelations(id, relations);

            const reverse = await storage.readRelations(targetId);
            reverse.edges = (reverse.edges || []).filter(edge => edge.targetId !== id);
            reverse.suggestions = (reverse.suggestions || []).filter(edge => edge.targetId !== id);
            reverse.computedAt = Date.now();
            await storage.writeRelations(targetId, reverse);
            await storage.suppressRelation(id, targetId);
            await storage.suppressRelation(targetId, id);

            return {
                success: true,
                removed: relations.edges.length !== originalLength
            };
        });
        res.json(result);
    } catch (err) {
        console.error('Error deleting thought relation:', err);
        res.status(500).json({ error: 'Error deleting thought relation' });
    }
});

async function removeSuppressedPair(id, targetId) {
    const sourceSuppressed = await storage.readSuppressedRelations(id);
    sourceSuppressed.edges = (sourceSuppressed.edges || []).filter(edge => edge.targetId !== targetId);
    await storage.writeSuppressedRelations(id, sourceSuppressed);

    const targetSuppressed = await storage.readSuppressedRelations(targetId);
    targetSuppressed.edges = (targetSuppressed.edges || []).filter(edge => edge.targetId !== id);
    await storage.writeSuppressedRelations(targetId, targetSuppressed);
}

async function withRelationWriteLock(task) {
    const lock = aiQueue._private?.withRelationWriteLock;
    return typeof lock === 'function' ? lock(task) : task();
}

function upsertManualEdge(relations, targetId, relationType = 'manual') {
    const now = Date.now();
    const edges = Array.isArray(relations.edges) ? relations.edges.filter(edge => edge.targetId !== targetId) : [];
    const suggestions = Array.isArray(relations.suggestions)
        ? relations.suggestions.filter(edge => edge.targetId !== targetId)
        : [];
    edges.unshift({
        targetId,
        score: 1,
        confidence: 1,
        relationType,
        method: 'manual',
        source: 'manual',
        reasons: ['manual'],
        signals: { manual: 1 },
        createdAt: now
    });
    return {
        id: relations.id,
        edges,
        suggestions,
        version: 2,
        computedAt: now
    };
}

app.post('/api/thoughts/:id/relations', async (req, res) => {
    try {
        const { id } = req.params;
        const targetId = String(req.body?.targetId || '').trim();
        const relationType = String(req.body?.relationType || 'manual').trim() || 'manual';
        if (!targetId) return res.status(400).json({ error: 'targetId is required' });
        if (targetId === id) return res.status(400).json({ error: 'Cannot link a thought to itself' });

        const sourceThought = await storage.readThought(id);
        const targetThought = await storage.readThought(targetId);
        if (!sourceThought || !targetThought) return res.status(404).json({ error: 'Thought not found' });

        const { sourceRelations, targetRelations } = await withRelationWriteLock(async () => {
            const sourceRelations = upsertManualEdge(await storage.readRelations(id), targetId, relationType);
            const targetRelations = upsertManualEdge(await storage.readRelations(targetId), id, relationType);
            await storage.writeRelations(id, sourceRelations);
            await storage.writeRelations(targetId, targetRelations);
            await removeSuppressedPair(id, targetId);
            return { sourceRelations, targetRelations };
        });

        broadcastWebSocketMessage({
            type: 'relations_update',
            thoughtId: id,
            relationsCount: sourceRelations.edges.length
        });
        broadcastWebSocketMessage({
            type: 'relations_update',
            thoughtId: targetId,
            relationsCount: targetRelations.edges.length
        });

        res.status(201).json({
            success: true,
            relation: sourceRelations.edges.find(edge => edge.targetId === targetId),
            relationCount: sourceRelations.edges.length
        });
    } catch (err) {
        console.error('Error creating manual thought relation:', err);
        res.status(500).json({ error: 'Error creating manual thought relation' });
    }
});

app.post('/api/thoughts/:id/ai-process', async (req, res) => {
    const { id } = req.params;
    const thought = await storage.readThought(id);
    if (!thought) return res.status(404).json({ error: 'Thought not found' });

    console.info(`[thought-ai] queue reason=manual thoughtId=${id}`);
    aiQueue.queueThought(id, 'manual');
    res.status(202).json({ queued: true, id });
});

app.post('/api/thoughts/ai-backfill', async (req, res) => {
    try {
        const limit = Number(req.body?.limit);
        const result = await aiQueue.backfillMissingMeta({
            limit: Number.isFinite(limit) && limit > 0 ? limit : Infinity
        });
        res.status(202).json(result);
    } catch (err) {
        console.error('Error queueing AI backfill:', err);
        res.status(500).json({ error: 'Error queueing AI backfill' });
    }
});

app.post('/api/thoughts/relations-rebuild', async (req, res) => {
    try {
        const limit = Number(req.body?.limit);
        const result = await aiQueue.rebuildRelations({
            limit: Number.isFinite(limit) && limit > 0 ? limit : Infinity
        });
        res.status(202).json(result);
    } catch (err) {
        console.error('Error rebuilding thought relations:', err);
        res.status(500).json({ error: 'Error rebuilding thought relations' });
    }
});

app.get('/api/thoughts/ai-queue/status', async (req, res) => {
    try {
        res.json(aiQueue.getQueueStatus());
    } catch (err) {
        console.error('Error fetching AI queue status:', err);
        res.status(500).json({ error: 'Error fetching AI queue status' });
    }
});

app.get('/api/thoughts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const thoughts = await readThoughts();
        const thought = thoughts.find(t => t.id === id);
        if (!thought) return res.status(404).json({ error: 'Thought not found' });
        res.json(thought);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching thought' });
    }
});

app.get('/api/thoughts', async (req, res) => {
    try {
        const { q, date, tag } = req.query;
        let thoughts = await readThoughts();
        
        if (tag) {
            const tagLower = tag.toLowerCase();
            thoughts = thoughts.filter(t => t.tags && t.tags.some(tg => tg.toLowerCase() === tagLower));
        }
        
        if (q) {
            const query = q.toLowerCase();
            thoughts = thoughts.filter(t => {
                if (t.text.toLowerCase().includes(query)) return true;
                if (t.subItems && t.subItems.some(s => s.text.toLowerCase().includes(query))) return true;
                return false;
            });
        }
        
        if (date) {
            thoughts = thoughts.filter(t => {
                // Use a local-time aware date string (YYYY-MM-DD)
                const d = new Date(t.createdAt);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                return dateStr === date;
            });
        }
        
        const thoughtsWithRelationCounts = await Promise.all(thoughts.map(async (thought) => {
            const meta = await storage.readThoughtMeta(thought.id);
            return {
                ...thought,
                relationCount: await storage.readRelationCount(thought.id),
                aiStatus: meta?.status || 'missing',
                aiError: meta?.error || null,
                aiProcessedAt: meta?.ai?.processedAt || 0,
                aiTags: Array.isArray(meta?.ai?.tags) ? meta.ai.tags : []
            };
        }));

        res.json(thoughtsWithRelationCounts);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching thoughts' });
    }
});

app.post('/api/thoughts', async (req, res) => {
    try {
        const { text, subItems, tags, completed } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });
        
        const thoughts = await readThoughts();
        const newThought = {
            id: Date.now().toString(),
            text,
            subItems: subItems || [],
            tags: tags || [],
            completed: completed === true,
            relationCount: 0,
            aiStatus: 'pending',
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        
        thoughts.unshift(newThought);
        await saveThoughts(thoughts);
        scheduleIndexNotepads(250);
        
        broadcastThoughtsUpdate('create', newThought);
        console.info(`[thought-ai] queue reason=create thoughtId=${newThought.id}`);
        aiQueue.queueThought(newThought.id, 'create');
        res.json(newThought);
    } catch (err) {
        res.status(500).json({ error: 'Error creating thought' });
    }
});

app.get('/api/thoughts/:id/ai-status', async (req, res) => {
    try {
        const { id } = req.params;
        const thought = await storage.readThought(id);
        if (!thought) return res.status(404).json({ error: 'Thought not found' });

        const meta = await storage.readThoughtMeta(id);
        const relations = await storage.readRelations(id);
        const relationEdges = Array.isArray(relations.edges) ? relations.edges : [];
        const relationSuggestions = Array.isArray(relations.suggestions) ? relations.suggestions : [];
        const stages = meta?.stages || {
            queued: { status: meta ? 'ready' : 'missing' },
            analysis: { status: meta?.status === 'ready' ? 'ready' : (meta?.status || 'missing') },
            embedding: { status: meta?.status === 'ready' ? 'ready' : (meta?.status || 'missing') },
            relations: relations?.diagnostics?.status ? { status: relations.diagnostics.status } : { status: 'missing' }
        };
        res.json({
            id,
            status: meta?.status || 'missing',
            error: meta?.error || null,
            processedAt: meta?.ai?.processedAt || 0,
            relationCount: relationEdges.length,
            suggestionCount: relationSuggestions.length,
            aiTags: Array.isArray(meta?.ai?.tags) ? meta.ai.tags : [],
            stages,
            models: {
                extract: meta?.ai?.extractModel || stages.analysis?.model || null,
                embedding: meta?.ai?.model || stages.embedding?.model || null,
                rerank: stages.relations?.model || null
            },
            diagnostics: relations?.diagnostics || null
        });
    } catch (err) {
        console.error('Error fetching thought AI status:', err);
        res.status(500).json({ error: 'Error fetching thought AI status' });
    }
});

app.patch('/api/thoughts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { action, text, target, replacement, baseVersion } = req.body;
        const thoughts = await readThoughts();
        const index = thoughts.findIndex(t => t.id === id);
        
        if (index === -1) return res.status(404).json({ error: 'Thought not found' });
        
        const thought = thoughts[index];
        const clientVersion = Number(baseVersion);
        if (Number.isFinite(clientVersion) && (thought.version || 1) > clientVersion) {
            return res.status(409).json({
                error: 'Thought has been updated on another device',
                currentVersion: thought.version || 1
            });
        }
        let modified = false;
        
        switch (action) {
            case 'toggle_complete':
                thought.completed = !thought.completed;
                modified = true;
                break;
            case 'append':
                if (text) {
                    thought.text += text;
                    modified = true;
                }
                break;
            case 'replace':
                if (target && thought.text.includes(target)) {
                    thought.text = thought.text.split(target).join(replacement || '');
                    modified = true;
                }
                break;
            case 'overwrite':
                if (text !== undefined) { thought.text = text; modified = true; }
                if (req.body.subItems !== undefined) { thought.subItems = req.body.subItems; modified = true; }
                if (req.body.tags !== undefined) { thought.tags = req.body.tags; modified = true; }
                if (req.body.completed !== undefined) { thought.completed = req.body.completed === true; modified = true; }
                break;
            case 'add_subitem':
                if (!text) return res.status(400).json({ error: 'Subitem text is required' });
                thought.subItems.push({
                    id: Date.now().toString(),
                    text,
                    completed: false
                });
                modified = true;
                break;
            case 'toggle_subitem': {
                const sub = thought.subItems.find(s => s.id === req.body.subId);
                if (!sub) return res.status(404).json({ error: 'Subitem not found' });
                sub.completed = !sub.completed;
                modified = true;
                break;
            }
            case 'update_subitem': {
                const sub = thought.subItems.find(s => s.id === req.body.subId);
                if (!sub) return res.status(404).json({ error: 'Subitem not found' });
                if (text !== undefined) sub.text = text;
                if (req.body.completed !== undefined) sub.completed = req.body.completed;
                modified = true;
                break;
            }
            case 'delete_subitem': {
                const idx = thought.subItems.findIndex(s => s.id === req.body.subId);
                if (idx === -1) return res.status(404).json({ error: 'Subitem not found' });
                thought.subItems.splice(idx, 1);
                modified = true;
                break;
            }
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        
        if (modified) {
            thought.updatedAt = Date.now();
            thought.version = (thought.version || 1) + 1;
            await saveThoughts(thoughts);
            scheduleIndexNotepads(250);
            broadcastThoughtsUpdate('update', thought);
            console.info(`[thought-ai] queue reason=update thoughtId=${thought.id}`);
            aiQueue.queueThought(thought.id, 'update');
        }
        
        res.json({ success: true, thought });
    } catch (err) {
        res.status(500).json({ error: 'Error updating thought' });
    }
});

app.delete('/api/thoughts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let thoughts = await readThoughts();
        const initialLen = thoughts.length;
        thoughts = thoughts.filter(t => t.id !== id);
        
        if (thoughts.length !== initialLen) {
            await saveThoughts(thoughts);
            await storage.deleteThoughtMeta(id);
            await storage.deleteRelations(id);
            await storage.deleteSuppressedRelations(id);
            const relationCleanup = await storage.removeRelationReferences(id);
            await storage.removeSuppressedRelationReferences(id);
            scheduleIndexNotepads(250);
            broadcastThoughtsUpdate('delete', { id });
            const affectedRelationIds = Array.isArray(relationCleanup?.affectedIds) ? relationCleanup.affectedIds : [];
            for (const affectedId of affectedRelationIds) {
                broadcastWebSocketMessage({
                    type: 'relations_update',
                    thoughtId: affectedId,
                    relationsCount: await storage.readRelationCount(affectedId)
                });
            }
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Thought not found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error deleting thought' });
    }
});

app.delete('/api/notepads/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`Attempting to delete notepad with id: ${id}`);
        
        // Don't allow deletion of default notepad
        if (id === 'default') {
            console.log('Attempted to delete default notepad');
            return res.status(400).json({ error: 'Cannot delete default notepad' });
        }

        const { data, notepad } = await findNotepadById(id);
        console.log('Current notepads:', data.notepads);
        
        if (!notepad) {
            console.log(`Notepad with id ${id} not found`);
            return res.status(404).json({ error: 'Notepad not found' });
        }

        // Get the notepad before removing it
        const notepadToDelete = notepad;
        
        // Remove from notepads list
        const notepadIndex = data.notepads.findIndex(n => n.id === id);
        const removedNotepad = data.notepads.splice(notepadIndex, 1)[0];
        console.log(`Removed notepad:`, removedNotepad);
        
        // Save updated notepads list
        await storage.saveNotepadsMeta(data);
        console.log('Updated notepads list saved');

        await storage.deleteNoteContent(notepadToDelete);

        scheduleIndexNotepads(250); // update searching index
        res.json({ success: true, message: 'Notepad deleted successfully' });
    } catch (err) {
        console.error('Error in delete notepad endpoint:', err);
        res.status(500).json({ error: 'Error deleting notepad' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
}); 

/* Search API Endpoints */
// Search
app.get('/api/search', async (req, res) => {
    const query = req.query.query || req.query.q || '';
    const results = await searchNotepads(query);
    
    // set up for pagination
    const page = parseInt(req.query.page) || 1;
    const requestedPageSize = parseInt(req.query.pageSize);
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
        ? requestedPageSize
        : (results.length || 10); // defaults to all results, with a non-zero fallback for empty searches
    const paginatedResults = results.slice((page - 1) * pageSize, page * pageSize);
    res.json({
        results: paginatedResults,
        totalPages: results.length === 0 ? 0 : Math.ceil(results.length / pageSize),
        currentPage: page
    });
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
