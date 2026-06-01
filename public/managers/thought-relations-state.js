export function normalizeRelationCount(value, fallback = 0) {
    const count = Number(value);
    if (Number.isFinite(count)) return Math.max(0, count);
    return Math.max(0, Number(fallback || 0));
}

export function applyManualRelationCreated(thought, relationCount) {
    if (!thought) return 0;
    const nextCount = normalizeRelationCount(relationCount, thought.relationCount);
    thought.relationCount = nextCount;
    thought.aiStatus = 'ready';
    return nextCount;
}

export function applyManualRelationCreateFailure(thought) {
    if (!thought) return 0;
    thought.localPending = true;
    thought.relationCount = normalizeRelationCount(Number(thought.relationCount || 0) + 1);
    return thought.relationCount;
}

export function applyRelationDeleted(thought, relationCount) {
    if (!thought) return 0;
    const fallback = Math.max(0, Number(thought.relationCount || 0) - 1);
    thought.relationCount = normalizeRelationCount(relationCount, fallback);
    return thought.relationCount;
}

export function applyRelationDeleteFailure(thought) {
    if (!thought) return 0;
    thought.localPending = true;
    thought.relationCount = Math.max(0, Number(thought.relationCount || 0) - 1);
    return thought.relationCount;
}
