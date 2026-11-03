// 存量内联附件迁移脚本（scripts/migrate-thought-attachments.js）的回归。
//
// 关注五件事：dry-run 绝不改集合；--apply 把 dataUrl 换成与 /api/assets/files
// 同形的 asset 引用且字节可读回；重复执行幂等；坏 base64 不会被"迁移"成另一段
// 字节；相同字节但不同文件名的附件共享 asset 但保留各自的显示名。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const INLINE_TEXT = 'hello-migrated-attachment';
const INLINE_DATA_URL = `data:text/plain;base64,${Buffer.from(INLINE_TEXT).toString('base64')}`;
const UNSUPPORTED_DATA_URL = `data:application/x-unknown;base64,${Buffer.from('weird').toString('base64')}`;
const BAD_BASE64_DATA_URL = 'data:text/plain;base64,@@@definitely-not-base64@@@';
const INLINE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const INLINE_PNG = Buffer.from(INLINE_PNG_BASE64, 'base64');
const INLINE_PNG_DATA_URL = `data:image/png;base64,${INLINE_PNG_BASE64}`;

function prepareDataDir() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-att-migrate-'));
    fs.mkdirSync(path.join(dataDir, 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'notepads.json'), JSON.stringify({
        notepads: [{ id: 'default', name: 'Default', file: 'default.txt', createdAt: 1 }],
        currentNotepadId: 'default'
    }));
    fs.writeFileSync(path.join(dataDir, 'default.txt'), 'Default content');
    fs.writeFileSync(path.join(dataDir, 'today-drafts.json'), '[]');
    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), JSON.stringify([
        {
            id: 't-inline',
            text: '内联附件迁移测试',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [{ id: 'a1', name: 'note.txt', type: 'text/plain', size: INLINE_TEXT.length, dataUrl: INLINE_DATA_URL }],
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
            version: 1
        },
        {
            id: 't-duplicate',
            text: '相同字节不同文件名',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [{ id: 'a1-dup', name: 'copy.txt', type: 'text/plain', size: INLINE_TEXT.length, dataUrl: INLINE_DATA_URL }],
            createdAt: 1700000000500,
            updatedAt: 1700000000500,
            version: 1
        },
        {
            id: 't-image',
            text: '内联图片走图片通道',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [{ id: 'img-1', name: 'shot.png', type: 'image/png', size: INLINE_PNG.length, dataUrl: INLINE_PNG_DATA_URL }],
            createdAt: 1700000000700,
            updatedAt: 1700000000700,
            version: 1
        },
        {
            id: 't-unsupported',
            text: '不支持的类型保持内联',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [{ id: 'a2', name: 'weird.xyz', type: 'application/x-unknown', size: 5, dataUrl: UNSUPPORTED_DATA_URL }],
            createdAt: 1700000001000,
            updatedAt: 1700000001000,
            version: 1
        },
        {
            id: 't-bad',
            text: '坏 base64 必须原样保留',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [{ id: 'a4', name: 'broken.txt', type: 'text/plain', size: 10, dataUrl: BAD_BASE64_DATA_URL }],
            createdAt: 1700000001500,
            updatedAt: 1700000001500,
            version: 1
        },
        {
            id: 't-asset',
            text: '已经迁移过的保持不动',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [{
                id: 'a3',
                assetId: 'asset-already-there',
                name: 'done.pdf',
                type: 'application/pdf',
                size: 3,
                originalUrl: '/api/assets/asset-already-there/original',
                downloadUrl: '/api/assets/asset-already-there/download'
            }],
            createdAt: 1700000002000,
            updatedAt: 1700000002000,
            version: 1
        },
        {
            id: 't-plain',
            text: '没有附件',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [],
            createdAt: 1700000003000,
            updatedAt: 1700000003000,
            version: 1
        }
    ]));
    return dataDir;
}

