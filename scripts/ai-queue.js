const { createDefaultProvider } = require('./ai-provider');
const { findCandidates } = require('./relations-calculator');

let storage;
let aiProvider;
let broadcast = () => {};
let processing = false;
let currentJob = null;
let currentJobs = [];
let lastError = null;
const queue = [];
const queuedIds = new Set();
const LOCAL_CANDIDATE_LIMIT = 30;
const LLM_RERANK_CANDIDATE_LIMIT = 8;
const FINAL_RELATION_LIMIT = 8;
const FINAL_RELATION_THRESHOLD = 0.72;
const SUGGESTED_RELATION_LIMIT = 6;
const SUGGESTED_RELATION_THRESHOLD = 0.62;
const DEFAULT_PENDING_RECOVERY_MS = Number(process.env.AI_PENDING_RECOVERY_MS || 120000);
const DEFAULT_QUEUE_CONCURRENCY = Math.max(1, Number(process.env.AI_QUEUE_CONCURRENCY || 3));
let relationWriteLock = Promise.resolve();

function logAI(event, details = {}) {
    const payload = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    console.info(`[ai-queue ${new Date().toISOString()}] ${event}${payload ? ` ${payload}` : ''}`);
}

function init(options = {}) {
    storage = options.storage || require('./storage');
    aiProvider = options.aiProvider || createDefaultProvider();
    broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => {};
    relationWriteLock = Promise.resolve();
    logAI('provider:init', {
        provider: aiProvider.constructor?.name || 'unknown',
        chatModel: aiProvider.chatModel || 'noop',
        embeddingModel: aiProvider.embeddingModel || 'noop',
        rerankModel: aiProvider.rerankModel || 'noop',
        hasReranker: Boolean(aiProvider.rerankBaseUrl && aiProvider.rerankApiKey)
    });
}

function ensureInitialized() {
    if (!storage || !aiProvider) init();
}

async function writePendingMeta(thoughtId, reason = 'process') {
    if (!thoughtId) return null;
    const meta = {
        id: thoughtId,
        status: 'pending',
        ai: null,
        schemaVersion: 2,
        queuedReason: reason,
        queuedAt: Date.now(),
        stages: {
            queued: { status: 'ready', at: Date.now(), reason },
            analysis: { status: 'pending' },
            embedding: { status: 'pending' },
            relations: { status: 'pending' }
        },
        error: null
    };
    await storage.writeThoughtMeta(thoughtId, meta);
    logAI('pending', { thoughtId, reason });
    broadcast({
        type: 'ai_status_update',
        thoughtId,
        status: 'pending',
        reason
    });
    return meta;
}

function thoughtText(thought) {
    const parts = [thought?.text || ''];
    if (Array.isArray(thought?.subItems)) {
        for (const item of thought.subItems) {
            if (item?.text) parts.push(item.text);
        }
    }
    if (Array.isArray(thought?.tags)) {
        parts.push(thought.tags.join(' '));
    }
    return parts.join('\n').trim();
}

function normalizeExtraction(extracted = {}) {
    const array = (value, limit) => (
        Array.isArray(value)
            ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit)
            : []
    );
    const intent = String(extracted.intent || '').trim().toLowerCase();
    const timeScope = String(extracted.timeScope || '').trim().toLowerCase();

    return {
        summary: String(extracted.summary || '').trim(),
        entities: array(extracted.entities, 10),
        topics: array(extracted.topics, 8),
        intent: ['question', 'idea', 'task', 'plan', 'note', 'decision', 'risk', 'conclusion'].includes(intent) ? intent : 'note',
        keywords: array(extracted.keywords, 12),
        timeScope: ['now', 'later', 'someday', 'reference'].includes(timeScope) ? timeScope : 'reference',
        tags: array(extracted.tags, 6)
    };
}

function thoughtSummary(thought) {
    if (!thought) return null;
    return {
        id: thought.id,
        text: String(thought.text || '').slice(0, 300),
        tags: Array.isArray(thought.tags) ? thought.tags : [],
        completed: !!thought.completed,
        createdAt: thought.createdAt || 0,
        updatedAt: thought.updatedAt || 0
    };
}

