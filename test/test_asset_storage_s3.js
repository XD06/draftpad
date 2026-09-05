const assert = require('assert');

const objects = new Map();
const fakeClient = {
    async send(command) {
        const input = command.input;
        if (command.constructor.name === 'PutObjectCommand') {
            objects.set(input.Key, Buffer.from(input.Body));
            return {};
        }
        if (command.constructor.name === 'GetObjectCommand') {
            if (!objects.has(input.Key)) {
                const error = new Error('not found');
                error.name = 'NotFound';
                error.$metadata = { httpStatusCode: 404 };
                throw error;
            }
            return { Body: Buffer.from(objects.get(input.Key)) };
        }
        if (command.constructor.name === 'ListObjectsV2Command') {
            const prefix = input.Prefix || '';
            const Contents = Array.from(objects.keys())
                .filter(key => key.startsWith(prefix))
                .map(key => ({ Key: key, Size: objects.get(key).length, LastModified: new Date(0), ETag: '"x"' }));
            return { Contents };
        }
        if (command.constructor.name === 'DeleteObjectCommand') {
            objects.delete(input.Key);
            return {};
        }
        throw new Error(`Unhandled command: ${command.constructor.name}`);
    }
};

const s3 = require('../scripts/s3-service');
s3.initS3({ client: fakeClient, bucket: 'asset-test' });
const { createAssetStorage } = require('../scripts/asset-storage');

async function run() {
    const assets = createAssetStorage({
        backend: 's3',
        getS3Prefix: () => 'article-data',
        paths: { DATA_DIR: '' }
    });
    const original = Buffer.from('ordinary file bytes');
    await assets.writeAsset({
        id: '11111111-1111-4111-8111-111111111111',
        metadata: {
            version: 1,
            kind: 'file',
            id: '11111111-1111-4111-8111-111111111111',
            name: 'report.pdf',
            type: 'application/pdf',
            size: original.length,
            createdAt: 1
        },
        original: { buffer: original, contentType: 'application/pdf' }
    });

    assert(objects.has('article-data/assets/11111111-1111-4111-8111-111111111111/original'), 'S3 ordinary files should store an original object');
    assert(objects.has('article-data/assets/11111111-1111-4111-8111-111111111111/meta.json'), 'S3 ordinary files should store metadata');
    assert(!objects.has('article-data/assets/11111111-1111-4111-8111-111111111111/preview'), 'ordinary files must not create a fake preview object');

    const restored = await assets.readAsset('11111111-1111-4111-8111-111111111111', 'original');
    assert(restored, 'S3 ordinary files should be readable');
    assert.deepStrictEqual(restored.buffer, original, 'S3 ordinary file bytes must round-trip unchanged');
    assert.strictEqual(restored.contentType, 'application/pdf');
    assert.strictEqual(await assets.readAsset('11111111-1111-4111-8111-111111111111', 'preview'), null, 'ordinary files must not expose a preview variant');
    const restoredMetadata = await assets.readMetadata('11111111-1111-4111-8111-111111111111');
    assert.strictEqual(restoredMetadata?.name, 'report.pdf', 'S3 asset metadata should be readable without downloading asset bytes');

    const imageId = '22222222-2222-4222-8222-222222222222';
    await assets.writeAsset({
        id: imageId,
        metadata: {
            version: 1,
            id: imageId,
            name: 'diagram.png',
            type: 'image/png',
            size: 11,
            previewType: 'image/webp',
            createdAt: 2
        },
        original: { buffer: Buffer.from('image-bytes'), contentType: 'image/png' },
        preview: { buffer: Buffer.from('webp-bytes'), contentType: 'image/webp' }
    });

    const listed = await assets.listAssets();
    assert.strictEqual(listed.length, 2, 'listAssets should enumerate every stored asset from the S3 prefix');
    assert.strictEqual(listed[0].id, imageId, 'listAssets should sort newest-first by createdAt');
    assert.strictEqual(listed[1].name, 'report.pdf', 'listAssets should include ordinary file metadata');

    assert.strictEqual(await assets.deleteAsset('deadbeef'), false, 'deleteAsset should reject an unsafe/short id');
    assert.strictEqual(await assets.deleteAsset('33333333-3333-4333-8333-333333333333'), false, 'deleteAsset should report false when the asset does not exist');

    assert.strictEqual(await assets.deleteAsset(imageId), true, 'deleteAsset should remove an existing asset');
    assert.strictEqual(await assets.readAsset(imageId, 'original'), null, 'a deleted asset original must be gone');
    assert(!objects.has(`article-data/assets/${imageId}/preview`), 'deleteAsset should remove the S3 preview object');
    assert(!objects.has(`article-data/assets/${imageId}/meta.json`), 'deleteAsset should remove the S3 metadata object');
    const afterDelete = await assets.listAssets();
    assert.strictEqual(afterDelete.length, 1, 'a deleted asset should no longer be listed');
    assert.strictEqual(afterDelete[0].name, 'report.pdf', 'the remaining asset should still be listable');

    // deleteAssets: batch removal with dedupe and partial-result reporting.
    const batchA = '44444444-4444-4444-8444-444444444444';
    const batchB = '55555555-5555-4555-8555-555555555555';
    for (const id of [batchA, batchB]) {
        await assets.writeAsset({
            id,
            metadata: { version: 1, kind: 'file', id, name: `${id}.pdf`, type: 'application/pdf', size: 3, createdAt: 3 },
            original: { buffer: Buffer.from('pdf'), contentType: 'application/pdf' }
        });
    }
    const bogusValidId = '66666666-6666-4666-8666-666666666666';
    const batchResult = await assets.deleteAssets([batchA, batchB, batchA, bogusValidId, 'short']);
    assert.deepStrictEqual([...batchResult.deleted].sort(), [batchA, batchB].sort(), 'deleteAssets should remove each existing id once despite duplicates');
    assert.deepStrictEqual([...batchResult.missing].sort(), [bogusValidId, 'short'].sort(), 'deleteAssets should report unknown and unsafe ids as missing');
    assert.strictEqual(await assets.readAsset(batchA, 'original'), null, 'a batch-deleted asset original must be gone');
    assert(!objects.has(`article-data/assets/${batchB}/meta.json`), 'deleteAssets should remove S3 metadata for each id');
    const afterBatch = await assets.listAssets();
    assert.strictEqual(afterBatch.length, 1, 'only the untouched asset should remain after a batch delete');
    assert.strictEqual(afterBatch[0].name, 'report.pdf', 'the untouched asset should survive the batch delete');
    console.log('S3 asset storage checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
