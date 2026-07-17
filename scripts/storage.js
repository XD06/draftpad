const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const {
    sanitizeFilename,
    getNotepadFilePath,
    migrateDefaultNotepad
} = require('./notepad-migration');
const s3 = require('./s3-service');
const {
    assertValidAgentRun,
    assertValidTerminalAgentRun,
    hashIdempotencyKey,
    isAgentRunStatus,
    isSha256,
    isTerminalAgentRunStatus,
    toActiveAgentRunIndexEntry,
    validateSourceRef
} = require('./agent/agent-contracts');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const NOTEPADS_FILE = path.join(DATA_DIR, 'notepads.json');
const THOUGHTS_FILE = path.join(DATA_DIR, 'thoughts.json');
const THOUGHTS_DIR = path.join(DATA_DIR, 'thoughts');
const META_DIR = path.join(DATA_DIR, 'thoughts.meta');
const RELATIONS_DIR = path.join(DATA_DIR, 'relations');
const SUPPRESSED_RELATIONS_DIR = path.join(DATA_DIR, 'relations.suppressed');
const INDEX_DIR = path.join(DATA_DIR, 'indexes');
const AGENT_RUNS_DIR = path.join(DATA_DIR, 'agent-runs');
const AGENT_RUNS_ACTIVE_INDEX_FILE = path.join(AGENT_RUNS_DIR, 'active-index.json');
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
const s3NotepadKeyCache = new Map();
let storageInitialized = false;
let storageInitPromise = null;

// Async mutex for serializing Thought read-modify-write operations.
// Without this, concurrent POST/PATCH/DELETE requests can lose data
// because they each read the full thoughts array, mutate it, and save
// it back — the last writer wins and intermediate writes are lost.
let thoughtWriteLock = Promise.resolve();

async function withThoughtWriteLock(task) {
    const run = thoughtWriteLock.then(task, task);
    thoughtWriteLock = run.catch(() => {});
    return run;
}

// Async mutex for serializing Notepad/Note metadata read-modify-write.
// Without this, concurrent POST/PATCH/DELETE on notepads/notes can lose
// version numbers and content: each handler reads meta, mutates, and saves,
// so the last writer wins and intermediate writes are lost.
let notepadWriteLock = Promise.resolve();
async function withNotepadWriteLock(task) {
    const run = notepadWriteLock.then(task, task);
    notepadWriteLock = run.catch(() => {});
    return run;
}

// AgentRun data is derived and must not block user content writes. Keep a
// dedicated single-process lock for the small run record + active index
// transaction; it intentionally does not promise cross-process S3 atomicity.
let agentRunWriteLock = Promise.resolve();
async function withAgentRunWriteLock(task) {
    const run = agentRunWriteLock.then(task, task);
    agentRunWriteLock = run.catch(() => {});
    return run;
}

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
    // On Windows, fs.rename can fail with EPERM if the target file is briefly
    // locked by another concurrent operation or antivirus scan. Retry a few
    // times with a short delay before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await fs.rename(tempPath, filePath);
            return;
        } catch (err) {
            if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
            if (attempt === 4) throw err;
            await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
    }
}

function s3Key(key) {
    const cleanKey = String(key || '').replace(/^\/+/, '');
    return activeS3Prefix ? `${activeS3Prefix}/${cleanKey}` : cleanKey;
}

async function setS3Prefix(prefix) {
    const clean = cleanPrefix(prefix);
    if (!clean) throw new Error('S3 prefix is required');
    activeS3Prefix = clean;
    s3NotepadKeyCache.clear();
    storageInitialized = false;
    storageInitPromise = null;
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
    // Keep only filename-safe characters. This also neutralizes path traversal:
    // '../' becomes '___' (no dots, no separators), so the result can never
    // escape the target directory when used in path.join or as an S3 key.
    return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').trim();
}

function thoughtPath(id) {
    const filename = safeId(id);
    if (!filename) throw new Error('Thought id is required');
    return path.join(THOUGHTS_DIR, `${filename}.json`);
}

