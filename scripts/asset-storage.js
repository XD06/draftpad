const fs = require('fs').promises;
const path = require('path');
const s3 = require('./s3-service');

const ASSET_ID_RE = /^[a-f0-9-]{16,64}$/i;

function safeAssetId(id) {
    const value = String(id || '');
    return ASSET_ID_RE.test(value) ? value : '';
}

function joinS3Key(...parts) {
    return parts
        .map(part => String(part || '').replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/');
}

function contentDispositionFilename(name = 'image') {
    return String(name || 'image')
        .replace(/[\\/:*?"<>|\r\n]/g, '_')
        .trim()
        .slice(0, 180) || 'image';
}

function createAssetStorage(storage) {
    const localRoot = path.join(storage.paths.DATA_DIR, 'assets');

    function assetPrefix(id) {
        return joinS3Key(storage.getS3Prefix(), 'assets', id);
    }

    function localAssetDir(id) {
        return path.join(localRoot, id);
    }

    async function writeAsset({ id, metadata, original, preview }) {
        const safeId = safeAssetId(id);
        if (!safeId) throw new Error('Invalid asset id');

        if (storage.backend === 's3') {
            const prefix = assetPrefix(safeId);
            await Promise.all([
                s3.putObject(joinS3Key(prefix, 'original'), original.buffer, original.contentType),
                s3.putObject(joinS3Key(prefix, 'preview'), preview.buffer, preview.contentType),
                s3.putObject(joinS3Key(prefix, 'meta.json'), JSON.stringify(metadata, null, 2), 'application/json')
            ]);
            return metadata;
        }

        const target = localAssetDir(safeId);
        await fs.mkdir(target, { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(target, 'original'), original.buffer),
            fs.writeFile(path.join(target, 'preview'), preview.buffer),
            fs.writeFile(path.join(target, 'meta.json'), JSON.stringify(metadata, null, 2), 'utf8')
        ]);
        return metadata;
    }

    async function readAsset(id, variant = 'preview') {
        const safeId = safeAssetId(id);
        if (!safeId || !['preview', 'original'].includes(variant)) return null;

        let metadata;
        let buffer;
        if (storage.backend === 's3') {
            const prefix = assetPrefix(safeId);
            metadata = await s3.getJSONObject(joinS3Key(prefix, 'meta.json'), null);
            if (!metadata) return null;
            buffer = await s3.getObjectBuffer(joinS3Key(prefix, variant));
        } else {
            const target = localAssetDir(safeId);
            try {
                metadata = JSON.parse(await fs.readFile(path.join(target, 'meta.json'), 'utf8'));
                buffer = await fs.readFile(path.join(target, variant));
            } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error;
            }
        }

        if (!buffer) return null;
        const contentType = variant === 'preview'
            ? String(metadata.previewType || 'image/webp')
            : String(metadata.type || 'application/octet-stream');
        return {
            id: safeId,
            metadata,
            buffer,
            contentType,
            filename: contentDispositionFilename(metadata.name)
        };
    }

    return { readAsset, writeAsset };
}

module.exports = { createAssetStorage, safeAssetId };
