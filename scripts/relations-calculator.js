function asArray(value) {
    return Array.isArray(value) ? value : [];
}

const LOW_VALUE_RELATION_TERMS = new Set([
    '收集',
    '标签',
    '标签管理',
    '标签策略',
    '分类系统',
    '知识管理',
    '个人知识管理',
    '现有标签',
    '用户标签',
    '新建标签',
    '已有标签',
    '标签规则',
    '规则',
    '使用规则',
    '参考笔记',
    'note'
]);

function normalizeTerms(value, { filterLowValue = true } = {}) {
    return asArray(value)
        .map(item => String(item || '').trim().toLowerCase())
        .filter(Boolean)
        .filter(term => !filterLowValue || !LOW_VALUE_RELATION_TERMS.has(term));
}

function aiOf(meta) {
    return meta?.ai || meta || {};
}

function cosineSimilarity(vecA, vecB) {
    const a = asArray(vecA);
    const b = asArray(vecB);
    if (!a.length || a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        const x = Number(a[i]);
        const y = Number(b[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
        dot += x * y;
        normA += x * x;
        normB += y * y;
    }

    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function overlap(a, b) {
    const left = new Set(normalizeTerms(a));
    const right = new Set(normalizeTerms(b));
    if (!left.size || !right.size) return 0;

    let matches = 0;
    for (const term of left) {
        if (right.has(term)) matches++;
    }

    return matches / Math.max(left.size, right.size);
}

function keywordOverlap(a, b) {
    return overlap(a, b);
}

function tagOverlap(a, b) {
    const score = overlap(a, b);
    return score >= 0.5 ? score : 0;
}

function entityOverlap(a, b) {
    return overlap(a, b);
}

function topicOverlap(a, b) {
    return overlap(a, b);
}

function intentCompatibility(a, b) {
    const left = String(a || '').trim().toLowerCase();
    const right = String(b || '').trim().toLowerCase();
    if (!left || !right) return 0;
    if (left === right) return 0.65;

    const pairs = new Set([
        'question:conclusion',
        'question:note',
        'question:decision',
        'idea:plan',
        'idea:task',
        'plan:task',
        'risk:decision',
        'risk:plan',
        'decision:conclusion'
    ]);

    return pairs.has(`${left}:${right}`) || pairs.has(`${right}:${left}`) ? 1 : 0;
}

function calculateScore(metaA, metaB) {
    const a = aiOf(metaA);
    const b = aiOf(metaB);

    const vector = cosineSimilarity(a.embedding, b.embedding);
    const keyword = keywordOverlap(a.keywords, b.keywords);
    const tag = tagOverlap(a.tags, b.tags);
    const entity = entityOverlap(a.entities, b.entities);
    const topic = topicOverlap(a.topics, b.topics);
    const intent = intentCompatibility(a.intent, b.intent);
    const score = (
        (0.34 * vector) +
        (0.18 * keyword) +
        (0.04 * tag) +
        (0.22 * entity) +
        (0.12 * topic) +
        (0.10 * intent)
    );
    const methodParts = [];

    if (entity > 0) methodParts.push('entity');
    if (topic > 0) methodParts.push('topic');
    if (intent > 0) methodParts.push('intent');
    if (keyword > 0) methodParts.push('keyword');
    if (tag > 0) methodParts.push('tag');
    if (vector > 0) methodParts.push('vector');

    return {
        score,
        method: methodParts.length ? methodParts.join('+') : 'none',
        parts: { vector, keyword, tag, entity, topic, intent },
        signals: { vector, keyword, tag, entity, topic, intent }
    };
}

function findCandidates(currentMeta, allMetas, options = {}) {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.25;
    const limit = Number.isFinite(options.limit) ? options.limit : 15;
    const currentId = currentMeta?.id;

    return asArray(allMetas)
        .filter(meta => meta && meta.id !== currentId)
        .map(meta => {
            const result = calculateScore(currentMeta, meta);
            return { meta, ...result };
        })
        .filter(candidate => candidate.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

module.exports = {
    cosineSimilarity,
    keywordOverlap,
    tagOverlap,
    entityOverlap,
    topicOverlap,
    intentCompatibility,
    calculateScore,
    findCandidates
};