function agentRunPath(id) {
    const filename = safeId(id);
    if (!filename) throw new Error('AgentRun id is required');
    if (filename === 'active-index') throw new Error('AgentRun id is reserved');
    return path.join(AGENT_RUNS_DIR, `${filename}.json`);
}

function agentRunKey(id) {
    const filename = safeId(id);
    if (!filename) throw new Error('AgentRun id is required');
    if (filename === 'active-index') throw new Error('AgentRun id is reserved');
    return `agent-runs/${filename}.json`;
}

function normalizeAgentRunActiveIndex(index) {
    const deduped = new Map();
    for (const item of Array.isArray(index?.items) ? index.items : []) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || '').trim();
        const workflowId = String(item.workflowId || '').trim();
        const actorId = String(item.actorId || '').trim();
        const objectScope = String(item.objectScope || '').trim();
        const status = String(item.status || '').trim();
        const createdAt = Number(item.createdAt);
        const updatedAt = Number(item.updatedAt);
        const sourceValidation = validateSourceRef(item.primarySource);
        if (
            !id || safeId(id) !== id || id === 'active-index' || !workflowId || !actorId || !objectScope ||
            !isAgentRunStatus(status) || isTerminalAgentRunStatus(status) ||
            !Number.isSafeInteger(createdAt) || createdAt < 0 ||
            !Number.isSafeInteger(updatedAt) || updatedAt < createdAt ||
            !sourceValidation.valid
        ) {
            continue;
        }
        const idempotencyKeyHash = String(item.idempotencyKeyHash || '').trim();
        if (idempotencyKeyHash && !isSha256(idempotencyKeyHash)) continue;
        const normalized = {
            id,
            workflowId,
            actorId,
            objectScope,
            primarySource: sourceValidation.value,
            status,
            createdAt,
            updatedAt,
            ...(idempotencyKeyHash ? { idempotencyKeyHash } : {})
        };
        const existing = deduped.get(id);
        if (!existing || normalized.updatedAt >= existing.updatedAt) deduped.set(id, normalized);
    }
    return {
        version: 1,
        updatedAt: Number.isSafeInteger(Number(index?.updatedAt)) ? Number(index.updatedAt) : Date.now(),
        items: Array.from(deduped.values()).sort((left, right) => (
            right.updatedAt - left.updatedAt || String(left.id).localeCompare(String(right.id))
        ))
    };
}

function prepareAgentRunForStorage(run) {
    if (!run || typeof run !== 'object') throw new Error('AgentRun is required');
    const candidate = { ...run };
    if (candidate.idempotencyKey !== undefined) {
        const derivedHash = hashIdempotencyKey(candidate.idempotencyKey);
        if (candidate.idempotencyKeyHash && candidate.idempotencyKeyHash !== derivedHash) {
            throw new Error('AgentRun idempotencyKeyHash does not match idempotencyKey');
        }
        candidate.idempotencyKeyHash = derivedHash;
        delete candidate.idempotencyKey;
    }
    return isTerminalAgentRunStatus(candidate.status)
        ? assertValidTerminalAgentRun(candidate)
        : assertValidAgentRun(candidate);
}

function thoughtIndexFrom(thoughts) {
    return {
        items: thoughts.map(thought => ({
            id: thought.id,
            type: 'thought',
            textPreview: String(thought.text || '').slice(0, 300),
            tags: Array.isArray(thought.tags) ? thought.tags : [],
            completed: !!thought.completed,
            pinned: thought.pinned === true,
            pinnedAt: Number(thought.pinnedAt || 0),
            createdAt: thought.createdAt || 0,
            updatedAt: thought.updatedAt || 0
        })),
        updatedAt: Date.now()
    };
}

