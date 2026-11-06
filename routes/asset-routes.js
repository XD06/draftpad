const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const { createAssetStorage, safeAssetId } = require('../scripts/asset-storage');
const { getMaxFileBytes, validateFileAssetUpload, FILE_TYPES } = require('../scripts/file-asset-policy');

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100 * 1000 * 1000;
const PREVIEW_EDGE = 2560;
const DEFAULT_ASSET_PAGE_SIZE = 50;
const MAX_ASSET_PAGE_SIZE = 100;
const MIME_BY_FORMAT = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif'
};

function decodeAssetName(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch {
        return '';
    }
}

/**
 * 单段 Range 头（bytes=a-b / bytes=a- / bytes=-n）→ { start, end }。
 * 无法解析、越界或多段请求一律返回 null（调用方回退 200 全量，RFC 允许忽略 Range）。
 */
function parseByteRange(header, totalLength) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!match || (match[1] === '' && match[2] === '')) return null;
    let start;
    let end;
    if (match[1] === '') {
        const suffix = Number(match[2]);
        if (!Number.isInteger(suffix) || suffix <= 0) return null;
        start = Math.max(0, totalLength - suffix);
        end = totalLength - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? totalLength - 1 : Number(match[2]);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= totalLength) return null;
    return { start, end: Math.min(end, totalLength - 1) };
}

function createAssetId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(20).toString('hex');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 只有「文本类普通文件」的字节可以原地改写：图片带 preview 变体（改 original
// 会让预览失真），音视频/压缩包是二进制。白名单直接取自上传策略里 type 以
// text/ 开头的扩展名（txt / md / markdown / csv），与 /api/assets/files 同源。
const TEXT_CONTENT_EXTENSIONS = new Set(
    Object.entries(FILE_TYPES)
        .filter(([, policy]) => String(policy.type).startsWith('text/'))
        .map(([ext]) => ext)
);

function isEditableTextAsset(metadata) {
    if (!metadata || String(metadata.kind || 'image') !== 'file') return false;
    const base = String(metadata.name || '').trim().split(/[\\/]/).pop() || '';
    const ext = base.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] || '';
    return TEXT_CONTENT_EXTENSIONS.has(ext);
}

