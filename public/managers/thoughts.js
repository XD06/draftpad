export class ThoughtsManager {
    constructor(app) {
        this.app = app;
        this.view = document.getElementById('thoughts-view');
        this.timeline = document.getElementById('thoughts-timeline');
        this.searchInput = document.getElementById('thoughts-search-input');
        this.dateFilter = document.getElementById('thoughts-date-filter');
        this.statusFilter = document.getElementById('thoughts-status-filter');
        this.toggleBtn = document.getElementById('toggle-thoughts');
        this.editorContainer = document.querySelector('main');

        this.thoughts = [];
        this.isActive = false;

        this.initDateFilter();
        this.initEventListeners();
    }
    initDateFilter() {
        // Correctly get YYYY-MM-DD in local time
        const now = new Date();
        const offset = now.getTimezoneOffset();
        const localDate = new Date(now.getTime() - (offset * 60 * 1000));
        this.dateFilter.value = localDate.toISOString().split('T')[0];
    }
    initEventListeners() {
        this.addThoughtBtn = document.getElementById('fab-add-thought');

        this.addThoughtBtn.addEventListener('click', () => this.addThought());

        this.toggleBtn.addEventListener('click', () => {
            if (this.isActive) {
                window.location.hash = '';
            } else {
                window.location.hash = 'thoughts';
            }
        });

        window.addEventListener('hashchange', () => this.handleHashChange());

        this.searchInput.addEventListener('input', () => this.render());
        this.dateFilter.addEventListener('change', () => this.fetchThoughts());
        this.statusFilter.querySelectorAll('.status-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                this.statusFilter.querySelector('.status-pill.active')?.classList.remove('active');
                btn.classList.add('active');
                this.statusFilter.dataset.value = btn.dataset.status;
                this.render();
            });
        });

        document.getElementById('header-title').addEventListener('click', () => {
            if (this.isActive) {
                window.location.hash = '';
            }
        });

        // Listen for socket updates
        window.addEventListener('thoughts_update', (e) => {
            const { action, payload } = e.detail;
            this.handleSocketUpdate(action, payload);
        });

        // Initial hash check
        this.handleHashChange();
    }

    handleHashChange() {
        const isThoughts = window.location.hash === '#thoughts';
        if (isThoughts !== this.isActive) {
            this.updateViewState(isThoughts);
        }
    }

    async updateViewState(active) {
        this.isActive = active;
        const floatingActions = document.querySelector('.floating-actions');

        if (this.isActive) {
            document.body.classList.add('thoughts-mode');
            this.view.style.display = 'flex';
            this.editorContainer.style.display = 'none';
            this.toggleBtn.classList.add('active');
            if (floatingActions) floatingActions.style.display = 'none';
            await this.fetchThoughts();
        } else {
            document.body.classList.remove('thoughts-mode');
            this.view.style.display = 'none';
            this.editorContainer.style.display = 'flex';
            this.toggleBtn.classList.remove('active');
            if (floatingActions) floatingActions.style.display = 'flex';
        }
    }

    async fetchThoughts() {
        const date = this.dateFilter.value;
        const query = this.searchInput.value.trim();
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        if (query) params.set('q', query);
        const qs = params.toString();
        const url = `/api/thoughts${qs ? '?' + qs : ''}`;
        try {
            const response = await fetch(url);
            this.thoughts = await response.json();
            this.render();
        } catch (err) {
            console.error('Failed to fetch thoughts:', err);
        }
    }

    async addThought() {
        if (this.isAdding) return;
        this.isAdding = true;

        try {
            const response = await fetch('/api/thoughts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '新的灵感...' })
            });
            const data = await response.json();
            if (response.ok) {
                // 1. Optimistic update: Add to list immediately
                this.thoughts.unshift(data);
                this.render();
                
                // 2. Immediate Edit: Find the new card and enter edit mode
                setTimeout(() => {
                    const card = document.querySelector(`.thought-card[data-id="${data.id}"]`);
                    if (card) {
                        this.enterEditMode(card, data);
                    }
                }, 50); // Short delay to ensure DOM is updated
            }
        } catch (err) {
            console.error('Failed to add thought:', err);
        } finally {
            // Short delay to prevent extreme rapid-fire clicks even after completion
            setTimeout(() => { this.isAdding = false; }, 300);
        }
    }

    handleSocketUpdate(action, payload) {
        if (action === 'create') {
            const exists = this.thoughts.some(t => t.id === payload.id);
            if (!exists) {
                this.thoughts.unshift(payload);
            }
        } else if (action === 'update') {
            const index = this.thoughts.findIndex(t => t.id === payload.id);
            if (index !== -1) {
                this.thoughts[index] = payload;
            }
        } else if (action === 'delete') {
            this.thoughts = this.thoughts.filter(t => t.id !== payload.id);
        }
        
        this.render();
    }

    async toggleComplete(id) {
        // Optimistic update
        const thought = this.thoughts.find(t => t.id === id);
        if (thought) {
            thought.completed = !thought.completed;
            this.render();
        }

        try {
            await fetch(`/api/thoughts/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'toggle_complete' })
            });
        } catch (err) {
            console.error('Failed to toggle complete:', err);
            // Revert if failed
            if (thought) {
                thought.completed = !thought.completed;
                this.render();
            }
        }
    }

    async deleteThought(id) {
        if (!this.pendingDeletes) this.pendingDeletes = new Set();
        if (this.pendingDeletes.has(id)) return;
        
        this.pendingDeletes.add(id);

        const confirmed = await this.app.confirmationManager.show(
            '确定要永久删除这条灵感记录吗？'
        );
        
        if (!confirmed) {
            this.pendingDeletes.delete(id);
            return;
        }

        // Optimistic delete: Remove from local array immediately
        this.thoughts = this.thoughts.filter(t => t.id !== id);
        this.render();

        try {
            await fetch(`/api/thoughts/${id}`, {
                method: 'DELETE'
            });
        } catch (err) {
            console.error('Failed to delete thought:', err);
            // On failure, re-fetch to sync with server
            this.fetchThoughts();
        } finally {
            this.pendingDeletes.delete(id);
        }
    }


    render() {
        const query = this.searchInput.value.toLowerCase();
        const status = this.statusFilter.dataset.value || 'all';
        
        let filtered = this.thoughts.filter(t => {
            if (t.text.toLowerCase().includes(query)) return true;
            if (t.subItems && t.subItems.some(s => s.text.toLowerCase().includes(query))) return true;
            return false;
        });

        if (status === 'todo') {
            filtered = filtered.filter(t => !t.completed);
        } else if (status === 'done') {
            filtered = filtered.filter(t => t.completed);
        }

        // Sort: Incomplete first, completed last. Then by creation/update time desc.
        filtered.sort((a, b) => {
            if (a.completed !== b.completed) {
                return a.completed ? 1 : -1; // completed goes to bottom
            }
            // Fallback to createdAt
            return b.createdAt - a.createdAt;
        });

        this.timeline.innerHTML = '';

        if (filtered.length === 0) {
            this.timeline.innerHTML = `
                <div class="thoughts-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M12 20h9"></path>
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                    </svg>
                    <p>${query ? '未找到相关想法' : '还没有记录过灵感'}</p>
                </div>
            `;
            return;
        }

        filtered.forEach(thought => {
            const card = document.createElement('div');
            card.className = `thought-card ${thought.completed ? 'completed' : ''}`;
            card.dataset.id = thought.id;

            const dateStr = new Date(thought.createdAt).toLocaleString();

            // --- Resolve subItems: structured first, fallback to legacy text parsing ---
            let subItems = thought.subItems || [];
            let bodyText = thought.text;

            if (subItems.length === 0 && /^- \[[ x]\]/m.test(thought.text)) {
                const parsed = this._parseLegacyText(thought.text);
                subItems = parsed.subItems;
                bodyText = parsed.bodyText;
            }

            // Render body text
            let bodyHtml = this.escapeHtml(bodyText).split('\n').join('<br>');
            if (query) {
                const regex = new RegExp(`(${this.escapeRegExp(query)})`, 'gi');
                bodyHtml = bodyHtml.replace(regex, '<mark class="thought-highlight">$1</mark>');
            }

            // Render subtask list
            let subtasksHtml = '';
            if (subItems.length > 0) {
                subtasksHtml = '<div class="subtask-list">' + subItems.map(item => {
                    let label = this.escapeHtml(item.text);
                    if (query) {
                        const regex = new RegExp(`(${this.escapeRegExp(query)})`, 'gi');
                        label = label.replace(regex, '<mark class="thought-highlight">$1</mark>');
                    }
                    return `<label class="subtask ${item.completed ? 'completed' : ''}" data-subid="${item.id}"><input type="checkbox" class="subtask-check" ${item.completed ? 'checked' : ''}><span>${label}</span></label>`;
                }).join('') + '</div>';
            }

            const isLong = bodyText.split('\n').length > 6 || bodyText.length > 200 || subItems.length > 3;
            if (isLong) card.classList.add('can-expand');

            card.innerHTML = `
                <div class="timeline-node"></div>
                <div class="thought-card-header">
                    <div class="thought-dot" title="点击切换完成状态">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </div>
                    <div class="thought-time">${dateStr}</div>
                </div>
                <div class="thought-text">${bodyHtml}</div>
                ${subtasksHtml}
            `;

            // Handle all interactions via event delegation or direct listeners
            const textEl = card.querySelector('.thought-text');
            const dotEl = card.querySelector('.thought-dot');
            const expandBtn = card.querySelector('.expand-btn');

            // 1. Toggle completion
            dotEl.onclick = (e) => {
                e.stopPropagation();
                this.toggleComplete(thought.id);
            };

            // 2. Gesture handling (Single click/tap = Expand, Double click/tap = Edit)
            let lastTap = 0;
            let tapTimeout;

            const handleGesture = (e) => {
                // Don't trigger expand/collapse when clicking subtask elements
                if (e.target.classList.contains('subtask-check') ||
                    e.target.closest('.subtask')) return;

                const now = Date.now();
                const DOUBLE_TAP_DELAY = 300;

                if (now - lastTap < DOUBLE_TAP_DELAY) {
                    // DOUBLE TAP/CLICK
                    clearTimeout(tapTimeout);
                    this.enterEditMode(card, thought);
                    lastTap = 0; // Reset
                } else {
                    // SINGLE TAP/CLICK
                    lastTap = now;
                    tapTimeout = setTimeout(() => {
                        if (isLong) {
                            card.classList.toggle('expanded');
                            const btn = card.querySelector('.expand-btn');
                            if (btn) btn.textContent = card.classList.contains('expanded') ? '收起内容' : '展开阅读';
                        }
                    }, DOUBLE_TAP_DELAY);
                }
            };

            textEl.addEventListener('click', handleGesture);

            // 3. Long press to delete (Desktop & Mobile)
            let longPressTimer;
            let isPressing = false;
            
            const startLongPress = (e) => {
                if (isPressing) return;
                isPressing = true;
                longPressTimer = setTimeout(() => {
                    this.deleteThought(thought.id);
                }, 800);
            };
            const cancelLongPress = () => {
                isPressing = false;
                clearTimeout(longPressTimer);
            };

            textEl.addEventListener('mousedown', startLongPress);
            textEl.addEventListener('touchstart', startLongPress, { passive: true });
            textEl.addEventListener('mouseup', cancelLongPress);
            textEl.addEventListener('touchend', cancelLongPress);
            textEl.addEventListener('touchmove', cancelLongPress);

            // 4. Subtasks
            card.querySelectorAll('.subtask-check').forEach((check) => {
                const subId = check.closest('.subtask').dataset.subid;
                check.onchange = () => this.toggleSubtask(thought.id, subId);
            });

            if (expandBtn) {
                expandBtn.onclick = (e) => {
                    e.stopPropagation();
                    card.classList.toggle('expanded');
                    expandBtn.textContent = card.classList.contains('expanded') ? '收起内容' : '展开阅读';
                };
            }

            this.timeline.appendChild(card);
        });
    }

    enterEditMode(card, thought) {
        if (card.classList.contains('editing')) return;
        card.classList.add('editing');
        card.classList.add('expanded');

        const textEl = card.querySelector('.thought-text');

        // --- Resolve subItems: structured first, fallback to legacy text parsing ---
        let subtasks = (thought.subItems || []).map(s => ({ ...s }));
        let bodyText = thought.text;

        if (subtasks.length === 0 && /^- \[[ x]\]/m.test(thought.text)) {
            const parsed = this._parseLegacyText(thought.text);
            subtasks = parsed.subItems;
            bodyText = parsed.bodyText;
        }

        // --- 1. Body textarea ---
        const textarea = document.createElement('textarea');
        textarea.className = 'edit-textarea';
        textarea.value = bodyText;
        textarea.placeholder = '输入主要内容...';
        textEl.style.display = 'none';
        textEl.parentNode.insertBefore(textarea, textEl.nextSibling);

        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        };
        textarea.focus();
        autoResize();
        textarea.addEventListener('input', autoResize);

        // --- 2. Subtask editor panel ---
        const existingList = card.querySelector('.subtask-list');
        if (existingList) existingList.style.display = 'none';

        const panel = document.createElement('div');
        panel.className = 'subtask-editor-panel';

        const renderSubtaskEditor = () => {
            panel.innerHTML = '';
            subtasks.forEach((st, i) => {
                const row = document.createElement('div');
                row.className = `subtask-edit-row ${st.completed ? 'completed' : ''}`;
                row.innerHTML = `
                    <input type="checkbox" class="subtask-check" ${st.completed ? 'checked' : ''}>
                    <input type="text" class="subtask-edit-input" value="${this.escapeHtml(st.text)}">
                    <button class="subtask-delete-btn" title="删除">×</button>
                `;
                row.querySelector('.subtask-check').onchange = (e) => {
                    subtasks[i].completed = e.target.checked;
                    row.classList.toggle('completed', e.target.checked);
                };
                row.querySelector('.subtask-edit-input').oninput = (e) => {
                    subtasks[i].text = e.target.value;
                };
                row.querySelector('.subtask-delete-btn').onclick = () => {
                    subtasks.splice(i, 1);
                    renderSubtaskEditor();
                };
                panel.appendChild(row);
            });

            // Add subtask button
            const addRow = document.createElement('div');
            addRow.className = 'subtask-add-row';
            addRow.innerHTML = `<span class="subtask-add-btn">+ 添加子任务</span>`;
            addRow.querySelector('.subtask-add-btn').onclick = () => {
                subtasks.push({ id: 'new_' + Date.now(), text: '', completed: false });
                renderSubtaskEditor();
                setTimeout(() => {
                    const inputs = panel.querySelectorAll('.subtask-edit-input');
                    if (inputs.length) inputs[inputs.length - 1].focus();
                }, 50);
            };
            panel.appendChild(addRow);
        };

        renderSubtaskEditor();
        textarea.parentNode.insertBefore(panel, textarea.nextSibling);

        // --- Save logic ---
        const saveAndExit = async () => {
            const newText = textarea.value.trim();
            const cleanSubItems = subtasks
                .filter(st => st.text.trim())
                .map(st => ({
                    id: (st.id && !st.id.startsWith('new_') && !st.id.startsWith('legacy_')) ? st.id : Date.now().toString() + Math.random().toString(36).substring(2, 9),
                    text: st.text.trim(),
                    completed: st.completed
                }));

            const hasTextChanged = newText !== thought.text;
            const hasSubsChanged = JSON.stringify(cleanSubItems) !== JSON.stringify(thought.subItems || []);

            if (hasTextChanged || hasSubsChanged) {
                thought.text = newText;
                thought.subItems = cleanSubItems;
                try {
                    await fetch(`/api/thoughts/${thought.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'overwrite', text: newText, subItems: cleanSubItems })
                    });
                } catch (err) {
                    console.error('Failed to save thought:', err);
                }
            }
            this.exitEditMode(card);
            this.render();
        };

        // Ctrl+Enter to save
        textarea.onkeydown = (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveAndExit();
            } else if (e.key === 'Escape') {
                this.exitEditMode(card);
                this.render();
            }
        };

        // Store save function on card for external access
        card._saveAndExit = saveAndExit;

        // Click outside card to save & exit
        const handleClickOutside = (e) => {
            if (!e.target.isConnected) return;
            if (!card.contains(e.target)) {
                saveAndExit();
            }
        };
        setTimeout(() => {
            document.addEventListener('click', handleClickOutside);
        }, 100);
        card._clickOutsideHandler = handleClickOutside;
    }

    exitEditMode(card) {
        card.classList.remove('editing');
        const textarea = card.querySelector('.edit-textarea');
        const panel = card.querySelector('.subtask-editor-panel');
        const textEl = card.querySelector('.thought-text');
        const subtaskList = card.querySelector('.subtask-list');
        if (textarea) textarea.remove();
        if (panel) panel.remove();
        if (textEl) textEl.style.display = '';
        if (subtaskList) subtaskList.style.display = '';
        // Cleanup listeners
        if (card._clickOutsideHandler) {
            document.removeEventListener('click', card._clickOutsideHandler);
            card._clickOutsideHandler = null;
        }
        card._saveAndExit = null;
    }

    async toggleSubtask(id, subId) {
        const thought = this.thoughts.find(t => t.id === id);
        if (!thought) return;

        // If legacy data (subtask parsed from text), migrate on toggle
        if (subId.startsWith('legacy_') && !thought.subItems.length) {
            const { bodyText, subItems } = this._parseLegacyText(thought.text);
            const idx = parseInt(subId.replace('legacy_', ''));
            const target = subItems.find(s => s.id === subId);
            if (!target) return;

            target.completed = !target.completed;
            // Assign real IDs
            subItems.forEach(s => { if (s.id.startsWith('legacy_')) s.id = Date.now().toString() + Math.random().toString(36).substring(2, 9); });

            thought.text = bodyText;
            thought.subItems = subItems;
            this.render();
            try {
                await fetch(`/api/thoughts/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'overwrite', text: bodyText, subItems })
                });
            } catch (err) {
                console.error('Failed to toggle legacy subtask:', err);
                this.fetchThoughts();
            }
            return;
        }

        const sub = thought.subItems.find(s => s.id === subId);
        if (!sub) return;

        // Optimistic update
        sub.completed = !sub.completed;
        this.render();

        try {
            await fetch(`/api/thoughts/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'toggle_subitem', subId })
            });
        } catch (err) {
            console.error('Failed to toggle subtask:', err);
            sub.completed = !sub.completed;
            this.render();
        }
    }

    _parseLegacyText(text) {
        const lines = text.split('\n');
        const bodyLines = [];
        const subItems = [];
        lines.forEach((line, i) => {
            const m = line.match(/^- \[([ x])\]\s+(.*)/);
            if (m) {
                subItems.push({ id: 'legacy_' + i, text: m[2], completed: m[1] === 'x' });
            } else {
                bodyLines.push(line);
            }
        });
        return { bodyText: bodyLines.join('\n'), subItems };
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

}
