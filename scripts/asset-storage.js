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

    async function writeAsset({ id, metadata, original, preview = null }) {
        const safeId = safeAssetId(id);
        if (!safeId) throw new Error('Invalid asset id');
        if (!original?.buffer) throw new Error('Asset original is required');

        if (storage.backend === 's3') {
            const prefix = assetPrefix(safeId);
            const writes = [
                s3.putObject(joinS3Key(prefix, 'original'), original.buffer, original.contentType),
                s3.putObject(joinS3Key(prefix, 'meta.json'), JSON.stringify(metadata, null, 2), 'application/json')
            ];
            if (preview?.buffer) writes.push(s3.putObject(joinS3Key(prefix, 'preview'), preview.buffer, preview.contentType));
            await Promise.all(writes);
            return metadata;
        }

        const target = localAssetDir(safeId);
        await fs.mkdir(target, { recursive: true });
        const writes = [
            fs.writeFile(path.join(target, 'original'), original.buffer),
            fs.writeFile(path.join(target, 'meta.json'), JSON.stringify(metadata, null, 2), 'utf8')
        ];
        if (preview?.buffer) writes.push(fs.writeFile(path.join(target, 'preview'), preview.buffer));
        await Promise.all(writes);
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
            if (variant === 'preview' && !metadata.previewType) return null;
            buffer = await s3.getObjectBuffer(joinS3Key(prefix, variant));
        } else {
            const target = localAssetDir(safeId);
            try {
                metadata = JSON.parse(await fs.readFile(path.join(target, 'meta.json'), 'utf8'));
                if (variant === 'preview' && !metadata.previewType) return null;
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

    function byNewestFirst(a, b) {
        return Number(b?.createdAt || 0) - Number(a?.createdAt || 0);
    }

    async function listAssets() {
        if (storage.backend === 's3') {
            const prefix = joinS3Key(storage.getS3Prefix(), 'assets');
            const objects = await s3.listObjects(prefix);
            const metaKeys = objects
                .map(object => object.key)
                .filter(key => /\/meta\.json$/.test(key));
            const metadatas = await Promise.all(
                metaKeys.map(key => s3.getJSONObject(key, null))
            );
            return metadatas.filter(Boolean).sort(byNewestFirst);
        }

        let entries;
        try {
            entries = await fs.readdir(localRoot, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const metadatas = await Promise.all(
            entries
                .filter(entry => entry.isDirectory() && safeAssetId(entry.name))
                .map(async entry => {
                    try {
                        return JSON.parse(await fs.readFile(path.join(localAssetDir(entry.name), 'meta.json'), 'utf8'));
                    } catch (error) {
                        // A single missing/corrupt meta.json must not break the
                        // whole listing (the panel is a recovery tool for exactly
                        // the kind of orphaned assets that may be malformed).
                        if (error.code !== 'ENOENT') {
                            console.warn(`asset-storage: skipping unreadable asset ${entry.name}:`, error.message);
                        }
                        return null;
                    }
                })
        );
        return metadatas.filter(Boolean).sort(byNewestFirst);
    }

    async function deleteAsset(id) {
        const safeId = safeAssetId(id);
        if (!safeId) return false;

        if (storage.backend === 's3') {
            const prefix = assetPrefix(safeId);
            const metadata = await s3.getJSONObject(joinS3Key(prefix, 'meta.json'), null);
            if (!metadata) return false;
            await Promise.all([
                s3.deleteObject(joinS3Key(prefix, 'original')),
                s3.deleteObject(joinS3Key(prefix, 'preview')),
                s3.deleteObject(joinS3Key(prefix, 'meta.json'))
            ]);
            return true;
        }

        const target = localAssetDir(safeId);
        try {
            await fs.access(path.join(target, 'meta.json'));
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
        await fs.rm(target, { recursive: true, force: true });
        return true;
    }

    async function deleteAssets(ids) {
        // Dedupe first so a caller passing the same id twice can never inflate
        // the deleted count or double-hit the backend.
        const unique = Array.from(new Set(
            (Array.isArray(ids) ? ids : []).map(value => String(value || ''))
        )).filter(Boolean);
        const deleted = [];
        const missing = [];
        for (const rawId of unique) {
            let removed = false;
            try {
                removed = await deleteAsset(rawId);
            } catch (error) {
                // One unreadable/locked asset must not abort the batch; report it
                // as not-removed so the caller can surface a partial result.
                console.warn(`asset-storage: failed to delete asset ${rawId}:`, error.message);
                removed = false;
            }
            if (removed) deleted.push(safeAssetId(rawId));
            else missing.push(rawId);
        }
        return { deleted, missing };
    }

    return { readAsset, writeAsset, listAssets, deleteAsset, deleteAssets };
}

module.exports = { createAssetStorage, safeAssetId };
