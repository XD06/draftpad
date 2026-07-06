function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Strip dangerous HTML from marked output. marked v15 does not sanitize raw
// HTML, so user-supplied <script>/<iframe>/on* handlers would otherwise
// execute on the public (unauthenticated) share page. Defense-in-depth alongside CSP.
const DANGEROUS_TAGS = /<\/?(script|iframe|object|embed|form|input|button|textarea|select|option|link|meta|style|base|svg|math)\b[^>]*>/gi;
const ON_ATTRS = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DANGEROUS_ATTRS = /\s+(?:srcdoc|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_PROTO = /((?:href|src|action|formaction|data|xlink:href)\s*=\s*)("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi;
function sanitizeHtml(html) {
    return String(html == null ? '' : html)
        .replace(DANGEROUS_TAGS, '')
        .replace(ON_ATTRS, '')
        .replace(DANGEROUS_ATTRS, '')
        .replace(JS_PROTO, '$1""');
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

            // --- PHASE 2: Markdown Parsing + Sanitize ---
            // Sanitize before rehydrating tokens: the @@MARK_TOKEN_n@@ placeholders
            // are plain text so they survive sanitization, and the trusted badge SVG
            // is generated afterwards in Phase 3 (so it is not stripped).
            let htmlBody = sanitizeHtml(marked.parse(textForMarked));

            // --- PHASE 3: Rehydrate Tokens ---
            htmlBody = htmlBody.replace(/@@MARK_TOKEN_(\d+)@@/g, (match, idStr) => {
                let m = marks[parseInt(idStr, 10)];
                if (!m) return match;

                if (m.type === 'annotation' || m.type === 'annotation_legacy') {
                    const comment = encodeURIComponent(m.type === 'annotation' ? m.groups[0] : m.groups[1]);
                    const textInner = escapeHtml(m.type === 'annotation' ? m.groups[1] : m.groups[0]);
                    const badge = `<span class="annotation-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>`;
                    const decoded = escapeHtml(decodeURIComponent(comment));
                    const note = decoded ? `<span class="annotation-note">（${decoded}）</span>` : '';
                    return `<span class="has-annotation" data-comment="${comment}"><span style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">${textInner}</span>${badge}${note}</span>`;
                } else if (m.type === 'highlight') {
                    return `<span style="text-decoration:underline blue;text-decoration-thickness:2px;">${escapeHtml(m.groups[0])}</span>`;
                } else if (m.type === 'mark') {
                    return `<mark class="md-mark">${escapeHtml(m.groups[0])}</mark>`;
                }
                return match;
            });

            const htmlContent = `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHtml(notepad.name)} - DumbPad Shared</title>
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
            <h1 class="shared-title">${escapeHtml(notepad.name)}</h1>
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
            const escapeHtmlClient = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
            let currentPopover = null;
            document.addEventListener('click', (e) => {
                const annotation = e.target.closest('.has-annotation');
                if (currentPopover) {
                    currentPopover.remove();
                    currentPopover = null;
                }
                if (annotation) {
                    const comment = escapeHtmlClient(decodeURIComponent(annotation.dataset.comment));
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
    
}

module.exports = { registerShareRoutes };
