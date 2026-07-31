const assert = require('assert');
const express = require('express');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { registerAssetRoutes } = require('../routes/asset-routes');

async function run() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dumbpad-assets-'));
    const app = express();
    registerAssetRoutes(app, {
        storage: {
            backend: 'local',
            paths: { DATA_DIR: dataDir },
            getS3Prefix: () => ''
        },
        originValidationMiddleware: (_req, _res, next) => next()
    });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const original = await sharp({
            create: { width: 32, height: 20, channels: 3, background: '#ffcc00' }
        }).png().toBuffer();
        const upload = await fetch(`${baseUrl}/api/assets/images`, {
            method: 'POST',
            headers: {
                'content-type': 'image/png',
                'x-asset-name': encodeURIComponent('原图.png')
            },
            body: original
        });
        assert.strictEqual(upload.status, 201, 'valid image should be accepted');
        const asset = await upload.json();
        assert.match(asset.id, /^[a-f0-9-]{16,64}$/i, 'asset id should be safe and opaque');
        assert.strictEqual(asset.name, '原图.png');
        assert.strictEqual(asset.type, 'image/png');

        const preview = await fetch(`${baseUrl}${asset.previewUrl}`);
        assert.strictEqual(preview.status, 200);
        assert.strictEqual(preview.headers.get('content-type'), 'image/webp');
        assert.strictEqual((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format, 'webp');

        const originalResponse = await fetch(`${baseUrl}${asset.originalUrl}`);
        assert.strictEqual(originalResponse.status, 200);
        assert.deepStrictEqual(Buffer.from(await originalResponse.arrayBuffer()), original, 'original endpoint must preserve upload bytes');

        const download = await fetch(`${baseUrl}${asset.downloadUrl}`);
        assert.match(download.headers.get('content-disposition') || '', /attachment/i, 'download should force attachment behavior');

        const invalid = await fetch(`${baseUrl}/api/assets/images`, {
            method: 'POST',
            headers: { 'content-type': 'image/png' },
            body: Buffer.from('not an image')
        });
        assert.strictEqual(invalid.status, 415, 'invalid image bytes should be rejected');

        const fileBytes = Buffer.from('%PDF-1.4 demo document');
        const fileUpload = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('计划.pdf'),
                'x-asset-type': 'application/pdf'
            },
            body: fileBytes
        });
        assert.strictEqual(fileUpload.status, 201, 'an allowed ordinary file should be accepted');
        const fileAsset = await fileUpload.json();
        assert.strictEqual(fileAsset.kind, 'file');
        assert.strictEqual(fileAsset.previewUrl, null, 'ordinary files should not claim an image preview');

        const fileOriginal = await fetch(`${baseUrl}${fileAsset.originalUrl}`);
        assert.strictEqual(fileOriginal.status, 200);
        assert.match(fileOriginal.headers.get('content-disposition') || '', /attachment/i, 'ordinary file originals must force download');
        assert.deepStrictEqual(Buffer.from(await fileOriginal.arrayBuffer()), fileBytes, 'ordinary file bytes must round-trip unchanged');

        const rejectedFile = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('unsafe.html'),
                'x-asset-type': 'text/html'
            },
            body: Buffer.from('<script>alert(1)</script>')
        });
        assert.strictEqual(rejectedFile.status, 415, 'HTML uploads must be rejected');

        const list = await fetch(`${baseUrl}/api/assets`);
        assert.strictEqual(list.status, 200, 'GET /api/assets should list stored assets');
        const listBody = await list.json();
        assert(Array.isArray(listBody.assets), 'asset listing should return an assets array');
        assert(listBody.assets.some(item => item.id === asset.id), 'the uploaded image should appear in the listing');
        assert(listBody.assets.some(item => item.id === fileAsset.id), 'the uploaded file should appear in the listing');
        const listedImage = listBody.assets.find(item => item.id === asset.id);
        assert.strictEqual(listedImage.previewUrl, `/api/assets/${asset.id}/preview`, 'listed images should expose a preview URL');
        assert(Number.isFinite(listedImage.createdAt) && listedImage.createdAt > 0, 'listed assets should expose a numeric createdAt for the panel timestamp');

        const deleteMissing = await fetch(`${baseUrl}/api/assets/deadbeef`, { method: 'DELETE' });
        assert.strictEqual(deleteMissing.status, 404, 'deleting an unsafe id should 404');

        const deleted = await fetch(`${baseUrl}/api/assets/${fileAsset.id}`, { method: 'DELETE' });
        assert.strictEqual(deleted.status, 200, 'deleting an existing asset should succeed');
        const afterDelete = await fetch(`${baseUrl}${fileAsset.originalUrl}`);
        assert.strictEqual(afterDelete.status, 404, 'a deleted asset original should no longer be served');
        const listAfter = await fetch(`${baseUrl}/api/assets`);
        const listAfterBody = await listAfter.json();
        assert(!listAfterBody.assets.some(item => item.id === fileAsset.id), 'a deleted asset must disappear from the listing');
        const deleteAgain = await fetch(`${baseUrl}/api/assets/${fileAsset.id}`, { method: 'DELETE' });
        assert.strictEqual(deleteAgain.status, 404, 'deleting an already-removed asset should 404');

        // Bulk delete: upload two fresh files and remove them (plus a duplicate and a
        // non-existent id) in a single request to prove partial-result reporting.
        const bulkOne = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('批量一.pdf'),
                'x-asset-type': 'application/pdf'
            },
            body: Buffer.from('%PDF-1.4 bulk one')
        });
        const bulkTwo = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('批量二.pdf'),
                'x-asset-type': 'application/pdf'
            },
            body: Buffer.from('%PDF-1.4 bulk two')
        });
        const bulkAssetOne = await bulkOne.json();
        const bulkAssetTwo = await bulkTwo.json();

        const emptyBulk = await fetch(`${baseUrl}/api/assets/bulk-delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [] })
        });
        assert.strictEqual(emptyBulk.status, 400, 'bulk delete without ids should be rejected');

        const bogusId = 'a'.repeat(24);
        const bulkResponse = await fetch(`${baseUrl}/api/assets/bulk-delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [bulkAssetOne.id, bulkAssetTwo.id, bulkAssetOne.id, bogusId] })
        });
        assert.strictEqual(bulkResponse.status, 200, 'bulk delete should succeed');
        const bulkBody = await bulkResponse.json();
        assert.deepStrictEqual(
            [...bulkBody.deleted].sort(),
            [bulkAssetOne.id, bulkAssetTwo.id].sort(),
            'bulk delete should report each existing id exactly once even when duplicated'
        );
        assert.deepStrictEqual(bulkBody.missing, [bogusId], 'bulk delete should report ids it could not remove');

        const afterBulkOne = await fetch(`${baseUrl}${bulkAssetOne.originalUrl}`);
        assert.strictEqual(afterBulkOne.status, 404, 'a bulk-deleted asset original should no longer be served');
        const listAfterBulk = await fetch(`${baseUrl}/api/assets`);
        const listAfterBulkBody = await listAfterBulk.json();
        assert(
            !listAfterBulkBody.assets.some(item => item.id === bulkAssetOne.id || item.id === bulkAssetTwo.id),
            'bulk-deleted assets must disappear from the listing'
        );

        console.log('Asset route checks passed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
