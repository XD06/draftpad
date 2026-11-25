/**
 * Renders read-only shared notepad pages with isolated B+C hybrid styling.
 * Handles DumbPad inline marks, 3-state tasks, media sizing, and dark mode.
 * Keeps share HTML self-contained without leaking main editor stylesheets.
 */

const crypto = require('crypto');

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function decodeBasicEntities(str) {
    return String(str == null ? '' : str)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function maskCodeSegments(markdown, nonce) {
    const masked = [];
    const pushMask = (raw) => {
        const id = masked.length;
        masked.push(raw);
        return `@@CODE_${nonce}_${id}@@`;
    };

    // Mask fenced blocks first, then inline backtick spans, so custom mark
    // syntax shown inside code examples is never transformed.
    let text = String(markdown == null ? '' : markdown).replace(
        /(^|\n)([ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)|[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*$)/g,
        (match, prefix, fence) => `${prefix}${pushMask(fence)}`
    );

    text = text.replace(/(`+)([^\n`]|[^`\n][\s\S]*?[^`\n])\1/g, (match) => pushMask(match));
    return { text, masked };
}

function unmaskCodeSegments(text, masked, nonce) {
    const pattern = new RegExp(`@@CODE_${nonce}_(\\d+)@@`, 'g');
    return text.replace(pattern, (match, idStr) => {
        const idx = parseInt(idStr, 10);
        return masked[idx] !== undefined ? masked[idx] : match;
    });
}

function tokenizeDumbPadMarks(markdown, nonce) {
    const marks = [];
    const { text: codeSafe, masked } = maskCodeSegments(markdown, nonce);
    let textForMarked = codeSafe;

    const replaceMark = (regex, type, captureCount) => {
        textForMarked = textForMarked.replace(regex, (...args) => {
            const groups = args.slice(1, 1 + captureCount).map((g) => (
                g == null ? g : unmaskCodeSegments(g, masked, nonce)
            ));
            const id = marks.length;
            marks.push({ type, groups });
            return `@@MARK_${nonce}_${id}@@`;
        });
    };

    // Order matters: Tiptap/Vditor span[data-note], legacy <mark note>,
    // legacy ==text=={comment}, then plain ==highlight== and <mark>, then time chips.
    replaceMark(
        /<span\b[^>]*\bdata-note=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]+?)<\/span>(?:\s*<sub\b[^>]*>[\s\S]*?<\/sub>)?/gi,
        'annotation_span',
        3
    );
    replaceMark(/<mark\s+note=(?:"([^"]+)"|'([^']+)')>([\s\S]+?)<\/mark>/gi, 'annotation_attr', 3);
    replaceMark(/==([^\n=]+?)==\{(?:用户批注:\s*)?([^}]*)\}/g, 'annotation_legacy', 2);
    replaceMark(/==([^\n=]+?)==/g, 'highlight', 1);
    replaceMark(/<mark>([\s\S]+?)<\/mark>/gi, 'mark', 1);
    replaceMark(
        /\[\[time:(?:(create|update)(?:@([1-4]))?:)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\]/g,
        'time',
        3
    );

    textForMarked = unmaskCodeSegments(textForMarked, masked, nonce);
    return { textForMarked, marks };
}

