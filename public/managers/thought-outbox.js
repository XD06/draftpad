const DEFAULT_OUTBOX_KEY = 'dumbpad_thoughts_outbox_v1';

export default class ThoughtOutbox {
    constructor({ storage = window.localStorage, key = DEFAULT_OUTBOX_KEY } = {}) {
        this.storage = storage;
        this.key = key;
        this.changeListeners = new Set();
    }

    onChange(callback) {
        if (typeof callback !== 'function') return () => {};
        this.changeListeners.add(callback);
        return () => this.changeListeners.delete(callback);
    }

    emitChange(items) {
        this.changeListeners.forEach(callback => callback(items));
    }

    load() {
        try {
            const items = JSON.parse(this.storage.getItem(this.key) || '[]');
            return Array.isArray(items) ? items : [];
        } catch (err) {
            console.warn('Failed to load thought outbox:', err);
            return [];
        }
    }

    save(items) {
        const nextItems = Array.isArray(items) ? items : [];
        try {
            this.storage.setItem(this.key, JSON.stringify(nextItems));
        } catch (err) {
            console.warn('Failed to save thought outbox:', err);
        }
        this.emitChange(nextItems);
        return nextItems;
    }

    count() {
        return this.load().length;
    }

    cloneThought(thought) {
        return {
            ...thought,
            subItems: Array.isArray(thought.subItems) ? thought.subItems.map(item => ({ ...item })) : [],
            tags: Array.isArray(thought.tags) ? [...thought.tags] : [],
            attachments: Array.isArray(thought.attachments) ? thought.attachments.map(att => ({ ...att })) : []
        };
    }

    buildOverwriteBody(thought) {
        return {
            action: 'overwrite',
            text: thought.text || '',
            subItems: Array.isArray(thought.subItems) ? thought.subItems.map(item => ({ ...item })) : [],
            tags: Array.isArray(thought.tags) ? [...thought.tags] : [],
            completed: thought.completed === true,
            pinned: thought.pinned === true,
            attachments: Array.isArray(thought.attachments) ? thought.attachments.map(att => ({ ...att })) : [],
            baseVersion: Number.isFinite(Number(thought.version)) ? Number(thought.version) : undefined
        };
    }

