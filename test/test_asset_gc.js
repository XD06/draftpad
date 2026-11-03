// 孤儿 asset 回收脚本（scripts/gc-orphan-assets.js）的回归。
//
// 关注四件事：引用根（Thought 附件 / 垃圾桶可恢复 payload / 文章 Markdown 里的
// /api/assets/<id>）里的资产绝不能被回收；宽限期内的新资产不回收；默认 dry-run
// 不删；引用根为空时拒绝执行（防错 prefix 清空整个 asset store）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

const ASSET_THOUGHT = 'aaaaaaaa-1111-4111-8111-111111111111';
const ASSET_TRASH = 'bbbbbbbb-2222-4222-8222-222222222222';
const ASSET_ARTICLE = 'cccccccc-3333-4333-8333-333333333333';
const ASSET_ORPHAN = 'dddddddd-4444-4444-8444-444444444444';
const ASSET_YOUNG = 'eeeeeeee-5555-4555-8555-555555555555';
const ASSET_TRASHED_ARTICLE = 'ffffffff-6666-4666-8666-666666666666';

function prepareDataDir({ withRoots = true } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-asset-gc-'));
    fs.mkdirSync(path.join(dataDir, 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'today-drafts.json'), '[]');
    fs.writeFileSync(path.join(dataDir, 'default.txt'), withRoots
        ? `文章正文 ![图](/api/assets/${ASSET_ARTICLE}/original)`
        : '');
    fs.writeFileSync(path.join(dataDir, 'notepads.json'), JSON.stringify({
        notepads: withRoots ? [{ id: 'default', name: 'Default', file: 'default.txt', createdAt: 1 }] : [],
        currentNotepadId: withRoots ? 'default' : ''
    }));
    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), JSON.stringify(withRoots ? [{
        id: 't-keep',
        text: '引用了一个附件',
        subItems: [],
        tags: [],
        completed: false,
        pinned: false,
        attachments: [{
            id: 'att-1',
            assetId: ASSET_THOUGHT,
            name: 'keep.txt',
            type: 'text/plain',
            size: 3,
            originalUrl: `/api/assets/${ASSET_THOUGHT}/original`,
            downloadUrl: `/api/assets/${ASSET_THOUGHT}/download`
        }],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        version: 1
    }] : []));
    return dataDir;
}

function writeAsset(assets, id, { size = 3, createdAt = Date.now() } = {}) {
    return assets.writeAsset({
        id,
        metadata: { version: 1, kind: 'file', id, name: `${id.slice(0, 4)}.txt`, type: 'text/plain', size, createdAt },
        original: { buffer: Buffer.from('abc'), contentType: 'text/plain' }
    });
}

