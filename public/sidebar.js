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

export function renderSidebar(notepads, currentNotepadId, onSelect, onDelete, onRename) {
    const treeContainer = document.getElementById('directory-tree');
    if (!treeContainer) return;

    const sorted = [...notepads].sort((a, b) => getPadTime(b) - getPadTime(a));
    const groups = new Map();
    sorted.forEach(pad => {
        const key = formatDay(getPadTime(pad));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pad);
    });

    const collapsed = getCollapsedGroups();
    const autoExpandGroups = ['今天'];
    let html = '';
    groups.forEach((pads, groupName) => {
        const hasActive = pads.some(p => p.id === currentNotepadId);
        // Auto-expand if it's recent (last 3 days) OR contains active notepad.
        const isRecent = autoExpandGroups.includes(groupName);
        const isCollapsed = collapsed.has(groupName) || (!isRecent && !hasActive);
        
        html += `<div class="dir-group ${isCollapsed ? 'is-collapsed' : ''}" data-group="${escapeHtml(groupName)}">
            <button class="dir-group-title" type="button" aria-expanded="${!isCollapsed}">
                <span class="chevron">›</span>
                <span>${escapeHtml(groupName)}</span>
                <span class="dir-count">${pads.length}</span>
            </button>
            <div class="dir-items">
                ${pads.map(p => {
                    const time = getPadTime(p);
                    return `<div class="sidebar-item-wrapper ${p.id === currentNotepadId ? 'active' : ''}">
                        <button class="dir-item" type="button" data-id="${escapeHtml(p.id)}">
                            <span class="item-name">${escapeHtml(p.name)}</span>
                            <span class="item-time">${formatTime(time)}</span>
                        </button>
                        <div class="item-actions">
                            <button class="item-action-btn item-rename-btn" data-id="${escapeHtml(p.id)}" aria-label="Rename">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                            </button>
                            <button class="item-action-btn item-delete-btn" data-id="${escapeHtml(p.id)}" aria-label="Delete">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                            </button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    });

    treeContainer.innerHTML = html || '<div class="empty-state">还没有草稿</div>';

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

    treeContainer.querySelectorAll('.sidebar-item-wrapper').forEach(wrapper => {
        setupLongPress(wrapper);
    });

    treeContainer.querySelectorAll('.dir-item').forEach(item => {
        item.addEventListener('click', () => onSelect(item.getAttribute('data-id')));
    });

    treeContainer.querySelectorAll('.item-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onDelete(btn.getAttribute('data-id'));
        });
    });

    treeContainer.querySelectorAll('.item-rename-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onRename(btn.getAttribute('data-id'));
        });
    });
}

export function renderRecentFiles(currentNotepadId, notepads, onSelect, onDelete, onRename) {
    const containers = [
        document.getElementById('recent-files'),
        document.getElementById('recent-files-mobile')
    ].filter(c => c !== null);
    
    if (containers.length === 0) return;
    
    const notepadIds = new Set(notepads.map(p => p.id));
    let recents = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    
    // Filter out deleted files
    const originalLength = recents.length;
    recents = recents.filter(p => notepadIds.has(p.id));
    if (recents.length !== originalLength) {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    }

    const html = recents.length === 0 
        ? '<div class="empty-state">暂无编辑记录</div>'
        : `<div class="recent-stack">
            ${recents.map(p => `
                <div class="sidebar-item-wrapper ${p.id === currentNotepadId ? 'active' : ''}">
                    <button class="recent-item" type="button" data-id="${escapeHtml(p.id)}">
                        <span class="item-name">${escapeHtml(p.name)}</span>
                        <span class="item-time">${p.touchedAt ? formatTime(p.touchedAt) : '刚刚'}</span>
                    </button>
                    <div class="item-actions">
                        <button class="item-action-btn item-rename-btn" data-id="${escapeHtml(p.id)}" aria-label="Rename">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                        </button>
                        <button class="item-action-btn item-delete-btn" data-id="${escapeHtml(p.id)}" aria-label="Delete">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>`).join('')}
        </div>`;
    
    containers.forEach(container => {
        container.innerHTML = html;
        container.querySelectorAll('.sidebar-item-wrapper').forEach(wrapper => {
            setupLongPress(wrapper);
        });
        container.querySelectorAll('.recent-item').forEach(item => {
            item.addEventListener('click', () => onSelect(item.getAttribute('data-id')));
        });
        container.querySelectorAll('.item-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                onDelete(btn.getAttribute('data-id'));
            });
        });
        container.querySelectorAll('.item-rename-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                onRename(btn.getAttribute('data-id'));
            });
        });
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
