#!/usr/bin/env node
'use strict';

/*
 * Emergency Qiniu S3 audit for DumbPad recovery.
 *
 * Safety properties:
 * - Only reads QINIU_S3_* environment variables.
 * - Only imports ListObjectsV2Command and GetObjectCommand.
 * - Never prints an endpoint, bucket name, access key, secret, or object body.
 * - Never imports or calls PutObject, DeleteObject, CopyObject, or any app
 *   storage initialiser (which could initialise an empty data space).
 *
 * The output intentionally contains metadata, IDs, timestamps, sizes, and
 * object keys needed for a later merge plan. It never includes note/Thought
 * text, attachment bytes, trash previews, or AI text.
 */

const {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand
} = require('@aws-sdk/client-s3');

const Q = name => process.env[`QINIU_S3_${name}`];
const clean = value => String(value || '').replace(/^\/+|\/+$/g, '');
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
const asTime = value => {
    const number = asNumber(value);
    return number !== null && number >= 0 ? number : null;
};

// Object keys normally are harmless paths, but an object store allows almost
// any string as a key. Keep an accidental URL (including its query string and
// hostname) out of an incident report. This affects display only: S3 requests
// always use the original key held in memory.
function safeDisplay(value) {
    return String(value ?? '').replace(/(?:https?|s3):\/\/[^\s/?#]+(?:\/[^\s?#]*)?(?:[?#][^\s]*)?/gi, '[url-redacted]');
}

function displayKey(value) {
    return safeDisplay(value).replace(/[?#].*$/s, '');
}

function fail(message) {
    // Do not include process.env or raw SDK errors: they can contain endpoint
    // details or credentials in some providers' diagnostic messages.
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
}

const endpoint = Q('ENDPOINT');
const region = Q('REGION') || 'us-east-1';
const bucket = Q('BUCKET');
const accessKeyId = Q('ACCESS_KEY');
const secretAccessKey = Q('SECRET_KEY');
const configuredPrefix = clean(Q('PREFIX'));

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    fail('QINIU_S3_ENDPOINT, QINIU_S3_BUCKET, QINIU_S3_ACCESS_KEY, and QINIU_S3_SECRET_KEY must be present');
    return;
}

const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }
});

async function bodyToString(body) {
    if (!body) return '';
    if (typeof body.transformToString === 'function') return body.transformToString();
    if (typeof body.transformToByteArray === 'function') {
        return Buffer.from(await body.transformToByteArray()).toString('utf8');
    }
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

async function listAll() {
    const items = [];
    let ContinuationToken;
    do {
        const result = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken
        }));
        for (const item of result.Contents || []) {
            items.push({
                key: String(item.Key || ''),
                size: Number(item.Size || 0),
                lastModified: item.LastModified ? new Date(item.LastModified).toISOString() : null,
                etag: String(item.ETag || '')
            });
        }
        ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);
    return items;
}

async function getJsonSafely(key) {
    try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const text = await bodyToString(result.Body);
        try {
            return { ok: true, value: JSON.parse(text) };
        } catch {
            return { ok: false, reason: 'invalid_json' };
        }
    } catch (error) {
        return {
            ok: false,
            reason: error?.$metadata?.httpStatusCode === 404 ? 'not_found' : 'read_failed'
        };
    }
}

function rootFromMarker(key, marker) {
    if (key === marker) return '';
    const suffix = `/${marker}`;
    return key.endsWith(suffix) ? key.slice(0, -suffix.length) : null;
}

function rootFromFolder(key, folder) {
    if (key.startsWith(`${folder}/`)) return '';
    const needle = `/${folder}/`;
    const position = key.indexOf(needle);
    return position >= 0 ? key.slice(0, position) : null;
}

