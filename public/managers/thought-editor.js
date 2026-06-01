export function parseLegacyText(text = '') {
    const lines = String(text || '').split('\n');
    const bodyLines = [];
    const subItems = [];
    lines.forEach((line, index) => {
        const match = line.match(/^- \[([ x])\]\s+(.*)/);
        if (match) {
            subItems.push({
                id: `legacy_${index}`,
                text: match[2],
                completed: match[1] === 'x'
            });
        } else {
            bodyLines.push(line);
        }
    });
    return { bodyText: bodyLines.join('\n'), subItems };
}

export function createSubItem(text, { completed = false, id = createSubItemId() } = {}) {
    return {
        id,
        text: String(text || '').trim(),
        completed: completed === true
    };
}

export function createSubItemId() {
    return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

export function cleanSubItems(subItems = []) {
    return subItems
        .filter(item => String(item.text || '').trim())
        .map(item => createSubItem(item.text, {
            id: item.id && !item.id.startsWith('new_') && !item.id.startsWith('legacy_')
                ? item.id
                : createSubItemId(),
            completed: item.completed
        }));
}

export function sortSubItems(subItems = []) {
    return [...subItems].sort((a, b) => {
        if (a.completed !== b.completed) {
            return a.completed ? 1 : -1;
        }
        return 0;
    });
}

export function assignRealSubItemIds(subItems = []) {
    return subItems.map(item => ({
        ...item,
        id: item.id && !item.id.startsWith('legacy_') && !item.id.startsWith('new_')
            ? item.id
            : createSubItemId()
    }));
}
