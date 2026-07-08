export function markCreatedThoughtPending(thought, { now = Date.now() } = {}) {
    return {
        ...thought,
        aiStatus: 'pending',
        aiPendingSince: now
    };
}

export function createLocalPendingThought({ text, tags = [], attachments = [], now = Date.now(), id = `local-${now}` }) {
    return {
        id,
        text,
        tags: [...tags],
        subItems: [],
        completed: false,
        pinned: false,
        attachments: [...attachments],
        relationCount: 0,
        aiStatus: 'missing',
        localPending: true,
        createdAt: now,
        updatedAt: now
    };
}

export function buildQuickAddCreateOutboxItem({ text, tags = [], attachments = [], tempThought }) {
    return {
        text,
        tags: [...tags],
        subItems: [],
        completed: false,
        attachments: [...attachments],
        tempThought
    };
}