async function run() {
    const dataDir = prepareDataDir();
    process.env.DATA_DIR = dataDir;
    process.env.STORAGE_BACKEND = 'local';
    process.env.STORAGE_LAYOUT = 'legacy';

    const storage = require(path.join(ROOT, 'scripts', 'storage.js'));
    const { createAssetStorage } = require(path.join(ROOT, 'scripts', 'asset-storage.js'));
    const { gcOrphanAssets } = require(path.join(ROOT, 'scripts', 'gc-orphan-assets.js'));
    const assets = createAssetStorage(storage);

    const old = Date.now() - 10 * DAY_MS;
    await writeAsset(assets, ASSET_THOUGHT, { createdAt: old });
    await writeAsset(assets, ASSET_TRASH, { createdAt: old });
    await writeAsset(assets, ASSET_ARTICLE, { createdAt: old });
    await writeAsset(assets, ASSET_TRASHED_ARTICLE, { createdAt: old });
    await writeAsset(assets, ASSET_ORPHAN, { size: 128, createdAt: old });
    await writeAsset(assets, ASSET_YOUNG, { createdAt: Date.now() });

    // 垃圾桶里的 Thought 仍可恢复，它的附件不算孤儿
    await storage.addTrashItem({
        type: 'thought',
        sourceId: 't-trashed',
        title: '被删除的想法',
        preview: '引用了一个附件',
        payload: {
            thought: {
                id: 't-trashed',
                text: '引用了一个附件',
                subItems: [],
                tags: [],
                completed: false,
                pinned: false,
                attachments: [{ id: 'att-2', assetId: ASSET_TRASH, name: 'trash.txt', type: 'text/plain', size: 3 }],
                createdAt: old,
                updatedAt: old,
                version: 1
            }
        }
    });

    // 垃圾桶里的文章同样可恢复：正文在 payload.content（不是 notepad.content），
    // 里面的媒体资产不能算孤儿。
    await storage.addTrashItem({
        type: 'notepad',
        sourceId: 'n-trashed',
        title: '被删除的文章',
        preview: '文章正文',
        payload: {
            notepad: { id: 'n-trashed', name: '被删除的文章', file: 'n-trashed.txt', createdAt: old, updatedAt: old, version: 1 },
            content: `旧文章 ![图](/api/assets/${ASSET_TRASHED_ARTICLE}/original)`
        }
    });

    const exists = id => fs.existsSync(path.join(dataDir, 'assets', id, 'meta.json'));

    // 1. dry-run：只报告，不删
    {
        const report = await gcOrphanAssets({ apply: false, graceDays: 1 });
        assert.strictEqual(report.apply, false);
        assert.strictEqual(report.assets, 6, 'all assets are scanned');
        assert.strictEqual(report.referenced, 4, 'thought / trashed thought / article / trashed article references are all counted');
        assert.strictEqual(report.orphans, 1, 'only the old unreferenced asset is an orphan');
        assert.strictEqual(report.skippedYoung, 1, 'the fresh asset is protected by the grace period');
        assert.strictEqual(report.orphanBytes, 128);
        assert.deepStrictEqual(report.largest.map(item => item.id), [ASSET_ORPHAN]);
        assert.strictEqual(report.deleted.length, 0, 'dry run deletes nothing');
        assert(exists(ASSET_ORPHAN), 'the orphan is still on disk after a dry run');
    }

    // 2. apply：只删孤儿，引用中的资产与宽限期内资产保持
    {
        const report = await gcOrphanAssets({ apply: true, graceDays: 1 });
        assert.deepStrictEqual(report.deleted, [ASSET_ORPHAN], 'exactly the orphan is deleted');
        assert.strictEqual(report.failed.length, 0);
        assert.strictEqual(exists(ASSET_ORPHAN), false, 'the orphan is gone');
        assert(exists(ASSET_THOUGHT), 'a Thought attachment is kept');
        assert(exists(ASSET_TRASH), 'a trashed Thought attachment is kept (still restorable)');
        assert(exists(ASSET_TRASHED_ARTICLE), 'a trashed article media asset is kept (still restorable)');
        assert(exists(ASSET_ARTICLE), 'an article media asset is kept');
        assert(exists(ASSET_YOUNG), 'the fresh asset is kept');

        const again = await gcOrphanAssets({ apply: true, graceDays: 1 });
        assert.strictEqual(again.orphans, 0, 'a second run finds nothing left');
    }

    // 3. 引用根为空时拒绝执行（错 prefix 不能把 asset store 清空）
    {
        const emptyDir = prepareDataDir({ withRoots: false });
        process.env.DATA_DIR = emptyDir;
        delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'storage.js'))];
        delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gc-orphan-assets.js'))];
        const emptyStorage = require(path.join(ROOT, 'scripts', 'storage.js'));
        const emptyAssets = createAssetStorage(emptyStorage);
        const { gcOrphanAssets: gcAgain } = require(path.join(ROOT, 'scripts', 'gc-orphan-assets.js'));
        await writeAsset(emptyAssets, ASSET_ORPHAN, { createdAt: old });
        const report = await gcAgain({ apply: true, graceDays: 1 });
        assert.strictEqual(report.refused, true, 'an empty workspace refuses to delete');
        assert.strictEqual(report.deleted.length, 0);
        assert(fs.existsSync(path.join(emptyDir, 'assets', ASSET_ORPHAN, 'meta.json')), 'nothing was deleted');
        fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('Asset GC checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
