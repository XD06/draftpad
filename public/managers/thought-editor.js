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

export function getEditableThoughtParts(thought = {}) {
    let subtasks = Array.isArray(thought.subItems)
        ? thought.subItems.map(item => ({ ...item }))
        : [];
    let bodyText = String(thought.text || '');

    if (subtasks.length === 0 && /^- \[[ x]\]/m.test(bodyText)) {
        const parsed = parseLegacyText(bodyText);
        subtasks = parsed.subItems;
        bodyText = parsed.bodyText;
    }

    return { bodyText, subtasks };
}

export function renderSubtaskEditRow(subtask, escapeHtml) {
    const item = subtask || {};
    return `
                    <input type="checkbox" class="subtask-check" ${item.completed ? 'checked' : ''}>
                    <input type="text" class="subtask-edit-input" value="${escapeHtml(item.text || '')}">
                    <button class="subtask-delete-btn" title="删除">×</button>
                `;
}

export function renderSubtaskAddRow() {
    return '<span class="subtask-add-btn">+ 添加子任务</span>';
}

export function renderSubtaskInlineAddRow() {
    return '<input type="checkbox" class="subtask-check" disabled><input type="text" class="subtask-inline-input" placeholder="新增子任务...">';
}

export function appendLocalSubItem(thought, text) {
    const subItem = createSubItem(text);
    thought.subItems = Array.isArray(thought.subItems) ? [...thought.subItems, subItem] : [subItem];
    return subItem;
}

export function applyLocalSubItemTextEdit(thought, subId, text) {
    const newText = String(text || '').trim();
    if (!newText) {
        thought.subItems = (thought.subItems || []).filter(item => item.id !== subId);
        return { action: 'delete', text: newText };
    }

    const subItem = (thought.subItems || []).find(item => item.id === subId);
    if (subItem) subItem.text = newText;
    return { action: 'update', text: newText };
}

export function toggleLocalSubItemCompletion(thought, subId) {
    const subItem = (thought.subItems || []).find(item => item.id === subId);
    if (!subItem) return false;
    subItem.completed = !subItem.completed;
    return true;
}

export function migrateAndToggleLegacySubItem(thought, subId) {
    if (!subId || !subId.startsWith('legacy_') || (thought.subItems || []).length > 0) return false;
    const { bodyText, subItems } = parseLegacyText(thought.text);
    const target = subItems.find(item => item.id === subId);
    if (!target) return false;

    target.completed = !target.completed;
    thought.text = bodyText;
    thought.subItems = assignRealSubItemIds(subItems);
    return true;
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