function relativeKey(root, key) {
    if (!root) return key;
    const prefix = `${root}/`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

function safeId(value) {
    return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').trim();
}

function sanitizeFilename(value) {
    return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

function attachmentIds(thought) {
    const result = [];
    for (const attachment of Array.isArray(thought?.attachments) ? thought.attachments : []) {
        if (!attachment || typeof attachment !== 'object') continue;
        const assetId = String(attachment.assetId || '').trim();
        const id = String(attachment.id || '').trim();
        const dataUrl = String(attachment.dataUrl || '');
        result.push({
            id: id ? safeDisplay(id) : null,
            assetId: assetId ? safeDisplay(assetId) : null,
            embedded: dataUrl.startsWith('data:'),
            hasRemoteUrl: Boolean(attachment.previewUrl || attachment.originalUrl || attachment.downloadUrl)
        });
    }
    return result;
}

function compactThought(thought, sourceKey, objectLastModified) {
    if (!thought || typeof thought !== 'object') return null;
    const id = String(thought.id || '').trim();
    return {
        id: id ? safeDisplay(id) : null,
        sourceKey: displayKey(sourceKey),
        createdAt: asTime(thought.createdAt),
        updatedAt: asTime(thought.updatedAt),
        version: asNumber(thought.version),
        objectLastModified,
        textLength: String(thought.text || '').length,
        subItemCount: Array.isArray(thought.subItems) ? thought.subItems.length : 0,
        attachmentRefs: attachmentIds(thought)
    };
}

function duplicateGroups(items, getId) {
    const grouped = new Map();
    for (const item of items) {
        const id = String(getId(item) || '').trim();
        if (!id) continue;
        const list = grouped.get(id) || [];
        list.push(item);
        grouped.set(id, list);
    }
    return Array.from(grouped.entries())
        .filter(([, list]) => list.length > 1)
        .map(([id, list]) => ({ id, sources: list.map(item => item.sourceKey || item.metaKey || item.contentKey || null) }));
}

function summarizeObject(object) {
    return {
        key: displayKey(object.key),
        size: object.size,
        lastModified: object.lastModified
    };
}

function assetSummary(entries) {
    const byId = new Map();
    for (const entry of entries) {
        const match = entry.relative.match(/^assets\/([^/]+)\/(original|preview|meta\.json)$/);
        if (!match) continue;
        const [, id, part] = match;
        const item = byId.get(id) || { id: safeDisplay(id), parts: {}, bytes: 0, lastModified: null };
        item.parts[part] = summarizeObject(entry.object);
        item.bytes += entry.object.size;
        if (!item.lastModified || new Date(entry.object.lastModified) > new Date(item.lastModified)) {
            item.lastModified = entry.object.lastModified;
        }
        byId.set(id, item);
    }
    return Array.from(byId.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function auditSpace(root, allObjects) {
    const entries = allObjects
        .map(object => ({ object, relative: relativeKey(root, object.key) }))
        .filter(entry => entry.relative !== null);
    const byRelative = new Map(entries.map(entry => [entry.relative, entry]));
    const exact = name => byRelative.get(name) || null;
    const rootTextFiles = entries.filter(entry => /^([^/]+)\.txt$/i.test(entry.relative));

    const notepadMeta = exact('notepads.json');
    const legacyThoughts = exact('thoughts.json');
    const splitThoughtObjects = entries.filter(entry => /^thoughts\/[^/]+\.json$/i.test(entry.relative));
    const metaObjects = entries.filter(entry => /^thoughts\.meta\/[^/]+\.json$/i.test(entry.relative));
    const relationObjects = entries.filter(entry => /^relations\/[^/]+\.json$/i.test(entry.relative));
    const suppressedRelationObjects = entries.filter(entry => /^relations\.suppressed\/[^/]+\.json$/i.test(entry.relative));
    const trashObjects = entries.filter(entry => /^trash\/(index\.json|notepads\/[^/]+\.json|thoughts\/[^/]+\.json)$/i.test(entry.relative));
    const agentRunObjects = entries.filter(entry => /^agent-runs\/(active-index\.json|[^/]+\.json)$/i.test(entry.relative));
    const indexObjects = entries.filter(entry => /^indexes\/[^/]+\.json$/i.test(entry.relative));
    const assets = assetSummary(entries);

    const notepads = [];
    const readProblems = [];
    if (notepadMeta) {
        const parsed = await getJsonSafely(notepadMeta.object.key);
        if (!parsed.ok || !Array.isArray(parsed.value?.notepads)) {
            readProblems.push({ key: displayKey(notepadMeta.object.key), kind: 'notepads', reason: parsed.reason || 'invalid_shape' });
        } else {
            for (const notepad of parsed.value.notepads) {
                const id = String(notepad?.id || '').trim();
                const name = String(notepad?.name || '').trim();
                const expected = id === 'default'
                    ? ['default.txt']
                    : [`${sanitizeFilename(name)}.txt`, `${sanitizeFilename(id)}.txt`];
                const contentKeys = expected.filter(key => byRelative.has(key));
                notepads.push({
                    id: id ? safeDisplay(id) : null,
                    name: name ? safeDisplay(name) : null,
                    createdAt: asTime(notepad?.createdAt),
                    updatedAt: asTime(notepad?.updatedAt),
                    version: asNumber(notepad?.version),
                    contentKeys: contentKeys.map(displayKey),
                    contentState: contentKeys.length === 0 ? 'missing' : (contentKeys.length > 1 ? 'ambiguous' : 'present')
                });
            }
        }
    }

    const thoughts = [];
    if (legacyThoughts) {
        const parsed = await getJsonSafely(legacyThoughts.object.key);
        if (!parsed.ok || !Array.isArray(parsed.value)) {
            readProblems.push({ key: displayKey(legacyThoughts.object.key), kind: 'legacy_thoughts', reason: parsed.reason || 'invalid_shape' });
        } else {
            for (const thought of parsed.value) {
                const compact = compactThought(thought, legacyThoughts.object.key, legacyThoughts.object.lastModified);
                if (compact) thoughts.push({ ...compact, layout: 'legacy' });
            }
        }
    }

    // Bounded concurrency avoids accidentally hitting Qiniu with a burst when
    // a historical space has many split Thought records.
    const queue = [...splitThoughtObjects];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length) {
            const entry = queue.shift();
            const parsed = await getJsonSafely(entry.object.key);
            if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
                readProblems.push({ key: displayKey(entry.object.key), kind: 'split_thought', reason: parsed.reason || 'invalid_shape' });
                continue;
            }
            const compact = compactThought(parsed.value, entry.object.key, entry.object.lastModified);
            if (compact) thoughts.push({ ...compact, layout: 'split' });
        }
    });
    await Promise.all(workers);

    const knownRelativeKeys = new Set([
        'notepads.json',
        'thoughts.json',
        ...rootTextFiles.map(entry => entry.relative),
        ...splitThoughtObjects.map(entry => entry.relative),
        ...metaObjects.map(entry => entry.relative),
        ...relationObjects.map(entry => entry.relative),
        ...suppressedRelationObjects.map(entry => entry.relative),
        ...trashObjects.map(entry => entry.relative),
        ...agentRunObjects.map(entry => entry.relative),
        ...indexObjects.map(entry => entry.relative),
        ...entries.filter(entry => /^assets\/[^/]+\/(original|preview|meta\.json)$/i.test(entry.relative)).map(entry => entry.relative)
    ]);
    const unknownObjects = entries.filter(entry => !knownRelativeKeys.has(entry.relative));

    const thoughtRefs = new Map();
    let embeddedAttachmentCount = 0;
    for (const thought of thoughts) {
        for (const ref of thought.attachmentRefs) {
            if (ref.embedded) embeddedAttachmentCount += 1;
            if (ref.assetId) thoughtRefs.set(ref.assetId, (thoughtRefs.get(ref.assetId) || 0) + 1);
        }
    }
    const assetIds = new Set(assets.map(asset => asset.id));
    const danglingAssetReferences = Array.from(thoughtRefs.entries())
        .filter(([id]) => !assetIds.has(id))
        .map(([id, referenceCount]) => ({ id, referenceCount }));
    const unreferencedAssets = assets
        .filter(asset => !thoughtRefs.has(asset.id))
        .map(asset => asset.id);

    const notepadContentKeySet = new Set(notepads.flatMap(item => item.contentKeys));
    const orphanTextFiles = rootTextFiles
        .filter(entry => !notepadContentKeySet.has(displayKey(entry.relative)))
        .map(entry => summarizeObject(entry.object));

    return {
        root: root ? displayKey(root) : '(bucket-root)',
        objectCount: entries.length,
        totalBytes: entries.reduce((sum, entry) => sum + entry.object.size, 0),
        latestObjectAt: entries.reduce((latest, entry) => (
            !latest || new Date(entry.object.lastModified) > new Date(latest) ? entry.object.lastModified : latest
        ), null),
        layout: {
            legacyThoughts: Boolean(legacyThoughts),
            splitThoughtCount: splitThoughtObjects.length,
            mixedThoughtLayouts: Boolean(legacyThoughts && splitThoughtObjects.length)
        },
        notepads: {
            meta: notepadMeta ? summarizeObject(notepadMeta.object) : null,
            count: notepads.length,
            entries: notepads,
            duplicateIds: duplicateGroups(notepads, item => item.id),
            duplicateNames: duplicateGroups(notepads, item => item.name),
            missingContent: notepads.filter(item => item.contentState === 'missing').map(item => item.id),
            ambiguousContent: notepads.filter(item => item.contentState === 'ambiguous').map(item => item.id),
            orphanTextFiles
        },
        thoughts: {
            legacy: legacyThoughts ? summarizeObject(legacyThoughts.object) : null,
            totalCount: thoughts.length,
            legacyCount: thoughts.filter(item => item.layout === 'legacy').length,
            splitCount: thoughts.filter(item => item.layout === 'split').length,
            entries: thoughts.sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''))),
            duplicateIds: duplicateGroups(thoughts, item => item.id),
            missingIds: thoughts.filter(item => !item.id).map(item => item.sourceKey)
        },
        derivedAndRecoveryObjects: {
            metaCount: metaObjects.length,
            metaKeys: metaObjects.map(entry => summarizeObject(entry.object)),
            relationCount: relationObjects.length,
            relationKeys: relationObjects.map(entry => summarizeObject(entry.object)),
            suppressedRelationCount: suppressedRelationObjects.length,
            suppressedRelationKeys: suppressedRelationObjects.map(entry => summarizeObject(entry.object)),
            trashCount: trashObjects.length,
            trashKeys: trashObjects.map(entry => summarizeObject(entry.object)),
            agentRunCount: agentRunObjects.length,
            agentRunKeys: agentRunObjects.map(entry => summarizeObject(entry.object)),
            indexCount: indexObjects.length,
            indexKeys: indexObjects.map(entry => summarizeObject(entry.object))
        },
        attachments: {
            assetCount: assets.length,
            assets,
            thoughtAssetReferenceCount: Array.from(thoughtRefs.values()).reduce((sum, count) => sum + count, 0),
            embeddedDataUrlAttachmentCount: embeddedAttachmentCount,
            danglingAssetReferences,
            unreferencedAssets
        },
        unknownObjects: unknownObjects.map(entry => summarizeObject(entry.object)),
        readProblems
    };
}

