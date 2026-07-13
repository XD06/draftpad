const DEFAULT_STARTUP_CACHE_KEY = 'dumbpad_startup_cache_v1';

export default class NoteSyncController {
    constructor({ storageManager, key = DEFAULT_STARTUP_CACHE_KEY } = {}) {
        if (!storageManager) throw new Error('NoteSyncController requires storageManager');
        this.storageManager = storageManager;
        this.key = key;
    }

    loadStartupCache() {
        const cache = this.storageManager.load(this.key);
        if (!cache || cache.version !== 1 || !Array.isArray(cache.notepads)) return null;
        return {
            ...cache,
            notes: cache.notes && typeof cache.notes === 'object' ? cache.notes : {}
        };
    }

    saveStartupCache(patch = {}) {
        const previous = this.loadStartupCache() || { version: 1, notes: {}, notepads: [] };
        const next = {
            ...previous,
            ...patch,
            version: 1,
            notes: {
                ...(previous.notes || {}),
                ...(patch.notes || {})
            },
            savedAt: Date.now()
        };
        this.storageManager.save(this.key, next);
        return next;
    }

    cacheNotepads({ currentNotepadId, noteHistory, notepads }) {
        if (!Array.isArray(notepads) || notepads.length === 0) return null;
        return this.saveStartupCache({
            currentNotepadId,
            noteHistory,
            notepads: notepads.map(notepad => ({
                id: notepad.id,
                name: notepad.name,
                createdAt: notepad.createdAt,
                updatedAt: notepad.updatedAt,
                version: notepad.version
            }))
        });
    }

    cacheNote(notepadId, content, options = {}, { notepads = [] } = {}) {
        const previous = this.loadStartupCache() || { version: 1, notes: {}, notepads };
        const previousNote = previous.notes?.[notepadId] || {};
        const dirty = !!options.dirty;
        const nextNote = {
            content: content || '',
            version: Number.isFinite(options.version) ? options.version : previousNote.version,
            dirty,
            savedAt: Date.now()
        };
        const explicitBase = typeof options.baseContent === 'string' ? options.baseContent : null;
        const retainedBase = previousNote.dirty && typeof previousNote.baseContent === 'string'
            ? previousNote.baseContent
            : (!previousNote.dirty && typeof previousNote.content === 'string' ? previousNote.content : null);
        const baseContent = dirty ? (explicitBase ?? retainedBase) : nextNote.content;
        if (typeof baseContent === 'string') nextNote.baseContent = baseContent;
        if (Number.isFinite(options.remoteVersion)) nextNote.remoteVersion = Number(options.remoteVersion);
        if (options.conflict) nextNote.conflict = true;
        return this.saveStartupCache({
            currentNotepadId: notepadId,
            notepads: Array.isArray(notepads) && notepads.length ? notepads : previous.notepads,
            notes: {
                ...(previous.notes || {}),
                [notepadId]: nextNote
            }
        });
    }

    cacheDirtyNote(notepadId, content, { version, baseContent, notepads = [] } = {}) {
        return this.cacheNote(notepadId, content, {
            version,
            baseContent,
            dirty: true
        }, { notepads });
    }

    cacheSyncedNote(notepadId, content, { version, notepads = [] } = {}) {
        return this.cacheNote(notepadId, content, {
            version,
            dirty: false
        }, { notepads });
    }

    cacheConflictNote(notepadId, content, { localVersion, remoteVersion, notepads = [] } = {}) {
        return this.cacheNote(notepadId, content, {
            version: localVersion,
            dirty: true,
            remoteVersion,
            conflict: true
        }, { notepads });
    }

    mergeContents({ base, local, remote } = {}) {
        if (![base, local, remote].every(value => typeof value === 'string')) {
            return { ok: false, reason: 'missing_base' };
        }
        if (local === remote) return { ok: true, content: local, reason: 'identical' };
        if (local === base) return { ok: true, content: remote, reason: 'remote_only' };
        if (remote === base) return { ok: true, content: local, reason: 'local_only' };

        const localEdit = this.findSingleEdit(base, local);
        const remoteEdit = this.findSingleEdit(base, remote);
        const sameInsertionPoint = localEdit.start === localEdit.end
            && remoteEdit.start === remoteEdit.end
            && localEdit.start === remoteEdit.start;
        const disjoint = !sameInsertionPoint && (
            localEdit.end <= remoteEdit.start || remoteEdit.end <= localEdit.start
        );
        if (!disjoint) return { ok: false, reason: 'overlap' };

        const edits = [localEdit, remoteEdit].sort((a, b) => b.start - a.start);
        let content = base;
        for (const edit of edits) {
            content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
        }
        return { ok: true, content, reason: 'disjoint' };
    }

    findSingleEdit(base, next) {
        let start = 0;
        while (start < base.length && start < next.length && base[start] === next[start]) start += 1;

        let baseEnd = base.length;
        let nextEnd = next.length;
        while (baseEnd > start && nextEnd > start && base[baseEnd - 1] === next[nextEnd - 1]) {
            baseEnd -= 1;
            nextEnd -= 1;
        }
        return {
            start,
            end: baseEnd,
            replacement: next.slice(start, nextEnd)
        };
    }

    getCachedNote(notepadId) {
        return this.loadStartupCache()?.notes?.[notepadId] || null;
    }

    getDirtyCachedNotes({ currentNotepads = [], conflictIds = new Set() } = {}) {
        const cache = this.loadStartupCache();
        if (!cache?.notes || typeof cache.notes !== 'object') return [];
        const knownNotepads = [
            ...(Array.isArray(currentNotepads) ? currentNotepads : []),
            ...(Array.isArray(cache.notepads) ? cache.notepads : [])
        ];
        const names = new Map();
        for (const notepad of knownNotepads) {
            if (notepad?.id && !names.has(notepad.id)) {
                names.set(notepad.id, notepad.name || notepad.id);
            }
        }
        return Object.entries(cache.notes)
            .filter(([id, note]) => id && note?.dirty)
            .map(([id, note]) => ({
                id,
                name: names.get(id) || id,
                savedAt: note.savedAt || 0,
                conflict: !!note.conflict || conflictIds.has(id)
            }))
            .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    }

    canSyncDirtyNote({
        notepadId,
        cachedNote,
        editorContent,
        isOnline = true,
        notepadExists = true,
        conflictIds = new Set()
    } = {}) {
        if (!isOnline) return { ok: false, reason: 'offline' };
        if (!notepadId) return { ok: false, reason: 'invalid_notepad' };
        if (!cachedNote?.dirty) return { ok: false, reason: 'no_dirty' };
        if (editorContent !== cachedNote.content) return { ok: false, reason: 'editor_changed' };
        if (!notepadExists) return { ok: false, reason: 'notepad_missing' };
        if (conflictIds.has(notepadId) || cachedNote.conflict) {
            return { ok: false, reason: 'conflict' };
        }
        return { ok: true, reason: 'ready' };
    }
}
