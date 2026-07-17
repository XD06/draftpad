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
        throw new Error(`Unhandled command: ${command.constructor.name}`);
    }
};

const s3 = require('./scripts/s3-service');
s3.initS3({ client: fakeClient, bucket: 'asset-test' });
const { createAssetStorage } = require('./scripts/asset-storage');

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
    console.log('S3 asset storage checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
