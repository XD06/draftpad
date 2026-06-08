const {
    NoopAIProvider,
    OpenAICompatibleProvider,
    createDefaultProvider,
    createInsightPrompt,
    createPrompt,
    endpoint,
    normalizeInsightMarkdown,
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
    assert(provider.isInsightReady() === false, 'Noop provider should not report insight readiness');
    let noopInsightError = null;
    try {
        await provider.generateThoughtInsight({});
    } catch (error) {
        noopInsightError = error;
    }
    assert(
        noopInsightError?.message.includes('AI insight model is not configured'),
        'Noop provider should reject manual insight generation'
    );

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

    const insightProvider = new OpenAICompatibleProvider({
        chatBaseUrl: 'https://chat.example/v1',
        chatApiKey: 'chat-key',
        chatModel: 'chat-model',
        insightBaseUrl: 'https://insight.example/v1',
        insightApiKey: 'insight-key',
        insightModel: 'insight-model',
        fetchImpl: async (url, options) => {
            assert(url === 'https://insight.example/v1/chat/completions', 'insight endpoint should use the dedicated insight base URL');
            const body = JSON.parse(options.body);
            assert(body.model === 'insight-model', 'insight request should use the dedicated insight model');
            assert(body.model !== 'chat-model', 'insight request should not reuse the chat model');
            assert(body.messages[1].content.includes('不超过 500'), 'insight prompt should include the output length limit');
            return {
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: '**扩展**：可以先验证最小上下文。' } }]
                })
            };
        }
    });
    assert(insightProvider.isInsightReady() === true, 'dedicated insight config should be ready');
    const insight = await insightProvider.generateThoughtInsight({
        current: { text: '当前想法' },
        relations: [],
        relatedThoughts: [],
        notepads: []
    });
    assert(insight.includes('**扩展**'), 'insight generation should return markdown content');

    const missingInsightModelProvider = new OpenAICompatibleProvider({
        chatApiKey: 'chat-key',
        chatModel: 'chat-model',
        insightApiKey: 'insight-key',
        insightModel: ''
    });
    assert(missingInsightModelProvider.isInsightReady() === false, 'insight model must be explicitly configured');
    const reusedModelProvider = new OpenAICompatibleProvider({
        chatApiKey: 'chat-key',
        chatModel: 'same-model',
        insightApiKey: 'insight-key',
        insightModel: 'same-model'
    });
    assert(reusedModelProvider.isInsightReady() === false, 'insight model should not be the same as the chat model');
    assert(
        normalizeInsightMarkdown('```md\n' + '测'.repeat(520) + '\n```').length === 500,
        'insight markdown should be clamped to 500 characters'
    );
    assert(
        createInsightPrompt({ current: { text: '测试' } }).includes('中文 Markdown'),
        'insight prompt should ask for Chinese Markdown'
    );

    const insightOnlyEnv = {
        AI_API_KEY: process.env.AI_API_KEY,
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
        AI_EMBEDDING_API_KEY: process.env.AI_EMBEDDING_API_KEY,
        SILICON_API_KEY: process.env.SILICON_API_KEY
    };
    delete process.env.AI_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.AI_EMBEDDING_API_KEY;
    delete process.env.SILICON_API_KEY;
    const insightOnlyProvider = new OpenAICompatibleProvider({
        chatBaseUrl: 'https://chat.example/v1',
        embeddingBaseUrl: 'https://embedding.example/v1',
        insightBaseUrl: 'https://insight.example/v1',
        insightApiKey: 'insight-key',
        insightModel: 'insight-only-model',
        fetchImpl: async () => {
            throw new Error('insight-only provider should not call chat or embedding APIs for noop fallbacks');
        }
    });
    assert(insightOnlyProvider.isInsightReady() === true, 'insight-only provider should still be ready for manual insight');
    assert(insightOnlyProvider.isChatReady() === false, 'insight-only provider should not report chat readiness');
    assert(insightOnlyProvider.isEmbeddingReady() === false, 'insight-only provider should not report embedding readiness');
    const insightOnlyExtraction = await insightOnlyProvider.extract('test');
    assert(insightOnlyExtraction.intent === 'note', 'missing chat config should fall back to noop extraction');
    const insightOnlyEmbedding = await insightOnlyProvider.getEmbedding('test');
    assert(Array.isArray(insightOnlyEmbedding) && insightOnlyEmbedding.length === 0, 'missing embedding config should fall back to empty embedding');
    const insightOnlyRelations = await insightOnlyProvider.rerankRelations(null, [{ meta: { id: 'noop-target' }, score: 0.8 }]);
    assert(insightOnlyRelations[0].targetId === 'noop-target', 'missing chat config should fall back to noop relation rerank');

    const chatOnlyProvider = new OpenAICompatibleProvider({
        chatBaseUrl: 'https://chat.example/v1',
        chatApiKey: 'chat-key',
        chatModel: 'chat-model',
        fetchImpl: async () => {
            throw new Error('chat-only provider should not call embedding APIs without an embedding key');
        }
    });
    assert(chatOnlyProvider.isChatReady() === true, 'chat-only provider should report chat readiness');
    assert(chatOnlyProvider.isEmbeddingReady() === false, 'chat-only provider should not reuse the chat key for embeddings');
    const chatOnlyEmbedding = await chatOnlyProvider.getEmbedding('test');
    assert(
        Array.isArray(chatOnlyEmbedding) && chatOnlyEmbedding.length === 0,
        'missing embedding key should skip real embeddings even when chat is configured'
    );

    Object.entries(insightOnlyEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });

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
        AI_INSIGHT_API_KEY: process.env.AI_INSIGHT_API_KEY,
        AI_INSIGHT_MODEL: process.env.AI_INSIGHT_MODEL,
        AI_EMBEDDING_API_KEY: process.env.AI_EMBEDDING_API_KEY,
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
        SILICON_API_KEY: process.env.SILICON_API_KEY
    };
    delete process.env.AI_API_KEY;
    delete process.env.AI_INSIGHT_API_KEY;
    delete process.env.AI_INSIGHT_MODEL;
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
