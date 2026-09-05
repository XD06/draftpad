'use strict';

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MIN_FILE_BYTES = 1;
const MAX_CONFIGURED_FILE_BYTES = 100 * 1024 * 1024;

const FILE_TYPES = Object.freeze({
    pdf: { type: 'application/pdf', mimes: ['application/pdf'] },
    txt: { type: 'text/plain', mimes: ['text/plain', 'application/octet-stream'] },
    md: { type: 'text/markdown', mimes: ['text/markdown', 'text/plain', 'application/octet-stream'] },
    markdown: { type: 'text/markdown', mimes: ['text/markdown', 'text/plain', 'application/octet-stream'] },
    csv: { type: 'text/csv', mimes: ['text/csv', 'text/plain', 'application/octet-stream'] },
    doc: { type: 'application/msword', mimes: ['application/msword', 'application/octet-stream'] },
    docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'] },
    xls: { type: 'application/vnd.ms-excel', mimes: ['application/vnd.ms-excel', 'application/octet-stream'] },
    xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'] },
    ppt: { type: 'application/vnd.ms-powerpoint', mimes: ['application/vnd.ms-powerpoint', 'application/octet-stream'] },
    pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream'] },
    mp3: { type: 'audio/mpeg', mimes: ['audio/mpeg', 'audio/mp3', 'application/octet-stream'] },
    m4a: { type: 'audio/mp4', mimes: ['audio/mp4', 'audio/x-m4a', 'application/octet-stream'] },
    wav: { type: 'audio/wav', mimes: ['audio/wav', 'audio/x-wav', 'application/octet-stream'] },
    ogg: { type: 'audio/ogg', mimes: ['audio/ogg', 'application/ogg', 'application/octet-stream'] },
    flac: { type: 'audio/flac', mimes: ['audio/flac', 'application/octet-stream'] },
    mp4: { type: 'video/mp4', mimes: ['video/mp4', 'application/octet-stream'] },
    mov: { type: 'video/quicktime', mimes: ['video/quicktime', 'application/octet-stream'] },
    webm: { type: 'video/webm', mimes: ['video/webm', 'application/octet-stream'] },
    zip: { type: 'application/zip', mimes: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'] },
    rar: { type: 'application/vnd.rar', mimes: ['application/vnd.rar', 'application/x-rar-compressed', 'application/octet-stream'] },
    '7z': { type: 'application/x-7z-compressed', mimes: ['application/x-7z-compressed', 'application/octet-stream'] }
});

function getExtension(name) {
    const base = String(name || '').trim().split(/[\\/]/).pop() || '';
    const match = base.toLowerCase().match(/\.([a-z0-9]{1,12})$/);
    return match ? match[1] : '';
}

function normalizeMime(value) {
    return String(value || '').trim().toLowerCase().split(';', 1)[0];
}

function getMaxFileBytes(value = process.env.ASSET_MAX_FILE_BYTES) {
    if (value === undefined || value === null || value === '') return DEFAULT_MAX_FILE_BYTES;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_FILE_BYTES) {
        return DEFAULT_MAX_FILE_BYTES;
    }
    return Math.min(parsed, MAX_CONFIGURED_FILE_BYTES);
}

function formatLimitMegabytes(bytes) {
    const value = Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function validateFileAssetUpload({ name, type, size, maxBytes = getMaxFileBytes() } = {}) {
    const extension = getExtension(name);
    const policy = FILE_TYPES[extension];
    const bytes = Number(size);
    const mime = normalizeMime(type);
    const limit = Number(maxBytes);

    if (!policy) return { ok: false, error: 'Unsupported file type' };
    if (!Number.isFinite(bytes) || bytes < MIN_FILE_BYTES) return { ok: false, error: 'File body is required' };
    if (!Number.isFinite(limit) || limit < MIN_FILE_BYTES || bytes > limit) {
        return { ok: false, error: `文件超过 ${formatLimitMegabytes(limit)}MB 限制`, status: 413 };
    }
    if (mime && !policy.mimes.includes(mime)) {
        return { ok: false, error: 'File MIME type does not match its extension' };
    }
    return {
        ok: true,
        extension,
        type: mime && mime !== 'application/octet-stream' ? mime : policy.type
    };
}

module.exports = {
    DEFAULT_MAX_FILE_BYTES,
    MAX_CONFIGURED_FILE_BYTES,
    FILE_TYPES,
    getExtension,
    getMaxFileBytes,
    validateFileAssetUpload
};
