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

        // Re-uploading identical image bytes (even under a different name) must
        // dedupe to the existing asset instead of storing a second copy.
        const duplicateUpload = await fetch(`${baseUrl}/api/assets/images`, {
            method: 'POST',
            headers: {
                'content-type': 'image/png',
                'x-asset-name': encodeURIComponent('重复上传.png')
            },
            body: original
        });
        assert.strictEqual(duplicateUpload.status, 200, 'a duplicate image upload should report reuse (200), not creation (201)');
        const duplicateAsset = await duplicateUpload.json();
        assert.strictEqual(duplicateAsset.id, asset.id, 'a duplicate image upload should return the existing asset id');
        const afterDuplicateList = await (await fetch(`${baseUrl}/api/assets`)).json();
        assert.strictEqual(
            afterDuplicateList.assets.filter(item => item.id === asset.id).length,
            1,
            'a deduped image must appear exactly once in the listing'
        );

        // Same display name, different bytes: each create (201) must
        // disambiguate the stored name as "base (n).ext" so the panel can
        // tell same-named assets apart, while a hash-dedupe hit (200) must
        // still return the existing asset with its stored name untouched.
        const clashBytesOne = await sharp({
            create: { width: 40, height: 20, channels: 3, background: '#00ccff' }
        }).png().toBuffer();
        const clashBytesTwo = await sharp({
            create: { width: 42, height: 20, channels: 3, background: '#cc00ff' }
        }).png().toBuffer();
        const clashBytesThree = await sharp({
            create: { width: 44, height: 20, channels: 3, background: '#ff00cc' }
        }).png().toBuffer();
        const uploadNamedImage = async (bytes, name) => {
            const response = await fetch(`${baseUrl}/api/assets/images`, {
                method: 'POST',
                headers: {
                    'content-type': 'image/png',
                    'x-asset-name': encodeURIComponent(name)
                },
                body: bytes
            });
            return { response, asset: await response.json() };
        };

        const clashFirst = await uploadNamedImage(clashBytesOne, 'image.png');
        assert.strictEqual(clashFirst.response.status, 201, 'an image with an unused name should be created');
        assert.strictEqual(clashFirst.asset.name, 'image.png', 'an unused name must be stored verbatim');

        const clashDedupe = await uploadNamedImage(clashBytesOne, 'image.png');
        assert.strictEqual(clashDedupe.response.status, 200, 'identical bytes must still dedupe even under a clashing name');
        assert.strictEqual(clashDedupe.asset.id, clashFirst.asset.id, 'hash dedupe must return the existing asset id');
        assert.strictEqual(clashDedupe.asset.name, 'image.png', 'hash dedupe must never rename the stored asset');

        const clashSecond = await uploadNamedImage(clashBytesTwo, 'image.png');
        assert.strictEqual(clashSecond.response.status, 201, 'different bytes under the same name must create a new asset');
        assert.notStrictEqual(clashSecond.asset.id, clashFirst.asset.id, 'different bytes must not dedupe to the first asset');
        assert.strictEqual(clashSecond.asset.name, 'image (1).png', 'the second same-name image must be disambiguated as base (1).ext');

        const clashThird = await uploadNamedImage(clashBytesThree, 'image.png');
        assert.strictEqual(clashThird.response.status, 201, 'different bytes under the same name must create a new asset');
        assert.strictEqual(clashThird.asset.name, 'image (2).png', 'the third same-name image must be disambiguated as base (2).ext');

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

        // Re-uploading identical file bytes must dedupe to the existing asset.
        const duplicateFileUpload = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('重复计划.pdf'),
                'x-asset-type': 'application/pdf'
            },
            body: fileBytes
        });
        assert.strictEqual(duplicateFileUpload.status, 200, 'a duplicate file upload should report reuse (200), not creation (201)');
        const duplicateFileAsset = await duplicateFileUpload.json();
        assert.strictEqual(duplicateFileAsset.id, fileAsset.id, 'a duplicate file upload should return the existing asset id');

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

        // 嵌入媒体（video/audio）：original 变体必须 inline + Accept-Ranges，
        // Range 请求返回 206 分段；download 变体仍强制 attachment。
        // 服务端不嗅探媒体内容，任意字节即可验证响应管线。
        const mediaBytes = Buffer.from('0123456789ABCDEFGHIJ media payload');
        const mediaUpload = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('片段.mp4'),
                'x-asset-type': 'video/mp4'
            },
            body: mediaBytes
        });
        assert.strictEqual(mediaUpload.status, 201, 'a playable video file should be accepted');
        const mediaAsset = await mediaUpload.json();

        const mediaOriginal = await fetch(`${baseUrl}${mediaAsset.originalUrl}`);
        assert.strictEqual(mediaOriginal.status, 200);
        assert.strictEqual(mediaOriginal.headers.get('content-disposition'), 'inline', 'media originals must be inline so <video>/<audio> can reference them');
        assert.strictEqual(mediaOriginal.headers.get('accept-ranges'), 'bytes', 'media originals must advertise byte ranges for player seeking');

        const firstTen = await fetch(`${baseUrl}${mediaAsset.originalUrl}`, { headers: { range: 'bytes=0-9' } });
        assert.strictEqual(firstTen.status, 206, 'a valid byte range should be answered with 206');
        assert.strictEqual(firstTen.headers.get('content-range'), `bytes 0-9/${mediaBytes.length}`);
        assert.strictEqual(firstTen.headers.get('content-length'), '10');
        assert.deepStrictEqual(
            Buffer.from(await firstTen.arrayBuffer()),
            mediaBytes.subarray(0, 10),
            'a ranged media response must carry exactly the requested bytes'
        );

        const suffixRange = await fetch(`${baseUrl}${mediaAsset.originalUrl}`, { headers: { range: 'bytes=-4' } });
        assert.strictEqual(suffixRange.status, 206, 'a suffix range should be answered with 206');
        assert.strictEqual(suffixRange.headers.get('content-range'), `bytes ${mediaBytes.length - 4}-${mediaBytes.length - 1}/${mediaBytes.length}`);
        assert.deepStrictEqual(
            Buffer.from(await suffixRange.arrayBuffer()),
            mediaBytes.subarray(mediaBytes.length - 4),
            'a suffix range must serve the trailing bytes'
        );

        const openRange = await fetch(`${baseUrl}${mediaAsset.originalUrl}`, { headers: { range: 'bytes=5-' } });
        assert.strictEqual(openRange.status, 206, 'an open-ended range should be answered with 206');
        assert.deepStrictEqual(
            Buffer.from(await openRange.arrayBuffer()),
            mediaBytes.subarray(5),
            'an open-ended range must serve through the end of the asset'
        );

        const unsatisfiable = await fetch(`${baseUrl}${mediaAsset.originalUrl}`, { headers: { range: 'bytes=99999-' } });
        assert.strictEqual(unsatisfiable.status, 200, 'an out-of-bounds range should fall back to a full 200 response');

        const mediaDownload = await fetch(`${baseUrl}${mediaAsset.downloadUrl}`);
        assert.match(mediaDownload.headers.get('content-disposition') || '', /attachment/i, 'media downloads must still force attachment behavior');

        const audioUpload = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('录音.wav'),
                'x-asset-type': 'audio/wav'
            },
            body: Buffer.from('RIFF audio bytes')
        });
        assert.strictEqual(audioUpload.status, 201, 'an audio file should be accepted');
        const audioAsset = await audioUpload.json();
        const audioOriginal = await fetch(`${baseUrl}${audioAsset.originalUrl}`);
        assert.strictEqual(audioOriginal.headers.get('content-disposition'), 'inline', 'audio originals must be inline like video');
        assert.strictEqual(audioOriginal.headers.get('accept-ranges'), 'bytes', 'audio originals must advertise byte ranges');
        const audioRanged = await fetch(`${baseUrl}${audioAsset.originalUrl}`, { headers: { range: 'bytes=0-3' } });
        assert.strictEqual(audioRanged.status, 206, 'audio originals must answer ranges like video');

        const list = await fetch(`${baseUrl}/api/assets`);
        assert.strictEqual(list.status, 200, 'GET /api/assets should list stored assets');
        const listBody = await list.json();
        assert(Array.isArray(listBody.assets), 'asset listing should return an assets array');
        assert(listBody.assets.some(item => item.id === asset.id), 'the uploaded image should appear in the listing');
        assert(listBody.assets.some(item => item.id === fileAsset.id), 'the uploaded file should appear in the listing');
        const listedImage = listBody.assets.find(item => item.id === asset.id);
        assert.strictEqual(listedImage.previewUrl, `/api/assets/${asset.id}/preview`, 'listed images should expose a preview URL');
        assert(Number.isFinite(listedImage.createdAt) && listedImage.createdAt > 0, 'listed assets should expose a numeric createdAt for the panel timestamp');

        const filesOnly = await fetch(`${baseUrl}/api/assets?kind=file&limit=1`);
        assert.strictEqual(filesOnly.status, 200, 'GET /api/assets should accept a file-kind filter and page limit');
        const filesOnlyBody = await filesOnly.json();
        assert(filesOnlyBody.assets.length === 1 && filesOnlyBody.assets[0].kind === 'file', 'asset filtering should return only requested asset kinds');
        assert(typeof filesOnlyBody.hasMore === 'boolean', 'a limited asset listing should report pagination state');
        assert(Object.prototype.hasOwnProperty.call(filesOnlyBody, 'nextCursor'), 'a limited asset listing should return a nextCursor field');

        const firstPage = await fetch(`${baseUrl}/api/assets?limit=1`);
        const firstPageBody = await firstPage.json();
        assert(firstPageBody.hasMore === true && firstPageBody.nextCursor, 'a bounded multi-asset listing should expose the next cursor');
        const secondPage = await fetch(`${baseUrl}/api/assets?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor)}`);
        const secondPageBody = await secondPage.json();
        assert(secondPageBody.assets[0]?.id && secondPageBody.assets[0].id !== firstPageBody.assets[0].id, 'an asset cursor page must not repeat its predecessor');

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
