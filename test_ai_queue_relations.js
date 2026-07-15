const aiQueue = require('./scripts/ai-queue');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    let writtenRelations = null;
    const relationStore = {
        source: { id: 'source', edges: [] },
        'target-strong': { id: 'target-strong', edges: [] },
        'target-suggest': { id: 'target-suggest', edges: [] },
        'target-weak': { id: 'target-weak', edges: [] }
    };
    const thoughts = [
        { id: 'source', text: 'DumbPad should use local first AI relations', tags: ['architecture'], createdAt: 1 },
        { id: 'target-strong', text: 'Local first design helps low resource servers', tags: ['architecture'], createdAt: 2 },
        { id: 'target-suggest', text: 'DumbPad sync queue needs careful background handling', tags: ['architecture'], createdAt: 4 },
        { id: 'target-weak', text: 'A cooking recipe note', tags: ['life'], createdAt: 3 }
    ];
    const metas = {
        source: {
            id: 'source',
            status: 'ready',
            ai: {
                entities: ['DumbPad'],
                topics: ['local first'],
                intent: 'question',
                keywords: ['low resource server'],
                tags: ['architecture'],
                embedding: [1, 0]
            }
        },
        'target-strong': {
            id: 'target-strong',
            status: 'ready',
            ai: {
                entities: ['DumbPad'],
                topics: ['local first'],
                intent: 'conclusion',
                keywords: ['low resource server'],
                tags: ['architecture'],
                embedding: [0.95, 0.05]
            }
        },
        'target-suggest': {
            id: 'target-suggest',
            status: 'ready',
            ai: {
                entities: ['DumbPad'],
                topics: ['sync architecture'],
                intent: 'task',
                keywords: ['background queue'],
                tags: ['architecture'],
                embedding: [0.85, 0.15]
            }
        },
        'target-weak': {
            id: 'target-weak',
            status: 'ready',
            ai: {
                entities: ['Recipe'],
                topics: ['cooking'],
                intent: 'note',
                keywords: ['food'],
                tags: ['life'],
                embedding: [0, 1]
            }
        }
    };

    aiQueue.init({
        storage: {
            readThoughts: async () => thoughts,
            readThoughtMeta: async id => metas[id],
            readSuppressedRelations: async () => ({ id: 'source', edges: [] }),
            readRelations: async id => relationStore[id] || { id, edges: [] },
            writeRelations: async (id, relations) => {
                relationStore[id] = relations;
                writtenRelations = relations;
            }
        },
        aiProvider: {
            rerankRelations: async (_source, candidates) => candidates.map(candidate => ({
                targetId: candidate.meta.id,
                score: candidate.meta.id === 'target-strong' ? 0.91 : candidate.meta.id === 'target-suggest' ? 0.66 : 0.2,
                confidence: 0.88,
                relationType: 'supports',
                reasons: ['same product direction']
            }))
        },
        broadcast: () => {}
    });

    const relations = await aiQueue._private.buildRelations(metas.source);
    assert(relations.version === 2, 'relations should use schema version 2');
    assert(relations.diagnostics?.status === 'ready', 'relations should include ready diagnostics');
    assert(relations.diagnostics.candidateCount >= 1, 'relations diagnostics should include candidate count');
    assert(Number.isFinite(relations.diagnostics.confirmedCount), 'relations diagnostics should include confirmed count');
    assert(relations.edges.length === 1, 'low-score reranked candidates should be filtered out');
    assert(relations.edges[0].targetId === 'target-strong', 'strong target should remain');
    assert(relations.suggestions.length === 1, 'mid-score reranked candidates should be kept as suggestions');
    assert(relations.suggestions[0].targetId === 'target-suggest', 'suggested target should be separate from confirmed edges');
    assert(relations.edges[0].relationType === 'supports', 'reranked relation type should be preserved');
    assert(relations.edges[0].confidence === 0.88, 'reranked confidence should be preserved');
    assert(relations.edges[0].signals.entity > 0, 'edge should include local signals');
    assert(writtenRelations === relations, 'relations should be written through storage');
    assert(
        relationStore['target-strong'].edges.some(edge => edge.targetId === 'source'),
        'AI relations should be visible from the reverse target'
    );
    assert(
        !relationStore['target-suggest'].edges.some(edge => edge.targetId === 'source'),
        'suggested relations should not be written as reverse confirmed edges'
    );

    const rebuildResult = await aiQueue.rebuildRelations({ limit: 2 });
    assert(rebuildResult.rebuilt === 2, 'rebuildRelations should rebuild ready metas up to limit');

    const rerankSignalThoughts = [
        { id: 'rerank-source', text: 'DumbPad 的 AI 关联需要提升明显相关想法的召回', tags: ['product'], createdAt: 10 },
        { id: 'rerank-target', text: '关联推荐漏掉了同一产品方向下的上下文，需要用重排分数补足', tags: ['product'], createdAt: 11 }
    ];
    const rerankSignalMetas = {
        'rerank-source': {
            id: 'rerank-source',
            status: 'ready',
            ai: {
                entities: ['DumbPad'],
                topics: ['relation recall'],
                intent: 'problem',
                keywords: ['AI relation'],
                tags: ['product']
            }
        },
        'rerank-target': {
            id: 'rerank-target',
            status: 'ready',
            ai: {
                entities: ['DumbPad'],
                topics: ['semantic recommendation'],
                intent: 'note',
                keywords: ['recommendation quality'],
                tags: ['product']
            }
        }
    };
    const rerankSignalStore = {
        'rerank-source': { id: 'rerank-source', edges: [] },
        'rerank-target': { id: 'rerank-target', edges: [] }
    };
    aiQueue.init({
        storage: {
            readThoughts: async () => rerankSignalThoughts,
            readThoughtMeta: async id => rerankSignalMetas[id],
            readSuppressedRelations: async id => ({ id, edges: [] }),
            readRelations: async id => rerankSignalStore[id] || { id, edges: [] },
            writeRelations: async (id, relations) => {
                rerankSignalStore[id] = relations;
            }
        },
        aiProvider: {
            scoreRelationCandidates: async (_source, candidates) => candidates.map(candidate => ({
                ...candidate,
                rerankScore: 0.89,
                signals: {
                    ...(candidate.signals || {}),
                    reranker: 0.89
                }
            })),
            rerankRelations: async (_source, candidates) => candidates.map(candidate => ({
                targetId: candidate.meta.id,
                score: candidate.score,
                confidence: candidate.score,
                relationType: 'related_context',
                reasons: ['fallback judge kept local score']
            }))
        },
        broadcast: () => {}
    });

    const rerankSignalRelations = await aiQueue._private.buildRelations(rerankSignalMetas['rerank-source']);
    assert(
        rerankSignalRelations.edges.some(edge => edge.targetId === 'rerank-target') ||
            rerankSignalRelations.suggestions.some(edge => edge.targetId === 'rerank-target'),
        'a high dedicated reranker score should promote an obvious semantic relation even when the local overlap score is below the display threshold'
    );

    const entityOnlyThoughts = [
        { id: 'entity-source', text: 'DumbPad 需要优化同步体验', tags: [], createdAt: 20 },
        { id: 'entity-target', text: 'DumbPad 的文章保存误冲突需要自动合并', tags: [], createdAt: 21 }
    ];
    const entityOnlyMetas = {
        'entity-source': { id: 'entity-source', status: 'ready', ai: { entities: ['DumbPad'], topics: [], keywords: [], tags: [], embedding: [] } },
        'entity-target': { id: 'entity-target', status: 'ready', ai: { entities: ['DumbPad'], topics: [], keywords: [], tags: [], embedding: [] } }
    };
    const entityOnlyStore = {
        'entity-source': { id: 'entity-source', edges: [] },
        'entity-target': { id: 'entity-target', edges: [] }
    };
    aiQueue.init({
        storage: {
            readThoughts: async () => entityOnlyThoughts,
            readThoughtMeta: async id => entityOnlyMetas[id],
            readSuppressedRelations: async id => ({ id, edges: [] }),
            readRelations: async id => entityOnlyStore[id] || { id, edges: [] },
            writeRelations: async (id, relations) => {
                entityOnlyStore[id] = relations;
            }
        },
        aiProvider: {
            rerankRelations: async (_source, candidates) => candidates.map(candidate => ({
                targetId: candidate.meta.id,
                score: 0.85,
                confidence: 0.82,
                relationType: 'same_project',
                reasons: ['同一产品问题']
            }))
        },
        broadcast: () => {}
    });
    const entityOnlyRelations = await aiQueue._private.buildRelations(entityOnlyMetas['entity-source']);
    assert(
        entityOnlyRelations.edges.some(edge => edge.targetId === 'entity-target'),
        'entity-only but specific same-product thoughts should reach the AI judge instead of being filtered before rerank'
    );

    relationStore.source = { id: 'source', edges: [{ targetId: 'target-strong', score: 0.91 }] };
    relationStore['target-strong'] = { id: 'target-strong', edges: [{ targetId: 'source', score: 0.91 }] };
    aiQueue.init({
        storage: {
            readThoughts: async () => thoughts,
            readThoughtMeta: async id => metas[id],
            readSuppressedRelations: async () => ({ id: 'source', edges: [{ targetId: 'target-strong' }] }),
            readRelations: async id => relationStore[id] || { id, edges: [] },
            writeRelations: async (id, nextRelations) => {
                relationStore[id] = nextRelations;
                writtenRelations = nextRelations;
            }
        },
        aiProvider: {
            rerankRelations: async (_source, candidates) => candidates.map(candidate => ({
                targetId: candidate.meta.id,
                score: 0.91,
                confidence: 0.88,
                relationType: 'supports',
                reasons: ['same product direction']
            }))
        },
        broadcast: () => {}
    });

    const suppressedRelations = await aiQueue._private.buildRelations(metas.source);
    assert(
        suppressedRelations.edges.every(edge => edge.targetId !== 'target-strong'),
        'suppressed target should not be regenerated'
    );
    assert(
        !relationStore['target-strong'].edges.some(edge => edge.targetId === 'source'),
        'reverse relation should be removed when a relation is suppressed or no longer present'
    );

    relationStore.source = {
        id: 'source',
        edges: [{ targetId: 'target-strong', score: 1, method: 'manual', source: 'manual', relationType: 'manual' }]
    };
    relationStore['target-strong'] = {
        id: 'target-strong',
        edges: [{ targetId: 'source', score: 1, method: 'manual', source: 'manual', relationType: 'manual' }]
    };
    aiQueue.init({
        storage: {
            readThoughts: async () => thoughts,
            readThoughtMeta: async id => metas[id],
            readSuppressedRelations: async () => ({ id: 'source', edges: [] }),
            readRelations: async id => relationStore[id] || { id, edges: [] },
            writeRelations: async (id, nextRelations) => {
                relationStore[id] = nextRelations;
            }
        },
        aiProvider: {
            rerankRelations: async () => []
        },
        broadcast: () => {}
    });

    const manualPreservedRelations = await aiQueue._private.buildRelations(metas.source);
    assert(
        manualPreservedRelations.edges.some(edge => edge.targetId === 'target-strong' && edge.method === 'manual'),
        'AI rebuild should preserve manual source relations'
    );
    assert(
        relationStore['target-strong'].edges.some(edge => edge.targetId === 'source' && edge.method === 'manual'),
        'AI rebuild should preserve manual reverse relations'
    );

    const emptyBroadcasts = [];
    const emptyRelationStore = {
        'empty-source': {
            id: 'empty-source',
            edges: [{ targetId: 'empty-target', score: 1, method: 'manual', source: 'manual', relationType: 'manual' }]
        },
        'empty-target': {
            id: 'empty-target',
            edges: [{ targetId: 'empty-source', score: 1, method: 'manual', source: 'manual', relationType: 'manual' }]
        }
    };
    aiQueue.init({
        storage: {
            readThought: async id => ({ id, text: '', tags: [], subItems: [] }),
            readThoughts: async () => [
                { id: 'empty-source', text: '', tags: [], subItems: [] },
                { id: 'empty-target', text: 'target', tags: [], subItems: [] }
            ],
            readThoughtMeta: async id => ({ id, insight: { status: 'ready', markdown: '保留 insight' } }),
            writeThoughtMeta: async () => {},
            readRelations: async id => emptyRelationStore[id] || { id, edges: [] },
            writeRelations: async (id, nextRelations) => {
                emptyRelationStore[id] = nextRelations;
            },
            readSuppressedRelations: async id => ({ id, edges: [] })
        },
        aiProvider: {
            extract: async () => {
                throw new Error('empty thought should not call extract');
            },
            getEmbedding: async () => {
                throw new Error('empty thought should not call embedding');
            },
            rerankRelations: async () => []
        },
        broadcast: message => emptyBroadcasts.push(message)
    });
    const emptyResult = await aiQueue.processThought('empty-source');
    assert(emptyResult.relations.length === 1, 'empty thought processing should return preserved manual relations');
    assert(
        emptyBroadcasts.some(message => message.type === 'ai_status_update' && message.relationsCount === 1),
        'empty thought processing should broadcast preserved manual relation count'
    );

    const embeddingFailureThoughts = [
        { id: 'embedding-source', text: 'DumbPad 保存冲突需要自动合并', tags: [], subItems: [] },
        { id: 'embedding-target', text: 'DumbPad 多端同步误报冲突', tags: [], subItems: [] }
    ];
    const embeddingFailureMetas = {
        'embedding-target': {
            id: 'embedding-target',
            status: 'ready',
            ai: {
                entities: ['DumbPad'],
                topics: ['sync'],
                keywords: ['conflict'],
                tags: [],
                embedding: []
            }
        }
    };
    const embeddingFailureRelations = {
        'embedding-source': { id: 'embedding-source', edges: [] },
        'embedding-target': { id: 'embedding-target', edges: [] }
    };
    aiQueue.init({
        storage: {
            readThought: async id => embeddingFailureThoughts.find(thought => thought.id === id) || null,
            readThoughts: async () => embeddingFailureThoughts,
            readThoughtMeta: async id => embeddingFailureMetas[id],
            writeThoughtMeta: async (id, meta) => {
                embeddingFailureMetas[id] = meta;
            },
            readRelations: async id => embeddingFailureRelations[id] || { id, edges: [] },
            writeRelations: async (id, relations) => {
                embeddingFailureRelations[id] = relations;
            },
            readSuppressedRelations: async id => ({ id, edges: [] })
        },
        aiProvider: {
            extract: async () => ({
                summary: '保存冲突自动合并',
                entities: ['DumbPad'],
                topics: ['sync'],
                keywords: ['conflict'],
                tags: []
            }),
            getEmbedding: async () => {
                throw new Error('AI request failed with status 500');
            },
            rerankRelations: async (_source, candidates) => candidates.map(candidate => ({
                targetId: candidate.meta.id,
                score: 0.86,
                confidence: 0.84,
                relationType: 'same_project',
                reasons: ['同一同步问题']
            }))
        },
        broadcast: () => {}
    });
    const embeddingFailureResult = await aiQueue.processThought('embedding-source');
    assert(embeddingFailureResult.meta.status === 'ready', 'embedding failure should not fail the whole AI process');
    assert(embeddingFailureResult.meta.stages.embedding.status === 'error', 'embedding failure should be recorded on the embedding stage');
    assert(
        embeddingFailureRelations['embedding-source'].edges.some(edge => edge.targetId === 'embedding-target'),
        'relations should still be generated from extraction signals when embedding fails'
    );

    const now = Date.now();
    const recoveryThoughts = [
        { id: 'stale-pending', text: 'stale pending should recover', tags: [], subItems: [] },
        { id: 'fresh-pending', text: 'fresh pending should wait', tags: [], subItems: [] }
    ];
    const recoveryMetas = {
        'stale-pending': { id: 'stale-pending', status: 'pending', queuedAt: now - 10000 },
        'fresh-pending': { id: 'fresh-pending', status: 'pending', queuedAt: now }
    };
    const recoveryWrites = [];
    aiQueue.init({
        storage: {
            readThoughts: async () => recoveryThoughts,
            readThought: async id => recoveryThoughts.find(thought => thought.id === id) || null,
            readThoughtMeta: async id => recoveryMetas[id],
            writeThoughtMeta: async (id, meta) => {
                recoveryMetas[id] = meta;
                recoveryWrites.push({ id, status: meta.status, reason: meta.queuedReason });
            },
            readRelations: async id => ({ id, edges: [] }),
            writeRelations: async () => {},
            readSuppressedRelations: async id => ({ id, edges: [] })
        },
        aiProvider: {
            extract: async () => ({ summary: 'recovered', keywords: ['recover'] }),
            getEmbedding: async () => [1, 0],
            rerankRelations: async () => []
        },
        broadcast: () => {}
    });

    const recovered = await aiQueue.recoverStalePendingMeta({ maxAgeMs: 1000 });
    assert(recovered.queued === 1, 'stale pending recovery should queue old pending meta');
    assert(recovered.skippedFresh === 1, 'stale pending recovery should skip fresh pending meta');
    await sleep(30);
    assert(
        recoveryWrites.some(write => write.id === 'stale-pending' && write.reason === 'recover-pending'),
        'stale pending recovery should mark recovered job reason'
    );

    const insightThoughts = [
        { id: 'insight-source', text: '需要为当前想法生成 AI 思考扩展', tags: ['AI'], subItems: [{ text: '控制 token' }], createdAt: 1 },
        { id: 'insight-target', text: '手动触发可以避免无用 token 消耗', tags: ['AI'], subItems: [], createdAt: 2 },
        { id: 'insight-related', text: 'Markdown 折叠展示需要保留一两行预览', tags: ['UI'], subItems: [], createdAt: 3 }
    ];
    const insightMetas = {
        'insight-source': {
            id: 'insight-source',
            status: 'ready',
            ai: {
                summary: 'AI 思考扩展',
                entities: ['DumbPad'],
                topics: ['AI'],
                keywords: ['token', 'Markdown'],
                tags: ['AI']
            }
        },
        'insight-target': {
            id: 'insight-target',
            status: 'ready',
            ai: {
                summary: '手动触发减少 token',
                entities: ['DumbPad'],
                topics: ['AI'],
                keywords: ['token']
            }
        },
        'insight-related': {
            id: 'insight-related',
            status: 'ready',
            ai: {
                summary: '折叠 Markdown 预览',
                topics: ['UI'],
                keywords: ['Markdown']
            }
        }
    };
    aiQueue.init({
        storage: {
            readThought: async id => insightThoughts.find(thought => thought.id === id) || null,
            readThoughts: async () => insightThoughts,
            readThoughtMeta: async id => insightMetas[id],
            writeThoughtMeta: async (id, meta) => {
                insightMetas[id] = meta;
            },
            readRelations: async id => ({
                id,
                edges: [{
                    targetId: 'insight-target',
                    score: 1,
                    source: 'manual',
                    method: 'manual',
                    relationType: 'manual',
                    reasons: ['用户确认']
                }]
            }),
            getSearchDocuments: async () => [{
                id: 'note-ai',
                type: 'notepad',
                title: 'AI token 设计',
                content: '手动触发 AI insight 可以结合少量已有关联和文章摘要，避免上下文爆炸。',
                updatedAt: 4
            }]
        },
        aiProvider: {
            insightModel: 'insight-model',
            isInsightReady: () => true,
            generateThoughtInsight: async (context) => {
                assert(context.current.id === 'insight-source', 'insight context should include current thought');
                assert(context.relations.length === 1, 'insight context should include confirmed relations');
                assert(context.relations[0].thought.id === 'insight-target', 'insight context should include relation target summary');
                assert(context.relatedThoughts.length <= 3, 'insight context should keep fallback related thoughts bounded');
                assert(context.notepads.length === 1, 'insight context should include bounded notepad snippets');
                assert(context.contextIds.includes('thought:insight-target'), 'insight context should track thought context ids');
                assert(context.contextIds.includes('notepad:note-ai'), 'insight context should track notepad context ids');
                return '**扩展**：先验证最小上下文是否足够。';
            }
        },
        broadcast: () => {}
    });
    const insight = await aiQueue.generateThoughtInsight('insight-source');
    assert(insight.status === 'ready', 'manual insight generation should write ready insight status');
    assert(insight.model === 'insight-model', 'manual insight should record the dedicated model');
    assert(insight.markdown.includes('**扩展**'), 'manual insight should store markdown output');
    assert(insightMetas['insight-source'].status === 'ready', 'manual insight should preserve existing AI meta status');
    assert(insightMetas['insight-source'].insight.contextIds.length >= 2, 'manual insight should store context ids');

    aiQueue.init({
        storage: {
            readThought: async () => insightThoughts[0],
            readThoughtMeta: async () => null,
            writeThoughtMeta: async () => {}
        },
        aiProvider: {
            isInsightReady: () => false
        },
        broadcast: () => {}
    });
    let insightConfigError = null;
    try {
        await aiQueue.generateThoughtInsight('insight-source');
    } catch (error) {
        insightConfigError = error;
    }
    assert(insightConfigError?.code === 'AI_INSIGHT_NOT_CONFIGURED', 'manual insight should require a configured dedicated model');

    let staleThought = { id: 'stale-source', text: '旧内容', tags: ['AI'], subItems: [], version: 1 };
    const staleMetas = {};
    const staleRelationWrites = [];
    aiQueue.init({
        storage: {
            withThoughtWriteLock: async task => task(),
            readThought: async id => id === staleThought.id ? staleThought : null,
            readThoughts: async () => [staleThought],
            readThoughtMeta: async id => staleMetas[id] || null,
            writeThoughtMeta: async (id, meta) => { staleMetas[id] = meta; },
            readRelations: async id => ({ id, edges: [] }),
            writeRelations: async (id, relations) => { staleRelationWrites.push({ id, relations }); },
            readSuppressedRelations: async id => ({ id, edges: [] })
        },
        aiProvider: {
            extract: async () => {
                staleThought = { ...staleThought, text: '新内容', version: 2 };
                return { summary: '旧内容摘要', keywords: ['旧内容'] };
            },
            getEmbedding: async () => [1, 0],
            rerankRelations: async () => []
        },
        broadcast: () => {}
    });
    const staleResult = await aiQueue.processThought('stale-source');
    assert(staleResult.discarded === true, 'AI processing should discard results when Thought analysis input changes');
    assert(staleMetas['stale-source']?.status !== 'ready', 'stale AI processing must not write ready metadata');
    assert(staleRelationWrites.length === 0, 'stale AI processing must not write relations');

    const dedupeThought = { id: 'dedupe-source', text: '需要防止重复 AI 队列', tags: [], subItems: [], version: 1 };
    const dedupeMetas = {};
    let extractCalls = 0;
    let activeExtracts = 0;
    let maxActiveExtracts = 0;
    let releaseFirstExtract;
    const firstExtractStarted = new Promise(resolve => {
        releaseFirstExtract = resolve;
    });
    let signalFirstExtract;
    const firstExtractSignal = new Promise(resolve => { signalFirstExtract = resolve; });
    aiQueue.init({
        storage: {
            withThoughtWriteLock: async task => task(),
            readThought: async id => id === dedupeThought.id ? dedupeThought : null,
            readThoughts: async () => [dedupeThought],
            readThoughtMeta: async id => dedupeMetas[id] || null,
            writeThoughtMeta: async (id, meta) => { dedupeMetas[id] = meta; },
            readRelations: async id => ({ id, edges: [] }),
            writeRelations: async () => {},
            readSuppressedRelations: async id => ({ id, edges: [] })
        },
        aiProvider: {
            extract: async () => {
                extractCalls++;
                activeExtracts++;
                maxActiveExtracts = Math.max(maxActiveExtracts, activeExtracts);
                if (extractCalls === 1) {
                    signalFirstExtract();
                    await firstExtractStarted;
                }
                activeExtracts--;
                return { summary: '重复队列保护', keywords: ['队列'] };
            },
            getEmbedding: async () => [],
            rerankRelations: async () => []
        },
        broadcast: () => {}
    });
    aiQueue.queueThought('dedupe-source', 'manual');
    await firstExtractSignal;
    const deferred = aiQueue.queueThought('dedupe-source', 'manual');
    assert(deferred.deferred === true, 'a manual rerun during processing should be deferred');
    releaseFirstExtract();
    await sleep(50);
    assert(extractCalls === 2, 'a deferred rerun should execute once after the active job');
    assert(maxActiveExtracts === 1, 'the same Thought must not run two AI jobs concurrently');

    const insightDedupeThought = { id: 'insight-dedupe', text: 'Insight 去重', tags: [], subItems: [], version: 1 };
    const insightDedupeMetas = {};
    let insightCalls = 0;
    let releaseInsight;
    const insightRelease = new Promise(resolve => { releaseInsight = resolve; });
    aiQueue.init({
        storage: {
            withThoughtWriteLock: async task => task(),
            readThought: async id => id === insightDedupeThought.id ? insightDedupeThought : null,
            readThoughts: async () => [insightDedupeThought],
            readThoughtMeta: async id => insightDedupeMetas[id] || null,
            writeThoughtMeta: async (id, meta) => { insightDedupeMetas[id] = meta; },
            readRelations: async id => ({ id, edges: [] })
        },
        aiProvider: {
            insightModel: 'insight-model',
            isInsightReady: () => true,
            generateThoughtInsight: async () => {
                insightCalls++;
                await insightRelease;
                return '共享的 insight 结果';
            }
        },
        broadcast: () => {}
    });
    const firstInsight = aiQueue.generateThoughtInsight('insight-dedupe');
    const secondInsight = aiQueue.generateThoughtInsight('insight-dedupe');
    await sleep(0);
    assert(insightCalls === 1, 'concurrent insight requests should share one provider call');
    releaseInsight();
    const [firstInsightResult, secondInsightResult] = await Promise.all([firstInsight, secondInsight]);
    assert(firstInsightResult.markdown === secondInsightResult.markdown, 'shared insight requests should receive the same result');

    console.log('AI queue relations checks passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
