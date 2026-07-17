#!/usr/bin/env node
'use strict';

/*
 * Emergency DumbPad recovery uploader.
 *
 * This program intentionally has a very narrow capability set:
 *
 *   local incident snapshots (read) -> a brand-new R2/S3 prefix (PUT only)
 *
 * It never initialises application storage and never imports a delete/copy
 * command.  The default is a dry run; --apply is required before any remote
 * write.  Even then, it refuses a non-empty destination and checks every key
 * immediately before writing it.  `recovery-verification.json` is written
 * only after every prior object has been read back and hash-verified.
 *
 * The tool deliberately uses already captured Qiniu and R2 snapshots instead
 * of connecting to either source.  That keeps the recovery reproducible and
 * avoids exposing or even requiring QINIU_S3_* credentials during upload.
 *
 * Usage (PowerShell):
 *   node -r dotenv/config scripts/recover-incident-to-s3.js `
 *     --edge-backup C:\path\dumbpad-browser-backup.json `
 *     --qiniu-snapshot C:\path\qiniu-before-restore `
 *     --r2-snapshot C:\path\r2-before-restore `
 *     --target-prefix dumbpad-recovery-YYYYMMDD-random
 *
 * Add --apply only after reviewing the dry-run JSON.  Values in .env are
 * consumed by the S3 client in memory and are never printed.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand
} = require('@aws-sdk/client-s3');

const DATE_TAG = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const REQUIRED_SOURCE_OPTIONS = ['edgeBackup', 'qiniuSnapshot', 'r2Snapshot'];

function fail(message) {
    // Do not pass through SDK error messages: they can contain endpoint data.
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
}

function parseArgs(argv) {
    const options = {
        apply: false,
        edgeBackup: '',
        qiniuSnapshot: '',
        r2Snapshot: '',
        targetPrefix: ''
    };
    const optionNames = new Map([
        ['--edge-backup', 'edgeBackup'],
        ['--qiniu-snapshot', 'qiniuSnapshot'],
        ['--r2-snapshot', 'r2Snapshot'],
        ['--target-prefix', 'targetPrefix']
    ]);

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') {
            options.apply = true;
            continue;
        }
        const option = optionNames.get(arg);
        if (!option) throw new Error(`Unknown option: ${arg}`);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
        options[option] = value;
        index += 1;
    }

    for (const key of REQUIRED_SOURCE_OPTIONS) {
        if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)} is required`);
    }
    return options;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function canonicalHash(value) {
    return sha256(Buffer.from(stableStringify(value), 'utf8'));
}

function thoughtUserContentHash(record) {
    // In this incident the recoverable substantive body is the Thought text.
    // The cache carries mutable task/tags/UI/AI fields that can differ between
    // two otherwise identical copies; the newer full record wins those fields
    // and every older raw object is still archived immutably.  Limiting the
    // conflict fingerprint to text avoids presenting stale cache metadata as
    // a user-visible content conflict or invalidating usable AI metadata.
    return sha256(Buffer.from(String(record?.text || ''), 'utf8'));
}

function safeId(value) {
    return String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
}

function sanitizeFilename(value) {
    return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Untitled';
}

function cleanPrefix(value) {
    return String(value || '').replace(/^\/+|\/+$/g, '');
}

function safeRelativePath(value) {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Snapshot contains an unsafe relative object path');
    }
    return normalized;
}

function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function sourcePriority(source) {
    if (source === 'r2') return 40;
    if (source === 'edge') return 30;
    if (source === 'qiniu-legacy') return 20;
    if (source === 'qiniu-split') return 10;
    return 0;
}

function newerCandidate(left, right) {
    const leftTime = toNumber(left.record?.updatedAt, 0);
    const rightTime = toNumber(right.record?.updatedAt, 0);
    if (leftTime !== rightTime) return leftTime > rightTime ? left : right;

    const leftVersion = toNumber(left.record?.version, 0);
    const rightVersion = toNumber(right.record?.version, 0);
    if (leftVersion !== rightVersion) return leftVersion > rightVersion ? left : right;

    return sourcePriority(left.source) >= sourcePriority(right.source) ? left : right;
}

async function readJsonFile(filePath, description) {
    let text;
    try {
        text = await fs.readFile(filePath, 'utf8');
    } catch {
        throw new Error(`${description} is unavailable`);
    }
    try {
        return { value: JSON.parse(text), bytes: Buffer.from(text, 'utf8') };
    } catch {
        throw new Error(`${description} is not valid JSON`);
    }
}

function ensureInside(root, relative) {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, relative);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error('Snapshot contains a path outside its incident directory');
    }
    return target;
}

async function loadSnapshot(directory, label) {
    const manifestPath = path.join(directory, 'manifest.json');
    const { value: manifest, bytes: manifestBytes } = await readJsonFile(manifestPath, `${label} snapshot manifest`);
    if (!manifest || !Array.isArray(manifest.objects)) {
        throw new Error(`${label} snapshot manifest has no object inventory`);
    }

    const objects = new Map();
    for (const entry of manifest.objects) {
        const relative = safeRelativePath(entry?.relative);
        if (objects.has(relative)) throw new Error(`${label} snapshot repeats an object path`);
        const sourcePath = ensureInside(directory, relative);
        let bytes;
        try {
            bytes = await fs.readFile(sourcePath);
        } catch {
            throw new Error(`${label} snapshot object is unavailable`);
        }
        if (Number.isFinite(Number(entry?.size)) && bytes.length !== Number(entry.size)) {
            throw new Error(`${label} snapshot object length does not match its manifest`);
        }
        if (entry?.sha256 && sha256(bytes) !== String(entry.sha256)) {
            throw new Error(`${label} snapshot object hash does not match its manifest`);
        }
        objects.set(relative, { bytes, manifest: entry });
    }

    return {
        label,
        manifest,
        manifestBytes,
        manifestHash: sha256(manifestBytes),
        objects
    };
}

function parseSnapshotJson(snapshot, relative, fallback = null) {
    const object = snapshot.objects.get(relative);
    if (!object) return fallback;
    try {
        return JSON.parse(object.bytes.toString('utf8'));
    } catch {
        throw new Error(`${snapshot.label} snapshot has invalid JSON at a required record`);
    }
}

async function loadEdgeBackup(filePath) {
    const { value: dump, bytes } = await readJsonFile(filePath, 'Edge browser backup');
    const startupRaw = dump?.dumbpad_startup_cache_v1;
    const thoughtsRaw = dump?.dumbpad_thoughts_cache_v1;
    let startup;
    let thoughtCache;
    try {
        startup = typeof startupRaw === 'string' ? JSON.parse(startupRaw) : startupRaw;
        thoughtCache = typeof thoughtsRaw === 'string' ? JSON.parse(thoughtsRaw) : thoughtsRaw;
    } catch {
        throw new Error('Edge browser backup has an invalid DumbPad cache payload');
    }
    if (!startup || !Array.isArray(startup.notepads) || !startup.notes || !Array.isArray(thoughtCache?.thoughts)) {
        throw new Error('Edge browser backup does not contain complete Notepad and Thought caches');
    }

    const notepads = [];
    for (const record of startup.notepads) {
        const id = String(record?.id || '').trim();
        if (!id) continue;
        const cached = startup.notes[id];
        const content = typeof cached === 'string' ? cached : cached?.content;
        if (typeof content !== 'string') {
            throw new Error('Edge browser backup is missing a Notepad body');
        }
        notepads.push({
            source: 'edge',
            record: { ...record },
            content,
            contentHash: sha256(Buffer.from(content, 'utf8'))
        });
    }

    const thoughts = thoughtCache.thoughts
        .filter(record => record && typeof record === 'object' && String(record.id || '').trim())
        .map(record => ({ source: 'edge', record: { ...record }, contentHash: thoughtUserContentHash(record) }));

    return {
        bytes,
        hash: sha256(bytes),
        notepads,
        thoughts,
        savedAt: toNumber(startup.savedAt, 0),
        thoughtCacheUpdatedAt: toNumber(thoughtCache.updatedAt, 0)
    };
}

function qiniuNotepadCandidates(snapshot) {
    const meta = parseSnapshotJson(snapshot, 'notepads.json', { notepads: [] });
    if (!Array.isArray(meta?.notepads)) throw new Error('Qiniu snapshot Notepad metadata is invalid');
    const result = [];
    for (const record of meta.notepads) {
        const id = String(record?.id || '').trim();
        if (!id) continue;
        const candidates = id === 'default'
            ? ['default.txt']
            : [`${sanitizeFilename(record?.name)}.txt`, `${sanitizeFilename(id)}.txt`];
        const relative = candidates.find(key => snapshot.objects.has(key));
        if (!relative) throw new Error('Qiniu snapshot has a Notepad with no matching body');
        const content = snapshot.objects.get(relative).bytes.toString('utf8');
        result.push({
            source: 'qiniu-legacy',
            record: { ...record },
            content,
            contentHash: sha256(Buffer.from(content, 'utf8'))
        });
    }
    return result;
}

function qiniuThoughtCandidates(snapshot) {
    const result = [];
    const legacy = parseSnapshotJson(snapshot, 'thoughts.json', []);
    if (!Array.isArray(legacy)) throw new Error('Qiniu snapshot legacy Thought list is invalid');
    for (const record of legacy) {
        if (!record || typeof record !== 'object' || !String(record.id || '').trim()) continue;
        result.push({ source: 'qiniu-legacy', record: { ...record }, contentHash: thoughtUserContentHash(record) });
    }
    for (const [relative, object] of snapshot.objects) {
        if (!/^thoughts\/[^/]+\.json$/i.test(relative)) continue;
        let record;
        try {
            record = JSON.parse(object.bytes.toString('utf8'));
        } catch {
            throw new Error('Qiniu snapshot contains invalid split Thought JSON');
        }
        if (!record || typeof record !== 'object' || !String(record.id || '').trim()) continue;
        result.push({ source: 'qiniu-split', record: { ...record }, contentHash: thoughtUserContentHash(record) });
    }
    return result;
}

function r2ThoughtCandidates(snapshot) {
    const legacy = parseSnapshotJson(snapshot, 'thoughts.json', []);
    if (!Array.isArray(legacy)) throw new Error('R2 snapshot legacy Thought list is invalid');
    return legacy
        .filter(record => record && typeof record === 'object' && String(record.id || '').trim())
        .map(record => ({ source: 'r2', record: { ...record }, contentHash: thoughtUserContentHash(record) }));
}

function mergeNotepads(edgeCandidates, qiniuCandidates) {
    const candidatesById = new Map();
    for (const candidate of [...qiniuCandidates, ...edgeCandidates]) {
        const id = String(candidate.record.id || '').trim();
        const list = candidatesById.get(id) || [];
        list.push(candidate);
        candidatesById.set(id, list);
    }

    const contentConflicts = [];
    const merged = [];
    for (const [id, candidates] of candidatesById) {
        const winner = candidates.reduce(newerCandidate);
        const loserHashes = new Set(candidates.filter(item => item !== winner).map(item => item.contentHash));
        if ([...loserHashes].some(hash => hash !== winner.contentHash)) {
            contentConflicts.push({ id, winner: winner.source, archivedSources: candidates.filter(item => item !== winner).map(item => item.source) });
        }
        const older = candidates.find(item => item !== winner) || null;
        const mergedRecord = {
            ...(older?.record || {}),
            ...winner.record,
            id
        };
        merged.push({
            id,
            record: mergedRecord,
            content: winner.content,
            source: winner.source,
            contentHash: winner.contentHash
        });
    }

    // The legacy reader addresses content by the sanitised display name.  Make
    // that key unambiguous before any remote write, while keeping `default`
    // special because it always maps to default.txt.
    const usedFilenames = new Set(['default.txt']);
    for (const item of merged.sort((a, b) => a.id.localeCompare(b.id))) {
        if (item.id === 'default') {
            item.record.name = String(item.record.name || 'Default Notepad');
            item.contentKey = 'default.txt';
            continue;
        }
        const baseName = String(item.record.name || 'Untitled').trim() || 'Untitled';
        let nextName = baseName;
        let filename = `${sanitizeFilename(nextName)}.txt`;
        let attempt = 1;
        while (usedFilenames.has(filename)) {
            attempt += 1;
            nextName = `${baseName} (${attempt})`;
            filename = `${sanitizeFilename(nextName)}.txt`;
        }
        if (nextName !== baseName) item.record.name = nextName;
        usedFilenames.add(filename);
        item.contentKey = filename;
    }

    return {
        items: merged.sort((a, b) => (b.record.updatedAt || 0) - (a.record.updatedAt || 0)),
        contentConflicts
    };
}

function mergeThoughts(candidates) {
    const candidatesById = new Map();
    for (const candidate of candidates) {
        const id = String(candidate.record.id || '').trim();
        const list = candidatesById.get(id) || [];
        list.push(candidate);
        candidatesById.set(id, list);
    }

    const conflicts = [];
    const winners = new Map();
    for (const [id, list] of candidatesById) {
        const winner = list.reduce(newerCandidate);
        winners.set(id, winner);
        const different = list.filter(item => item.contentHash !== winner.contentHash);
        if (different.length) {
            conflicts.push({
                id,
                winner: winner.source,
                archivedSources: [...new Set(different.map(item => item.source))]
            });
        }
    }

    return {
        items: [...winners.entries()]
            .map(([id, candidate]) => ({ id, source: candidate.source, contentHash: candidate.contentHash, record: { ...candidate.record, id } }))
            .sort((a, b) => (b.record.updatedAt || b.record.createdAt || 0) - (a.record.updatedAt || a.record.createdAt || 0)),
        winners,
        conflicts
    };
}

function newestCandidatesPerId(candidates) {
    const winners = new Map();
    for (const candidate of candidates) {
        const id = String(candidate?.record?.id || '').trim();
        if (!id) continue;
        const existing = winners.get(id);
        winners.set(id, existing ? newerCandidate(existing, candidate) : candidate);
    }
    return [...winners.values()];
}

function parseJsonObject(snapshot, relative) {
    const object = snapshot.objects.get(relative);
    if (!object) return null;
    try {
        const parsed = JSON.parse(object.bytes.toString('utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        throw new Error(`${snapshot.label} snapshot contains invalid JSON in an auxiliary record`);
    }
}

function buildLiveAuxiliaryData(qiniu, r2, mergedThoughts) {
    const activeIds = new Set(mergedThoughts.items.map(item => item.id));
    const activeHashById = new Map(mergedThoughts.items.map(item => [item.id, item.contentHash]));
    const qiniuHashesById = new Map();
    for (const candidate of qiniuThoughtCandidates(qiniu)) {
        const id = String(candidate.record?.id || '').trim();
        if (!id) continue;
        const hashes = qiniuHashesById.get(id) || new Set();
        hashes.add(candidate.contentHash);
        qiniuHashesById.set(id, hashes);
    }

    const meta = new Map();
    const loadMeta = (snapshot, source) => {
        for (const [relative] of snapshot.objects) {
            const match = relative.match(/^thoughts\.meta\/([^/]+)\.json$/i);
            if (!match) continue;
            const id = String(match[1] || '');
            if (!activeIds.has(id)) continue;
            // A Qiniu meta record is tied to its source Thought.  Do not carry
            // it into a newer, content-different Edge winner.
            if (source === 'qiniu' && !qiniuHashesById.get(id)?.has(activeHashById.get(id))) {
                continue;
            }
            const value = parseJsonObject(snapshot, relative);
            if (value) meta.set(id, { source, value });
        }
    };
    loadMeta(qiniu, 'qiniu');
    loadMeta(r2, 'r2');

    // Relation payloads include a small amount of derived AI data, but are
    // directly consumable by the legacy VPS and contain the user's manual
    // links.  Keep the whole valid record, rather than discarding all but the
    // manual edges.  This also preserves the saved relation-panel state.
    const relations = new Map();
    const keepKnownTargets = entries => (Array.isArray(entries) ? entries : [])
        .filter(entry => {
            const targetId = String(entry?.targetId || '').trim();
            return !targetId || activeIds.has(targetId);
        })
        .map(entry => ({ ...entry, ...(entry?.targetId ? { targetId: String(entry.targetId).trim() } : {}) }));
    const loadRelations = (snapshot, source) => {
        for (const [relative] of snapshot.objects) {
            const match = relative.match(/^relations\/([^/]+)\.json$/i);
            if (!match) continue;
            const sourceId = String(match[1] || '');
            if (!activeIds.has(sourceId)) continue;
            const value = parseJsonObject(snapshot, relative);
            if (!value) continue;
            relations.set(sourceId, {
                source,
                value: {
                    ...value,
                    id: sourceId,
                    edges: keepKnownTargets(value.edges),
                    suggestions: keepKnownTargets(value.suggestions)
                }
            });
        }
    };
    loadRelations(qiniu, 'qiniu');
    loadRelations(r2, 'r2');

    const suppressed = new Map();
    for (const snapshot of [qiniu, r2]) {
        for (const [relative] of snapshot.objects) {
            const match = relative.match(/^relations\.suppressed\/([^/]+)\.json$/i);
            if (!match) continue;
            const sourceId = String(match[1] || '');
            if (!activeIds.has(sourceId)) continue;
            const value = parseJsonObject(snapshot, relative);
            const edges = (Array.isArray(value?.edges) ? value.edges : [])
                .filter(edge => activeIds.has(String(edge?.targetId || '').trim()) && String(edge.targetId) !== sourceId)
                .map(edge => ({ ...edge, targetId: String(edge.targetId).trim() }));
            if (value) suppressed.set(sourceId, { ...value, id: sourceId, edges });
        }
    }

    const relationObjects = [...relations.entries()].map(([id, item]) => ({
        key: `relations/${safeId(id)}.json`,
        value: item.value
    }));
    const suppressedObjects = [...suppressed.values()].map(value => ({
        key: `relations.suppressed/${safeId(value.id)}.json`,
        value
    }));

    const relationCountById = new Map([...relations.entries()].map(([id, item]) => [id, item.value.edges.length]));
    return { meta, relationObjects, suppressedObjects, relationCountById };
}

function jsonObject(relative, value) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return { relative, bytes, contentType: 'application/json; charset=utf-8', kind: 'live' };
}

function textObject(relative, text) {
    return { relative, bytes: Buffer.from(text, 'utf8'), contentType: 'text/plain; charset=utf-8', kind: 'live' };
}

function rawObject(relative, bytes) {
    return { relative, bytes, contentType: 'application/octet-stream', kind: 'archive' };
}

function uniqueObjects(objects) {
    const result = new Map();
    for (const object of objects) {
        const relative = safeRelativePath(object.relative);
        if (result.has(relative)) throw new Error('Recovery plan would produce duplicate destination object keys');
        result.set(relative, { ...object, relative });
    }
    return [...result.values()];
}

function archiveSnapshot(snapshot, archiveRoot, includeManifest = true) {
    const objects = [];
    if (includeManifest) objects.push(rawObject(`${archiveRoot}/manifest.json`, snapshot.manifestBytes));
    for (const [relative, object] of snapshot.objects) {
        objects.push(rawObject(`${archiveRoot}/${relative}`, object.bytes));
    }
    return objects;
}

function buildRecoveryPlan({ edge, qiniu, r2, targetPrefix }) {
    const qiniuNotes = qiniuNotepadCandidates(qiniu);
    const mergedNotepads = mergeNotepads(edge.notepads, qiniuNotes);
    // The Qiniu snapshot contains both its legacy aggregate and older split
    // records.  Select its newest record per ID before comparing it with
    // Edge/R2; the historical split variants remain fully available in the
    // immutable archive but do not inflate the user-visible conflict count.
    const qiniuThoughts = newestCandidatesPerId(qiniuThoughtCandidates(qiniu));
    const mergedThoughts = mergeThoughts([...edge.thoughts, ...qiniuThoughts, ...r2ThoughtCandidates(r2)]);
    const auxiliary = buildLiveAuxiliaryData(qiniu, r2, mergedThoughts);

    const liveObjects = [];
    const notepads = mergedNotepads.items.map(item => item.record);
    liveObjects.push(jsonObject('notepads.json', { notepads }));
    for (const item of mergedNotepads.items) liveObjects.push(textObject(item.contentKey, item.content));

    const thoughts = mergedThoughts.items.map(item => ({
        ...item.record,
        relationCount: auxiliary.relationCountById.get(item.id) || 0
    }));
    liveObjects.push(jsonObject('thoughts.json', thoughts));
    for (const [id, meta] of auxiliary.meta) {
        liveObjects.push(jsonObject(`thoughts.meta/${safeId(id)}.json`, meta.value));
    }
    for (const item of auxiliary.relationObjects) liveObjects.push(jsonObject(item.key, item.value));
    for (const item of auxiliary.suppressedObjects) liveObjects.push(jsonObject(item.key, item.value));

    const archiveRoot = 'recovery-archive/20260716';
    const archiveObjects = [
        rawObject(`${archiveRoot}/edge-browser-backup.json`, edge.bytes),
        ...archiveSnapshot(qiniu, `${archiveRoot}/qiniu`),
        ...archiveSnapshot(r2, `${archiveRoot}/r2`)
    ];

    const objects = uniqueObjects([...liveObjects, ...archiveObjects]);
    const manifestObjects = objects.map(object => ({
        key: object.relative,
        kind: object.kind,
        bytes: object.bytes.length,
        sha256: sha256(object.bytes),
        contentType: object.contentType
    }));
    const recoveryManifest = {
        version: 1,
        kind: 'dumbpad-incident-recovery',
        createdAt: new Date().toISOString(),
        targetPrefix,
        safety: {
            sourceSnapshotsVerified: true,
            writesOnlyToNewPrefix: true,
            overwriteRefused: true,
            deleteOrCopyCommandsUsed: false,
            activationRequirement: 'Require recovery-verification.json before selecting this prefix in production.'
        },
        sourceSummary: {
            edge: {
                sha256: edge.hash,
                bytes: edge.bytes.length,
                notepads: edge.notepads.length,
                thoughts: edge.thoughts.length,
                savedAt: edge.savedAt,
                thoughtCacheUpdatedAt: edge.thoughtCacheUpdatedAt
            },
            qiniuSnapshot: {
                manifestSha256: qiniu.manifestHash,
                objects: qiniu.objects.size,
                bytes: [...qiniu.objects.values()].reduce((sum, item) => sum + item.bytes.length, 0)
            },
            r2Snapshot: {
                manifestSha256: r2.manifestHash,
                objects: r2.objects.size,
                bytes: [...r2.objects.values()].reduce((sum, item) => sum + item.bytes.length, 0)
            }
        },
        mergeSummary: {
            activeNotepads: notepads.length,
            activeThoughts: thoughts.length,
            articleContentConflictsArchived: mergedNotepads.contentConflicts,
            thoughtContentConflictsArchived: mergedThoughts.conflicts,
            importedThoughtMeta: auxiliary.meta.size,
            importedRelationRecords: auxiliary.relationObjects.length,
            importedSuppressionRecords: auxiliary.suppressedObjects.length,
            archiveRoot
        },
        objects: manifestObjects
    };

    return {
        targetPrefix,
        liveObjects,
        archiveObjects,
        objects,
        recoveryManifest,
        summary: {
            activeNotepads: notepads.length,
            activeThoughts: thoughts.length,
            liveObjects: liveObjects.length,
            archiveObjects: archiveObjects.length,
            totalObjectsBeforeManifests: objects.length,
            totalBytesBeforeManifests: objects.reduce((sum, item) => sum + item.bytes.length, 0),
            articleContentConflictsArchived: mergedNotepads.contentConflicts.length,
            thoughtContentConflictsArchived: mergedThoughts.conflicts.length,
            relationRecords: auxiliary.relationObjects.length,
            suppressionRecords: auxiliary.suppressedObjects.length,
            metaRecords: auxiliary.meta.size
        }
    };
}

function generateTargetPrefix() {
    return `dumbpad-recovery-${DATE_TAG}-${crypto.randomBytes(5).toString('hex')}`;
}

function validateTargetPrefix(value) {
    const prefix = cleanPrefix(value);
    if (!/^dumbpad-recovery-\d{8}-[a-z0-9]{8,}$/i.test(prefix)) {
        throw new Error('Target prefix must look like dumbpad-recovery-YYYYMMDD-random');
    }
    const activePrefix = cleanPrefix(process.env.S3_PREFIX);
    if (activePrefix && (prefix === activePrefix || prefix.startsWith(`${activePrefix}/`) || activePrefix.startsWith(`${prefix}/`))) {
        throw new Error('Target prefix must not be the active production prefix or an ancestor/child of it');
    }
    return prefix;
}

function createTargetClient() {
    const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY']
        .filter(name => !process.env[name]);
    if (!(process.env.S3_SECRET_KEY || process.env.S3_API_KEY)) missing.push('S3_SECRET_KEY or S3_API_KEY');
    if (missing.length) throw new Error(`Missing target S3 configuration: ${missing.join(', ')}`);
    return {
        bucket: process.env.S3_BUCKET,
        client: new S3Client({
            endpoint: process.env.S3_ENDPOINT,
            region: process.env.S3_REGION || 'auto',
            forcePathStyle: true,
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY,
                secretAccessKey: process.env.S3_SECRET_KEY || process.env.S3_API_KEY
            }
        })
    };
}

function targetKey(prefix, relative) {
    return `${prefix}/${safeRelativePath(relative)}`;
}

async function listTargetPrefix(client, bucket, prefix) {
    const items = [];
    let ContinuationToken;
    do {
        const result = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${prefix}/`,
            ContinuationToken
        }));
        items.push(...(result.Contents || []));
        ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);
    return items;
}

async function headMissing(client, bucket, key) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return false;
    } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return true;
        // A generic error may contain service details, so do not interpolate it.
        throw new Error('Destination pre-write existence check failed');
    }
}

async function bodyToBuffer(body) {
    if (!body) return Buffer.alloc(0);
    if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function uploadOne(client, bucket, prefix, object) {
    const key = targetKey(prefix, object.relative);
    if (!await headMissing(client, bucket, key)) {
        throw new Error('Destination was no longer empty; refusing to overwrite an object');
    }
    try {
        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: object.bytes,
            ContentType: object.contentType,
            // R2/S3 providers that support conditional puts get an additional
            // atomic no-overwrite guard.  If unsupported, the request fails
            // closed rather than relaxing this recovery invariant.
            IfNoneMatch: '*'
        }));
    } catch {
        throw new Error('Destination upload failed; no overwrite fallback is permitted');
    }
}

async function verifyOne(client, bucket, prefix, object) {
    const key = targetKey(prefix, object.relative);
    let response;
    try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
        throw new Error('Destination readback failed during verification');
    }
    const bytes = await bodyToBuffer(response.Body);
    if (sha256(bytes) !== sha256(object.bytes)) {
        throw new Error('Destination hash verification failed');
    }
}

async function applyPlan(plan) {
    const { client, bucket } = createTargetClient();
    const existing = await listTargetPrefix(client, bucket, plan.targetPrefix);
    if (existing.length) throw new Error('Destination prefix is not empty; refusing to overwrite any existing object');

    const manifestObject = jsonObject('recovery-manifest.json', plan.recoveryManifest);
    const uploadQueue = [...plan.objects, manifestObject];
    for (let index = 0; index < uploadQueue.length; index += 1) {
        await uploadOne(client, bucket, plan.targetPrefix, uploadQueue[index]);
        if ((index + 1) % 25 === 0 || index + 1 === uploadQueue.length) {
            console.log(JSON.stringify({ phase: 'upload', completed: index + 1, total: uploadQueue.length }));
        }
    }

    const verifyQueue = [...plan.objects, manifestObject];
    for (let index = 0; index < verifyQueue.length; index += 1) {
        await verifyOne(client, bucket, plan.targetPrefix, verifyQueue[index]);
        if ((index + 1) % 25 === 0 || index + 1 === verifyQueue.length) {
            console.log(JSON.stringify({ phase: 'verify', completed: index + 1, total: verifyQueue.length }));
        }
    }

    const verification = jsonObject('recovery-verification.json', {
        version: 1,
        kind: 'dumbpad-incident-recovery-verification',
        verifiedAt: new Date().toISOString(),
        targetPrefix: plan.targetPrefix,
        verifiedObjects: verifyQueue.length,
        manifestSha256: sha256(manifestObject.bytes),
        policy: 'All recovery data and the manifest were read back and SHA-256 verified before this marker was written.'
    });
    await uploadOne(client, bucket, plan.targetPrefix, verification);
    await verifyOne(client, bucket, plan.targetPrefix, verification);

    return {
        targetPrefix: plan.targetPrefix,
        uploadedObjects: uploadQueue.length + 1,
        verificationMarker: 'recovery-verification.json'
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const targetPrefix = validateTargetPrefix(options.targetPrefix || generateTargetPrefix());
    const [edge, qiniu, r2] = await Promise.all([
        loadEdgeBackup(options.edgeBackup),
        loadSnapshot(options.qiniuSnapshot, 'Qiniu'),
        loadSnapshot(options.r2Snapshot, 'R2')
    ]);
    const plan = buildRecoveryPlan({ edge, qiniu, r2, targetPrefix });

    console.log(JSON.stringify({
        ok: true,
        mode: options.apply ? 'apply' : 'dry-run',
        targetPrefix,
        safety: options.apply
            ? 'New empty prefix only; PUT with no-overwrite guards; no delete/copy; readback verification required.'
            : 'No remote writes performed. Add --apply only after reviewing this plan.',
        summary: plan.summary,
        activation: 'Do not set production S3_PREFIX until recovery-verification.json exists in this target prefix.'
    }, null, 2));

    if (!options.apply) return;
    const result = await applyPlan(plan);
    console.log(JSON.stringify({ ok: true, mode: 'apply-complete', ...result }, null, 2));
}

main().catch(error => fail(error?.message || 'Recovery program failed'));
