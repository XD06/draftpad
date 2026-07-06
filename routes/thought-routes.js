function registerThoughtRoutes(app, context) {
    const {
        storage,
        aiQueue,
        scheduleIndexNotepads,
        broadcastWebSocketMessage
    } = context;

    async function readThoughts() {
        return storage.readThoughts();
    }

    async function saveThoughts(thoughts) {
        await storage.saveThoughts(thoughts);
    }

    async function withThoughtWriteLock(task) {
        return storage.withThoughtWriteLock(task);
    }

    function broadcastThoughtsUpdate(action, payload) {
        broadcastWebSocketMessage({
            type: 'thoughts_update',
            action,
            payload
        });
    }

    async function withRelationWriteLock(task) {
        const lock = aiQueue._private?.withRelationWriteLock;
        return typeof lock === 'function' ? lock(task) : task();
    }

    function isThoughtAIActive(thoughtId) {
        const status = typeof aiQueue.getQueueStatus === 'function' ? aiQueue.getQueueStatus() : null;
        const id = String(thoughtId || '');
        return (
            Array.isArray(status?.queuedIds) && status.queuedIds.some(item => String(item) === id)
        ) || (
            Array.isArray(status?.currentJobs) && status.currentJobs.some(job => String(job?.thoughtId) === id)
        ) || String(status?.currentJob?.thoughtId || '') === id;
    }

    function visibleAIStatus(thoughtId, meta, fallback = 'missing') {
        const status = meta?.status || fallback;
        if (status === 'pending' && !isThoughtAIActive(thoughtId)) return 'missing';
        return status;
    }

    function normalizeInsight(insight) {
        const status = ['missing', 'pending', 'ready', 'error'].includes(insight?.status)
            ? insight.status
            : 'missing';
        if (status === 'missing') return { status: 'missing' };
        return {
            status,
            markdown: String(insight?.markdown || ''),
            generatedAt: insight?.generatedAt || 0,
            updatedAt: insight?.updatedAt || 0,
            requestedAt: insight?.requestedAt || 0,
            model: insight?.model || null,
            contextIds: Array.isArray(insight?.contextIds) ? insight.contextIds : [],
            error: insight?.error || null
        };
    }

    function createThoughtId(existingThoughts = []) {
        const existingIds = new Set(existingThoughts.map(thought => String(thought.id)));
        let id = '';
        do {
            id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        } while (existingIds.has(id));
        return id;
    }

    async function removeSuppressedPair(id, targetId) {
        const sourceSuppressed = await storage.readSuppressedRelations(id);
        sourceSuppressed.edges = (sourceSuppressed.edges || []).filter(edge => edge.targetId !== targetId);
        await storage.writeSuppressedRelations(id, sourceSuppressed);

        const targetSuppressed = await storage.readSuppressedRelations(targetId);
        targetSuppressed.edges = (targetSuppressed.edges || []).filter(edge => edge.targetId !== id);
        await storage.writeSuppressedRelations(targetId, targetSuppressed);
    }

    function upsertManualEdge(relations, targetId, relationType = 'manual') {
        const now = Date.now();
        const suggestion = Array.isArray(relations.suggestions)
            ? relations.suggestions.find(edge => edge.targetId === targetId)
            : null;
        const edges = Array.isArray(relations.edges) ? relations.edges.filter(edge => edge.targetId !== targetId) : [];
        const suggestions = Array.isArray(relations.suggestions)
            ? relations.suggestions.filter(edge => edge.targetId !== targetId)
            : [];
        const preservedRelationType = suggestion?.relationType && ['manual', 'suggested'].includes(relationType)
            ? suggestion.relationType
            : relationType;
        edges.unshift({
            targetId,
            score: Number.isFinite(Number(suggestion?.score)) ? Number(suggestion.score) : 1,
            confidence: Number.isFinite(Number(suggestion?.confidence)) ? Number(suggestion.confidence) : 1,
            relationType: preservedRelationType,
            method: 'manual',
            source: 'manual',
            reasons: Array.isArray(suggestion?.reasons) && suggestion.reasons.length > 0 ? suggestion.reasons : [],
            signals: suggestion?.signals ? { ...suggestion.signals, manual: 1 } : { manual: 1 },
            createdAt: now
        });
        return {
            id: relations.id,
            edges,
            suggestions,
            version: 2,
            computedAt: now
        };
    }

    app.get('/api/thoughts/:id/relations', async (req, res) => {
        try {
            const { id } = req.params;
            const thought = await storage.readThought(id);
            if (!thought) {
                return res.json({
                    id,
                    status: 'missing',
                    relations: []
                });
            }

            const meta = await storage.readThoughtMeta(id);
            const relations = await storage.readRelations(id);
            const responseRelations = [];
            const responseSuggestions = [];

            async function edgeToResponse(edge) {
                const target = await storage.readThought(edge.targetId);
                if (!target) return null;
                return {
                    thought: {
                        id: target.id,
                        text: target.text || '',
                        tags: Array.isArray(target.tags) ? target.tags : [],
                        completed: !!target.completed,
                        createdAt: target.createdAt || 0
                    },
                    score: edge.score || 0,
                    confidence: edge.confidence || 0,
                    relationType: edge.relationType || '',
                    method: edge.method || 'unknown',
                    reasons: Array.isArray(edge.reasons) ? edge.reasons : [],
                    signals: edge.signals || null
                };
            }

            const [resolvedRelations, resolvedSuggestions] = await Promise.all([
                Promise.all((relations.edges || []).map(edgeToResponse)),
                Promise.all((relations.suggestions || []).map(edgeToResponse))
            ]);

            for (const item of resolvedRelations) {
                if (item) responseRelations.push(item);
            }
            for (const item of resolvedSuggestions) {
                if (item) responseSuggestions.push(item);
            }

            res.json({
                id,
                status: visibleAIStatus(id, meta),
                relations: responseRelations,
                suggestions: responseSuggestions
            });
        } catch (err) {
            console.error('Error fetching thought relations:', err);
            res.status(500).json({ error: 'Error fetching thought relations' });
        }
    });

    app.delete('/api/thoughts/:id/relations/:targetId', async (req, res) => {
        try {
            const { id, targetId } = req.params;
            const result = await withRelationWriteLock(async () => {
                const relations = await storage.readRelations(id);
                const originalLength = Array.isArray(relations.edges) ? relations.edges.length : 0;
                relations.edges = (relations.edges || []).filter(edge => edge.targetId !== targetId);
                relations.suggestions = (relations.suggestions || []).filter(edge => edge.targetId !== targetId);
                relations.computedAt = Date.now();
                await storage.writeRelations(id, relations);

                const reverse = await storage.readRelations(targetId);
                reverse.edges = (reverse.edges || []).filter(edge => edge.targetId !== id);
                reverse.suggestions = (reverse.suggestions || []).filter(edge => edge.targetId !== id);
                reverse.computedAt = Date.now();
                await storage.writeRelations(targetId, reverse);
                await storage.suppressRelation(id, targetId);
                await storage.suppressRelation(targetId, id);

                return {
                    success: true,
                    removed: relations.edges.length !== originalLength,
                    relationCount: relations.edges.length,
                    targetRelationCount: reverse.edges.length
                };
            });
            broadcastWebSocketMessage({
                type: 'relations_update',
                thoughtId: id,
                relationsCount: result.relationCount
            });
            broadcastWebSocketMessage({
                type: 'relations_update',
                thoughtId: targetId,
                relationsCount: result.targetRelationCount
            });
            res.json(result);
        } catch (err) {
            console.error('Error deleting thought relation:', err);
            res.status(500).json({ error: 'Error deleting thought relation' });
        }
    });

    app.post('/api/thoughts/:id/relations', async (req, res) => {
        try {
            const { id } = req.params;
            const targetId = String(req.body?.targetId || '').trim();
            const relationType = String(req.body?.relationType || 'manual').trim() || 'manual';
            if (!targetId) return res.status(400).json({ error: 'targetId is required' });
            if (targetId === id) return res.status(400).json({ error: 'Cannot link a thought to itself' });

            const sourceThought = await storage.readThought(id);
            const targetThought = await storage.readThought(targetId);
            if (!sourceThought || !targetThought) return res.status(404).json({ error: 'Thought not found' });

            const { sourceRelations, targetRelations } = await withRelationWriteLock(async () => {
                const sourceRelations = upsertManualEdge(await storage.readRelations(id), targetId, relationType);
                const targetRelations = upsertManualEdge(await storage.readRelations(targetId), id, relationType);
                await storage.writeRelations(id, sourceRelations);
                await storage.writeRelations(targetId, targetRelations);
                await removeSuppressedPair(id, targetId);
                return { sourceRelations, targetRelations };
            });

            broadcastWebSocketMessage({
                type: 'relations_update',
                thoughtId: id,
                relationsCount: sourceRelations.edges.length
            });
            broadcastWebSocketMessage({
                type: 'relations_update',
                thoughtId: targetId,
                relationsCount: targetRelations.edges.length
            });

            res.status(201).json({
                success: true,
                relation: sourceRelations.edges.find(edge => edge.targetId === targetId),
                relationCount: sourceRelations.edges.length,
                targetRelationCount: targetRelations.edges.length
            });
        } catch (err) {
            console.error('Error creating manual thought relation:', err);
            res.status(500).json({ error: 'Error creating manual thought relation' });
        }
    });

    app.post('/api/thoughts/:id/ai-process', async (req, res) => {
        const { id } = req.params;
        const thought = await storage.readThought(id);
        if (!thought) return res.status(404).json({ error: 'Thought not found' });

        console.info(`[thought-ai] queue reason=manual thoughtId=${id}`);
        aiQueue.queueThought(id, 'manual');
        res.status(202).json({ queued: true, id });
    });

    app.post('/api/thoughts/:id/ai-insight', async (req, res) => {
        try {
            const { id } = req.params;
            const thought = await storage.readThought(id);
            if (!thought) return res.status(404).json({ error: 'Thought not found' });

            console.info(`[thought-ai] insight reason=manual thoughtId=${id}`);
            if (typeof aiQueue.isInsightReady === 'function' && !aiQueue.isInsightReady()) {
                const provider = typeof aiQueue.getInsightProviderStatus === 'function'
                    ? aiQueue.getInsightProviderStatus()
                    : null;
                console.info(`[thought-ai] insight skipped thoughtId=${id} reason=${provider?.reason || 'not-ready'} model=${provider?.model || 'not-configured'}`);
                return res.status(503).json({
                    error: provider?.reason === 'same-as-chat-model'
                        ? 'AI insight model must be configured separately from AI chat model'
                        : 'AI insight model is not configured',
                    provider
                });
            }

            const insight = await aiQueue.generateThoughtInsight(id);
            if (!insight) return res.status(404).json({ error: 'Thought not found' });
            res.json({
                success: true,
                insight: normalizeInsight(insight)
            });
        } catch (err) {
            console.error('Error generating thought AI insight:', err);
            if (err.code === 'AI_INSIGHT_NOT_CONFIGURED') {
                return res.status(503).json({ error: err.message, provider: err.provider || null });
            }
            res.status(500).json({
                error: 'Error generating thought AI insight',
                message: err.message,
                insight: normalizeInsight(err.insight)
            });
        }
    });

    app.post('/api/thoughts/ai-backfill', async (req, res) => {
        try {
            const limit = Number(req.body?.limit);
            const result = await aiQueue.backfillMissingMeta({
                limit: Number.isFinite(limit) && limit > 0 ? limit : Infinity
            });
            res.status(202).json(result);
        } catch (err) {
            console.error('Error queueing AI backfill:', err);
            res.status(500).json({ error: 'Error queueing AI backfill' });
        }
    });

    app.post('/api/thoughts/relations-rebuild', async (req, res) => {
        try {
            const limit = Number(req.body?.limit);
            const result = await aiQueue.rebuildRelations({
                limit: Number.isFinite(limit) && limit > 0 ? limit : Infinity
            });
            res.status(202).json(result);
        } catch (err) {
            console.error('Error rebuilding thought relations:', err);
            res.status(500).json({ error: 'Error rebuilding thought relations' });
        }
    });

    app.get('/api/thoughts/ai-queue/status', async (req, res) => {
        try {
            res.json(aiQueue.getQueueStatus());
        } catch (err) {
            console.error('Error fetching AI queue status:', err);
            res.status(500).json({ error: 'Error fetching AI queue status' });
        }
    });

    app.get('/api/thoughts/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const thoughts = await readThoughts();
            const thought = thoughts.find(t => t.id === id);
            if (!thought) return res.status(404).json({ error: 'Thought not found' });
            res.json(thought);
        } catch (err) {
            res.status(500).json({ error: 'Error fetching thought' });
        }
    });

    app.get('/api/thoughts', async (req, res) => {
        try {
            const { q, date, tag } = req.query;
            const light = req.query.light === '1' || req.query.light === 'true';
            const rawLimit = Number.parseInt(req.query.limit, 10);
            const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 0;
            let thoughts = await readThoughts();

            if (tag) {
                const tagLower = tag.toLowerCase();
                thoughts = thoughts.filter(t => t.tags && t.tags.some(tg => tg.toLowerCase() === tagLower));
            }

            if (q) {
                const query = q.toLowerCase();
                thoughts = thoughts.filter(t => {
                    if (t.text.toLowerCase().includes(query)) return true;
                    if (t.subItems && t.subItems.some(s => s.text.toLowerCase().includes(query))) return true;
                    return false;
                });
            }

            if (date) {
                thoughts = thoughts.filter(t => {
                    const d = new Date(t.createdAt);
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    const dateStr = `${year}-${month}-${day}`;
                    return dateStr === date;
                });
            }

            if (limit) {
                thoughts = thoughts.slice(0, limit);
            }

            if (light) {
                return res.json(thoughts.map(thought => ({
                    id: thought.id,
                    text: thought.text || '',
                    subItems: Array.isArray(thought.subItems) ? thought.subItems : [],
                    tags: Array.isArray(thought.tags) ? thought.tags : [],
                    completed: thought.completed === true,
                    createdAt: thought.createdAt || 0,
                    updatedAt: thought.updatedAt || thought.createdAt || 0
                })));
            }

            // Optimisation: only fetch meta for thoughts whose AI status is
            // "pending" or "missing" (to check if processing has finished).
            // For thoughts that are already "ready" or "error", we trust the
            // aiStatus / aiError / aiProcessedAt / aiTags fields already
            // stored on the thought object — they are kept up-to-date by PATCH
            // and WebSocket pushes.  This avoids N meta file reads per list
            // request while still reading relation counts from source of truth.
            const pendingIds = new Set(
                thoughts
                    .filter(t => t.aiStatus === 'pending' || !t.aiStatus || t.aiStatus === 'missing')
                    .map(t => t.id)
            );

            const thoughtsWithRelationCounts = await Promise.all(thoughts.map(async (thought) => {
                const relationCount = await storage.readRelationCount(thought.id);
                if (!pendingIds.has(thought.id)) {
                    return {
                        ...thought,
                        relationCount,
                        aiStatus: visibleAIStatus(thought.id, { status: thought.aiStatus }, thought.aiStatus || 'missing'),
                        aiError: thought.aiError || null,
                        aiProcessedAt: thought.aiProcessedAt || 0,
                        aiTags: Array.isArray(thought.aiTags) ? thought.aiTags : []
                    };
                }
                const meta = await storage.readThoughtMeta(thought.id);
                return {
                    ...thought,
                    relationCount,
                    aiStatus: visibleAIStatus(thought.id, meta, thought.aiStatus || 'missing'),
                    aiError: meta?.error || thought.aiError || null,
                    aiProcessedAt: meta?.ai?.processedAt || 0,
                    aiTags: Array.isArray(meta?.ai?.tags) ? meta.ai.tags : (thought.aiTags || [])
                };
            }));

            res.json(thoughtsWithRelationCounts);
        } catch (err) {
            res.status(500).json({ error: 'Error fetching thoughts' });
        }
    });

    app.post('/api/thoughts', async (req, res) => {
        try {
            const { text, subItems, tags, completed } = req.body;
            if (!text) return res.status(400).json({ error: 'Text is required' });

            const newThought = await withThoughtWriteLock(async () => {
                const thoughts = await readThoughts();
                const now = Date.now();
                const thought = {
                    id: createThoughtId(thoughts),
                    text,
                    subItems: subItems || [],
                    tags: tags || [],
                    completed: completed === true,
                    relationCount: 0,
                    aiStatus: 'pending',
                    version: 1,
                    createdAt: now,
                    updatedAt: now
                };

                thoughts.unshift(thought);
                await saveThoughts(thoughts);
                return thought;
            });

            scheduleIndexNotepads(250);
            broadcastThoughtsUpdate('create', newThought);
            console.info(`[thought-ai] queue reason=create thoughtId=${newThought.id}`);
            aiQueue.queueThought(newThought.id, 'create');
            res.json(newThought);
        } catch (err) {
            res.status(500).json({ error: 'Error creating thought' });
        }
    });

    app.get('/api/thoughts/:id/ai-status', async (req, res) => {
        try {
            const { id } = req.params;
            const thought = await storage.readThought(id);
            if (!thought) return res.status(404).json({ error: 'Thought not found' });

            const meta = await storage.readThoughtMeta(id);
            const relations = await storage.readRelations(id);
            const relationEdges = Array.isArray(relations.edges) ? relations.edges : [];
            const relationSuggestions = Array.isArray(relations.suggestions) ? relations.suggestions : [];
            const stages = meta?.stages || {
                queued: { status: meta ? 'ready' : 'missing' },
                analysis: { status: meta?.status === 'ready' ? 'ready' : (meta?.status || 'missing') },
                embedding: { status: meta?.status === 'ready' ? 'ready' : (meta?.status || 'missing') },
                relations: relations?.diagnostics?.status ? { status: relations.diagnostics.status } : { status: 'missing' }
            };
            res.json({
                id,
                status: visibleAIStatus(id, meta),
                error: meta?.error || null,
                processedAt: meta?.ai?.processedAt || 0,
                relationCount: relationEdges.length,
                suggestionCount: relationSuggestions.length,
                aiTags: Array.isArray(meta?.ai?.tags) ? meta.ai.tags : [],
                stages,
                models: {
                    extract: meta?.ai?.extractModel || stages.analysis?.model || null,
                    embedding: meta?.ai?.model || stages.embedding?.model || null,
                    rerank: stages.relations?.model || null,
                    insight: meta?.insight?.model || null
                },
                insight: normalizeInsight(meta?.insight),
                diagnostics: relations?.diagnostics || null
            });
        } catch (err) {
            console.error('Error fetching thought AI status:', err);
            res.status(500).json({ error: 'Error fetching thought AI status' });
        }
    });

    app.patch('/api/thoughts/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { action, text, target, replacement, baseVersion } = req.body;

            const result = await withThoughtWriteLock(async () => {
                const thoughts = await readThoughts();
                const index = thoughts.findIndex(t => t.id === id);

                if (index === -1) return { status: 404, body: { error: 'Thought not found' } };

                const thought = thoughts[index];
                const clientVersion = Number(baseVersion);
                if (Number.isFinite(clientVersion) && (thought.version || 1) > clientVersion) {
                    return {
                        status: 409,
                        body: {
                            error: 'Thought has been updated on another device',
                            currentVersion: thought.version || 1
                        }
                    };
                }
                let modified = false;

                switch (action) {
                    case 'toggle_complete':
                        thought.completed = !thought.completed;
                        modified = true;
                        break;
                    case 'append':
                        if (text) {
                            thought.text += text;
                            modified = true;
                        }
                        break;
                    case 'replace':
                        if (target && thought.text.includes(target)) {
                            thought.text = thought.text.split(target).join(replacement || '');
                            modified = true;
                        }
                        break;
                    case 'overwrite':
                        if (text !== undefined) { thought.text = text; modified = true; }
                        if (req.body.subItems !== undefined) { thought.subItems = req.body.subItems; modified = true; }
                        if (req.body.tags !== undefined) { thought.tags = req.body.tags; modified = true; }
                        if (req.body.completed !== undefined) { thought.completed = req.body.completed === true; modified = true; }
                        break;
                    case 'add_subitem':
                        if (!text) return { status: 400, body: { error: 'Subitem text is required' } };
                        thought.subItems.push({
                            id: Date.now().toString(),
                            text,
                            completed: false
                        });
                        modified = true;
                        break;
                    case 'toggle_subitem': {
                        const sub = thought.subItems.find(s => s.id === req.body.subId);
                        if (!sub) return { status: 404, body: { error: 'Subitem not found' } };
                        sub.completed = !sub.completed;
                        modified = true;
                        break;
                    }
                    case 'update_subitem': {
                        const sub = thought.subItems.find(s => s.id === req.body.subId);
                        if (!sub) return { status: 404, body: { error: 'Subitem not found' } };
                        if (text !== undefined) sub.text = text;
                        if (req.body.completed !== undefined) sub.completed = req.body.completed;
                        modified = true;
                        break;
                    }
                    case 'delete_subitem': {
                        const idx = thought.subItems.findIndex(s => s.id === req.body.subId);
                        if (idx === -1) return { status: 404, body: { error: 'Subitem not found' } };
                        thought.subItems.splice(idx, 1);
                        modified = true;
                        break;
                    }
                    default:
                        return { status: 400, body: { error: 'Invalid action' } };
                }

                if (modified) {
                    thought.updatedAt = Date.now();
                    thought.version = (thought.version || 1) + 1;
                    const meta = await storage.readThoughtMeta(thought.id);
                    thought.aiStatus = visibleAIStatus(thought.id, meta, thought.aiStatus || 'missing');
                    thought.aiError = meta?.error || null;
                    thought.relationCount = await storage.readRelationCount(thought.id);
                    await saveThoughts(thoughts);
                }

                return { status: 200, body: { success: true, thought }, thought, modified };
            });

            if (result.status !== 200) {
                return res.status(result.status).json(result.body);
            }

            if (result.modified) {
                scheduleIndexNotepads(250);
                broadcastThoughtsUpdate('update', result.thought);
            }
            res.json(result.body);
        } catch (err) {
            res.status(500).json({ error: 'Error updating thought' });
        }
    });

    app.delete('/api/thoughts/:id', async (req, res) => {
        try {
            const { id } = req.params;

            const result = await withThoughtWriteLock(async () => {
                let thoughts = await readThoughts();
                const thoughtToDelete = thoughts.find(t => t.id === id);
                const initialLen = thoughts.length;
                thoughts = thoughts.filter(t => t.id !== id);

                if (thoughts.length === initialLen) return null;

                const trashItem = await storage.moveThoughtToTrash(thoughtToDelete);
                await saveThoughts(thoughts);
                return { trashItem, thoughtToDelete };
            });

            if (!result) {
                return res.status(404).json({ error: 'Thought not found' });
            }

            const relationCleanup = await withRelationWriteLock(async () => {
                await storage.deleteThoughtMeta(id);
                await storage.deleteRelations(id);
                await storage.deleteSuppressedRelations(id);
                const cleanup = await storage.removeRelationReferences(id);
                await storage.removeSuppressedRelationReferences(id);
                return cleanup;
            });
            scheduleIndexNotepads(250);
            broadcastThoughtsUpdate('delete', { id });
            const affectedRelationIds = Array.isArray(relationCleanup?.affectedIds) ? relationCleanup.affectedIds : [];
            for (const affectedId of affectedRelationIds) {
                broadcastWebSocketMessage({
                    type: 'relations_update',
                    thoughtId: affectedId,
                    relationsCount: await storage.readRelationCount(affectedId)
                });
            }
            res.json({ success: true, trashItem: result.trashItem });
        } catch (err) {
            res.status(500).json({ error: 'Error deleting thought' });
        }
    });
}

module.exports = { registerThoughtRoutes };