async function run() {
    const dataDir = prepareDataDir();
    process.env.DATA_DIR = dataDir;
    process.env.STORAGE_BACKEND = 'local';
    process.env.STORAGE_LAYOUT = 'legacy';

    const { migrate, decodeInlineDataUrl } = require(path.join(ROOT, 'scripts', 'migrate-thought-attachments.js'));
    const storage = require(path.join(ROOT, 'scripts', 'storage.js'));

    const readCollection = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'thoughts.json'), 'utf8'));
    const readAttachment = (thoughtId) => readCollection()
        .find(thought => thought.id === thoughtId)
        .attachments[0];

    // 1. data URL 解码：正常往返 + 坏输入必须拒绝（Buffer.from 对坏 base64 是宽容的）
    {
        const decoded = decodeInlineDataUrl(INLINE_DATA_URL);
        assert(decoded, 'inline data url decodes');
        assert.strictEqual(decoded.buffer.toString('utf8'), INLINE_TEXT, 'bytes round-trip');
        assert.strictEqual(decoded.type, 'text/plain', 'mime is preserved');
        assert.strictEqual(decodeInlineDataUrl('not-a-data-url'), null, 'garbage is rejected');
        assert.strictEqual(decodeInlineDataUrl(BAD_BASE64_DATA_URL), null, 'non-canonical base64 is rejected instead of silently re-encoded');
    }

    // 2. dry-run 不改集合、不建 asset
    {
        const before = fs.readFileSync(path.join(dataDir, 'thoughts.json'), 'utf8');
        const report = await migrate({ apply: false });
        assert.strictEqual(report.apply, false);
        assert.strictEqual(report.thoughts, 7, 'all thoughts are scanned');
        assert.strictEqual(report.inlineAttachments, 5, 'five inline attachments are found');
        assert.strictEqual(report.inlineBytes, INLINE_TEXT.length * 2 + INLINE_PNG.length + 5 + BAD_BASE64_DATA_URL.length, 'inline bytes are reported');
        assert.strictEqual(report.migratable, 3, 'text, duplicate and image attachments are migratable');
        assert.strictEqual(report.migrated, 0, 'dry run migrates nothing');
        assert.strictEqual(report.skipped.length, 2, 'unsupported type and bad base64 are reported as skipped');
        assert.strictEqual(report.backup, null, 'dry run writes no backup');
        assert.strictEqual(fs.readFileSync(path.join(dataDir, 'thoughts.json'), 'utf8'), before, 'dry run must not touch the collection');
        assert.strictEqual(fs.existsSync(path.join(dataDir, 'assets')), false, 'dry run must not create assets');
    }

    // 2b. --limit 只缩小处理量，不改变扫描结果
    {
        const report = await migrate({ apply: false, limit: 1 });
        assert.strictEqual(report.inlineAttachments, 5, 'limit does not change the scan');
        assert.strictEqual(report.migratable, 1, 'limit caps the migrated set');
    }

    // 3. apply 迁移并保留可读回的字节；相同字节共享 asset、各自保留显示名
    let migratedAssetId = '';
    {
        const report = await migrate({ apply: true });
        assert.strictEqual(report.migrated, 3, 'text, duplicate and image attachments are migrated');
        assert.strictEqual(report.thoughtsWritten, 3, 'each touched Thought is written once');
        assert.ok(report.backup && fs.existsSync(report.backup), 'a backup of the collection is written');
        assert.strictEqual(report.failed.length, 0, 'no failures');

        const migrated = readAttachment('t-inline');
        assert.strictEqual(migrated.dataUrl, undefined, 'the inline payload is gone');
        assert.ok(migrated.assetId, 'the attachment now points at an asset');
        assert.strictEqual(migrated.kind, 'file');
        assert.strictEqual(migrated.originalUrl, `/api/assets/${migrated.assetId}/original`);
        assert.strictEqual(migrated.downloadUrl, `/api/assets/${migrated.assetId}/download`);
        assert.strictEqual(migrated.name, 'note.txt', 'the display name is preserved');
        assert.strictEqual(migrated.size, INLINE_TEXT.length, 'the size is preserved');
        migratedAssetId = migrated.assetId;

        const duplicate = readAttachment('t-duplicate');
        assert.strictEqual(duplicate.assetId, migratedAssetId, 'identical bytes share one asset');
        assert.strictEqual(duplicate.name, 'copy.txt', 'each Thought keeps its own display name');
        assert.notStrictEqual(duplicate.id, migrated.id, 'attachment instance ids stay distinct');

        const stored = fs.readFileSync(path.join(dataDir, 'assets', migratedAssetId, 'original'));
        assert.strictEqual(stored.toString('utf8'), INLINE_TEXT, 'the asset stores the original bytes');
        const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'assets', migratedAssetId, 'meta.json'), 'utf8'));
        assert.strictEqual(meta.kind, 'file');
        assert.strictEqual(meta.type, 'text/plain');

        assert(readAttachment('t-unsupported').dataUrl, 'unsupported types stay inline by default');
        assert.strictEqual(readAttachment('t-bad').dataUrl, BAD_BASE64_DATA_URL, 'a corrupted data URL is left untouched');
        assert.strictEqual(readAttachment('t-asset').assetId, 'asset-already-there', 'already migrated attachments are untouched');

        // 图片走图片通道：kind=image + webp 预览，与 /api/assets/images 同形
        const image = readAttachment('t-image');
        assert.strictEqual(image.dataUrl, undefined, 'the inline image payload is gone');
        assert.ok(image.assetId, 'the image points at an asset');
        assert.ok(image.previewUrl, 'a migrated image gets a preview url');
        const imageMeta = JSON.parse(fs.readFileSync(path.join(dataDir, 'assets', image.assetId, 'meta.json'), 'utf8'));
        assert.strictEqual(imageMeta.kind, 'image', 'the image asset is stored in the image channel');
        assert.strictEqual(imageMeta.previewType, 'image/webp', 'a webp preview is generated');
        assert(fs.existsSync(path.join(dataDir, 'assets', image.assetId, 'preview')), 'the preview bytes exist');
        const imageBytes = fs.readFileSync(path.join(dataDir, 'assets', image.assetId, 'original'));
        assert(imageBytes.equals(INLINE_PNG), 'the original image bytes are preserved');
    }

    // 4. 幂等 + 索引仍可搜
    {
        const report = await migrate({ apply: true });
        assert.strictEqual(report.migratable, 0, 'a second run has nothing to migrate');
        assert.strictEqual(report.migrated, 0);
        assert.strictEqual(report.backup, null, 'nothing changed, so no new backup');

        const results = await storage.searchThoughtsLight({ query: '内联附件迁移测试', limit: 5 });
        assert(results.some(item => item.id === 't-inline'), 'the thoughts index still finds the migrated thought');
        const thought = await storage.readThought('t-inline');
        assert.strictEqual(thought.attachments[0].assetId, migratedAssetId, 'readThought returns the asset reference');
    }

    // 5. 白名单外的老类型：默认保持内联，显式放行时以不透明 file 资产落库
    {
        const blocked = await migrate({ apply: true });
        assert.strictEqual(blocked.migratable, 0, 'unsupported types stay inline unless explicitly allowed');
        assert(readAttachment('t-unsupported').dataUrl);

        const report = await migrate({ apply: true, allowUnsupportedTypes: true });
        assert.strictEqual(report.migrated, 1, 'the unsupported attachment is migrated when allowed');
        const migrated = readAttachment('t-unsupported');
        assert.strictEqual(migrated.dataUrl, undefined, 'the inline payload is gone');
        assert.ok(migrated.assetId);
        assert.strictEqual(migrated.type, 'application/x-unknown', 'the Thought keeps the original display type');
        const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'assets', migrated.assetId, 'meta.json'), 'utf8'));
        assert.strictEqual(meta.kind, 'file');
        assert.strictEqual(meta.type, 'application/octet-stream', 'the stored asset is an opaque download, never inline');
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('Thought attachment migration checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
