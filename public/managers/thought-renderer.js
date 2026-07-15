export function filterThoughts(thoughts, { query = '', status = 'all', activeTag = '' } = {}) {
    const normalizedQuery = String(query || '').toLowerCase();
    const normalizedTag = String(activeTag || '').toLowerCase();

    let filtered = Array.isArray(thoughts) ? thoughts.filter(thought => {
        const text = String(thought.text || '').toLowerCase();
        if (text.includes(normalizedQuery)) return true;
        if (Array.isArray(thought.subItems) && thought.subItems.some(item => String(item.text || '').toLowerCase().includes(normalizedQuery))) {
            return true;
        }
        return false;
    }) : [];

    if (status === 'todo') {
        filtered = filtered.filter(thought => !thought.completed);
    } else if (status === 'done') {
        filtered = filtered.filter(thought => thought.completed);
    }

    if (normalizedTag) {
        filtered = filtered.filter(thought => (
            Array.isArray(thought.tags) &&
            thought.tags.some(tag => String(tag || '').toLowerCase() === normalizedTag)
        ));
    }

    return filtered;
}

export function sortThoughts(thoughts) {
    return [...thoughts].sort((a, b) => {
        const aPinned = a.pinned === true;
        const bPinned = b.pinned === true;
        if (aPinned !== bPinned) {
            return aPinned ? -1 : 1;
        }
        if (aPinned && bPinned) {
            return Number(b.pinnedAt || 0) - Number(a.pinnedAt || 0);
        }
        if (a.completed !== b.completed) {
            return a.completed ? 1 : -1;
        }
        return Number(b.createdAt || 0) - Number(a.createdAt || 0)
            || String(b.id || '').localeCompare(String(a.id || ''));
    });
}

export function collectThoughtTags(thoughts, normalizeTag) {
    const tagMap = new Map();
    for (const thought of Array.isArray(thoughts) ? thoughts : []) {
        for (const rawTag of Array.isArray(thought.tags) ? thought.tags : []) {
            const tag = normalizeTag(rawTag);
            if (!tag) continue;
            const key = tag.toLowerCase();
            if (!tagMap.has(key)) tagMap.set(key, tag);
        }
    }
    return Array.from(tagMap.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
