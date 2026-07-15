const { createDefaultProvider } = require('./ai-provider');
const { findCandidates } = require('./relations-calculator');
const { createAnalysisSourceSignature, hasSameAnalysisSource } = require('./thought-ai-source');

let storage;
let aiProvider;
let broadcast = () => {};
let processing = false;
let currentJob = null;
let currentJobs = [];
let pendingRecoveryTimer = null;
let lastError = null;
const queue = [];
const queuedIds = new Set();
const activeThoughtIds = new Set();
const deferredQueueReasons = new Map();
const insightJobs = new Map();
const LOCAL_CANDIDATE_LIMIT = 50;
const LLM_RERANK_CANDIDATE_LIMIT = 12;
const LOCAL_CANDIDATE_THRESHOLD = 0.16;
const FINAL_RELATION_LIMIT = 8;
const FINAL_RELATION_THRESHOLD = 0.72;
const SUGGESTED_RELATION_LIMIT = 6;
const SUGGESTED_RELATION_THRESHOLD = 0.62;
const INSIGHT_RELATION_LIMIT = 5;
const INSIGHT_RELATED_THOUGHT_LIMIT = 3;
const INSIGHT_NOTEPAD_LIMIT = 2;
const DEFAULT_INSIGHT_MAX_CHARS = Math.max(200, Number(process.env.AI_INSIGHT_MAX_CHARS || 800));
const DEFAULT_PENDING_RECOVERY_MS = Number(process.env.AI_PENDING_RECOVERY_MS || 120000);
const DEFAULT_QUEUE_CONCURRENCY = Math.max(1, Number(process.env.AI_QUEUE_CONCURRENCY || 3));
const DEFAULT_RELATION_META_READ_CONCURRENCY = Math.max(1, Number(process.env.AI_RELATION_META_READ_CONCURRENCY || 4));
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
        chatModel: providerModelLabel('chat'),
        embeddingModel: providerModelLabel('embedding'),
        rerankModel: aiProvider.rerankModel || 'noop',
        insightModel: aiProvider.insightModel || 'not-configured',
        hasReranker: Boolean(aiProvider.rerankBaseUrl && aiProvider.rerankApiKey)
    });

    // Periodically recover thoughts whose meta is stuck in 'pending' (process
    // died mid-process, or a storage outage prevented the error write). Without
    // this, a single transient failure can leave a thought permanently stuck
    // and require manual intervention.
    if (!pendingRecoveryTimer) {
        pendingRecoveryTimer = setInterval(() => {
            recoverStalePendingMeta({ limit: 50 }).catch(err => {
                logAI('pending:recover:error', { message: err?.message || String(err) });
            });
        }, 60000);
        if (pendingRecoveryTimer.unref) pendingRecoveryTimer.unref();
    }
}

function ensureInitialized() {
    if (!storage || !aiProvider) init();
}

function providerModelLabel(kind) {
    if (!aiProvider) return 'noop';
    if (kind === 'chat') {
        return typeof aiProvider.isChatReady === 'function' && !aiProvider.isChatReady()
            ? 'noop'
            : (aiProvider.chatModel || 'noop');
    }
    if (kind === 'embedding') {
        return typeof aiProvider.isEmbeddingReady === 'function' && !aiProvider.isEmbeddingReady()
            ? 'noop'
            : (aiProvider.embeddingModel || 'noop');
    }
    return 'noop';
}

async function isAnalysisSourceCurrent(thoughtId, signature) {
    const thought = await storage.readThought(thoughtId);
    return hasSameAnalysisSource(thought, signature);
}

async function writeThoughtMetaIfSourceCurrent(thoughtId, signature, meta) {
    const write = async () => {
        if (!(await isAnalysisSourceCurrent(thoughtId, signature))) return false;
        await storage.writeThoughtMeta(thoughtId, meta);
        return true;
    };
    return typeof storage.withThoughtWriteLock === 'function'
        ? storage.withThoughtWriteLock(write)
        : write();
}

async function mapWithConcurrency(values, limit, mapper) {
    const items = Array.isArray(values) ? values : [];
    const concurrency = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
    const results = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    }));
    return results;
}

