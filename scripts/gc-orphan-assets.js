/**
 * 孤儿 asset 回收：找出 asset store 里没有任何持久引用指向的资产。
 *
 * 引用根（缺一不可，宁可漏删不可误删）：
 *   1. Thought：attachments[].assetId，以及附件 URL 字段、正文、子任务里出现的
 *      /api/assets/<id>（用户可能把资产链接直接贴进正文，hydrate 也原样接受没有
 *      assetId 的 URL 型附件）；
 *   2. 垃圾桶里可恢复的 payload：Thought 附件/正文，文章正文在 `payload.content`；
 *   3. 所有文章 Markdown 里的 /api/assets/<id>（/file 插入的图片、音视频、附件）；
 *   4. Instant Draft 的持久文本（可能粘着旧资产链接）。
 * 离线 outbox 与"刚上传、引用还没写盘"的资产在服务端无法枚举，所以只回收宽限期
 * （默认 7 天）之前创建的资产。
 *
 * 误删防护（fail-closed）：
 *   - 根读取用严格版本（`readNoteContentStrict`）：读失败直接抛错，绝不把
 *     "读不出来的文章"当成"没有引用"；
 *   - 捕获 S3 层 "corrupt JSON" 警告：坏集合/坏垃圾桶索引会让根静默丢失，
 *     只要出现就拒绝 apply；
 *   - `--apply` 必须带 `--expect-orphans N`（先跑 dry-run 拿到的数字），两次
 *     结果不一致说明根集合变了（并发写入 / 读取异常），拒绝执行；
 *   - createdAt 未知的资产一律不删（旧 metadata 没有该字段，不能当"很老"处理）；
 *   - 引用根为空（无 Thought、无文章、无草稿）时拒绝执行。
 *
 * 用法（停写或隔离执行；脚本拿不到服务端写锁）：
 *   node scripts/gc-orphan-assets.js                       # 报告
 *   node scripts/gc-orphan-assets.js --apply --expect-orphans 35
 *   node scripts/gc-orphan-assets.js --grace-days 14       # 更保守
 */

'use strict';

const storage = require('./storage');
const { createAssetStorage } = require('./asset-storage');

const DEFAULT_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const LARGEST_LIMIT = 20;
// 任何变体（/original、/preview、/download）都算引用。
const ASSET_URL_RE = /\/api\/assets\/([a-f0-9-]{16,64})/gi;

function parseArgs(argv = process.argv.slice(2)) {
    const args = { apply: false, graceDays: DEFAULT_GRACE_DAYS, expectOrphans: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.apply = false;
        else if (arg === '--grace-days') args.graceDays = Number(argv[++index]);
        else if (arg.startsWith('--grace-days=')) args.graceDays = Number(arg.slice('--grace-days='.length));
        else if (arg === '--expect-orphans') args.expectOrphans = Number(argv[++index]);
        else if (arg.startsWith('--expect-orphans=')) args.expectOrphans = Number(arg.slice('--expect-orphans='.length));
    }
    if (!Number.isFinite(args.graceDays) || args.graceDays < 0) args.graceDays = DEFAULT_GRACE_DAYS;
    if (args.expectOrphans !== null && !Number.isFinite(args.expectOrphans)) args.expectOrphans = null;
    return args;
}

function collectAssetIds(text, into) {
    const value = String(text || '');
    if (!value.includes('/api/assets/')) return into;
    ASSET_URL_RE.lastIndex = 0;
    let match = ASSET_URL_RE.exec(value);
    while (match) {
        into.add(String(match[1]).toLowerCase());
        match = ASSET_URL_RE.exec(value);
    }
    return into;
}

// A Thought references assets through attachment metadata AND through any
// asset URL it carries: attachment URL fields (a client may send URL-shaped
// attachments without assetId), the body text and the subtask lines.
function collectThoughtReferences(thought, into) {
    if (!thought) return into;
    collectAssetIds(thought.text, into);
    for (const item of Array.isArray(thought.subItems) ? thought.subItems : []) {
        collectAssetIds(item?.text, into);
    }
    for (const attachment of Array.isArray(thought.attachments) ? thought.attachments : []) {
        const assetId = String(attachment?.assetId || '').toLowerCase();
        if (assetId) into.add(assetId);
        collectAssetIds(attachment?.previewUrl, into);
        collectAssetIds(attachment?.originalUrl, into);
        collectAssetIds(attachment?.downloadUrl, into);
        collectAssetIds(attachment?.url, into);
        collectAssetIds(attachment?.dataUrl, into);
    }
    return into;
}

// S3 reads fall back to a default on corrupt JSON (with a console warning) and
// would silently drop roots. Watch for it and refuse to delete anything when it
// happens.
async function watchCorruptReads(task) {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
        if (String(args[0] || '').includes('corrupt JSON')) warnings.push(String(args[0]));
        originalWarn.apply(console, args);
    };
    try {
        return { result: await task(), warnings };
    } finally {
        console.warn = originalWarn;
    }
}

