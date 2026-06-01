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

    console.log('AI queue relations checks passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
