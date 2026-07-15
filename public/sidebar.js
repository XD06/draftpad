const RECENTS_KEY = 'dumbpad_recents';
const COLLAPSED_KEY = 'dumbpad_collapsed_days';
const MAX_RECENTS = 8;

function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function getPadTime(pad) {
    return Number(pad.updatedAt || pad.createdAt || Date.now());
}

function compareByNewest(left, right, ...fields) {
    for (const field of fields) {
        const leftTime = Number(left?.[field] || 0);
        const rightTime = Number(right?.[field] || 0);
        if (leftTime !== rightTime) return rightTime - leftTime;
    }
    return String(left?.id || '').localeCompare(String(right?.id || ''));
}

function readRecents() {
    try {
        const value = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

export function getRecentNotepadId(notepads = []) {
    const ids = new Set(notepads.map(notepad => notepad?.id).filter(Boolean));
    return readRecents()
        .filter(item => item?.id && ids.has(item.id))
        .sort((left, right) => Number(right.touchedAt || 0) - Number(left.touchedAt || 0))[0]?.id || null;
}

export function getPinnedNotepadId(notepads = []) {
    return [...notepads]
        .filter(notepad => notepad?.pinned === true)
        .sort((left, right) => compareByNewest(left, right, 'pinnedAt', 'updatedAt', 'createdAt'))[0]?.id || null;
}

export function getNewestCreatedNotepadId(notepads = []) {
    return [...notepads]
        .sort((left, right) => compareByNewest(left, right, 'createdAt'))[0]?.id || null;
}

export function getStartupNotepadId(notepads = []) {
    return getRecentNotepadId(notepads)
        || getPinnedNotepadId(notepads)
        || getNewestCreatedNotepadId(notepads)
        || null;
}

function formatDay(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(timestamp);
    target.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((today - target) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays > 1 && diffDays < 7) return `${diffDays} 天前`;
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function getCollapsedGroups() {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
}

function saveCollapsedGroups(groups) {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...groups]));
}

function setupLongPress(wrapper) {
    let timer;
    const start = () => {
        timer = setTimeout(() => {
            // Long press detected
            document.querySelectorAll('.sidebar-item-wrapper.show-actions').forEach(el => {
                if (el !== wrapper) el.classList.remove('show-actions');
            });
            wrapper.classList.toggle('show-actions');
        }, 600);
    };
    const cancel = () => clearTimeout(timer);

    wrapper.addEventListener('touchstart', start, { passive: true });
    wrapper.addEventListener('touchend', cancel, { passive: true });
    wrapper.addEventListener('touchmove', cancel, { passive: true });
    
    // Hide actions on normal click if already shown
    wrapper.querySelector('.dir-item, .recent-item')?.addEventListener('click', () => {
        wrapper.classList.remove('show-actions');
    });
}

function pinIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 1-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>`;
}

function renderItemActions(pad) {
    const isPinned = pad.pinned === true;
    const pinLabel = isPinned ? '取消置顶' : '置顶';
    return `<div class="item-actions">
        <button class="item-action-btn item-pin-btn ${isPinned ? 'is-pinned' : ''}" data-id="${escapeHtml(pad.id)}" data-pinned="${isPinned}" title="${pinLabel}" aria-label="${pinLabel}" aria-pressed="${isPinned}">
            ${pinIcon()}
        </button>
        <button class="item-action-btn item-rename-btn" data-id="${escapeHtml(pad.id)}" title="重命名" aria-label="重命名">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        </button>
        <button class="item-action-btn item-delete-btn" data-id="${escapeHtml(pad.id)}" title="删除" aria-label="删除">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
        </button>
    </div>`;
}

function renderNotepadItem(pad, currentNotepadId, itemClass = 'dir-item') {
    const time = getPadTime(pad);
    const isPinned = pad.pinned === true;
    return `<div class="sidebar-item-wrapper ${pad.id === currentNotepadId ? 'active' : ''} ${isPinned ? 'is-pinned' : ''}">
        <button class="${itemClass}" type="button" data-id="${escapeHtml(pad.id)}">
            <span class="item-name">${isPinned ? `<span class="item-pin-indicator" title="已置顶">${pinIcon()}</span>` : ''}<span class="item-name-text">${escapeHtml(pad.name)}</span></span>
            <span class="item-time">${formatTime(time)}</span>
        </button>
        ${renderItemActions(pad)}
    </div>`;
}

function bindItemActions(container, { onSelect, onDelete, onRename, onPin }) {
    container.querySelectorAll('.sidebar-item-wrapper').forEach(wrapper => {
        setupLongPress(wrapper);
    });

    container.querySelectorAll('.dir-item, .recent-item').forEach(item => {
        item.addEventListener('click', () => onSelect(item.getAttribute('data-id')));
    });

    container.querySelectorAll('.item-delete-btn').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            onDelete(btn.getAttribute('data-id'));
        });
    });

    container.querySelectorAll('.item-rename-btn').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            onRename(btn.getAttribute('data-id'));
        });
    });

    container.querySelectorAll('.item-pin-btn').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            onPin(btn.getAttribute('data-id'), btn.dataset.pinned !== 'true');
        });
    });
}

export function renderSidebar(notepads, currentNotepadId, onSelect, onDelete, onRename, onPin, titleQuery = '') {
    const treeContainer = document.getElementById('directory-tree');
    if (!treeContainer) return;

    const query = String(titleQuery || '').trim().toLocaleLowerCase();
    const visibleNotepads = query
        ? notepads.filter(pad => String(pad?.name || '').toLocaleLowerCase().includes(query))
        : notepads;

    const pinned = [...visibleNotepads]
        .filter(pad => pad?.pinned === true)
        .sort((left, right) => compareByNewest(left, right, 'pinnedAt', 'updatedAt', 'createdAt'));
    const sorted = [...visibleNotepads]
        .filter(pad => pad?.pinned !== true)
        .sort((a, b) => getPadTime(b) - getPadTime(a));
    const groups = new Map();
    sorted.forEach(pad => {
        const key = formatDay(getPadTime(pad));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pad);
    });

    const collapsed = getCollapsedGroups();
    const autoExpandGroups = ['今天'];
    let html = '';
    if (pinned.length > 0) {
        html += `<div class="dir-group dir-group-pinned" data-group="置顶">
            <button class="dir-group-title" type="button" aria-expanded="true">
                <span class="chevron">›</span>
                <span>置顶</span>
                <span class="dir-count">${pinned.length}</span>
            </button>
            <div class="dir-items">
                ${pinned.map(pad => renderNotepadItem(pad, currentNotepadId)).join('')}
            </div>
        </div>`;
    }
    groups.forEach((pads, groupName) => {
        const hasActive = pads.some(p => p.id === currentNotepadId);
        // Auto-expand if it's recent (last 3 days) OR contains active notepad.
        const isRecent = autoExpandGroups.includes(groupName);
        const isCollapsed = query ? false : (collapsed.has(groupName) || (!isRecent && !hasActive));
        
        html += `<div class="dir-group ${isCollapsed ? 'is-collapsed' : ''}" data-group="${escapeHtml(groupName)}">
            <button class="dir-group-title" type="button" aria-expanded="${!isCollapsed}">
                <span class="chevron">›</span>
                <span>${escapeHtml(groupName)}</span>
                <span class="dir-count">${pads.length}</span>
            </button>
            <div class="dir-items">
                ${pads.map(pad => renderNotepadItem(pad, currentNotepadId)).join('')}
            </div>
        </div>`;
    });

    treeContainer.innerHTML = html || `<div class="empty-state">${query ? '未找到匹配文章' : '还没有草稿'}</div>`;

    treeContainer.querySelectorAll('.dir-group-title').forEach(title => {
        title.addEventListener('click', () => {
            const group = title.closest('.dir-group');
            const name = group.dataset.group;
            const nextCollapsed = !group.classList.contains('is-collapsed');
            group.classList.toggle('is-collapsed', nextCollapsed);
            title.setAttribute('aria-expanded', String(!nextCollapsed));
            if (nextCollapsed) collapsed.add(name);
            else collapsed.delete(name);
            saveCollapsedGroups(collapsed);
        });
    });

    bindItemActions(treeContainer, { onSelect, onDelete, onRename, onPin });
}

export function renderRecentFiles(currentNotepadId, notepads, onSelect, onDelete, onRename, onPin) {
    const containers = [
        document.getElementById('recent-files'),
        document.getElementById('recent-files-mobile')
    ].filter(c => c !== null);
    
    if (containers.length === 0) return;
    
    const notepadIds = new Set(notepads.map(p => p.id));
    let recents = readRecents();
    
    // Filter out deleted files
    const originalLength = recents.length;
    recents = recents.filter(p => notepadIds.has(p.id));
    if (recents.length !== originalLength) {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    }

    const html = recents.length === 0 
        ? '<div class="empty-state">暂无编辑记录</div>'
        : `<div class="recent-stack">
            ${recents.map(recent => {
                const notepad = notepads.find(item => item.id === recent.id);
                return renderNotepadItem({ ...notepad, updatedAt: recent.touchedAt || notepad.updatedAt }, currentNotepadId, 'recent-item');
            }).join('')}
        </div>`;
    
    containers.forEach(container => {
        container.innerHTML = html;
        bindItemActions(container, { onSelect, onDelete, onRename, onPin });
    });
}

export function updateSidebarSelection(currentNotepadId) {
    document.querySelectorAll('.sidebar-item-wrapper').forEach(item => {
        const id = item.querySelector('.dir-item, .recent-item')?.getAttribute('data-id');
        item.classList.toggle('active', id === currentNotepadId);
    });
}

export function trackRecentFile(notepad) {
    let recents = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    recents = recents.filter(p => p.id !== notepad.id);
    recents.unshift({
        id: notepad.id,
        name: notepad.name,
        touchedAt: Date.now()
    });
    if (recents.length > MAX_RECENTS) recents = recents.slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
}