function compareThoughtPageEntries(left, right, sort = 'updated') {
    if (sort === 'timeline') {
        const leftPinned = left.pinned === true;
        const rightPinned = right.pinned === true;
        if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
        if (leftPinned && rightPinned) {
            const pinnedAtDifference = Number(right.pinnedAt || 0) - Number(left.pinnedAt || 0);
            if (pinnedAtDifference) return pinnedAtDifference;
        }
        if ((left.completed === true) !== (right.completed === true)) {
            return left.completed === true ? 1 : -1;
        }
        return Number(right.createdAt || 0) - Number(left.createdAt || 0)
            || String(right.id).localeCompare(String(left.id));
    }
    return Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0)
        || String(right.id).localeCompare(String(left.id));
}

function hasUsableThoughtPageIndex(index, sort = 'updated') {
    if (!Array.isArray(index?.items)) return false;
    return index.items.every(item => (
        item
        && typeof item.id === 'string'
        && Number.isFinite(Number(item.createdAt || 0))
        && Number.isFinite(Number(item.updatedAt || item.createdAt || 0))
        && (sort !== 'timeline' || (
            typeof item.pinned === 'boolean'
            && Number.isFinite(Number(item.pinnedAt || 0))
            && typeof item.completed === 'boolean'
        ))
    ));
}