async function writePendingMeta(thoughtId, reason = 'process', sourceSignature = null) {
    if (!thoughtId) return null;
    const write = async () => {
        const thought = await storage.readThought(thoughtId);
        if (!thought) return null;
        const currentSource = createAnalysisSourceSignature(thought);
        if (sourceSignature && currentSource.hash !== sourceSignature.hash) return null;

        const existingMeta = await storage.readThoughtMeta(thoughtId);
        const meta = {
            id: thoughtId,
            status: 'pending',
            ai: null,
            schemaVersion: 2,
            sourceVersion: currentSource.version,
            sourceHash: currentSource.hash,
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
        if (existingMeta?.insight) meta.insight = existingMeta.insight;
        await storage.writeThoughtMeta(thoughtId, meta);
        return meta;
    };
    const meta = typeof storage.withThoughtWriteLock === 'function'
        ? await storage.withThoughtWriteLock(write)
        : await write();
    if (!meta) return null;
    logAI('pending', { thoughtId, reason });
    broadcast({
        type: 'ai_status_update',
        thoughtId,
        status: 'pending',
        reason
    });
    return meta;
}

async function attachLatestInsight(thoughtId, meta, fallbackInsight = null) {
    const latestMeta = await storage.readThoughtMeta(thoughtId);
    const insight = latestMeta?.insight || fallbackInsight;
    if (insight) meta.insight = insight;
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

function compactText(value = '', limit = 420) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return Array.from(text).slice(0, limit).join('');
}

function cleanInsightTerms(values = []) {
    const terms = new Map();
    for (const raw of values) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const parts = value.match(/[A-Za-z0-9_#.+-]{2,}|[\u4e00-\u9fff]{2,}/g) || [value];
        for (const part of parts) {
            const term = String(part || '').trim();
            if (term.length < 2 || term.length > 32) continue;
            terms.set(term.toLowerCase(), term);
        }
    }
    return Array.from(terms.values()).slice(0, 40);
}

function insightTermsFrom(thought, meta) {
    const ai = meta?.ai || {};
    return cleanInsightTerms([
        ...(Array.isArray(thought?.tags) ? thought.tags : []),
        ...(Array.isArray(ai.entities) ? ai.entities : []),
        ...(Array.isArray(ai.topics) ? ai.topics : []),
        ...(Array.isArray(ai.keywords) ? ai.keywords : []),
        ...(Array.isArray(ai.tags) ? ai.tags : []),
        compactText(thoughtText(thought), 260)
    ]);
}

function thoughtInsightSummary(thought, meta = {}, limit = 420) {
    const ai = meta?.ai || {};
    return {
        id: thought?.id || meta?.id || '',
        text: compactText(thoughtText(thought), limit),
        tags: Array.isArray(thought?.tags) ? thought.tags.slice(0, 8) : [],
        completed: thought?.completed === true,
        updatedAt: thought?.updatedAt || thought?.createdAt || 0,
        ai: {
            summary: compactText(ai.summary || '', 80),
            entities: Array.isArray(ai.entities) ? ai.entities.slice(0, 8) : [],
            topics: Array.isArray(ai.topics) ? ai.topics.slice(0, 6) : [],
            intent: ai.intent || '',
            keywords: Array.isArray(ai.keywords) ? ai.keywords.slice(0, 10) : [],
            tags: Array.isArray(ai.tags) ? ai.tags.slice(0, 6) : []
        }
    };
}

function relationPriority(edge) {
    if (edge?.source === 'manual' || edge?.method === 'manual') return 2;
    if (edge?.source === 'ai') return 1;
    return 0;
}

function termHits(text, terms = []) {
    const source = String(text || '').toLowerCase();
    if (!source) return 0;
    return terms.reduce((count, term) => (
        source.includes(String(term || '').toLowerCase()) ? count + 1 : count
    ), 0);
}

function scoreInsightThought(currentTerms, thought, meta) {
    const ai = meta?.ai || {};
    const tagText = (Array.isArray(thought?.tags) ? thought.tags : []).join(' ');
    const aiText = [
        ai.summary,
        ...(Array.isArray(ai.entities) ? ai.entities : []),
        ...(Array.isArray(ai.topics) ? ai.topics : []),
        ...(Array.isArray(ai.keywords) ? ai.keywords : []),
        ...(Array.isArray(ai.tags) ? ai.tags : [])
    ].join(' ');
    return (
        termHits(tagText, currentTerms) * 3 +
        termHits(aiText, currentTerms) * 2 +
        termHits(thoughtText(thought), currentTerms)
    );
}

function snippetAroundTerms(content, terms = [], limit = 260) {
    const text = compactText(content, 3000);
    if (!text) return '';
    const lower = text.toLowerCase();
    let index = -1;
    for (const term of terms) {
        const hit = lower.indexOf(String(term || '').toLowerCase());
        if (hit >= 0 && (index === -1 || hit < index)) index = hit;
    }
    if (index === -1) return compactText(text, limit);
    const start = Math.max(0, index - Math.floor(limit / 3));
    return compactText(text.slice(start), limit);
}

async function buildThoughtInsightContext(thoughtId) {
    const thought = await storage.readThought(thoughtId);
    if (!thought) return null;

    const meta = await storage.readThoughtMeta(thoughtId) || { id: thoughtId };
    const currentTerms = insightTermsFrom(thought, meta);
    const relations = await storage.readRelations(thoughtId);
    const relationEdges = (Array.isArray(relations?.edges) ? relations.edges : [])
        .filter(edge => edge?.targetId && edge.targetId !== thoughtId)
        .sort((a, b) => (
            relationPriority(b) - relationPriority(a) ||
            Number(b.score || 0) - Number(a.score || 0)
        ))
        .slice(0, INSIGHT_RELATION_LIMIT);

    const relationContexts = [];
    const relationTargetIds = new Set();
    for (const edge of relationEdges) {
        const target = await storage.readThought(edge.targetId);
        if (!target) continue;
        relationTargetIds.add(target.id);
        const targetMeta = await storage.readThoughtMeta(target.id) || { id: target.id };
        relationContexts.push({
            relationType: edge.relationType || edge.method || 'related_context',
            source: edge.source || edge.method || 'ai',
            score: Number.isFinite(Number(edge.score)) ? Number(edge.score) : null,
            reasons: Array.isArray(edge.reasons) ? edge.reasons.slice(0, 4) : [],
            thought: thoughtInsightSummary(target, targetMeta, 360)
        });
    }

    const relatedThoughts = [];
    const thoughts = await storage.readThoughts();
    for (const candidate of thoughts) {
        if (!candidate?.id || candidate.id === thoughtId || relationTargetIds.has(candidate.id)) continue;
        const candidateMeta = await storage.readThoughtMeta(candidate.id) || { id: candidate.id };
        const score = scoreInsightThought(currentTerms, candidate, candidateMeta);
        if (score <= 0) continue;
        relatedThoughts.push({
            score,
            thought: thoughtInsightSummary(candidate, candidateMeta, 320)
        });
    }
    relatedThoughts.sort((a, b) => (
        b.score - a.score ||
        Number(b.thought.updatedAt || 0) - Number(a.thought.updatedAt || 0)
    ));

    const notepads = [];
    if (typeof storage.getSearchDocuments === 'function' && currentTerms.length > 0) {
        try {
            const documents = await storage.getSearchDocuments();
            const scoredDocuments = (Array.isArray(documents) ? documents : [])
                .filter(doc => doc?.type === 'notepad')
                .map(doc => ({
                    doc,
                    score: termHits(`${doc.title || ''}\n${doc.content || ''}`, currentTerms)
                }))
                .filter(item => item.score > 0)
                .sort((a, b) => (
                    b.score - a.score ||
                    Number(b.doc.updatedAt || 0) - Number(a.doc.updatedAt || 0)
                ))
                .slice(0, INSIGHT_NOTEPAD_LIMIT);
            for (const item of scoredDocuments) {
                notepads.push({
                    id: item.doc.id,
                    title: compactText(item.doc.title || '', 80),
                    snippet: snippetAroundTerms(item.doc.content || '', currentTerms, 260),
                    updatedAt: item.doc.updatedAt || 0
                });
            }
        } catch (error) {
            logAI('insight:notepads:error', { thoughtId, message: error.message });
        }
    }

    return {
        current: thoughtInsightSummary(thought, meta, 1000),
        relations: relationContexts,
        relatedThoughts: relatedThoughts.slice(0, INSIGHT_RELATED_THOUGHT_LIMIT),
        notepads,
        contextIds: [
            ...relationContexts.map(item => `thought:${item.thought.id}`),
            ...relatedThoughts.slice(0, INSIGHT_RELATED_THOUGHT_LIMIT).map(item => `thought:${item.thought.id}`),
            ...notepads.map(item => `notepad:${item.id}`)
        ]
    };
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
    const judgeScore = Number.isFinite(item.score) ? item.score : candidate.score;
    const rerankScore = Number(candidate.rerankScore ?? candidate.signals?.reranker);
    const score = Number.isFinite(rerankScore)
        ? Math.max(judgeScore, rerankScore)
        : judgeScore;
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

async function buildRelations(currentMeta, { isSourceCurrent = null } = {}) {
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
    const thoughtsById = new Map();
    for (const thought of thoughts) {
        if (thought?.id) thoughtsById.set(thought.id, thought);
    }
    const candidateThoughts = thoughts.filter(thought => (
        thought?.id &&
        thought.id !== currentMeta.id &&
        !suppressedTargetIds.has(thought.id)
    ));
    const candidateMetas = await mapWithConcurrency(
        candidateThoughts,
        DEFAULT_RELATION_META_READ_CONCURRENCY,
        async thought => ({ thought, meta: await storage.readThoughtMeta(thought.id) })
    );
    const metas = candidateMetas
        .filter(({ meta }) => meta?.status === 'ready' && meta.ai)
        .map(({ thought, meta }) => ({
            ...meta,
            thought: thoughtSummary(thought)
        }));

    const candidates = findCandidates(currentMeta, metas, {
        threshold: LOCAL_CANDIDATE_THRESHOLD,
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
            model: providerModelLabel('chat'),
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

    if (typeof isSourceCurrent === 'function' && !(await isSourceCurrent())) {
        logAI('relations:discarded', { thoughtId: currentMeta.id, reason: 'source-changed' });
        return {
            ...relations,
            stale: true,
            diagnostics: {
                ...relations.diagnostics,
                status: 'stale'
            }
        };
    }

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
    const sourceSignature = createAnalysisSourceSignature(thought);
    const pendingMeta = await writePendingMeta(thoughtId, 'processing', sourceSignature);
    if (!pendingMeta) {
        logAI('process:discarded', { thoughtId, reason: 'source-changed-before-start' });
        return { discarded: true, reason: 'source-changed' };
    }
    const preservedInsight = pendingMeta?.insight || null;

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
            sourceVersion: sourceSignature.version,
            sourceHash: sourceSignature.hash,
            ai: {
                summary: '',
                entities: [],
                topics: [],
                intent: 'note',
                keywords: [],
                timeScope: 'reference',
                tags: [],
                embedding: [],
                model: providerModelLabel('embedding'),
                extractModel: providerModelLabel('chat'),
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
        await attachLatestInsight(thoughtId, emptyMeta, preservedInsight);
        const existingRelations = await storage.readRelations(thoughtId);
        const manualEdges = (existingRelations.edges || []).filter(isManualRelation);
        if (!(await writeThoughtMetaIfSourceCurrent(thoughtId, sourceSignature, emptyMeta))) {
            logAI('process:discarded', { thoughtId, reason: 'source-changed-empty' });
            return { discarded: true, reason: 'source-changed' };
        }
        const emptyRelationsWritten = await withRelationWriteLock(async () => {
            if (!(await isAnalysisSourceCurrent(thoughtId, sourceSignature))) return false;
            await syncReverseRelations(thoughtId, manualEdges);
            await storage.writeRelations(thoughtId, {
                id: thoughtId,
                edges: manualEdges,
                suggestions: [],
                diagnostics: { status: 'skipped', reason: 'empty', computedAt: Date.now() },
                version: 2,
                computedAt: Date.now()
            });
            return true;
        });
        if (!emptyRelationsWritten) {
            logAI('process:discarded', { thoughtId, reason: 'source-changed-empty-relations' });
            return { discarded: true, reason: 'source-changed' };
        }
        logAI('process:empty', {
            thoughtId,
            durationMs: Date.now() - startedAt
        });
        broadcast({
            type: 'ai_status_update',
            thoughtId,
            status: 'empty',
            relationsCount: manualEdges.length,
            aiTags: []
        });
        return { meta: emptyMeta, relations: manualEdges };
    }

    let currentStage = 'analysis';
    let embeddingStage = { status: 'pending' };
    try {
        logAI('extract:start', {
            thoughtId,
            model: providerModelLabel('chat')
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
            model: providerModelLabel('embedding')
        });
        let embedding = [];
        try {
            embedding = await aiProvider.getEmbedding(text);
            embeddingStage = {
                status: 'ready',
                model: providerModelLabel('embedding'),
                dims: Array.isArray(embedding) ? embedding.length : 0
            };
            logAI('embedding:done', {
                thoughtId,
                dims: embeddingStage.dims
            });
        } catch (embeddingError) {
            embedding = [];
            embeddingStage = {
                status: 'error',
                model: providerModelLabel('embedding'),
                message: embeddingError.message
            };
            logAI('embedding:error', {
                thoughtId,
                model: providerModelLabel('embedding'),
                message: embeddingError.message
            });
        }
        const meta = {
            id: thoughtId,
            status: 'ready',
            sourceVersion: sourceSignature.version,
            sourceHash: sourceSignature.hash,
            ai: {
                summary: extracted.summary,
                entities: extracted.entities,
                topics: extracted.topics,
                intent: extracted.intent,
                keywords: extracted.keywords,
                timeScope: extracted.timeScope,
                tags: extracted.tags,
                embedding: embedding || [],
                model: providerModelLabel('embedding'),
                extractModel: providerModelLabel('chat'),
                schemaVersion: 2,
                processedAt: Date.now()
            },
            stages: {
                queued: { status: 'ready' },
                analysis: {
                    status: 'ready',
                    model: providerModelLabel('chat')
                },
                embedding: embeddingStage,
                relations: { status: 'pending' }
            },
            error: null
        };
        await attachLatestInsight(thoughtId, meta, preservedInsight);

        if (!(await writeThoughtMetaIfSourceCurrent(thoughtId, sourceSignature, meta))) {
            logAI('process:discarded', { thoughtId, reason: 'source-changed-before-relations' });
            return { discarded: true, reason: 'source-changed' };
        }
        currentStage = 'relations';
        const relations = await withRelationWriteLock(() => buildRelations(meta, {
            isSourceCurrent: () => isAnalysisSourceCurrent(thoughtId, sourceSignature)
        }));
        if (relations?.stale) {
            logAI('process:discarded', { thoughtId, reason: 'source-changed-during-relations' });
            return { discarded: true, reason: 'source-changed' };
        }
        meta.stages.relations = {
            status: 'ready',
            rerankScore: relations.diagnostics?.rerankScore || 'skipped',
            rerankJudge: relations.diagnostics?.rerankJudge || 'skipped',
            model: aiProvider.rerankModel || null,
            candidateCount: relations.diagnostics?.candidateCount || 0,
            confirmedCount: relations.edges.length,
            suggestionCount: Array.isArray(relations.suggestions) ? relations.suggestions.length : 0,
            errors: relations.diagnostics?.errors || []
        };
        await attachLatestInsight(thoughtId, meta, preservedInsight);
        if (!(await writeThoughtMetaIfSourceCurrent(thoughtId, sourceSignature, meta))) {
            logAI('process:discarded', { thoughtId, reason: 'source-changed-before-ready' });
            return { discarded: true, reason: 'source-changed' };
        }
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
        if (!(await isAnalysisSourceCurrent(thoughtId, sourceSignature))) {
            logAI('process:discarded', { thoughtId, reason: 'source-changed-after-error' });
            return { discarded: true, reason: 'source-changed' };
        }
        // Preserve already-completed AI extraction. Previously this built a
        // fresh meta with ai: null, discarding expensive extract+embedding
        // results just because the relations stage hit a transient
        // rerank/LLM/network error. Now we keep meta.ai when extraction
        // succeeded and only mark the failed stage.
        let meta;
        try {
            meta = await storage.readThoughtMeta(thoughtId);
        } catch (_) {
            meta = null;
        }
        const relationsFailed = currentStage === 'relations';
        if (!meta || !meta.ai) {
            meta = {
                id: thoughtId,
                schemaVersion: 2,
                stages: { queued: { status: 'ready' } },
                status: 'error',
                ai: null
            };
        } else {
            // Extraction succeeded; keep it so rebuildRelations can retry the
            // relations stage later without re-running extract/embedding.
            meta.status = 'ready';
        }
        meta.id = thoughtId;
        meta.sourceVersion = sourceSignature.version;
        meta.sourceHash = sourceSignature.hash;
        meta.stages = meta.stages || {};
        meta.stages.queued = { status: 'ready' };
        meta.stages.analysis = { status: currentStage === 'analysis' ? 'error' : 'ready' };
        meta.stages.embedding = currentStage === 'analysis' ? { status: 'pending' } : embeddingStage;
        meta.stages.relations = { status: relationsFailed ? 'error' : 'pending' };
        meta.error = {
            stage: currentStage,
            message: error.message,
            lastFailedAt: Date.now()
        };
        await attachLatestInsight(thoughtId, meta, preservedInsight);
        if (!(await writeThoughtMetaIfSourceCurrent(thoughtId, sourceSignature, meta))) {
            logAI('process:discarded', { thoughtId, reason: 'source-changed-before-error-write' });
            return { discarded: true, reason: 'source-changed' };
        }
        logAI('process:error', {
            thoughtId,
            message: error.message,
            stage: currentStage,
            preservedAI: !!meta.ai,
            durationMs: Date.now() - startedAt
        });
        broadcast({
            type: 'ai_status_update',
            thoughtId,
            status: meta.status,
            error: meta.error
        });
        return { meta, relations: null };
    }
}

function queueThought(thoughtId, reason = 'process') {
    ensureInitialized();
    if (!thoughtId) return { queued: false, reason: 'missing-id' };
    if (queuedIds.has(thoughtId)) return { queued: false, state: 'queued' };
    if (activeThoughtIds.has(thoughtId)) {
        deferredQueueReasons.set(thoughtId, reason);
        logAI('queue:deferred', { thoughtId, reason });
        return { queued: false, state: 'processing', deferred: true };
    }
    queuedIds.add(thoughtId);
    queue.push({ thoughtId, reason });
    logAI('queued', { thoughtId, reason, queueSize: queue.length });
    writePendingMeta(thoughtId, reason).catch(error => {
        console.warn('Failed to mark thought AI pending:', error);
    });
    setImmediate(drainQueue);
    return { queued: true, state: 'queued' };
}

async function drainQueue() {
    if (processing) return;
    processing = true;
    logAI('drain:start', { queueSize: queue.length, concurrency: DEFAULT_QUEUE_CONCURRENCY });

    try {
        while (queue.length) {
            const batch = queue.splice(0, DEFAULT_QUEUE_CONCURRENCY);
            for (const job of batch) {
                queuedIds.delete(job.thoughtId);
                activeThoughtIds.add(job.thoughtId);
            }
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
                    activeThoughtIds.delete(job.thoughtId);
                    currentJobs = currentJobs.filter(item => item.thoughtId !== job.thoughtId);
                    currentJob = currentJobs[0] || null;
                    const deferredReason = deferredQueueReasons.get(job.thoughtId);
                    if (deferredReason) {
                        deferredQueueReasons.delete(job.thoughtId);
                        queueThought(job.thoughtId, deferredReason);
                    }
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
        activeIds: Array.from(activeThoughtIds),
        deferredIds: Array.from(deferredQueueReasons.keys()),
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

    const activeIds = new Set(currentJobs.map(job => job?.thoughtId).filter(Boolean));
    for (const thought of thoughts) {
        if (queued >= limit) break;
        if (!thought?.id) continue;

        // Skip thoughts currently being processed: their meta is still
        // 'pending' (queuedIds was removed on dispatch) but re-queueing them
        // would cause concurrent duplicate processing and waste AI quota.
        if (activeIds.has(thought.id)) {
            skippedFresh++;
            continue;
        }

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

        const sourceSignature = createAnalysisSourceSignature(thought);
        const relations = await withRelationWriteLock(() => buildRelations(meta, {
            isSourceCurrent: typeof storage.readThought === 'function'
                ? () => isAnalysisSourceCurrent(thought.id, sourceSignature)
                : null
        }));
        if (relations?.stale) continue;
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

function isInsightReady() {
    ensureInitialized();
    return typeof aiProvider?.isInsightReady === 'function' && aiProvider.isInsightReady();
}

function getInsightProviderStatus() {
    ensureInitialized();
    const model = aiProvider?.insightModel || '';
    let reason = null;
    if (!aiProvider?.insightBaseUrl) reason = 'missing-base-url';
    else if (!aiProvider?.insightApiKey) reason = 'missing-api-key';
    else if (!model) reason = 'missing-model';
    else if (model === aiProvider?.chatModel) reason = 'same-as-chat-model';
    else if (!isInsightReady()) reason = 'unavailable';
    return {
        ready: !reason,
        model: model || null,
        provider: aiProvider?.constructor?.name || 'unknown',
        reason
    };
}

function insightNotConfiguredError() {
    const status = getInsightProviderStatus();
    const error = new Error(
        status.reason === 'same-as-chat-model'
            ? 'AI insight model must be configured separately from AI chat model'
            : 'AI insight model is not configured'
    );
    error.code = 'AI_INSIGHT_NOT_CONFIGURED';
    error.provider = status;
    return error;
}

function sourceChangedError() {
    const error = new Error('Thought changed while AI was processing; please run it again');
    error.code = 'AI_SOURCE_STALE';
    return error;
}

function truncateInsightMarkdown(markdown, maxChars = DEFAULT_INSIGHT_MAX_CHARS) {
    const chars = Array.from(String(markdown || ''));
    if (chars.length <= maxChars) return { markdown: chars.join(''), truncated: false };
    return {
        markdown: `${chars.slice(0, maxChars).join('').trimEnd()}\n\n...`,
        truncated: true
    };
}

async function writeThoughtInsight(thoughtId, insight, sourceSignature = null) {
    const write = async () => {
        const thought = await storage.readThought(thoughtId);
        if (!thought) return null;
        if (sourceSignature && !hasSameAnalysisSource(thought, sourceSignature)) return null;

        const meta = await storage.readThoughtMeta(thoughtId) || { id: thoughtId };
        const nextInsight = {
            ...(meta.insight || {}),
            ...insight,
            schemaVersion: 1,
            updatedAt: Date.now()
        };
        meta.id = thoughtId;
        meta.insight = nextInsight;
        await storage.writeThoughtMeta(thoughtId, meta);
        return nextInsight;
    };
    return typeof storage.withThoughtWriteLock === 'function'
        ? storage.withThoughtWriteLock(write)
        : write();
}

async function runThoughtInsight(thoughtId) {
    ensureInitialized();
    if (!isInsightReady()) throw insightNotConfiguredError();

    const thought = await storage.readThought(thoughtId);
    if (!thought) return null;
    const sourceSignature = createAnalysisSourceSignature(thought);

    const startedAt = Date.now();
    const model = aiProvider.insightModel || 'not-configured';
    const pendingInsight = await writeThoughtInsight(thoughtId, {
        status: 'pending',
        markdown: '',
        model,
        contextIds: [],
        requestedAt: Date.now(),
        error: null
    }, sourceSignature);
    if (!pendingInsight) throw sourceChangedError();
    logAI('insight:start', { thoughtId, model });

    try {
        const context = await buildThoughtInsightContext(thoughtId);
        if (!context) return null;
        const markdown = await aiProvider.generateThoughtInsight(context);
        if (!markdown) throw new Error('AI insight response was empty');
        const output = truncateInsightMarkdown(markdown);
        const insight = await writeThoughtInsight(thoughtId, {
            status: 'ready',
            markdown: output.markdown,
            truncated: output.truncated,
            model,
            contextIds: context.contextIds,
            generatedAt: Date.now(),
            error: null
        }, sourceSignature);
        if (!insight) throw sourceChangedError();
        logAI('insight:ready', {
            thoughtId,
            chars: Array.from(markdown).length,
            contextIds: context.contextIds.length,
            durationMs: Date.now() - startedAt
        });
        return insight;
    } catch (error) {
        if (error.code === 'AI_SOURCE_STALE') throw error;
        const insight = await writeThoughtInsight(thoughtId, {
            status: 'error',
            markdown: '',
            model,
            contextIds: [],
            error: {
                message: error.message,
                lastFailedAt: Date.now()
            }
        }, sourceSignature);
        if (!insight) throw sourceChangedError();
        error.insight = insight;
        logAI('insight:error', {
            thoughtId,
            message: error.message,
            durationMs: Date.now() - startedAt
        });
        throw error;
    }
}

async function generateThoughtInsight(thoughtId) {
    ensureInitialized();
    if (insightJobs.has(thoughtId)) return insightJobs.get(thoughtId);

    const job = runThoughtInsight(thoughtId);
    insightJobs.set(thoughtId, job);
    try {
        return await job;
    } finally {
        if (insightJobs.get(thoughtId) === job) insightJobs.delete(thoughtId);
    }
}

module.exports = {
    init,
    queueThought,
    processThought,
    backfillMissingMeta,
    recoverStalePendingMeta,
    rebuildRelations,
    generateThoughtInsight,
    getInsightProviderStatus,
    isInsightReady,
    getQueueStatus,
    _private: {
        thoughtText,
        normalizeExtraction,
        localRerankFallback,
        buildRelations,
        buildThoughtInsightContext,
        compactText,
        insightTermsFrom,
        syncReverseRelations,
        userTagVocabulary,
        isManualRelation,
        withRelationWriteLock
    }
};
