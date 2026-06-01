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

    getCachedNote(notepadId) {
        return this.loadStartupCache()?.notes?.[notepadId] || null;
    }
}
