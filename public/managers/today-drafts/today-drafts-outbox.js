const DEFAULT_OUTBOX_KEY = 'dumbpad_today_drafts_outbox_v1';

function cloneDraft(draft) {
    const next = {
        id: String(draft.id),
        text: String(draft.text || ''),
        completed: draft.completed === true,
        version: Number(draft.version) || 0,
        createdAt: Number(draft.createdAt) || Date.now(),
        updatedAt: Number(draft.updatedAt) || Date.now()
    };
    // day 必须跟着进队列：离线草稿跨过午夜后才重放时，服务端要把它盖回
    // 原来的日子，而不是重放当天。
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(draft.day || ''))) next.day = String(draft.day);
    return next;
}

export default class TodayDraftsOutbox {
    constructor({ storage = window.localStorage, key = DEFAULT_OUTBOX_KEY } = {}) {
        this.storage = storage;
        this.key = key;
    }

    load() {
        try {
            const items = JSON.parse(this.storage.getItem(this.key) || '[]');
            return Array.isArray(items) ? items : [];
        } catch (error) {
            console.warn('Failed to load today drafts outbox:', error);
            return [];
        }
    }

    save(items) {
        const next = Array.isArray(items) ? items : [];
        try {
            this.storage.setItem(this.key, JSON.stringify(next));
        } catch (error) {
            console.warn('Failed to save today drafts outbox:', error);
        }
        return next;
    }

    hasPending(id) {
        return this.load().some(item => item.draftId === id);
    }

    enqueueUpsert(draft) {
        if (!draft?.id || !String(draft.text || '').trim()) return null;
        const nextDraft = cloneDraft(draft);
        const items = this.load().filter(item => item.draftId !== nextDraft.id);
        const item = {
            id: `today-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'upsert',
            draftId: nextDraft.id,
            draft: nextDraft,
            createdAt: Date.now(),
            attempts: 0
        };
        items.push(item);
        this.save(items);
        return item;
    }

    enqueueDelete(draft) {
        if (!draft?.id) return null;
        const current = this.load();
        const previous = current.find(item => item.draftId === draft.id);
        const items = current.filter(item => item.draftId !== draft.id);
        if (previous?.kind === 'upsert' && Number(previous.draft?.version) <= 0) {
            this.save(items);
            return null;
        }
        const item = {
            id: `today-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'delete',
            draftId: String(draft.id),
            draft: cloneDraft(draft),
            createdAt: Date.now(),
            attempts: 0
        };
        items.push(item);
        this.save(items);
        return item;
    }

    async replay(item, apiClient) {
        const save = async baseVersion => apiClient.put(item.draftId, {
            text: item.draft.text,
            completed: item.draft.completed,
            day: item.draft.day,
            baseVersion
        });
        const remove = async baseVersion => apiClient.delete(item.draftId, baseVersion);
        try {
            return item.kind === 'delete'
                ? { item, result: await remove(item.draft.version) }
                : { item, result: await save(item.draft.version) };
        } catch (error) {
            if (Number(error?.status) === 404 && item.kind === 'delete') {
                return { item, result: { success: true, deleted: false } };
            }
            if (Number(error?.status) !== 409) throw error;
            const current = await apiClient.get(item.draftId);
            return item.kind === 'delete'
                ? { item, result: await remove(current.version) }
                : { item, result: await save(current.version) };
        }
    }

    async retry(apiClient) {
        const attempted = this.load();
        const succeeded = new Set();
        const failures = new Map();
        const saved = [];
        for (const item of attempted) {
            try {
                const replayed = await this.replay(item, apiClient);
                succeeded.add(item.id);
                saved.push(replayed);
            } catch (error) {
                failures.set(item.id, {
                    ...item,
                    attempts: Number(item.attempts || 0) + 1,
                    lastError: error.message || String(error)
                });
            }
        }

        const latest = this.load();
        // 失败项永远留在队列（attempts 只作诊断）：静默丢弃等于丢掉用户离线
        // 输入；重试节奏由 manager 的退避计时收敛，不会因此打爆网络。
        const remaining = latest
            .filter(item => !succeeded.has(item.id))
            .map(item => failures.get(item.id) || item);
        this.save(remaining);
        return { saved, remaining };
    }
}