async function collectReferences() {
    const referenced = new Set();
    const stats = { thoughts: 0, trashItems: 0, notepads: 0, drafts: 0, notepadBytes: 0 };

    const thoughts = await storage.readThoughts();
    stats.thoughts = thoughts.length;
    for (const thought of thoughts) collectThoughtReferences(thought, referenced);

    const trashItems = await storage.listTrashItems();
    stats.trashItems = trashItems.length;
    for (const entry of trashItems) {
        // Read the payload directly: getTrashItem() re-reads the whole index per
        // item, which is O(items × index) on S3.
        const wrapper = await storage.readTrashPayload(entry.type, entry.trashId);
        const payload = wrapper?.payload || {};
        collectThoughtReferences(payload.thought, referenced);
        collectAssetIds(payload.content || '', referenced);
        collectAssetIds(payload.notepad?.content || '', referenced);
    }

    const meta = await storage.readNotepadsMeta();
    const notepads = Array.isArray(meta.notepads) ? meta.notepads : [];
    stats.notepads = notepads.length;
    for (const notepad of notepads) {
        // Strict: a failed read must abort the scan, not look like "no refs".
        const content = await storage.readNoteContentStrict(notepad);
        stats.notepadBytes += String(content || '').length;
        collectAssetIds(content, referenced);
    }

    // Instant drafts are short-lived but persist up to three days and can carry
    // a pasted asset link; an asset referenced only there is still in use.
    const drafts = await storage.readInstantDrafts();
    const draftList = Array.isArray(drafts) ? drafts : [];
    stats.drafts = draftList.length;
    for (const draft of draftList) collectAssetIds(draft?.text, referenced);

    return { referenced, stats };
}

async function gcOrphanAssets(options = {}) {
    const args = { ...parseArgs([]), ...options };
    const assets = createAssetStorage(storage);
    const all = (await assets.listAssets()).filter(Boolean);
    const { result: roots, warnings } = await watchCorruptReads(() => collectReferences());
    const { referenced, stats } = roots;
    const cutoff = Date.now() - args.graceDays * DAY_MS;

    const report = {
        backend: storage.backend,
        layout: storage.layout,
        s3Prefix: typeof storage.getS3Prefix === 'function' ? storage.getS3Prefix() : '',
        apply: Boolean(args.apply),
        graceDays: args.graceDays,
        expectOrphans: args.expectOrphans,
        references: stats,
        corruptReads: warnings,
        assets: all.length,
        referenced: 0,
        orphans: 0,
        orphanBytes: 0,
        skippedYoung: 0,
        skippedUnknownAge: 0,
        refused: false,
        reason: '',
        deleted: [],
        failed: [],
        largest: []
    };

    const candidates = [];
    for (const asset of all) {
        const id = String(asset?.id || '').toLowerCase();
        if (!id) continue;
        if (referenced.has(id)) {
            report.referenced += 1;
            continue;
        }
        const createdAt = Number(asset?.createdAt);
        if (!Number.isFinite(createdAt) || createdAt <= 0) {
            // Old metadata may have no createdAt; "unknown" is not "ancient".
            report.skippedUnknownAge += 1;
            continue;
        }
        if (createdAt > cutoff) {
            // Could be an upload whose Thought has not been written yet.
            report.skippedYoung += 1;
            continue;
        }
        candidates.push(asset);
        report.orphanBytes += Number(asset?.size) || 0;
    }
    report.orphans = candidates.length;
    report.largest = candidates
        .map(asset => ({ id: asset.id, name: asset.name || '', bytes: Number(asset.size) || 0, createdAt: Number(asset.createdAt) || 0 }))
        .slice(0, LARGEST_LIMIT)
        .sort((left, right) => right.bytes - left.bytes);

    if (!args.apply || candidates.length === 0) return report;

    // --- fail-closed gates -------------------------------------------------
    if (warnings.length) {
        report.refused = true;
        report.reason = 'corrupt storage read during the root scan';
        return report;
    }
    if (stats.thoughts === 0 && stats.notepads === 0 && stats.drafts === 0) {
        report.refused = true;
        report.reason = 'no Thought, no notepad and no draft: every asset looks orphaned (wrong DATA_DIR / S3_PREFIX?)';
        return report;
    }
    if (!Number.isFinite(args.expectOrphans)) {
        report.refused = true;
        report.reason = '--apply requires --expect-orphans N (run the dry-run first and pass its orphan count)';
        return report;
    }
    if (Number(args.expectOrphans) !== candidates.length) {
        report.refused = true;
        report.reason = `orphan count changed since the dry-run (expected ${args.expectOrphans}, found ${candidates.length})`;
        return report;
    }

    for (const asset of candidates) {
        try {
            const removed = await assets.deleteAsset(asset.id);
            if (removed) report.deleted.push(asset.id);
            else report.failed.push({ id: asset.id, error: 'asset not found' });
        } catch (error) {
            report.failed.push({ id: asset.id, error: error.message });
        }
    }
    return report;
}

if (require.main === module) {
    gcOrphanAssets(parseArgs()).then(report => {
        console.log(JSON.stringify(report, null, 2));
        if (report.refused) {
            console.error(`\nRefused: ${report.reason}`);
            process.exitCode = 1;
            return;
        }
        if (!report.apply) {
            console.log('\nDry run: nothing deleted. Re-run with --apply --expect-orphans ' + report.orphans + ' to reclaim.');
            return;
        }
        if (report.failed.length) {
            console.error(`\n${report.failed.length} asset(s) could not be deleted.`);
            process.exitCode = 2;
        }
    }).catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    gcOrphanAssets,
    parseArgs,
    collectAssetIds,
    collectThoughtReferences,
    collectReferences,
    DEFAULT_GRACE_DAYS
};
