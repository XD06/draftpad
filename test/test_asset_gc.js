// 孤儿 asset 回收脚本（scripts/gc-orphan-assets.js）的回归。
//
// 关注六件事：所有持久引用根（Thought 附件 / 正文 / 子任务 / 附件 URL、垃圾桶
// Thought 与文章正文、文章 Markdown、Instant Draft 文本）里的资产绝不回收；
// 宽限期内与「年龄未知」的资产不回收；默认 dry-run 不删；apply 必须带正确的
// --expect-orphans；引用根为空时拒绝执行；**文章读取失败必须 fail-closed**
// （不能把"读不出来的文章"当成"没有引用"）。
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
const ASSET_TEXT_REF = '11111111-7777-4777-8777-777777777777';
const ASSET_DRAFT_REF = '22222222-8888-4888-8888-888888888888';
const ASSET_UNKNOWN_AGE = '33333333-9999-4999-8999-999999999999';

function prepareDataDir({ withRoots = true } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-asset-gc-'));
    fs.mkdirSync(path.join(dataDir, 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'today-drafts.json'), JSON.stringify(withRoots ? [{
        id: 'd1',
        day: '2026-11-03',
        text: `草稿里粘了旧链接 /api/assets/${ASSET_DRAFT_REF}/original`
    }] : []));
    fs.writeFileSync(path.join(dataDir, 'default.txt'), withRoots
        ? `文章正文 ![图](/api/assets/${ASSET_ARTICLE}/original)`
        : '');
    fs.writeFileSync(path.join(dataDir, 'notepads.json'), JSON.stringify({
        notepads: withRoots ? [{ id: 'default', name: 'Default', file: 'default.txt', createdAt: 1 }] : [],
        currentNotepadId: withRoots ? 'default' : ''
    }));
    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), JSON.stringify(withRoots ? [{
        id: 't-keep',
        // 正文里直接贴的资产链接同样是持久引用（用户粘贴、hydrate 也接受 URL 型附件）
        text: `引用了一个附件，还贴了个链接 /api/assets/${ASSET_TEXT_REF}/download`,
        subItems: [{ id: 's1', text: '子任务', completed: false }],
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
    const metadata = { version: 1, kind: 'file', id, name: `${id.slice(0, 4)}.txt`, type: 'text/plain', size };
    if (createdAt !== null) metadata.createdAt = createdAt;
    return assets.writeAsset({
        id,
        metadata,
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
    await writeAsset(assets, ASSET_TEXT_REF, { createdAt: old });
    await writeAsset(assets, ASSET_DRAFT_REF, { createdAt: old });
    await writeAsset(assets, ASSET_ORPHAN, { size: 128, createdAt: old });
    await writeAsset(assets, ASSET_YOUNG, { createdAt: Date.now() });
    await writeAsset(assets, ASSET_UNKNOWN_AGE, { createdAt: null });

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

    // 垃圾桶里的文章同样可恢复：正文在 payload.content（不是 notepad.content）
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

    const existsIn = (dir, id) => fs.existsSync(path.join(dir, 'assets', id, 'meta.json'));
    const exists = id => existsIn(dataDir, id);

    // 1. dry-run：只报告，不删
    {
        const report = await gcOrphanAssets({ apply: false, graceDays: 1 });
        assert.strictEqual(report.apply, false);
        assert.strictEqual(report.assets, 9, 'all assets are scanned');
        assert.strictEqual(report.referenced, 6, 'every persistent root kind is counted (thought/attachment URL/trash/article/trashed article/draft)');
        assert.strictEqual(report.orphans, 1, 'only the old unreferenced asset is an orphan');
        assert.strictEqual(report.skippedYoung, 1, 'the fresh asset is protected by the grace period');
        assert.strictEqual(report.skippedUnknownAge, 1, 'an asset without createdAt is never treated as ancient');
        assert.strictEqual(report.orphanBytes, 128);
        assert.deepStrictEqual(report.largest.map(item => item.id), [ASSET_ORPHAN]);
        assert.strictEqual(report.deleted.length, 0, 'dry run deletes nothing');
        assert(exists(ASSET_ORPHAN), 'the orphan is still on disk after a dry run');
        assert.deepStrictEqual(report.corruptReads, [], 'a healthy storage read reports no corruption');
    }

    // 2. apply 的安全门：必须带正确的 --expect-orphans
    {
        const missing = await gcOrphanAssets({ apply: true, graceDays: 1 });
        assert.strictEqual(missing.refused, true, 'apply without --expect-orphans is refused');
        assert(/expect-orphans/.test(missing.reason), `refusal explains the gate (got ${missing.reason})`);
        assert(exists(ASSET_ORPHAN), 'nothing deleted without the count');

        const mismatch = await gcOrphanAssets({ apply: true, graceDays: 1, expectOrphans: 99 });
        assert.strictEqual(mismatch.refused, true, 'a changed orphan count is refused');
        assert(/changed/.test(mismatch.reason), `refusal explains the mismatch (got ${mismatch.reason})`);
        assert(exists(ASSET_ORPHAN), 'nothing deleted on a count mismatch');
    }

    // 3. apply：只删孤儿，引用中的资产与宽限期/未知年龄资产保持
    {
        const report = await gcOrphanAssets({ apply: true, graceDays: 1, expectOrphans: 1 });
        assert.strictEqual(report.refused, false);
        assert.deepStrictEqual(report.deleted, [ASSET_ORPHAN], 'exactly the orphan is deleted');
        assert.strictEqual(report.failed.length, 0);
        assert.strictEqual(exists(ASSET_ORPHAN), false, 'the orphan is gone');
        for (const id of [ASSET_THOUGHT, ASSET_TRASH, ASSET_ARTICLE, ASSET_TRASHED_ARTICLE, ASSET_TEXT_REF, ASSET_DRAFT_REF]) {
            assert(exists(id), `${id} is still referenced and must be kept`);
        }
        assert(exists(ASSET_YOUNG), 'the fresh asset is kept');
        assert(exists(ASSET_UNKNOWN_AGE), 'the unknown-age asset is kept');

        const again = await gcOrphanAssets({ apply: true, graceDays: 1, expectOrphans: 0 });
        assert.strictEqual(again.orphans, 0, 'a second run finds nothing left');
    }

    // 4. 文章读失败必须 fail-closed：读不出来 ≠ 没有引用
    {
        const brokenDir = prepareDataDir();
        process.env.DATA_DIR = brokenDir;
        // 让文章"文件"是一个目录：readFile 会以 EISDIR/EPERM 失败，而宽容读取会吞成 ''
        fs.rmSync(path.join(brokenDir, 'default.txt'), { force: true });
        fs.mkdirSync(path.join(brokenDir, 'default.txt'));
        delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'storage.js'))];
        delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gc-orphan-assets.js'))];
        const brokenStorage = require(path.join(ROOT, 'scripts', 'storage.js'));
        const brokenAssets = createAssetStorage(brokenStorage);
        const { gcOrphanAssets: gcBroken } = require(path.join(ROOT, 'scripts', 'gc-orphan-assets.js'));
        await writeAsset(brokenAssets, ASSET_ARTICLE, { createdAt: old });
        await writeAsset(brokenAssets, ASSET_ORPHAN, { createdAt: old });

        await assert.rejects(
            () => gcBroken({ apply: true, graceDays: 1, expectOrphans: 2 }),
            /EISDIR|EPERM|EACCES|directory/i,
            'an unreadable article must abort the scan instead of dropping its references'
        );
        assert(existsIn(brokenDir, ASSET_ARTICLE), 'the article asset is not deleted when its content cannot be read');
        assert(existsIn(brokenDir, ASSET_ORPHAN), 'nothing is deleted when the root scan fails');
        fs.rmSync(brokenDir, { recursive: true, force: true });
    }

    // 5. 引用根为空时拒绝执行（错 prefix 不能把 asset store 清空）
    {
        const emptyDir = prepareDataDir({ withRoots: false });
        process.env.DATA_DIR = emptyDir;
        delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'storage.js'))];
        delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gc-orphan-assets.js'))];
        const emptyStorage = require(path.join(ROOT, 'scripts', 'storage.js'));
        const emptyAssets = createAssetStorage(emptyStorage);
        const { gcOrphanAssets: gcAgain } = require(path.join(ROOT, 'scripts', 'gc-orphan-assets.js'));
        await writeAsset(emptyAssets, ASSET_ORPHAN, { createdAt: old });
        const report = await gcAgain({ apply: true, graceDays: 1, expectOrphans: 1 });
        assert.strictEqual(report.refused, true, 'an empty workspace refuses to delete');
        assert.strictEqual(report.deleted.length, 0);
        assert(existsIn(emptyDir, ASSET_ORPHAN), 'nothing was deleted');
        fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('Asset GC checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
