const STORAGE_KEY = 'dumbpad_today_drafts_v1';

export function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function createTodayDraft(text, now = Date.now()) {
    return {
        id: globalThis.crypto?.randomUUID?.() || `today-${now}-${Math.random().toString(36).slice(2, 8)}`,
        text: String(text || '').trim(),
        completed: false,
        version: 0,
        createdAt: now,
        updatedAt: now
    };
}

export class TodayDraftsStore {
    constructor({ storage = globalThis.localStorage, now = () => new Date() } = {}) {
        this.storage = storage;
        this.now = now;
    }

    load() {
        const day = localDayKey(this.now());
        try {
            const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
            if (saved?.day === day && Array.isArray(saved.items)) {
                return { day, items: saved.items.filter(item => String(item?.text || '').trim()) };
            }
        } catch (_error) {
            // A malformed local cache should not block a new temporary list.
        }
        const state = { day, items: [] };
        this.save(state);
        return state;
    }

    save(state) {
        const next = {
            day: localDayKey(this.now()),
            items: Array.isArray(state?.items) ? state.items : []
        };
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (_error) {
            // Temporary drafts remain usable for the open session when storage is unavailable.
        }
        return next;
    }
}

export { STORAGE_KEY };
