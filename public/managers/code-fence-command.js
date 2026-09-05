export const PENDING_CODE_FENCE_GUARD = '\u2060';

const PENDING_PREFIX = `\`\`${PENDING_CODE_FENCE_GUARD}\``;
const LANGUAGE_RE = /^[A-Za-z0-9_+.#-]{0,40}$/;

export function normalizeCodeFenceLanguage(value = '') {
    const language = String(value || '').trim();
    return LANGUAGE_RE.test(language) ? language : null;
}

export function readCodeFenceLanguage(markdown = '') {
    const match = String(markdown || '').match(/^(?:`{3,}|~{3,})([^\r\n]*)/);
    if (!match) return null;
    return normalizeCodeFenceLanguage(match[1]);
}

export function readCodeFenceBody(markdown = '') {
    const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const opening = lines[0]?.match(/^(`{3,}|~{3,})/);
    if (!opening || lines.length < 2) return null;
    const marker = opening[1];
    const closing = lines[lines.length - 1];
    const closingPattern = marker[0] === '`' ? /^`{3,}[ \t]*$/ : /^~{3,}[ \t]*$/;
    if (!closingPattern.test(closing)) return null;
    return lines.slice(1, -1).join('\n');
}

export function replaceCodeFenceLanguage(markdown = '', language = '') {
    const normalizedLanguage = normalizeCodeFenceLanguage(language);
    if (normalizedLanguage === null) return null;
    const source = String(markdown || '');
    const opening = source.match(/^(`{3,}|~{3,})[^\r\n]*(\r?\n|$)/);
    if (!opening) return null;
    return `${opening[1]}${normalizedLanguage}${opening[2]}${source.slice(opening[0].length)}`;
}

export function buildPendingCodeFenceText(before = '', after = '', insertedText = '') {
    const normalize = value => String(value || '').replace(/[\u200B\uFEFF]/g, '');
    const next = `${normalize(before)}${String(insertedText || '')}${normalize(after)}`;
    return next === '```' ? PENDING_PREFIX : null;
}

export function parseCodeFenceCommand(value = '') {
    const text = String(value || '').replace(/\u200B/g, '');
    if (!text.startsWith(PENDING_PREFIX)) return null;
    const language = text.slice(PENDING_PREFIX.length);
    return LANGUAGE_RE.test(language) ? language : null;
}

export function buildCodeFenceMarkdown(language = '') {
    const normalizedLanguage = normalizeCodeFenceLanguage(language) ?? '';
    const opening = `\`\`\`${normalizedLanguage}`;
    return {
        markdown: `${opening}\n\n\`\`\``,
        caretOffset: opening.length + 1
    };
}
