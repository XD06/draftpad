const {
    calculateScore,
    findCandidates,
    intentCompatibility
} = require('./scripts/relations-calculator');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const source = {
    id: 'source',
    ai: {
        entities: ['DumbPad', 'S3'],
        topics: ['personal knowledge management', 'sync architecture'],
        intent: 'question',
        keywords: ['local first', 'low resource server'],
        tags: ['architecture'],
        embedding: [1, 0]
    }
};

const strongTarget = {
    id: 'strong',
    ai: {
        entities: ['DumbPad'],
        topics: ['personal knowledge management'],
        intent: 'conclusion',
        keywords: ['local first'],
        tags: ['architecture'],
        embedding: [0.9, 0.1]
    }
};

const weakTarget = {
    id: 'weak',
    ai: {
        entities: ['Unrelated'],
        topics: ['cooking'],
        intent: 'note',
        keywords: ['recipe'],
        tags: ['life'],
        embedding: [0, 1]
    }
};

const legacyTarget = {
    id: 'legacy',
    ai: {
        keywords: ['local first'],
        tags: ['architecture'],
        embedding: [0.8, 0.2]
    }
};

const strongScore = calculateScore(source, strongTarget);
const weakScore = calculateScore(source, weakTarget);
const legacyScore = calculateScore(source, legacyTarget);

assert(strongScore.score > weakScore.score, 'strong target should score above weak target');
assert(strongScore.parts.entity > 0, 'strong score should include entity signal');
assert(strongScore.parts.topic > 0, 'strong score should include topic signal');
assert(strongScore.parts.intent > 0, 'question/conclusion should have intent compatibility');
assert(strongScore.method.includes('entity'), 'method should include entity');
assert(strongScore.method.includes('topic'), 'method should include topic');
assert(legacyScore.score > 0, 'legacy keyword/tag/vector meta should still score');
assert(intentCompatibility('plan', 'task') === 1, 'plan/task should be fully compatible');
assert(intentCompatibility('plan', 'plan') === 0.65, 'same intent should be partially compatible');
assert(intentCompatibility('plan', 'note') === 0, 'unmatched intents should not add signal');

const candidates = findCandidates(source, [weakTarget, strongTarget, legacyTarget], { threshold: 0.01, limit: 3 });
assert(candidates[0].meta.id === 'strong', 'strong target should rank first');
assert(candidates.every(candidate => candidate.signals), 'candidates should expose signals');

const pollutedResource = {
    id: 'polluted-resource',
    ai: {
        entities: ['收集'],
        topics: ['标签管理', '个人知识管理'],
        intent: 'note',
        keywords: ['现有标签', '用户标签', '新建标签'],
        tags: ['收集'],
        embedding: [0, 1]
    }
};
const anotherPollutedResource = {
    id: 'another-polluted-resource',
    ai: {
        entities: ['收集'],
        topics: ['标签管理', '个人知识管理'],
        intent: 'note',
        keywords: ['现有标签', '用户标签', '新建标签'],
        tags: ['收集'],
        embedding: [0, 1]
    }
};
const pollutedScore = calculateScore(pollutedResource, anotherPollutedResource);
assert(pollutedScore.parts.entity === 0, 'low-value entity terms should not create relation signal');
assert(pollutedScore.parts.topic === 0, 'low-value topic terms should not create relation signal');
assert(pollutedScore.parts.keyword === 0, 'low-value keywords should not create relation signal');
assert(pollutedScore.parts.tag === 0, 'generic collection tags should not create relation signal');
assert(pollutedScore.score < 0.45, 'generic tag-management pollution should stay below final relation threshold');

console.log('Relations calculator checks passed');
