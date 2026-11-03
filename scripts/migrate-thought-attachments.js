/**
 * 存量内联附件迁移：把 Thought 里以 base64 dataUrl 存储的附件搬进 asset store，
 * 换成与上传端点一致的 asset 引用（assetId + originalUrl/downloadUrl）。
 * 图片走图片通道（sharp 生成 webp preview，与 /api/assets/images 同形），
 * 其它文件走 /api/assets/files 的白名单；白名单外的老类型（ps1/html/tar.gz…）
 * 默认保持内联，加 `--allow-unsupported-types` 则以 application/octet-stream
 * 存成只读资产（服务端仍以 attachment 下发，不放宽上传白名单）。
 *
 * 默认 dry-run，`--apply` 才写；幂等（已有 assetId 的跳过）；逐条 `readAsset`
 * 回读做字节校验后才替换，写盘前把整份集合并存到 data/legacy/。
 *
 * 用法（**必须停服或确认无写入时运行**：脚本拿不到 withThoughtWriteLock）：
 *   node scripts/migrate-thought-attachments.js                          # dry-run
 *   node scripts/migrate-thought-attachments.js --apply                  # 执行
 *   node scripts/migrate-thought-attachments.js --apply --allow-unsupported-types
 *   node scripts/migrate-thought-attachments.js --thought <id>           # 只处理一条
 *   node scripts/migrate-thought-attachments.js --limit 1                # 只处理一个附件
 *
 * 容器内运行（生产）：本地 data/ 常为 root 拥有，备份目录需要写权限：
 *   docker compose run --rm --no-deps --user root dumbpad node scripts/migrate-thought-attachments.js --apply
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
    const args = { apply: false, thoughtId: '', limit: 0, allowUnsupportedTypes: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.apply = false;
        else if (arg === '--allow-unsupported-types') args.allowUnsupportedTypes = true;
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
// object GETs). Mirrors asset-storage's per-kind name uniquing.
function createAssetIndex(metadatas) {
    const byHash = new Map();
    const namesByKind = new Map([['file', new Set()], ['image', new Set()]]);
    const remember = (meta) => {
        if (!meta) return;
        if (meta.hash) byHash.set(String(meta.hash), meta);
        const kind = String(meta.kind || 'image');
        if (!namesByKind.has(kind)) namesByKind.set(kind, new Set());
        if (meta.name) namesByKind.get(kind).add(String(meta.name));
    };
    (Array.isArray(metadatas) ? metadatas : []).forEach(remember);
    return {
        find: hash => byHash.get(String(hash || '')) || null,
        remember,
        uniqueName(name, kind = 'file') {
            const taken = namesByKind.get(String(kind)) || new Set();
            const wanted = String(name || '');
            if (!wanted || !taken.has(wanted)) return wanted;
            const dot = wanted.lastIndexOf('.');
            const hasExt = dot > 0 && dot < wanted.length - 1;
            const base = hasExt ? wanted.slice(0, dot) : wanted;
            const ext = hasExt ? wanted.slice(dot) : '';
            for (let n = 1; ; n += 1) {
                const candidate = ext ? `${base} (${n})${ext}` : `${base} (${n})`;
                if (!taken.has(candidate)) return candidate;
            }
        }
    };
}

// Inline images never went through `/api/assets/images`, so they are not in the
// file-asset whitelist either. Reproduce that route's pipeline (metadata +
// webp preview) so a migrated image is indistinguishable from an uploaded one.
const PREVIEW_EDGE = 2560;
const MAX_IMAGE_PIXELS = 100 * 1000 * 1000;
const MIME_BY_FORMAT = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif'
};

let sharpModule;
function getSharp() {
    if (sharpModule === undefined) {
        try {
            sharpModule = require('sharp');
        } catch (_error) {
            sharpModule = null;
        }
    }
    return sharpModule;
}

async function prepareImageAsset(buffer) {
    const sharp = getSharp();
    if (!sharp) return null;
    try {
        const image = sharp(buffer, { animated: false, limitInputPixels: MAX_IMAGE_PIXELS });
        const info = await image.metadata();
        const type = MIME_BY_FORMAT[info.format];
        if (!type) return null;
        const previewBuffer = await sharp(buffer, { animated: false, limitInputPixels: MAX_IMAGE_PIXELS })
            .rotate()
            .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82, effort: 4 })
            .toBuffer();
        return {
            type,
            previewBuffer,
            width: Number(info.width || 0),
            height: Number(info.height || 0)
        };
    } catch (_error) {
        return null;
    }
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
        allowUnsupportedTypes: Boolean(args.allowUnsupportedTypes),
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
            // Inline images never passed the file-asset whitelist; they belong to
            // the image channel (sharp preview + original), same as /api/assets/images.
            const declaredType = String(decoded.type || attachment.type || '');
            if (/^image\//i.test(declaredType)) {
                candidates.push({ thought, attachment, kind: 'image', type: declaredType });
                continue;
            }
            const validation = validateFileAssetUpload({
                name: attachment.name || 'attachment',
                type: decoded.type || attachment.type,
                size: decoded.buffer.length,
                maxBytes
            });
            if (validation.ok) {
                candidates.push({ thought, attachment, kind: 'file', type: validation.type });
                continue;
            }
            // Legacy code/config/archive attachments (ps1/html/tar.gz/...) are
            // outside the /file upload whitelist. Storing them as an opaque
            // octet-stream asset keeps the bytes reachable without widening what
            // the upload API accepts; serving stays Content-Disposition: attachment.
            if (args.allowUnsupportedTypes) {
                candidates.push({ thought, attachment, kind: 'file', type: 'application/octet-stream', unsupported: true });
                continue;
            }
            report.skipped.push({ thoughtId: thought.id, attachmentId: id, reason: validation.error || 'unsupported-type' });
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
                const name = String(candidate.attachment.name || 'attachment');
                let preview = null;
                if (candidate.kind === 'image') {
                    const prepared = await prepareImageAsset(decoded.buffer);
                    if (!prepared) {
                        // Unreadable/unsupported image bytes: keep the bytes as an
                        // opaque file when the operator allowed it, never drop them.
                        if (!args.allowUnsupportedTypes) throw new Error('unsupported-image');
                        candidate.kind = 'file';
                        candidate.type = 'application/octet-stream';
                    } else {
                        candidate.type = prepared.type;
                        preview = { buffer: prepared.previewBuffer, contentType: 'image/webp' };
                        metadata = {
                            version: 1,
                            kind: 'image',
                            id: assetId,
                            name: assetIndex.uniqueName(name, 'image'),
                            type: prepared.type,
                            size: decoded.buffer.length,
                            hash,
                            previewType: 'image/webp',
                            previewSize: prepared.previewBuffer.length,
                            width: prepared.width,
                            height: prepared.height,
                            createdAt: Date.now()
                        };
                    }
                }
                if (!metadata) {
                    metadata = {
                        version: 1,
                        kind: 'file',
                        id: assetId,
                        name: assetIndex.uniqueName(name, 'file'),
                        type: candidate.type,
                        size: decoded.buffer.length,
                        hash,
                        createdAt: Date.now()
                    };
                }
                await assets.writeAsset({
                    id: assetId,
                    metadata,
                    original: { buffer: decoded.buffer, contentType: metadata.type },
                    preview
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
