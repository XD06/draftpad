const RETENTION_DAYS = 3;

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

function isSafeTodayDraftId(id) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{2,95}$/.test(String(id || ''));
}

function isDayKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeTodayDraft(value, fallbackDay) {
    const id = String(value?.id || '');
    if (!isSafeTodayDraftId(id)) return null;
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

function registerTodayDraftRoutes(app, { storage, broadcastWebSocketMessage }) {
    // 宽容窗口：考虑全球时区差异（UTC-12 到 UTC+14，时差范围最多跨 ±1 天）。
    // 客户端若处于比服务端快的时区（如东八区相较于 UTC），其本地「今天」在服务端视角为「明天」。
    // 淘汰历史草稿时保留 oldest（服务器 3 天前）；允许快时区客户端当前日 latest（服务器明天）。
    function withinWindow(item, oldest, latest) {
        return Boolean(item) && isDayKey(item.day) && item.day >= oldest && item.day <= latest;
    }

    async function readWindowDrafts() {
        const nowDate = new Date();
        const today = localDayKey(nowDate);
        const [oldest] = dayWindowKeys(nowDate);
        const latest = nextDayKey(nowDate, 1);
        return storage.withTodayDraftWriteLock(async () => {
            const all = await storage.readTodayDrafts();
            const active = all
                .filter(item => withinWindow(item, oldest, latest))
                .map(item => normalizeTodayDraft(item, today))
                .filter(Boolean)
                .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
            if (active.length !== all.length) await storage.saveTodayDrafts(active);
            return { day: today, items: active };
        });
    }

    function broadcast(action, draft) {
        broadcastWebSocketMessage({
            type: 'today_drafts_update',
            action,
            payload: draft
        });
    }

    app.get('/api/today-drafts', async (_req, res) => {
        try {
            res.json(await readWindowDrafts());
        } catch (error) {
            console.error('Error listing today drafts:', error);
            res.status(500).json({ error: 'Error listing today drafts' });
        }
    });

    app.get('/api/today-drafts/:id', async (req, res) => {
        if (!isSafeTodayDraftId(req.params.id)) {
            return res.status(400).json({ error: 'Today draft id is invalid', code: 'INVALID_TODAY_DRAFT_ID' });
        }
        try {
            const { items } = await readWindowDrafts();
            const draft = items.find(item => item.id === req.params.id);
            if (!draft) return res.status(404).json({ error: 'Today draft not found' });
            res.json(draft);
        } catch (error) {
            console.error('Error reading today draft:', error);
            res.status(500).json({ error: 'Error reading today draft' });
        }
    });

    app.put('/api/today-drafts/:id', async (req, res) => {
        const id = String(req.params.id || '');
        if (!isSafeTodayDraftId(id)) {
            return res.status(400).json({ error: 'Today draft id is invalid', code: 'INVALID_TODAY_DRAFT_ID' });
        }
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'text is required', code: 'INVALID_TODAY_DRAFT_TEXT' });

        try {
            const result = await storage.withTodayDraftWriteLock(async () => {
                const nowDate = new Date();
                const today = localDayKey(nowDate);
                const [oldest] = dayWindowKeys(nowDate);
                const latest = nextDayKey(nowDate, 1);
                const all = await storage.readTodayDrafts();
                const active = all.filter(item => withinWindow(item, oldest, latest));
                const index = active.findIndex(item => item.id === id);
                const existing = index >= 0 ? normalizeTodayDraft(active[index], today) : null;
                const requestedVersion = Number(req.body?.baseVersion);

                if (existing && !Number.isSafeInteger(requestedVersion)) {
                    return { error: 'baseVersion is required', status: 400, code: 'BASE_VERSION_REQUIRED' };
                }
                if (existing && requestedVersion !== existing.version) {
                    return { error: 'Today draft has been updated', status: 409, currentVersion: existing.version };
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
                await storage.saveTodayDrafts(next);
                return { draft, created: !existing };
            });

            if (result.error) return res.status(result.status).json(result);
            broadcast(result.created ? 'create' : 'update', result.draft);
            res.status(result.created ? 201 : 200).json({ success: true, created: result.created, draft: result.draft });
        } catch (error) {
            console.error('Error saving today draft:', error);
            res.status(500).json({ error: 'Error saving today draft' });
        }
    });

    app.delete('/api/today-drafts/:id', async (req, res) => {
        const id = String(req.params.id || '');
        if (!isSafeTodayDraftId(id)) {
            return res.status(400).json({ error: 'Today draft id is invalid', code: 'INVALID_TODAY_DRAFT_ID' });
        }
        try {
            const result = await storage.withTodayDraftWriteLock(async () => {
                const nowDate = new Date();
                const today = localDayKey(nowDate);
                const [oldest] = dayWindowKeys(nowDate);
                const latest = nextDayKey(nowDate, 1);
                const all = await storage.readTodayDrafts();
                const active = all.filter(item => withinWindow(item, oldest, latest));
                const existing = active.find(item => item.id === id);
                if (!existing) return { error: 'Today draft not found', status: 404 };
                const requestedVersion = Number(req.body?.baseVersion);
                if (!Number.isSafeInteger(requestedVersion)) {
                    return { error: 'baseVersion is required', status: 400, code: 'BASE_VERSION_REQUIRED' };
                }
                if (requestedVersion !== existing.version) {
                    return { error: 'Today draft has been updated', status: 409, currentVersion: existing.version };
                }
                await storage.saveTodayDrafts(active.filter(item => item.id !== id));
                return { draft: normalizeTodayDraft(existing, today) };
            });

            if (result.error) return res.status(result.status).json(result);
            broadcast('delete', result.draft);
            res.json({ success: true, deleted: true, draft: result.draft });
        } catch (error) {
            console.error('Error deleting today draft:', error);
            res.status(500).json({ error: 'Error deleting today draft' });
        }
    });
}

module.exports = { localDayKey, dayWindowKeys, nextDayKey, registerTodayDraftRoutes };
