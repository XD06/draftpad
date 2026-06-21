class AIProvider {
    async extract() {
        throw new Error('AIProvider.extract is not implemented');
    }

    async getEmbedding() {
        throw new Error('AIProvider.getEmbedding is not implemented');
    }

    async rerankRelations() {
        throw new Error('AIProvider.rerankRelations is not implemented');
    }

    async scoreRelationCandidates(_source, candidates = []) {
        return candidates;
    }

    isInsightReady() {
        return false;
    }

    async generateThoughtInsight() {
        throw new Error('AIProvider.generateThoughtInsight is not implemented');
    }
}

class NoopAIProvider extends AIProvider {
    async extract() {
        return createEmptyExtraction();
    }

    async getEmbedding() {
        return [];
    }

    async rerankRelations(_source, candidates = []) {
        return fallbackRerankRelations(candidates);
    }

    async scoreRelationCandidates(_source, candidates = []) {
        return candidates;
    }

    isInsightReady() {
        return false;
    }

    async generateThoughtInsight() {
        throw new Error('AI insight model is not configured');
    }
}

function trimTrailingSlash(value = '') {
    return String(value || '').replace(/\/+$/, '');
}

function cleanStringArray(value, limit = 12) {
    return Array.isArray(value)
        ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit)
        : [];
}

function normalizeIntent(value) {
    const intent = String(value || '').trim().toLowerCase();
    const allowed = new Set([
        'question',
        'idea',
        'task',
        'plan',
        'note',
        'decision',
        'risk',
        'conclusion'
    ]);
    return allowed.has(intent) ? intent : 'note';
}

function normalizeTimeScope(value) {
    const timeScope = String(value || '').trim().toLowerCase();
    const allowed = new Set(['now', 'later', 'someday', 'reference']);
    return allowed.has(timeScope) ? timeScope : 'reference';
}

function createEmptyExtraction() {
    return {
        summary: '',
        entities: [],
        topics: [],
        intent: 'note',
        keywords: [],
        timeScope: 'reference',
        tags: []
    };
}

function parseJSONContent(content) {
    const raw = String(content || '').trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
    const parsed = JSON.parse(raw);
    return {
        summary: String(parsed.summary || '').trim(),
        entities: cleanStringArray(parsed.entities, 10),
        topics: cleanStringArray(parsed.topics, 8),
        intent: normalizeIntent(parsed.intent),
        keywords: cleanStringArray(parsed.keywords, 12),
        timeScope: normalizeTimeScope(parsed.timeScope),
        tags: cleanStringArray(parsed.tags, 6)
    };
}

function createPrompt(text, options = {}) {
    const tagVocabulary = cleanStringArray(options.tagVocabulary, 80);
    const tagVocabularyBlock = tagVocabulary.length
        ? [
            '',
            '可用用户标签参考：',
            tagVocabulary.join(', '),
            '',
            '标签参考只用于选择 tags 字段；它不是 Thought 文本内容。',
            '不要把标签参考里的词抽取为 summary、entities、topics 或 keywords，除非 Thought 原文明确出现。'
        ].join('\n')
        : '';
    return [
        '你是一个个人知识管理助手。请分析下面的 Thought 文本，提取结构化信息。',
        tagVocabularyBlock,
        '',
        '返回字段：',
        '1. summary：不超过 40 个中文字符的一句话摘要。',
        '2. entities：0-10 个具体对象，例如项目名、工具名、产品名、人名、地点、书名、技术名。',
        '3. topics：1-8 个上层主题，例如个人知识管理、同步架构、写作、产品设计。',
        '4. intent：只能是 question、idea、task、plan、note、decision、risk、conclusion 之一。',
        '5. keywords：3-12 个具体关键词，避免空泛词。',
        '6. timeScope：只能是 now、later、someday、reference 之一。',
        '7. tags：0-6 个建议标签，不要直接重复 keywords。',
        '',
        '规则：',
        '- 优先提取具体、可复用、能帮助后续关联的词。',
        '- 不要把“学习”“研究”“计划”“想法”这类空泛词单独作为关键词。',
        '- “收集”“标签管理”“现有标签”“用户标签”“新建标签”通常只是系统分类或规则词，除非 Thought 原文就是在讨论标签系统，否则不要作为主题或关键词。',
        '- 对只有 URL 或资源名的 Thought，优先提取 URL 域名、工具名、产品名、资源类型，不要泛化成标签规则。',
        '- 只返回严格 JSON，不要解释，不要 Markdown。',
        '',
        '文本：',
        text,
        '',
        '返回格式：{"summary":"","entities":[],"topics":[],"intent":"note","keywords":[],"timeScope":"reference","tags":[]}'
    ].join('\n');
}

