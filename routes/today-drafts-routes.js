const RETENTION_DAYS = 3;
const ARCHIVE_LIMIT_DEFAULT = 200;
const ARCHIVE_LIMIT_MAX = 1000;

// 即时草稿（Instant Draft）对外挂载的两条路径：改名后的规范路径在前，
// 旧名 `/api/today-drafts` 作为长期 alias 保留，避免已接入的脚本断掉。
const API_PATHS = ['/api/instant-drafts', '/api/today-drafts'];

// 同步事件同样双发：新前端认新名，缓存了旧 bundle 的客户端仍能收到更新。
const WS_EVENTS = ['instant_drafts_update', 'today_drafts_update'];

// 列表过滤：默认 `all`（保持既有行为），`today` 让「只看今天」成为服务端能力，
// 客户端不必再自己按 day 筛（窗口清理与落盘不受过滤影响）。
const DAY_FILTERS = ['today', 'all'];

function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 草稿窗口保留的日历日（今天 + 前 2 天），从旧到新排列。
// 用 setDate 而不是毫秒减法：跨夏令时的日子不是 24*3600*1000 毫秒。
function dayWindowKeys(date = new Date(), days = RETENTION_DAYS) {
    const keys = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const shifted = new Date(date);
        shifted.setDate(shifted.getDate() - offset);
        keys.push(localDayKey(shifted));
    }
    return keys;
}

function nextDayKey(date = new Date(), offset = 1) {
    const shifted = new Date(date);
    shifted.setDate(shifted.getDate() + offset);
    return localDayKey(shifted);
}

function isSafeInstantDraftId(id) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{2,95}$/.test(String(id || ''));
}

function isDayKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeInstantDraft(value, fallbackDay) {
    const id = String(value?.id || '');
    if (!isSafeInstantDraftId(id)) return null;
    const text = String(value?.text || '').trim();
    if (!text) return null;
    const createdAt = Number(value?.createdAt);
    const updatedAt = Number(value?.updatedAt);
    const version = Number(value?.version);
    return {
        id,
        text,
        completed: value?.completed === true,
        day: isDayKey(value?.day) ? String(value.day) : fallbackDay,
        version: Number.isSafeInteger(version) && version > 0 ? version : 1,
        createdAt: Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : Date.now(),
        updatedAt: Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : Date.now()
    };
}

