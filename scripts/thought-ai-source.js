const crypto = require('crypto');

function normalizeAnalysisInput(thought = {}) {
    return {
        text: String(thought.text || ''),
        subItems: Array.isArray(thought.subItems)
            ? thought.subItems.map(item => String(item?.text || ''))
            : [],
        tags: Array.isArray(thought.tags)
            ? thought.tags.map(tag => String(tag || '').trim())
            : []
    };
}

function createAnalysisSourceSignature(thought = {}) {
    const input = normalizeAnalysisInput(thought);
    const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(input))
        .digest('hex');
    return {
        version: Number(thought.version || 0),
        hash
    };
}

function hasSameAnalysisSource(thought, signature) {
    if (!thought || !signature?.hash) return false;
    return createAnalysisSourceSignature(thought).hash === signature.hash;
}

module.exports = {
    normalizeAnalysisInput,
    createAnalysisSourceSignature,
    hasSameAnalysisSource
};
