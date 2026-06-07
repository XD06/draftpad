function registerTrashRoutes(app, context) {
    const {
        storage,
        scheduleIndexNotepads,
        broadcastWebSocketMessage
    } = context;

    function broadcastThoughtsUpdate(action, payload) {
        broadcastWebSocketMessage({
            type: 'thoughts_update',
            action,
            payload
        });
    }

    app.get('/api/trash', async (_req, res) => {
        try {
            res.json({
                items: await storage.listTrashItems()
            });
        } catch (err) {
            console.error('Error reading trash:', err);
            res.status(500).json({ error: 'Error reading trash' });
        }
    });

    app.get('/api/trash/:trashId', async (req, res) => {
        try {
            const item = await storage.getTrashItem(req.params.trashId);
            if (!item) return res.status(404).json({ error: 'Trash item not found' });
            res.json(item);
        } catch (err) {
            console.error('Error reading trash item:', err);
            res.status(500).json({ error: 'Error reading trash item' });
        }
    });

    app.post('/api/trash/:trashId/restore', async (req, res) => {
        try {
            const restored = await storage.restoreTrashItem(req.params.trashId);
            if (!restored) return res.status(404).json({ error: 'Trash item not found' });

            scheduleIndexNotepads(250);
            if (restored.type === 'notepad') {
                broadcastWebSocketMessage({
                    type: 'notepad_change',
                    action: 'restore',
                    notepadId: restored.item.id,
                    notepadName: restored.item.name
                });
            } else if (restored.type === 'thought') {
                broadcastThoughtsUpdate('create', restored.item);
                const affectedRelationIds = Array.isArray(restored.affectedRelationIds) ? restored.affectedRelationIds : [];
                for (const thoughtId of affectedRelationIds) {
                    broadcastWebSocketMessage({
                        type: 'relations_update',
                        thoughtId,
                        relationsCount: await storage.readRelationCount(thoughtId)
                    });
                }
            }

            res.json({ success: true, restored });
        } catch (err) {
            console.error('Error restoring trash item:', err);
            res.status(500).json({ error: 'Error restoring trash item' });
        }
    });

    app.delete('/api/trash/:trashId', async (req, res) => {
        try {
            const deleted = await storage.deleteTrashItem(req.params.trashId);
            if (!deleted) return res.status(404).json({ error: 'Trash item not found' });
            res.json({ success: true });
        } catch (err) {
            console.error('Error deleting trash item:', err);
            res.status(500).json({ error: 'Error deleting trash item' });
        }
    });

    app.delete('/api/trash', async (_req, res) => {
        try {
            res.json(await storage.emptyTrash());
        } catch (err) {
            console.error('Error emptying trash:', err);
            res.status(500).json({ error: 'Error emptying trash' });
        }
    });
}

module.exports = { registerTrashRoutes };
