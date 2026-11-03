/**
 * 孤儿 asset 回收：找出 asset store 里没有任何持久引用指向的资产。
 *
 * 引用根（缺一不可，宁可漏删不可误删）：
 *   1. Thought 的 attachments[].assetId；
 *   2. 垃圾桶里可恢复的 payload（Thought 附件 / 文章正文里的 /api/assets/<id>）；
 *   3. 所有文章 Markdown 里的 /api/assets/<id>（/file 插入的图片、音视频、附件）。
 * 离线 outbox 与"刚上传、引用还没写盘"的资产无法在服务端枚举，所以默认只回收
 * 宽限期（默认 7 天）之前创建的资产。
 *
 * 默认 dry-run；`--apply` 才删。引用根为空（没有 Thought、没有文章、却有资产）
 * 时拒绝执行——那基本是 prefix/挂载点配错了，不是真的全空。
 *
 * 用法（建议停写或低峰执行）：
 *   node scripts/gc-orphan-assets.js                 # 报告
 *   node scripts/gc-orphan-assets.js --apply         # 回收
 *   node scripts/gc-orphan-assets.js --grace-days 14 # 更保守
 */

'use strict';

const path = require('path');

const storage = require('./storage');
const { createAssetStorage } = require('./asset-storage');

const DEFAULT_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const LARGEST_LIMIT = 20;
// 任何变体（/original、/preview、/download）都算引用。
const ASSET_URL_RE = /\/api\/assets\/([a-f0-9-]{16,64})/gi;

function parseArgs(argv = process.argv.slice(2)) {
    const args = { apply: false, graceDays: DEFAULT_GRACE_DAYS };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.apply = false;
        else if (arg === '--grace-days') args.graceDays = Number(argv[++index]);
        else if (arg.startsWith('--grace-days=')) args.graceDays = Number(arg.slice('--grace-days='.length));
    }
    if (!Number.isFinite(args.graceDays) || args.graceDays < 0) args.graceDays = DEFAULT_GRACE_DAYS;
    return args;
}

function collectAssetIds(text, into) {
    const value = String(text || '');
    ASSET_URL_RE.lastIndex = 0;
    let match = ASSET_URL_RE.exec(value);
    while (match) {
        into.add(String(match[1]).toLowerCase());
        match = ASSET_URL_RE.exec(value);
    }
    return into;
}

function collectAttachmentIds(thought, into) {
    const attachments = Array.isArray(thought?.attachments) ? thought.attachments : [];
    for (const attachment of attachments) {
        const id = String(attachment?.assetId || '').toLowerCase();
        if (id) into.add(id);
    }
    return into;
}

async function collectReferences() {
    const referenced = new Set();
    const stats = { thoughts: 0, trashItems: 0, notepads: 0, notepadBytes: 0 };

    const thoughts = await storage.readThoughts();
    stats.thoughts = thoughts.length;
    for (const thought of thoughts) collectAttachmentIds(thought, referenced);

    const trashItems = await storage.listTrashItems();
    stats.trashItems = trashItems.length;
    for (const entry of trashItems) {
        const item = await storage.getTrashItem(entry.trashId);
        // getTrashItem returns the wrapper { version, trashId, type, payload }.
        // A trashed Thought keeps its attachments; a trashed notepad keeps its
        // markdown under `content` (NOT notepad.content) — missing that would
        // delete media of an article that is still restorable.
        const payload = item?.payload?.payload || {};
        collectAttachmentIds(payload.thought, referenced);
        collectAssetIds(payload.content || '', referenced);
        collectAssetIds(payload.notepad?.content || '', referenced);
    }

    const meta = await storage.readNotepadsMeta();
    const notepads = Array.isArray(meta.notepads) ? meta.notepads : [];
    stats.notepads = notepads.length;
    for (const notepad of notepads) {
        const content = await storage.readNoteContent(notepad);
        stats.notepadBytes += String(content || '').length;
        collectAssetIds(content, referenced);
    }

    return { referenced, stats };
}

async function gcOrphanAssets(options = {}) {
    const args = { ...parseArgs([]), ...options };
    const assets = createAssetStorage(storage);
    const all = (await assets.listAssets()).filter(Boolean);
    const { referenced, stats } = await collectReferences();
    const cutoff = Date.now() - args.graceDays * DAY_MS;

    const report = {
        backend: storage.backend,
        layout: storage.layout,
        s3Prefix: typeof storage.getS3Prefix === 'function' ? storage.getS3Prefix() : '',
        apply: Boolean(args.apply),
        graceDays: args.graceDays,
        references: stats,
        assets: all.length,
        referenced: 0,
        orphans: 0,
        orphanBytes: 0,
        skippedYoung: 0,
        refused: false,
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
        const createdAt = Number(asset?.createdAt) || 0;
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
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, LARGEST_LIMIT);

    if (!args.apply || candidates.length === 0) return report;

    // Nothing to reference at all: that is a misconfigured prefix, not a real
    // empty workspace. Refuse instead of deleting every asset.
    if (stats.thoughts === 0 && stats.notepads === 0) {
        report.refused = true;
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
        if (!report.apply) {
            console.log('\nDry run: nothing deleted. Re-run with --apply to reclaim.');
            return;
        }
        if (report.refused) {
            console.error('\nRefused: no Thought and no notepad found, so every asset looks orphaned. Check DATA_DIR / S3_PREFIX.');
            process.exit(1);
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
    collectReferences,
    DEFAULT_GRACE_DAYS
};