function preprocessTaskLists(html, nonce) {
    // marked renders - [ ] / - [x] as <input type="checkbox">, which sanitizeHtml
    // strips along with arbitrary form inputs. Convert list task markers into
    // nonce tokens before sanitizeHtml, then rehydrate as safe <span> indicators.
    let out = String(html || '').replace(
        /(<li\b[^>]*>\s*(?:<p>)?)\s*<input\b([^>]*\btype=["']checkbox["'][^>]*)>\s*/gi,
        (_m, prefix, attrs) => {
            const isChecked = /\bchecked\b/i.test(attrs);
            return `${prefix}@@TASK_${nonce}_${isChecked ? 'DONE' : 'TODO'}@@`;
        }
    );

    out = out.replace(
        /(<li\b[^>]*>\s*(?:<p>)?)\s*\[~\]\s+/gi,
        (_m, prefix) => `${prefix}@@TASK_${nonce}_DOING@@`
    );

    return out;
}

function rehydrateTokens({ html, marks, nonce, marked, sanitizeHtml }) {
    const markPattern = new RegExp(`@@MARK_${nonce}_(\\d+)@@`, 'g');
    const renderSafeInner = (raw) => sanitizeHtml(marked.parseInline(String(raw == null ? '' : raw), { breaks: true, gfm: true }));

    let out = html.replace(markPattern, (match, idStr) => {
        const m = marks[parseInt(idStr, 10)];
        if (!m) return match;

        if (m.type === 'annotation_span' || m.type === 'annotation_attr' || m.type === 'annotation_legacy') {
            const rawComment = m.type === 'annotation_legacy'
                ? m.groups[1]
                : (m.groups[0] !== undefined ? m.groups[0] : m.groups[1]);
            const rawInner = m.type === 'annotation_legacy' ? m.groups[0] : m.groups[2];
            const commentText = decodeBasicEntities(rawComment || '');
            const encodedComment = encodeURIComponent(commentText);
            const innerHtml = renderSafeInner(rawInner);
            const badge = '<span class="annotation-badge" aria-label="查看批注"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>';
            return `<span class="has-annotation" tabindex="0" data-comment="${escapeHtml(encodedComment)}"><span class="ann-span">${innerHtml}</span>${badge}</span>`;
        }

        if (m.type === 'highlight' || m.type === 'mark') {
            return `<mark class="md-mark">${renderSafeInner(m.groups[0])}</mark>`;
        }

        if (m.type === 'time') {
            const kind = m.groups[0] === 'update' ? 'update' : 'create';
            const label = kind === 'update' ? '更新' : '创建';
            const stamp = escapeHtml(m.groups[2]);
            return `<span class="time-chip is-${kind}" title="${label}时间：${stamp}">${label} ${stamp}</span>`;
        }

        return match;
    });

    const taskPattern = new RegExp(`@@TASK_${nonce}_(TODO|DOING|DONE)@@`, 'g');
    out = out.replace(taskPattern, (_match, stateRaw) => {
        const state = stateRaw.toLowerCase();
        const label = state === 'done' ? '已完成' : (state === 'doing' ? '进行中' : '未完成');
        return `<span class="task-check" data-task-state="${state}" aria-label="${label}"></span>`;
    });

    return out;
}

function stripDuplicateLeadingHeading(html, title) {
    const normalizedTitle = String(title || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!normalizedTitle) return html;
    return html.replace(/^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i, (match, inner) => {
        const plain = decodeBasicEntities(inner.replace(/<[^>]+>/g, ''))
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
        return plain === normalizedTitle ? '' : match;
    });
}

function applyImageWidthHints(html) {
    // Preserve DumbPad's explicit dumbpad-width=N hint directly in SSR HTML so
    // images render at their intended measure immediately with zero layout shift.
    return html.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
        const titleMatch = attrs.match(/\btitle=(?:"([^"]*)"|'([^']*)')/i);
        if (!titleMatch) return match;
        const titleVal = titleMatch[1] !== undefined ? titleMatch[1] : titleMatch[2];
        const widthMatch = titleVal.match(/dumbpad-width=(\d{2,4})/);
        if (!widthMatch) return match;
        const widthPx = Math.min(2400, Math.max(60, parseInt(widthMatch[1], 10)));
        const cleanAttrs = attrs.replace(/\s*\/$/, '').replace(/\s*\bstyle=(?:"[^"]*"|'[^']*')/gi, '');
        return `<img${cleanAttrs} data-dumbpad-width="${widthPx}" style="width:min(100%, ${widthPx}px);height:auto;">`;
    });
}

function computeReadingStats(markdown) {
    const plain = String(markdown || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[#>*`~\[\]()!]/g, ' ');
    const cjkMatches = plain.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
    const latinMatches = plain.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9_-]+/g) || [];
    const wordCount = cjkMatches.length + latinMatches.length;
    const readMinutes = Math.max(1, Math.ceil(cjkMatches.length / 400 + latinMatches.length / 220));
    return { wordCount, readMinutes };
}

function formatIsoDateFallback(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const pad = v => String(v).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatIsoDateTimeFallback(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const pad = v => String(v).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Extract leading YAML frontmatter (`--- ... ---` at document start) so marked
 * does not split it into `<hr>` + Setext `<h2>`. Adjacent `---\n---` or
 * blank-only delimiters stay ordinary horizontal rules.
 */
function extractFrontmatter(markdown) {
    const raw = String(markdown == null ? '' : markdown).replace(/^\uFEFF/, '');
    const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match || !match[1].trim()) {
        return { frontmatterRaw: null, bodyMarkdown: raw };
    }
    return {
        frontmatterRaw: match[1],
        bodyMarkdown: raw.slice(match[0].length)
    };
}

function unquoteYamlScalar(value) {
    const trimmed = String(value == null ? '' : value).trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

function parseFrontmatterEntries(rawYaml) {
    const lines = String(rawYaml == null ? '' : rawYaml).split(/\r?\n/);
    const entries = [];
    let current = null;
    let blockMode = '';
    let parseFailed = false;

    for (const line of lines) {
        if (!line.trim() || /^[ \t]*#/.test(line)) {
            if (current && blockMode) current._lines.push('');
            continue;
        }
        if (/^[ \t]+/.test(line) || (/^[ \t]*-\s+/.test(line) && current)) {
            if (!current) {
                parseFailed = true;
                break;
            }
            const listMatch = !blockMode && line.match(/^[ \t]*-\s+(.*)$/);
            if (listMatch) {
                if (!current.values) current.values = [];
                current.values.push(unquoteYamlScalar(listMatch[1]));
            } else {
                current._lines.push(line.trim());
            }
            continue;
        }
        const kvMatch = line.match(/^([^:\s][^:]*?)\s*:\s*(.*)$/);
        if (!kvMatch) {
            parseFailed = true;
            break;
        }
        blockMode = '';
        const key = unquoteYamlScalar(kvMatch[1]);
        const rest = kvMatch[2].trim();
        current = { key, value: '', values: null, _lines: [] };
        if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
            blockMode = rest;
        } else if (/^\[.*\]$/.test(rest)) {
            const inner = rest.slice(1, -1).trim();
            current.values = inner
                ? inner.split(/\s*,\s*/).map(unquoteYamlScalar).filter(Boolean)
                : [];
        } else if (rest) {
            current.value = unquoteYamlScalar(rest);
        }
        entries.push(current);
    }

    if (parseFailed || entries.length === 0) {
        return { entries: [], raw: String(rawYaml == null ? '' : rawYaml).trim() };
    }

    const cleaned = entries.map((item) => {
        let value = item.value;
        if (item._lines.length > 0) {
            const joined = item._lines.join(value ? ' ' : '\n').trim();
            value = value ? `${value}\n${joined}` : joined;
        }
        return { key: item.key, value, values: item.values };
    });
    return { entries: cleaned, raw: String(rawYaml == null ? '' : rawYaml).trim() };
}

function renderFrontmatterCardHtml(frontmatterRaw) {
    if (!frontmatterRaw) return '';
    const { entries, raw } = parseFrontmatterEntries(frontmatterRaw);
    if (!raw && entries.length === 0) return '';

    let summaryPreview = '';
    let countText = 'YAML';
    if (entries.length > 0) {
        summaryPreview = entries.slice(0, 2).map((entry) => {
            const val = entry.values ? entry.values.join(', ') : entry.value;
            return val ? `${entry.key}: ${val}` : entry.key;
        }).join(' · ');
        countText = `${entries.length} 项属性`;
    }

    const bodyHtml = entries.length > 0
        ? `<div class="fm-grid">${entries.map((entry) => {
            let valHtml = '';
            if (entry.values && entry.values.length > 0) {
                valHtml = `<div class="fm-chips">${entry.values.map((v) => `<span class="fm-chip">${escapeHtml(v)}</span>`).join('')}</div>`;
            } else if (entry.value) {
                valHtml = `<span class="fm-val-text">${escapeHtml(entry.value)}</span>`;
            } else {
                valHtml = '<span class="fm-val-empty">—</span>';
            }
            return `<div class="fm-row"><div class="fm-key">${escapeHtml(entry.key)}</div><div class="fm-val">${valHtml}</div></div>`;
        }).join('')}</div>`
        : `<pre class="fm-raw">${escapeHtml(raw)}</pre>`;

    const chevronSvg = '<svg class="fm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
    return `<details class="fm-card" aria-label="文档属性">
        <summary class="fm-summary">
            <span class="fm-badge">属性</span>
            <span class="fm-preview">${escapeHtml(summaryPreview || 'Frontmatter')}</span>
            <span class="fm-meta">
                <span class="fm-count">${escapeHtml(countText)}</span>
                ${chevronSvg}
            </span>
        </summary>
        <div class="fm-body">${bodyHtml}</div>
    </details>`;
}

function renderShareBody({ content, notepadName, marked, sanitizeHtml }) {
    const { bodyMarkdown } = extractFrontmatter(content);
    const nonce = crypto.randomBytes(6).toString('hex');
    const { textForMarked, marks } = tokenizeDumbPadMarks(bodyMarkdown, nonce);
    const parsed = marked.parse(textForMarked, { breaks: true, gfm: true });
    const withTaskTokens = preprocessTaskLists(parsed, nonce);
    const sanitized = sanitizeHtml(withTaskTokens);
    let htmlBody = rehydrateTokens({ html: sanitized, marks, nonce, marked, sanitizeHtml });
    htmlBody = stripDuplicateLeadingHeading(htmlBody, notepadName);
    htmlBody = applyImageWidthHints(htmlBody);
    return htmlBody;
}

function buildMetaItemsHtml(notepad, stats) {
    const items = [];
    const createdAt = Number(notepad?.createdAt);
    const updatedAt = Number(notepad?.updatedAt);
    const editCount = Number(notepad?.editCount);

    if (Number.isFinite(createdAt) && createdAt > 0) {
        items.push({ label: '创建', value: formatIsoDateFallback(createdAt), ts: createdAt, fmt: 'date' });
    }
    if (Number.isFinite(updatedAt) && updatedAt > 0) {
        items.push({ label: '更新', value: formatIsoDateTimeFallback(updatedAt), ts: updatedAt, fmt: 'datetime' });
    }
    if (Number.isSafeInteger(editCount) && editCount > 0) {
        items.push({ label: '修改', value: `${editCount} 次` });
    }
    items.push({ label: '阅读', value: `约 ${stats.readMinutes} 分钟` });
    return items;
}

function renderSharePage({ notepad, content, marked, sanitizeHtml }) {
    const title = String(notepad?.name || 'Untitled');
    const safeTitle = escapeHtml(title);
    const { frontmatterRaw, bodyMarkdown } = extractFrontmatter(content);
    const frontmatterHtml = renderFrontmatterCardHtml(frontmatterRaw);
    const htmlBody = renderShareBody({ content: bodyMarkdown, notepadName: title, marked, sanitizeHtml });
    const hasHeadings = /<h[1-6]\b/i.test(htmlBody);
    const stats = computeReadingStats(bodyMarkdown);
    const metaItems = buildMetaItemsHtml(notepad, stats);

    const railKvHtml = metaItems.map((item) => {
        const tsAttr = item.ts ? ` data-ts="${item.ts}" data-fmt="${item.fmt}"` : '';
        return `<div class="rail-kv"><span>${escapeHtml(item.label)}</span><span${tsAttr}>${escapeHtml(item.value)}</span></div>`;
    }).join('');

    const pillsHtml = metaItems.map((item) => {
        const tsAttr = item.ts ? ` data-ts="${item.ts}" data-fmt="${item.fmt}"` : '';
        return `<span class="meta-pill">${escapeHtml(item.label)} <strong${tsAttr}>${escapeHtml(item.value)}</strong></span>`;
    }).join('');

    const bodyClass = hasHeadings ? 'has-toc' : 'no-toc';

    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>${safeTitle} - DumbPad Shared</title>
    <link rel="icon" type="image/png" href="/Assets/dumbpad-icon-192.png?v=3">
    <script>
        (function () {
            var t = null;
            try { t = localStorage.getItem('dumbpad_share_theme'); } catch (_e) {}
            if (!t) {
                try {
                    var raw = localStorage.getItem('dumbpad_theme');
                    if (raw) t = JSON.parse(raw);
                } catch (_e) {}
            }
            if (t !== 'dark' && t !== 'light') {
                t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }
            document.documentElement.setAttribute('data-theme', t);
        })();
    </script>
    <style>
        /* ==================================================================
           DumbPad Shared Page — Style B (iOS Frosted Sheet) + Style C (Left Rail)
           Completely isolated from main app styles.css to prevent global leaks.
           ================================================================== */
        :root {
            --bg-color: #F2F2F7;
            --card-bg: #FFFFFF;
            --surface-subtle: #F7F7FA;
            --nav-glass: rgba(255, 255, 255, 0.78);
            --nav-border: rgba(60, 60, 67, 0.12);
            --text-primary: #1C1C1E;
            --text-body: #2C2C2E;
            --text-muted: #8E8E93;
            --text-faint: #AEAEB2;
            --border-color: rgba(60, 60, 67, 0.10);
            --border-strong: rgba(60, 60, 67, 0.22);
            --separator: rgba(60, 60, 67, 0.08);
            --primary: #E5A100;
            --primary-soft: rgba(229, 161, 0, 0.12);
            --code-bg: #F5F5F8;
            --code-header: #ECECF1;
            --mark-bg: rgba(255, 214, 10, 0.36);
            --draw-color: #007AFF;
            --danger-note: #FF3B30;
            --danger-soft: rgba(255, 59, 48, 0.10);
            --shadow-card: 0 2px 10px rgba(0, 0, 0, 0.03), 0 12px 32px rgba(0, 0, 0, 0.045);
            --shadow-pill: 0 8px 24px rgba(15, 23, 42, 0.07);
            --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", sans-serif;
            --font-mono: "SF Mono", "Fira Code", "JetBrains Mono", Consolas, ui-monospace, monospace;
        }

        html[data-theme="dark"] {
            --bg-color: #1C1C1E;
            --card-bg: #2C2C2E;
            --surface-subtle: #242426;
            --nav-glass: rgba(44, 44, 46, 0.78);
            --nav-border: rgba(255, 255, 255, 0.12);
            --text-primary: #FFFFFF;
            --text-body: #E5E5EA;
            --text-muted: #98989D;
            --text-faint: #636366;
            --border-color: rgba(255, 255, 255, 0.09);
            --border-strong: rgba(255, 255, 255, 0.22);
            --separator: rgba(255, 255, 255, 0.09);
            --primary: #FFD60A;
            --primary-soft: rgba(255, 214, 10, 0.15);
            --code-bg: #1E1E20;
            --code-header: #252528;
            --mark-bg: rgba(255, 214, 10, 0.25);
            --draw-color: #0A84FF;
            --danger-note: #FF453A;
            --danger-soft: rgba(255, 69, 58, 0.16);
            --shadow-card: 0 4px 18px rgba(0, 0, 0, 0.28);
            --shadow-pill: 0 8px 28px rgba(0, 0, 0, 0.35);
        }

        *, *::before, *::after { box-sizing: border-box; }
        html {
            background: var(--bg-color);
            scroll-behavior: smooth;
            -webkit-text-size-adjust: 100%;
        }
        body {
            margin: 0;
            min-height: 100vh;
            background: var(--bg-color);
            color: var(--text-body);
            font-family: var(--font-sans);
            font-size: 16px;
            line-height: 1.75;
            -webkit-font-smoothing: antialiased;
            overflow-x: clip;
            transition: background-color 0.22s ease, color 0.22s ease;
        }

        /* Top Reading Progress Bar */
        .progress-track {
            position: fixed;
            top: 0; left: 0; right: 0;
            height: 2px;
            z-index: 100;
            pointer-events: none;
        }
        .progress-fill {
            height: 100%;
            width: 0%;
            background: var(--primary);
            transition: width 0.08s linear;
        }

        /* Mobile / Narrow Seamless Top Bar (only visible < 1060px) */
        .mobile-topbar {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 80;
            height: calc(50px + env(safe-area-inset-top, 0px));
            padding: env(safe-area-inset-top, 0px) 14px 0;
            background: var(--nav-glass);
            backdrop-filter: blur(22px) saturate(185%);
            -webkit-backdrop-filter: blur(22px) saturate(185%);
            border-bottom: 0.5px solid var(--nav-border);
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .nav-left {
            display: flex;
            align-items: center;
            gap: 9px;
            min-width: 0;
        }
        .app-badge {
            width: 24px;
            height: 24px;
            border-radius: 7px;
            background: var(--primary);
            color: #1C1C1E;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 13px;
            flex-shrink: 0;
            text-decoration: none;
        }
        .nav-doc-name {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .nav-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        .nav-pill-btn {
            height: 30px;
            padding: 0 11px;
            border: 0;
            border-radius: 9px;
            background: color-mix(in srgb, var(--text-primary) 6%, transparent);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 12.5px;
            font-weight: 500;
            white-space: nowrap;
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            cursor: pointer;
            transition: background-color 0.15s ease, transform 0.12s ease;
        }
        .nav-pill-btn:hover { background: color-mix(in srgb, var(--text-primary) 11%, transparent); }
        .nav-pill-btn:active { transform: scale(0.97); }
        .nav-pill-btn svg { width: 14px; height: 14px; flex-shrink: 0; }

        /* Mobile / Narrow TOC Popover (Style B) */
        .toc-popover-btn { display: none; }
        .toc-popover {
            position: fixed;
            top: calc(58px + env(safe-area-inset-top, 0px));
            right: 12px;
            width: min(316px, calc(100vw - 24px));
            max-height: 64vh;
            border-radius: 14px;
            background: var(--nav-glass);
            backdrop-filter: blur(22px) saturate(185%);
            -webkit-backdrop-filter: blur(22px) saturate(185%);
            border: 0.5px solid var(--nav-border);
            box-shadow: var(--shadow-pill);
            z-index: 95;
            display: none;
            flex-direction: column;
            overflow: hidden;
        }
        .toc-popover.open { display: flex; }
        .toc-popover-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 9px 13px 8px;
            border-bottom: 0.5px solid var(--separator);
            flex-shrink: 0;
        }
        .toc-popover-title {
            font-size: 11.5px;
            font-weight: 700;
            letter-spacing: 0.05em;
            color: var(--text-muted);
        }
        .toc-popover-count {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-faint);
            font-variant-numeric: tabular-nums;
        }
        .toc-popover-list {
            overflow-y: auto;
            overscroll-behavior: contain;
            padding: 6px;
            max-height: calc(64vh - 40px);
            scrollbar-width: thin;
            scrollbar-color: color-mix(in srgb, var(--text-muted) 28%, transparent) transparent;
        }
        .toc-popover a {
            display: flex;
            align-items: flex-start;
            gap: 7px;
            padding: 7px 10px 7px 9px;
            border-radius: 9px;
            font-size: 13.5px;
            color: var(--text-primary);
            text-decoration: none;
            line-height: 1.42;
            transition: background-color 0.14s ease, color 0.14s ease;
        }
        .toc-popover a[data-depth="0"] { padding-left: 9px; font-weight: 560; }
        .toc-popover a[data-depth="1"] { padding-left: 19px; font-size: 13px; color: var(--text-muted); }
        .toc-popover a[data-depth="2"] { padding-left: 29px; font-size: 12.5px; color: var(--text-muted); }
        .toc-popover a[data-depth="3"] { padding-left: 37px; font-size: 12px; color: var(--text-faint); }
        .toc-popover a[data-depth="4"] { padding-left: 45px; font-size: 12px; color: var(--text-faint); }
        .toc-popover a:hover, .toc-popover a.active {
            background: var(--primary-soft);
            color: var(--primary);
        }
        .toc-popover a.active { font-weight: 600; }

        /* Two-Column Grid: Style C Left Rail + Style B Main Sheet */
        .share-grid {
            max-width: 1084px;
            margin: 0 auto;
            padding: calc(32px + env(safe-area-inset-top, 0px)) 16px 72px;
            display: grid;
            grid-template-columns: 236px minmax(0, 792px);
            gap: 28px;
            justify-content: center;
            align-items: start;
        }
        body.no-toc .share-grid {
            display: block;
            max-width: 832px;
        }

        /* Left Rail (Style C Structure, Style B Surfaces) */
        .doc-rail {
            position: sticky;
            top: calc(24px + env(safe-area-inset-top, 0px));
            align-self: start;
            max-height: calc(100vh - 96px - env(safe-area-inset-top, 0px));
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        body.no-toc .doc-rail { display: none; }

        .rail-card {
            flex-shrink: 0;
            padding: 13px 14px 12px;
            border-radius: 16px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-card);
            margin-bottom: 14px;
        }
        .rail-brand-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 10px;
        }
        .rail-brand {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            text-decoration: none;
            color: var(--text-primary);
            font-size: 13.5px;
            font-weight: 700;
            letter-spacing: -0.01em;
        }
        .rail-badge {
            font-size: 11px;
            color: var(--text-muted);
            padding: 1px 7px;
            border-radius: 999px;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
        }
        .rail-tools {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            padding-bottom: 11px;
            margin-bottom: 9px;
            border-bottom: 1px solid var(--separator);
        }
        .rail-tool-btn {
            height: 31px;
            padding: 0 9px;
            border-radius: 9px;
            border: 1px solid var(--border-color);
            background: var(--surface-subtle);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 12px;
            font-weight: 550;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            cursor: pointer;
            white-space: nowrap;
            transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.12s ease;
        }
        .rail-tool-btn:hover {
            border-color: var(--border-strong);
            background: color-mix(in srgb, var(--text-primary) 6%, var(--surface-subtle));
        }
        .rail-tool-btn:active { transform: scale(0.97); }
        .rail-tool-btn svg { width: 13px; height: 13px; flex-shrink: 0; }
        .rail-kv {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            font-size: 12px;
            padding: 4px 0;
            font-variant-numeric: tabular-nums;
        }
        .rail-kv span:first-child { color: var(--text-muted); flex-shrink: 0; }
        .rail-kv span:last-child { color: var(--text-primary); font-weight: 600; text-align: right; }

        .rail-toc-box {
            flex: 1 1 auto;
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 13px 10px 14px 14px;
            border-radius: 16px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-card);
        }
        .rail-heading-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin: 0 4px 9px 2px;
            flex-shrink: 0;
        }
        .rail-heading {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.07em;
            text-transform: uppercase;
            color: var(--text-muted);
            margin: 0;
        }
        .rail-toc-count {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-faint);
            font-variant-numeric: tabular-nums;
        }
        .rail-nav {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            overscroll-behavior: contain;
            list-style: none;
            margin: 0;
            padding: 0 4px 0 0;
            box-shadow: inset 1px 0 0 var(--border-color);
            scrollbar-width: thin;
            scrollbar-color: color-mix(in srgb, var(--text-muted) 28%, transparent) transparent;
        }
        .rail-nav::-webkit-scrollbar,
        .toc-popover-list::-webkit-scrollbar { width: 4px; }
        .rail-nav::-webkit-scrollbar-track,
        .toc-popover-list::-webkit-scrollbar-track { background: transparent; }
        .rail-nav::-webkit-scrollbar-thumb,
        .toc-popover-list::-webkit-scrollbar-thumb {
            background: color-mix(in srgb, var(--text-muted) 26%, transparent);
            border-radius: 999px;
        }
        .rail-nav::-webkit-scrollbar-thumb:hover,
        .toc-popover-list::-webkit-scrollbar-thumb:hover {
            background: color-mix(in srgb, var(--text-muted) 46%, transparent);
        }
        .rail-nav a {
            display: flex;
            align-items: flex-start;
            gap: 7px;
            padding: 5.5px 8px 5.5px 10px;
            box-shadow: inset 2px 0 0 transparent;
            border-radius: 0 8px 8px 0;
            color: var(--text-muted);
            text-decoration: none;
            font-size: 13px;
            line-height: 1.42;
            transition: color 0.14s ease, box-shadow 0.14s ease, background-color 0.14s ease;
        }
        .rail-nav a[data-depth="0"] {
            padding-left: 10px;
            font-size: 13px;
            font-weight: 560;
            color: var(--text-body);
        }
        .rail-nav a[data-depth="1"] { padding-left: 20px; font-size: 12.5px; }
        .rail-nav a[data-depth="2"] { padding-left: 30px; font-size: 12px; }
        .rail-nav a[data-depth="3"] { padding-left: 38px; font-size: 11.5px; color: var(--text-faint); }
        .rail-nav a[data-depth="4"] { padding-left: 46px; font-size: 11.5px; color: var(--text-faint); }
        .rail-nav a:hover {
            color: var(--text-primary);
            background: color-mix(in srgb, var(--text-primary) 4%, transparent);
        }
        .rail-nav a.active {
            color: var(--primary);
            box-shadow: inset 2.5px 0 0 var(--primary);
            background: var(--primary-soft);
            font-weight: 600;
        }
        .toc-level-badge {
            flex: 0 0 auto;
            min-width: 22px;
            padding: 3px 0;
            margin-top: 2px;
            border-radius: 4px;
            text-align: center;
            font-family: var(--font-mono);
            font-size: 9.5px;
            font-weight: 700;
            line-height: 1;
            letter-spacing: 0.01em;
            color: var(--text-muted);
            background: color-mix(in srgb, var(--text-muted) 13%, transparent);
            transition: color 0.14s ease, background-color 0.14s ease;
        }
        .toc-level-badge::before {
            content: attr(data-badge);
        }
        .rail-nav a[data-level="1"] .toc-level-badge,
        .toc-popover a[data-level="1"] .toc-level-badge {
            color: var(--primary);
            background: color-mix(in srgb, var(--primary) 16%, transparent);
        }
        .rail-nav a[data-level="2"] .toc-level-badge,
        .toc-popover a[data-level="2"] .toc-level-badge {
            color: color-mix(in srgb, var(--primary) 78%, var(--text-muted));
            background: color-mix(in srgb, var(--primary) 10%, transparent);
        }
        .rail-nav a[data-level="3"] .toc-level-badge,
        .toc-popover a[data-level="3"] .toc-level-badge {
            color: color-mix(in srgb, var(--primary) 54%, var(--text-muted));
            background: color-mix(in srgb, var(--primary) 6%, transparent);
        }
        .rail-nav a.active .toc-level-badge,
        .toc-popover a.active .toc-level-badge {
            color: var(--primary);
            background: color-mix(in srgb, var(--primary) 18%, transparent);
        }
        .toc-link-label {
            flex: 1 1 auto;
            min-width: 0;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
            overflow: hidden;
            overflow-wrap: anywhere;
            word-break: break-word;
        }

        /* Main iOS Rounded Sheet (Style B) */
        .main-col { min-width: 0; }
        .ios-sheet {
            background: var(--card-bg);
            border-radius: 20px;
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-card);
            padding: 44px 56px 52px;
            transition: background-color 0.22s ease;
        }

        .sheet-header {
            margin-bottom: 30px;
            padding-bottom: 22px;
            border-bottom: 1px solid var(--separator);
        }
        .sheet-header-row {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
        }
        .sheet-header-actions {
            display: none;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
            margin-top: 4px;
        }
        body.no-toc .sheet-header-actions { display: flex; }
        .sheet-title {
            margin: 0;
            font-size: clamp(1.6rem, 3vw, 2.05rem);
            font-weight: 750;
            line-height: 1.25;
            letter-spacing: -0.02em;
            color: var(--text-primary);
            overflow-wrap: anywhere;
        }
        .meta-pills {
            display: none;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 14px;
        }
        body.no-toc .meta-pills { display: flex; }

        .meta-pill {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 3px 10px;
            border-radius: 999px;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            font-size: 12px;
            color: var(--text-muted);
            font-variant-numeric: tabular-nums;
        }
        .meta-pill strong { color: var(--text-primary); font-weight: 600; }

        /* Collapsible Document Frontmatter Card */
        .fm-card {
            margin: -10px 0 26px;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            background: var(--surface-subtle);
            overflow: hidden;
        }
        .fm-summary {
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 8px 12px;
            cursor: pointer;
            list-style: none;
            user-select: none;
            font-size: 12.5px;
            line-height: 1.4;
            color: var(--text-muted);
            transition: background-color 0.14s ease;
        }
        .fm-summary::-webkit-details-marker { display: none; }
        .fm-summary:hover {
            background: color-mix(in srgb, var(--text-primary) 3%, transparent);
        }
        .fm-badge {
            flex-shrink: 0;
            padding: 1.5px 7px;
            border-radius: 6px;
            background: var(--primary-soft);
            color: var(--primary);
            font-size: 11px;
            font-weight: 650;
            letter-spacing: 0.02em;
        }
        .fm-preview {
            flex: 1 1 auto;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--text-body);
            font-family: var(--font-mono);
            font-size: 12px;
        }
        .fm-card[open] .fm-preview { opacity: 0.72; }
        .fm-meta {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }
        .fm-count {
            font-size: 11px;
            color: var(--text-faint);
            font-variant-numeric: tabular-nums;
        }
        .fm-chevron {
            width: 14px;
            height: 14px;
            color: var(--text-muted);
            transition: transform 0.16s ease;
        }
        .fm-card[open] .fm-chevron { transform: rotate(90deg); }
        .fm-body {
            border-top: 1px solid var(--separator);
            padding: 8px 12px 10px;
            background: color-mix(in srgb, var(--card-bg) 55%, var(--surface-subtle));
        }
        .fm-grid {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .fm-row {
            display: grid;
            grid-template-columns: minmax(76px, 128px) minmax(0, 1fr);
            gap: 10px;
            align-items: baseline;
            font-size: 12.5px;
            line-height: 1.55;
            padding: 2px 0;
        }
        .fm-key {
            color: var(--text-muted);
            font-family: var(--font-mono);
            font-size: 11.5px;
            font-weight: 600;
            overflow-wrap: anywhere;
        }
        .fm-val {
            color: var(--text-primary);
            min-width: 0;
            overflow-wrap: anywhere;
        }
        .fm-val-text { white-space: pre-wrap; }
        .fm-val-empty { color: var(--text-faint); }
        .fm-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
        }
        .fm-chip {
            display: inline-flex;
            align-items: center;
            padding: 1px 8px;
            border-radius: 999px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            font-size: 11.5px;
            color: var(--text-body);
        }
        .fm-raw {
            margin: 0;
            font-family: var(--font-mono);
            font-size: 12px;
            line-height: 1.55;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            color: var(--text-body);
        }

        /* Markdown Prose */
        .markdown-body {
            font-size: 15.5px;
            line-height: 1.78;
            color: var(--text-body);
            overflow-wrap: break-word;
        }
        .markdown-body > *:first-child { margin-top: 0; }
        .markdown-body > *:last-child { margin-bottom: 0; }

        .markdown-body h1,
        .markdown-body h2,
        .markdown-body h3,
        .markdown-body h4,
        .markdown-body h5,
        .markdown-body h6 {
            color: var(--text-primary);
            font-weight: 700;
            line-height: 1.32;
            scroll-margin-top: calc(24px + env(safe-area-inset-top, 0px));
        }
        .markdown-body h1 { font-size: 1.5em; margin: 1.55em 0 0.55em; padding-bottom: 0.3em; border-bottom: 1px solid var(--separator); }
        .markdown-body h2 { font-size: 1.32em; margin: 1.45em 0 0.5em; }
        .markdown-body h3 { font-size: 1.12em; margin: 1.3em 0 0.45em; }
        .markdown-body h4 { font-size: 1em; margin: 1.15em 0 0.4em; }

        .toc-flash {
            animation: tocTargetPulse 1.6s ease;
        }
        @keyframes tocTargetPulse {
            0%, 20% { color: var(--primary); }
            100% { color: var(--text-primary); }
        }

        .markdown-body p { margin: 0 0 0.85em; }
        .markdown-body strong { color: var(--text-primary); font-weight: 650; }
        .markdown-body a {
            color: var(--primary);
            text-decoration: underline;
            text-underline-offset: 3px;
            overflow-wrap: anywhere;
        }
        .markdown-body hr {
            border: 0;
            height: 1px;
            background: var(--separator);
            margin: 1.8em 0;
        }

        /* Callout-style Blockquote (no forced CJK italics!) */
        .markdown-body blockquote {
            margin: 1.25em 0;
            padding: 12px 16px;
            border-radius: 12px;
            border-left: 3.5px solid var(--primary);
            background: var(--primary-soft);
            color: var(--text-primary);
            font-style: normal;
        }
        .markdown-body blockquote p { margin: 0 0 0.5em; }
        .markdown-body blockquote p:last-child { margin-bottom: 0; }

        /* Lists (Typora-aligned: ul / ol / taskList share 1.55em text origin & balanced vertical rhythm) */
        .markdown-body ul, .markdown-body ol {
            margin: 0.45em 0 0.8em;
            padding-left: 1.55em;
        }
        .markdown-body ul:has(+ ul),
        .markdown-body ul:has(+ ol),
        .markdown-body ol:has(+ ul),
        .markdown-body ol:has(+ ol) {
            margin-bottom: 0.28em;
        }
        .markdown-body ul + ol,
        .markdown-body ol + ul,
        .markdown-body ul + ul,
        .markdown-body ol + ol {
            margin-top: 0.28em;
        }
        .markdown-body li { margin-bottom: 0.28em; }
        .markdown-body li:last-child { margin-bottom: 0; }
        .markdown-body li > p { margin: 0 0 0.28em; }
        .markdown-body li > p:last-child { margin-bottom: 0; }
        .markdown-body li > ul, .markdown-body li > ol {
            margin-top: 0.28em;
            margin-bottom: 0.15em;
        }
        .markdown-body li::marker {
            color: var(--primary);
            font-weight: 600;
            font-size: 0.94em;
        }
        .markdown-body ol > li:not(.task-item)::marker {
            content: counter(list-item) ".\\2004";
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", sans-serif;
            font-variant-numeric: tabular-nums;
            font-weight: 550;
            font-size: 0.94em;
        }
        .markdown-body ul > li:not(.task-item):not(:has(> .task-check)):not(:has(> p > .task-check))::marker {
            content: "•\\2004\\2006";
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
            font-size: 1.05em;
        }
        .markdown-body ul ul > li:not(.task-item):not(:has(> .task-check)):not(:has(> p > .task-check))::marker {
            content: "◦\\2004\\2006";
        }
        .markdown-body ul ul ul > li:not(.task-item):not(:has(> .task-check)):not(:has(> p > .task-check))::marker {
            content: "▪\\2004\\2006";
        }

        /* 3-State Task List (applied strictly per task <li>, never suppresses sibling bullets in mixed lists!) */
        .markdown-body ul.task-list,
        .markdown-body ul:has(> li > .task-check),
        .markdown-body ul:has(> li > p > .task-check) {
            padding-left: 1.55em;
        }
        .markdown-body li.task-item,
        .markdown-body li:has(> .task-check),
        .markdown-body li:has(> p > .task-check) {
            position: relative;
            padding: 2px 8px 2px calc(15px + 0.38em + 8px);
            margin: 0 -8px 0.28em calc(-15px - 0.38em - 8px);
            border-radius: 10px;
            list-style: none;
        }
        .markdown-body li.task-item:last-child,
        .markdown-body li:has(> .task-check):last-child,
        .markdown-body li:has(> p > .task-check):last-child {
            margin-bottom: 0;
        }
        .markdown-body li.task-item::marker,
        .markdown-body li:has(> .task-check)::marker,
        .markdown-body li:has(> p > .task-check)::marker {
            content: none;
        }
        .markdown-body li.task-item[data-state="doing"],
        .markdown-body li:has(.task-check[data-task-state="doing"]) {
            background: color-mix(in srgb, var(--primary) 7%, transparent);
        }
        .task-check {
            position: absolute;
            left: 8px;
            top: calc(2px + 0.42em);
            width: 15px;
            height: 15px;
            border-radius: 4.5px;
            border: 1.5px solid color-mix(in srgb, var(--text-muted) 55%, transparent);
            background: var(--card-bg);
            display: inline-block;
        }
        .task-check[data-task-state="done"] {
            background: var(--primary);
            border-color: var(--primary);
        }
        .task-check[data-task-state="done"]::after {
            content: "";
            position: absolute;
            left: 4px;
            top: 1.5px;
            width: 4px;
            height: 7.5px;
            border: solid #1C1C1E;
            border-width: 0 2px 2px 0;
            transform: rotate(42deg);
        }
        .task-check[data-task-state="doing"] {
            border-color: var(--primary);
            background: linear-gradient(90deg, var(--primary) 50%, transparent 50%);
        }
        .markdown-body li.task-item[data-state="done"],
        .markdown-body li.task-item[data-state="done"] > p,
        .markdown-body li:has(> .task-check[data-task-state="done"]),
        .markdown-body li:has(> p > .task-check[data-task-state="done"]) > p {
            color: var(--text-muted);
            text-decoration: line-through;
        }

        /* Inline Code & Contained Code Cards */
        .markdown-body code {
            font-family: var(--font-mono);
            font-size: 0.85em;
            background: var(--primary-soft);
            color: var(--text-primary);
            padding: 0.14em 0.42em;
            border-radius: 6px;
            overflow-wrap: anywhere;
        }
        .markdown-body pre {
            margin: 1.3em 0;
            padding: 13px 15px;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            background: var(--code-bg);
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            font-family: var(--font-mono);
            font-size: 13px;
            line-height: 1.55;
            color: var(--text-primary);
        }
        .markdown-body pre code {
            background: transparent;
            padding: 0;
            border-radius: 0;
            font-size: inherit;
            white-space: pre;
            overflow-wrap: normal;
        }
        .ios-code-card {
            margin: 1.3em 0;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            background: var(--code-bg);
            overflow: hidden;
        }
        .ios-code-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 12px;
            background: var(--code-header);
            border-bottom: 1px solid var(--border-color);
            font-family: var(--font-mono);
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
        .copy-code-btn {
            border: 1px solid var(--border-color);
            background: var(--card-bg);
            color: var(--text-primary);
            border-radius: 6px;
            padding: 3px 9px;
            font-family: var(--font-sans);
            font-size: 11.5px;
            font-weight: 500;
            cursor: pointer;
        }
        .copy-code-btn.copied { color: var(--primary); }
        .ios-code-card pre {
            margin: 0;
            border: 0;
            border-radius: 0;
        }

        /* Mermaid Diagram Cards */
        .ios-mermaid-card {
            margin: 1.35em 0;
            border-radius: 14px;
            border: 1px solid var(--border-color);
            background: var(--card-bg);
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.025);
            overflow: hidden;
        }
        .ios-mermaid-tools {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .ios-mermaid-stage {
            padding: 18px 16px;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            text-align: center;
            cursor: zoom-in;
        }
        .ios-mermaid-stage[hidden] { display: none; }
        .ios-mermaid-stage svg {
            display: block;
            max-width: 100%;
            height: auto;
            margin: 0 auto;
        }
        .ios-mermaid-status {
            padding: 20px 14px;
            font-size: 13px;
            color: var(--text-muted);
            text-align: center;
        }
        .ios-mermaid-hint {
            padding: 8px 14px;
            font-size: 12px;
            color: var(--danger-note);
            background: var(--danger-soft);
            border-bottom: 1px solid var(--border-color);
        }
        .ios-mermaid-source[hidden] { display: none; }
        .ios-mermaid-source pre {
            margin: 0;
            border: 0;
            border-radius: 0;
        }

        /* Images — Always bounded + respects dumbpad-width */
        .markdown-body img {
            display: block;
            max-width: 100%;
            height: auto;
            border-radius: 10px;
            margin: 1em 0;
            cursor: zoom-in;
        }
        .ios-media-frame {
            margin: 1.15em 0;
            display: inline-block;
            max-width: 100%;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            background: var(--surface-subtle);
            overflow: hidden;
        }
        .ios-media-frame img {
            margin: 0;
            border-radius: 0;
            display: block;
            max-width: 100%;
            height: auto;
        }
        .ios-media-caption {
            padding: 6px 12px;
            font-size: 12px;
            color: var(--text-muted);
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            gap: 10px;
        }

        /* Embedded Audio / Video Cards */
        .dumbpad-share-media {
            margin: 1.2em 0;
            border: 1px solid var(--border-color);
            border-radius: 12px;
            background: var(--surface-subtle);
            overflow: hidden;
            max-width: 100%;
        }
        .dumbpad-share-media video,
        .dumbpad-share-media audio {
            display: block;
            width: 100%;
        }
        .dumbpad-share-media video { max-height: 70vh; background: #000; }
        .dumbpad-share-media-meta {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 7px 12px;
            font-size: 12.5px;
            color: var(--text-muted);
            border-top: 1px solid var(--border-color);
        }
        .dumbpad-share-media-meta a {
            color: var(--primary);
            font-weight: 600;
            text-decoration: none;
            flex-shrink: 0;
        }

        /* Tables */
        .ios-table-wrap {
            margin: 1.3em 0;
            overflow-x: auto;
            border-radius: 12px;
            border: 1px solid var(--border-color);
        }
        .markdown-body table {
            width: 100%;
            min-width: 420px;
            border-collapse: collapse;
            font-size: 13.5px;
        }
        .markdown-body th, .markdown-body td {
            padding: 10px 14px;
            text-align: left;
            border-bottom: 1px solid var(--separator);
        }
        .markdown-body th {
            background: var(--surface-subtle);
            font-weight: 650;
            color: var(--text-primary);
        }
        .markdown-body tr:last-child td { border-bottom: none; }

        /* Marks, Underlines, Time Chips & File Chips */
        .md-mark {
            background: var(--mark-bg);
            color: var(--text-primary);
            padding: 1px 5px;
            border-radius: 5px;
        }
        .markdown-body [data-draw] {
            text-decoration: underline solid var(--draw-color) !important;
            text-decoration-thickness: 2px !important;
            text-underline-offset: 3px;
            text-decoration-skip-ink: none;
        }
        .markdown-body u {
            text-underline-offset: 3px;
            text-decoration-skip-ink: none;
        }
        .has-annotation { cursor: pointer; }
        .has-annotation .ann-span {
            text-decoration: underline wavy var(--danger-note);
            text-decoration-thickness: 2px;
            text-underline-offset: 3px;
            text-decoration-skip-ink: none;
        }
        .annotation-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            margin-left: 3px;
            border-radius: 50%;
            background: var(--danger-soft);
            color: var(--danger-note);
            vertical-align: 2px;
        }
        .annotation-badge svg { width: 10px; height: 10px; }

        .time-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 1px 7px;
            margin: 0 2px;
            border-radius: 6px;
            border: 1px solid color-mix(in srgb, #14785c 28%, var(--border-color));
            background: color-mix(in srgb, #14785c 9%, transparent);
            color: #14785c;
            font-family: var(--font-mono);
            font-size: 12px;
            vertical-align: 1px;
        }
        html[data-theme="dark"] .time-chip {
            color: #5eead4;
            border-color: rgba(94, 234, 212, 0.25);
            background: rgba(94, 234, 212, 0.10);
        }

        .markdown-body a.file-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 7px 12px;
            margin: 4px 0;
            border-radius: 11px;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            font-size: 13px;
            font-weight: 500;
            text-decoration: none;
            max-width: 100%;
        }
        .markdown-body a.file-pill:hover { border-color: var(--primary); color: var(--primary); }

        /* Clamped Glass Annotation Popover */
        .ios-popover {
            position: fixed;
            z-index: 120;
            max-width: min(320px, calc(100vw - 24px));
            padding: 12px 14px;
            border-radius: 14px;
            background: var(--nav-glass);
            backdrop-filter: blur(22px) saturate(185%);
            -webkit-backdrop-filter: blur(22px) saturate(185%);
            border: 0.5px solid var(--nav-border);
            box-shadow: var(--shadow-pill);
            font-size: 13.5px;
            line-height: 1.55;
            color: var(--text-primary);
        }
        .ios-popover-head {
            font-size: 11px;
            font-weight: 700;
            color: var(--danger-note);
            margin-bottom: 3px;
        }
        .ios-popover-body {
            white-space: pre-wrap;
            word-break: break-word;
        }

        /* Lightbox */
        .lightbox {
            position: fixed;
            inset: 0;
            z-index: 200;
            background: rgba(0, 0, 0, 0.84);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
            cursor: zoom-out;
        }
        .lightbox.open { display: flex; }
        .lightbox img {
            max-width: 96vw;
            max-height: 92vh;
            border-radius: 12px;
        }
        .lightbox img[hidden],
        .lightbox-svg-paper[hidden] { display: none; }
        .lightbox-svg-paper {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 20px;
            max-width: 94vw;
            max-height: 88vh;
            overflow: auto;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42);
            cursor: default;
        }
        .lightbox-svg-paper svg {
            display: block;
            margin: 0 auto;
        }

        /* Footer */
        .sheet-footer {
            margin-top: 24px;
            text-align: center;
            font-size: 12px;
            color: var(--text-muted);
        }
        .sheet-footer a {
            color: var(--primary);
            text-decoration: none;
            font-weight: 650;
        }

        /* Collapse Left Rail below 1060px -> Seamless Mobile/Tablet Top Bar */
        @media (max-width: 1059px) {
            .mobile-topbar { display: flex; }
            .share-grid {
                display: block;
                max-width: 832px;
                padding-top: calc(68px + env(safe-area-inset-top, 0px));
            }
            .doc-rail { display: none; }
            body.no-toc .sheet-header-actions { display: none; }
            .meta-pills { display: flex; }
            body.has-toc .toc-popover-btn { display: inline-flex; }
            .markdown-body h1,
            .markdown-body h2,
            .markdown-body h3,
            .markdown-body h4,
            .markdown-body h5,
            .markdown-body h6 {
                scroll-margin-top: calc(66px + env(safe-area-inset-top, 0px));
            }
        }

        @media (max-width: 680px) {
            .mobile-topbar {
                height: calc(46px + env(safe-area-inset-top, 0px));
                padding: env(safe-area-inset-top, 0px) 10px 0;
            }
            .toc-popover {
                top: calc(54px + env(safe-area-inset-top, 0px));
                right: 10px;
            }
            .share-grid {
                padding: calc(60px + env(safe-area-inset-top, 0px)) 10px 44px;
            }
            .ios-sheet {
                padding: 26px 18px 34px;
                border-radius: 16px;
            }
            .fm-row {
                grid-template-columns: 1fr;
                gap: 2px;
                padding: 3px 0;
            }
            .markdown-body { font-size: 15px; }
            .mobile-copy-label { display: none; }
        }
    </style>
