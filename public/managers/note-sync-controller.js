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
        const nextNote = {
            content: content || '',
            version: Number.isFinite(options.version) ? options.version : previousNote.version,
            dirty: !!options.dirty,
            savedAt: Date.now()
        };
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

    cacheDirtyNote(notepadId, content, { version, notepads = [] } = {}) {
        return this.cacheNote(notepadId, content, {
            version,
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
