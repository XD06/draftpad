/**
 * 端到端回归测试：新建文章立即编写时的多管道协同同步、版本一致与存储加速。
 * 覆盖：1) 慢网络下 POST /api/notepads 往返期间连续打字不丢字、不误触 409；
 * 2) 自动命名 600ms + 自动保存 2000ms + 手动重命名同队列串行与版本联动；
 * 3) 真实跨端 409 响应拉取期间持续打字仍可安全三路合并；
 * 4) 仅元数据升版触发 reconcile/loadNotes 时不误报正文冲突；
 * 5) 单次保存仅读一次元数据，以及 generateUniqueName 防跨标点文件撞车。
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { registerNoteRoutes } = require('../routes/note-routes');
const { registerNotepadRoutes } = require('../routes/notepad-routes');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadNoteSyncController() {
    const filePath = path.join(ROOT, 'public/managers/note-sync-controller.js');
    const source = fs.readFileSync(filePath, 'utf8')
        .replace('export default class NoteSyncController', 'class NoteSyncController')
        + '\nmodule.exports = NoteSyncController;\n';
    const ctx = { module: { exports: {} }, exports: {}, Date, crypto, Math, Number, Object, Array, Set, Map };
    vm.runInNewContext(source, ctx, { filename: filePath });
    return ctx.module.exports;
}

function loadArticleTitleHelpers() {
    const filePath = path.join(ROOT, 'public/managers/article-title.js');
    const source = fs.readFileSync(filePath, 'utf8')
        .replace(/export const /g, 'const ')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { deriveArticleTitle, DEFAULT_NOTEPAD_NAME_RE };\n';
    const ctx = { module: { exports: {} }, exports: {}, String, Number, Math, Array, RegExp };
    vm.runInNewContext(source, ctx, { filename: filePath });
    return ctx.module.exports;
}

function extractSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert(start >= 0 && end > start, `Expected section: ${startMarker} .. ${endMarker}`);
    return source.slice(start, end);
}

function createFrontendHarness(baseUrl) {
    const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const NoteSyncController = loadNoteSyncController();
    const { deriveArticleTitle, DEFAULT_NOTEPAD_NAME_RE } = loadArticleTitleHelpers();

    const store = new Map();
    const storageManager = {
        load: (key) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null),
        save: (key, val) => { store.set(key, JSON.parse(JSON.stringify(val))); return true; }
    };
    const noteSyncController = new NoteSyncController({ storageManager });

    const toasts = [];
    const wsEvents = [];
    const statusHistory = [];
    let editorText = '';
    const editorProxy = {
        get value() { return editorText; },
        set value(v) { editorText = String(v ?? ''); },
        applyRemoteValue(v) { editorText = String(v ?? ''); }
    };

    const requests = [];
    const wrappedFetch = async (url, options = {}) => {
        const targetUrl = String(url).startsWith('http') ? url : `${baseUrl}${url}`;
        const response = await globalThis.fetch(targetUrl, options);
        requests.push({
            method: options.method || 'GET',
            url: String(url),
            status: response.status,
        });
        return response;
    };

    let currentUrl = `${baseUrl}/`;
    const context = {
        Date, Math, Number, String, Boolean, Array, Object, Map, Set, JSON, Promise, Error, RegExp, URL, Intl,
        console,
        setTimeout, clearTimeout,
        requestAnimationFrame: (fn) => setTimeout(fn, 0),
        navigator: { onLine: true },
        URLSearchParams,
        window: {
            crypto,
            location: { get origin() { return baseUrl; }, get href() { return currentUrl; }, search: '' },
            history: {
                replaceState(_s, _t, next) { currentUrl = String(next); },
                pushState(_s, _t, next) { currentUrl = String(next); }
            }
        },
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            querySelector: () => null
        },
        userId: 'client-a',
        editor: editorProxy,
        editorInstance: null,
        bootEditor: null,
        bootEditorActive: false,
        pendingEditorValue: '',
        renderedEditorNotepadId: null,
        renderedEditorContent: null,
        bootPreview: null,
        bootPreviewActive: false,
        bootPreviewScroller: null,
        bootPreviewContent: null,
        isApplyingRemoteUpdate: false,
        hasUnsavedChanges: false,
        editorPerformanceSwitchToken: 0,
        renameModal: {},
        renameInput: { value: '' },
        settingsModal: null,
        settingsConflictSection: null,
        settingsConflictContent: null,
        settingsConflictMessage: null,
        settingsSyncSummary: null,
        settingsLocalVersion: null,
        settingsServerVersion: null,
        settingsCacheTime: null,
        settingsDirtyNotes: null,
        settingsRetryLocalSync: null,
        articleMetaFooter: { setMeta: () => {} },
        noteSyncController,
        deriveArticleTitle,
        DEFAULT_NOTEPAD_NAME_RE,
        fetch: wrappedFetch,
        toaster: {
            show(message, type = 'info') {
                const handle = { message, type, parentNode: {} };
                toasts.push(handle);
                return handle;
            },
            hide(el) {
                if (el) el.parentNode = null;
            }
        },
        settingsManager: { getSettings: () => ({ saveStatusMessageInterval: 500 }) },
        wsClient: { sendUpdate: (type, detail) => wsEvents.push({ type, detail }) },
        ensureEditor: async () => {},
        selectNotepad: async () => {},
        deleteNotepadById: () => {},
        renameNotepadById: () => {},
        renderSidebar: () => {},
        renderRecentFiles: () => {},
        trackRecentFile: () => {},
        updateSidebarSelection: () => {},
        showEditingSurface: () => {},
        restoreEditorCaretForNotepad: () => {},
        markEditorPerformanceContent: () => {},
        replaySearchJumpAfterContentWrite: () => {},
        debouncedUpdateToC: () => {},
        applyNoteEditStats: () => {},
        updateSettingsConflictSection: () => {},
        hideModal: () => {},
        showModal: () => {},
        getStartupNotepadId: (list) => list[0]?.id || 'default',
        setStartupSyncStatus: (state, label) => { statusHistory.push({ state, label }); },
        applyCurrentNotepadTitle: () => {},
        persistCurrentRenderedSnapshot: () => {},
        scheduleIdleTask: (fn) => fn(),
        updateUrlWithNotepad: (name) => { currentUrl = `${baseUrl}/?id=${encodeURIComponent(name)}`; },
    };

    const blockA = extractSection(appSource, '    let saveTimeout;', '    let isReadingMode = false;');
    const blockB = extractSection(appSource, '    function createSaveId(', '    function setHeaderTitle(');
    const blockC = extractSection(appSource, '    async function fetchWithPin(', '    async function fetchJSON(');
    const blockD = extractSection(appSource, '    function isValidNotepadId(', '    function escapeHtml(');
    const blockF = extractSection(appSource, '    function getCurrentNotepad(', '    function handleQueryParameterSelection(');
    const blockG = extractSection(appSource, '    function handleQueryParameterSelection(', '    let tocUpdateTimeout;');
    const blockH = extractSection(appSource, '    async function createNotepad(', '    let dirtySyncInFlight');
    const blockI = extractSection(appSource, '    function debouncedSave(', '    async function deleteNotepad(');

    vm.createContext(context);
    vm.runInContext([
        blockA,
        blockB,
        blockC,
        blockD,
        blockF,
        blockG,
        blockH,
        blockI,
        `
        this.__harness = {
            createNotepad,
            debouncedSave,
            renameNotepad,
            loadNotes,
            loadNotepads,
            reconcileCurrentNote,
            saveNotes,
            getState: () => ({
                currentNotepadId,
                currentNoteVersion,
                currentNotepads,
                editorText: editor.value,
                cachedNote: noteSyncController.getCachedNote(currentNotepadId),
                dirtyConflicts: [...dirtyConflictNotepadIds],
                hasUnsavedChanges,
            }),
            setActiveNotepad: (id) => { currentNotepadId = id; },
            setRenameTarget: (id, nextName) => {
                notepadIdToRename = id;
                renameInput.value = nextName;
            },
            typeText: (text) => {
                editor.value = text;
                hasUnsavedChanges = true;
                editorRevision += 1;
                debouncedSave(text);
            },
            resetSaveCooldown: () => { lastSaveTime = 0; },
            getRevision: () => editorRevision,
        };
        `
    ].join('\n'), context);

    return {
        h: context.__harness,
        sync: noteSyncController,
        toasts,
        requests,
        wsEvents,
        statusHistory,
        setEditorText: (v) => { editorText = v; },
        getEditorText: () => editorText,
    };
}

function waitForServer(port, timeoutMs = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
                res.resume();
                resolve();
            }).on('error', () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('Server failed to start within timeout'));
                    return;
                }
                setTimeout(tick, 150);
            });
        };
        tick();
    });
}

(async () => {
    // Instrumented in-memory backend server using real routes
    let metadata = {
        notepads: [{ id: 'default', name: 'Default Notepad', version: 1, createdAt: 1, updatedAt: 1 }]
    };
    const contents = new Map([['default', '']]);
    let readMetaCalls = 0;
    let createDelayMs = 0;
    let bodyReadGate = null;
    let lock = Promise.resolve();

    const storage = {
        init: async () => {},
        readNotepadsMeta: async () => {
            readMetaCalls += 1;
            return structuredClone(metadata);
        },
        saveNotepadsMeta: async (data) => {
            metadata = structuredClone(data);
        },
        readNoteContent: async (notepad) => {
            if (bodyReadGate) await bodyReadGate;
            return contents.get(notepad.id) || '';
        },
        writeNoteContent: async (notepad, content) => {
            contents.set(notepad.id, content || '');
        },
        renameNoteContent: async () => {},
        withNotepadWriteLock(operation) {
            const run = lock.then(operation, operation);
            lock = run.catch(() => {});
            return run;
        }
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.cookies = {}; next(); });
    app.use('/api/notepads', (req, _res, next) => {
        if (req.method === 'POST' && createDelayMs > 0) {
            setTimeout(next, createDelayMs);
            return;
        }
        next();
    });

    const routeCtx = {
        storage,
        dataDir: os.tmpdir(),
        baseUrl: 'http://localhost',
        nodeEnv: 'test',
        pageHistoryCookie: 'dumbpad_page_history',
        pageHistoryCookieAge: 10000,
        loadNotepadsList: async () => structuredClone(metadata.notepads),
        generateUniqueName: (desiredName, existing) => {
            let name = String(desiredName || 'Untitled');
            let n = 1;
            while (existing.some((item) => item.name === name)) {
                name = `${desiredName}-${n++}`;
            }
            return name;
        },
        findNotepadById: async (id) => {
            const data = await storage.readNotepadsMeta();
            return { data, notepad: data.notepads.find((item) => item.id === id) };
        },
        broadcastUpdate: () => {},
        scheduleIndexNotepads: () => {},
    };
    registerNoteRoutes(app, routeCtx);
    registerNotepadRoutes(app, routeCtx);

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
        // ===== Case 1 & 2: Create + Immediate Typing Under Slow Create RTT -> Auto-Title -> Auto-Save -> Manual Rename =====
        const client = createFrontendHarness(baseUrl);
        await client.h.loadNotepads({ loadCurrentNote: false });
        client.h.resetSaveCooldown();

        createDelayMs = 260;
        const createPromise = client.h.createNotepad();
        const createdId = client.h.getState().currentNotepadId;
        assert(createdId.startsWith('note-'), 'optimistic notepad created immediately');

        // Type BEFORE POST /api/notepads returns!
        await sleep(35);
        client.h.typeText('# 新建即写标题\n第一行正文内容');
        assert.equal(client.getEditorText(), '# 新建即写标题\n第一行正文内容');

        // Wait for POST /api/notepads response at t ~ 260ms
        await createPromise;
        createDelayMs = 0;

        // Critical invariant 1: POST /api/notepads completion MUST NOT wipe user's typed text!
        assert.equal(client.getEditorText(), '# 新建即写标题\n第一行正文内容',
            'Case 1: typed text during in-flight POST /api/notepads must survive completion');
        assert.equal(client.h.getState().cachedNote.dirty, true,
            'Case 1: note edited during POST must remain dirty until saved');

        // Concurrent loadNotepads while creating wouldn't erase it; wait for auto-title (600ms) + auto-save (2000ms)
        await sleep(2400);

        const afterSaveState = client.h.getState();
        const postSaveStatuses = client.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/api/notes/'));
        const putStatuses = client.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/api/notepads/'));
        const conflicts = client.requests.filter((r) => r.status === 409);

        assert(putStatuses.length >= 1 && putStatuses.every((r) => r.status === 200),
            `Case 2: auto-title PUT should succeed (got ${JSON.stringify(putStatuses)})`);
        assert(postSaveStatuses.length >= 1 && postSaveStatuses.every((r) => r.status === 200),
            `Case 2: auto-save POST should succeed without 409 (got ${JSON.stringify(postSaveStatuses)})`);
        assert.equal(conflicts.length, 0,
            `Case 1/2: single-device create + type + auto-title + save must trigger 0 HTTP 409s (got ${JSON.stringify(client.requests)})`);
        assert.equal(afterSaveState.dirtyConflicts.length, 0, 'no conflict flag left on notepad');
        assert(!client.toasts.some((t) => /冲突|已在其他设备更新/.test(t.message)),
            `must not show conflict toast (saw ${JSON.stringify(client.toasts)})`);
        assert.equal(afterSaveState.currentNotepads.find((n) => n.id === createdId)?.name, '新建即写标题',
            'auto-title renamed notepad to derived heading');
        assert.equal(afterSaveState.currentNoteVersion, 3,
            'create(v1) -> auto-title PUT(v2) -> body POST(v3) keeps exact version sync');
        assert.equal(contents.get(createdId), '# 新建即写标题\n第一行正文内容',
            'server content matches typed article');

        // Manual rename immediately after must succeed with updated version (v3 -> v4)
        client.h.setRenameTarget(createdId, '手工最终标题');
        await client.h.renameNotepad();
        const afterManualRename = client.h.getState();
        assert.equal(afterManualRename.currentNotepads.find((n) => n.id === createdId)?.name, '手工最终标题',
            'Case 2: manual rename succeeds cleanly');
        assert.equal(afterManualRename.currentNoteVersion, 4,
            'Case 2: manual rename advances currentNoteVersion so next save will not 409');
        assert.equal(afterManualRename.cachedNote.version, 4,
            'Case 2: manual rename advances cachedNote.version');

        // Type right after manual rename -> auto-save must send baseVersion=4 and get 200 OK
        client.h.resetSaveCooldown();
        client.h.typeText('# 新建即写标题\n第一行正文内容\n追加一段');
        await sleep(2250);
        assert.equal(client.requests.filter((r) => r.status === 409).length, 0,
            'Case 2: save after manual rename must send updated baseVersion and avoid 409');
        assert.equal(client.h.getState().currentNoteVersion, 5);
        console.log('PASS Case 1 & 2: Create + immediate typing + auto-title + save + manual rename (zero 409, zero wipe)');

        // ===== Case 3: Typing continuously during a real 409 response + fetchNoteData RTT =====
        const seedRes = await globalThis.fetch(`${baseUrl}/api/notepads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'case3-note', name: 'Case 3', content: 'Top line\nMiddle\nBottom line' })
        }).then((r) => r.json());
        assert.equal(seedRes.version, 1);
        await client.h.loadNotepads({ loadCurrentNote: false });
        client.h.getState().currentNotepads.forEach(() => {});
        // Switch client context cleanly via loadNotes mock selection
        const client3 = createFrontendHarness(baseUrl);
        await client3.h.loadNotepads({ loadCurrentNote: false });
        client3.h.setActiveNotepad('case3-note');
        await client3.h.loadNotes('case3-note');
        assert.equal(client3.getEditorText(), 'Top line\nMiddle\nBottom line');

        // Device B appends at bottom on server -> server moves to v2
        const patchRes = await globalThis.fetch(`${baseUrl}/api/notes/case3-note`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Top line\nMiddle\nBottom line from B', baseVersion: 1, userId: 'device-b' })
        }).then((r) => r.json());
        assert.equal(patchRes.version, 2);

        // Device A is still on baseVersion 1 and edits at top
        client3.h.resetSaveCooldown();
        client3.sync.cacheDirtyNote('case3-note', 'Top A\nMiddle\nBottom line', { version: 1, baseContent: 'Top line\nMiddle\nBottom line' });
        client3.setEditorText('Top A\nMiddle\nBottom line');

        // Simulate 409 fetchNoteData in flight while user types ONE MORE char at top!
        let releaseGet;
        const origGet = storage.readNoteContent;
        const getStarted = new Promise((res) => {
            storage.readNoteContent = async (np) => {
                if (np.id === 'case3-note' && bodyReadGate === 'armed') {
                    bodyReadGate = null;
                    res();
                    await new Promise((r) => { releaseGet = r; });
                }
                return origGet(np);
            };
        });
        bodyReadGate = 'armed';
        try {
            const conflictingSavePromise = client3.h.saveNotes('Top A\nMiddle\nBottom line', true, false, 0, 'case3-note', null);
            await getStarted;
            // User types more text at top while GET /api/notes/case3-note is in flight!
            client3.setEditorText('Top A+extra\nMiddle\nBottom line');
            releaseGet();
            await conflictingSavePromise;
        } finally {
            storage.readNoteContent = origGet;
        }
        await sleep(150);

        const state3 = client3.h.getState();
        assert.equal(state3.dirtyConflicts.length, 0,
            'Case 3: typing during 409 recovery must not fail into dirtyConflictNotepadIds');
        assert(!client3.toasts.some((t) => t.type === 'error'),
            `Case 3: typing during 409 recovery must auto-merge without error toast (got ${JSON.stringify(client3.toasts)})`);
        assert(client3.getEditorText().includes('Top A+extra') && client3.getEditorText().includes('Bottom line from B'),
            `Case 3: disjoint merge preserved both Device A live extra char and Device B edit (got ${JSON.stringify(client3.getEditorText())})`);
        assert(contents.get('case3-note').includes('Top A+extra') && contents.get('case3-note').includes('Bottom line from B'),
            `Case 3: follow-up merged save persisted to server (got ${JSON.stringify(contents.get('case3-note'))})`);
        assert.equal(state3.currentNoteVersion, 3);
        console.log('PASS Case 3: Continuous typing during real 409 recovery auto-merges cleanly');

        // ===== Case 4: loadNotes after metadata-only version bump on dirty note =====
        const client4 = createFrontendHarness(baseUrl);
        await globalThis.fetch(`${baseUrl}/api/notepads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'case4-note', name: 'Case 4', content: 'Base text' })
        });
        await client4.h.loadNotepads({ loadCurrentNote: false });
        client4.h.setActiveNotepad('case4-note');
        await client4.h.loadNotes('case4-note');
        // Local edit still in debounce window (baseVersion = 1, baseContent = 'Base text')
        client4.sync.cacheDirtyNote('case4-note', 'Local unsaved text', { version: 1, baseContent: 'Base text' });
        client4.setEditorText('Local unsaved text');
        // Remote renames metadata only (version = 2, content STILL 'Base text')
        await globalThis.fetch(`${baseUrl}/api/notepads/case4-note`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Case 4 Renamed', baseVersion: 1 })
        });
        await client4.h.loadNotes('case4-note', { forceRemote: true });
        const state4 = client4.h.getState();
        assert.equal(state4.currentNoteVersion, 2, 'Case 4: metadata-only remote bump updates currentNoteVersion');
        assert.equal(Boolean(state4.cachedNote.conflict), false, 'Case 4: unchanged remote text must NOT flag conflict');
        assert.equal(state4.cachedNote.dirty, true, 'Case 4: dirty state preserved across metadata-only bump');
        assert.equal(state4.dirtyConflicts.length, 0, 'Case 4: dirtyConflictNotepadIds remains empty');
        assert.equal(client4.getEditorText(), 'Local unsaved text', 'Case 4: unsaved local edit kept intact');
        console.log('PASS Case 4: Metadata-only version bump on dirty note advances version without conflict');

        // ===== Case 5: Single readNotepadsMeta per save + server.js generateUniqueName sanitized collision =====
        readMetaCalls = 0;
        const metaCheckRes = await globalThis.fetch(`${baseUrl}/api/notes/case4-note`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Updated body', baseVersion: 2, userId: 'tester' })
        });
        assert.equal(metaCheckRes.status, 200);
        assert.equal(readMetaCalls, 1,
            `Case 5: POST /api/notes/:id should read notepads meta only ONCE inside write lock (got ${readMetaCalls})`);

        // Real server.js check for generateUniqueName across sanitized collisions ("API: Guide" vs "API/ Guide")
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-uniq-name-'));
        const testPort = 10099;
        const realServer = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: { ...process.env, PORT: String(testPort), WS_PORT: String(testPort + 1), DATA_DIR: dataDir, DUMBPAD_PIN: '', NODE_ENV: 'production' },
            stdio: 'ignore',
        });
        try {
            await waitForServer(testPort);
            const firstNp = await globalThis.fetch(`http://127.0.0.1:${testPort}/api/notepads`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'API: Guide', content: 'first body' })
            }).then((r) => r.json());
            const secondNp = await globalThis.fetch(`http://127.0.0.1:${testPort}/api/notepads`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'API/ Guide', content: 'second body' })
            }).then((r) => r.json());

            assert.equal(firstNp.name, 'API: Guide');
            assert.equal(secondNp.name, 'API/ Guide-1',
                `Case 5: colliding sanitized filenames must auto-suffix (got ${JSON.stringify(secondNp.name)})`);
            const body1 = await globalThis.fetch(`http://127.0.0.1:${testPort}/api/notes/${firstNp.id}`).then((r) => r.json());
            const body2 = await globalThis.fetch(`http://127.0.0.1:${testPort}/api/notes/${secondNp.id}`).then((r) => r.json());
            assert.equal(body1.content, 'first body');
            assert.equal(body2.content, 'second body');
        } finally {
            realServer.kill();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
        console.log('PASS Case 5: Single metadata read per save & sanitized filename collision protection');

        console.log('\nAll create-and-type sync regression checks passed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
