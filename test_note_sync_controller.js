const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function loadNoteSyncController() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'note-sync-controller.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace('export default class NoteSyncController', 'class NoteSyncController')
        + '\nmodule.exports = NoteSyncController;\n';
    const context = {
        module: { exports: {} },
        exports: {}
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function createMemoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        load(key) {
            return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null;
        },
        save(key, value) {
            store.set(key, JSON.parse(JSON.stringify(value)));
        },
        dump(key) {
            return store.get(key);
        }
    };
}

function run() {
    const NoteSyncController = loadNoteSyncController();
    const storageManager = createMemoryStorage();
    const sync = new NoteSyncController({ storageManager });

    assert(sync.loadStartupCache() === null, 'empty startup cache should load as null');

    sync.cacheNotepads({
        currentNotepadId: 'default',
        noteHistory: 'default',
        notepads: [
            { id: 'default', name: 'Default Notepad', createdAt: 1, updatedAt: 2, version: 3 },
            { id: 'second', name: 'Second', createdAt: 4, updatedAt: 5, version: 6 }
        ]
    });
    sync.cacheNote('default', 'clean content', { version: 3, dirty: false });
    sync.cacheNote('second', 'local dirty', {
        version: 6,
        dirty: true,
        remoteVersion: 8,
        conflict: true
    });

    const clean = sync.getCachedNote('default');
    assert(clean.content === 'clean content', 'cacheNote should store note content');
    assert(clean.version === 3, 'cacheNote should store note version');
    assert(clean.dirty === false, 'cacheNote should store clean state');

    const dirty = sync.getCachedNote('second');
    assert(dirty.content === 'local dirty', 'cacheNote should store dirty note content');
    assert(dirty.remoteVersion === 8, 'cacheNote should store remote conflict version');
    assert(dirty.conflict === true, 'cacheNote should store conflict marker');

    const dirtyNotes = sync.getDirtyCachedNotes({
        currentNotepads: [{ id: 'second', name: 'Second' }],
        conflictIds: new Set(['second'])
    });
    assert(dirtyNotes.length === 1, 'getDirtyCachedNotes should list dirty notes');
    assert(dirtyNotes[0].id === 'second', 'dirty note list should include note id');
    assert(dirtyNotes[0].name === 'Second', 'dirty note list should resolve note name');
    assert(dirtyNotes[0].conflict === true, 'dirty note list should merge conflict set');

    sync.cacheDirtyNote('default', 'local edit', { version: 3 });
    let defaultNote = sync.getCachedNote('default');
    assert(defaultNote.content === 'local edit', 'cacheDirtyNote should keep local content');
    assert(defaultNote.version === 3, 'cacheDirtyNote should keep local version');
    assert(defaultNote.dirty === true, 'cacheDirtyNote should mark note dirty');
    assert(defaultNote.conflict !== true, 'cacheDirtyNote should not mark conflict by default');
    assert(defaultNote.baseContent === 'clean content', 'first dirty edit should retain the last synced content as merge base');

    sync.cacheDirtyNote('default', 'local edit again', { version: 3 });
    defaultNote = sync.getCachedNote('default');
    assert(defaultNote.baseContent === 'clean content', 'later dirty edits should preserve the original merge base');

    sync.cacheDirtyNote('default', 'automatically merged edit', { version: 4, baseContent: 'new remote base' });
    defaultNote = sync.getCachedNote('default');
    assert(defaultNote.baseContent === 'new remote base', 'automatic merge should be able to advance the merge base');

    sync.cacheSyncedNote('default', 'remote saved', { version: 4 });
    defaultNote = sync.getCachedNote('default');
    assert(defaultNote.content === 'remote saved', 'cacheSyncedNote should keep saved content');
    assert(defaultNote.version === 4, 'cacheSyncedNote should update version');
    assert(defaultNote.dirty === false, 'cacheSyncedNote should clear dirty state');
    assert(defaultNote.conflict !== true, 'cacheSyncedNote should clear conflict state');

    sync.cacheConflictNote('default', 'conflicting local edit', {
        localVersion: 4,
        remoteVersion: 7
    });
    defaultNote = sync.getCachedNote('default');
    assert(defaultNote.content === 'conflicting local edit', 'cacheConflictNote should keep local content');
    assert(defaultNote.version === 4, 'cacheConflictNote should keep local base version');
    assert(defaultNote.remoteVersion === 7, 'cacheConflictNote should record remote version');
    assert(defaultNote.dirty === true, 'cacheConflictNote should keep dirty state');
    assert(defaultNote.conflict === true, 'cacheConflictNote should mark conflict');

    let merge = sync.mergeContents({
        base: 'title\nalpha\nomega',
        local: 'title\nlocal alpha\nomega',
        remote: 'title\nalpha\nremote omega'
    });
    assert(merge.ok === true, 'disjoint local and remote edits should merge automatically');
    assert(merge.content === 'title\nlocal alpha\nremote omega', 'automatic merge should retain both disjoint edits');

    merge = sync.mergeContents({
        base: 'title\nalpha\nomega',
        local: 'title\nlocal alpha\nomega',
        remote: 'title\nremote alpha\nomega'
    });
    assert(merge.ok === false && merge.reason === 'overlap', 'overlapping edits should remain an explicit conflict');

    let decision = sync.canSyncDirtyNote({
        notepadId: 'default',
        cachedNote: defaultNote,
        editorContent: 'conflicting local edit',
        isOnline: true,
        notepadExists: true,
        conflictIds: new Set(['default'])
    });
    assert(decision.ok === false && decision.reason === 'conflict', 'canSyncDirtyNote should block conflict notes');

    sync.cacheDirtyNote('default', 'local retry', { version: 4 });
    defaultNote = sync.getCachedNote('default');
    decision = sync.canSyncDirtyNote({
        notepadId: 'default',
        cachedNote: defaultNote,
        editorContent: 'changed in editor',
        isOnline: true,
        notepadExists: true
    });
    assert(decision.ok === false && decision.reason === 'editor_changed', 'canSyncDirtyNote should block when editor changed');

    decision = sync.canSyncDirtyNote({
        notepadId: 'default',
        cachedNote: defaultNote,
        editorContent: 'local retry',
        isOnline: true,
        notepadExists: true
    });
    assert(decision.ok === true, 'canSyncDirtyNote should allow clean dirty note retry');

    console.log('Note sync controller checks passed');
}

run();
