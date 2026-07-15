const assert = require('assert');
const express = require('express');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { registerAssetRoutes } = require('./routes/asset-routes');

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
