export const FILE_COMMAND = '/file';
export const ARTICLE_FILE_TITLE_PREFIX = 'dumbpad-file=1';

function clampOffset(value, offset) {
    return Math.max(0, Math.min(String(value || '').length, Number(offset) || 0));
}

function escapeMarkdownLabel(value) {
    return String(value || '文件').replace(/[\[\]\\]/g, '\\$&');
}

function safeTitlePart(value) {
    return encodeURIComponent(String(value || '').trim().slice(0, 120));
}

export function formatFileSize(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function findFileCommandBeforeCursor(value, selectionStart, selectionEnd) {
    const text = String(value || '');
    const start = clampOffset(text, selectionStart);
    const end = clampOffset(text, selectionEnd);
    if (start !== end || start < FILE_COMMAND.length) return null;

    const commandStart = start - FILE_COMMAND.length;
    if (text.slice(commandStart, start) !== FILE_COMMAND) return null;
    const charAfterCommand = text[start] || '';
    if (/^[A-Za-z0-9_-]$/.test(charAfterCommand)) return null;
    return { start: commandStart, end: start };
}

export function findFileCommandInMarkdownBlock(block = {}, textBeforeCursor = '') {
    const blockType = String(block.type || '').toLowerCase();
    if (blockType === 'code' || blockType === 'codespan') return null;

    const visiblePrefix = String(textBeforeCursor || '');
    const localRange = findFileCommandBeforeCursor(visiblePrefix, visiblePrefix.length, visiblePrefix.length);
    if (!localRange) return null;

    const occurrenceIndex = visiblePrefix
        .slice(0, localRange.end)
        .split(FILE_COMMAND)
        .length - 2;
    if (occurrenceIndex < 0) return null;

    const raw = String(block.raw || '');
    let rawOffset = -1;
    let from = 0;
    for (let index = 0; index <= occurrenceIndex; index += 1) {
        rawOffset = raw.indexOf(FILE_COMMAND, from);
        if (rawOffset < 0) return null;
        from = rawOffset + FILE_COMMAND.length;
    }

    const blockStart = Number(block.start);
    const blockEnd = Number(block.end);
    if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return null;
    const start = blockStart + rawOffset;
    const end = start + FILE_COMMAND.length;
    if (start < blockStart || end > blockEnd) return null;
    return { start, end };
}

export function replaceFileCommand(value, range, replacement = '') {
    const text = String(value || '');
    const start = clampOffset(text, range?.start);
    const end = clampOffset(text, range?.end);
    if (start > end || text.slice(start, end) !== FILE_COMMAND) return null;
    const inserted = String(replacement || '');
    const next = `${text.slice(0, start)}${inserted}${text.slice(end)}`;
    const caret = start + inserted.length;
    return { value: next, selectionStart: caret, selectionEnd: caret };
}

export function buildArticleFileMarkdown(asset = {}) {
    const name = escapeMarkdownLabel(asset.name || '文件');
    const url = String(asset.downloadUrl || asset.originalUrl || '').trim();
    if (!url) return '';
    const size = Math.max(0, Number(asset.size) || 0);
    const type = safeTitlePart(asset.type || 'application/octet-stream');
    const title = `${ARTICLE_FILE_TITLE_PREFIX};size=${size};type=${type}`;
    return `[📎 ${name} · ${formatFileSize(size)}](${url} "${title}")`;
}
