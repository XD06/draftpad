import { renderTimeMarkers } from './time-command.js';

export function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function escapeRegExp(string) {
    return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function linkifyEscapedHtml(escaped = '') {
    return String(escaped || '').replace(/((?:https?:\/\/|www\.)[^\s<>'"]+)/gi, (match) => {
        let url = match;
        let trailing = '';
        const punctuation = /[.,;:!?\)]$/;
        while (punctuation.test(url)) {
            if (url.endsWith(')')) {
                const openParentheses = (url.match(/\(/g) || []).length;
                const closeParentheses = (url.match(/\)/g) || []).length;
                if (closeParentheses > openParentheses) {
                    trailing = url.slice(-1) + trailing;
                    url = url.slice(0, -1);
                    continue;
                }
            } else {
                trailing = url.slice(-1) + trailing;
                url = url.slice(0, -1);
                continue;
            }
            break;
        }
        let href = url;
        if (url.toLowerCase().startsWith('www.')) {
            href = 'https://' + url;
        }
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="thought-link">${url}</a>${trailing}`;
    });
}

function renderThoughtInlineMarkers(escaped = '') {
    let html = renderTimeMarkers(escaped, 'thought-time-marker');
    html = html.replace(
        /&lt;span data-note=&quot;([^&]*)&quot;[\s\S]*?&gt;([\s\S]*?)&lt;\/span&gt;\s*&lt;sub[\s\S]*?&gt;[\s\S]*?&lt;\/sub&gt;/g,
        (_match, comment, markedText) => `<span class="thought-note-line" title="${comment}">${markedText}</span>`
    );
    html = html.replace(
        /&lt;span data-draw[\s\S]*?&gt;([\s\S]*?)&lt;\/span&gt;/g,
        '<span class="thought-draw-line">$1</span>'
    );
    html = html.replace(/&lt;mark&gt;([\s\S]*?)&lt;\/mark&gt;/g, '<mark class="thought-inline-highlight">$1</mark>');
    html = html.replace(/==([^=\n]+?)==/g, '<mark class="thought-inline-highlight">$1</mark>');
    return html;
}

function escapeRegExpLiteral(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearSelectedThoughtInlineMarker(source, selected) {
    const escapedSelected = escapeRegExpLiteral(selected);
    const replacements = [
        new RegExp(`<mark>${escapedSelected}<\\/mark>`),
        new RegExp(`<span data-draw[^>]*>${escapedSelected}<\\/span>`),
        new RegExp(`<span data-note="[^"]*"[^>]*>${escapedSelected}<\\/span>\\s*<sub[^>]*>[\\s\\S]*?<\\/sub>`)
    ];
    for (const pattern of replacements) {
        if (pattern.test(source)) return source.replace(pattern, selected);
    }
    return source;
}

export function applyThoughtTextStyle(source, selectedText, style) {
    const text = String(source || '');
    const selected = String(selectedText || '').trim();
    if (!text || !selected) return text;

    const cleared = clearSelectedThoughtInlineMarker(text, selected);
    if (style === 'clear') return cleared;

    const index = cleared.indexOf(selected);
    if (index === -1) return text;

    const replacement = style === 'draw'
        ? `<span data-draw>${selected}</span>`
        : `<mark>${selected}</mark>`;
    return `${cleared.slice(0, index)}${replacement}${cleared.slice(index + selected.length)}`;
}

export function formatThoughtText(text, escapeHtmlFn = escapeHtml) {
    if (!text) return '';
    return linkifyEscapedHtml(renderThoughtInlineMarkers(escapeHtmlFn(text)));
}

export function linkifyText(text, escapeHtmlFn = escapeHtml) {
    if (!text) return '';
    return linkifyEscapedHtml(escapeHtmlFn(text));
}