function compactSpaceForConsole(space) {
    // Useful when the audit is being pasted into a terminal/chat. The full
    // report remains available by leaving DUMBPAD_QINIU_AUDIT_SUMMARY unset.
    // It preserves every primary-record ID/timestamp needed to decide whether
    // this space is a recovery source, but removes long object-key inventories.
    return {
        root: space.root,
        objectCount: space.objectCount,
        totalBytes: space.totalBytes,
        latestObjectAt: space.latestObjectAt,
        layout: space.layout,
        notepads: {
            count: space.notepads.count,
            entries: space.notepads.entries.map(item => ({
                id: item.id,
                name: item.name,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                version: item.version,
                contentState: item.contentState
            })),
            duplicateIds: space.notepads.duplicateIds,
            duplicateNames: space.notepads.duplicateNames,
            missingContent: space.notepads.missingContent,
            ambiguousContent: space.notepads.ambiguousContent,
            orphanTextFileCount: space.notepads.orphanTextFiles.length
        },
        thoughts: {
            totalCount: space.thoughts.totalCount,
            legacyCount: space.thoughts.legacyCount,
            splitCount: space.thoughts.splitCount,
            entries: space.thoughts.entries.map(item => ({
                id: item.id,
                layout: item.layout,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                version: item.version,
                objectLastModified: item.objectLastModified,
                textLength: item.textLength,
                attachmentRefCount: item.attachmentRefs.length
            })),
            duplicateIds: space.thoughts.duplicateIds,
            missingIds: space.thoughts.missingIds
        },
        derivedAndRecoveryCounts: {
            meta: space.derivedAndRecoveryObjects.metaCount,
            relations: space.derivedAndRecoveryObjects.relationCount,
            suppressedRelations: space.derivedAndRecoveryObjects.suppressedRelationCount,
            trash: space.derivedAndRecoveryObjects.trashCount,
            agentRuns: space.derivedAndRecoveryObjects.agentRunCount,
            indexes: space.derivedAndRecoveryObjects.indexCount
        },
        attachments: {
            assetCount: space.attachments.assetCount,
            thoughtAssetReferenceCount: space.attachments.thoughtAssetReferenceCount,
            embeddedDataUrlAttachmentCount: space.attachments.embeddedDataUrlAttachmentCount,
            danglingAssetReferences: space.attachments.danglingAssetReferences,
            unreferencedAssetCount: space.attachments.unreferencedAssets.length
        },
        unknownObjectCount: space.unknownObjects.length,
        readProblems: space.readProblems
    };
}

