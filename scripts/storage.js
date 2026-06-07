const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const {
    sanitizeFilename,
    getNotepadFilePath,
    migrateDefaultNotepad
} = require('./notepad-migration');
const s3 = require('./s3-service');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const NOTEPADS_FILE = path.join(DATA_DIR, 'notepads.json');
const THOUGHTS_FILE = path.join(DATA_DIR, 'thoughts.json');
const THOUGHTS_DIR = path.join(DATA_DIR, 'thoughts');
const META_DIR = path.join(DATA_DIR, 'thoughts.meta');
const RELATIONS_DIR = path.join(DATA_DIR, 'relations');
const SUPPRESSED_RELATIONS_DIR = path.join(DATA_DIR, 'relations.suppressed');
const INDEX_DIR = path.join(DATA_DIR, 'indexes');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const TRASH_NOTEPADS_DIR = path.join(TRASH_DIR, 'notepads');
const TRASH_THOUGHTS_DIR = path.join(TRASH_DIR, 'thoughts');
const TRASH_INDEX_FILE = path.join(TRASH_DIR, 'index.json');
const STORAGE_LAYOUT = process.env.STORAGE_LAYOUT === 'split' ? 'split' : 'legacy';
const STORAGE_BACKEND = process.env.STORAGE_BACKEND === 's3' ? 's3' : 'local';
const STORAGE_STATE_FILE = path.join(__dirname, '..', 'config', 'storage-state.json');

function cleanPrefix(prefix) {
    return String(prefix || '').replace(/^\/+|\/+$/g, '');
}

