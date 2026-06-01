import ThoughtApiClient from './thought-api-client.js';
import ThoughtOutbox from './thought-outbox.js';
import {
    renderManualRelationControls as renderManualRelationControlsHtml,
    renderRelationsPanelContent as renderRelationsPanelContentHtml,
    renderRelationsList as renderRelationsListHtml,
    renderRelationsMoreButton as renderRelationsMoreButtonHtml,
    renderSuggestedRelationsList as renderSuggestedRelationsListHtml,
    relationDetailLine,
    relationDisplayDate,
    relationStrengthClass,
    relationTypeLabel
} from './thought-relations-panel.js';
import { assignRealSubItemIds, cleanSubItems, createSubItem, parseLegacyText, sortSubItems } from './thought-editor.js';
import { collectThoughtTags, filterThoughts, sortThoughts } from './thought-renderer.js';

const AI_PENDING_MIN_VISIBLE_MS = 1200;

export class ThoughtsManager {
    constructor(app) {
        this.app = app;
        this.apiClient = app.apiClient || new ThoughtApiClient();
        this.outbox = app.outbox || new ThoughtOutbox();
        this.view = document.getElementById('thoughts-view');
        this.timeline = document.getElementById('thoughts-timeline');
        this.searchInput = document.getElementById('thoughts-search-input');
        this.dateFilter = document.getElementById('thoughts-date-filter');
        this.statusFilter = document.getElementById('thoughts-status-filter');
        this.toggleBtn = document.getElementById('toggle-thoughts');
        this.editorContainer = document.querySelector('main');

        // Quick Add Bar elements
        this.quickAddBar = document.getElementById('quick-add-bar');
        this.quickAddInput = document.getElementById('quick-add-input');
        this.quickAddSubmit = document.getElementById('quick-add-submit');
        this.quickAddTagsList = document.getElementById('quick-add-tags-list');
        this.quickAddTagInput = document.getElementById('quick-add-tag-input');
        this.quickAddTagSuggestions = document.getElementById('quick-add-tag-suggestions');
        this.tagsFilter = document.getElementById('thoughts-tags-filter');
        this.outboxStatus = document.getElementById('thoughts-outbox-status');

        this.thoughts = [];
        this.quickAddTags = [];
        this.activeTag = '';
        this.savedTags = this.loadSavedTags();
        this.isActive = false;
        this.pendingCreateIds = new Set(); // Prevent duplicate from race conditions
        this.pendingAIStatusTimers = new Map();
        this.outboxInFlight = false;
        this.manualRelationSearchTimer = null;
        this.manualRelationSearchSeq = 0;

        this.initDateFilter();
        this.initEventListeners();
        this.updateOutboxStatus();
        window.addEventListener('online', () => this.retryOutbox({ silent: true }));
    }
    initDateFilter() {
        this.dateFilter.value = '';
    }
    initEventListeners() {
        this.addThoughtBtn = document.getElementById('fab-add-thought');

        this.addThoughtBtn.addEventListener('click', () => this.openQuickAdd());

        // Quick Add Bar events
        if (this.quickAddBar) {
            // Click backdrop to close
            this.quickAddBar.querySelector('.quick-add-backdrop').addEventListener('click', () => this.closeQuickAdd());
            // Submit button
            this.quickAddSubmit.addEventListener('click', (e) => { e.stopPropagation(); this.submitQuickAdd(); });
            // Enter to submit (Shift+Enter for newline)
            this.quickAddInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.submitQuickAdd();
                } else if (e.key === 'Escape') {
                    this.closeQuickAdd();
                }
            });
            // Auto-resize textarea
            this.quickAddInput.addEventListener('input', () => {
                this.quickAddInput.style.height = 'auto';
                this.quickAddInput.style.height = Math.min(this.quickAddInput.scrollHeight, 160) + 'px';
            });
            this.initQuickAddTagEvents();
        }

        this.toggleBtn.addEventListener('click', () => {
            if (this.isActive) {
                window.location.hash = '';
            } else {
                window.location.hash = 'thoughts';
            }
        });

        // Search/filter toggle: thoughts mode expands panel, editor mode opens article search
        this.searchToggle = document.getElementById('thoughts-search-toggle');
        this.headerActions = document.querySelector('.thoughts-header-actions');
        if (this.searchToggle) {
            this.searchToggle.addEventListener('click', () => {
                if (this.isActive) {
                    this.view.classList.add('expanded');
                    this.searchInput.focus();
                } else if (this.app.openSearch) {
                    this.app.openSearch();
                }
            });
            // Click outside header-actions or toggle button → collapse
            document.addEventListener('click', (e) => {
                if (!this.view.classList.contains('expanded')) return;
                const path = e.composedPath ? e.composedPath() : [];
                const clickedInsideHeader = path.includes(this.headerActions) || this.headerActions.contains(e.target);
                const clickedSearchToggle = path.includes(this.searchToggle) || this.searchToggle.contains(e.target);
                if (clickedInsideHeader || clickedSearchToggle) return;
                this.view.classList.remove('expanded');
            });

            // Click outside expanded card → collapse
            document.addEventListener('click', (e) => {
                const expandedCards = this.timeline.querySelectorAll('.thought-card.expanded');
                expandedCards.forEach(card => {
                    if (!card.contains(e.target) && !card.classList.contains('editing')) {
                        card.classList.remove('expanded');
                    }
                });
            });
            // Blur on all inputs inside header-actions → collapse if focus left the group
        }

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

        if (this.tagsFilter) {
            this.tagsFilter.addEventListener('click', (e) => {
                const clearBtn = e.target.closest('[data-clear-tag-filter]');
                if (clearBtn) {
                    this.activeTag = '';
                    this.render();
                    return;
                }

                const tagBtn = e.target.closest('[data-tag-filter]');
                if (!tagBtn) return;
                const tag = tagBtn.dataset.tagFilter;
                this.activeTag = this.activeTag.toLowerCase() === tag.toLowerCase() ? '' : tag;
                this.render();
            });

            this.tagsFilter.addEventListener('keydown', (e) => {
                const input = e.target.closest('#thoughts-tag-filter-input');
                if (!input) return;
                if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    const tag = this.normalizeTag(input.value);
                    if (!tag) return;
                    this.saveTag(tag);
                    this.activeTag = tag;
                    input.value = '';
                    this.render();
                } else if (e.key === 'Escape') {
                    input.value = '';
                    this.activeTag = '';
                    this.render();
                }
            });
        }

        if (this.outboxStatus) {
            this.outboxStatus.addEventListener('click', () => this.retryOutbox({ silent: false }));
        }

        document.querySelector('#header-title h1')?.addEventListener('click', () => {
            if (this.isActive) {
                window.location.hash = '';
            }
        });
        // Listen for lightweight WebSocket updates dispatched by ws-client.
        window.addEventListener('thoughts_update', (e) => {
            const detail = e.detail || {};
            const action = detail.action;
            const payload = detail.payload || detail.thought || detail.data;
            this.handleSocketUpdate(action, payload);
        });

        window.addEventListener('relations_update', (e) => {
            this.handleRelationsSocketUpdate(e.detail || {});
        });

        window.addEventListener('ai_status_update', (e) => {
            this.handleAIStatusSocketUpdate(e.detail || {});
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

    loadOutbox() {
        return this.outbox.load();
    }

    saveOutbox(items) {
        this.outbox.save(items);
        this.updateOutboxStatus(items);
    }

    updateOutboxStatus(items = this.loadOutbox()) {
        if (!this.outboxStatus) return;
        const count = items.length;
        this.outboxStatus.hidden = count === 0;
        this.outboxStatus.textContent = count > 0 ? `待同步 ${count}` : '待同步 0';
        this.outboxStatus.disabled = this.outboxInFlight;
    }

    enqueueOutbox(item) {
        const result = this.outbox.enqueue(item);
        return this.handleOutboxResult(result);
    }

    handleOutboxResult(result) {
        if (!result) return null;
        this.updateOutboxStatus(result.items);
        if (result.outcome === 'merged-create') {
            this.app.toaster?.show('云端暂时不可用，已更新本地待同步内容', 'warning', false, 2400);
        } else if (result.outcome === 'cancelled-create') {
            this.app.toaster?.show('本地待同步 Thought 已取消', 'info', false, 1800);
        } else {
            this.app.toaster?.show('云端暂时不可用，已保留到本地待同步', 'warning', false, 2600);
        }
        return result.item;
    }

    cloneThoughtForOutbox(thought) {
        return this.outbox.cloneThought(thought);
    }

    buildThoughtOverwriteBody(thought) {
        return this.outbox.buildOverwriteBody(thought);
    }

    enqueueThoughtOverwrite(thought) {
        if (!thought?.id) return;
        const result = this.outbox.enqueueOverwrite(thought);
        return this.handleOutboxResult(result);
    }

    mergeOutboxThoughts(thoughts) {
        return this.outbox.mergeThoughts(thoughts);
    }

    async retryOutbox({ silent = false } = {}) {
        const items = this.loadOutbox();
        if (this.outboxInFlight || items.length === 0) return;
        this.outboxInFlight = true;
        this.updateOutboxStatus(items);

        const result = await this.outbox.retry(this.apiClient);
        for (const created of result.created) {
            const index = this.thoughts.findIndex(thought => thought.id === created.item.tempThought?.id);
            if (index >= 0) this.thoughts[index] = created.data;
        }

        this.outboxInFlight = false;
        this.updateOutboxStatus(result.remaining);
        if (result.changed) {
            await this.fetchThoughts();
        }
        if (!silent) {
            this.app.toaster?.show(
                result.remaining.length === 0 ? '待同步 Thought 已全部提交' : `仍有 ${result.remaining.length} 条 Thought 待同步`,
                result.remaining.length === 0 ? 'success' : 'warning',
                false,
                2200
            );
        }
    }

    async fetchThoughts() {
        const date = this.dateFilter.value;
        const query = this.searchInput.value.trim();
        try {
            this.thoughts = this.mergeOutboxThoughts(await this.apiClient.list({ date, query }));
            this.syncTagsFromThoughts(this.thoughts);
            this.render();
        } catch (err) {
            console.error('Failed to fetch thoughts:', err);
        }
    }

    openQuickAdd() {
        if (!this.quickAddBar) return;
        this.quickAddBar.style.display = 'flex';
        document.body.classList.add('quick-add-open');
        this.quickAddInput.value = '';
        this.quickAddTags = [];
        this.quickAddInput.style.height = '52px';
        this.quickAddSubmit.disabled = false;
        this.renderQuickAddTags();
        this.hideQuickAddTagSuggestions();

        // Auto-focus to trigger mobile keyboard
        setTimeout(() => this.quickAddInput.focus(), 80);
    }

    closeQuickAdd() {
        if (!this.quickAddBar) return;
        this.quickAddBar.style.display = 'none';
        document.body.classList.remove('quick-add-open');
        this.quickAddInput.blur();
        this.hideQuickAddTagSuggestions();
    }

    async submitQuickAdd() {
        const text = this.quickAddInput.value.trim();
        if (!text) {
            this.quickAddInput.focus();
            return;
        }
        if (this.isAdding) return;
        this.isAdding = true;
        this.quickAddSubmit.disabled = true;

        try {
            const data = await this.apiClient.create({ text, tags: this.quickAddTags });
            data.aiStatus = 'pending';
            data.aiPendingSince = Date.now();
            // Race-condition guard: if WebSocket already added this thought, skip
            const exists = this.thoughts.some(t => t.id === data.id);
            if (!exists) {
                this.thoughts.unshift(data);
                this.pendingCreateIds.add(data.id);
            }
            this.syncTagsFromThoughts([data]);
            this.render();
            this.closeQuickAdd();

            // Scroll new item into view
            setTimeout(() => {
                const card = document.querySelector(`.thought-card[data-id="${data.id}"]`);
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);

            // Clear pending after a safe window
            setTimeout(() => this.pendingCreateIds.delete(data.id), 2000);
        } catch (err) {
            console.error('Failed to add thought:', err);
            const tempThought = {
                id: `local-${Date.now()}`,
                text,
                tags: [...this.quickAddTags],
                subItems: [],
                completed: false,
                relationCount: 0,
                aiStatus: 'missing',
                localPending: true,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            this.handleOutboxResult(this.outbox.enqueueCreate({
                text,
                tags: this.quickAddTags,
                subItems: [],
                completed: false,
                tempThought
            }));
            this.thoughts.unshift(tempThought);
            this.syncTagsFromThoughts([tempThought]);
            this.render();
            this.closeQuickAdd();
        } finally {
            this.isAdding = false;
            if (this.quickAddBar.style.display !== 'none') {
                this.quickAddSubmit.disabled = false;
            }
        }
    }

    initQuickAddTagEvents() {
        if (this.quickAddTagInput) {
            this.quickAddTagInput.disabled = true;
        }
        if (this.quickAddTagsList) {
            this.quickAddTagsList.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-quick-tag-choice]');
                if (!btn) return;
                this.toggleQuickAddTag(btn.dataset.quickTagChoice);
                this.renderQuickAddTags();
            });
        }
    }

    toggleQuickAddTag(value) {
        const tag = this.normalizeTag(value);
        if (!tag) return;
        const index = this.quickAddTags.findIndex(t => t.toLowerCase() === tag.toLowerCase());
        if (index === -1) {
            this.quickAddTags.push(tag);
        } else {
            this.quickAddTags.splice(index, 1);
        }
    }

    renderQuickAddTags() {
        if (!this.quickAddTagsList) return;
        const tags = this.getAllTags();
        const selected = new Set(this.quickAddTags.map(tag => tag.toLowerCase()));
        if (tags.length === 0) {
            this.quickAddTagsList.innerHTML = '<div class="quick-add-tags-empty">No saved tags</div>';
            return;
        }
        this.quickAddTagsList.innerHTML = tags.map(tag => {
            const isSelected = selected.has(tag.toLowerCase());
            return `
                <button type="button" class="quick-add-tag-chip ${isSelected ? 'selected' : ''}" data-quick-tag-choice="${this.escapeHtml(tag)}" aria-pressed="${isSelected}">
                    <span>#${this.escapeHtml(tag)}</span>
                </button>
            `;
        }).join('');
        return;
        this.quickAddTagsList.innerHTML = this.quickAddTags.map(tag => `
            <button type="button" class="quick-add-tag-chip" data-remove-quick-tag="${this.escapeHtml(tag)}" title="移除标签">
                <span>#${this.escapeHtml(tag)}</span>
                <span aria-hidden="true">×</span>
            </button>
        `).join('');
    }

    renderQuickAddTagSuggestions() {
        if (!this.quickAddTagSuggestions || !this.quickAddTagInput) return;
        const query = this.quickAddTagInput.value.trim().toLowerCase();
        const selected = new Set(this.quickAddTags.map(tag => tag.toLowerCase()));
        const suggestions = this.getAllTags()
            .filter(tag => !selected.has(tag.toLowerCase()))
            .filter(tag => !query || tag.toLowerCase().includes(query))
            .slice(0, 8);

        if (suggestions.length === 0) {
            this.hideQuickAddTagSuggestions();
            return;
        }

        this.quickAddTagSuggestions.innerHTML = suggestions.map(tag => `
            <button type="button" class="quick-add-tag-suggestion" data-quick-tag-suggestion="${this.escapeHtml(tag)}">#${this.escapeHtml(tag)}</button>
        `).join('');
        this.quickAddTagSuggestions.style.display = 'flex';
    }

    hideQuickAddTagSuggestions() {
        if (!this.quickAddTagSuggestions) return;
        this.quickAddTagSuggestions.style.display = 'none';
        this.quickAddTagSuggestions.innerHTML = '';
    }

    handleSocketUpdate(action, payload) {
        if (!action || !payload) return;

        if (action === 'create') {
            payload.aiStatus = this.normalizeAIStatus(payload.aiStatus);
            if (payload.aiStatus === 'pending') payload.aiPendingSince = Date.now();
            // Skip if this is our own optimistic update (still in pending window)
            if (this.pendingCreateIds.has(payload.id)) return;
            const exists = this.thoughts.some(t => t.id === payload.id);
            if (!exists) {
                this.thoughts.unshift(payload);
            }
        } else if (action === 'update') {
            const index = this.thoughts.findIndex(t => t.id === payload.id);
            if (index !== -1) {
                if (payload.aiTags === undefined && this.thoughts[index].aiTags !== undefined) {
                    payload.aiTags = this.thoughts[index].aiTags;
                }
                this.thoughts[index] = payload;
            }
        } else if (action === 'delete') {
            this.thoughts = this.thoughts.filter(t => t.id !== payload.id);
        }

        this.render();
    }

    handleRelationsSocketUpdate(detail) {
        const thoughtId = detail.thoughtId || detail.id;
        if (!thoughtId) return;

        const nextCount = Number(detail.relationsCount ?? detail.relationCount);
        if (!Number.isFinite(nextCount)) return;

        const thought = this.thoughts.find(item => item.id === thoughtId);
        if (thought && this.shouldDelayAIStatusUpdate(thought, 'ready', {
            thoughtId,
            status: 'ready',
            relationsCount: nextCount
        })) return;

        if (thought) {
            thought.relationCount = nextCount;
            thought.aiStatus = 'ready';
            delete thought.aiPendingSince;
        }

        const card = this.timeline?.querySelector(`.thought-card[data-id="${CSS.escape(thoughtId)}"]`);
        if (card && thought) this.updateThoughtToolCounts(card, thought, 'ready', nextCount);
        const panel = card?.querySelector('.thought-relations-panel');
        if (panel && thought) {
            this.refreshRelationsPanel(panel, thought);
        }
    }

    updateThoughtToolCounts(card, thought, status = this.normalizeAIStatus(thought?.aiStatus), relationCount = Number(thought?.relationCount || 0)) {
        if (!card || !thought) return;
        const nextCount = Math.max(0, Number.isFinite(Number(relationCount)) ? Number(relationCount) : 0);
        const countEl = card.querySelector('.relations-count');
        if (countEl) countEl.textContent = nextCount;

        const statusEl = card.querySelector('.thought-ai-status');
        if (!statusEl) return;
        const wrapper = document.createElement('span');
        wrapper.innerHTML = this.renderAIStatus(thought, status, nextCount);
        const nextStatusEl = wrapper.firstElementChild;
        if (!nextStatusEl) return;
        nextStatusEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleAIStatusPanel(card, thought);
        });
        statusEl.replaceWith(nextStatusEl);
    }

    handleAIStatusSocketUpdate(detail) {
        const thoughtId = detail.thoughtId || detail.id;
        if (!thoughtId) return;

        const thought = this.thoughts.find(item => item.id === thoughtId);
        if (!thought) return;

        const nextStatus = this.normalizeAIStatus(detail.status);
        if (this.shouldDelayAIStatusUpdate(thought, nextStatus, detail)) return;

        if (this.pendingAIStatusTimers.has(thoughtId)) {
            clearTimeout(this.pendingAIStatusTimers.get(thoughtId));
            this.pendingAIStatusTimers.delete(thoughtId);
        }

        thought.aiStatus = nextStatus;
        if (nextStatus === 'pending') {
            thought.aiPendingSince = Date.now();
        } else {
            delete thought.aiPendingSince;
        }
        thought.aiError = detail.error || null;
        if (Number.isFinite(Number(detail.relationsCount))) {
            thought.relationCount = Number(detail.relationsCount);
        }
        if (Number.isFinite(Number(detail.processedAt))) {
            thought.aiProcessedAt = Number(detail.processedAt);
        }
        if (Array.isArray(detail.aiTags)) {
            thought.aiTags = detail.aiTags.map(tag => this.normalizeTag(tag)).filter(Boolean);
        }
        this.render();
    }

    shouldDelayAIStatusUpdate(thought, nextStatus, detail) {
        if (nextStatus === 'pending') return false;
        if (thought.aiStatus !== 'pending' || !thought.aiPendingSince) return false;

        const elapsed = Date.now() - thought.aiPendingSince;
        const remaining = AI_PENDING_MIN_VISIBLE_MS - elapsed;
        if (remaining <= 0) return false;

        const thoughtId = detail.thoughtId || detail.id;
        if (this.pendingAIStatusTimers.has(thoughtId)) {
            clearTimeout(this.pendingAIStatusTimers.get(thoughtId));
        }
        const timer = setTimeout(() => {
            this.pendingAIStatusTimers.delete(thoughtId);
            this.handleAIStatusSocketUpdate(detail);
        }, remaining);
        this.pendingAIStatusTimers.set(thoughtId, timer);
        return true;
    }

    async toggleComplete(id) {
        // Optimistic update
        const thought = this.thoughts.find(t => t.id === id);
        if (thought) {
            thought.completed = !thought.completed;
            this.render();
        }

        try {
            await this.apiClient.toggleComplete(id);
        } catch (err) {
            console.error('Failed to toggle complete:', err);
            if (thought) {
                this.enqueueThoughtOverwrite(thought);
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
            await this.apiClient.delete(id);
        } catch (err) {
            console.error('Failed to delete thought:', err);
            this.handleOutboxResult(this.outbox.enqueueDeleteThought(id));
        } finally {
            this.pendingDeletes.delete(id);
        }
    }


    render() {
        const query = this.searchInput.value.toLowerCase();
        const status = this.statusFilter.dataset.value || 'all';
        const activeTag = this.activeTag.toLowerCase();
        this.renderTagFilters();
        
        const filtered = sortThoughts(filterThoughts(this.thoughts, { query, status, activeTag }));

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

            const sortedSubItems = sortSubItems(subItems);

            // Render body text
            let bodyHtml = this.linkify(bodyText).split('\n').join('<br>');
            if (query) {
                bodyHtml = this.highlightSearch(bodyHtml, query);
            }

            const tags = thought.tags || [];
            const tagsHtml = tags.length ? `
                <div class="thought-tags">
                    ${tags.map(tag => `
                        <span class="thought-tag-wrap">
                            <button type="button" class="thought-tag" data-card-tag="${this.escapeHtml(tag)}">#${this.escapeHtml(tag)}</button>
                            <button type="button" class="thought-tag-remove" data-remove-tag="${this.escapeHtml(tag)}" title="从当前 Thought 移除标签" aria-label="从当前 Thought 移除标签">×</button>
                        </span>
                    `).join('')}
                </div>
            ` : '';
            const aiTagsHtml = this.renderAISuggestedTags(thought, tags);
            const relationCount = Number.isFinite(Number(thought.relationCount)) ? Number(thought.relationCount) : 0;
            const aiStatus = this.normalizeAIStatus(thought.aiStatus);
            const aiStatusHtml = this.renderAIStatus(thought, aiStatus, relationCount);
            const hasSubtasks = sortedSubItems.length > 0;
            const emptySubtaskActionHtml = hasSubtasks ? '' : `
                <button class="thought-tool-btn subtask-add-inline subtask-add-footer" title="添加子任务" aria-label="添加子任务">
                    <svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
            `;
            const relationsButtonHtml = `
                <div class="thought-card-footer">
                    ${emptySubtaskActionHtml}
                    ${aiStatusHtml}
                    <button class="thought-tool-btn thought-relations-btn" data-relations="${this.escapeHtml(thought.id)}" title="查看关联想法" aria-label="查看关联想法">
                        <svg class="thought-tool-icon relations-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                        </svg>
                        <span class="relations-count">${relationCount}</span>
                    </button>
                </div>
            `;

            // Render subtask list only when there are existing subtasks; empty cards use a compact footer action.
            let subtasksHtml = '';
            if (hasSubtasks) {
                subtasksHtml = '<div class="subtask-list">';
                sortedSubItems.forEach((item, index) => {
                    let label = this.linkify(item.text);
                    if (query) {
                        label = this.highlightSearch(label, query);
                    }
                    const isExtra = sortedSubItems.length > 3 && index >= 3;
                    const extraClass = isExtra ? 'subtask-extra' : '';
                    subtasksHtml += `<div class="subtask ${item.completed ? 'completed' : ''} ${extraClass}" data-subid="${item.id}">
                        <input type="checkbox" class="subtask-check" ${item.completed ? 'checked' : ''}>
                        <span class="subtask-text">${label}</span>
                        <button class="subtask-copy-btn" title="复制">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                    </div>`;
                });

                if (sortedSubItems.length > 3) {
                    const remainingCount = sortedSubItems.length - 3;
                    const completedCount = sortedSubItems.filter(item => item.completed).length;
                    const totalCount = sortedSubItems.length;

                    const radius = 7;
                    const circumference = Math.round(2 * Math.PI * radius); // ~44
                    const progress = totalCount > 0 ? (completedCount / totalCount) : 0;
                    const strokeDashoffset = circumference - (progress * circumference);

                    subtasksHtml += `
                        <div class="subtasks-summary-row">
                            <div class="summary-left">
                                <svg class="progress-ring" width="18" height="18" viewBox="0 0 18 18">
                                    <circle class="progress-ring-bg" cx="9" cy="9" r="7" fill="none" stroke-width="2"/>
                                    <circle class="progress-ring-fg" cx="9" cy="9" r="7" fill="none" stroke-width="2"
                                            stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}"
                                            stroke-linecap="round" transform="rotate(-90 9 9)"/>
                                </svg>
                            </div>
                            <div class="summary-right">
                                <span class="summary-more-num">+${remainingCount}</span>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chevron-down-icon">
                                    <polyline points="6 9 12 15 18 9"></polyline>
                                </svg>
                            </div>
                        </div>
                    `;
                }

                subtasksHtml += '<button class="subtask-add-inline" title="添加子任务"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button></div>';
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
                <div class="thought-body">
                    <div class="thought-text">${bodyHtml}</div>
                    <button class="thought-copy-btn" title="复制">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                </div>
                ${tagsHtml}
                ${aiTagsHtml}
                ${subtasksHtml}
                ${relationsButtonHtml}
            `;

            // Handle all interactions via event delegation or direct listeners
            const textEl = card.querySelector('.thought-text');
            const dotEl = card.querySelector('.thought-dot');
            const thoughtCopyBtn = card.querySelector('.thought-copy-btn');

            // 1. Toggle completion
            dotEl.onclick = (e) => {
                e.stopPropagation();
                this.toggleComplete(thought.id);
            };

            // 1.5 Copy main task text
            if (thoughtCopyBtn) {
                thoughtCopyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(bodyText).catch(() => {
                        const ta = document.createElement('textarea');
                        ta.value = bodyText;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                    });
                    thoughtCopyBtn.classList.add('copied');
                    setTimeout(() => thoughtCopyBtn.classList.remove('copied'), 1200);
                    this.app.toaster?.show('已复制', 'success', false, 1500);
                });
            }

            // 2. Gesture handling (Single click/tap = Expand, Double click/tap = Edit)
            let lastTap = 0;
            let tapTimeout;

            const handleGesture = (e) => {
                // Don't trigger expand/collapse when clicking interactive elements or inside editing panel
                if (
                    e.target.closest('.thought-dot') ||
                    e.target.closest('.thought-copy-btn') ||
                    e.target.closest('.thought-relations-btn') ||
                    e.target.closest('.thought-ai-status') ||
                    e.target.closest('.thought-ai-detail-panel') ||
                    e.target.closest('.thought-ai-tag-suggestion') ||
                    e.target.closest('.thought-tag-remove') ||
                    e.target.closest('.thought-relations-panel') ||
                    e.target.closest('.thought-tag') ||
                    e.target.closest('.subtask') ||
                    e.target.closest('.subtask-add-inline') ||
                    e.target.closest('.subtasks-summary-row') ||
                    e.target.closest('.subtask-editor-panel') ||
                    e.target.closest('.edit-textarea') ||
                    e.target.closest('.thought-link') ||
                    card.classList.contains('editing')
                ) {
                    return;
                }

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
                        }
                    }, DOUBLE_TAP_DELAY);
                }
            };

            card.addEventListener('click', handleGesture);

            const relationsBtn = card.querySelector('.thought-relations-btn');
            if (relationsBtn) {
                relationsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleRelationsPanel(card, thought);
                });
            }

            const aiStatusBtn = card.querySelector('.thought-ai-status');
            if (aiStatusBtn) {
                aiStatusBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleAIStatusPanel(card, thought);
                });
            }

            card.querySelectorAll('.thought-tag').forEach((tagBtn) => {
                tagBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.activeTag = tagBtn.dataset.cardTag;
                    this.render();
                });
            });

            card.querySelectorAll('.thought-tag-remove').forEach((tagBtn) => {
                tagBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removeThoughtTag(thought.id, tagBtn.dataset.removeTag);
                });
            });

            card.querySelectorAll('.thought-ai-tag-suggestion').forEach((tagBtn) => {
                tagBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.acceptAITag(thought.id, tagBtn.dataset.aiTag);
                });
            });

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
                const subtaskEl = check.closest('.subtask');
                const subId = subtaskEl.dataset.subid;
                check.onchange = () => this.toggleSubtask(thought.id, subId);
                // Copy button: click to copy subtask text
                const copyBtn = subtaskEl.querySelector('.subtask-copy-btn');
                if (copyBtn) {
                    copyBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const text = subtaskEl.querySelector('.subtask-text').textContent;
                        navigator.clipboard.writeText(text).catch(() => {
                            const ta = document.createElement('textarea');
                            ta.value = text;
                            document.body.appendChild(ta);
                            ta.select();
                            document.execCommand('copy');
                            document.body.removeChild(ta);
                        });
                        // Visual feedback
                        copyBtn.classList.add('copied');
                        setTimeout(() => copyBtn.classList.remove('copied'), 1200);
                        this.app.toaster?.show('已复制', 'success', false, 1500);
                    });
                }
            });

            // 5. Double-click subtask text → inline edit
            card.querySelectorAll('.subtask-text').forEach((textSpan) => {
                textSpan.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    this.inlineEditSubtask(card, thought, textSpan);
                });
            });

            // 6. Quick add subtask button (inside subtask-list)
            const addSubBtn = card.querySelector('.subtask-add-inline');
            if (addSubBtn) {
                addSubBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.quickAddSubtask(card, thought);
                });
            }

            const summaryRow = card.querySelector('.subtasks-summary-row');
            if (summaryRow) {
                summaryRow.onclick = (e) => {
                    e.stopPropagation();
                    card.classList.add('expanded');
                };
            }

            this.timeline.appendChild(card);
        });
    }

    renderAISuggestedTags(thought, userTags = []) {
        const current = new Set((userTags || []).map(tag => tag.toLowerCase()));
        const suggestions = (thought.aiTags || [])
            .map(tag => this.normalizeTag(tag))
            .filter(Boolean)
            .filter(tag => !current.has(tag.toLowerCase()))
            .slice(0, 4);

        if (suggestions.length === 0) return '';

        return `
            <div class="thought-ai-tags" title="AI 建议标签，点击后加入当前 Thought">
                ${suggestions.map(tag => `
                    <button type="button" class="thought-ai-tag-suggestion" data-ai-tag="${this.escapeHtml(tag)}">
                        +#${this.escapeHtml(tag)}
                    </button>
                `).join('')}
            </div>
        `;
    }

    async acceptAITag(thoughtId, rawTag) {
        const tag = this.normalizeTag(rawTag);
        if (!tag) return;

        const thought = this.thoughts.find(item => item.id === thoughtId);
        if (!thought) return;

        const tags = Array.isArray(thought.tags) ? [...thought.tags] : [];
        if (tags.some(item => item.toLowerCase() === tag.toLowerCase())) return;

        tags.push(tag);
        thought.tags = tags;
        this.saveTag(tag);
        this.render();

        try {
            await this.apiClient.overwrite(thoughtId, {
                text: thought.text,
                subItems: thought.subItems || [],
                tags,
                completed: thought.completed
            });
        } catch (err) {
            console.error('Failed to accept AI tag:', err);
            this.enqueueThoughtOverwrite(thought);
            this.render();
            this.app.toaster?.show('标签保存失败', 'error', false, 2200);
        }
    }

    async removeThoughtTag(thoughtId, rawTag) {
        const tag = this.normalizeTag(rawTag);
        if (!tag) return;

        const thought = this.thoughts.find(item => item.id === thoughtId);
        if (!thought) return;

        const originalTags = Array.isArray(thought.tags) ? [...thought.tags] : [];
        const nextTags = originalTags.filter(item => item.toLowerCase() !== tag.toLowerCase());
        if (nextTags.length === originalTags.length) return;

        thought.tags = nextTags;
        if (this.activeTag.toLowerCase() === tag.toLowerCase() && !this.isTagUsed(tag)) {
            this.activeTag = '';
        }
        this.render();

        try {
            await this.apiClient.overwrite(thoughtId, {
                text: thought.text,
                subItems: thought.subItems || [],
                tags: nextTags,
                completed: thought.completed
            });
        } catch (err) {
            console.error('Failed to remove thought tag:', err);
            this.enqueueThoughtOverwrite(thought);
            this.render();
            this.app.toaster?.show('标签移除失败', 'error', false, 2200);
        }
    }

    isTagUsed(rawTag) {
        const tag = this.normalizeTag(rawTag).toLowerCase();
        if (!tag) return false;
        return this.thoughts.some(thought => (
            thought.tags || []
        ).some(item => this.normalizeTag(item).toLowerCase() === tag));
    }

    normalizeAIStatus(status = '') {
        return ['pending', 'ready', 'empty', 'error', 'missing'].includes(status) ? status : 'missing';
    }

    aiStatusLabel(status, relationCount = 0) {
        if (status === 'pending') return 'AI 处理中';
        if (status === 'ready') return relationCount > 0 ? `AI 已关联 ${relationCount}` : 'AI 已分析';
        if (status === 'empty') return 'AI 无内容';
        if (status === 'error') return 'AI 失败';
        return 'AI 未分析';
    }

    aiStatusIcon(status) {
        if (status === 'pending') {
            return '<svg class="thought-tool-icon spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"></path><path d="M12 18v4"></path><path d="m4.93 4.93 2.83 2.83"></path><path d="m16.24 16.24 2.83 2.83"></path><path d="M2 12h4"></path><path d="M18 12h4"></path><path d="m4.93 19.07 2.83-2.83"></path><path d="m16.24 7.76 2.83-2.83"></path></svg>';
        }
        if (status === 'ready') {
            return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8L12 3Z"></path><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"></path></svg>';
        }
        if (status === 'error') {
            return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"></path></svg>';
        }
        if (status === 'empty') {
            return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"></path></svg>';
        }
        return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';
    }

    renderAIStatus(thought, status, relationCount = 0) {
        const label = this.aiStatusLabel(status, relationCount);
        const count = Math.max(0, Number.isFinite(Number(relationCount)) ? Number(relationCount) : 0);
        const errorMessage = thought.aiError?.message ? `：${thought.aiError.message}` : '';
        return `
            <button type="button" class="thought-tool-btn thought-ai-status ${this.escapeHtml(status)}" data-ai-status="${this.escapeHtml(thought.id)}" title="${this.escapeHtml(label + errorMessage)}" aria-label="${this.escapeHtml(label + '，点击查看详情')}" aria-expanded="false">
                ${this.aiStatusIcon(status)}
                <span class="thought-ai-count">${count}</span>
            </button>
        `;
    }

    async toggleAIStatusPanel(card, thought) {
        const existing = card.querySelector('.thought-ai-detail-panel');
        const button = card.querySelector('.thought-ai-status');

        if (existing) {
            existing.remove();
            card.classList.remove('ai-detail-open');
            button?.setAttribute('aria-expanded', 'false');
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'thought-ai-detail-panel';
        panel.innerHTML = '<div class="thought-ai-detail-state">正在读取 AI 状态...</div>';
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
            const retry = e.target.closest('.thought-ai-detail-retry');
            if (retry) this.retryAIProcessing(thought.id);
        });

        card.appendChild(panel);
        card.classList.add('ai-detail-open');
        button?.setAttribute('aria-expanded', 'true');

        try {
            const detail = await this.apiClient.getAIStatus(thought.id);
            panel.innerHTML = this.renderAIStatusDetail(detail);
        } catch (err) {
            console.error('Failed to fetch thought AI status:', err);
            panel.innerHTML = `
                <div class="thought-ai-detail-state error">AI 状态读取失败</div>
                <button type="button" class="thought-ai-detail-retry">重试分析</button>
            `;
        }
    }

    renderAIStatusDetail(detail = {}) {
        const stageRows = [
            ['queued', '排队'],
            ['analysis', '分析'],
            ['embedding', '嵌入'],
            ['relations', '关联']
        ].map(([key, label]) => this.renderAIStageRow(label, detail.stages?.[key])).join('');
        const diagnostics = detail.diagnostics || {};
        const error = detail.error?.message ? `
            <div class="thought-ai-detail-error">${this.escapeHtml(detail.error.stage || 'AI')}：${this.escapeHtml(detail.error.message)}</div>
        ` : '';
        const counts = [
            `关联 ${Number(detail.relationCount || 0)}`,
            `建议 ${Number(detail.suggestionCount || 0)}`,
            `待评估 ${Number(diagnostics.candidateCount || detail.stages?.relations?.candidateCount || 0)}`
        ].join(' · ');
        return `
            <div class="thought-ai-detail-head">
                <span>${this.escapeHtml(this.aiStatusLabel(this.normalizeAIStatus(detail.status), detail.relationCount || 0))}</span>
                ${detail.status === 'error' ? '<button type="button" class="thought-ai-detail-retry">重试</button>' : ''}
            </div>
            <div class="thought-ai-detail-counts">${this.escapeHtml(counts)}</div>
            <div class="thought-ai-stage-list">${stageRows}</div>
            ${error}
        `;
    }

    renderAIStageRow(label, stage = {}) {
        const status = this.normalizeAIStageStatus(stage.status);
        const extra = [
            stage.model,
            Number.isFinite(Number(stage.dims)) ? `${Number(stage.dims)}维` : '',
            Number.isFinite(Number(stage.confirmedCount)) ? `确认${Number(stage.confirmedCount)}` : '',
            Number.isFinite(Number(stage.suggestionCount)) ? `建议${Number(stage.suggestionCount)}` : '',
            stage.rerankJudge && stage.rerankJudge !== 'ready' ? stage.rerankJudge : ''
        ].filter(Boolean).join(' · ');
        return `
            <div class="thought-ai-stage-row ${this.escapeHtml(status)}">
                <span class="thought-ai-stage-dot"></span>
                <span class="thought-ai-stage-name">${this.escapeHtml(label)}</span>
                <span class="thought-ai-stage-status">${this.escapeHtml(this.aiStageLabel(status))}</span>
                ${extra ? `<span class="thought-ai-stage-extra">${this.escapeHtml(extra)}</span>` : ''}
            </div>
        `;
    }

    normalizeAIStageStatus(status = '') {
        return ['pending', 'ready', 'skipped', 'error', 'missing'].includes(status) ? status : 'missing';
    }

    aiStageLabel(status) {
        if (status === 'ready') return '完成';
        if (status === 'pending') return '处理中';
        if (status === 'skipped') return '跳过';
        if (status === 'error') return '失败';
        return '未开始';
    }

    async retryAIProcessing(thoughtId) {
        const thought = this.thoughts.find(item => item.id === thoughtId);
        if (thought) {
            thought.aiStatus = 'pending';
            thought.aiError = null;
            this.render();
        }

        try {
            await this.apiClient.retryAI(thoughtId);
        } catch (err) {
            console.error('Failed to retry thought AI processing:', err);
            if (thought) {
                thought.aiStatus = 'error';
                thought.aiError = { message: err.message };
                this.render();
            }
            this.app.toaster?.show('AI 重试失败', 'error', false, 2500);
        }
    }

    async toggleRelationsPanel(card, thought) {
        const existing = card.querySelector('.thought-relations-panel');
        const button = card.querySelector('.thought-relations-btn');

        if (existing) {
            existing.remove();
            button?.classList.remove('active');
            button?.setAttribute('aria-expanded', 'false');
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'thought-relations-panel';
        panel.innerHTML = '<div class="thought-relations-state">正在加载关联...</div>';
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
            const confirmSuggestion = e.target.closest('.thought-relation-suggestion-confirm');
            if (confirmSuggestion) {
                this.createManualRelation(card, thought, confirmSuggestion.dataset.relationConfirmTarget, 'suggested');
                return;
            }

            const ignoreSuggestion = e.target.closest('.thought-relation-suggestion-ignore');
            if (ignoreSuggestion) {
                this.ignoreSuggestedRelation(card, thought.id, ignoreSuggestion.dataset.relationIgnoreTarget);
                return;
            }

            const deleteButton = e.target.closest('.thought-relation-delete');
            if (deleteButton) {
                this.deleteRelation(card, thought.id, deleteButton.dataset.relationDelete);
                return;
            }

            const moreButton = e.target.closest('.thought-relations-more');
            if (moreButton) {
                const section = moreButton.closest('.thought-relations-section');
                section?.querySelectorAll('.relation-collapsed').forEach((item) => {
                    item.classList.remove('relation-collapsed');
                    item.removeAttribute('hidden');
                });
                moreButton.remove();
                return;
            }

            const item = e.target.closest('.thought-relation-item');
            if (item) {
                this.jumpToRelationTarget(item.dataset.relationTarget, Number(item.dataset.relationCreatedAt || 0));
                return;
            }

            const suggestionMain = e.target.closest('.thought-relation-suggestion-main');
            if (suggestionMain) {
                this.jumpToRelationTarget(suggestionMain.dataset.relationTarget, Number(suggestionMain.dataset.relationCreatedAt || 0));
                return;
            }

            const manualTarget = e.target.closest('.thought-manual-relation-option');
            if (manualTarget) {
                this.createManualRelation(card, thought, manualTarget.dataset.manualRelationTarget);
            }
        });
        panel.addEventListener('input', (e) => {
            const input = e.target.closest('.thought-manual-relation-input');
            if (!input) return;
            this.queueManualRelationSearch(panel, thought.id, input.value);
        });
        card.appendChild(panel);
        button?.classList.add('active');
        button?.setAttribute('aria-expanded', 'true');

        try {
            await this.refreshRelationsPanel(panel, thought);
        } catch (err) {
            console.warn('Failed to fetch thought relations:', err);
            panel.innerHTML = '<div class="thought-relations-state error">关联加载失败</div>';
        }
    }

    async refreshRelationsPanel(panel, thought) {
        if (!panel || !thought?.id) return;
        let data;
        try {
            data = await this.apiClient.getRelations(thought.id);
        } catch (err) {
            if (err.status !== 404) throw err;
            panel.innerHTML = '<div class="thought-relations-state">暂无关联想法</div>';
            return;
        }
        panel.innerHTML = this.renderRelationsPanelContent(
            thought.id,
            this.normalizeAIStatus(data.status),
            data.relations || [],
            data.suggestions || [],
            data.error || null
        );
    }

    renderRelationsPanelContent(thoughtId, status, relations, suggestions = [], error = null) {
        return renderRelationsPanelContentHtml({
            thoughtId,
            status,
            relations,
            suggestions,
            error,
            escapeHtml: value => this.escapeHtml(value)
        });
    }

    renderManualRelationControls(thoughtId) {
        return renderManualRelationControlsHtml(thoughtId, value => this.escapeHtml(value));
    }

    queueManualRelationSearch(panel, sourceId, query) {
        const resultsEl = panel.querySelector('.thought-manual-relation-results');
        if (!resultsEl) return;
        const q = String(query || '').trim();
        const searchSeq = ++this.manualRelationSearchSeq;
        clearTimeout(this.manualRelationSearchTimer);

        if (!q) {
            resultsEl.innerHTML = '';
            return;
        }

        resultsEl.innerHTML = '<div class="thought-manual-relation-empty">搜索中...</div>';
        this.manualRelationSearchTimer = setTimeout(() => {
            this.searchManualRelationTargets(panel, sourceId, q, searchSeq);
        }, 180);
    }

    async searchManualRelationTargets(panel, sourceId, query, searchSeq = this.manualRelationSearchSeq) {
        const resultsEl = panel.querySelector('.thought-manual-relation-results');
        if (!resultsEl) return;
        const q = String(query || '').trim();
        if (!q) {
            resultsEl.innerHTML = '';
            return;
        }

        try {
            const thoughts = await this.apiClient.list({ query: q, limit: 8, light: true });
            if (searchSeq !== this.manualRelationSearchSeq) return;
            const linkedIds = new Set(
                Array.from(panel.querySelectorAll('.thought-relation-item'))
                    .map(item => item.dataset.relationTarget)
            );
            const options = thoughts
                .filter(item => item.id !== sourceId && !linkedIds.has(item.id))
                .slice(0, 6);
            resultsEl.innerHTML = options.length ? options.map(item => {
                const text = String(item.text || '').replace(/\s+/g, ' ').trim();
                const subItems = Array.isArray(item.subItems) ? item.subItems : [];
                const matchedSubItem = subItems
                    .map(subItem => String(subItem?.text || '').replace(/\s+/g, ' ').trim())
                    .find(subText => subText.toLowerCase().includes(q.toLowerCase()));
                const summary = this.buildManualRelationSummary(text, matchedSubItem, q);
                const summaryHtml = this.highlightPlainText(summary, q);
                return `
                    <button type="button" class="thought-manual-relation-option" data-manual-relation-target="${this.escapeHtml(item.id)}">
                        ${summaryHtml}
                    </button>
                `;
            }).join('') : '<div class="thought-manual-relation-empty">没有可链接结果</div>';
        } catch (err) {
            if (searchSeq !== this.manualRelationSearchSeq) return;
            console.warn('Failed to search manual relation targets:', err);
            resultsEl.innerHTML = '<div class="thought-manual-relation-empty">搜索失败</div>';
        }
    }

    buildManualRelationSummary(text, matchedSubItem, query) {
        const mainText = text || '空白想法';
        const lowerText = mainText.toLowerCase();
        const lowerQuery = String(query || '').toLowerCase();
        if (lowerQuery && lowerText.includes(lowerQuery)) {
            return this.textSnippetAroundQuery(mainText, query, 96);
        }
        if (matchedSubItem) {
            const mainPrefix = mainText.length > 36 ? `${mainText.slice(0, 36)}...` : mainText;
            return `${mainPrefix} · ${this.textSnippetAroundQuery(matchedSubItem, query, 72)}`;
        }
        return mainText.length > 96 ? `${mainText.slice(0, 96)}...` : mainText;
    }

    textSnippetAroundQuery(text, query, maxLength = 96) {
        const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
        const cleanQuery = String(query || '').trim();
        if (!cleanText || !cleanQuery || cleanText.length <= maxLength) return cleanText;

        const index = cleanText.toLowerCase().indexOf(cleanQuery.toLowerCase());
        if (index < 0) return `${cleanText.slice(0, maxLength)}...`;

        const side = Math.max(12, Math.floor((maxLength - cleanQuery.length) / 2));
        const start = Math.max(0, index - side);
        const end = Math.min(cleanText.length, index + cleanQuery.length + side);
        return `${start > 0 ? '...' : ''}${cleanText.slice(start, end)}${end < cleanText.length ? '...' : ''}`;
    }

    highlightPlainText(text, query) {
        const cleanText = String(text || '');
        const cleanQuery = String(query || '').trim();
        if (!cleanText || !cleanQuery) return this.escapeHtml(cleanText);

        const lowerText = cleanText.toLowerCase();
        const lowerQuery = cleanQuery.toLowerCase();
        let lastIdx = 0;
        let idx = lowerText.indexOf(lowerQuery);
        let html = '';

        while (idx !== -1) {
            html += this.escapeHtml(cleanText.slice(lastIdx, idx));
            html += `<mark class="thought-highlight">${this.escapeHtml(cleanText.slice(idx, idx + cleanQuery.length))}</mark>`;
            lastIdx = idx + cleanQuery.length;
            idx = lowerText.indexOf(lowerQuery, lastIdx);
        }

        html += this.escapeHtml(cleanText.slice(lastIdx));
        return html;
    }

    async createManualRelation(card, thought, targetId, relationType = 'manual') {
        if (!targetId || !thought?.id) return;
        const panel = card.querySelector('.thought-relations-panel');
        try {
            const data = await this.apiClient.createRelation(thought.id, targetId, relationType);
            thought.relationCount = data.relationCount;
            thought.aiStatus = 'ready';
            this.updateThoughtToolCounts(card, thought, 'ready', data.relationCount);

            const relationsData = await this.apiClient.getRelations(thought.id);
            if (panel) {
                panel.innerHTML = this.renderRelationsPanelContent(
                    thought.id,
                    this.normalizeAIStatus(relationsData.status),
                    relationsData.relations || [],
                    relationsData.suggestions || [],
                    relationsData.error || null
                );
            }
        } catch (err) {
            console.error('Failed to create manual relation:', err);
            thought.localPending = true;
            thought.relationCount = Number(thought.relationCount || 0) + 1;
            this.handleOutboxResult(this.outbox.enqueueCreateRelation(thought.id, targetId, relationType));
            this.render();
            this.app.toaster?.show('手动链接失败', 'error', false, 2400);
        }
    }

    async ignoreSuggestedRelation(card, sourceId, targetId) {
        if (!sourceId || !targetId) return;
        const item = card.querySelector(`.thought-relation-suggestion[data-relation-target="${CSS.escape(targetId)}"]`);
        const ignoreButton = item?.querySelector('.thought-relation-suggestion-ignore');
        ignoreButton?.classList.add('deleting');

        try {
            await this.apiClient.deleteRelation(sourceId, targetId);
            item?.remove();
            if (!card.querySelector('.thought-relation-item') && !card.querySelector('.thought-relation-suggestion')) {
                const panel = card.querySelector('.thought-relations-panel');
                if (panel) panel.innerHTML = this.renderRelationsPanelContent(sourceId, 'ready', [], []);
            }
            this.app.toaster?.show('已忽略推荐关联', 'success', false, 1600);
        } catch (err) {
            console.error('Failed to ignore suggested relation:', err);
            item?.remove();
            this.handleOutboxResult(this.outbox.enqueueDeleteRelation(sourceId, targetId));
            ignoreButton?.classList.remove('deleting');
            this.app.toaster?.show('忽略推荐失败', 'error', false, 2400);
        }
    }

    relationTypeLabel(type = '') {
        return relationTypeLabel(type);
    }

    relationStrengthClass(score) {
        return relationStrengthClass(score);
    }

    relationDisplayDate(value) {
        return relationDisplayDate(value);
    }

    relationDetailLine(parts = []) {
        return relationDetailLine(parts);
    }

    renderRelationsMoreButton(count) {
        return renderRelationsMoreButtonHtml(count, value => this.escapeHtml(value));
    }

    renderRelationsList(relations) {
        return renderRelationsListHtml(relations, value => this.escapeHtml(value));
    }

    renderSuggestedRelationsList(suggestions) {
        return renderSuggestedRelationsListHtml(suggestions, value => this.escapeHtml(value));
    }

    jumpToRelationTarget(targetId, createdAt) {
        if (!targetId) return;

        const targetCard = this.timeline.querySelector(`.thought-card[data-id="${CSS.escape(targetId)}"]`);
        if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCard.classList.add('relation-focus');
            setTimeout(() => targetCard.classList.remove('relation-focus'), 1800);
            return;
        }

        const targetLoaded = this.thoughts.some(thought => thought.id === targetId);
        if (targetLoaded) {
            this.app.toaster?.show('关联想法不在当前筛选结果中，请清除搜索、状态或标签筛选', 'info', false, 3000);
            return;
        }

        if (createdAt) {
            const targetDate = new Date(createdAt);
            const year = targetDate.getFullYear();
            const month = String(targetDate.getMonth() + 1).padStart(2, '0');
            const day = String(targetDate.getDate()).padStart(2, '0');
            this.app.toaster?.show(`关联想法在 ${year}-${month}-${day}，请切换日期或清除日期筛选`, 'info', false, 3500);
            return;
        }

        this.app.toaster?.show('关联想法不在当前列表中，请清除筛选后再试', 'info', false, 3000);
    }

    async deleteRelation(card, sourceId, targetId) {
        if (!sourceId || !targetId) return;

        const item = card.querySelector(`.thought-relation-item[data-relation-target="${CSS.escape(targetId)}"]`);
        const deleteButton = item?.querySelector('.thought-relation-delete');
        deleteButton?.classList.add('deleting');

        try {
            const data = await this.apiClient.deleteRelation(sourceId, targetId);

            item?.remove();
            const sourceThought = this.thoughts.find(thought => thought.id === sourceId);
            if (sourceThought) {
                sourceThought.relationCount = Number.isFinite(Number(data?.relationCount))
                    ? Number(data.relationCount)
                    : Math.max(0, Number(sourceThought.relationCount || 0) - 1);
            }

            if (sourceThought) this.updateThoughtToolCounts(card, sourceThought, sourceThought.aiStatus || 'ready', sourceThought.relationCount);

            if (!card.querySelector('.thought-relation-item') && !card.querySelector('.thought-relation-suggestion')) {
                const panel = card.querySelector('.thought-relations-panel');
                if (panel) panel.innerHTML = '<div class="thought-relations-state">暂无关联想法</div>';
            }

            this.app.toaster?.show('已删除关联', 'success', false, 1600);
        } catch (err) {
            console.error('Failed to delete thought relation:', err);
            item?.remove();
            const sourceThought = this.thoughts.find(thought => thought.id === sourceId);
            if (sourceThought) {
                sourceThought.localPending = true;
                sourceThought.relationCount = Math.max(0, Number(sourceThought.relationCount || 0) - 1);
            }
            this.handleOutboxResult(this.outbox.enqueueDeleteRelation(sourceId, targetId));
            this.render();
            deleteButton?.classList.remove('deleting');
            this.app.toaster?.show('删除关联失败', 'error', false, 2500);
        }
    }

    renderTagFilters() {
        if (!this.tagsFilter) return;
        const tags = this.getAllTags();
        let activeTag = this.activeTag.toLowerCase();
        const activeStillExists = tags.some(tag => tag.toLowerCase() === activeTag);
        if (this.activeTag && !activeStillExists) {
            this.activeTag = '';
            activeTag = '';
        }

        const tagButtons = tags.map(tag => `
            <button type="button" class="thoughts-tag-filter ${tag.toLowerCase() === activeTag ? 'active' : ''}" data-tag-filter="${this.escapeHtml(tag)}">
                #${this.escapeHtml(tag)}
            </button>
        `).join('');

        const customActive = this.activeTag && !activeStillExists ? `
            <button type="button" class="thoughts-tag-filter active" data-tag-filter="${this.escapeHtml(this.activeTag)}">#${this.escapeHtml(this.activeTag)}</button>
        ` : '';

        this.tagsFilter.innerHTML = `
            <div class="thoughts-tag-filter-row">
                ${tagButtons}
                ${customActive}
                <input id="thoughts-tag-filter-input" class="thoughts-tag-filter-input" type="text" placeholder="+ 标签筛选" autocomplete="off">
                ${this.activeTag ? '<button type="button" class="thoughts-tag-clear" data-clear-tag-filter>清除</button>' : ''}
            </div>
        `;
    }

    getAllTags() {
        return collectThoughtTags(this.thoughts, value => this.normalizeTag(value));
    }

    renderTagFilters() {
        if (!this.tagsFilter) return;
        const tags = this.getAllTags();
        const activeTag = this.activeTag.toLowerCase();
        const activeStillExists = tags.some(tag => tag.toLowerCase() === activeTag);

        const tagButtons = tags.map(tag => `
            <button type="button" class="thoughts-tag-filter ${tag.toLowerCase() === activeTag ? 'active' : ''}" data-tag-filter="${this.escapeHtml(tag)}">
                <span>#</span>${this.escapeHtml(tag)}
            </button>
        `).join('');

        this.tagsFilter.innerHTML = `
            <div class="thoughts-tag-filter-row">
                ${tagButtons}
                <label class="thoughts-tag-create">
                    <span>#</span>
                    <input id="thoughts-tag-filter-input" class="thoughts-tag-filter-input" type="text" placeholder="新建或筛选" autocomplete="off">
                </label>
                ${this.activeTag ? '<button type="button" class="thoughts-tag-clear" data-clear-tag-filter>清除</button>' : ''}
            </div>
        `;
    }

    getAllTags() {
        const tagMap = new Map();
        this.thoughts.forEach(thought => {
            (thought.tags || []).forEach(rawTag => {
                const tag = this.normalizeTag(rawTag);
                if (!tag) return;
                const key = tag.toLowerCase();
                if (!tagMap.has(key)) tagMap.set(key, tag);
            });
        });
        return Array.from(tagMap.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    }

    loadSavedTags() {
        try {
            const raw = localStorage.getItem('dumbpad_thought_tags');
            if (!raw) return [];
            const tags = JSON.parse(raw);
            if (!Array.isArray(tags)) return [];
            return tags.map(tag => this.normalizeTag(tag)).filter(Boolean);
        } catch (err) {
            console.warn('Failed to load thought tags:', err);
            return [];
        }
    }

    persistSavedTags() {
        try {
            localStorage.setItem('dumbpad_thought_tags', JSON.stringify(this.savedTags));
        } catch (err) {
            console.warn('Failed to save thought tags:', err);
        }
    }

    saveTag(value) {
        const tag = this.normalizeTag(value);
        if (!tag) return '';
        const exists = this.savedTags.some(t => t.toLowerCase() === tag.toLowerCase());
        if (!exists) {
            this.savedTags.push(tag);
            this.savedTags.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
            this.persistSavedTags();
        }
        return tag;
    }

    syncTagsFromThoughts(thoughts) {
        let changed = false;
        thoughts.forEach(thought => {
            (thought.tags || []).forEach(rawTag => {
                const tag = this.normalizeTag(rawTag);
                if (!tag) return;
                const exists = this.savedTags.some(t => t.toLowerCase() === tag.toLowerCase());
                if (!exists) {
                    this.savedTags.push(tag);
                    changed = true;
                }
            });
        });
        if (changed) {
            this.savedTags.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
            this.persistSavedTags();
        }
    }

    normalizeTag(value) {
        return String(value || '')
            .replace(/^#+/, '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 24);
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
            const nextSubItems = cleanSubItems(subtasks);

            const hasTextChanged = newText !== thought.text;
            const hasSubsChanged = JSON.stringify(nextSubItems) !== JSON.stringify(thought.subItems || []);

            if (hasTextChanged || hasSubsChanged) {
                thought.text = newText;
                thought.subItems = nextSubItems;
                try {
                    await this.apiClient.overwrite(thought.id, thought);
                } catch (err) {
                    console.error('Failed to save thought:', err);
                    this.enqueueThoughtOverwrite(thought);
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

    async quickAddSubtask(card, thought) {
        let sublist = card.querySelector('.subtask-list');
        let createdSublist = false;
        if (!sublist) {
            sublist = document.createElement('div');
            sublist.className = 'subtask-list transient-subtask-list';
            const footer = card.querySelector('.thought-card-footer');
            if (footer) {
                card.insertBefore(sublist, footer);
            } else {
                card.appendChild(sublist);
            }
            createdSublist = true;
        }
        const addBtn = sublist.querySelector('.subtask-add-inline');
        const footerAddBtn = card.querySelector('.subtask-add-footer');

        if (addBtn) addBtn.style.display = 'none';
        if (footerAddBtn) footerAddBtn.style.display = 'none';
        const row = document.createElement('div');
        row.className = 'subtask';
        row.innerHTML = '<input type="checkbox" class="subtask-check" disabled><input type="text" class="subtask-inline-input" placeholder="新增子任务...">';
        if (addBtn) {
            sublist.insertBefore(row, addBtn);
        } else {
            sublist.appendChild(row);
        }
        const input = row.querySelector('input[type="text"]');
        input.focus();

        let committed = false;

        const cleanup = () => {
            row.remove();
            if (addBtn) addBtn.style.display = '';
            if (footerAddBtn) footerAddBtn.style.display = '';
            if (createdSublist && !sublist.querySelector('.subtask')) {
                sublist.remove();
            }
        };

        const commit = async () => {
            if (committed) return;
            committed = true;
            const text = input.value.trim();
            if (!text) { cleanup(); return; }
            const subItem = createSubItem(text);
            thought.subItems = Array.isArray(thought.subItems) ? [...thought.subItems, subItem] : [subItem];
            this.render();
            try {
                const updated = await this.apiClient.addSubitem(thought.id, text);
                const idx = this.thoughts.findIndex(t => t.id === thought.id);
                if (idx !== -1) this.thoughts[idx] = updated.thought;
                this.render();
            } catch (err) {
                console.error('Failed to add subtask:', err);
                this.enqueueThoughtOverwrite(thought);
                this.render();
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { cleanup(); }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => { if (row.parentNode) commit(); }, 100);
        });
    }

    inlineEditSubtask(card, thought, textSpan) {
        const subtaskEl = textSpan.closest('.subtask');
        const subId = subtaskEl.dataset.subid;
        const originalText = textSpan.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'subtask-inline-input';
        input.value = originalText;
        input.style.margin = '0';
        textSpan.replaceWith(input);
        input.focus();
        input.select();

        const commit = async () => {
            const newText = input.value.trim();
            if (newText === originalText) { input.replaceWith(textSpan); return; }

            try {
                if (!newText) {
                    thought.subItems = (thought.subItems || []).filter(item => item.id !== subId);
                    this.render();
                    // Empty text = delete subtask
                    await this.apiClient.deleteSubitem(thought.id, subId);
                } else {
                    const sub = (thought.subItems || []).find(item => item.id === subId);
                    if (sub) sub.text = newText;
                    this.render();
                    await this.apiClient.updateSubitem(thought.id, subId, newText);
                }
            } catch (err) {
                console.error('Failed to edit subtask:', err);
                this.enqueueThoughtOverwrite(thought);
                this.render();
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { input.replaceWith(textSpan); }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => { if (input.parentNode) commit(); }, 100);
        });
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
            thought.text = bodyText;
            thought.subItems = assignRealSubItemIds(subItems);
            this.render();
            try {
                await this.apiClient.overwrite(id, thought);
            } catch (err) {
                console.error('Failed to toggle legacy subtask:', err);
                this.enqueueThoughtOverwrite(thought);
                this.render();
            }
            return;
        }

        const sub = thought.subItems.find(s => s.id === subId);
        if (!sub) return;

        // Optimistic update
        sub.completed = !sub.completed;
        this.render();

        try {
            await this.apiClient.toggleSubitem(id, subId);
        } catch (err) {
            console.error('Failed to toggle subtask:', err);
            this.enqueueThoughtOverwrite(thought);
            this.render();
        }
    }

    _parseLegacyText(text) {
        return parseLegacyText(text);
    }

    linkify(text) {
        if (!text) return '';
        const escaped = this.escapeHtml(text);
        return escaped.replace(/((?:https?:\/\/|www\.)[^\s<>\'\"]+)/gi, (match) => {
            let url = match;
            let trailing = '';
            const punctuation = /[.,;:!?\)]$/;
            while (punctuation.test(url)) {
                if (url.endsWith(')')) {
                    const openParentheses = (url.match(/\(/g) || []).length;
                    const closeParentheses = (url.match(/\)/g) || []).length;
                    if (closeParentheses > openParentheses) {
                        trailing = url.slice(-1) + trailing;
                        url = url.slice(0, -1);
                        continue;
                    }
                } else {
                    trailing = url.slice(-1) + trailing;
                    url = url.slice(0, -1);
                    continue;
                }
                break;
            }
            let href = url;
            if (url.toLowerCase().startsWith('www.')) {
                href = 'https://' + url;
            }
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="thought-link">${url}</a>${trailing}`;
        });
    }

    highlightSearch(htmlString, query) {
        if (!query) return htmlString;
        const template = document.createElement('div');
        template.innerHTML = htmlString;
        
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.nodeValue;
                const lowerText = text.toLowerCase();
                const lowerQuery = query.toLowerCase();
                if (lowerText.includes(lowerQuery)) {
                    const fragment = document.createDocumentFragment();
                    let lastIdx = 0;
                    let idx = lowerText.indexOf(lowerQuery);
                    while (idx !== -1) {
                        if (idx > lastIdx) {
                            fragment.appendChild(document.createTextNode(text.substring(lastIdx, idx)));
                        }
                        const mark = document.createElement('mark');
                        mark.className = 'thought-highlight';
                        mark.textContent = text.substring(idx, idx + query.length);
                        fragment.appendChild(mark);
                        
                        lastIdx = idx + query.length;
                        idx = lowerText.indexOf(lowerQuery, lastIdx);
                    }
                    if (lastIdx < text.length) {
                        fragment.appendChild(document.createTextNode(text.substring(lastIdx)));
                    }
                    node.parentNode.replaceChild(fragment, node);
                }
            } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'MARK') {
                const children = Array.from(node.childNodes);
                for (const child of children) {
                    walk(child);
                }
            }
        };
        
        Array.from(template.childNodes).forEach(walk);
        return template.innerHTML;
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