function contentVersionOf(metadata) {
    const value = Number(metadata?.contentVersion);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

// 与 storage.withNotepadWriteLock 同形的进程内串行化：同一资产 id 的
// 读-改-写必须排队，否则两个并发 PUT 会各自读到同一个 contentVersion 并
// 双双通过 baseVersion 校验，409 就形同虚设。
const contentWriteLocks = new Map();
function withAssetContentLock(id, task) {
    const previous = contentWriteLocks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    contentWriteLocks.set(id, next);
    next.finally(() => {
        if (contentWriteLocks.get(id) === next) contentWriteLocks.delete(id);
    }).catch(() => {});
    return next;
}

function responseAsset(metadata) {
    const id = metadata.id;
    return {
        id,
        assetId: id,
        name: metadata.name,
        type: metadata.type,
        size: metadata.size,
        kind: metadata.kind || 'image',
        createdAt: Number(metadata.createdAt) || null,
        previewUrl: metadata.previewType ? `/api/assets/${id}/preview` : null,
        originalUrl: `/api/assets/${id}/original`,
        downloadUrl: `/api/assets/${id}/download`
    };
}

function compareAssets(left, right) {
    return Number(right?.createdAt || 0) - Number(left?.createdAt || 0)
        || String(right?.id || '').localeCompare(String(left?.id || ''));
}

function encodeAssetCursor(asset) {
    return Buffer.from(JSON.stringify({
        createdAt: Number(asset?.createdAt || 0),
        id: String(asset?.id || '')
    })).toString('base64url');
}

function decodeAssetCursor(value) {
    try {
        const decoded = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
        if (!Number.isFinite(Number(decoded?.createdAt)) || !safeAssetId(decoded?.id)) return null;
        return { createdAt: Number(decoded.createdAt), id: String(decoded.id) };
    } catch {
        return null;
    }
}

function registerAssetRoutes(app, { storage, originValidationMiddleware, maxFileBytes }) {
    const assets = createAssetStorage(storage);
    const fileByteLimit = getMaxFileBytes(maxFileBytes);

    app.post(
        '/api/assets/images',
        originValidationMiddleware,
        express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
        async (req, res) => {
            const input = Buffer.isBuffer(req.body) ? req.body : null;
            if (!input?.length) return res.status(400).json({ error: 'Image body is required' });

            try {
                // Dedupe identical bytes against an already-stored image so a
                // re-upload from the UI/API reuses the existing asset instead of
                // creating a second copy (and skips the expensive re-encode).
                const hash = sha256(input);
                const duplicate = await assets.findByHash(hash, 'image');
                if (duplicate) return res.status(200).json(responseAsset(duplicate));

                const image = sharp(input, { animated: false, limitInputPixels: MAX_IMAGE_PIXELS });
                const info = await image.metadata();
                const type = MIME_BY_FORMAT[info.format];
                if (!type) return res.status(415).json({ error: 'Unsupported image format' });

                const previewBuffer = await sharp(input, { animated: false, limitInputPixels: MAX_IMAGE_PIXELS })
                    .rotate()
                    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 82, effort: 4 })
                    .toBuffer();
                const id = createAssetId();
                const ext = info.format === 'jpeg' ? 'jpg' : info.format;
                const requestedName = decodeAssetName(req.get('x-asset-name'));
                const metadata = {
                    version: 1,
                    id,
                    // Create path only: disambiguate a name another image
                    // asset already holds (including the "image.${ext}"
                    // fallback); the dedupe branch above must never rename.
                    name: await assets.uniqueName(requestedName || `image.${ext}`, 'image'),
                    type,
                    size: input.length,
                    hash,
                    previewType: 'image/webp',
                    previewSize: previewBuffer.length,
                    width: Number(info.width || 0),
                    height: Number(info.height || 0),
                    createdAt: Date.now()
                };

                await assets.writeAsset({
                    id,
                    metadata,
                    original: { buffer: input, contentType: type },
                    preview: { buffer: previewBuffer, contentType: 'image/webp' }
                });
                res.status(201).json(responseAsset(metadata));
            } catch (error) {
                if (/Input.*image|unsupported image|unsupported input/i.test(error.message || '')) {
                    return res.status(415).json({ error: 'Invalid image data' });
                }
                console.error('Failed to store image asset:', error);
                res.status(500).json({ error: 'Unable to store image asset' });
            }
        }
    );

    app.post(
        '/api/assets/files',
        originValidationMiddleware,
        express.raw({ type: 'application/octet-stream', limit: fileByteLimit }),
        async (req, res) => {
            const input = Buffer.isBuffer(req.body) ? req.body : null;
            const requestedName = decodeAssetName(req.get('x-asset-name'));
            const validation = validateFileAssetUpload({
                name: requestedName,
                type: req.get('x-asset-type'),
                size: input?.length || 0,
                maxBytes: fileByteLimit
            });
            if (!validation.ok) return res.status(validation.status || 415).json({ error: validation.error });

            try {
                // Dedupe identical bytes against an already-stored file so a
                // re-upload reuses the existing asset instead of duplicating it.
                const hash = sha256(input);
                const duplicate = await assets.findByHash(hash, 'file');
                if (duplicate) return res.status(200).json(responseAsset(duplicate));

                const id = createAssetId();
                const metadata = {
                    version: 1,
                    kind: 'file',
                    id,
                    // Create path only: disambiguate a name another file
                    // asset already holds; the dedupe branch above must
                    // never rename.
                    name: await assets.uniqueName(requestedName, 'file'),
                    type: validation.type,
                    size: input.length,
                    hash,
                    createdAt: Date.now()
                };
                await assets.writeAsset({
                    id,
                    metadata,
                    original: { buffer: input, contentType: validation.type }
                });
                res.status(201).json(responseAsset(metadata));
            } catch (error) {
                console.error('Failed to store file asset:', error);
                res.status(500).json({ error: 'Unable to store file asset' });
            }
        }
    );

    app.get('/api/assets', async (req, res) => {
        const kind = req.query.kind === undefined ? '' : String(req.query.kind).toLowerCase();
        if (kind && !['image', 'file'].includes(kind)) {
            return res.status(400).json({ error: 'kind must be image or file', code: 'INVALID_ASSET_KIND' });
        }
        const hasPageRequest = req.query.limit !== undefined || req.query.cursor !== undefined;
        const rawLimit = req.query.limit === undefined ? DEFAULT_ASSET_PAGE_SIZE : Number.parseInt(req.query.limit, 10);
        if (hasPageRequest && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
            return res.status(400).json({ error: 'limit must be a positive integer', code: 'INVALID_ASSET_LIMIT' });
        }
        const cursor = req.query.cursor === undefined ? null : decodeAssetCursor(req.query.cursor);
        if (req.query.cursor !== undefined && !cursor) {
            return res.status(400).json({ error: 'cursor is invalid', code: 'INVALID_ASSET_CURSOR' });
        }
        try {
            let list = await assets.listAssets();
            list = list
                .filter(asset => !kind || String(asset?.kind || 'image') === kind)
                .sort(compareAssets);
            if (cursor) {
                list = list.filter(asset => Number(asset?.createdAt || 0) < cursor.createdAt
                    || (Number(asset?.createdAt || 0) === cursor.createdAt && String(asset?.id || '').localeCompare(cursor.id) < 0));
            }
            if (!hasPageRequest) return res.json({ assets: list.map(responseAsset) });

            const limit = Math.min(rawLimit, MAX_ASSET_PAGE_SIZE);
            const hasMore = list.length > limit;
            const page = list.slice(0, limit);
            res.json({
                assets: page.map(responseAsset),
                hasMore,
                nextCursor: hasMore && page.length ? encodeAssetCursor(page[page.length - 1]) : null
            });
        } catch (error) {
            console.error('Failed to list assets:', error);
            res.status(500).json({ error: 'Unable to list assets' });
        }
    });

    app.post('/api/assets/bulk-delete', originValidationMiddleware, express.json({ limit: '256kb' }), async (req, res) => {
        const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
        if (!rawIds || rawIds.length === 0) {
            return res.status(400).json({ error: 'An ids array is required' });
        }
        if (rawIds.length > 1000) {
            return res.status(413).json({ error: 'Too many assets requested for deletion' });
        }
        try {
            const result = await assets.deleteAssets(rawIds);
            res.json({ success: true, deleted: result.deleted, missing: result.missing });
        } catch (error) {
            console.error('Failed to bulk delete assets:', error);
            res.status(500).json({ error: 'Unable to delete assets' });
        }
    });

    app.delete('/api/assets/:id', originValidationMiddleware, async (req, res) => {
        const id = safeAssetId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Asset not found' });
        try {
            const deleted = await assets.deleteAsset(id);
            if (!deleted) return res.status(404).json({ error: 'Asset not found' });
            res.json({ success: true, id });
        } catch (error) {
            console.error('Failed to delete asset:', error);
            res.status(500).json({ error: 'Unable to delete asset' });
        }
    });

    // 文本类附件的「读接口」：把字节解成 UTF-8 文本并带出乐观并发版本。
    // 必须 no-store —— 通用变体路由给的是 immutable 一年缓存，原地改写后
    // 复用同一个 URL 会读到浏览器缓存里的旧字节。
    app.get('/api/assets/:id/content', async (req, res) => {
        const id = safeAssetId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Asset not found' });
        try {
            const metadata = await assets.readMetadata(id);
            if (!metadata) return res.status(404).json({ error: 'Asset not found' });
            if (!isEditableTextAsset(metadata)) {
                return res.status(415).json({ error: 'Asset type does not support content editing' });
            }
            const asset = await assets.readAsset(id, 'original');
            if (!asset) return res.status(404).json({ error: 'Asset not found' });
            res.setHeader('Cache-Control', 'no-store, private');
            res.json({
                id,
                name: metadata.name,
                type: metadata.type,
                size: Number(metadata.size) || asset.buffer.length,
                contentVersion: contentVersionOf(metadata),
                content: asset.buffer.toString('utf8')
            });
        } catch (error) {
            console.error('Failed to read asset content:', error);
            res.status(500).json({ error: 'Unable to read asset content' });
        }
    });

    // 文本类附件的「原地保存」：body 是 UTF-8 原文（与 /api/assets/files 的
    // raw body + X-Asset-* 头同形），X-Asset-Base-Version 用于乐观并发。
    // 409 语义照抄 note-routes.js 的 POST /api/notes/:id：版本落后就拒绝，
    // 前端复用 app.js:3044-3101 的合并 / 冲突 toast / 保留输入分支。
    app.put(
        '/api/assets/:id/content',
        originValidationMiddleware,
        express.raw({ type: ['text/plain', 'text/markdown', 'application/octet-stream'], limit: fileByteLimit }),
        async (req, res) => {
            const id = safeAssetId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Asset not found' });
            const input = Buffer.isBuffer(req.body) ? req.body : null;
            if (!input) return res.status(400).json({ error: 'Text body is required' });
            // 与 file-asset-policy.js 的 MIN_FILE_BYTES 一致：不产生 0 字节资产。
            if (input.length === 0) return res.status(400).json({ error: 'Text body is required' });
            if (input.length > fileByteLimit) {
                return res.status(413).json({ error: 'Asset content exceeds the size limit' });
            }
            let content;
            try {
                content = new TextDecoder('utf-8', { fatal: true }).decode(input);
            } catch {
                return res.status(400).json({ error: 'Asset content must be valid UTF-8' });
            }
            const rawVersion = req.get('x-asset-base-version');
            const clientVersion = rawVersion === undefined || rawVersion === '' ? null : Number(rawVersion);
            if (clientVersion !== null && (!Number.isInteger(clientVersion) || clientVersion < 0)) {
                return res.status(400).json({ error: 'X-Asset-Base-Version must be a non-negative integer' });
            }

            try {
                const result = await withAssetContentLock(id, async () => {
                    const metadata = await assets.readMetadata(id);
                    if (!metadata) return { status: 404, body: { error: 'Asset not found' } };
                    if (!isEditableTextAsset(metadata)) {
                        return { status: 415, body: { error: 'Asset type does not support content editing' } };
                    }
                    const currentVersion = contentVersionOf(metadata);
                    const existing = await assets.readAsset(id, 'original');
                    const currentContent = existing ? existing.buffer.toString('utf8') : '';
                    // 与 note-routes.js:104-106 一致：内容没变就不计版本、不刷新时间。
                    if (currentContent === content) {
                        return { status: 200, body: { success: true, unchanged: true, contentVersion: currentVersion, size: input.length } };
                    }
                    if (clientVersion !== null && clientVersion !== currentVersion) {
                        return { status: 409, body: { error: 'Asset content has been updated on another device', currentVersion } };
                    }
                    const nextVersion = currentVersion + 1;
                    await assets.writeAsset({
                        id,
                        metadata: {
                            ...metadata,
                            size: input.length,
                            hash: sha256(input),
                            contentVersion: nextVersion,
                            updatedAt: Date.now()
                        },
                        original: { buffer: input, contentType: String(metadata.type || 'text/plain') }
                    });
                    return { status: 200, body: { success: true, unchanged: false, contentVersion: nextVersion, size: input.length } };
                });
                return res.status(result.status).json(result.body);
            } catch (error) {
                console.error('Failed to write asset content:', error);
                return res.status(500).json({ error: 'Unable to write asset content' });
            }
        }
    );

    app.get('/api/assets/:id/:variant', async (req, res) => {
        const id = safeAssetId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Asset not found' });
        if (!['preview', 'original', 'download'].includes(req.params.variant)) {
            return res.status(404).json({ error: 'Asset not found' });
        }
        const requestedVariant = req.params.variant === 'download' ? 'original' : req.params.variant;

        try {
            const asset = await assets.readAsset(id, requestedVariant);
            if (!asset) return res.status(404).json({ error: 'Asset not found' });
            const isMediaAsset = /^(video|audio)\//i.test(asset.contentType || '');
            // 'private' keeps shared caches (reverse proxies/CDNs) from
            // serving one account's authenticated asset responses to another;
            // browser caching behaviour is unaffected.
            // 文本类附件可被 /content 原地改写，不能再声明 immutable，否则保存后
            // 下载同一个 URL 会命中浏览器缓存里的旧字节。
            res.setHeader('Cache-Control', isEditableTextAsset(asset.metadata)
                ? 'no-store, private'
                : 'private, max-age=31536000, immutable');
            res.type(asset.contentType);
            // 媒体文件必须 inline 供 <video>/<audio> 引用，其余文件维持
            // attachment（download 变体永远强制下载）。
            if (req.params.variant === 'download' || (asset.metadata?.kind === 'file' && !isMediaAsset)) {
                res.attachment(asset.filename);
            } else {
                res.setHeader('Content-Disposition', 'inline');
            }
            if (isMediaAsset && req.params.variant !== 'download') {
                // 原生播放器（尤其 iOS Safari）靠 Range 请求探测与拖动进度；
                // 媒体资产支持 206 分段响应，普通文件与 download 变体不启用。
                res.setHeader('Accept-Ranges', 'bytes');
                const range = parseByteRange(req.get('range'), asset.buffer.length);
                if (range) {
                    res.status(206);
                    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${asset.buffer.length}`);
                    res.setHeader('Content-Length', String(range.end - range.start + 1));
                    return res.end(asset.buffer.subarray(range.start, range.end + 1));
                }
            }
            res.send(asset.buffer);
        } catch (error) {
            console.error('Failed to read image asset:', error);
            res.status(500).json({ error: 'Unable to read image asset' });
        }
    });
}

module.exports = { MAX_IMAGE_BYTES, MAX_ASSET_PAGE_SIZE, registerAssetRoutes, responseAsset };
