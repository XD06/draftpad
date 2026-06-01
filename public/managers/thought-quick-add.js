export function markCreatedThoughtPending(thought, { now = Date.now() } = {}) {
    return {
        ...thought,
        aiStatus: 'pending',
        aiPendingSince: now
    };
}

export function createLocalPendingThought({ text, tags = [], now = Date.now(), id = `local-${now}` }) {
    return {
        id,
        text,
        tags: [...tags],
        subItems: [],
        completed: false,
        relationCount: 0,
        aiStatus: 'missing',
        localPending: true,
        createdAt: now,
        updatedAt: now
    };
}

export function buildQuickAddCreateOutboxItem({ text, tags = [], tempThought }) {
    return {
        text,
        tags: [...tags],
        subItems: [],
        completed: false,
        tempThought
    };
}