function userTagVocabulary(thoughts = []) {
    const tags = new Map();
    for (const thought of thoughts) {
        for (const rawTag of Array.isArray(thought?.tags) ? thought.tags : []) {
            const tag = String(rawTag || '').trim();
            if (!tag) continue;
            const key = tag.toLowerCase();
            if (!tags.has(key)) tags.set(key, tag);
        }
    }
    return Array.from(tags.values()).slice(0, 80);
}

function localRelationType(candidate) {
    const parts = candidate.parts || {};
    if (parts.intent > 0 && parts.entity > 0) return 'supports';
    if (parts.entity > 0) return 'same_project';
    if (parts.topic > 0) return 'same_topic';
    return 'related_context';
}

function localRerankFallback(candidates) {
    return candidates.map(candidate => ({
        targetId: candidate.meta.id,
        score: candidate.score,
        confidence: candidate.score,
        relationType: localRelationType(candidate),
        reasons: [
            ...(candidate.parts.entity > 0 ? ['entity'] : []),
            ...(candidate.parts.topic > 0 ? ['topic'] : []),
            ...(candidate.parts.intent > 0 ? ['intent'] : []),
            ...(candidate.parts.keyword > 0 ? ['keyword'] : []),
            ...(candidate.parts.tag > 0 ? ['tag'] : []),
            ...(candidate.parts.vector > 0 ? ['vector'] : [])
        ].slice(0, 4)
    }));
}

async function syncReverseRelations(sourceId, nextEdges = []) {
    if (!sourceId || typeof storage?.readRelations !== 'function' || typeof storage?.writeRelations !== 'function') return;

    const previous = await storage.readRelations(sourceId);
    const previousTargetIds = new Set((previous.edges || []).map(edge => edge.targetId).filter(Boolean));
    const nextTargetIds = new Set(nextEdges.map(edge => edge.targetId).filter(Boolean));
    const affectedTargetIds = new Set([...previousTargetIds, ...nextTargetIds]);
    let addedOrUpdated = 0;
    let removed = 0;

    for (const targetId of affectedTargetIds) {
        const targetRelations = await storage.readRelations(targetId);
        const existingEdges = Array.isArray(targetRelations.edges) ? targetRelations.edges : [];
        const nextSourceEdge = nextEdges.find(edge => edge.targetId === targetId);
        const previousReverse = existingEdges.find(edge => edge.targetId === sourceId);
        const keptEdges = existingEdges.filter(edge => edge.targetId !== sourceId);

        if (nextSourceEdge) {
            keptEdges.push({
                ...nextSourceEdge,
                targetId: sourceId,
                createdAt: previousReverse?.createdAt || nextSourceEdge.createdAt || Date.now()
            });
            addedOrUpdated++;
        } else if (previousReverse) {
            removed++;
        }

        if (nextSourceEdge || previousReverse) {
            await storage.writeRelations(targetId, {
                ...targetRelations,
                id: targetId,
                edges: keptEdges.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)),
                version: 2,
                computedAt: Date.now()
            });
        }
    }

    logAI('relations:reverse-sync', {
        thoughtId: sourceId,
        targets: affectedTargetIds.size,
        addedOrUpdated,
        removed
    });
}

async function withRelationWriteLock(task) {
    const run = relationWriteLock.then(task, task);
    relationWriteLock = run.catch(() => {});
    return run;
}

function isManualRelation(edge) {
    return edge?.source === 'manual' || edge?.method === 'manual';
}

function relationEdgeFromRerankItem(item, candidate) {
    const score = Number.isFinite(item.score) ? item.score : candidate.score;
    return {
        targetId: item.targetId,
        score,
        confidence: Number.isFinite(item.confidence) ? item.confidence : score,
        relationType: item.relationType || localRelationType(candidate),
        method: candidate.method,
        reasons: Array.isArray(item.reasons) && item.reasons.length
            ? item.reasons
            : localRerankFallback([candidate])[0].reasons,
        signals: candidate.signals || candidate.parts,
        createdAt: Date.now()
    };
}

