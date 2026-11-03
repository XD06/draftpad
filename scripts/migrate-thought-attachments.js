/**
 * 存量内联附件迁移：把 Thought 里以 base64 dataUrl 存储的附件搬进 asset store，
 * 换成与 `POST /api/assets/files` 完全一致的 asset 引用（assetId + originalUrl/
 * downloadUrl）。默认 dry-run，`--apply` 才写；幂等（已有 assetId 的跳过）；
 * 逐条 `readAsset` 回读做字节校验后才替换，写盘前把整份集合并存到 data/legacy/。
 *
 * 用法（**必须停服或确认无写入时运行**：脚本拿不到 withThoughtWriteLock）：
 *   node scripts/migrate-thought-attachments.js                 # dry-run 报告
 *   node scripts/migrate-thought-attachments.js --apply         # 执行
 *   node scripts/migrate-thought-attachments.js --thought <id>  # 只处理一条
 *   node scripts/migrate-thought-attachments.js --limit 1       # 只处理一条附件
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const storage = require('./storage');
const { createAssetStorage } = require('./asset-storage');
const { getMaxFileBytes, validateFileAssetUpload } = require('./file-asset-policy');

const LARGEST_LIMIT = 10;

function parseArgs(argv = process.argv.slice(2)) {
    const args = { apply: false, thoughtId: '', limit: 0 };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.apply = false;
        else if (arg === '--thought') args.thoughtId = String(argv[++index] || '');
        else if (arg.startsWith('--thought=')) args.thoughtId = arg.slice('--thought='.length);
        else if (arg === '--limit') args.limit = Number(argv[++index]) || 0;
        else if (arg.startsWith('--limit=')) args.limit = Number(argv[arg.indexOf('=') + 1]) || 0;
    }
    return args;
}

// `data:<mime>;base64,<payload>`（附件都由 FileReader.readAsDataURL 产生）。
// Buffer.from 对非法 base64 是宽容的（静默丢弃字符），所以这里要求**规范化往返
// 一致**：否则损坏的 data URL 会被"迁移"成另一段字节、原串又已丢弃。不一致就
// 返回 null，调用方保留原样并记入 skipped。
function decodeInlineDataUrl(dataUrl) {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
    if (!match) return null;
    const type = String(match[1] || '');
    try {
        if (match[2]) {
            const compact = match[3].replace(/\s+/g, '');
            const buffer = Buffer.from(compact, 'base64');
            if (!buffer.length) return null;
            if (buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) return null;
            return { buffer, type };
        }
        const buffer = Buffer.from(decodeURIComponent(match[3]), 'utf8');
        return buffer.length ? { buffer, type } : null;
    } catch (_error) {
        return null;
    }
}

function createAssetId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(20).toString('hex');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Same shape `hydrateAttachments()` writes for an assetId attachment, so the
// client cannot tell a migrated attachment from an uploaded one. The Thought
// keeps its own display name/type: the asset may be shared by hash dedupe and
// carries the first uploader's metadata.
function toAssetAttachment(attachment, metadata) {
    return {
        id: String(attachment.id || metadata.id),
        assetId: metadata.id,
        name: String(attachment.name || metadata.name),
        type: String(attachment.type || metadata.type),
        size: Number(attachment.size || metadata.size),
        kind: metadata.kind || 'file',
        previewUrl: metadata.previewType ? `/api/assets/${metadata.id}/preview` : null,
        originalUrl: `/api/assets/${metadata.id}/original`,
        downloadUrl: `/api/assets/${metadata.id}/download`
    };
}

// One metadata scan instead of `findByHash()` + `uniqueName()` per attachment
// (each of those re-lists every asset; on S3 that is O(attachments × assets)
// object GETs). Mirrors asset-storage's file-kind name uniquing.
function createAssetIndex(metadatas) {
    const byHash = new Map();
    const names = new Set();
    const remember = (meta) => {
        if (!meta) return;
        if (meta.hash) byHash.set(String(meta.hash), meta);
        if (String(meta.kind || 'image') === 'file' && meta.name) names.add(String(meta.name));
    };
    (Array.isArray(metadatas) ? metadatas : []).forEach(remember);
    return {
        find: hash => byHash.get(String(hash || '')) || null,
        remember,
        uniqueName(name) {
            const wanted = String(name || '');
            if (!wanted || !names.has(wanted)) return wanted;
            const dot = wanted.lastIndexOf('.');
            const hasExt = dot > 0 && dot < wanted.length - 1;
            const base = hasExt ? wanted.slice(0, dot) : wanted;
            const ext = hasExt ? wanted.slice(dot) : '';
            for (let n = 1; ; n += 1) {
                const candidate = ext ? `${base} (${n})${ext}` : `${base} (${n})`;
                if (!names.has(candidate)) return candidate;
            }
        }
    };
}

async function backupCollection(thoughts) {
    const dir = path.join(storage.paths.DATA_DIR, 'legacy');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `thoughts-before-attachment-migration-${Date.now()}.json`);
    await fs.writeFile(file, JSON.stringify(thoughts, null, 2), 'utf8');
    return file;
}

async function migrate(options = {}) {
    const args = { ...parseArgs([]), ...options };
    const thoughts = await storage.readThoughts();
    const assets = createAssetStorage(storage);
    const maxBytes = getMaxFileBytes();

    const report = {
        backend: storage.backend,
        layout: storage.layout,
        dataDir: storage.paths.DATA_DIR,
        s3Prefix: typeof storage.getS3Prefix === 'function' ? storage.getS3Prefix() : '',
        apply: Boolean(args.apply),
        thoughts: thoughts.length,
        inlineAttachments: 0,
        inlineBytes: 0,
        migratable: 0,
        migrated: 0,
        thoughtsWritten: 0,
        skipped: [],
        failed: [],
        largest: [],
        backup: null
    };

    // Pass 1: locate inline attachments. The decoded buffer is released on each
    // iteration so a huge collection cannot pin every attachment in memory.
    const candidates = [];
    for (const thought of thoughts) {
        if (args.thoughtId && thought.id !== args.thoughtId) continue;
        const attachments = Array.isArray(thought.attachments) ? thought.attachments : [];
        for (const attachment of attachments) {
            // An attachment that already has an assetId is migrated even if a
            // stale dataUrl was left behind; re-uploading it would orphan the
            // existing asset and could break dedupe sharing.
            if (!attachment || !attachment.dataUrl || attachment.assetId) continue;
            const id = String(attachment.id || '');
            report.inlineAttachments += 1;
            const decoded = decodeInlineDataUrl(attachment.dataUrl);
            report.inlineBytes += decoded ? decoded.buffer.length : String(attachment.dataUrl).length;
            report.largest.push({ thoughtId: thought.id, attachmentId: id, name: attachment.name || '', bytes: decoded ? decoded.buffer.length : 0 });
            if (!decoded) {
                report.skipped.push({ thoughtId: thought.id, attachmentId: id, reason: 'undecodable-data-url' });
                continue;
            }
            const validation = validateFileAssetUpload({
                name: attachment.name || 'attachment',
                type: decoded.type || attachment.type,
                size: decoded.buffer.length,
                maxBytes
            });
            if (!validation.ok) {
                report.skipped.push({ thoughtId: thought.id, attachmentId: id, reason: validation.error || 'unsupported-type' });
                continue;
            }
            candidates.push({ thought, attachment, type: validation.type });
        }
    }

    report.largest = report.largest.sort((left, right) => right.bytes - left.bytes).slice(0, LARGEST_LIMIT);
    const selected = args.limit > 0 ? candidates.slice(0, args.limit) : candidates;
    report.migratable = selected.length;
    if (!args.apply || selected.length === 0) return report;

    if (thoughts.length === 0) {
        throw new Error(`refusing to migrate an empty collection (backend=${storage.backend}, prefix=${report.s3Prefix || '-'}) — check DATA_DIR / S3_PREFIX`);
    }

    report.backup = await backupCollection(thoughts);

    const assetIndex = createAssetIndex(await assets.listAssets());
    const touchedThoughts = new Set();
    const migratedIds = new Set();

    for (const candidate of selected) {
        const id = String(candidate.attachment.id || '');
        try {
            const decoded = decodeInlineDataUrl(candidate.attachment.dataUrl);
            if (!decoded) throw new Error('undecodable-data-url');
            const hash = sha256(decoded.buffer);
            let metadata = assetIndex.find(hash);
            if (!metadata) {
                const assetId = createAssetId();
                metadata = {
                    version: 1,
                    kind: 'file',
                    id: assetId,
                    name: assetIndex.uniqueName(String(candidate.attachment.name || 'attachment')),
                    type: candidate.type,
                    size: decoded.buffer.length,
                    hash,
                    createdAt: Date.now()
                };
                await assets.writeAsset({
                    id: assetId,
                    metadata,
                    original: { buffer: decoded.buffer, contentType: candidate.type }
                });
                assetIndex.remember(metadata);
            }
            // Never point the Thought at an asset we cannot read back byte for
            // byte: a half-written asset would silently corrupt the attachment.
            const stored = await assets.readAsset(metadata.id, 'original');
            if (!stored || !stored.buffer.equals(decoded.buffer)) {
                throw new Error('asset verification failed');
            }
            const replacement = toAssetAttachment(candidate.attachment, metadata);
            candidate.thought.attachments = candidate.thought.attachments
                .map(item => (item === candidate.attachment ? replacement : item));
            touchedThoughts.add(candidate.thought);
            migratedIds.add(id);
            report.migrated += 1;
        } catch (error) {
            report.failed.push({ thoughtId: candidate.thought.id, attachmentId: id, error: error.message });
        }
    }

    // Per-Thought writes instead of one collection-wide saveThoughts(): the
    // split layout's save deletes every object missing from the snapshot, so a
    // full save would drop any Thought created between the read and the write.
    // writeThought also maintains the search index incrementally.
    for (const thought of touchedThoughts) {
        await storage.writeThought(thought);
        report.thoughtsWritten += 1;
    }
    return report;
}

if (require.main === module) {
    migrate(parseArgs()).then(report => {
        console.log(JSON.stringify(report, null, 2));
        if (!report.apply) {
            console.log('\nDry run: nothing written. Re-run with --apply to migrate.');
            return;
        }
        if (report.failed.length) {
            console.error(`\n${report.failed.length} attachment(s) failed and were left inline; re-run to retry.`);
            process.exitCode = 2;
        }
    }).catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    migrate,
    parseArgs,
    decodeInlineDataUrl,
    toAssetAttachment,
    createAssetIndex
};
