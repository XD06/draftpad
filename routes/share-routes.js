const crypto = require('crypto');
const { renderSharePage } = require('../scripts/share-renderer');

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Strip dangerous HTML from marked output. marked v15 does not sanitize raw
// HTML, so user-supplied <script>/<iframe>/on* handlers or javascript: URLs
// would otherwise execute on the public (unauthenticated) share page. This is
// defense-in-depth alongside CSP.
//
// Two hardenings over a naive single-pass blacklist:
//   1. The tag/attribute strippers run to a fixpoint, so a payload cannot
//      smuggle a tag through a single pass (e.g. "<scr<script>ipt>" collapsing
//      into a fresh "<script>" that a one-shot replace would leave behind).
//   2. URL-bearing attributes are scheme-checked AFTER decoding HTML entities
//      and removing whitespace/control chars, so obfuscations such as
//      "javascript&#58;alert(1)" or "jav\tascript:alert(1)" are still caught.
const DANGEROUS_TAGS = /<\/?(script|iframe|object|embed|form|input|button|textarea|select|option|link|meta|style|base|svg|math)\b[^>]*>/gi;
const ON_ATTRS = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DANGEROUS_ATTRS = /\s+(?:srcdoc|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTRS = /\b(href|src|action|poster|background|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function decodeForSchemeCheck(value) {
    return String(value == null ? '' : value)
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; } })
        .replace(/&#(\d+);?/g, (_, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; } })
        .replace(/&colon;/gi, ':')
        .replace(/&(?:tab|newline);/gi, '')
        .replace(/[\u0000-\u0020\u00a0\u2028\u2029]+/g, '')
        .toLowerCase();
}

function isDangerousUrl(value) {
    const normalized = decodeForSchemeCheck(value);
    // Inline raster data images are safe (cannot execute); everything else on
    // the data:/blob:/file:/script scheme list is rejected.
    if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/.test(normalized)) return false;
    return /^(?:javascript|vbscript|data|file|blob):/.test(normalized);
}

function stripDangerousMarkup(html) {
    let current = html;
    let previous;
    let guard = 0;
    do {
        previous = current;
        current = current
            .replace(DANGEROUS_TAGS, '')
            .replace(ON_ATTRS, '')
            .replace(DANGEROUS_ATTRS, '');
        guard += 1;
    } while (current !== previous && guard < 30);
    return current;
}

function neutralizeUrls(html) {
    return html.replace(URL_ATTRS, (match, attr, _value, doubleQuoted, singleQuoted, unquoted) => {
        const raw = doubleQuoted != null ? doubleQuoted : (singleQuoted != null ? singleQuoted : (unquoted != null ? unquoted : ''));
        return isDangerousUrl(raw) ? `${attr}="#"` : match;
    });
}

function sanitizeHtml(html) {
    let out = stripDangerousMarkup(String(html == null ? '' : html));
    out = neutralizeUrls(out);
    // Re-run the tag strippers in case neutralization exposed a new boundary.
    return stripDangerousMarkup(out);
}

function registerShareRoutes(app, context) {
    const { storage, marked, baseUrl, getShareToken } = context;

    // Secure Sharing API
    app.get('/api/share/:id', (req, res) => {
        const { id } = req.params;
        const token = getShareToken(id);
        const shareUrl = `${baseUrl}/s/${id}?t=${token}`;
        res.json({ shareUrl });
    });

    // Public Share Route (Read-only)
    app.get('/s/:id', async (req, res) => {
        const { id } = req.params;
        const { t } = req.query;

        // Constant-time compare: the share token is the only thing guarding
        // this unauthenticated page, so it must not leak through a timing
        // side channel. Length differs only for malformed links.
        const expected = getShareToken(id);
        const provided = Array.isArray(t) ? String(t[0] || '') : String(t || '');
        const tokenValid = provided.length === expected.length
            && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        if (!tokenValid) {
            return res.status(403).send('<h1>Invalid or expired share link.</h1>');
        }

        try {
            const data = await storage.readNotepadsMeta();
            const notepad = data.notepads.find(n => n.id === id);
            if (!notepad) return res.status(404).send('<h1>Notepad not found.</h1>');

            const content = await storage.readNoteContent(notepad);
            const htmlContent = renderSharePage({ notepad, content, marked, sanitizeHtml });
            res.setHeader('Cache-Control', 'no-store');
            res.send(htmlContent);
        } catch (err) {
            console.error('Share rendering error:', err);
            res.status(500).send('<h1>Error rendering shared content.</h1>');
        }
    });
    
}

module.exports = { registerShareRoutes, sanitizeHtml, escapeHtml };
