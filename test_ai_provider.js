const {
    NoopAIProvider,
    OpenAICompatibleProvider,
    createDefaultProvider,
    createPrompt,
    endpoint,
    normalizeRerankItems
} = require('./scripts/ai-provider');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function run() {
    const provider = new NoopAIProvider();
    const extraction = await provider.extract('DumbPad local first AI relations');
    assert(Array.isArray(extraction.entities), 'Noop extraction should include entities array');
    assert(Array.isArray(extraction.topics), 'Noop extraction should include topics array');
    assert(extraction.intent === 'note', 'Noop extraction should include default intent');
    assert(extraction.timeScope === 'reference', 'Noop extraction should include default timeScope');

    const reranked = await provider.rerankRelations(null, [
        { meta: { id: 'a' }, score: 0.75, method: 'entity+topic' },
        { targetId: 'b', score: 2, method: 'vector' }
    ]);

    assert(reranked.length === 2, 'Noop rerank should return candidates');
    assert(reranked[0].targetId === 'a', 'Noop rerank should use meta id');
    assert(reranked[0].relationType === 'related_context', 'Noop rerank should set a safe relation type');
    assert(reranked[1].score === 1, 'Rerank score should be clamped');

    const normalized = normalizeRerankItems([
        { targetId: 'x', score: -1, confidence: 9, relationType: 'unknown', reasons: ['one', 'two', 'three', 'four', 'five'] },
        { targetId: '', score: 0.5 }
    ]);

    assert(normalized.length === 1, 'Rerank normalization should drop missing target ids');
    assert(normalized[0].score === 0, 'Rerank normalization should clamp low score');
    assert(normalized[0].confidence === 1, 'Rerank normalization should clamp high confidence');
    assert(normalized[0].relationType === 'related_context', 'Rerank normalization should default unknown relation type');
    assert(normalized[0].reasons.length === 4, 'Rerank normalization should limit reasons');

    const rerankProvider = new OpenAICompatibleProvider({
        chatBaseUrl: 'https://chat.example/v1',
        chatApiKey: 'chat-key',
        rerankBaseUrl: 'https://rerank.example/v1',
        rerankApiKey: 'rerank-key',
        rerankModel: 'rerank-model',
        fetchImpl: async (url, options) => {
            assert(url === 'https://rerank.example/v1/rerank', 'rerank endpoint should append /rerank');
            const body = JSON.parse(options.body);
            assert(body.model === 'rerank-model', 'rerank request should include model');
            assert(body.documents.length === 2, 'rerank request should include documents');
            return {
                ok: true,
                json: async () => ({
                    results: [
                        { index: 1, relevance_score: 0.93 },
                        { index: 0, relevance_score: 0.51 }
                    ]
                })
            };
        }
    });
    const scored = await rerankProvider.scoreRelationCandidates(
        { ai: { summary: 'source', keywords: ['local first'] } },
        [
            { meta: { id: 'a', ai: { summary: 'weak' } }, score: 0.2, signals: {} },
            { meta: { id: 'b', ai: { summary: 'strong' } }, score: 0.3, signals: {} }
        ]
    );
    assert(scored[0].meta.id === 'b', 'dedicated reranker should reorder candidates');
    assert(scored[0].signals.reranker === 0.93, 'dedicated reranker score should be stored in signals');
    assert(endpoint('https://chat.example/v1/chat/completions', '/chat/completions') === 'https://chat.example/v1/chat/completions', 'full chat endpoint should not be appended twice');
    assert(endpoint('https://api.siliconflow.cn/v1/embeddings', '/embeddings') === 'https://api.siliconflow.cn/v1/embeddings', 'full embedding endpoint should not be appended twice');

    const failingEmbeddingProvider = new OpenAICompatibleProvider({
        embeddingBaseUrl: 'https://embedding.example/v1',
        embeddingApiKey: 'embedding-key',
        embeddingModel: 'bad-embedding-model',
        fetchImpl: async () => ({
            ok: false,
            status: 500,
            json: async () => ({ data: null })
        })
    });
    let embeddingError = null;
    try {
        await failingEmbeddingProvider.getEmbedding('test');
    } catch (error) {
        embeddingError = error;
    }
    assert(
        embeddingError?.message.includes('AI request failed with status 500: {"data":null}'),
        'embedding failures should include the provider response body'
    );
    const prompt = createPrompt('tag context test', { tagVocabulary: ['DumbPad', 'AI关联'] });
    assert(prompt.includes('可用用户标签参考'), 'prompt should include user tag context when available');
    assert(prompt.includes('DumbPad') && prompt.includes('AI关联'), 'prompt should include existing tag values');
    assert(
        prompt.indexOf('可用用户标签参考') < prompt.indexOf('文本：'),
        'tag vocabulary should not be placed inside the thought text section'
    );
    assert(
        prompt.includes('它不是 Thought 文本内容'),
        'prompt should explicitly prevent tag vocabulary from contaminating extraction'
    );

    const previousEnv = {
        AI_API_KEY: process.env.AI_API_KEY,
        AI_EMBEDDING_API_KEY: process.env.AI_EMBEDDING_API_KEY,
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
        SILICON_API_KEY: process.env.SILICON_API_KEY
    };
    delete process.env.AI_API_KEY;
    delete process.env.AI_EMBEDDING_API_KEY;
    process.env.OPENCODE_API_KEY = 'opencode-test-key';
    process.env.SILICON_API_KEY = 'silicon-test-key';
    const defaultProvider = createDefaultProvider();
    assert(defaultProvider instanceof OpenAICompatibleProvider, 'OPENCODE_API_KEY/SILICON_API_KEY should enable real provider');
    assert(defaultProvider.chatModel === 'deepseek-v4-flash', 'default chat model should match ai_config.txt');
    assert(defaultProvider.embeddingModel === 'Qwen/Qwen3-Embedding-0.6B', 'default embedding model should use the current SiliconFlow-compatible embedding model');
    Object.entries(previousEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });

    console.log('AI provider checks passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
