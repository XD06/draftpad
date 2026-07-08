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
            attachments: Array.isArray(thought.attachments) ? thought.attachments.map(att => ({ ...att })) : []
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
                if (index >= 0) merged[index] = { ...merged[index], ...item.localThought, localPending: true };
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

        for (const item of items) {
            try {
                const data = await apiClient.requestOutboxItem(item);
                changed = true;
                succeededIds.add(item.id);
                if (item.kind === 'create') {
                    created.push({ item, data });
                }
            } catch (err) {
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
        const latest = this.load();
        const remaining = [];
        for (const item of latest) {
            if (succeededIds.has(item.id)) continue;
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
        return { changed, remaining, created };
    }
}