(async () => {
    let objects;
    try {
        objects = await listAll();
    } catch {
        fail('Qiniu object listing failed; verify the QINIU_S3_* values and that the access key has ListBucket permission');
        return;
    }

    const roots = new Set();
    if (configuredPrefix) roots.add(configuredPrefix);
    for (const object of objects) {
        for (const marker of ['notepads.json', 'thoughts.json', 'trash/index.json']) {
            const root = rootFromMarker(object.key, marker);
            if (root !== null) roots.add(root);
        }
        for (const folder of ['thoughts', 'thoughts.meta', 'relations', 'relations.suppressed', 'assets', 'trash']) {
            const root = rootFromFolder(object.key, folder);
            if (root !== null) roots.add(root);
        }
    }

    const candidateRoots = Array.from(roots)
        .filter(root => root === '' || objects.some(object => relativeKey(root, object.key) !== null))
        .sort((a, b) => a.localeCompare(b));
    const spaces = [];
    for (const root of candidateRoots) spaces.push(await auditSpace(root, objects));

    const configuredSpaceLabel = configuredPrefix ? displayKey(configuredPrefix) : '(bucket-root)';
    const configuredSpace = spaces.find(space => space.root === configuredSpaceLabel) || null;
    const report = {
        ok: true,
        safety: 'ListObjectsV2 + GetObject only; no object bodies or credentials emitted; no writes performed.',
        bucketObjectCount: objects.length,
        bucketTotalBytes: objects.reduce((sum, object) => sum + object.size, 0),
        configuredPrefixHasObjects: configuredPrefix
            ? objects.some(object => object.key === configuredPrefix || object.key.startsWith(`${configuredPrefix}/`))
            : objects.length > 0,
        configuredSpaceFound: Boolean(configuredSpace),
        spaces: process.env.DUMBPAD_QINIU_AUDIT_SUMMARY === '1'
            ? spaces.map(compactSpaceForConsole)
            : spaces
    };
    console.log(JSON.stringify(report, null, 2));
})().catch(() => fail('unexpected audit failure'));
