const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert(from >= 0 && to > from, `production source section exists: ${start}`);
    return source.slice(from, to);
}

function harness() {
    let now = 100000;
    let remoteVersion = 42;
    let remoteContent = 'remote 42';
    let failMeta = false;
    let bodyGate = null;
    let metaGate = null;
    const requests = [];
    const toasts = [];
    const cache = { version: 38, content: 'cached 38', dirty: false };
    const caches = { note: cache, other: { version: 1, content: 'other cached', dirty: false } };
    const dom = new JSDOM('<section id="section"></section><textarea id="content"></textarea><div id="message"></div><div id="summary"></div><strong id="local"></strong><strong id="remote"></strong>');
    const noOperation = () => {};
    const context = {
        Date: { now: () => now }, console: { warn: noOperation }, navigator: { onLine: true },
        currentNotepadId: 'note', currentNoteVersion: 38,
        currentNotepads: [{ id: 'note', name: 'Note', version: 42 }],
        remoteNoteStates: new Map(), noteLoadsInFlight: new Map(),
        editor: { value: 'cached 38' }, editorInstance: {}, bootEditorActive: false,
        isApplyingRemoteUpdate: false, hasUnsavedChanges: false,
        editorPerformanceSwitchToken: 0, pendingCaretRestoreNotepadId: null,
        settingsConflictSection: dom.window.document.querySelector('#section'),
        settingsConflictContent: dom.window.document.querySelector('#content'),
        settingsConflictMessage: dom.window.document.querySelector('#message'),
        settingsSyncSummary: dom.window.document.querySelector('#summary'),
        settingsLocalVersion: dom.window.document.querySelector('#local'),
        settingsServerVersion: dom.window.document.querySelector('#remote'),
        settingsCacheTime: null, settingsDirtyNotes: null, settingsRetryLocalSync: null,
        articleMetaFooter: { setMeta: noOperation },
        startupSyncSnapshot: { kind: 'cached', label: '本地快照' },
        findNotepadByIdOrName: (items, id) => items.find(item => item.id === id),
        isValidNotepadId: id => Boolean(id), getCachedNote: id => caches[id],
        loadStartupCache: () => ({ notes: caches }),
        getCurrentNotepadName: () => 'Note', getDirtyCachedNotes: () => [],
        setStartupSyncStatus(state, label) { context.startupSyncSnapshot = { kind: state, label }; },
        ensureEditor: async () => {},
        cacheSyncedNote(id, content, options) { Object.assign(caches[id], options, { content, dirty: false, conflict: false }); },
        cacheDirtyNote(id, content, options) { Object.assign(caches[id], options, { content, dirty: true }); },
        cacheConflictNote(id, content, options) { Object.assign(caches[id], { content, dirty: true, conflict: true, remoteVersion: options.remoteVersion }); },
        setCurrentNoteVersion(id, version) {
            context.currentNoteVersion = Number(version);
            context.currentNotepads.find(item => item.id === id).version = Number(version);
        },
        showEditingSurface: noOperation, restoreEditorCaretForNotepad: noOperation,
        markEditorPerformanceContent: noOperation, trackRecentFile: noOperation,
        updateSidebarSelection: noOperation, renderRecentFiles: noOperation,
        updateUrlWithNotepad: noOperation, applyCurrentNotepadTitle: noOperation,
        updateArticleMeta: noOperation, applyNoteEditStats: noOperation,
        hideNoteConflictToast: noOperation, replaySearchJumpAfterContentWrite: noOperation,
        debouncedUpdateToC: noOperation, selectNotepad: noOperation,
        deleteNotepadById: noOperation, renameNotepadById: noOperation, toggleNotepadPin: noOperation,
        toaster: { show: message => toasts.push(message) },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url.startsWith('/api/notepads/')) {
                if (metaGate) await metaGate;
                if (failMeta) throw new Error('network failed');
                return { ok: true, json: async () => ({ id: 'note', version: remoteVersion }) };
            }
            if (bodyGate) await bodyGate;
            return { ok: true, json: async () => ({ content: remoteContent, version: remoteVersion }) };
        }
    };
    vm.createContext(context);
    vm.runInContext([
        section('    async function fetchWithPin(', '    async function fetchJSON('),
        section('    function renderCachedNotepad(', '    async function fetchNoteData('),
        section('    async function fetchNoteData(', '    let notePrefetchRun'),
        section('    const dirtyConflictNotepadIds', '    let tocUpdateTimeout'),
        section('    function updateSettingsConflictSection(', '    function openSettingsModal(')
    ].join('\n'), context);
    return {
        context, cache, requests, toasts, dom,
        advance: milliseconds => { now += milliseconds; },
        remote: (version, content = `remote ${version}`) => { remoteVersion = version; remoteContent = content; },
        fail: value => { failMeta = value; },
        gateBody: promise => { bodyGate = promise; },
        gateMeta: promise => { metaGate = promise; }
    };
}