</head>
<body class="${bodyClass}">
    <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>

    <header class="mobile-topbar" id="mobile-nav" aria-label="移动端操作栏">
        <div class="nav-left">
            <a class="app-badge" href="/" title="DumbPad">D</a>
            <span class="nav-doc-name">${safeTitle}</span>
        </div>
        <div class="nav-actions">
            <button class="nav-pill-btn toc-popover-btn" id="toc-btn" type="button" aria-label="文章目录">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="15" y2="12"/><line x1="4" y1="18" x2="11" y2="18"/></svg>
                <span>目录</span>
            </button>
            <button class="nav-pill-btn" data-share-copy="1" type="button" aria-label="复制正文" title="复制正文">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span class="js-copy-label mobile-copy-label">复制</span>
            </button>
            <button class="nav-pill-btn" data-share-theme="1" type="button" aria-label="切换浅色/暗色模式">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                <span class="js-theme-label">暗色</span>
            </button>
        </div>
    </header>

    <div class="toc-popover" id="toc-popover" aria-label="目录列表">
        <div class="toc-popover-head">
            <span class="toc-popover-title">文章目录</span>
            <span class="toc-popover-count" id="toc-popover-count"></span>
        </div>
        <div class="toc-popover-list" id="toc-popover-list"></div>
    </div>

    <div class="share-grid">
        <aside class="doc-rail" aria-label="文档导航与元信息">
            <div class="rail-card">
                <div class="rail-brand-row">
                    <a class="rail-brand" href="/"><span class="app-badge">D</span><span>DumbPad</span></a>
                    <span class="rail-badge">只读分享</span>
                </div>
                <div class="rail-tools">
                    <button class="rail-tool-btn" id="copy-doc-btn" data-share-copy="1" type="button" aria-label="复制正文" title="复制正文">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        <span class="js-copy-label">复制</span>
                    </button>
                    <button class="rail-tool-btn" id="theme-btn" data-share-theme="1" type="button" aria-label="切换浅色/暗色模式">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                        <span id="theme-text" class="js-theme-label">暗色</span>
                    </button>
                </div>
                ${railKvHtml}
            </div>
            <div class="rail-toc-box" id="rail-toc-box">
                <div class="rail-heading-row">
                    <div class="rail-heading">文章目录</div>
                    <span class="rail-toc-count" id="rail-toc-count"></span>
                </div>
                <ul class="rail-nav" id="rail-nav"></ul>
            </div>
        </aside>

        <main class="main-col">
            <article class="ios-sheet">
                <header class="sheet-header">
                    <div class="sheet-header-row">
                        <h1 class="sheet-title">${safeTitle}</h1>
                        <div class="sheet-header-actions">
                            <button class="rail-tool-btn" data-share-copy="1" type="button" aria-label="复制正文" title="复制正文">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                <span class="js-copy-label">复制</span>
                            </button>
                            <button class="rail-tool-btn" data-share-theme="1" type="button" aria-label="切换浅色/暗色模式">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                                <span class="js-theme-label">暗色</span>
                            </button>
                        </div>
                    </div>
                    <div class="meta-pills">${pillsHtml}</div>
                </header>
                ${frontmatterHtml}
                <div class="markdown-body" id="article-body">
                    ${htmlBody}
                </div>
            </article>
            <footer class="sheet-footer">
                PUBLISHED WITH <a href="/">DUMBPAD</a>
            </footer>
        </main>
    </div>

    <div class="lightbox" id="lightbox"><img id="lightbox-img" alt=""><div class="lightbox-svg-paper" id="lightbox-svg-paper" hidden></div></div>

    <script>
        (function () {
            var root = document.documentElement;
            var body = document.getElementById('article-body');
            var mermaidCards = [];
            var mermaidSeq = 0;
            var mermaidRuntimePromise = null;

            var syncThemeLabel = function () {
                var isDark = root.getAttribute('data-theme') === 'dark';
                var nextLabel = isDark ? '浅色' : '暗色';
                document.querySelectorAll('.js-theme-label').forEach(function (el) {
                    el.textContent = nextLabel;
                });
            };
            syncThemeLabel();

            var loadMermaidRuntime = function () {
                if (window.DumbPadMermaid) return Promise.resolve(window.DumbPadMermaid);
                if (!mermaidRuntimePromise) {
                    mermaidRuntimePromise = new Promise(function (resolve, reject) {
                        var s = document.createElement('script');
                        s.src = '/vendor/tiptap/tiptap-mermaid.bundle.js';
                        s.async = true;
                        s.addEventListener('load', function () {
                            if (window.DumbPadMermaid) resolve(window.DumbPadMermaid);
                            else reject(new Error('DumbPadMermaid global missing'));
                        });
                        s.addEventListener('error', function () {
                            s.remove();
                            mermaidRuntimePromise = null;
                            reject(new Error('Failed to load Mermaid runtime'));
                        });
                        document.head.appendChild(s);
                    });
                }
                return mermaidRuntimePromise;
            };

            var looksLikeMermaidError = function (svg) {
                return /class="error-message"|>Syntax error|No "graph types" were found/i.test(String(svg || ''));
            };

            var renderAllMermaid = function () {
                if (mermaidCards.length === 0) return;
                loadMermaidRuntime().then(function (runtime) {
                    var mermaid = runtime && (runtime.default || runtime);
                    if (!mermaid || typeof mermaid.render !== 'function') {
                        throw new Error('Mermaid render API unavailable');
                    }
                    mermaid.initialize({
                        startOnLoad: false,
                        securityLevel: 'strict',
                        theme: root.getAttribute('data-theme') === 'dark' ? 'dark' : 'default'
                    });
                    return mermaidCards.reduce(function (chain, item) {
                        return chain.then(function () {
                            var renderId = 'dumbpad-share-mermaid-' + (mermaidSeq += 1);
                            return mermaid.render(renderId, item.source).then(function (res) {
                                var orphan = document.getElementById(renderId);
                                if (orphan) orphan.remove();
                                var svg = res && (res.svg || res.svgCode);
                                if (typeof svg !== 'string' || !svg.trim() || looksLikeMermaidError(svg)) {
                                    throw new Error('Mermaid syntax error');
                                }
                                item.stage.innerHTML = svg;
                                item.hint.hidden = true;
                                if (!item.showSource) {
                                    item.stage.hidden = false;
                                    item.sourceBox.hidden = true;
                                }
                                item.zoomBtn.disabled = false;
                            }).catch(function () {
                                var orphan = document.getElementById(renderId);
                                if (orphan) orphan.remove();
                                item.stage.hidden = true;
                                item.sourceBox.hidden = false;
                                item.hint.hidden = false;
                                item.zoomBtn.disabled = true;
                            });
                        });
                    }, Promise.resolve());
                }).catch(function () {
                    mermaidCards.forEach(function (item) {
                        item.stage.hidden = true;
                        item.sourceBox.hidden = false;
                        item.zoomBtn.disabled = true;
                    });
                });
            };

            document.querySelectorAll('[data-share-theme]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                    root.setAttribute('data-theme', next);
                    try { localStorage.setItem('dumbpad_share_theme', next); } catch (_e) {}
                    syncThemeLabel();
                    renderAllMermaid();
                });
            });

            // Format timestamps in viewer local timezone
            var pad = function (v) { return String(v).padStart(2, '0'); };
            document.querySelectorAll('[data-ts]').forEach(function (el) {
                var ts = Number(el.getAttribute('data-ts'));
                if (!Number.isFinite(ts) || ts <= 0) return;
                var d = new Date(ts);
                var datePart = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
                if (el.getAttribute('data-fmt') === 'datetime') {
                    el.textContent = datePart + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
                } else {
                    el.textContent = datePart;
                }
            });

            // Reading progress bar
            var progressFill = document.getElementById('progress-fill');
            var updateProgress = function () {
                var max = document.documentElement.scrollHeight - window.innerHeight;
                progressFill.style.width = max > 0 ? Math.min(100, (window.scrollY / max) * 100) + '%' : '0%';
            };
            window.addEventListener('scroll', updateProgress, { passive: true });
            updateProgress();

            // Normalize 3-state task list classes for browsers without :has()
            body.querySelectorAll('.task-check[data-task-state]').forEach(function (chk) {
                var li = chk.closest('li');
                if (!li) return;
                li.classList.add('task-item');
                li.setAttribute('data-state', chk.getAttribute('data-task-state'));
                var ul = li.parentElement;
                if (ul && (ul.tagName === 'UL' || ul.tagName === 'OL')) ul.classList.add('task-list');
            });

            // Wrap tables so narrow screens scroll internally
            body.querySelectorAll('table').forEach(function (tbl) {
                if (tbl.parentElement && tbl.parentElement.classList.contains('ios-table-wrap')) return;
                var wrap = document.createElement('div');
                wrap.className = 'ios-table-wrap';
                tbl.parentNode.insertBefore(wrap, tbl);
                wrap.appendChild(tbl);
            });

            var copyTextToClipboard = function (txt) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    return navigator.clipboard.writeText(txt).catch(function () {});
                }
                var ta = document.createElement('textarea');
                ta.value = txt;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch (_e) {}
                ta.remove();
            };

            var lb = document.getElementById('lightbox');
            var lbImg = document.getElementById('lightbox-img');
            var lbSvgPaper = document.getElementById('lightbox-svg-paper');

            var openImageLightbox = function (src, alt) {
                lbSvgPaper.hidden = true;
                lbSvgPaper.replaceChildren();
                lbImg.hidden = false;
                lbImg.src = src;
                lbImg.alt = alt || '';
                lb.classList.add('open');
            };

            var openSvgLightbox = function (svgEl) {
                if (!svgEl) return;
                lbImg.hidden = true;
                lbImg.removeAttribute('src');
                var clone = svgEl.cloneNode(true);
                clone.removeAttribute('style');
                var vb = String(clone.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
                if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
                    var maxW = Math.max(240, window.innerWidth * 0.88 - 44);
                    var maxH = Math.max(180, window.innerHeight * 0.82 - 44);
                    var scale = Math.min(maxW / vb[2], maxH / vb[3], 2.2);
                    clone.setAttribute('width', String(Math.round(vb[2] * scale)));
                    clone.setAttribute('height', String(Math.round(vb[3] * scale)));
                } else {
                    clone.setAttribute('width', String(Math.round(window.innerWidth * 0.8)));
                }
                lbSvgPaper.replaceChildren(clone);
                lbSvgPaper.hidden = false;
                lb.classList.add('open');
            };

            lb.addEventListener('click', function () { lb.classList.remove('open'); });

            // Enhance <pre> blocks: upgrade Mermaid blocks into diagram cards, wrap code blocks cleanly
            body.querySelectorAll('pre').forEach(function (pre) {
                if (pre.closest('.ios-code-card') || pre.closest('.ios-mermaid-card')) return;
                var codeEl = pre.querySelector('code');
                var langMatch = codeEl && (codeEl.className || '').match(/language-([A-Za-z0-9_+-]+)/i);
                var lang = langMatch ? langMatch[1] : 'code';

                if (lang.toLowerCase() === 'mermaid') {
                    var source = (codeEl ? codeEl.textContent : pre.textContent || '').replace(/[\\u200B\\uFEFF]/g, '');
                    var mCard = document.createElement('div');
                    mCard.className = 'ios-mermaid-card';

                    var mBar = document.createElement('div');
                    mBar.className = 'ios-code-bar';
                    var mLabel = document.createElement('span');
                    mLabel.textContent = 'mermaid';
                    var mTools = document.createElement('div');
                    mTools.className = 'ios-mermaid-tools';

                    var srcBtn = document.createElement('button');
                    srcBtn.type = 'button';
                    srcBtn.className = 'copy-code-btn';
                    srcBtn.textContent = '源码';

                    var zoomBtn = document.createElement('button');
                    zoomBtn.type = 'button';
                    zoomBtn.className = 'copy-code-btn';
                    zoomBtn.textContent = '放大';
                    zoomBtn.disabled = true;

                    var mCopyBtn = document.createElement('button');
                    mCopyBtn.type = 'button';
                    mCopyBtn.className = 'copy-code-btn';
                    mCopyBtn.textContent = '复制';

                    mTools.append(srcBtn, zoomBtn, mCopyBtn);
                    mBar.append(mLabel, mTools);

                    var mHint = document.createElement('div');
                    mHint.className = 'ios-mermaid-hint';
                    mHint.textContent = 'Mermaid 语法未能渲染，已保留源码展示。';
                    mHint.hidden = true;

                    var stage = document.createElement('div');
                    stage.className = 'ios-mermaid-stage';
                    var loading = document.createElement('div');
                    loading.className = 'ios-mermaid-status';
                    loading.textContent = '正在渲染图表…';
                    stage.appendChild(loading);

                    var sourceBox = document.createElement('div');
                    sourceBox.className = 'ios-mermaid-source';
                    sourceBox.hidden = true;

                    pre.parentNode.insertBefore(mCard, pre);
                    sourceBox.appendChild(pre);
                    mCard.append(mBar, mHint, stage, sourceBox);

                    var item = {
                        source: source,
                        stage: stage,
                        sourceBox: sourceBox,
                        hint: mHint,
                        zoomBtn: zoomBtn,
                        showSource: false
                    };
                    mermaidCards.push(item);

                    srcBtn.addEventListener('click', function () {
                        item.showSource = !item.showSource;
                        srcBtn.textContent = item.showSource ? '图表' : '源码';
                        sourceBox.hidden = !item.showSource;
                        stage.hidden = item.showSource || !stage.querySelector('svg');
                    });

                    zoomBtn.addEventListener('click', function () {
                        var svg = stage.querySelector('svg');
                        if (svg) openSvgLightbox(svg);
                    });

                    stage.addEventListener('click', function () {
                        var svg = stage.querySelector('svg');
                        if (svg) openSvgLightbox(svg);
                    });

                    mCopyBtn.addEventListener('click', function () {
                        copyTextToClipboard(source);
                        mCopyBtn.textContent = '已复制';
                        mCopyBtn.classList.add('copied');
                        setTimeout(function () {
                            mCopyBtn.textContent = '复制';
                            mCopyBtn.classList.remove('copied');
                        }, 1400);
                    });
                    return;
                }

                var card = document.createElement('div');
                card.className = 'ios-code-card';
                var bar = document.createElement('div');
                bar.className = 'ios-code-bar';
                var label = document.createElement('span');
                label.textContent = lang;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'copy-code-btn';
                btn.textContent = '复制';
                btn.addEventListener('click', function () {
                    copyTextToClipboard(codeEl ? codeEl.textContent : pre.textContent);
                    btn.textContent = '已复制';
                    btn.classList.add('copied');
                    setTimeout(function () {
                        btn.textContent = '复制';
                        btn.classList.remove('copied');
                    }, 1400);
                });
                bar.append(label, btn);
                pre.parentNode.insertBefore(card, pre);
                card.append(bar, pre);
            });

            renderAllMermaid();

            // Enhance DumbPad file links & media/images
            var safeReadMeta = function (titleStr, key) {
                var m = String(titleStr || '').match(new RegExp('(?:^|;)' + key + '=([^;]*)'));
                if (!m) return '';
                try { return decodeURIComponent(m[1]); } catch (_e) { return m[1]; }
            };
            var formatBytes = function (n) {
                var v = Math.max(0, Number(n) || 0);
                if (v < 1024) return v + ' B';
                if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
                return (v / (1024 * 1024)).toFixed(v < 10485760 ? 1 : 0) + ' MB';
            };

            body.querySelectorAll('a[title^="dumbpad-file=1"]').forEach(function (a) {
                a.classList.add('file-pill');
                a.setAttribute('title', '下载附件');
            });

            body.querySelectorAll('img').forEach(function (img) {
                var rawTitle = img.getAttribute('title') || '';
                if (rawTitle.indexOf('dumbpad-video=1') === 0 || rawTitle.indexOf('dumbpad-audio=1') === 0) {
                    var kind = rawTitle.indexOf('dumbpad-video=1') === 0 ? 'video' : 'audio';
                    var wrap = document.createElement('div');
                    wrap.className = 'dumbpad-share-media';
                    var media = document.createElement(kind);
                    media.controls = true;
                    media.preload = 'metadata';
                    media.src = img.getAttribute('src') || '';
                    var meta = document.createElement('div');
                    meta.className = 'dumbpad-share-media-meta';
                    var nameEl = document.createElement('span');
                    var fname = safeReadMeta(rawTitle, 'name') || img.getAttribute('alt') || (kind === 'audio' ? '音频' : '视频');
                    var fsize = safeReadMeta(rawTitle, 'size');
                    nameEl.textContent = fsize ? (fname + ' · ' + formatBytes(fsize)) : fname;
                    meta.appendChild(nameEl);
                    var assetMatch = (img.getAttribute('src') || '').match(/\\/api\\/assets\\/([a-f0-9-]{16,64})\\/(?:preview|original)/i);
                    if (assetMatch) {
                        var dl = document.createElement('a');
                        dl.href = '/api/assets/' + assetMatch[1] + '/download';
                        dl.textContent = '下载';
                        dl.setAttribute('download', fname);
                        meta.appendChild(dl);
                    }
                    wrap.append(media, meta);
                    img.replaceWith(wrap);
                    return;
                }

                var wAttr = img.getAttribute('data-dumbpad-width');
                if (wAttr) {
                    img.removeAttribute('title');
                    var fig = document.createElement('figure');
                    fig.className = 'ios-media-frame';
                    img.parentNode.insertBefore(fig, img);
                    fig.appendChild(img);
                    var cap = document.createElement('figcaption');
                    cap.className = 'ios-media-caption';
                    var altSpan = document.createElement('span');
                    altSpan.textContent = img.getAttribute('alt') || '图片';
                    var hintSpan = document.createElement('span');
                    hintSpan.textContent = wAttr + 'px · 点击放大';
                    cap.append(altSpan, hintSpan);
                    fig.appendChild(cap);
                }

                img.addEventListener('click', function () {
                    openImageLightbox(img.currentSrc || img.src, img.alt || '');
                });
            });

            // Copy article plain text (all copy triggers stay in sync)
            var copyLabelTimer = null;
            document.querySelectorAll('[data-share-copy]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    copyTextToClipboard(body.innerText || body.textContent || '');
                    document.querySelectorAll('.js-copy-label').forEach(function (el) { el.textContent = '已复制'; });
                    clearTimeout(copyLabelTimer);
                    copyLabelTimer = setTimeout(function () {
                        document.querySelectorAll('.js-copy-label').forEach(function (el) { el.textContent = '复制'; });
                    }, 1400);
                });
            });

            // Build Left-Rail TOC + Mobile Popover TOC
            var railNav = document.getElementById('rail-nav');
            var railTocCount = document.getElementById('rail-toc-count');
            var tocPop = document.getElementById('toc-popover');
            var tocPopList = document.getElementById('toc-popover-list');
            var tocPopCount = document.getElementById('toc-popover-count');
            var tocBtn = document.getElementById('toc-btn');
            var headings = Array.prototype.slice.call(body.querySelectorAll('h1, h2, h3, h4, h5, h6'))
                .filter(function (h) { return Boolean((h.textContent || '').trim()); });
            var tocPairs = [];
            var lastActivePair = null;

            var keepLinkVisibleInContainer = function (container, target, centerTarget) {
                if (!container || !target) return;
                if (container.scrollHeight <= container.clientHeight + 2) return;
                var cRect = container.getBoundingClientRect();
                var tRect = target.getBoundingClientRect();
                if (!cRect.height) return;
                if (centerTarget) {
                    container.scrollTop += (tRect.top - cRect.top) - (cRect.height - tRect.height) / 2;
                    return;
                }
                var pad = 16;
                if (tRect.top < cRect.top + pad) {
                    container.scrollTop += (tRect.top - cRect.top) - pad;
                } else if (tRect.bottom > cRect.bottom - pad) {
                    container.scrollTop += (tRect.bottom - cRect.bottom) + pad;
                }
            };

            if (headings.length === 0) {
                document.body.classList.remove('has-toc');
                document.body.classList.add('no-toc');
            } else {
                document.body.classList.add('has-toc');
                document.body.classList.remove('no-toc');
                if (railTocCount) railTocCount.textContent = headings.length + ' 节';
                if (tocPopCount) tocPopCount.textContent = headings.length + ' 节';
                var minLevel = headings.reduce(function (min, h) {
                    var lv = parseInt(h.tagName.slice(1), 10) || 2;
                    return lv < min ? lv : min;
                }, 6);

                headings.forEach(function (h, i) {
                    if (!h.id) h.id = 'sec-' + i;
                    var tagLevel = parseInt(h.tagName.slice(1), 10) || 2;
                    var depth = Math.min(4, Math.max(0, tagLevel - minLevel));
                    var labelText = (h.textContent || '').trim();

                    var buildTocAnchor = function () {
                        var link = document.createElement('a');
                        link.href = '#' + h.id;
                        link.title = labelText;
                        link.setAttribute('data-level', String(tagLevel));
                        link.setAttribute('data-depth', String(depth));
                        var badge = document.createElement('span');
                        badge.className = 'toc-level-badge';
                        badge.setAttribute('data-badge', 'H' + tagLevel);
                        badge.setAttribute('aria-hidden', 'true');
                        var span = document.createElement('span');
                        span.className = 'toc-link-label';
                        span.textContent = labelText;
                        link.append(badge, span);
                        return link;
                    };

                    var li = document.createElement('li');
                    var a = buildTocAnchor();
                    a.addEventListener('click', function () {
                        h.classList.remove('toc-flash');
                        void h.offsetWidth;
                        h.classList.add('toc-flash');
                    });
                    li.appendChild(a);
                    railNav.appendChild(li);

                    var ma = buildTocAnchor();
                    ma.addEventListener('click', function () {
                        tocPop.classList.remove('open');
                        h.classList.remove('toc-flash');
                        void h.offsetWidth;
                        h.classList.add('toc-flash');
                    });
                    tocPopList.appendChild(ma);

                    tocPairs.push({ h: h, rail: a, pop: ma });
                });

                var syncActiveToc = function () {
                    var activeLine = window.innerWidth < 1060 ? 115 : 80;
                    var doc = document.documentElement;
                    var atBottom = doc.scrollHeight > window.innerHeight + 8
                        && (window.scrollY + window.innerHeight >= doc.scrollHeight - 4);
                    var current = atBottom ? tocPairs[tocPairs.length - 1] : tocPairs[0];
                    if (!atBottom) {
                        for (var i = 0; i < tocPairs.length; i += 1) {
                            if (tocPairs[i].h.getBoundingClientRect().top <= activeLine) current = tocPairs[i];
                        }
                    }
                    tocPairs.forEach(function (p) {
                        var active = Boolean(current && p === current);
                        p.rail.classList.toggle('active', active);
                        p.pop.classList.toggle('active', active);
                    });
                    if (current && current !== lastActivePair) {
                        lastActivePair = current;
                        keepLinkVisibleInContainer(railNav, current.rail, false);
                    }
                };
                window.addEventListener('scroll', syncActiveToc, { passive: true });
                syncActiveToc();
            }

            tocBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var willOpen = !tocPop.classList.contains('open');
                tocPop.classList.toggle('open', willOpen);
                if (willOpen && lastActivePair) {
                    keepLinkVisibleInContainer(tocPopList, lastActivePair.pop, true);
                }
            });

            // Clamped Annotation Popover
            var activePopover = null;
            var closePopover = function () {
                if (activePopover) {
                    activePopover.remove();
                    activePopover = null;
                }
            };

            document.addEventListener('click', function (e) {
                if (!e.target.closest('#toc-popover') && !e.target.closest('#toc-btn')) {
                    tocPop.classList.remove('open');
                }
                if (activePopover && e.target.closest('.ios-popover')) return;
                var ann = e.target.closest('.has-annotation');
                closePopover();
                if (!ann) return;
                e.stopPropagation();

                var commentText = '';
                try { commentText = decodeURIComponent(ann.getAttribute('data-comment') || ''); } catch (_e) { commentText = ann.getAttribute('data-comment') || ''; }
                var pop = document.createElement('div');
                pop.className = 'ios-popover';
                var head = document.createElement('div');
                head.className = 'ios-popover-head';
                head.textContent = '批注';
                var pBody = document.createElement('div');
                pBody.className = 'ios-popover-body';
                pBody.textContent = commentText;
                pop.append(head, pBody);
                document.body.appendChild(pop);

                var rect = ann.getBoundingClientRect();
                var pr = pop.getBoundingClientRect();
                var minTop = window.innerWidth < 1060 ? 58 : 12;
                var left = Math.max(12, Math.min(window.innerWidth - pr.width - 12, rect.left + rect.width / 2 - pr.width / 2));
                var top = rect.top - pr.height - 10 >= minTop
                    ? rect.top - pr.height - 10
                    : Math.min(window.innerHeight - pr.height - 12, rect.bottom + 10);
                pop.style.left = left + 'px';
                pop.style.top = top + 'px';
                activePopover = pop;
            });

            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    closePopover();
                    tocPop.classList.remove('open');
                    lb.classList.remove('open');
                }
            });
        })();
    </script>
</body>
</html>`;
}

module.exports = {
    renderSharePage,
    renderShareBody,
    extractFrontmatter,
    parseFrontmatterEntries,
    renderFrontmatterCardHtml,
    tokenizeDumbPadMarks,
    preprocessTaskLists,
    stripDuplicateLeadingHeading,
    applyImageWidthHints,
    computeReadingStats,
    escapeHtml
};
