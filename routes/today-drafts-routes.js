function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isSafeTodayDraftId(id) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{2,95}$/.test(String(id || ''));
}

function normalizeTodayDraft(value, day) {
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
        day,
        version: Number.isSafeInteger(version) && version > 0 ? version : 1,
        createdAt: Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : Date.now(),
        updatedAt: Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : Date.now()
    };
}

function registerTodayDraftRoutes(app, { storage, broadcastWebSocketMessage }) {
    async function readCurrentDayDrafts() {
        const day = localDayKey();
        return storage.withTodayDraftWriteLock(async () => {
            const all = await storage.readTodayDrafts();
            const active = all
                .filter(item => item && item.day === day)
                .map(item => normalizeTodayDraft(item, day))
                .filter(Boolean)
                .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
            if (active.length !== all.length) await storage.saveTodayDrafts(active);
            return { day, items: active };
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
            res.json(await readCurrentDayDrafts());
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
            const { items } = await readCurrentDayDrafts();
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
                const day = localDayKey();
                const all = await storage.readTodayDrafts();
                const active = all.filter(item => item && item.day === day);
                const index = active.findIndex(item => item.id === id);
                const existing = index >= 0 ? normalizeTodayDraft(active[index], day) : null;
                const requestedVersion = Number(req.body?.baseVersion);

                if (existing && !Number.isSafeInteger(requestedVersion)) {
                    return { error: 'baseVersion is required', status: 400, code: 'BASE_VERSION_REQUIRED' };
                }
                if (existing && requestedVersion !== existing.version) {
                    return { error: 'Today draft has been updated', status: 409, currentVersion: existing.version };
                }

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
                const day = localDayKey();
                const all = await storage.readTodayDrafts();
                const active = all.filter(item => item && item.day === day);
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
                return { draft: normalizeTodayDraft(existing, day) };
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

module.exports = { localDayKey, registerTodayDraftRoutes };