async function buildRelations(currentMeta) {
    const startedAt = Date.now();
    const diagnostics = {
        status: 'pending',
        candidateCount: 0,
        scoredCount: 0,
        returnedCount: 0,
        rerankScore: 'skipped',
        rerankJudge: 'pending',
        errors: []
    };
    const thoughts = await storage.readThoughts();
    const suppressed = await storage.readSuppressedRelations(currentMeta.id);
    const suppressedTargetIds = new Set((suppressed.edges || []).map(edge => edge.targetId));
    const metas = [];
    const thoughtsById = new Map();

    for (const thought of thoughts) {
        if (thought?.id) thoughtsById.set(thought.id, thought);
        if (!thought?.id || thought.id === currentMeta.id) continue;
        if (suppressedTargetIds.has(thought.id)) continue;
        const meta = await storage.readThoughtMeta(thought.id);
        if (meta?.status === 'ready' && meta.ai) {
            metas.push({
                ...meta,
                thought: thoughtSummary(thought)
            });
        }
    }

    const candidates = findCandidates(currentMeta, metas, {
        threshold: 0.25,
        limit: LOCAL_CANDIDATE_LIMIT
    });
    logAI('relations:candidates', {
        thoughtId: currentMeta.id,
        readyMetas: metas.length,
        candidates: candidates.length
    });
    diagnostics.candidateCount = candidates.length;
    const source = {
        id: currentMeta.id,
        ai: currentMeta.ai || {},
        thought: thoughtSummary(thoughtsById.get(currentMeta.id))
    };
    let scoredCandidates = candidates;
    let reranked;

    try {
        if (typeof aiProvider.scoreRelationCandidates === 'function') {
            logAI('rerank:score:start', {
                thoughtId: currentMeta.id,
                model: aiProvider.rerankModel || 'noop',
                candidates: candidates.length
            });
            scoredCandidates = await aiProvider.scoreRelationCandidates(source, candidates);
            diagnostics.rerankScore = 'ready';
            diagnostics.scoredCount = scoredCandidates.length;
            logAI('rerank:score:done', {
                thoughtId: currentMeta.id,
                candidates: scoredCandidates.length
            });
        }
    } catch (error) {
        logAI('rerank:score:error', {
            thoughtId: currentMeta.id,
            message: error.message
        });
        diagnostics.rerankScore = 'fallback';
        diagnostics.errors.push({ stage: 'rerankScore', message: error.message });
        scoredCandidates = candidates;
    }
    if (diagnostics.rerankScore === 'skipped') diagnostics.scoredCount = scoredCandidates.length;

    const explanationCandidates = scoredCandidates.slice(0, LLM_RERANK_CANDIDATE_LIMIT);

    try {
        logAI('rerank:judge:start', {
            thoughtId: currentMeta.id,
            model: aiProvider.chatModel || 'noop',
            candidates: explanationCandidates.length
        });
        reranked = await aiProvider.rerankRelations(source, explanationCandidates);
        diagnostics.rerankJudge = 'ready';
        diagnostics.returnedCount = Array.isArray(reranked) ? reranked.length : 0;
        logAI('rerank:judge:done', {
            thoughtId: currentMeta.id,
            returned: Array.isArray(reranked) ? reranked.length : 0
        });
    } catch (error) {
        logAI('rerank:judge:error', {
            thoughtId: currentMeta.id,
            message: error.message
        });
        diagnostics.rerankJudge = 'fallback';
        diagnostics.errors.push({ stage: 'rerankJudge', message: error.message });
        reranked = localRerankFallback(explanationCandidates);
        diagnostics.returnedCount = reranked.length;
    }

    const candidatesById = new Map(scoredCandidates.map(candidate => [candidate.meta.id, candidate]));
    const scoredEdges = reranked
        .map(item => {
            const candidate = candidatesById.get(item.targetId);
            if (!candidate) return null;
            const edge = relationEdgeFromRerankItem(item, candidate);
            if (edge.score < SUGGESTED_RELATION_THRESHOLD) return null;
            return edge;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

    const finalEdges = scoredEdges
        .filter(edge => edge.score >= FINAL_RELATION_THRESHOLD)
        .slice(0, FINAL_RELATION_LIMIT);

    const existingRelations = await storage.readRelations(currentMeta.id);
    const manualEdges = (existingRelations.edges || [])
        .filter(isManualRelation)
        .filter(edge => edge.targetId && edge.targetId !== currentMeta.id);
    const manualTargetIds = new Set(manualEdges.map(edge => edge.targetId));
    const mergedEdges = [
        ...manualEdges,
        ...finalEdges
            .filter(edge => !manualTargetIds.has(edge.targetId))
            .map(edge => ({ ...edge, source: 'ai' }))
    ].slice(0, FINAL_RELATION_LIMIT + manualEdges.length);
    const confirmedTargetIds = new Set(mergedEdges.map(edge => edge.targetId));
    const suggestions = scoredEdges
        .filter(edge => edge.score < FINAL_RELATION_THRESHOLD)
        .filter(edge => !confirmedTargetIds.has(edge.targetId))
        .map(edge => ({ ...edge, source: 'ai_suggestion' }))
        .slice(0, SUGGESTED_RELATION_LIMIT);

    const relations = {
        id: currentMeta.id,
        edges: mergedEdges,
        suggestions,
        diagnostics: {
            ...diagnostics,
            status: 'ready',
            confirmedCount: mergedEdges.length,
            suggestionCount: suggestions.length,
            computedAt: Date.now()
        },
        version: 2,
        computedAt: Date.now()
    };

    await syncReverseRelations(currentMeta.id, mergedEdges);
    await storage.writeRelations(currentMeta.id, relations);
    logAI('relations:ready', {
        thoughtId: currentMeta.id,
        edges: mergedEdges.length,
        suggestions: suggestions.length,
        manualEdges: manualEdges.length,
        durationMs: Date.now() - startedAt
    });
    return relations;
}

async function processThought(thoughtId) {
    ensureInitialized();
    const startedAt = Date.now();
    const thought = await storage.readThought(thoughtId);
    if (!thought) return null;
    await writePendingMeta(thoughtId, 'processing');

    const text = thoughtText(thought);
    const tagVocabulary = userTagVocabulary(await storage.readThoughts());
    logAI('process:start', {
        thoughtId,
        textChars: text.length,
        tags: Array.isArray(thought.tags) ? thought.tags.length : 0,
        subItems: Array.isArray(thought.subItems) ? thought.subItems.length : 0,
        tagVocabulary: tagVocabulary.length
    });
    if (!text) {
        const emptyMeta = {
            id: thoughtId,
            status: 'empty',
            ai: {
                summary: '',
                entities: [],
                topics: [],
                intent: 'note',
                keywords: [],
                timeScope: 'reference',
                tags: [],
                embedding: [],
                model: aiProvider.embeddingModel || 'noop',
                extractModel: aiProvider.chatModel || 'noop',
                schemaVersion: 2,
                processedAt: Date.now()
            },
            stages: {
                queued: { status: 'ready' },
                analysis: { status: 'ready' },
                embedding: { status: 'skipped', reason: 'empty' },
                relations: { status: 'skipped', reason: 'empty' }
            },
            error: null
        };
        const existingRelations = await storage.readRelations(thoughtId);
        const manualEdges = (existingRelations.edges || []).filter(isManualRelation);
        await storage.writeThoughtMeta(thoughtId, emptyMeta);
        await syncReverseRelations(thoughtId, manualEdges);
        await storage.writeRelations(thoughtId, {
            id: thoughtId,
            edges: manualEdges,
            suggestions: [],
            diagnostics: { status: 'skipped', reason: 'empty', computedAt: Date.now() },
            version: 2,
            computedAt: Date.now()
        });
        logAI('process:empty', {
            thoughtId,
            durationMs: Date.now() - startedAt
        });
        broadcast({
            type: 'ai_status_update',
            thoughtId,
            status: 'empty',
            relationsCount: 0,
            aiTags: []
        });
        return { meta: emptyMeta, relations: [] };
    }

    let currentStage = 'analysis';
    try {
        logAI('extract:start', {
            thoughtId,
            model: aiProvider.chatModel || 'noop'
        });
        const extracted = normalizeExtraction(await aiProvider.extract(text, { tagVocabulary }));
        logAI('extract:done', {
            thoughtId,
            entities: extracted.entities.length,
            topics: extracted.topics.length,
            keywords: extracted.keywords.length
        });

        currentStage = 'embedding';
        logAI('embedding:start', {
            thoughtId,
            model: aiProvider.embeddingModel || 'noop'
        });
        const embedding = await aiProvider.getEmbedding(text);
        logAI('embedding:done', {
            thoughtId,
            dims: Array.isArray(embedding) ? embedding.length : 0
        });
        const meta = {
            id: thoughtId,
            status: 'ready',
            ai: {
                summary: extracted.summary,
                entities: extracted.entities,
                topics: extracted.topics,
                intent: extracted.intent,
                keywords: extracted.keywords,
                timeScope: extracted.timeScope,
                tags: extracted.tags,
                embedding: embedding || [],
                model: aiProvider.embeddingModel || 'noop',
                extractModel: aiProvider.chatModel || 'noop',
                schemaVersion: 2,
                processedAt: Date.now()
            },
            stages: {
                queued: { status: 'ready' },
                analysis: {
                    status: 'ready',
                    model: aiProvider.chatModel || 'noop'
                },
                embedding: {
                    status: 'ready',
                    model: aiProvider.embeddingModel || 'noop',
                    dims: Array.isArray(embedding) ? embedding.length : 0
                },
                relations: { status: 'pending' }
            },
            error: null
        };

        await storage.writeThoughtMeta(thoughtId, meta);
        const relations = await withRelationWriteLock(() => buildRelations(meta));
        meta.stages.relations = {
            status: 'ready',
            rerankScore: relations.diagnostics?.rerankScore || 'skipped',
            rerankJudge: relations.diagnostics?.rerankJudge || 'skipped',
            candidateCount: relations.diagnostics?.candidateCount || 0,
            confirmedCount: relations.edges.length,
            suggestionCount: Array.isArray(relations.suggestions) ? relations.suggestions.length : 0,
            errors: relations.diagnostics?.errors || []
        };
        await storage.writeThoughtMeta(thoughtId, meta);
        logAI('process:ready', {
            thoughtId,
            relationCount: relations.edges.length,
            entities: meta.ai.entities.length,
            topics: meta.ai.topics.length,
            keywords: meta.ai.keywords.length,
            aiTags: meta.ai.tags.length,
            embeddingDims: Array.isArray(meta.ai.embedding) ? meta.ai.embedding.length : 0,
            extractModel: meta.ai.extractModel,
            embeddingModel: meta.ai.model,
            durationMs: Date.now() - startedAt
        });
        broadcast({
            type: 'ai_status_update',
            thoughtId,
            status: 'ready',
            relationsCount: relations.edges.length,
            processedAt: meta.ai.processedAt,
            aiTags: meta.ai.tags
        });
        broadcast({
            type: 'relations_update',
            thoughtId,
            relationsCount: relations.edges.length
        });
        return { meta, relations };
    } catch (error) {
        const meta = {
            id: thoughtId,
            status: 'error',
            ai: null,
            schemaVersion: 2,
            stages: {
                queued: { status: 'ready' },
                analysis: { status: currentStage === 'analysis' ? 'error' : 'ready' },
                embedding: { status: currentStage === 'embedding' ? 'error' : 'pending' },
                relations: { status: 'pending' }
            },
            error: {
                stage: currentStage,
                message: error.message,
                lastFailedAt: Date.now()
            }
        };
        await storage.writeThoughtMeta(thoughtId, meta);
        logAI('process:error', {
            thoughtId,
            message: error.message,
            durationMs: Date.now() - startedAt
        });
        broadcast({
            type: 'ai_status_update',
            thoughtId,
            status: 'error',
            error: meta.error
        });
        return { meta, relations: null };
    }
}

function queueThought(thoughtId, reason = 'process') {
    ensureInitialized();
    if (!thoughtId || queuedIds.has(thoughtId)) return;
    queuedIds.add(thoughtId);
    queue.push({ thoughtId, reason });
    logAI('queued', { thoughtId, reason, queueSize: queue.length });
    writePendingMeta(thoughtId, reason).catch(error => {
        console.warn('Failed to mark thought AI pending:', error);
    });
    setImmediate(drainQueue);
}

async function drainQueue() {
    if (processing) return;
    processing = true;
    logAI('drain:start', { queueSize: queue.length, concurrency: DEFAULT_QUEUE_CONCURRENCY });

    try {
        while (queue.length) {
            const batch = queue.splice(0, DEFAULT_QUEUE_CONCURRENCY);
            for (const job of batch) queuedIds.delete(job.thoughtId);
            currentJobs = batch.map(job => ({
                ...job,
                startedAt: Date.now()
            }));
            currentJob = currentJobs[0] || null;
            await Promise.all(batch.map(async job => {
                try {
                    await processThought(job.thoughtId);
                } catch (error) {
                    lastError = {
                        thoughtId: job.thoughtId,
                        reason: job.reason,
                        message: error.message,
                        at: Date.now()
                    };
                    logAI('job:error', {
                        thoughtId: job.thoughtId,
                        reason: job.reason,
                        message: error.message
                    });
                } finally {
                    currentJobs = currentJobs.filter(item => item.thoughtId !== job.thoughtId);
                    currentJob = currentJobs[0] || null;
                }
            }));
        }
    } finally {
        processing = false;
        currentJobs = [];
        logAI('drain:done', { queueSize: queue.length });
    }
}

function getQueueStatus() {
    return {
        processing,
        queueSize: queue.length,
        queuedIds: Array.from(queuedIds),
        currentJob,
        currentJobs,
        concurrency: DEFAULT_QUEUE_CONCURRENCY,
        lastError
    };
}

async function backfillMissingMeta({ limit = Infinity, force = false } = {}) {
    ensureInitialized();
    const thoughts = await storage.readThoughts();
    let queued = 0;

    for (const thought of thoughts) {
        if (queued >= limit) break;
        const meta = await storage.readThoughtMeta(thought.id);
        if (force || !meta || meta.status !== 'ready') {
            queueThought(thought.id, 'backfill');
            queued++;
        }
    }

    logAI('backfill:queued', { queued, limit, force });
    return { queued };
}

async function recoverStalePendingMeta({ limit = Infinity, maxAgeMs = DEFAULT_PENDING_RECOVERY_MS } = {}) {
    ensureInitialized();
    const thoughts = await storage.readThoughts();
    const now = Date.now();
    let queued = 0;
    let skippedFresh = 0;

    for (const thought of thoughts) {
        if (queued >= limit) break;
        if (!thought?.id) continue;

        const meta = await storage.readThoughtMeta(thought.id);
        if (meta?.status !== 'pending') continue;

        const lastTouchedAt = Number(meta.queuedAt || meta.processingAt || meta.updatedAt || 0);
        if (lastTouchedAt > 0 && now - lastTouchedAt < maxAgeMs) {
            skippedFresh++;
            continue;
        }

        queueThought(thought.id, 'recover-pending');
        queued++;
    }

    logAI('pending:recover', { queued, skippedFresh, maxAgeMs });
    return { queued, skippedFresh };
}

async function rebuildRelations({ limit = Infinity } = {}) {
    ensureInitialized();
    const thoughts = await storage.readThoughts();
    let rebuilt = 0;

    for (const thought of thoughts) {
        if (rebuilt >= limit) break;
        if (!thought?.id) continue;

        const meta = await storage.readThoughtMeta(thought.id);
        if (meta?.status !== 'ready' || !meta.ai) continue;

        const relations = await buildRelations(meta);
        broadcast({
            type: 'relations_update',
            thoughtId: thought.id,
            relationsCount: relations.edges.length
        });
        rebuilt++;
    }

    logAI('relations:rebuild:done', { rebuilt, limit });
    return { rebuilt };
}

module.exports = {
    init,
    queueThought,
    processThought,
    backfillMissingMeta,
    recoverStalePendingMeta,
    rebuildRelations,
    getQueueStatus,
    _private: {
        thoughtText,
        normalizeExtraction,
        localRerankFallback,
        buildRelations,
        syncReverseRelations,
        userTagVocabulary,
        isManualRelation,
        withRelationWriteLock
    }
};
