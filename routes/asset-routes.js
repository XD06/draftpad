const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const { createAssetStorage, safeAssetId } = require('../scripts/asset-storage');
const { getMaxFileBytes, validateFileAssetUpload } = require('../scripts/file-asset-policy');

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100 * 1000 * 1000;
const PREVIEW_EDGE = 2560;
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

function createAssetId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(20).toString('hex');
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
        previewUrl: metadata.previewType ? `/api/assets/${id}/preview` : null,
        originalUrl: `/api/assets/${id}/original`,
        downloadUrl: `/api/assets/${id}/download`
    };
}

function registerAssetRoutes(app, { storage, originValidationMiddleware }) {
    const assets = createAssetStorage(storage);
    const maxFileBytes = getMaxFileBytes();

    app.post(
        '/api/assets/images',
        originValidationMiddleware,
        express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
        async (req, res) => {
            const input = Buffer.isBuffer(req.body) ? req.body : null;
            if (!input?.length) return res.status(400).json({ error: 'Image body is required' });

            try {
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
                    name: requestedName || `image.${ext}`,
                    type,
                    size: input.length,
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
        express.raw({ type: 'application/octet-stream', limit: maxFileBytes }),
        async (req, res) => {
            const input = Buffer.isBuffer(req.body) ? req.body : null;
            const requestedName = decodeAssetName(req.get('x-asset-name'));
            const validation = validateFileAssetUpload({
                name: requestedName,
                type: req.get('x-asset-type'),
                size: input?.length || 0,
                maxBytes: maxFileBytes
            });
            if (!validation.ok) return res.status(validation.status || 415).json({ error: validation.error });

            try {
                const id = createAssetId();
                const metadata = {
                    version: 1,
                    kind: 'file',
                    id,
                    name: requestedName,
                    type: validation.type,
                    size: input.length,
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
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.type(asset.contentType);
            if (req.params.variant === 'download' || asset.metadata?.kind === 'file') {
                res.attachment(asset.filename);
            } else {
                res.setHeader('Content-Disposition', 'inline');
            }
            res.send(asset.buffer);
        } catch (error) {
            console.error('Failed to read image asset:', error);
            res.status(500).json({ error: 'Unable to read image asset' });
        }
    });
}

module.exports = { MAX_IMAGE_BYTES, registerAssetRoutes, responseAsset };