function thoughtPageMatchesFilters(thought, { date = '', tag = '', status = 'all', updatedSince = null } = {}) {
    if (tag) {
        const expectedTag = String(tag).toLowerCase();
        if (!Array.isArray(thought.tags) || !thought.tags.some(value => String(value).toLowerCase() === expectedTag)) {
            return false;
        }
    }
    if (date) {
        const value = new Date(thought.createdAt || 0);
        const dateValue = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
        if (dateValue !== date) return false;
    }
    if (status === 'todo' && thought.completed === true) return false;
    if (status === 'done' && thought.completed !== true) return false;
    if (updatedSince !== null && Number(thought.updatedAt || thought.createdAt || 0) <= updatedSince) return false;
    return true;
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

const thoughtEntries = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
const thoughts = await Promise.all(
thoughtEntries.map(entry => readJSON(path.join(THOUGHTS_DIR, entry.name), null))
);

return thoughts
.filter(thought => thought && thought.id)
.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

async function readS3SplitThoughts() {
const entries = await s3.listObjects(s3Key('thoughts/'));

const thoughtEntries = entries.filter(entry => entry.key.endsWith('.json'));
const thoughts = await Promise.all(
thoughtEntries.map(entry => s3.getJSONObject(entry.key, null))
);

return thoughts
.filter(thought => thought && thought.id)
.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
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

async function initStorage() {
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
    await fs.mkdir(AGENT_RUNS_DIR, { recursive: true });
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

async function init() {
    if (storageInitialized) return;
    if (!storageInitPromise) {
        storageInitPromise = initStorage()
            .then(() => {
                storageInitialized = true;
            })
            .catch(error => {
                storageInitPromise = null;
                throw error;
            });
    }
    await storageInitPromise;
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

async function listThoughtsPage({
    query = '',
    date = '',
    tag = '',
    status = 'all',
    updatedSince = null,
    sort = 'updated',
    cursor = null,
    limit = 50
} = {}) {
    await init();
    if (STORAGE_LAYOUT !== 'split' || query) return null;

    const pageSort = sort === 'timeline' ? 'timeline' : 'updated';
    let index = await readIndex('thoughts-index');
    if (!hasUsableThoughtPageIndex(index, pageSort)) {
        const thoughts = await readThoughts();
        index = thoughtIndexFrom(thoughts);
        await writeThoughtIndex(thoughts);
    }

    const pageSize = Math.max(1, Math.min(Number(limit) || 50, 50));
    let entries = index.items
        .filter(thought => thoughtPageMatchesFilters(thought, { date, tag, status, updatedSince }))
        .sort((left, right) => compareThoughtPageEntries(left, right, pageSort));
    if (cursor) {
        entries = entries.filter(thought => compareThoughtPageEntries(thought, cursor, pageSort) > 0);
    }

    const hasMore = entries.length > pageSize;
    const pageEntries = entries.slice(0, pageSize);
    const items = await Promise.all(pageEntries.map(entry => readThought(entry.id)));
    if (items.some(item => !item?.id)) {
        // A concurrent write or an older index may reference an object that no
        // longer exists. Rebuild once, then let the route use its safe full-read
        // path for this request instead of returning a partial page.
        const thoughts = await readThoughts();
        await writeThoughtIndex(thoughts);
        return null;
    }

    return { items, hasMore, usedIndex: true };
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

async function readAgentRunUnsafe(id) {
    if (isS3Backend()) return s3ReadJSON(agentRunKey(id), null);
    return readJSON(agentRunPath(id), null);
}

async function writeAgentRunUnsafe(run) {
    if (isS3Backend()) {
        await s3WriteJSON(agentRunKey(run.id), run);
        return;
    }
    await writeJSON(agentRunPath(run.id), run);
}

async function readAgentRunActiveIndexUnsafe() {
    const fallback = { version: 1, items: [] };
    const index = isS3Backend()
        ? await s3ReadJSON('agent-runs/active-index.json', fallback)
        : await readJSON(AGENT_RUNS_ACTIVE_INDEX_FILE, fallback);
    return normalizeAgentRunActiveIndex(index);
}

async function writeAgentRunActiveIndexUnsafe(index) {
    const payload = normalizeAgentRunActiveIndex({ ...index, updatedAt: Date.now() });
    if (isS3Backend()) {
        await s3WriteJSON('agent-runs/active-index.json', payload);
        return payload;
    }
    await writeJSON(AGENT_RUNS_ACTIVE_INDEX_FILE, payload);
    return payload;
}

async function readAgentRun(id) {
    await init();
    return readAgentRunUnsafe(id);
}

async function readAgentRunActiveIndex() {
    await init();
    return readAgentRunActiveIndexUnsafe();
}

async function hasAgentRunActiveIndex() {
    await init();
    return isS3Backend()
        ? s3PathExists('agent-runs/active-index.json')
        : pathExists(AGENT_RUNS_ACTIVE_INDEX_FILE);
}

async function saveAgentRun(run) {
    return withAgentRunWriteLock(async () => {
        await init();
        const storedRun = prepareAgentRunForStorage(run);
        await writeAgentRunUnsafe(storedRun);

        const activeIndex = await readAgentRunActiveIndexUnsafe();
        const activeEntry = toActiveAgentRunIndexEntry(storedRun);
        activeIndex.items = activeIndex.items.filter(item => item.id !== storedRun.id);
        if (activeEntry) activeIndex.items.push(activeEntry);
        await writeAgentRunActiveIndexUnsafe(activeIndex);
        return storedRun;
    });
}

async function listActiveAgentRunSummaries() {
    const index = await readAgentRunActiveIndex();
    return index.items;
}

async function listNonterminalAgentRuns() {
    const summaries = await listActiveAgentRunSummaries();
    const runs = await Promise.all(summaries.map(summary => readAgentRun(summary.id)));
    return runs.filter((run, index) => {
        if (!run || run.id !== summaries[index].id || isTerminalAgentRunStatus(run.status)) return false;
        try {
            return !!toActiveAgentRunIndexEntry(run);
        } catch {
            return false;
        }
    });
}

async function listActiveAgentRuns() {
    return listNonterminalAgentRuns();
}

async function readStoredAgentRunsUnsafe() {
    if (isS3Backend()) {
        const activeIndexKey = s3Key('agent-runs/active-index.json');
        const entries = await s3.listObjects(s3Key('agent-runs/'));
        const runEntries = entries.filter(entry => (
            entry.key.endsWith('.json') && entry.key !== activeIndexKey
        ));
        const runs = await Promise.all(runEntries.map(entry => s3.getJSONObject(entry.key, null)));
        return runs.filter(run => run && run.id);
    }

    const entries = await fs.readdir(AGENT_RUNS_DIR, { withFileTypes: true });
    const runEntries = entries.filter(entry => (
        entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'active-index.json'
    ));
    const runs = await Promise.all(runEntries.map(entry => readJSON(path.join(AGENT_RUNS_DIR, entry.name), null)));
    return runs.filter(run => run && run.id);
}

async function rebuildAgentRunActiveIndex() {
    return withAgentRunWriteLock(async () => {
        await init();
        const runs = await readStoredAgentRunsUnsafe();
        const entries = [];
        for (const run of runs) {
            try {
                const entry = toActiveAgentRunIndexEntry(run);
                if (entry) entries.push(entry);
            } catch {
                // AgentRun records are derived data. A corrupt record must not
                // prevent valid nonterminal runs from recovering after restart.
            }
        }
        return writeAgentRunActiveIndexUnsafe({ version: 1, items: entries });
    });
}

async function readThoughtMeta(id) {
    if (isS3Backend()) return s3ReadJSON(`thoughts.meta/${safeId(id)}.json`, null);
    return readJSON(path.join(META_DIR, `${safeId(id)}.json`), null);
}

async function writeThoughtMeta(id, meta) {
    if (isS3Backend()) {
        await s3WriteJSON(`thoughts.meta/${safeId(id)}.json`, meta);
        return;
    }
    await writeJSON(path.join(META_DIR, `${safeId(id)}.json`), meta);
}

async function deleteThoughtMeta(id) {
    if (isS3Backend()) {
        await s3.deleteObject(s3Key(`thoughts.meta/${safeId(id)}.json`));
        return;
    }
    await fs.rm(path.join(META_DIR, `${safeId(id)}.json`), { force: true });
}

async function readRelations(id) {
    if (isS3Backend()) return s3ReadJSON(`relations/${safeId(id)}.json`, { id, edges: [] });
    return readJSON(path.join(RELATIONS_DIR, `${safeId(id)}.json`), { id, edges: [] });
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
    await writeJSON(path.join(RELATIONS_DIR, `${safeId(id)}.json`), relations);
}

async function deleteRelations(id) {
    if (isS3Backend()) {
        await s3.deleteObject(s3Key(`relations/${safeId(id)}.json`));
        return;
    }
    await fs.rm(path.join(RELATIONS_DIR, `${safeId(id)}.json`), { force: true });
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

    const cleanSuppressed = (suppressed) => {
        if (!suppressed || !Array.isArray(suppressed.edges)) return false;
        const nextEdges = suppressed.edges.filter(edge => edge.targetId !== safeTargetId);
        if (nextEdges.length !== suppressed.edges.length) {
            suppressed.edges = nextEdges;
            suppressed.updatedAt = Date.now();
            return true;
        }
        return false;
    };

    if (isS3Backend()) {
        const entries = await s3.listObjects(s3Key('relations.suppressed/'));
        const relationEntries = entries.filter(entry => entry.key.endsWith('.json'));

        const allSuppressed = await Promise.all(
            relationEntries.map(async (entry) => ({ entry, data: await s3.getJSONObject(entry.key, null) }))
        );

        const toUpdate = allSuppressed.filter(({ data }) => cleanSuppressed(data));

        await Promise.all(
            toUpdate.map(({ entry, data }) =>
                s3.putObject(entry.key, JSON.stringify(data, null, 2), 'application/json')
            )
        );

        return toUpdate.length;
    }

    await fs.mkdir(SUPPRESSED_RELATIONS_DIR, { recursive: true });
    const entries = await fs.readdir(SUPPRESSED_RELATIONS_DIR, { withFileTypes: true }).catch(() => []);

    const allLocal = await Promise.all(
        entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(async (entry) => {
                const filePath = path.join(SUPPRESSED_RELATIONS_DIR, entry.name);
                const data = await readJSON(filePath, null);
                return { filePath, data };
            })
    );

    const localToUpdate = allLocal.filter(({ data }) => cleanSuppressed(data));

    await Promise.all(
        localToUpdate.map(({ filePath, data }) => writeJSON(filePath, data))
    );

    return localToUpdate.length;
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
const relationEntries = entries.filter(entry => entry.key.endsWith('.json'));

// Read all relation files in parallel
const allRelations = await Promise.all(
relationEntries.map(async (entry) => ({
entry,
data: await s3.getJSONObject(entry.key, null)
}))
);

// Filter to only those that need updating
const toUpdate = allRelations.filter(({ data }) => data && removeFromRelations(data));

// Write back in parallel
await Promise.all(
toUpdate.map(({ entry, data }) =>
s3.putObject(entry.key, JSON.stringify(data, null, 2), 'application/json')
)
);

const affectedIds = toUpdate
.map(({ data }) => data.id)
.filter(Boolean);

return { updated: toUpdate.length, affectedIds };
}

await fs.mkdir(RELATIONS_DIR, { recursive: true });
const entries = await fs.readdir(RELATIONS_DIR, { withFileTypes: true }).catch(() => []);

// Read all relation files in parallel
const allLocalRelations = await Promise.all(
entries
.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
.map(async (entry) => {
const filePath = path.join(RELATIONS_DIR, entry.name);
const data = await readJSON(filePath, null);
return { filePath, data, entryName: entry.name };
})
);

// Filter to only those that need updating
const localToUpdate = allLocalRelations.filter(({ data }) => data && removeFromRelations(data));

// Write back in parallel
await Promise.all(
localToUpdate.map(({ filePath, data }) => writeJSON(filePath, data))
);

const localAffectedIds = localToUpdate
.map(({ data, entryName }) => data.id || path.basename(entryName, '.json'))
.filter(Boolean);

return { updated: localToUpdate.length, affectedIds: localAffectedIds };
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
    const cacheKey = `${activeS3Prefix}:${notepad?.id || ''}:${notepad?.name || ''}`;
    const cachedKey = s3NotepadKeyCache.get(cacheKey);
    if (cachedKey) return cachedKey;

    if (await s3PathExists(nameKey)) {
        s3NotepadKeyCache.set(cacheKey, nameKey);
        return nameKey;
    }
    if (await s3PathExists(idKey)) {
        s3NotepadKeyCache.set(cacheKey, idKey);
        return idKey;
    }
    s3NotepadKeyCache.set(cacheKey, nameKey);
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
    const safeContent = content || '';
    if (isS3Backend()) {
        const key = await getS3NotepadKey(notepad);
        await s3.putObject(s3Key(key), safeContent, 'text/plain; charset=utf-8');
        return;
    }

    const notePath = await getNotepadFilePath(notepad, DATA_DIR);
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    const tempPath = `${notePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tempPath, safeContent, 'utf8');
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await fs.rename(tempPath, notePath);
            return;
        } catch (err) {
            if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
            if (attempt === 4) throw err;
            await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
    }
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
        ...thoughtIndexFrom(thoughts),
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

    const notepadDocuments = await Promise.all(notepads.notepads.map(async (notepad) => ({
        id: notepad.id,
        type: 'notepad',
        title: notepad.name || '',
        content: await readNoteContent(notepad),
        tags: [],
        updatedAt: notepad.updatedAt || notepad.createdAt || 0
    })));

    return [...notepadDocuments, ...thoughtDocuments];
}

module.exports = {
    init,
    withThoughtWriteLock,
    withNotepadWriteLock,
    withAgentRunWriteLock,
    readThoughts,
    saveThoughts,
    readThought,
    listThoughtsPage,
    writeThought,
    deleteThought,
    readAgentRun,
    saveAgentRun,
    readAgentRunActiveIndex,
    hasAgentRunActiveIndex,
    listActiveAgentRunSummaries,
    listNonterminalAgentRuns,
    listActiveAgentRuns,
    rebuildAgentRunActiveIndex,
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
        AGENT_RUNS_DIR,
        AGENT_RUNS_ACTIVE_INDEX_FILE,
        TRASH_DIR,
        TRASH_INDEX_FILE
    },
    getS3Prefix,
    setS3Prefix,
    layout: STORAGE_LAYOUT,
    backend: STORAGE_BACKEND
};