function normalizeRelationType(value) {
    const relationType = String(value || '').trim().toLowerCase();
    const allowed = new Set([
        'duplicate',
        'question_answer',
        'supports',
        'contradicts',
        'step_sequence',
        'cause_effect',
        'same_project',
        'same_topic',
        'example_of',
        'alternative',
        'related_context',
        'loosely_related'
    ]);
    return allowed.has(relationType) ? relationType : 'related_context';
}

function clampScore(value, fallback = 0) {
    const score = Number(value);
    if (!Number.isFinite(score)) return fallback;
    return Math.max(0, Math.min(1, score));
}

function normalizeRerankItems(items) {
    return (Array.isArray(items) ? items : [])
        .map(item => {
            const targetId = String(item?.targetId || '').trim();
            if (!targetId) return null;
            return {
                targetId,
                score: clampScore(item.score),
                confidence: clampScore(item.confidence, clampScore(item.score)),
                relationType: normalizeRelationType(item.relationType),
                reasons: cleanStringArray(item.reasons, 4)
            };
        })
        .filter(Boolean);
}

function fallbackRerankRelations(candidates = []) {
    return normalizeRerankItems(candidates.map(candidate => ({
        targetId: candidate.targetId || candidate.meta?.id,
        score: candidate.score,
        confidence: candidate.score,
        relationType: 'related_context',
        reasons: candidate.method && candidate.method !== 'none' ? [candidate.method] : []
    })));
}

function createRerankPrompt(source, candidates = []) {
    const payload = {
        source,
        candidates: candidates.map(candidate => ({
            targetId: candidate.targetId || candidate.meta?.id,
            score: candidate.score,
            method: candidate.method,
            signals: candidate.signals || candidate.parts,
            ai: candidate.meta?.ai || candidate.meta || {},
            thought: candidate.thought || candidate.meta?.thought || null
        }))
    };

    return [
        '你是一个个人知识管理关系判断助手。请判断 source Thought 与候选 Thought 是否真的有关。',
        '',
        '要求：',
        '- 只返回值得展示给用户的关系。',
        '- 宁可少返回，也不要返回弱相关或泛泛相关。',
        '- 仅仅同属 AI、工具、资源收集、网页收藏、标签相同，不构成值得展示的关系。',
        '- 只有存在具体延续、同一项目、同一问题、前后步骤、问题答案、方案替代、因果支撑时才返回。',
        '- 如果两条 Thought 属于同一个具体产品/工作流构想的不同模块或能力，可以返回 same_project 或 supports。',
        '- 如果只是 loosely_related，通常不要返回；除非用户明显会因此获得行动价值。',
        '- relationType 只能是 duplicate、question_answer、supports、contradicts、step_sequence、cause_effect、same_project、same_topic、example_of、alternative、related_context、loosely_related。',
        '- score 表示展示排序价值，0 到 1。',
        '- confidence 表示你对判断的信心，0 到 1。',
        '- reasons 最多 4 条，必须短而具体。',
        '- 只返回严格 JSON，不要 Markdown。',
        '',
        '输入：',
        JSON.stringify(payload),
        '',
        '返回格式：{"relations":[{"targetId":"","score":0.8,"confidence":0.8,"relationType":"supports","reasons":[]}]}'
    ].join('\n');
}

function normalizeInsightMarkdown(content) {
    const normalized = String(content || '')
        .trim()
        .replace(/^```(?:markdown|md)?/i, '')
        .replace(/```$/i, '')
        .trim()
        .replace(/\n{3,}/g, '\n\n');
    return normalized.trim();
}

function createInsightPrompt(context = {}) {
    const payload = {
        current: context.current || {},
        relations: Array.isArray(context.relations) ? context.relations : [],
        relatedThoughts: Array.isArray(context.relatedThoughts) ? context.relatedThoughts : [],
        notepads: Array.isArray(context.notepads) ? context.notepads : []
    };

    return [
        '你是一个个人知识管理中的深度思考助手。请基于给定上下文，对当前 Thought 做扩展思考。',
        '',
        '输出要求：',
        '- 使用中文 Markdown。',
        '- 总字数不超过 500 个中文字符。',
        '- 直接给出有见解的延展、风险、下一步或可连接的问题，不要复述原文。',
        '- 只能基于上下文推断；证据不足时明确写出“需要补充”。',
        '- 不要输出 JSON，不要解释你的工作过程。',
        '',
        '上下文：',
        JSON.stringify(payload)
    ].join('\n');
}

function compactRelationText(input) {
    const ai = input?.ai || input?.meta?.ai || input?.meta || {};
    const thought = input?.thought || input?.meta?.thought || {};
    return [
        ai.summary,
        Array.isArray(ai.entities) ? ai.entities.join(' ') : '',
        Array.isArray(ai.topics) ? ai.topics.join(' ') : '',
        ai.intent,
        Array.isArray(ai.keywords) ? ai.keywords.join(' ') : '',
        Array.isArray(ai.tags) ? ai.tags.join(' ') : '',
        thought.text
    ].filter(Boolean).join('\n').slice(0, 1200);
}