    enqueue(item) {
        const items = this.load();
        const nextItem = {
            id: item.id || `outbox-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            createdAt: Date.now(),
            attempts: 0,
            ...item
        };

        let next = items;
        let outcome = 'queued';

        if (nextItem.kind === 'patch') {
            const createIndex = items.findIndex(existing => (
                existing.kind === 'create' &&
                existing.tempThought?.id === nextItem.thoughtId
            ));
            if (createIndex >= 0) {
                next = items.map((existing, index) => {
                    if (index !== createIndex) return existing;
                    const localThought = nextItem.localThought || {};
                    return {
                        ...existing,
                        body: {
                            ...existing.body,
                            text: localThought.text ?? existing.body?.text,
                            subItems: localThought.subItems ?? existing.body?.subItems,
                            tags: localThought.tags ?? existing.body?.tags,
                            completed: localThought.completed === true
                        },
                        tempThought: {
                            ...existing.tempThought,
                            ...localThought,
                            localPending: true
                        }
                    };
                });
                this.save(next);
                return { item: next[createIndex], items: next, outcome: 'merged-create' };
            }
            next = items.filter(existing => !(existing.kind === 'patch' && existing.thoughtId === nextItem.thoughtId));
        } else if (nextItem.kind === 'delete') {
            const createIndex = items.findIndex(existing => (
                existing.kind === 'create' &&
                existing.tempThought?.id === nextItem.thoughtId
            ));
            if (createIndex >= 0) {
                next = items.filter((_, index) => index !== createIndex);
                this.save(next);
                return { item: nextItem, items: next, outcome: 'cancelled-create' };
            }
            next = items.filter(existing => existing.thoughtId !== nextItem.thoughtId);
        }

        next.push(nextItem);
        this.save(next);
        return { item: nextItem, items: next, outcome };
    }

    enqueueOverwrite(thought) {
        if (!thought?.id) return null;
        thought.localPending = true;
        return this.enqueue({
            kind: 'patch',
            thoughtId: thought.id,
            method: 'PATCH',
            url: `/api/thoughts/${encodeURIComponent(thought.id)}`,
            body: this.buildOverwriteBody(thought),
            localThought: this.cloneThought(thought)
        });
    }

    markConflict(thoughtId, conflict = {}) {
        const items = this.load();
        const next = items.map(item => {
            if (item.kind !== 'patch' || item.thoughtId !== thoughtId) return item;
            return {
                ...item,
                state: 'conflict',
                lastError: conflict.message || item.lastError || 'Thought has been updated on another device',
                conflict: {
                    currentVersion: conflict.currentVersion,
                    detectedAt: Date.now()
                }
            };
        });
        this.save(next);
        return next.find(item => item.kind === 'patch' && item.thoughtId === thoughtId) || null;
    }

    // Give a conflicted patch an exit so the queue never dead-locks.
    // "Keep local": rebase the pending overwrite onto the current remote version
    // and clear the conflict/attempts so the next retry resends and wins.
    rebaseConflict(thoughtId, currentVersion) {
        const items = this.load();
        let updated = null;
        const next = items.map(item => {
            if (item.kind !== 'patch' || item.thoughtId !== thoughtId || item.state !== 'conflict') return item;
            const remoteVersion = Number(currentVersion);
            const fallbackVersion = Number(item.conflict?.currentVersion);
            const nextBaseVersion = Number.isFinite(remoteVersion)
                ? remoteVersion
                : (Number.isFinite(fallbackVersion) ? fallbackVersion : item.body?.baseVersion);
            updated = {
                ...item,
                state: undefined,
                attempts: 0,
                lastError: undefined,
                conflict: undefined,
                body: { ...item.body, baseVersion: nextBaseVersion }
            };
            return updated;
        });
        if (updated) this.save(next);
        return updated;
    }

    // "Discard local": drop the conflicted patch entirely so the remote version wins.
    discardConflict(thoughtId) {
        const items = this.load();
        const next = items.filter(item => !(item.kind === 'patch' && item.thoughtId === thoughtId && item.state === 'conflict'));
        const removed = next.length !== items.length;
        if (removed) this.save(next);
        return removed;
    }

    enqueueCreate({ text, tags = [], subItems = [], completed = false, tempThought }) {
        return this.enqueue({
            kind: 'create',
            method: 'POST',
            url: '/api/thoughts',
            body: { text, tags, subItems, completed },
            tempThought
        });
    }

    enqueueDeleteThought(id) {
        return this.enqueue({
            kind: 'delete',
            thoughtId: id,
            method: 'DELETE',
            url: `/api/thoughts/${encodeURIComponent(id)}`
        });
    }

    enqueueCreateRelation(thoughtId, targetId, relationType = 'manual') {
        return this.enqueue({
            kind: 'relation',
            thoughtId,
            method: 'POST',
            url: `/api/thoughts/${encodeURIComponent(thoughtId)}/relations`,
            body: { targetId, relationType }
        });
    }

    enqueueDeleteRelation(sourceId, targetId) {
        return this.enqueue({
            kind: 'relation',
            thoughtId: sourceId,
            method: 'DELETE',
            url: `/api/thoughts/${encodeURIComponent(sourceId)}/relations/${encodeURIComponent(targetId)}`
        });
    }

    mergeThoughts(thoughts) {
        let merged = Array.isArray(thoughts) ? [...thoughts] : [];
        for (const item of this.load()) {
            if (item.kind === 'create' && item.tempThought) {
                if (!merged.some(thought => thought.id === item.tempThought.id)) {
                    merged.unshift({ ...item.tempThought, localPending: true });
                }
            } else if (item.kind === 'patch' && item.localThought) {
                const index = merged.findIndex(thought => thought.id === item.thoughtId);
                if (index >= 0) {
                    merged[index] = {
                        ...merged[index],
                        ...item.localThought,
                        localPending: true,
                        syncConflict: item.state === 'conflict'
                    };
                }
            } else if (item.kind === 'delete') {
                merged = merged.filter(thought => thought.id !== item.thoughtId);
            }
        }
        return merged;
    }

    async retry(apiClient) {
        const items = this.load();
        const succeededIds = new Set();
        const failedUpdates = new Map();
        let changed = false;
        const created = [];
        const conflicts = [];
        // A patch/relation/delete that answers 404 means the Thought no longer
        // exists remotely (deleted on another device, or a pending temp id that
        // never made it to the server). Retrying it can never succeed, so the
        // item is dropped here and the caller removes the stale local copy.
        const dropped404 = [];

        for (const item of items) {
            if (item.state === 'conflict') {
                conflicts.push(item);
                continue;
            }
            try {
                const data = await apiClient.requestOutboxItem(item);
                changed = true;
                succeededIds.add(item.id);
                if (item.kind === 'create') {
                    created.push({ item, data });
                }
            } catch (err) {
                if (Number(err?.status) === 409) {
                    const conflict = {
                        ...item,
                        state: 'conflict',
                        lastError: err.message || String(err),
                        conflict: {
                            currentVersion: err.body?.currentVersion,
                            detectedAt: Date.now()
                        }
                    };
                    failedUpdates.set(item.id, conflict);
                    conflicts.push(conflict);
                    continue;
                }
                if (Number(err?.status) === 404 && item.kind !== 'create') {
                    changed = true;
                    dropped404.push(item);
                    continue;
                }
                failedUpdates.set(item.id, {
                    ...item,
                    attempts: Number(item.attempts || 0) + 1,
                    lastError: err.message || String(err)
                });
            }
        }

        // Re-load the latest outbox before saving: new items may have been
        // enqueued concurrently during the awaits above. Keep those new items,
        // drop the succeeded ones, and update the failed ones in place —
        // otherwise this.save(remaining) would overwrite storage and silently
        // delete anything queued while retry was running.
        const droppedIds = new Set(dropped404.map(item => item.id));
        const latest = this.load();
        const remaining = [];
        for (const item of latest) {
            if (succeededIds.has(item.id) || droppedIds.has(item.id)) continue;
            if (failedUpdates.has(item.id)) {
                const failed = failedUpdates.get(item.id);
                // Dead-letter: give up on permanently failing items (>10 attempts)
                // so they don't block the queue forever and retry endlessly.
                if (failed.attempts > 10) {
                    console.warn('thought-outbox: dropping item after max attempts:', failed);
                } else {
                    remaining.push(failed);
                }
            } else {
                remaining.push(item);
            }
        }
        this.save(remaining);
        return { changed, remaining, created, conflicts, dropped404 };
    }
}