async function run() {
    const test = harness();
    const { context, cache, requests } = test;
    context.renderCachedNotepad('note', cache.content);
    assert.equal(context.currentNoteVersion, 38);
    assert.equal(context.currentNotepads[0].version, 42, 'cached body cannot pollute listed remote version');
    context.updateSettingsConflictSection();
    assert.equal(context.settingsServerVersion.textContent, '未确认', 'cached body never impersonates server confirmation');
    await context.reconcileCurrentNote('startup');
    assert.equal(context.editor.value, 'remote 42', '42 > 38 must fetch and apply the remote body');
    assert.equal(context.currentNoteVersion, 42);
    context.updateSettingsConflictSection();
    assert.equal(context.settingsServerVersion.textContent, '42');
    assert(requests.every(request => request.options.cache === 'no-store'));
    const bodyRequests = () => requests.filter(request => request.url.startsWith('/api/notes/')).length;
    assert.equal(bodyRequests(), 1);
    await context.reconcileCurrentNote('selection');
    assert.equal(requests.length, 2, 'non-forced selection within ten seconds is throttled');
    await context.reconcileCurrentNote('panel', { force: true });
    assert.equal(bodyRequests(), 1, 'same version only checks metadata');
    await context.loadNotes('note');
    assert.equal(bodyRequests(), 1, 'same-version non-forced load short-circuits');

    let releaseMeta;
    test.gateMeta(new Promise(resolve => { releaseMeta = resolve; }));
    const first = context.reconcileCurrentNote('online', { force: true });
    const second = context.reconcileCurrentNote('ws_connected', { force: true });
    assert.strictEqual(first, second, 'in-flight reconciliation is shared');
    context.updateSettingsConflictSection();
    assert.equal(context.settingsServerVersion.textContent, '正在确认');
    releaseMeta();
    await first;
    test.gateMeta(null);

    test.remote(43);
    Object.assign(cache, { dirty: true, content: 'unsaved local', version: 42, baseContent: 'remote 42' });
    context.editor.value = cache.content;
    await context.reconcileCurrentNote('foreground', { force: true });
    assert.equal(context.editor.value, 'unsaved local', 'remote refresh never overwrites dirty content');
    assert.equal(cache.baseContent, 'remote 42');
    assert.equal(cache.conflict, true);
    assert.equal(context.currentNoteVersion, 42);
    context.updateSettingsConflictSection();
    assert.equal(context.settingsLocalVersion.textContent, '42');
    assert.equal(context.settingsServerVersion.textContent, '43', 'dirty base stays separate from confirmed remote version');

    test.fail(true);
    assert.equal(await context.reconcileCurrentNote('weak network', { force: true }), false);
    assert.equal(test.toasts.length, 0, 'background network failures are silent');
    context.updateSettingsConflictSection();
    assert.equal(context.settingsServerVersion.textContent, '43（上次确认）');
    test.fail(false);
    await context.reconcileCurrentNote('retry');
    assert.equal(context.remoteNoteStates.get('note').status, 'confirmed', 'failed checks do not prevent immediate retry');
    test.dom.window.close();

    const dirtyVersion = harness();
    Object.assign(dirtyVersion.cache, { dirty: true, content: 'unsaved 38', version: 38, baseContent: 'cached base' });
    dirtyVersion.context.editor.value = dirtyVersion.cache.content;
    await dirtyVersion.context.reconcileCurrentNote('dirty remote', { force: true });
    assert.equal(dirtyVersion.context.currentNotepads[0].version, 42,
        'loading a dirty old base must not overwrite the freshly confirmed remote list version');
    assert.equal(dirtyVersion.context.currentNoteVersion, 38,
        'dirty loading keeps the local base version for conflict handling');
    dirtyVersion.dom.window.close();

    const race = harness();
    let releaseBody;
    race.gateBody(new Promise(resolve => { releaseBody = resolve; }));
    await race.context.loadNotes('note', { deferRemote: true });
    const reconciliation = race.context.reconcileCurrentNote('startup');
    releaseBody();
    await reconciliation;
    assert.equal(race.requests.filter(request => request.url.startsWith('/api/notes/')).length, 1,
        'reconciliation waits for an existing body load instead of fetching twice');

    let releaseSwitchedMeta;
    race.gateMeta(new Promise(resolve => { releaseSwitchedMeta = resolve; }));
    const switched = race.context.reconcileCurrentNote('switch', { force: true });
    race.context.currentNotepadId = 'other';
    race.context.editor.value = 'other body';
    releaseSwitchedMeta();
    assert.equal(await switched, false);
    assert.equal(race.context.editor.value, 'other body', 'a late reconciliation never writes into another article');
    race.dom.window.close();

    const switchBack = harness();
    switchBack.context.currentNotepads.push({ id: 'other', name: 'Other', version: 42 });
    let releaseSwitchBody;
    switchBack.gateBody(new Promise(resolve => { releaseSwitchBody = resolve; }));
    await switchBack.context.loadNotes('note', { deferRemote: true });
    switchBack.context.currentNotepadId = 'other';
    await switchBack.context.loadNotes('other', { deferRemote: true });
    switchBack.context.currentNotepadId = 'note';
    await switchBack.context.loadNotes('note', { deferRemote: true });
    releaseSwitchBody();
    await Promise.all([...switchBack.context.noteLoadsInFlight.values()]);
    assert.equal(switchBack.context.editor.value, 'remote 42', 'switching A to B to A reuses A loading and paints A');
    assert.equal(switchBack.requests.filter(request => request.url === '/api/notes/note').length, 1);
    switchBack.dom.window.close();

    console.log('Note reconciliation: cache isolation, version display, refresh, dirty protection, deduplication, retry and switching passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