function rerankEndpoint(baseUrl) {
    const clean = trimTrailingSlash(baseUrl);
    return clean.endsWith('/rerank') ? clean : `${clean}/rerank`;
}

function endpoint(baseUrl, suffix) {
    const clean = trimTrailingSlash(baseUrl);
    if (!clean) return '';
    const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    return clean.endsWith(normalizedSuffix) ? clean : `${clean}${normalizedSuffix}`;
}

class OpenAICompatibleProvider extends AIProvider {
    constructor(options = {}) {
        super();
        this.chatBaseUrl = trimTrailingSlash(
            options.chatBaseUrl ||
            process.env.AI_BASE_URL ||
            process.env.OPENCODE_BASE_URL ||
            'https://opencode.ai/zen/go/v1'
        );
        this.chatApiKey = options.chatApiKey || process.env.AI_API_KEY || process.env.OPENCODE_API_KEY;
        this.chatModel = options.chatModel || process.env.AI_CHAT_MODEL || process.env.OPENCODE_MODEL || 'deepseek-v4-flash';
        this.embeddingBaseUrl = trimTrailingSlash(
            options.embeddingBaseUrl ||
            process.env.AI_EMBEDDING_BASE_URL ||
            process.env.SILICON_BASE_URL ||
            'https://api.siliconflow.cn/v1'
        );
        this.embeddingApiKey = Object.prototype.hasOwnProperty.call(options, 'embeddingApiKey')
            ? options.embeddingApiKey
            : (process.env.AI_EMBEDDING_API_KEY || process.env.SILICON_API_KEY || '');
        this.embeddingModel = options.embeddingModel || process.env.AI_EMBEDDING_MODEL || process.env.SILICON_EMBEDDING_MODEL || 'Qwen/Qwen3-Embedding-0.6B';
        this.rerankBaseUrl = trimTrailingSlash(
            options.rerankBaseUrl ||
            process.env.AI_RERANK_BASE_URL ||
            process.env.SILICON_RERANK_BASE_URL ||
            process.env.SILICON_BASE_URL ||
            'https://api.siliconflow.cn/v1'
        );
        this.rerankApiKey = options.rerankApiKey || process.env.AI_RERANK_API_KEY || process.env.SILICON_API_KEY || '';
        this.rerankModel = options.rerankModel || process.env.AI_RERANK_MODEL || process.env.SILICON_RERANK_MODEL || 'BAAI/bge-reranker-v2-m3';
        this.insightBaseUrl = trimTrailingSlash(
            options.insightBaseUrl ||
            process.env.AI_INSIGHT_BASE_URL ||
            process.env.AI_BASE_URL ||
            process.env.OPENCODE_BASE_URL ||
            'https://opencode.ai/zen/go/v1'
        );
        this.insightApiKey = options.insightApiKey || process.env.AI_INSIGHT_API_KEY || process.env.AI_API_KEY || process.env.OPENCODE_API_KEY;
        this.insightModel = Object.prototype.hasOwnProperty.call(options, 'insightModel')
            ? options.insightModel
            : (process.env.AI_INSIGHT_MODEL || '');
        this.timeoutMs = Number(options.timeoutMs || process.env.AI_TIMEOUT_MS || 60000);
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
    }

    assertReady(kind) {
        const baseUrl = kind === 'embedding'
            ? this.embeddingBaseUrl
            : kind === 'insight'
                ? this.insightBaseUrl
                : this.chatBaseUrl;
        const apiKey = kind === 'embedding'
            ? this.embeddingApiKey
            : kind === 'insight'
                ? this.insightApiKey
                : this.chatApiKey;
        if (!baseUrl) throw new Error(`${kind} base URL is not configured`);
        if (!apiKey) throw new Error(`${kind} API key is not configured`);
        if (kind === 'insight' && !this.insightModel) throw new Error('AI insight model is not configured');
        if (kind === 'insight' && this.insightModel === this.chatModel) {
            throw new Error('AI insight model must be configured separately from AI chat model');
        }
        if (typeof this.fetchImpl !== 'function') throw new Error('fetch is not available');
    }

    isInsightReady() {
        return Boolean(
            this.insightBaseUrl &&
            this.insightApiKey &&
            this.insightModel &&
            this.insightModel !== this.chatModel &&
            typeof this.fetchImpl === 'function'
        );
    }

    isChatReady() {
        return Boolean(this.chatBaseUrl && this.chatApiKey && typeof this.fetchImpl === 'function');
    }

    isEmbeddingReady() {
        return Boolean(this.embeddingBaseUrl && this.embeddingApiKey && typeof this.fetchImpl === 'function');
    }