function readStorageState() {
    try {
        return JSON.parse(fsSync.readFileSync(STORAGE_STATE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

let activeS3Prefix = cleanPrefix(readStorageState().activeS3Prefix || process.env.S3_PREFIX || '');

function isS3Backend() {
    return STORAGE_BACKEND === 's3';
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readJSON(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

async function writeJSON(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tempPath, filePath);
}

function s3Key(key) {
    const cleanKey = String(key || '').replace(/^\/+/, '');
    return activeS3Prefix ? `${activeS3Prefix}/${cleanKey}` : cleanKey;
}

async function setS3Prefix(prefix) {
    const clean = cleanPrefix(prefix);
    if (!clean) throw new Error('S3 prefix is required');
    activeS3Prefix = clean;
    await fs.mkdir(path.dirname(STORAGE_STATE_FILE), { recursive: true });
    await fs.writeFile(STORAGE_STATE_FILE, JSON.stringify({ activeS3Prefix: clean, updatedAt: Date.now() }, null, 2), 'utf8');
    return activeS3Prefix;
}

function getS3Prefix() {
    return activeS3Prefix;
}

async function s3ReadJSON(key, fallback) {
    return s3.getJSONObject(s3Key(key), fallback);
}

async function s3WriteJSON(key, value) {
    await s3.putObject(s3Key(key), JSON.stringify(value, null, 2), 'application/json');
}

async function s3PathExists(key) {
    return !!await s3.headObject(s3Key(key));
}

function safeId(id) {
    return String(id || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

function thoughtPath(id) {
    const filename = safeId(id);
    if (!filename) throw new Error('Thought id is required');
    return path.join(THOUGHTS_DIR, `${filename}.json`);
}

function thoughtIndexFrom(thoughts) {
    return {
        items: thoughts.map(thought => ({
            id: thought.id,
            type: 'thought',
            textPreview: String(thought.text || '').slice(0, 300),
            tags: Array.isArray(thought.tags) ? thought.tags : [],
            completed: !!thought.completed,
            createdAt: thought.createdAt || 0,
            updatedAt: thought.updatedAt || 0
        })),
        updatedAt: Date.now()
    };
}

function createTrashId(type, sourceId) {
    return `${Date.now()}-${type}-${safeId(sourceId) || 'item'}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTrashIndex(index) {
    const items = Array.isArray(index?.items) ? index.items.filter(item => item && item.trashId && item.type) : [];
    return {
        version: 1,
        updatedAt: Number.isFinite(Number(index?.updatedAt)) ? Number(index.updatedAt) : Date.now(),
        items: items.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    };
}

function trashPayloadKey(type, trashId) {
    const folder = type === 'thought' ? 'thoughts' : 'notepads';
    return `trash/${folder}/${safeId(trashId)}.json`;
}

function trashPayloadPath(type, trashId) {
    const dir = type === 'thought' ? TRASH_THOUGHTS_DIR : TRASH_NOTEPADS_DIR;
    return path.join(dir, `${safeId(trashId)}.json`);
}

async function readTrashIndex() {
    await init();
    if (isS3Backend()) return normalizeTrashIndex(await s3ReadJSON('trash/index.json', { version: 1, items: [] }));
    return normalizeTrashIndex(await readJSON(TRASH_INDEX_FILE, { version: 1, items: [] }));
}

async function writeTrashIndex(index) {
    const payload = normalizeTrashIndex({ ...index, updatedAt: Date.now() });
    if (isS3Backend()) {
        await s3WriteJSON('trash/index.json', payload);
        return payload;
    }
    await writeJSON(TRASH_INDEX_FILE, payload);
    return payload;
}

async function writeTrashPayload(type, trashId, payload) {
    if (isS3Backend()) {
        await s3WriteJSON(trashPayloadKey(type, trashId), payload);
        return;
    }
    await writeJSON(trashPayloadPath(type, trashId), payload);
}

async function readTrashPayload(type, trashId) {
    if (isS3Backend()) return s3ReadJSON(trashPayloadKey(type, trashId), null);
    return readJSON(trashPayloadPath(type, trashId), null);
}

async function deleteTrashPayload(type, trashId) {
    if (isS3Backend()) {
        await s3.deleteObject(s3Key(trashPayloadKey(type, trashId)));
        return;
    }
    await fs.rm(trashPayloadPath(type, trashId), { force: true });
}

function trashPreview(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function addTrashItem({ type, sourceId, title, preview, payload }) {
    const now = Date.now();
    const trashId = createTrashId(type, sourceId);
    const item = {
        trashId,
        type,
        sourceId: String(sourceId || ''),
        title: String(title || 'Untitled'),
        preview: trashPreview(preview),
        deletedAt: now,
        originalUpdatedAt: payload?.notepad?.updatedAt || payload?.thought?.updatedAt || payload?.notepad?.createdAt || payload?.thought?.createdAt || 0,
        payloadKey: trashPayloadKey(type, trashId)
    };
    await writeTrashPayload(type, trashId, {
        version: 1,
        trashId,
        type,
        sourceId: item.sourceId,
        deletedAt: now,
        payload
    });
    const index = await readTrashIndex();
    index.items = [item, ...index.items.filter(existing => existing.trashId !== trashId)];
    await writeTrashIndex(index);
    return item;
}

async function listTrashItems() {
    const index = await readTrashIndex();
    return index.items;
}

async function getTrashItem(trashId) {
    const index = await readTrashIndex();
    const item = index.items.find(entry => entry.trashId === trashId);
    if (!item) return null;
    const payload = await readTrashPayload(item.type, item.trashId);
    return payload ? { item, payload } : null;
}

async function deleteTrashItem(trashId) {
    const index = await readTrashIndex();
    const item = index.items.find(entry => entry.trashId === trashId);
    if (!item) return false;
    await deleteTrashPayload(item.type, item.trashId);
    index.items = index.items.filter(entry => entry.trashId !== trashId);
    await writeTrashIndex(index);
    return true;
}

async function emptyTrash() {
    const index = await readTrashIndex();
    for (const item of index.items) {
        await deleteTrashPayload(item.type, item.trashId);
    }
    await writeTrashIndex({ version: 1, items: [] });
    return { success: true, deleted: index.items.length };
}

async function writeThoughtIndex(thoughts) {
    await writeIndex('thoughts-index', thoughtIndexFrom(thoughts));
}

async function readSplitThoughts() {
    await fs.mkdir(THOUGHTS_DIR, { recursive: true });
    const entries = await fs.readdir(THOUGHTS_DIR, { withFileTypes: true });
    const thoughts = [];

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const thought = await readJSON(path.join(THOUGHTS_DIR, entry.name), null);
        if (thought && thought.id) thoughts.push(thought);
    }

    return thoughts.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

async function readS3SplitThoughts() {
    const entries = await s3.listObjects(s3Key('thoughts/'));
    const thoughts = [];

    for (const entry of entries) {
        if (!entry.key.endsWith('.json')) continue;
        const thought = await s3.getJSONObject(entry.key, null);
        if (thought && thought.id) thoughts.push(thought);
    }

    return thoughts.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

async function saveSplitThoughts(thoughts) {
    await fs.mkdir(THOUGHTS_DIR, { recursive: true });
    const nextThoughts = Array.isArray(thoughts) ? thoughts.filter(thought => thought && thought.id) : [];
    const nextIds = new Set(nextThoughts.map(thought => `${safeId(thought.id)}.json`));
    const entries = await fs.readdir(THOUGHTS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json') && !nextIds.has(entry.name)) {
            await fs.rm(path.join(THOUGHTS_DIR, entry.name), { force: true });
        }
    }

    for (const thought of nextThoughts) {
        await writeJSON(thoughtPath(thought.id), thought);
    }

    await writeThoughtIndex(nextThoughts);
}

async function saveS3SplitThoughts(thoughts) {
    const nextThoughts = Array.isArray(thoughts) ? thoughts.filter(thought => thought && thought.id) : [];
    const nextKeys = new Set(nextThoughts.map(thought => s3Key(`thoughts/${safeId(thought.id)}.json`)));
    const entries = await s3.listObjects(s3Key('thoughts/'));

    for (const entry of entries) {
        if (entry.key.endsWith('.json') && !nextKeys.has(entry.key)) {
            await s3.deleteObject(entry.key);
        }
    }

    for (const thought of nextThoughts) {
        await s3WriteJSON(`thoughts/${safeId(thought.id)}.json`, thought);
    }

    await writeThoughtIndex(nextThoughts);
}

async function init() {
    if (isS3Backend()) {
        s3.initS3();

        if (!await s3PathExists('notepads.json')) {
            const now = Date.now();
            await s3WriteJSON('notepads.json', {
                notepads: [{ id: 'default', name: 'Default Notepad', createdAt: now, updatedAt: now }]
            });
        }

        if (!await s3PathExists('thoughts.json')) {
            await s3WriteJSON('thoughts.json', []);
        }

        if (!await s3PathExists('default.txt')) {
            await s3.putObject(s3Key('default.txt'), '', 'text/plain; charset=utf-8');
        }

        return;
    }

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(THOUGHTS_DIR, { recursive: true });
    await fs.mkdir(META_DIR, { recursive: true });
    await fs.mkdir(RELATIONS_DIR, { recursive: true });
    await fs.mkdir(SUPPRESSED_RELATIONS_DIR, { recursive: true });
    await fs.mkdir(INDEX_DIR, { recursive: true });
    await fs.mkdir(TRASH_NOTEPADS_DIR, { recursive: true });
    await fs.mkdir(TRASH_THOUGHTS_DIR, { recursive: true });

    if (!await pathExists(NOTEPADS_FILE)) {
        const now = Date.now();
        await writeJSON(NOTEPADS_FILE, {
            notepads: [{ id: 'default', name: 'Default Notepad', createdAt: now, updatedAt: now }]
        });
    }

    await migrateDefaultNotepad(DATA_DIR);

    if (!await pathExists(THOUGHTS_FILE)) {
        await writeJSON(THOUGHTS_FILE, []);
    }
}

async function readThoughts() {
    await init();
    if (isS3Backend()) {
        if (STORAGE_LAYOUT === 'split') {
            return readS3SplitThoughts();
        }
        const thoughts = await s3ReadJSON('thoughts.json', []);
        return Array.isArray(thoughts) ? thoughts : [];
    }

    if (STORAGE_LAYOUT === 'split') {
        return readSplitThoughts();
    }
    const thoughts = await readJSON(THOUGHTS_FILE, []);
    return Array.isArray(thoughts) ? thoughts : [];
}

async function saveThoughts(thoughts) {
    await init();
    if (isS3Backend()) {
        if (STORAGE_LAYOUT === 'split') {
            await saveS3SplitThoughts(thoughts);
            return;
        }
        await s3WriteJSON('thoughts.json', Array.isArray(thoughts) ? thoughts : []);
        return;
    }

    if (STORAGE_LAYOUT === 'split') {
        await saveSplitThoughts(thoughts);
        return;
    }
    await writeJSON(THOUGHTS_FILE, Array.isArray(thoughts) ? thoughts : []);
}

async function readThought(id) {
    await init();
    if (isS3Backend()) {
        if (STORAGE_LAYOUT === 'split') {
            return s3ReadJSON(`thoughts/${safeId(id)}.json`, null);
        }
        const thoughts = await readThoughts();
        return thoughts.find(thought => thought.id === id) || null;
    }

    if (STORAGE_LAYOUT === 'split') {
        return readJSON(thoughtPath(id), null);
    }
    const thoughts = await readThoughts();
    return thoughts.find(thought => thought.id === id) || null;
}

async function writeThought(thought) {
    if (!thought || !thought.id) {
        throw new Error('writeThought requires a thought with an id');
    }

    await init();
    if (isS3Backend()) {
        if (STORAGE_LAYOUT === 'split') {
            await s3WriteJSON(`thoughts/${safeId(thought.id)}.json`, thought);
            await writeThoughtIndex(await readS3SplitThoughts());
            return;
        }

        const thoughts = await readThoughts();
        const index = thoughts.findIndex(item => item.id === thought.id);
        if (index >= 0) thoughts[index] = thought;
        else thoughts.unshift(thought);
        await saveThoughts(thoughts);
        return;
    }

    if (STORAGE_LAYOUT === 'split') {
        await writeJSON(thoughtPath(thought.id), thought);
        await writeThoughtIndex(await readSplitThoughts());
        return;
    }

    const thoughts = await readThoughts();
    const index = thoughts.findIndex(item => item.id === thought.id);
    if (index >= 0) thoughts[index] = thought;
    else thoughts.unshift(thought);
    await saveThoughts(thoughts);
}

async function deleteThought(id) {
    await init();
    if (isS3Backend()) {
        if (STORAGE_LAYOUT === 'split') {
            const key = `thoughts/${safeId(id)}.json`;
            const existed = await s3PathExists(key);
            await s3.deleteObject(s3Key(key));
            await writeThoughtIndex(await readS3SplitThoughts());
            return existed;
        }

        const thoughts = await readThoughts();
        const nextThoughts = thoughts.filter(thought => thought.id !== id);
        await saveThoughts(nextThoughts);
        return nextThoughts.length !== thoughts.length;
    }

    if (STORAGE_LAYOUT === 'split') {
        const filePath = thoughtPath(id);
        const existed = await pathExists(filePath);
        await fs.rm(filePath, { force: true });
        await writeThoughtIndex(await readSplitThoughts());
        return existed;
    }

    const thoughts = await readThoughts();
    const nextThoughts = thoughts.filter(thought => thought.id !== id);
    await saveThoughts(nextThoughts);
    return nextThoughts.length !== thoughts.length;
}

async function readThoughtMeta(id) {
    if (isS3Backend()) return s3ReadJSON(`thoughts.meta/${safeId(id)}.json`, null);
    return readJSON(path.join(META_DIR, `${id}.json`), null);
}

async function writeThoughtMeta(id, meta) {
    if (isS3Backend()) {
        await s3WriteJSON(`thoughts.meta/${safeId(id)}.json`, meta);
        return;
    }
    await writeJSON(path.join(META_DIR, `${id}.json`), meta);
}

async function deleteThoughtMeta(id) {
    if (isS3Backend()) {
        await s3.deleteObject(s3Key(`thoughts.meta/${safeId(id)}.json`));
        return;
    }
    await fs.rm(path.join(META_DIR, `${id}.json`), { force: true });
}

async function readRelations(id) {
    if (isS3Backend()) return s3ReadJSON(`relations/${safeId(id)}.json`, { id, edges: [] });
    return readJSON(path.join(RELATIONS_DIR, `${id}.json`), { id, edges: [] });
}

async function readRelationCount(id) {
    const relations = await readRelations(id);
    return Array.isArray(relations.edges) ? relations.edges.length : 0;
}

async function writeRelations(id, relations) {
    if (isS3Backend()) {
        await s3WriteJSON(`relations/${safeId(id)}.json`, relations);
        return;
    }
    await writeJSON(path.join(RELATIONS_DIR, `${id}.json`), relations);
}

async function deleteRelations(id) {
    if (isS3Backend()) {
        await s3.deleteObject(s3Key(`relations/${safeId(id)}.json`));
        return;
    }
    await fs.rm(path.join(RELATIONS_DIR, `${id}.json`), { force: true });
}

async function readSuppressedRelations(id) {
    const fallback = { id, edges: [] };
    if (isS3Backend()) return s3ReadJSON(`relations.suppressed/${safeId(id)}.json`, fallback);
    return readJSON(path.join(SUPPRESSED_RELATIONS_DIR, `${safeId(id)}.json`), fallback);
}

async function writeSuppressedRelations(id, suppressed) {
    const payload = {
        id,
        edges: Array.isArray(suppressed?.edges) ? suppressed.edges : [],
        updatedAt: Date.now()
    };
    if (isS3Backend()) {
        await s3WriteJSON(`relations.suppressed/${safeId(id)}.json`, payload);
        return;
    }
    await writeJSON(path.join(SUPPRESSED_RELATIONS_DIR, `${safeId(id)}.json`), payload);
}

async function suppressRelation(sourceId, targetId, reason = 'user_deleted') {
    const source = safeId(sourceId);
    const target = safeId(targetId);
    if (!source || !target) return null;

    const suppressed = await readSuppressedRelations(source);
    const edges = Array.isArray(suppressed.edges) ? suppressed.edges : [];
    const existing = edges.find(edge => edge.targetId === target);

    if (existing) {
        existing.reason = reason;
        existing.updatedAt = Date.now();
    } else {
        edges.push({
            targetId: target,
            reason,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }

    const next = { id: source, edges };
    await writeSuppressedRelations(source, next);
    return next;
}

async function deleteSuppressedRelations(id) {
    if (isS3Backend()) {
        await s3.deleteObject(s3Key(`relations.suppressed/${safeId(id)}.json`));
        return;
    }
    await fs.rm(path.join(SUPPRESSED_RELATIONS_DIR, `${safeId(id)}.json`), { force: true });
}

async function removeSuppressedRelationReferences(targetId) {
    const safeTargetId = safeId(targetId);
    if (!safeTargetId) return 0;

    if (isS3Backend()) {
        const entries = await s3.listObjects(s3Key('relations.suppressed/'));
        let updated = 0;

        for (const entry of entries) {
            if (!entry.key.endsWith('.json')) continue;
            const suppressed = await s3.getJSONObject(entry.key, null);
            if (!suppressed || !Array.isArray(suppressed.edges)) continue;

            const nextEdges = suppressed.edges.filter(edge => edge.targetId !== safeTargetId);
            if (nextEdges.length !== suppressed.edges.length) {
                suppressed.edges = nextEdges;
                suppressed.updatedAt = Date.now();
                await s3.putObject(entry.key, JSON.stringify(suppressed, null, 2), 'application/json');
                updated++;
            }
        }

        return updated;
    }

    await fs.mkdir(SUPPRESSED_RELATIONS_DIR, { recursive: true });
    const entries = await fs.readdir(SUPPRESSED_RELATIONS_DIR, { withFileTypes: true }).catch(() => []);
    let updated = 0;

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(SUPPRESSED_RELATIONS_DIR, entry.name);
        const suppressed = await readJSON(filePath, null);
        if (!suppressed || !Array.isArray(suppressed.edges)) continue;

        const nextEdges = suppressed.edges.filter(edge => edge.targetId !== safeTargetId);
        if (nextEdges.length !== suppressed.edges.length) {
            suppressed.edges = nextEdges;
            suppressed.updatedAt = Date.now();
            await writeJSON(filePath, suppressed);
            updated++;
        }
    }

    return updated;
}

async function removeRelationReferences(targetId) {
    const removeFromRelations = (relations) => {
        const edges = Array.isArray(relations.edges) ? relations.edges : [];
        const suggestions = Array.isArray(relations.suggestions) ? relations.suggestions : [];
        const nextEdges = edges.filter(edge => edge.targetId !== targetId);
        const nextSuggestions = suggestions.filter(edge => edge.targetId !== targetId);
        const changed = nextEdges.length !== edges.length || nextSuggestions.length !== suggestions.length;
        if (changed) {
            relations.edges = nextEdges;
            relations.suggestions = nextSuggestions;
            relations.computedAt = Date.now();
        }
        return changed;
    };

    if (isS3Backend()) {
        const entries = await s3.listObjects(s3Key('relations/'));
        let updated = 0;
        const affectedIds = [];

        for (const entry of entries) {
            if (!entry.key.endsWith('.json')) continue;
            const relations = await s3.getJSONObject(entry.key, null);
            if (!relations) continue;

            if (removeFromRelations(relations)) {
                await s3.putObject(entry.key, JSON.stringify(relations, null, 2), 'application/json');
                updated++;
                if (relations.id) affectedIds.push(relations.id);
            }
        }

        return { updated, affectedIds };
    }

    await fs.mkdir(RELATIONS_DIR, { recursive: true });
    const entries = await fs.readdir(RELATIONS_DIR, { withFileTypes: true }).catch(() => []);
    let updated = 0;
    const affectedIds = [];

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(RELATIONS_DIR, entry.name);
        const relations = await readJSON(filePath, null);
        if (!relations) continue;

        if (removeFromRelations(relations)) {
            await writeJSON(filePath, relations);
            updated++;
            affectedIds.push(relations.id || path.basename(entry.name, '.json'));
        }
    }

    return { updated, affectedIds };
}

async function readNotepadsMeta() {
    await init();
    if (isS3Backend()) {
        const data = await s3ReadJSON('notepads.json', { notepads: [] });
        return {
            notepads: Array.isArray(data.notepads) ? data.notepads : []
        };
    }

    const data = await readJSON(NOTEPADS_FILE, { notepads: [] });
    return {
        notepads: Array.isArray(data.notepads) ? data.notepads : []
    };
}

async function saveNotepadsMeta(data) {
    await init();
    if (isS3Backend()) {
        await s3WriteJSON('notepads.json', {
            notepads: Array.isArray(data?.notepads) ? data.notepads : []
        });
        return;
    }

    await writeJSON(NOTEPADS_FILE, {
        notepads: Array.isArray(data?.notepads) ? data.notepads : []
    });
}

async function getS3NotepadKey(notepad) {
    if (notepad?.id === 'default') return 'default.txt';

    const nameKey = `${sanitizeFilename(notepad.name)}.txt`;
    const idKey = `${sanitizeFilename(notepad.id)}.txt`;

    if (await s3PathExists(nameKey)) return nameKey;
    if (await s3PathExists(idKey)) return idKey;
    return nameKey;
}

async function readNoteContent(notepad) {
    await init();
    if (isS3Backend()) {
        const key = await getS3NotepadKey(notepad);
        return await s3.getObject(s3Key(key)) || '';
    }

    const notePath = await getNotepadFilePath(notepad, DATA_DIR);
    return fs.readFile(notePath, 'utf8').catch(() => '');
}

async function writeNoteContent(notepad, content) {
    await init();
    if (isS3Backend()) {
        const key = await getS3NotepadKey(notepad);
        await s3.putObject(s3Key(key), content || '', 'text/plain; charset=utf-8');
        return;
    }

    const notePath = await getNotepadFilePath(notepad, DATA_DIR);
    await fs.writeFile(notePath, content || '', 'utf8');
}

async function deleteNoteContent(notepad) {
    await init();
    if (isS3Backend()) {
        const key = await getS3NotepadKey(notepad);
        await s3.deleteObject(s3Key(key));

        if (notepad?.id) {
            const fallbackKey = `${sanitizeFilename(notepad.id)}.txt`;
            if (fallbackKey !== key) {
                await s3.deleteObject(s3Key(fallbackKey));
            }
        }
        return;
    }

    const notePath = await getNotepadFilePath(notepad, DATA_DIR);
    await fs.rm(notePath, { force: true });

    if (notepad?.id) {
        const fallbackPath = path.join(DATA_DIR, `${sanitizeFilename(notepad.id)}.txt`);
        if (fallbackPath !== notePath) {
            await fs.rm(fallbackPath, { force: true });
        }
    }
}

function uniqueRestoredName(name, notepads) {
    const base = String(name || 'Restored Notepad');
    if (!notepads.some(item => item.name === base)) return base;
    let counter = 1;
    let candidate = `${base} restored`;
    while (notepads.some(item => item.name === candidate)) {
        counter++;
        candidate = `${base} restored ${counter}`;
    }
    return candidate;
}

function uniqueRestoredId(id, existingIds) {
    const base = safeId(id) || `restored-${Date.now()}`;
    if (!existingIds.has(base)) return base;
    let counter = 1;
    let candidate = `${base}-restored`;
    while (existingIds.has(candidate)) {
        counter++;
        candidate = `${base}-restored-${counter}`;
    }
    return candidate;
}

async function moveNotepadToTrash(notepad) {
    if (!notepad?.id) throw new Error('moveNotepadToTrash requires a notepad');
    const content = await readNoteContent(notepad);
    return addTrashItem({
        type: 'notepad',
        sourceId: notepad.id,
        title: notepad.name || notepad.id,
        preview: content,
        payload: {
            notepad: { ...notepad },
            content: content || ''
        }
    });
}

async function moveThoughtToTrash(thought) {
    if (!thought?.id) throw new Error('moveThoughtToTrash requires a thought');
    const meta = await readThoughtMeta(thought.id);
    const relations = await readRelations(thought.id);
    const suppressed = await readSuppressedRelations(thought.id);
    const subText = (thought.subItems || []).map(item => item.text || '').join(' ');
    return addTrashItem({
        type: 'thought',
        sourceId: thought.id,
        title: String(thought.text || '').split('\n')[0].slice(0, 80) || 'Thought',
        preview: [thought.text || '', subText].filter(Boolean).join(' '),
        payload: {
            thought: { ...thought },
            meta,
            relations,
            suppressed
        }
    });
}

function normalizeRestoredRelations(relations, ownerId, validTargetIds, now) {
    const normalized = { ...(relations || {}) };
    const cleanEdges = (items) => (Array.isArray(items) ? items : [])
        .filter(edge => edge && validTargetIds.has(String(edge.targetId)) && String(edge.targetId) !== ownerId)
        .map(edge => ({ ...edge, targetId: String(edge.targetId), restoredAt: now }));

    normalized.id = ownerId;
    normalized.edges = cleanEdges(normalized.edges);
    normalized.suggestions = cleanEdges(normalized.suggestions);
    normalized.version = normalized.version || 2;
    normalized.computedAt = now;
    normalized.restoredAt = now;
    return normalized;
}

function upsertRestoredEdge(edges, edge, targetId, now) {
    const id = String(targetId);
    const next = (Array.isArray(edges) ? edges : []).filter(existing => String(existing?.targetId || '') !== id);
    next.unshift({ ...edge, targetId: id, restoredAt: now });
    return next;
}

async function restoreReverseRelations(restoredId, relations, now) {
    const affectedIds = new Set();
    const byTarget = new Map();

    function collect(kind) {
        for (const edge of Array.isArray(relations?.[kind]) ? relations[kind] : []) {
            const targetId = String(edge.targetId || '');
            if (!targetId) continue;
            if (!byTarget.has(targetId)) byTarget.set(targetId, { edges: [], suggestions: [] });
            byTarget.get(targetId)[kind].push(edge);
        }
    }

    collect('edges');
    collect('suggestions');

    for (const [targetId, lists] of byTarget.entries()) {
        const reverse = await readRelations(targetId);
        reverse.id = targetId;
        if (lists.edges.length > 0) {
            reverse.edges = upsertRestoredEdge(reverse.edges, lists.edges[0], restoredId, now);
        }
        if (lists.suggestions.length > 0) {
            reverse.suggestions = upsertRestoredEdge(reverse.suggestions, lists.suggestions[0], restoredId, now);
        }
        reverse.computedAt = now;
        reverse.version = reverse.version || 2;
        reverse.restoredAt = now;
        await writeRelations(targetId, reverse);
        affectedIds.add(targetId);
    }

    return Array.from(affectedIds);
}

function normalizeRestoredSuppressed(suppressed, ownerId, validTargetIds, now) {
    return {
        ...(suppressed || {}),
        id: ownerId,
        edges: (Array.isArray(suppressed?.edges) ? suppressed.edges : [])
            .filter(edge => edge && validTargetIds.has(String(edge.targetId)) && String(edge.targetId) !== ownerId)
            .map(edge => ({ ...edge, targetId: String(edge.targetId), restoredAt: now, updatedAt: now })),
        updatedAt: now,
        restoredAt: now
    };
}

async function restoreReverseSuppressed(restoredId, suppressed, now) {
    for (const edge of Array.isArray(suppressed?.edges) ? suppressed.edges : []) {
        const targetId = String(edge.targetId || '');
        if (!targetId) continue;
        const reverse = await readSuppressedRelations(targetId);
        reverse.edges = upsertRestoredEdge(reverse.edges, { ...edge, updatedAt: now }, restoredId, now);
        reverse.updatedAt = now;
        reverse.restoredAt = now;
        await writeSuppressedRelations(targetId, reverse);
    }
}

async function restoreTrashItem(trashId) {
    const trash = await getTrashItem(trashId);
    if (!trash) return null;
    const now = Date.now();

    if (trash.item.type === 'notepad') {
        const original = trash.payload.payload?.notepad;
        if (!original?.id) return null;
        const meta = await readNotepadsMeta();
        const existingIds = new Set(meta.notepads.map(item => item.id));
        const restored = {
            ...original,
            id: uniqueRestoredId(original.id, existingIds),
            name: uniqueRestoredName(original.name, meta.notepads),
            restoredAt: now,
            updatedAt: now,
            version: (original.version || 1) + 1
        };
        meta.notepads.push(restored);
        await saveNotepadsMeta(meta);
        await writeNoteContent(restored, trash.payload.payload?.content || '');
        await deleteTrashItem(trashId);
        await rebuildIndexes();
        return { type: 'notepad', item: restored };
    }

    if (trash.item.type === 'thought') {
        const original = trash.payload.payload?.thought;
        if (!original?.id) return null;
        const thoughts = await readThoughts();
        const existingIds = new Set(thoughts.map(item => item.id));
        const validRelationTargetIds = new Set(thoughts.map(item => String(item.id)));
        const restored = {
            ...original,
            id: uniqueRestoredId(original.id, existingIds),
            restoredAt: now,
            updatedAt: now,
            version: (original.version || 1) + 1
        };
        await writeThought(restored);
        if (trash.payload.payload?.meta) {
            await writeThoughtMeta(restored.id, { ...trash.payload.payload.meta, id: restored.id, restoredAt: now });
        }
        const affectedRelationIds = new Set([restored.id]);
        if (trash.payload.payload?.relations) {
            const restoredRelations = normalizeRestoredRelations(
                trash.payload.payload.relations,
                restored.id,
                validRelationTargetIds,
                now
            );
            await writeRelations(restored.id, restoredRelations);
            for (const affectedId of await restoreReverseRelations(restored.id, restoredRelations, now)) {
                affectedRelationIds.add(affectedId);
            }
        }
        if (trash.payload.payload?.suppressed) {
            const restoredSuppressed = normalizeRestoredSuppressed(
                trash.payload.payload.suppressed,
                restored.id,
                validRelationTargetIds,
                now
            );
            await writeSuppressedRelations(restored.id, restoredSuppressed);
            await restoreReverseSuppressed(restored.id, restoredSuppressed, now);
        }
        await deleteTrashItem(trashId);
        await rebuildIndexes();
        return { type: 'thought', item: restored, affectedRelationIds: Array.from(affectedRelationIds) };
    }

    return null;
}

async function renameNoteContent(oldNotepad, newNotepad) {
    await init();
    if (!oldNotepad || !newNotepad) {
        throw new Error('renameNoteContent requires oldNotepad and newNotepad');
    }

    if (oldNotepad.id === 'default') return;

    if (isS3Backend()) {
        const oldKey = await getS3NotepadKey(oldNotepad);
        const newKey = `${sanitizeFilename(newNotepad.name)}.txt`;
        if (oldKey === newKey) return;

        if (await s3PathExists(oldKey)) {
            await s3.copyObject(s3Key(oldKey), s3Key(newKey));
            await s3.deleteObject(s3Key(oldKey));
        }
        return;
    }

    const oldPath = await getNotepadFilePath(oldNotepad, DATA_DIR);
    const newPath = path.join(DATA_DIR, `${sanitizeFilename(newNotepad.name)}.txt`);
    if (oldPath === newPath) return;

    if (await pathExists(oldPath)) {
        await fs.rename(oldPath, newPath);
    }
}

async function readIndex(name) {
    if (isS3Backend()) return s3ReadJSON(`indexes/${safeId(name)}.json`, null);
    return readJSON(path.join(INDEX_DIR, `${name}.json`), null);
}

async function writeIndex(name, value) {
    if (isS3Backend()) {
        await s3WriteJSON(`indexes/${safeId(name)}.json`, value);
        return;
    }
    await writeJSON(path.join(INDEX_DIR, `${name}.json`), value);
}

async function rebuildIndexes() {
    const thoughts = await readThoughts();
    const notepads = await readNotepadsMeta();
    const now = Date.now();

    await writeIndex('thoughts-index', {
        items: thoughts.map(thought => ({
            id: thought.id,
            type: 'thought',
            textPreview: String(thought.text || '').slice(0, 300),
            tags: Array.isArray(thought.tags) ? thought.tags : [],
            completed: !!thought.completed,
            createdAt: thought.createdAt || 0,
            updatedAt: thought.updatedAt || 0
        })),
        updatedAt: now
    });

    await writeIndex('notepads-index', {
        items: notepads.notepads.map(notepad => ({
            id: notepad.id,
            type: 'notepad',
            title: notepad.name || '',
            createdAt: notepad.createdAt || 0,
            updatedAt: notepad.updatedAt || 0
        })),
        updatedAt: now
    });
}

async function getSearchDocuments() {
    const thoughts = await readThoughts();
    const notepads = await readNotepadsMeta();

    const thoughtDocuments = thoughts.map(thought => {
        const subText = (thought.subItems || []).map(item => item.text || '').join('\n');
        const content = [thought.text || '', subText].filter(Boolean).join('\n');
        return {
            id: thought.id,
            type: 'thought',
            title: String(thought.text || '').split('\n')[0].slice(0, 80) || 'Untitled Thought',
            content,
            tags: Array.isArray(thought.tags) ? thought.tags : [],
            updatedAt: thought.updatedAt || thought.createdAt || 0
        };
    });

    const notepadDocuments = [];
    for (const notepad of notepads.notepads) {
        notepadDocuments.push({
            id: notepad.id,
            type: 'notepad',
            title: notepad.name || '',
            content: await readNoteContent(notepad),
            tags: [],
            updatedAt: notepad.updatedAt || notepad.createdAt || 0
        });
    }

    return [...notepadDocuments, ...thoughtDocuments];
}

module.exports = {
    init,
    readThoughts,
    saveThoughts,
    readThought,
    writeThought,
    deleteThought,
    readThoughtMeta,
    writeThoughtMeta,
    deleteThoughtMeta,
    readRelations,
    readRelationCount,
    writeRelations,
    deleteRelations,
    readSuppressedRelations,
    writeSuppressedRelations,
    suppressRelation,
    deleteSuppressedRelations,
    removeSuppressedRelationReferences,
    removeRelationReferences,
    readNotepadsMeta,
    saveNotepadsMeta,
    readNoteContent,
    writeNoteContent,
    deleteNoteContent,
    renameNoteContent,
    moveNotepadToTrash,
    moveThoughtToTrash,
    listTrashItems,
    getTrashItem,
    restoreTrashItem,
    deleteTrashItem,
    emptyTrash,
    readIndex,
    writeIndex,
    rebuildIndexes,
    getSearchDocuments,
    paths: {
        DATA_DIR,
        NOTEPADS_FILE,
        THOUGHTS_FILE,
        THOUGHTS_DIR,
        META_DIR,
        RELATIONS_DIR,
        SUPPRESSED_RELATIONS_DIR,
        INDEX_DIR,
        TRASH_DIR,
        TRASH_INDEX_FILE
    },
    getS3Prefix,
    setS3Prefix,
    layout: STORAGE_LAYOUT,
    backend: STORAGE_BACKEND
};
