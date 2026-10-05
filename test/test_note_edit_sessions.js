const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { JSDOM } = require('jsdom');
const { registerNoteRoutes } = require('../routes/note-routes');
const { registerNotepadRoutes } = require('../routes/notepad-routes');
const { recordNoteEdit } = require('../scripts/note-edit-stats');

const ROOT = path.resolve(__dirname, '..');

function loadFrontend(relativePath, exportName, globals = {}) {
    const sourcePath = path.join(ROOT, relativePath);
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace('export default class ', 'class ')
        .replace('export class ', 'class ')
        + `\nmodule.exports = ${exportName};`;
    const context = { module: { exports: {} }, ...globals };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

async function run() {
    let now = 1800000000000;
    let sequence = 0;
    const originalNow = Date.now;
    Date.now = () => now;
    const entries = new Map();
    const storageManager = {
        load: key => entries.has(key) ? structuredClone(entries.get(key)) : null,
        save: (key, value) => entries.set(key, structuredClone(value))
    };
    const NoteSyncController = loadFrontend('public/managers/note-sync-controller.js', 'NoteSyncController', {
        Date,
        crypto: { randomUUID: () => `session-${++sequence}` }
    });
    let sync = new NoteSyncController({ storageManager });
    const legacy = { id: 'note', name: 'Note', version: 1340, createdAt: now - 1000000, updatedAt: now - 100000 };
    let metadata = { notepads: [legacy, { ...legacy, id: 'other', name: 'Other' }] };
    const contents = new Map([['note', 'base'], ['other', 'other base']]);
    let metadataWrites = 0;
    let contentWrites = 0;
    const broadcasts = [];
    let lock = Promise.resolve();
    const storage = {
        init: async () => {},
        readNotepadsMeta: async () => structuredClone(metadata),
        saveNotepadsMeta: async data => { metadata = structuredClone(data); metadataWrites += 1; },
        readNoteContent: async notepad => contents.get(notepad.id),
        writeNoteContent: async (notepad, content) => { contents.set(notepad.id, content); contentWrites += 1; },
        renameNoteContent: async () => {},
        withNotepadWriteLock(operation) {
            const result = lock.then(operation);
            lock = result.catch(() => {});
            return result;
        }
    };
    const context = {
        storage,
        baseUrl: 'http://localhost',
        nodeEnv: 'test',
        pageHistoryCookie: 'history',
        pageHistoryCookieAge: 10000,
        loadNotepadsList: async () => structuredClone(metadata.notepads),
        generateUniqueName: name => name,
        findNotepadById: async id => {
            const data = await storage.readNotepadsMeta();
            return { data, notepad: data.notepads.find(note => note.id === id) };
        },
        broadcastUpdate: (...args) => broadcasts.push(args),
        scheduleIndexNotepads: () => {}
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.cookies = {}; next(); });
    registerNoteRoutes(app, context);
    registerNotepadRoutes(app, context);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, method = 'GET', body) => {
        const response = await fetch(`${baseUrl}${route}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    };
    const input = content => sync.cacheDirtyNote('note', content, { version: 1340, recordActivity: true });
    const save = () => {
        const cached = sync.getCachedNote('note');
        return request('/api/notes/note', 'POST', {
            content: cached.content,
            baseVersion: metadata.notepads[0].version,
            editSessionId: cached.editSessionId,
            previousEditSessionId: cached.previousEditSessionId
        });
    };

    try {
        sync.cacheNotepads({ currentNotepadId: 'note', notepads: metadata.notepads });
        sync.cacheSyncedNote('note', 'base', { version: 1340 });
        let result = await request('/api/notes/note');
        assert.strictEqual(result.body.editCount, 0, 'legacy versions are not converted into session counts');
        assert.strictEqual(result.body.version, 1340);
        assert.strictEqual(metadataWrites, 0, 'reads must not migrate or write statistics');

        input('first edit');
        const firstSession = sync.getCachedNote('note').editSessionId;
        result = await save();
        assert.strictEqual(result.body.editCount, 1, 'first successful edit counts immediately');
        assert.strictEqual(result.body.version, 1341, 'sync version still increments for every changed save');
        assert.strictEqual(result.body.updatedAt, now);
        assert.strictEqual(broadcasts.at(-1)[4].editCount, 1, 'broadcast carries authoritative statistics');

        for (let index = 1; index <= 360; index += 1) {
            now += 500;
            input(`continuous input ${index}`);
        }
        assert.strictEqual(sync.getCachedNote('note').editSessionId, firstSession,
            'three minutes of continuous input without saves remains one session');
        result = await save();
        assert.strictEqual(result.body.editCount, 1, 'a long gap between requests does not split continuous typing');
        assert.strictEqual(result.body.version, 1342);

        now += 59999;
        input('still editing');
        assert.strictEqual(sync.getCachedNote('note').editSessionId, firstSession, '59.999 seconds idle stays in the session');
        now += 2000;
        result = await save();
        assert.strictEqual(result.body.editCount, 1);
        now += 58000;
        input('after one minute idle');
        assert.notStrictEqual(sync.getCachedNote('note').editSessionId, firstSession, '60 seconds idle opens a new session');
        assert.strictEqual(sync.getCachedNote('note').previousEditSessionId, firstSession);
        result = await save();
        assert.strictEqual(result.body.editCount, 2, 'input inactivity, not the shorter save gap, defines the boundary');

        const beforeNoop = structuredClone(metadata);
        const writes = metadataWrites;
        const broadcastCount = broadcasts.length;
        result = await request('/api/notes/note', 'POST', {
            content: contents.get('note'), baseVersion: 1, editSessionId: 'noop-session'
        });
        assert.strictEqual(result.body.unchanged, true, 'identical stale retries remain successful noops');
        assert.deepStrictEqual(metadata, beforeNoop, 'noop does not extend activity or change count/version/time');
        result = await request('/api/notes/note', 'POST', { content: 'stale change', baseVersion: 1 });
        assert.strictEqual(result.status, 409);
        assert.deepStrictEqual(metadata, beforeNoop, 'conflicts leave both statistics and sync metadata untouched');
        assert.strictEqual(metadataWrites, writes);
        assert.strictEqual(broadcasts.length, broadcastCount);

        const secondSession = sync.getCachedNote('note').editSessionId;
        const lastInput = sync.getCachedNote('note').lastEditedAt;
        sync.cacheSyncedNote('note', contents.get('note'), { version: result.body.currentVersion });
        sync = new NoteSyncController({ storageManager });
        assert.strictEqual(sync.getCachedNote('note').editSessionId, secondSession, 'reload and acknowledgements preserve the session');
        sync.cacheConflictNote('note', 'local dirty', { localVersion: 1344, remoteVersion: 1345 });
        sync.cacheDirtyNote('note', 'merged', { version: 1345, baseContent: 'remote' });
        assert.strictEqual(sync.getCachedNote('note').lastEditedAt, lastInput, 'remote updates and merges do not fabricate input activity');
        sync.cacheDirtyNote('other', 'other edit', { recordActivity: true });
        assert.notStrictEqual(sync.getCachedNote('other').editSessionId, secondSession, 'articles have independent sessions');

        const beforeRename = metadata.notepads[0].editCount;
        await request('/api/notepads/note', 'PUT', { name: 'Renamed', baseVersion: metadata.notepads[0].version });
        await request('/api/notepads/note', 'PATCH', { pinned: true, baseVersion: metadata.notepads[0].version });
        assert.strictEqual(metadata.notepads[0].editCount, beforeRename, 'rename and pin preserve the count');

        now += 60000;
        result = await request('/api/notes/note', 'PATCH', { action: 'append', text: ' API', baseVersion: metadata.notepads[0].version });
        assert.strictEqual(result.body.editCount, 3, 'clients without session ids use the server idle interval');
        result = await request('/api/notes/note/edits', 'POST', {
            baseVersion: metadata.notepads[0].version,
            edits: [{ action: 'append', text: ' one' }, { action: 'append', text: ' two' }]
        });
        assert.strictEqual(result.body.editCount, 3, 'batch edits use the same session counter');
        const beforeRead = metadataWrites;
        result = await request('/api/notes/note');
        assert.strictEqual(result.body.editCount, 3);
        assert.strictEqual(metadataWrites, beforeRead);
        assert.strictEqual(contentWrites, metadataWrites - 2, 'statistics reuse existing writes; only rename and pin add metadata-only writes');

        const shared = { version: 10, updatedAt: now };
        recordNoteEdit(shared, 'device-a', undefined, now);
        recordNoteEdit(shared, 'device-b', undefined, now + 30000);
        recordNoteEdit(shared, 'device-a', undefined, now + 180000);
        assert.strictEqual(shared.editCount, 1, 'interleaved device sessions are deduplicated within the current editing round');
        assert.strictEqual(shared.version, 10, 'statistics helper never changes sync versions');
        assert.strictEqual(shared.updatedAt, now);

        sync.cacheNotepads({ currentNotepadId: 'note', notepads: metadata.notepads });
        assert.strictEqual(sync.loadStartupCache().notepads[0].editCount, 3, 'startup caches retain the real count');
        const dom = new JSDOM('<main></main>');
        const ArticleMetaFooter = loadFrontend('public/managers/article-meta-footer.js', 'ArticleMetaFooter', {
            document: dom.window.document, window: dom.window
        });
        const footer = new ArticleMetaFooter({ host: dom.window.document.querySelector('main'), getCard: () => null });
        footer.attach();
        footer.setMeta({ ...legacy, revision: 1340 });
        assert(!footer.el.textContent.includes('修改'), 'legacy footer never displays version minus one');
        footer.setMeta(result.body);
        assert(footer.el.textContent.includes('修改3 次'), 'footer renders the independent count');
        assert(footer.el.querySelector('[title*="自 "]'), 'tooltip discloses the statistics start date');
        dom.window.close();

        console.log('Note editing sessions: input boundaries, counts, HTTP saves, noops, conflicts, caches and footer passed');
    } finally {
        Date.now = originalNow;
        await new Promise(resolve => server.close(resolve));
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