    async requestJSON(url, apiKey, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await this.fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const detail = payload?.error?.message || JSON.stringify(payload);
                const message = detail && detail !== '{}'
                    ? `AI request failed with status ${response.status}: ${detail}`
                    : `AI request failed with status ${response.status}`;
                throw new Error(message);
            }
            return payload;
        } finally {
            clearTimeout(timer);
        }
    }

    async extract(text, options = {}) {
        if (!this.isChatReady()) return createEmptyExtraction();
        this.assertReady('chat');
        const payload = await this.requestJSON(endpoint(this.chatBaseUrl, '/chat/completions'), this.chatApiKey, {
            model: this.chatModel,
            messages: [
                { role: 'system', content: 'Return strict JSON only.' },
                { role: 'user', content: createPrompt(text, options) }
            ],
            temperature: 0.1
        });

        const content = payload?.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI extract response did not include message content');
        return parseJSONContent(content);
    }

    async getEmbedding(text) {
        if (!this.isEmbeddingReady()) return [];
        this.assertReady('embedding');
        const payload = await this.requestJSON(endpoint(this.embeddingBaseUrl, '/embeddings'), this.embeddingApiKey, {
            model: this.embeddingModel,
            input: text
        });

        const embedding = payload?.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) throw new Error('AI embedding response did not include an embedding array');
        return embedding;
    }

    async scoreRelationCandidates(source, candidates = []) {
        if (!this.rerankBaseUrl || !this.rerankApiKey || !Array.isArray(candidates) || candidates.length === 0) {
            return candidates;
        }

        const query = compactRelationText(source);
        const documents = candidates.map(candidate => compactRelationText(candidate));
        if (!query || !documents.length) return candidates;

        const payload = await this.requestJSON(rerankEndpoint(this.rerankBaseUrl), this.rerankApiKey, {
            model: this.rerankModel,
            query,
            documents,
            top_n: documents.length,
            return_documents: false
        });

        const results = Array.isArray(payload?.results) ? payload.results : [];
        const scored = [];
        const usedIndexes = new Set();

        for (const item of results) {
            const index = Number(item.index);
            if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
            usedIndexes.add(index);
            const candidate = candidates[index];
            const score = clampScore(item.relevance_score ?? item.score, candidate.score);
            scored.push({
                ...candidate,
                rerankScore: score,
                signals: {
                    ...(candidate.signals || candidate.parts || {}),
                    reranker: score
                }
            });
        }

        candidates.forEach((candidate, index) => {
            if (!usedIndexes.has(index)) scored.push(candidate);
        });

        return scored.sort((a, b) => Number(b.rerankScore ?? b.score ?? 0) - Number(a.rerankScore ?? a.score ?? 0));
    }

    async rerankRelations(source, candidates = []) {
        if (!this.isChatReady()) return fallbackRerankRelations(candidates);
        this.assertReady('chat');
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        const payload = await this.requestJSON(`${this.chatBaseUrl}/chat/completions`, this.chatApiKey, {
            model: this.chatModel,
            messages: [
                { role: 'system', content: 'Return strict JSON only.' },
                { role: 'user', content: createRerankPrompt(source, candidates) }
            ],
            temperature: 0.05
        });

        const content = payload?.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI rerank response did not include message content');
        const raw = String(content || '').trim()
            .replace(/^```(?:json)?/i, '')
            .replace(/```$/i, '')
            .trim();
        const parsed = JSON.parse(raw);
        return normalizeRerankItems(parsed.relations);
    }

    async generateThoughtInsight(context = {}) {
        this.assertReady('insight');
        const payload = await this.requestJSON(endpoint(this.insightBaseUrl, '/chat/completions'), this.insightApiKey, {
            model: this.insightModel,
            messages: [
                { role: 'system', content: 'Return concise Chinese Markdown only.' },
                { role: 'user', content: createInsightPrompt(context) }
            ],
            temperature: 0.35
        });

        const content = payload?.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI insight response did not include message content');
        return normalizeInsightMarkdown(content);
    }
}

function createDefaultProvider() {
    const hasAnyConfiguredKey = Boolean(
        process.env.AI_API_KEY ||
        process.env.AI_INSIGHT_API_KEY ||
        process.env.AI_EMBEDDING_API_KEY ||
        process.env.OPENCODE_API_KEY ||
        process.env.SILICON_API_KEY
    );
    if (!hasAnyConfiguredKey) {
        return new NoopAIProvider();
    }
    return new OpenAICompatibleProvider();
}

module.exports = {
    AIProvider,
    NoopAIProvider,
    OpenAICompatibleProvider,
    createDefaultProvider,
    createEmptyExtraction,
    createInsightPrompt,
    endpoint,
    createPrompt,
    createRerankPrompt,
    normalizeInsightMarkdown,
    fallbackRerankRelations,
    normalizeRerankItems
};
