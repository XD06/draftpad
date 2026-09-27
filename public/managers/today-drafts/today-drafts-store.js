const STORAGE_KEY = 'dumbpad_today_drafts_v1';
const RETENTION_DAYS = 3;

export function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 草稿窗口保留的日历日（今天 + 前 2 天），从旧到新排列。
// 用 setDate 而不是毫秒减法：跨夏令时的日子不是 24*3600*1000 毫秒。
export function dayWindowKeys(date = new Date(), days = RETENTION_DAYS) {
    const keys = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const shifted = new Date(date);
        shifted.setDate(shifted.getDate() - offset);
        keys.push(localDayKey(shifted));
    }
    return keys;
}

export function createTodayDraft(text, now = Date.now()) {
    return {
        id: globalThis.crypto?.randomUUID?.() || `today-${now}-${Math.random().toString(36).slice(2, 8)}`,
        text: String(text || '').trim(),
        completed: false,
        day: localDayKey(new Date(now)),
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
        const nowDate = this.now();
        const today = localDayKey(nowDate);
        const windowKeys = new Set(dayWindowKeys(nowDate));
        try {
            const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
            // 整个缓存落在窗口外（例如设备闲置了一周）才全部作废；窗口内的
            // 旧单日缓存要保留，条目没有 day 时归到它缓存的那一天。
            if (saved && Array.isArray(saved.items) && windowKeys.has(saved.day)) {
                const items = saved.items
                    .filter(item => String(item?.text || '').trim())
                    .map(item => ({ ...item, day: windowKeys.has(item?.day) ? item.day : saved.day }))
                    .filter(item => windowKeys.has(item.day));
                return { day: today, items };
            }
        } catch (_error) {
            // A malformed local cache should not block a new temporary list.
        }
        const state = { day: today, items: [] };
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