function normalizeAndSort(items, today) {
    return items
        .map(item => normalizeInstantDraft(item, today))
        .filter(Boolean)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

// 归档条目比窗口内条目多一个 `archivedAt`；其余字段与即时草稿完全一致。
function normalizeArchivedDraft(value) {
    if (!isDayKey(value?.day)) return null;
    const draft = normalizeInstantDraft(value, String(value.day));
    if (!draft) return null;
    const archivedAt = Number(value?.archivedAt);
    return {
        ...draft,
        archivedAt: Number.isSafeInteger(archivedAt) && archivedAt > 0 ? archivedAt : draft.updatedAt
    };
}

function registerInstantDraftRoutes(app, { storage, broadcastWebSocketMessage }) {
    // 宽容窗口：考虑全球时区差异（UTC-12 到 UTC+14，时差范围最多跨 ±1 天）。
    // 客户端若处于比服务端快的时区（如东八区相较于 UTC），其本地「今天」在服务端视角为「明天」。
    // 淘汰历史草稿时保留 oldest（服务器 3 天前）；允许快时区客户端当前日 latest（服务器明天）。
    // 窗口边界只在这里定义，三个 handler 共用，避免规则漂移。
    function windowBounds(now = new Date()) {
        return {
            today: localDayKey(now),
            oldest: dayWindowKeys(now)[0],
            latest: nextDayKey(now, 1)
        };
    }

    function withinWindow(item, { oldest, latest }) {
        return Boolean(item) && isDayKey(item.day) && item.day >= oldest && item.day <= latest;
    }

    // 过期条目缺 `day`（改名前的旧数据）时按创建时间归日，实在推不出来才记今天，
    // 这样归档里的「哪一天」仍然可信，而不是统一盖成清理当天。
    function archiveDay(item, today) {
        if (isDayKey(item?.day)) return String(item.day);
        const createdAt = Number(item?.createdAt);
        return Number.isSafeInteger(createdAt) && createdAt > 0 ? localDayKey(new Date(createdAt)) : today;
    }

    // 滑出窗口的记录不再删除，而是搬进归档长期保留（界面不展示，只读归档端点可取）。
    // 归档先写、窗口文件后写：归档失败时抛给调用方，窗口文件保持原样，过期记录
    // 不会凭空消失（写操作返回 500，客户端 outbox 会重试；读操作只记日志并跳过
    // 本轮清理，下一次读写再试）。同一 id 重复归档时以后来的副本为准。
    async function archiveExpired(expired, today) {
        const normalized = expired
            .map(item => normalizeInstantDraft(item, archiveDay(item, today)))
            .filter(Boolean)
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        if (!normalized.length) return;
        const archive = await storage.readInstantDraftArchive();
        const byId = new Map();
        for (const item of Array.isArray(archive) ? archive : []) {
            if (item?.id) byId.set(String(item.id), item);
        }
        const archivedAt = Date.now();
        for (const item of normalized) byId.set(item.id, { ...item, archivedAt });
        const next = [...byId.values()]
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        await storage.saveInstantDraftArchive(next);
    }

    // 锁内读取 + 窗口切分。GET 侧把过期项归档、非法项丢弃；PUT/DELETE 在各自
    // 写回前调用 archiveExpired——切分本身不落盘，落盘节奏归调用方。
    async function readActiveItems() {
        const bounds = windowBounds();
        const all = await storage.readInstantDrafts();
        const active = [];
        const expired = [];
        for (const item of Array.isArray(all) ? all : []) {
            (withinWindow(item, bounds) ? active : expired).push(item);
        }
        return { bounds, active, expired };
    }

    async function readWindowDrafts() {
        return storage.withInstantDraftWriteLock(async () => {
            const { bounds: { today }, active, expired } = await readActiveItems();
            const items = normalizeAndSort(active, today);
            if (expired.length || items.length !== active.length) {
                try {
                    await archiveExpired(expired, today);
                    await storage.saveInstantDrafts(items);
                } catch (error) {
                    // 归档或落盘失败都不能让读请求失败，更不能丢掉过期记录：
                    // 本轮不清理，下一次读写会重新尝试。
                    console.error('Error archiving expired instant drafts:', error);
                }
            }
            return { day: today, items };
        });
    }

    function broadcast(action, draft) {
        for (const type of WS_EVENTS) {
            broadcastWebSocketMessage({ type, action, payload: draft });
        }
    }

    async function listDrafts(req, res) {
        const dayFilter = String(req.query?.day || 'all').toLowerCase();
        if (!DAY_FILTERS.includes(dayFilter)) {
            return res.status(400).json({
                error: `day must be ${DAY_FILTERS.join(', ')}`,
                code: 'INVALID_DAY_FILTER'
            });
        }
        try {
            const window = await readWindowDrafts();
            res.json(dayFilter === 'today'
                ? { ...window, items: window.items.filter(item => item.day === window.day) }
                : window);
        } catch (error) {
            console.error('Error listing instant drafts:', error);
            res.status(500).json({ error: 'Error listing instant drafts' });
        }
    }

    async function readDraft(req, res) {
        if (!isSafeInstantDraftId(req.params.id)) {
            return res.status(400).json({ error: 'Instant draft id is invalid', code: 'INVALID_INSTANT_DRAFT_ID' });
        }
        try {
            const { items } = await readWindowDrafts();
            const draft = items.find(item => item.id === req.params.id);
            if (!draft) return res.status(404).json({ error: 'Instant draft not found' });
            res.json(draft);
        } catch (error) {
            console.error('Error reading instant draft:', error);
            res.status(500).json({ error: 'Error reading instant draft' });
        }
    }

    async function upsertDraft(req, res) {
        const id = String(req.params.id || '');
        if (!isSafeInstantDraftId(id)) {
            return res.status(400).json({ error: 'Instant draft id is invalid', code: 'INVALID_INSTANT_DRAFT_ID' });
        }
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'text is required', code: 'INVALID_INSTANT_DRAFT_TEXT' });

        try {
            const result = await storage.withInstantDraftWriteLock(async () => {
                const { bounds: { today, oldest, latest }, active, expired } = await readActiveItems();
                const index = active.findIndex(item => item.id === id);
                const existing = index >= 0 ? normalizeInstantDraft(active[index], today) : null;
                const requestedVersion = Number(req.body?.baseVersion);

                if (existing && !Number.isSafeInteger(requestedVersion)) {
                    return { error: 'baseVersion is required', status: 400, code: 'BASE_VERSION_REQUIRED' };
                }
                if (existing && requestedVersion !== existing.version) {
                    return { error: 'Instant draft has been updated', status: 409, currentVersion: existing.version };
                }

                // 更新永远留在它被创建的那一天；新建可以携带客户端指定的 day
                // （离线草稿跨过午夜后才重放时，它应落回原来的日子；
                // 处于快时区的客户端本地「今天」可能为服务端「明天」），
                // 只要在 [oldest, latest] 宽容窗口内均予采纳，超出窗口才由服务端盖章今天。
                const requestedDay = isDayKey(req.body?.day) ? String(req.body.day) : null;
                const day = existing
                    ? existing.day
                    : (requestedDay && requestedDay >= oldest && requestedDay <= latest ? requestedDay : today);
                const now = Date.now();
                const draft = {
                    id,
                    text,
                    completed: req.body?.completed === undefined ? (existing?.completed || false) : req.body.completed === true,
                    day,
                    version: existing ? existing.version + 1 : 1,
                    createdAt: existing?.createdAt || now,
                    updatedAt: now
                };
                const next = active.filter(item => item.id !== id);
                next.push(draft);
                next.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
                await archiveExpired(expired, today);
                await storage.saveInstantDrafts(next);
                return { draft, created: !existing };
            });

            if (result.error) return res.status(result.status).json(result);
            broadcast(result.created ? 'create' : 'update', result.draft);
            res.status(result.created ? 201 : 200).json({ success: true, created: result.created, draft: result.draft });
        } catch (error) {
            console.error('Error saving instant draft:', error);
            res.status(500).json({ error: 'Error saving instant draft' });
        }
    }

    async function deleteDraft(req, res) {
        const id = String(req.params.id || '');
        if (!isSafeInstantDraftId(id)) {
            return res.status(400).json({ error: 'Instant draft id is invalid', code: 'INVALID_INSTANT_DRAFT_ID' });
        }
        try {
            const result = await storage.withInstantDraftWriteLock(async () => {
                const { bounds: { today }, active, expired } = await readActiveItems();
                const existing = active.find(item => item.id === id);
                if (!existing) return { error: 'Instant draft not found', status: 404 };
                const requestedVersion = Number(req.body?.baseVersion);
                if (!Number.isSafeInteger(requestedVersion)) {
                    return { error: 'baseVersion is required', status: 400, code: 'BASE_VERSION_REQUIRED' };
                }
                if (requestedVersion !== existing.version) {
                    return { error: 'Instant draft has been updated', status: 409, currentVersion: existing.version };
                }
                await archiveExpired(expired, today);
                await storage.saveInstantDrafts(active.filter(item => item.id !== id));
                return { draft: normalizeInstantDraft(existing, today) };
            });

            if (result.error) return res.status(result.status).json(result);
            broadcast('delete', result.draft);
            res.json({ success: true, deleted: true, draft: result.draft });
        } catch (error) {
            console.error('Error deleting instant draft:', error);
            res.status(500).json({ error: 'Error deleting instant draft' });
        }
    }

    // 归档只读：滑出 3 天窗口的历史草稿。界面不展示，供以后按日期/范围翻查。
    // 这是唯一的读取入口，不参与窗口清理，也不广播任何事件。
    async function listArchivedDrafts(req, res) {
        const day = String(req.query?.day || '');
        const from = String(req.query?.from || '');
        const to = String(req.query?.to || '');
        for (const value of [day, from, to]) {
            if (value && !isDayKey(value)) {
                return res.status(400).json({
                    error: 'day, from and to must be YYYY-MM-DD',
                    code: 'INVALID_ARCHIVE_FILTER'
                });
            }
        }
        const requestedLimit = Number.parseInt(req.query?.limit, 10);
        const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, ARCHIVE_LIMIT_MAX)
            : ARCHIVE_LIMIT_DEFAULT;
        try {
            const archive = await storage.readInstantDraftArchive();
            const items = (Array.isArray(archive) ? archive : [])
                .map(normalizeArchivedDraft)
                .filter(Boolean)
                .filter(item => !day || item.day === day)
                .filter(item => !from || item.day >= from)
                .filter(item => !to || item.day <= to)
                .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
            res.json({ total: items.length, items: items.slice(0, limit) });
        } catch (error) {
            console.error('Error listing archived instant drafts:', error);
            res.status(500).json({ error: 'Error listing archived instant drafts' });
        }
    }

    for (const base of API_PATHS) {
        app.get(base, listDrafts);
        // 归档路径必须注册在 `/:id` 之前：`archive` 本身也是合法草稿 id。
        app.get(`${base}/archive`, listArchivedDrafts);
        app.get(`${base}/:id`, readDraft);
        app.put(`${base}/:id`, upsertDraft);
        app.delete(`${base}/:id`, deleteDraft);
    }
}

module.exports = { localDayKey, dayWindowKeys, nextDayKey, registerInstantDraftRoutes, API_PATHS, WS_EVENTS };
