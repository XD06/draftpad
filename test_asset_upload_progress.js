const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        const list = this.listeners.get(type) || [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    emit(type, event = {}) {
        (this.listeners.get(type) || []).forEach(listener => listener(event));
    }
}

class FakeXMLHttpRequest extends FakeEventTarget {
    static instances = [];

    constructor() {
        super();
        this.upload = new FakeEventTarget();
        this.headers = {};
        FakeXMLHttpRequest.instances.push(this);
    }

    open(method, url) {
        this.method = method;
        this.url = url;
    }

    setRequestHeader(name, value) {
        this.headers[name] = value;
    }

    send(body) {
        this.body = body;
        this.upload.emit('progress', { lengthComputable: true, loaded: 5, total: 10 });
        this.upload.emit('progress', { lengthComputable: true, loaded: 10, total: 10 });
        this.status = 201;
        this.responseText = JSON.stringify({ id: 'asset-1', downloadUrl: '/api/assets/asset-1/download' });
        this.emit('load');
    }
}

function loadClient() {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'asset-api-client.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export const /g, 'const ')
        .replace(/export function /g, 'function ')
        .replace(/export class /g, 'class ')
        + '\nmodule.exports = { AssetApiClient };\n';
    const context = {
        module: { exports: {} },
        exports: {},
        XMLHttpRequest: FakeXMLHttpRequest,
        JSON,
        String,
        Number,
        Math,
        TypeError,
        Error,
        encodeURIComponent,
        Promise
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

async function run() {
    const { AssetApiClient } = loadClient();
    const progress = [];
    const file = { name: '说明.txt', type: 'text/plain', size: 10 };
    const asset = await new AssetApiClient().uploadFile(file, {
        onProgress: state => progress.push({ ...state })
    });

    const xhr = FakeXMLHttpRequest.instances[0];
    assert.strictEqual(xhr.method, 'POST');
    assert.strictEqual(xhr.url, '/api/assets/files');
    assert.strictEqual(xhr.body, file, 'the original file bytes should be uploaded without client recompression');
    assert.strictEqual(xhr.headers['X-Asset-Type'], 'text/plain');
    assert.deepStrictEqual(
        progress.map(item => [item.phase, item.percent]),
        [['uploading', 50], ['uploading', 100], ['processing', 100]],
        'upload progress should expose byte transfer and server processing as separate phases'
    );
    assert.strictEqual(asset.id, 'asset-1');
    const configurableClient = new AssetApiClient({ maxFileBytes: 80 * 1024 * 1024 });
    await configurableClient.uploadFile({ name: 'large.zip', type: 'application/zip', size: 60 * 1024 * 1024 });
    await assert.rejects(
        () => configurableClient.uploadFile({ name: 'too-large.zip', type: 'application/zip', size: 81 * 1024 * 1024 }),
        /80MB/,
        'the browser should enforce the server-provided limit before sending bytes'
    );
    console.log('Asset upload progress checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
