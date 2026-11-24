/**
 * 附件改名与跨文档引用同步服务：负责扩展名安全规范化校验，以及将资产新名称
 * 同步更新到引用该资产的文章 Markdown（图片 alt、音视频、文件胶囊）与 Thoughts 附件列表，
 * 在不改变不可变资产 URL 的前提下保证各端展示与下载文件名一致。
 */
'use strict';

const { FILE_TYPES, getExtension } = require('./file-asset-policy');

const IMAGE_MIME_EXTENSIONS = Object.freeze({
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'image/webp': ['webp'],
    'image/avif': ['avif'],
    'image/gif': ['gif']
});

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdownLabel(value) {
    return String(value || '文件').replace(/[\[\]\\]/g, '\\$&');
}

function safeTitlePart(value) {
    return encodeURIComponent(String(value || '').trim().slice(0, 120));
}

function formatFileSize(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function readTitleParam(title = '', key = '') {
    const match = String(title || '').match(new RegExp(`(?:^|;)${escapeRegExp(key)}=([^;]*)`));
    if (!match) return '';
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

function cleanRequestedName(rawName) {
    if (typeof rawName !== 'string') return '';
    const cleaned = rawName
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\.+$/, '');
    if (!cleaned || cleaned === '.' || cleaned === '..') return '';
    return cleaned;
}

function splitNameParts(name) {
    const dot = name.lastIndexOf('.');
    if (dot === 0) return { base: '', ext: name.slice(1) };
    if (dot < 0 || dot === name.length - 1) return { base: name, ext: '' };
    return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * 校验并规范化附件新名称：
 * - 若用户未填写扩展名，自动保留原扩展名；
 * - 图片（kind !== 'file'）只允许保持同编码对应的扩展名（如 jpg <-> jpeg）；
 * - 文件（kind === 'file'）禁止改名到不兼容或未列入白名单的格式；兼容文本类型互相改名时同步 MIME。
 */
function normalizeRenamedFilename({ requestedName, currentName = '', kind = 'image', mimeType = '' } = {}) {
    const cleaned = cleanRequestedName(requestedName);
    if (!cleaned) {
        return { ok: false, status: 400, error: '附件名称不能为空' };
    }

    const currentExt = getExtension(currentName);
    const { base, ext } = splitNameParts(cleaned);
    if (!base) {
        return { ok: false, status: 400, error: '文件名主干不能为空' };
    }

    const safeStem = base.slice(0, 160).trim();
    if (!safeStem) {
        return { ok: false, status: 400, error: '附件名称不能为空' };
    }

    if (!ext) {
        const finalName = currentExt ? `${safeStem}.${currentExt}` : safeStem;
        return { ok: true, name: finalName, extension: currentExt, type: String(mimeType || '') };
    }

    const nextExt = ext.toLowerCase();
    const curExt = currentExt.toLowerCase();
    if (!curExt || nextExt === curExt) {
        return { ok: true, name: `${safeStem}.${ext}`, extension: nextExt, type: String(mimeType || '') };
    }

    const normalizedMime = String(mimeType || '').toLowerCase().split(';', 1)[0].trim();
    if (kind !== 'file') {
        const allowedImageExts = IMAGE_MIME_EXTENSIONS[normalizedMime] || [];
        if (allowedImageExts.includes(nextExt)) {
            return { ok: true, name: `${safeStem}.${ext}`, extension: nextExt, type: normalizedMime };
        }
        return { ok: false, status: 400, error: '图片附件不支持更改为其他格式扩展名' };
    }

    const nextPolicy = FILE_TYPES[nextExt];
    if (!nextPolicy) {
        return { ok: false, status: 400, error: '不支持修改为该文件扩展名' };
    }

    const curPolicy = curExt ? FILE_TYPES[curExt] : null;
    const effectiveMime = normalizedMime && normalizedMime !== 'application/octet-stream'
        ? normalizedMime
        : String(curPolicy?.type || '').toLowerCase();
    const bothText = effectiveMime.startsWith('text/') && String(nextPolicy.type || '').startsWith('text/');
    const sameCategoryMime = Boolean(
        (effectiveMime && nextPolicy.mimes.includes(effectiveMime))
        || (curPolicy && curPolicy.type === nextPolicy.type)
    );
    if (!bothText && !sameCategoryMime) {
        return { ok: false, status: 400, error: '不能将扩展名更改为不兼容的文件类型' };
    }

    return {
        ok: true,
        name: `${safeStem}.${ext}`,
        extension: nextExt,
        type: nextPolicy.type || effectiveMime || normalizedMime
    };
}

/**
 * 替换文章 Markdown 中引用指定 assetId 的附件名称与元数据：
 * 覆盖文件胶囊（dumbpad-file=1 及无 title 的 /download 链接）、音视频（dumbpad-video/audio=1）
 * 以及文章图片（alt）。不触碰其他资产链接或非附件引用。
 */
function rewriteArticleAssetReferences(markdown, asset = {}) {
    const source = String(markdown ?? '');
    const assetId = String(asset?.id || '').trim();
    if (!source || !assetId || !source.includes(`/api/assets/${assetId}/`)) {
        return source;
    }

    const escapedId = escapeRegExp(assetId);
    const pattern = new RegExp(
        `(!?)\\[((?:\\\\.|[^\\]\\r\\n])*)\\]\\((\\/api\\/assets\\/${escapedId}\\/(?:preview|original|download)(?:\\?[^)\\s"]*)?)(?:\\s+"((?:\\\\.|[^"\\r\\n])*)")?\\)`,
        'g'
    );

    const nextName = String(asset.name || '文件');
    const escapedLabel = escapeMarkdownLabel(nextName);

    return source.replace(pattern, (full, bang, label, url, title) => {
        const rawTitle = String(title || '');
        if (bang === '!') {
            if (rawTitle.startsWith('dumbpad-video=1') || rawTitle.startsWith('dumbpad-audio=1')) {
                const kind = rawTitle.startsWith('dumbpad-audio=1') ? 'audio' : 'video';
                const prefix = kind === 'audio' ? 'dumbpad-audio=1' : 'dumbpad-video=1';
                const size = Math.max(0, Number(readTitleParam(rawTitle, 'size')) || Number(asset.size) || 0);
                const type = String(asset.type || readTitleParam(rawTitle, 'type') || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4'));
                const nextTitle = `${prefix};size=${size};type=${safeTitlePart(type)};name=${safeTitlePart(nextName)}`;
                return `![${escapedLabel} · ${formatFileSize(size)}](${url} "${nextTitle}")`;
            }
            const titlePart = rawTitle ? ` "${rawTitle}"` : '';
            return `![${escapedLabel}](${url}${titlePart})`;
        }

        if (rawTitle.startsWith('dumbpad-file=1')) {
            const size = Math.max(0, Number(readTitleParam(rawTitle, 'size')) || Number(asset.size) || 0);
            const type = String(asset.type || readTitleParam(rawTitle, 'type') || 'application/octet-stream');
            const nextTitle = `dumbpad-file=1;size=${size};type=${safeTitlePart(type)};name=${safeTitlePart(nextName)}`;
            return `[${escapedLabel} · ${formatFileSize(size)}](${url} "${nextTitle}")`;
        }

        if (/\/download(?:$|\?)/i.test(url)) {
            const sizeSuffix = label.match(/( · \d+(?:\.\d+)? (?:B|KB|MB))$/)?.[1] || '';
            return `[${escapedLabel}${sizeSuffix}](${url})`;
        }

        return full;
    });
}

function thoughtAttachmentMatchesAsset(attachment, assetId) {
    if (!attachment || typeof attachment !== 'object') return false;
    if (String(attachment.assetId || '') === assetId) return true;
    const urls = [attachment.originalUrl, attachment.downloadUrl, attachment.previewUrl, attachment.url];
    const re = new RegExp(`^\\/api\\/assets\\/${escapeRegExp(assetId)}\\/(?:preview|original|download)(?:$|[?#])`, 'i');
    return urls.some(url => re.test(String(url || '')));
}

async function syncRenamedAssetReferences({
    storage,
    asset,
    actorId = 'asset-rename',
    broadcastUpdate = () => {},
    broadcastThoughtsUpdate = () => {},
    scheduleIndexNotepads = () => {}
}) {
    if (!storage || !asset?.id) return { updatedNoteIds: [], updatedThoughtIds: [] };

    const updatedThoughtIds = [];
    if (typeof storage.withThoughtWriteLock === 'function' && typeof storage.readThoughts === 'function' && typeof storage.writeThought === 'function') {
        const updatedThoughts = await storage.withThoughtWriteLock(async () => {
            const thoughts = await storage.readThoughts();
            const changed = [];
            for (const thought of Array.isArray(thoughts) ? thoughts : []) {
                const attachments = Array.isArray(thought?.attachments) ? thought.attachments : [];
                let touched = false;
                const nextAttachments = attachments.map((att) => {
                    if (!thoughtAttachmentMatchesAsset(att, asset.id)) return att;
                    if (att.name === asset.name && (!asset.type || att.type === asset.type)) return att;
                    touched = true;
                    return {
                        ...att,
                        name: asset.name,
                        ...(asset.type ? { type: asset.type } : {})
                    };
                });
                if (!touched) continue;
                const nextThought = {
                    ...thought,
                    attachments: nextAttachments,
                    updatedAt: Date.now()
                };
                await storage.writeThought(nextThought);
                changed.push(nextThought);
            }
            return changed;
        });
        for (const thought of updatedThoughts) {
            updatedThoughtIds.push(thought.id);
            broadcastThoughtsUpdate('update', thought);
        }
    }

    const updatedNoteIds = [];
    const updatedNotesMeta = [];
    if (
        typeof storage.withNotepadWriteLock === 'function'
        && typeof storage.readNotepadsMeta === 'function'
        && typeof storage.readNoteContent === 'function'
        && typeof storage.writeNoteContent === 'function'
        && typeof storage.saveNotepadsMeta === 'function'
    ) {
        const updatedNotes = await storage.withNotepadWriteLock(async () => {
            const data = await storage.readNotepadsMeta();
            const notepads = Array.isArray(data?.notepads) ? data.notepads : [];
            const changed = [];
            let metaChanged = false;
            for (const notepad of notepads) {
                if (!notepad?.id) continue;
                const content = await storage.readNoteContent(notepad);
                const nextContent = rewriteArticleAssetReferences(content, asset);
                if (nextContent === content) continue;
                await storage.writeNoteContent(notepad, nextContent);
                notepad.version = (notepad.version || 1) + 1;
                notepad.updatedAt = Date.now();
                metaChanged = true;
                changed.push({ id: notepad.id, content: nextContent, version: notepad.version, updatedAt: notepad.updatedAt });
            }
            if (metaChanged) {
                await storage.saveNotepadsMeta(data);
            }
            return changed;
        });
        for (const note of updatedNotes) {
            updatedNoteIds.push(note.id);
            updatedNotesMeta.push({ id: note.id, version: note.version });
            broadcastUpdate(note.id, note.content, actorId, note.version, {
                updatedAt: note.updatedAt,
                source: 'asset_rename'
            });
        }
    }

    if (updatedNoteIds.length > 0 || updatedThoughtIds.length > 0) {
        scheduleIndexNotepads();
    }

    return { updatedNotes: updatedNotesMeta, updatedNoteIds, updatedThoughtIds };
}

module.exports = {
    normalizeRenamedFilename,
    rewriteArticleAssetReferences,
    syncRenamedAssetReferences,
    thoughtAttachmentMatchesAsset
};
