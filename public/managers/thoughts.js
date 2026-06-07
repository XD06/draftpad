import ThoughtApiClient from './thought-api-client.js';
import ThoughtOutbox from './thought-outbox.js';
import {
    renderManualRelationControls as renderManualRelationControlsHtml,
    renderManualRelationSearchOptions,
    renderRelationsPanelContent as renderRelationsPanelContentHtml
} from './thought-relations-panel.js';
import {
    applyManualRelationCreated,
    applyManualRelationCreateFailure,
    applyRelationDeleted,
    applyRelationDeleteFailure
} from './thought-relations-state.js';
import {
    appendLocalSubItem,
    applyLocalSubItemTextEdit,
    cleanSubItems,
    getEditableThoughtParts,
    migrateAndToggleLegacySubItem,
    parseLegacyText,
    renderSubtaskAddRow,
    renderSubtaskEditRow,
    renderSubtaskInlineAddRow,
    sortSubItems,
    toggleLocalSubItemCompletion
} from './thought-editor.js';
import { filterThoughts, sortThoughts } from './thought-renderer.js';
import {
    ThoughtTagRegistry,
    renderAISuggestedTags as renderAISuggestedTagsHtml,
    renderQuickAddTagChoices,
    renderQuickAddTagSuggestions as renderQuickAddTagSuggestionsHtml,
    renderThoughtTagFilters
} from './thought-tags.js';
import {
    AI_PENDING_MIN_VISIBLE_MS,
    applyAIStatusDetail,
    getAIStatusPendingDelay,
    normalizeAIStatus,
    renderAIStatusButton,
    renderAIStatusDetail as renderAIStatusDetailHtml,
    renderAIStatusError,
    renderAIStatusLoading
} from './thought-ai-status.js';
import { renderThoughtCard } from './thought-card-renderer.js';
import { applyThoughtTextStyle, escapeHtml as escapeThoughtHtml, formatThoughtText } from './thought-text-formatting.js';
import { buildQuickAddCreateOutboxItem, createLocalPendingThought, markCreatedThoughtPending } from './thought-quick-add.js';

const THOUGHTS_CACHE_KEY = 'dumbpad_thoughts_cache_v1';

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

        this.thoughts = this.loadThoughtsCache();
        this.quickAddTags = [];
        this.activeTag = '';
        this.tagRegistry = app.tagRegistry || new ThoughtTagRegistry();
        this.isActive = false;
        this.pendingCreateIds = new Set(); // Prevent duplicate from race conditions
        this.pendingAIStatusTimers = new Map();
        this.outboxInFlight = false;
        this.manualRelationSearchTimer = null;
        this.manualRelationSearchSeq = 0;
        this.openRelationsPanelIds = new Set();
        this.openAIStatusPanelIds = new Set();
        this.expandedThoughtIds = new Set();
        this.activeThoughtSelection = null;
        this.thoughtSelectionToolbar = null;

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
        this.initQuickAddEvents();
        this.initThoughtsToggleEvents();
        this.initSearchAndFilterEvents();
        this.initOutboxEvents();
        this.initSocketEvents();

        this.handleHashChange();
    }

    initQuickAddEvents() {
        if (this.quickAddBar) {
            this.quickAddBar.querySelector('.quick-add-backdrop').addEventListener('click', () => this.closeQuickAdd());
            this.quickAddSubmit.addEventListener('click', (e) => { e.stopPropagation(); this.submitQuickAdd(); });
            this.quickAddInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.submitQuickAdd();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.closeQuickAdd();
                }
            });
            this.quickAddInput.addEventListener('input', () => {
                this.quickAddInput.style.height = 'auto';
                this.quickAddInput.style.height = Math.min(this.quickAddInput.scrollHeight, 160) + 'px';
            });
            this.initQuickAddTagEvents();
        }
    }

    initThoughtsToggleEvents() {
        this.toggleBtn.addEventListener('click', () => {
            if (this.isActive) {
                window.location.hash = '';
            } else {
                window.location.hash = 'thoughts';
            }
        });

        window.addEventListener('hashchange', () => this.handleHashChange());

        document.querySelector('#header-title h1')?.addEventListener('click', () => {
            if (this.isActive) {
                window.location.hash = '';
            }
        });
    }

    initSearchAndFilterEvents() {
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
                        if (card.dataset.id) this.expandedThoughtIds.delete(card.dataset.id);
                    }
                });
            });
        }

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
    }

    initOutboxEvents() {
        if (this.outboxStatus) {
            this.outboxStatus.addEventListener('click', () => this.retryOutbox({ silent: false }));
        }
    }

    initSocketEvents() {
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
            if (this.thoughts.length > 0) {
                this.syncTagsFromThoughts(this.thoughts);
                this.render();
            }
            await this.fetchThoughts();
        } else {
            document.body.classList.remove('thoughts-mode');
            this.view.style.display = 'none';
            this.editorContainer.style.display = 'flex';
            this.toggleBtn.classList.remove('active');
            if (floatingActions) floatingActions.style.display = 'flex';
        }
    }

    loadThoughtsCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(THOUGHTS_CACHE_KEY) || 'null');
            const thoughts = Array.isArray(cached?.thoughts) ? cached.thoughts : [];
            return this.mergeOutboxThoughts(thoughts);
        } catch (_error) {
            return this.mergeOutboxThoughts([]);
        }
    }

    saveThoughtsCache(thoughts) {
        try {
            localStorage.setItem(THOUGHTS_CACHE_KEY, JSON.stringify({
                updatedAt: Date.now(),
                thoughts: Array.isArray(thoughts) ? thoughts.slice(0, 500) : []
            }));
        } catch (_error) {
            // Cache is a best-effort startup accelerator.
        }
    }

    loadOutbox() {
        return this.outbox.load();
    }

    updateOutboxStatus(items = this.loadOutbox()) {
        if (!this.outboxStatus) return;
        const count = items.length;
        this.outboxStatus.hidden = count === 0;
        this.outboxStatus.textContent = count > 0 ? `待同步 ${count}` : '待同步 0';
        this.outboxStatus.disabled = this.outboxInFlight;
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
            if (!date && !query) this.saveThoughtsCache(this.thoughts);
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
        const tags = [...this.quickAddTags];
        const tempThought = createLocalPendingThought({
            text,
            tags,
            now: Date.now()
        });

        this.thoughts.unshift(tempThought);
        this.syncTagsFromThoughts([tempThought]);
        this.render();
        this.closeQuickAdd();
        this.isAdding = false;

        setTimeout(() => {
            const card = document.querySelector(`.thought-card[data-id="${CSS.escape(tempThought.id)}"]`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);

        try {
            const data = markCreatedThoughtPending(
                await this.apiClient.create({ text, tags })
            );
            this.pendingCreateIds.add(data.id);
            const tempIndex = this.thoughts.findIndex(t => t.id === tempThought.id);
            this.thoughts = this.thoughts.filter(t => t.id !== tempThought.id && t.id !== data.id);
            this.thoughts.splice(tempIndex >= 0 ? tempIndex : 0, 0, data);
            this.syncTagsFromThoughts([data]);
            this.render();

            setTimeout(() => {
                const card = document.querySelector(`.thought-card[data-id="${CSS.escape(data.id)}"]`);
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);

            setTimeout(() => this.pendingCreateIds.delete(data.id), 2000);
        } catch (err) {
            console.error('Failed to add thought:', err);
            this.handleOutboxResult(this.outbox.enqueueCreate(buildQuickAddCreateOutboxItem({
                text,
                tags,
                tempThought
            })));
            this.render();
        } finally {
            this.isAdding = false;
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
        this.quickAddTagsList.innerHTML = renderQuickAddTagChoices({
            tags,
            selectedTags: this.quickAddTags,
            escapeHtml: value => this.escapeHtml(value)
        });
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

        this.quickAddTagSuggestions.innerHTML = renderQuickAddTagSuggestionsHtml({
            suggestions,
            escapeHtml: value => this.escapeHtml(value)
        });
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

        this.updateThoughtRelationCount(thoughtId, nextCount, 'ready');
    }

    updateThoughtRelationCount(thoughtId, relationCount, status = 'ready') {
        if (!thoughtId) return null;
        const nextCount = Math.max(0, Number.isFinite(Number(relationCount)) ? Number(relationCount) : 0);
        const thought = this.thoughts.find(item => item.id === thoughtId);
        if (thought) {
            thought.relationCount = nextCount;
            thought.aiStatus = status;
            delete thought.aiPendingSince;
        }

        const card = this.timeline?.querySelector(`.thought-card[data-id="${CSS.escape(thoughtId)}"]`);
        if (card && thought) this.updateThoughtToolCounts(card, thought, status, nextCount);
        const panel = card?.querySelector('.thought-relations-panel');
        if (panel && thought) {
            this.refreshRelationsPanel(panel, thought);
        }
        return nextCount;
    }

    updateThoughtToolCounts(card, thought, status = this.normalizeAIStatus(thought?.aiStatus), relationCount = Number(thought?.relationCount || 0)) {
        if (!card || !thought) return;
        const nextCount = Math.max(0, Number.isFinite(Number(relationCount)) ? Number(relationCount) : 0);
        const countEl = card.querySelector('.relations-count');
        if (countEl) {
            countEl.textContent = nextCount;
            countEl.classList.toggle('is-zero', nextCount === 0);
            countEl.classList.toggle('has-count', nextCount > 0);
        }

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

        applyAIStatusDetail(thought, detail, {
            normalizeTag: tag => this.normalizeTag(tag),
            now: Date.now()
        });
        this.render();
    }

    shouldDelayAIStatusUpdate(thought, nextStatus, detail) {
        const remaining = getAIStatusPendingDelay(thought, nextStatus, {
            now: Date.now(),
            minVisibleMs: AI_PENDING_MIN_VISIBLE_MS
        });
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
        return this.confirmAndDeleteThought(id);
    }

    async confirmAndDeleteThought(id, { skipConfirm = false } = {}) {
        if (!this.pendingDeletes) this.pendingDeletes = new Set();
        if (this.pendingDeletes.has(id)) return;
        
        this.pendingDeletes.add(id);

        const confirmed = skipConfirm ? true : await this.app.confirmationManager.show('确定将这条 Thought 移入垃圾桶吗？');
        
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

            const renderedCard = renderThoughtCard({
                thought,
                query,
                parseLegacyText: text => this._parseLegacyText(text),
                sortSubItems,
                linkify: text => this.linkify(text),
                highlightSearch: (html, term) => this.highlightSearch(html, term),
                escapeHtml: value => this.escapeHtml(value),
                renderAISuggestedTags: (item, tags) => this.renderAISuggestedTags(item, tags),
                renderAIStatus: (item, statusValue, relationCount) => this.renderAIStatus(item, statusValue, relationCount),
                normalizeAIStatus: statusValue => this.normalizeAIStatus(statusValue)
            });
            const { bodyText, isLong } = renderedCard;
            if (isLong) card.classList.add('can-expand');
            if (this.expandedThoughtIds.has(thought.id)) card.classList.add('expanded');
            card.innerHTML = renderedCard.html;

            this.bindThoughtCardEvents({ card, thought, bodyText, isLong });

            this.timeline.appendChild(card);
        });
        this.restoreOpenPanelsAfterRender();
    }

    restoreOpenPanelsAfterRender() {
        this.openRelationsPanelIds.forEach((thoughtId) => {
            const thought = this.thoughts.find(item => item.id === thoughtId);
            const card = this.timeline.querySelector(`.thought-card[data-id="${CSS.escape(thoughtId)}"]`);
            if (thought && card && !card.querySelector('.thought-relations-panel')) {
                this.openRelationsPanel(card, thought);
            }
        });

        this.openAIStatusPanelIds.forEach((thoughtId) => {
            const thought = this.thoughts.find(item => item.id === thoughtId);
            const card = this.timeline.querySelector(`.thought-card[data-id="${CSS.escape(thoughtId)}"]`);
            if (thought && card && !card.querySelector('.thought-ai-detail-panel')) {
                this.openAIStatusPanel(card, thought);
            }
        });
    }

    setThoughtCardExpanded(card, thoughtId, expanded, { collapseOthers = false } = {}) {
        if (!card || !thoughtId) return;
        if (collapseOthers) {
            this.timeline.querySelectorAll('.thought-card.expanded').forEach((item) => {
                if (item === card) return;
                item.classList.remove('expanded');
                if (item.dataset.id) this.expandedThoughtIds.delete(item.dataset.id);
            });
        }
        card.classList.toggle('expanded', expanded);
        if (expanded) {
            this.expandedThoughtIds.add(thoughtId);
        } else {
            this.expandedThoughtIds.delete(thoughtId);
        }
    }

    focusExpandedThought(thoughtId) {
        if (!thoughtId) return;
        Array.from(this.expandedThoughtIds).forEach((id) => {
            if (id !== thoughtId) this.expandedThoughtIds.delete(id);
        });
        this.expandedThoughtIds.add(thoughtId);
    }

    bindThoughtCardEvents({ card, thought, bodyText, isLong }) {
        const textEl = card.querySelector('.thought-text');
        const dotEl = card.querySelector('.thought-dot');
        const thoughtCopyBtn = card.querySelector('.thought-copy-btn');

        dotEl.onclick = (e) => {
            e.stopPropagation();
            this.toggleComplete(thought.id);
        };

        if (thoughtCopyBtn) {
            thoughtCopyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copyTextWithFeedback(thoughtCopyBtn, bodyText);
            });
        }

        this.bindThoughtSelectionFormatting(card, thought);
        this.bindThoughtInlineStyleClearing(card, thought);
        this.bindThoughtSwipeDelete(card, thought);

        let lastTap = 0;
        let tapTimeout;
        const handleGesture = (e) => {
            if (this.shouldIgnoreCardGesture(e, card)) return;

            const now = Date.now();
            const DOUBLE_TAP_DELAY = 300;

            if (now - lastTap < DOUBLE_TAP_DELAY) {
                clearTimeout(tapTimeout);
                this.enterEditMode(card, thought);
                lastTap = 0;
            } else {
                lastTap = now;
                tapTimeout = setTimeout(() => {
                    if (this.scrollFirstSearchHighlight(card)) return;
                    if (isLong) {
                        this.setThoughtCardExpanded(card, thought.id, !card.classList.contains('expanded'), { collapseOthers: true });
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

        card.querySelectorAll('.subtask-check').forEach((check) => {
            const subtaskEl = check.closest('.subtask');
            const subId = subtaskEl.dataset.subid;
            check.onchange = () => this.toggleSubtask(thought.id, subId);
            const copyBtn = subtaskEl.querySelector('.subtask-copy-btn');
            if (copyBtn) {
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const text = subtaskEl.querySelector('.subtask-text').textContent;
                    this.copyTextWithFeedback(copyBtn, text);
                });
            }
        });

        card.querySelectorAll('.subtask-text').forEach((textSpan) => {
            textSpan.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.inlineEditSubtask(card, thought, textSpan);
            });
        });

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
                this.setThoughtCardExpanded(card, thought.id, true, { collapseOthers: true });
            };
        }
    }

    shouldIgnoreCardGesture(event, card) {
        return (
            this.hasActiveThoughtSelection() ||
            event.target.closest('.thought-dot') ||
            event.target.closest('.thought-copy-btn') ||
            event.target.closest('.thought-relations-btn') ||
            event.target.closest('.thought-ai-status') ||
            event.target.closest('.thought-ai-detail-panel') ||
            event.target.closest('.thought-ai-tag-suggestion') ||
            event.target.closest('.thought-tag-remove') ||
            event.target.closest('.thought-relations-panel') ||
            event.target.closest('.thought-tag') ||
            event.target.closest('.subtask') ||
            event.target.closest('.subtask-add-inline') ||
            event.target.closest('.subtasks-summary-row') ||
            event.target.closest('.subtask-editor-panel') ||
            event.target.closest('.edit-textarea') ||
            event.target.closest('.thought-link') ||
            card.classList.contains('editing')
        );
    }

    hasActiveThoughtSelection() {
        const selection = window.getSelection?.();
        return !!selection && !selection.isCollapsed && String(selection.toString() || '').trim().length > 0;
    }

    clearThoughtSelectionForSwipe() {
        const selection = window.getSelection?.();
        if (selection && !selection.isCollapsed) selection.removeAllRanges();
        this.hideThoughtSelectionToolbar();
    }

    bindThoughtSelectionFormatting(card, thought) {
        const selectableNodes = card.querySelectorAll('.thought-text, .subtask-text');
        selectableNodes.forEach((node) => {
            const captureSelection = (event) => {
                if (event.target.closest('.thought-inline-highlight, .thought-draw-line, .thought-note-line')) return;
                event.stopPropagation();
                setTimeout(() => this.captureThoughtSelection(card, thought, node), 0);
            };
            node.addEventListener('mouseup', captureSelection);
            node.addEventListener('touchend', captureSelection);
        });
    }

    captureThoughtSelection(card, thought, node) {
        const selection = window.getSelection?.();
        const selectedText = String(selection?.toString() || '').trim();
        if (!selection || selection.isCollapsed || !selectedText || !node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) {
            this.hideThoughtSelectionToolbar();
            return;
        }

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        this.activeThoughtSelection = {
            thoughtId: thought.id,
            selectedText,
            subId: node.closest('.subtask')?.dataset.subid || '',
            card
        };
        this.showThoughtSelectionToolbar(rect, { mode: 'format' });
    }

    showThoughtSelectionToolbar(rect, { mode = 'format' } = {}) {
        const toolbar = this.ensureThoughtSelectionToolbar();
        toolbar.dataset.mode = mode;
        toolbar.hidden = false;
        const toolbarWidth = toolbar.offsetWidth || 150;
        const left = Math.max(12, Math.min(window.innerWidth - toolbarWidth - 12, rect.left + rect.width / 2 - toolbarWidth / 2));
        const top = Math.max(12, rect.top + window.scrollY - 46);
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${top}px`;
    }

    ensureThoughtSelectionToolbar() {
        if (this.thoughtSelectionToolbar) return this.thoughtSelectionToolbar;
        const toolbar = document.createElement('div');
        toolbar.className = 'thought-selection-toolbar';
        toolbar.hidden = true;
        toolbar.innerHTML = `
            <button type="button" data-thought-style="highlight" title="高亮">H</button>
            <button type="button" data-thought-style="draw" title="画线">U</button>
            <button type="button" data-thought-style="clear" title="清除样式">×</button>
        `;
        toolbar.addEventListener('click', (event) => {
            const button = event.target.closest('[data-thought-style]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            this.applySelectedThoughtStyle(button.dataset.thoughtStyle);
        });
        document.body.appendChild(toolbar);
        document.addEventListener('selectionchange', () => {
            const selection = window.getSelection?.();
            if (toolbar.dataset.mode === 'clear' && this.activeThoughtSelection) return;
            if (!selection || selection.isCollapsed) this.hideThoughtSelectionToolbar();
        });
        document.addEventListener('click', (event) => {
            if (!toolbar.contains(event.target)) this.hideThoughtSelectionToolbar();
        });
        this.thoughtSelectionToolbar = toolbar;
        return toolbar;
    }

    hideThoughtSelectionToolbar() {
        if (this.thoughtSelectionToolbar) this.thoughtSelectionToolbar.hidden = true;
        this.activeThoughtSelection = null;
    }

    async applySelectedThoughtStyle(style) {
        const selection = this.activeThoughtSelection;
        if (!selection) return;
        const thought = this.thoughts.find(item => item.id === selection.thoughtId);
        if (!thought) return;

        window.getSelection?.().removeAllRanges();
        this.hideThoughtSelectionToolbar();

        if (selection.subId) {
            await this.applySelectedSubtaskStyle(thought, selection.subId, selection.selectedText, style);
            return;
        }

        const nextText = applyThoughtTextStyle(thought.text, selection.selectedText, style);
        if (nextText === thought.text) return;
        thought.text = nextText;
        thought.updatedAt = Date.now();
        this.render();
        this.apiClient.overwrite(thought.id, thought)
            .catch(err => {
                console.error('Failed to style thought text:', err);
                this.enqueueThoughtOverwrite(thought);
                this.render();
            });
    }

    async applySelectedSubtaskStyle(thought, subId, selectedText, style) {
        if (subId.startsWith('legacy_') && !(thought.subItems || []).length) {
            const nextText = applyThoughtTextStyle(thought.text, selectedText, style);
            if (nextText === thought.text) return;
            thought.text = nextText;
            this.render();
            this.apiClient.overwrite(thought.id, thought)
                .catch(err => {
                    console.error('Failed to style legacy subtask text:', err);
                    this.enqueueThoughtOverwrite(thought);
                    this.render();
                });
            return;
        }

        const subItem = (thought.subItems || []).find(item => item.id === subId);
        if (!subItem) return;
        const nextText = applyThoughtTextStyle(subItem.text, selectedText, style);
        if (nextText === subItem.text) return;
        subItem.text = nextText;
        this.focusExpandedThought(thought.id);
        this.render();
        try {
            await this.apiClient.updateSubitem(thought.id, subId, nextText);
        } catch (err) {
            console.error('Failed to style subtask text:', err);
            this.enqueueThoughtOverwrite(thought);
            this.render();
        }
    }

    bindThoughtInlineStyleClearing(card, thought) {
        card.querySelectorAll('.thought-inline-highlight, .thought-draw-line, .thought-note-line').forEach((styledNode) => {
            styledNode.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const selectedText = String(styledNode.textContent || '').trim();
                if (!selectedText) return;
                this.activeThoughtSelection = {
                    thoughtId: thought.id,
                    selectedText,
                    subId: styledNode.closest('.subtask')?.dataset.subid || '',
                    card
                };
                this.showThoughtSelectionToolbar(styledNode.getBoundingClientRect(), { mode: 'clear' });
            });
        });
    }

    bindThoughtSwipeDelete(card, thought) {
        let startX = 0;
        let startY = 0;
        let deltaX = 0;
        let isDragging = false;
        let tracking = false;
        let threshold = 0;
        let maxSwipe = 0;
        let capturedPointerId = null;
        let suppressNextClick = false;

        const captureSwipePointer = (event) => {
            capturedPointerId = event.pointerId;
            try {
                card.setPointerCapture?.(event.pointerId);
            } catch {
                capturedPointerId = null;
            }
        };

        const releaseSwipePointer = (event) => {
            const pointerId = event?.pointerId ?? capturedPointerId;
            if (pointerId === null || pointerId === undefined) return;
            try {
                if (!card.hasPointerCapture || card.hasPointerCapture(pointerId)) {
                    card.releasePointerCapture?.(pointerId);
                }
            } catch {
                // Pointer capture can already be gone after browser cancellation.
            }
            if (pointerId === capturedPointerId) capturedPointerId = null;
        };

        const resetSwipe = (event) => {
            releaseSwipePointer(event);
            card.classList.remove('swiping', 'swipe-ready');
            card.style.removeProperty('--swipe-x');
            card.style.removeProperty('--swipe-icon-opacity');
            card.style.removeProperty('--swipe-rail-opacity');
            tracking = false;
            isDragging = false;
            deltaX = 0;
        };

        card.addEventListener('pointerdown', (event) => {
            if (card.classList.contains('editing') || event.target.closest('button, input, textarea, a, .thought-selection-toolbar')) return;
            if (this.hasActiveThoughtSelection()) this.clearThoughtSelectionForSwipe();
            if (event.pointerType === 'mouse' && event.target.closest('.thought-text, .subtask-text')) return;
            startX = event.clientX;
            startY = event.clientY;
            deltaX = 0;
            threshold = card.offsetWidth * 0.5;
            maxSwipe = Math.max(threshold + 28, card.offsetWidth * 0.58);
            tracking = true;
            captureSwipePointer(event);
        });

        card.addEventListener('pointermove', (event) => {
            if (!tracking) return;
            deltaX = event.clientX - startX;
            const deltaY = Math.abs(event.clientY - startY);
            if (!isDragging && deltaX > 14 && deltaX > deltaY * 1.4) {
                isDragging = true;
                card.classList.add('swiping');
            }
            if (!isDragging) return;
            event.preventDefault();
            const swipeX = Math.min(maxSwipe, Math.max(0, deltaX));
            const railOpacity = Math.min(1, Math.max(0, (swipeX - 34) / 54));
            const iconOpacity = Math.min(0.95, Math.max(0, (swipeX - 56) / 50));
            card.style.setProperty('--swipe-x', `${swipeX}px`);
            card.style.setProperty('--swipe-rail-opacity', String(railOpacity));
            card.style.setProperty('--swipe-icon-opacity', String(iconOpacity));
            card.classList.toggle('swipe-ready', swipeX >= threshold);
        });

        const finishSwipe = async (event) => {
            if (!tracking) return;
            const shouldDelete = isDragging && deltaX >= threshold;
            if (isDragging) suppressNextClick = true;
            releaseSwipePointer(event);
            if (!shouldDelete) {
                resetSwipe();
                return;
            }

            card.classList.add('swipe-ready');
            card.style.setProperty('--swipe-x', `${threshold}px`);
            card.style.setProperty('--swipe-rail-opacity', '1');
            card.style.setProperty('--swipe-icon-opacity', '0.95');
            const confirmed = await this.app.confirmationManager.show('确认移入垃圾桶吗？');
            if (!confirmed) {
                resetSwipe();
                return;
            }

            card.classList.add('swipe-deleting');
            await new Promise(resolve => setTimeout(resolve, 220));
            await this.confirmAndDeleteThought(thought.id, { skipConfirm: true });
        };

        card.addEventListener('click', (event) => {
            if (!suppressNextClick) return;
            suppressNextClick = false;
            event.preventDefault();
            event.stopPropagation();
        }, true);
        card.addEventListener('pointerup', finishSwipe);
        card.addEventListener('pointercancel', resetSwipe);
        card.addEventListener('pointerleave', (event) => {
            const isCaptured = capturedPointerId !== null && card.hasPointerCapture?.(capturedPointerId);
            if (tracking && !isDragging && !isCaptured) resetSwipe(event);
        });
    }

    scrollFirstSearchHighlight(card) {
        const query = String(this.searchInput?.value || '').trim();
        if (!query || !card) return false;
        const target = card.querySelector('.thought-highlight');
        if (!target) return false;

        this.setThoughtCardExpanded(card, card.dataset.id, true, { collapseOthers: true });
        setTimeout(() => {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.remove('is-jump-target');
            void target.offsetWidth;
            target.classList.add('is-jump-target');
            setTimeout(() => target.classList.remove('is-jump-target'), 1800);
        }, 30);
        return true;
    }

    copyTextWithFeedback(button, text) {
        navigator.clipboard.writeText(text).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        });
        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 1200);
        this.app.toaster?.show('已复制', 'success', false, 1500);
    }

    renderAISuggestedTags(thought, userTags = []) {
        return renderAISuggestedTagsHtml({
            thought,
            userTags,
            escapeHtml: value => this.escapeHtml(value)
        });
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
        return this.tagRegistry.isTagUsed(this.thoughts, rawTag);
    }

    normalizeAIStatus(status = '') {
        return normalizeAIStatus(status);
    }

    renderAIStatus(thought, status, relationCount = 0) {
        return renderAIStatusButton({
            thoughtId: thought.id,
            status,
            relationCount,
            errorMessage: thought.aiError?.message || '',
            escapeHtml: value => this.escapeHtml(value)
        });
    }

    async toggleAIStatusPanel(card, thought) {
        const existing = card.querySelector('.thought-ai-detail-panel');

        if (existing) {
            this.closeAIStatusPanel(card, thought);
            return;
        }

        this.openAIStatusPanel(card, thought);
    }

    closeAIStatusPanel(card, thought) {
        const existing = card?.querySelector('.thought-ai-detail-panel');
        const button = card?.querySelector('.thought-ai-status');
        existing?.remove();
        card?.classList.remove('ai-detail-open');
        button?.setAttribute('aria-expanded', 'false');
        if (thought?.id) this.openAIStatusPanelIds.delete(thought.id);
    }

    async openAIStatusPanel(card, thought) {
        if (!card || !thought?.id || card.querySelector('.thought-ai-detail-panel')) return;
        const button = card.querySelector('.thought-ai-status');
        const panel = document.createElement('div');
        panel.className = 'thought-ai-detail-panel';
        panel.innerHTML = renderAIStatusLoading();
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
            const retry = e.target.closest('.thought-ai-detail-retry');
            if (retry) this.retryAIProcessing(thought.id);
        });

        card.appendChild(panel);
        card.classList.add('ai-detail-open');
        button?.setAttribute('aria-expanded', 'true');
        this.openAIStatusPanelIds.add(thought.id);

        try {
            const detail = await this.apiClient.getAIStatus(thought.id);
            if (!panel.isConnected) return;
            panel.innerHTML = this.renderAIStatusDetail(detail);
        } catch (err) {
            console.error('Failed to fetch thought AI status:', err);
            if (!panel.isConnected) return;
            panel.innerHTML = renderAIStatusError();
        }
    }

    renderAIStatusDetail(detail = {}) {
        return renderAIStatusDetailHtml({
            detail,
            escapeHtml: value => this.escapeHtml(value)
        });
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

        if (existing) {
            this.closeRelationsPanel(card, thought);
            return;
        }

        this.openRelationsPanel(card, thought);
    }

    closeRelationsPanel(card, thought) {
        const existing = card?.querySelector('.thought-relations-panel');
        const button = card?.querySelector('.thought-relations-btn');
        existing?.remove();
        button?.classList.remove('active');
        button?.setAttribute('aria-expanded', 'false');
        if (thought?.id) this.openRelationsPanelIds.delete(thought.id);
    }

    async openRelationsPanel(card, thought) {
        if (!card || !thought?.id || card.querySelector('.thought-relations-panel')) return;
        const button = card.querySelector('.thought-relations-btn');
        const panel = document.createElement('div');
        panel.className = 'thought-relations-panel';
        panel.innerHTML = '<div class="thought-relations-state">正在加载关联...</div>';
        this.bindRelationsPanelEvents(panel, card, thought);
        card.appendChild(panel);
        button?.classList.add('active');
        button?.setAttribute('aria-expanded', 'true');
        this.openRelationsPanelIds.add(thought.id);

        try {
            await this.refreshRelationsPanel(panel, thought);
        } catch (err) {
            console.warn('Failed to fetch thought relations:', err);
            if (!panel.isConnected) return;
            panel.innerHTML = '<div class="thought-relations-state error">关联加载失败</div>';
        }
    }

    bindRelationsPanelEvents(panel, card, thought) {
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleRelationsPanelClick(e, panel, card, thought);
        });
        panel.addEventListener('input', (e) => {
            const input = e.target.closest('.thought-manual-relation-input');
            if (!input) return;
            this.queueManualRelationSearch(panel, thought.id, input.value);
        });
    }

    handleRelationsPanelClick(event, panel, card, thought) {
        const confirmSuggestion = event.target.closest('.thought-relation-suggestion-confirm');
        if (confirmSuggestion) {
            this.createManualRelation(card, thought, confirmSuggestion.dataset.relationConfirmTarget, 'suggested');
            return;
        }

        const ignoreSuggestion = event.target.closest('.thought-relation-suggestion-ignore');
        if (ignoreSuggestion) {
            this.ignoreSuggestedRelation(card, thought.id, ignoreSuggestion.dataset.relationIgnoreTarget);
            return;
        }

        const deleteButton = event.target.closest('.thought-relation-delete');
        if (deleteButton) {
            this.deleteRelation(card, thought.id, deleteButton.dataset.relationDelete);
            return;
        }

        const moreButton = event.target.closest('.thought-relations-more');
        if (moreButton) {
            this.revealCollapsedRelations(moreButton);
            return;
        }

        const item = event.target.closest('.thought-relation-item');
        if (item) {
            this.jumpToRelationTarget(item.dataset.relationTarget, Number(item.dataset.relationCreatedAt || 0));
            return;
        }

        const suggestionMain = event.target.closest('.thought-relation-suggestion-main');
        if (suggestionMain) {
            this.jumpToRelationTarget(suggestionMain.dataset.relationTarget, Number(suggestionMain.dataset.relationCreatedAt || 0));
            return;
        }

        const manualTarget = event.target.closest('.thought-manual-relation-option');
        if (manualTarget) {
            this.createManualRelation(card, thought, manualTarget.dataset.manualRelationTarget);
        }
    }

    revealCollapsedRelations(moreButton) {
        const section = moreButton.closest('.thought-relations-section');
        section?.querySelectorAll('.relation-collapsed').forEach((item) => {
            item.classList.remove('relation-collapsed');
            item.removeAttribute('hidden');
        });
        moreButton.remove();
    }

    async refreshRelationsPanel(panel, thought) {
        if (!panel || !thought?.id) return;
        let data;
        try {
            data = await this.apiClient.getRelations(thought.id);
        } catch (err) {
            if (err.status !== 404) throw err;
            if (!panel.isConnected) return;
            panel.innerHTML = '<div class="thought-relations-state">暂无关联想法</div>';
            return;
        }
        if (!panel.isConnected) return;
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
        if (!panel.isConnected || !resultsEl) return;
        const q = String(query || '').trim();
        if (!q) {
            resultsEl.innerHTML = '';
            return;
        }

        try {
            const thoughts = await this.apiClient.list({ query: q, limit: 8, light: true });
            if (searchSeq !== this.manualRelationSearchSeq) return;
            if (!panel.isConnected || !resultsEl.isConnected) return;
            const linkedIds = new Set(
                Array.from(panel.querySelectorAll('.thought-relation-item'))
                    .map(item => item.dataset.relationTarget)
            );
            resultsEl.innerHTML = renderManualRelationSearchOptions({
                thoughts,
                sourceId,
                linkedIds,
                query: q,
                escapeHtml: value => this.escapeHtml(value)
            });
        } catch (err) {
            if (searchSeq !== this.manualRelationSearchSeq) return;
            if (!panel.isConnected || !resultsEl.isConnected) return;
            console.warn('Failed to search manual relation targets:', err);
            resultsEl.innerHTML = '<div class="thought-manual-relation-empty">搜索失败</div>';
        }
    }

    async createManualRelation(card, thought, targetId, relationType = 'manual') {
        if (!targetId || !thought?.id) return;
        const panel = card.querySelector('.thought-relations-panel');
        try {
            const data = await this.apiClient.createRelation(thought.id, targetId, relationType);
            const nextCount = applyManualRelationCreated(thought, data.relationCount);
            this.updateThoughtToolCounts(card, thought, 'ready', nextCount);
            if (Number.isFinite(Number(data.targetRelationCount))) {
                this.updateThoughtRelationCount(targetId, data.targetRelationCount, 'ready');
            }

            const relationsData = await this.apiClient.getRelations(thought.id);
            if (panel?.isConnected) {
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
            applyManualRelationCreateFailure(thought);
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
                applyRelationDeleted(sourceThought, data?.relationCount);
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
                applyRelationDeleteFailure(sourceThought);
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
        this.tagsFilter.innerHTML = renderThoughtTagFilters({
            tags,
            activeTag: this.activeTag,
            escapeHtml: value => this.escapeHtml(value)
        });
    }

    getAllTags() {
        return this.tagRegistry.getAllTags(this.thoughts);
    }

    saveTag(value) {
        return this.tagRegistry.saveTag(value);
    }

    syncTagsFromThoughts(thoughts) {
        this.tagRegistry.syncFromThoughts(thoughts);
    }

    normalizeTag(value) {
        return this.tagRegistry.normalize(value);
    }

    enterEditMode(card, thought) {
        if (card.classList.contains('editing')) return;
        card.classList.add('editing');
        this.setThoughtCardExpanded(card, thought.id, true, { collapseOthers: true });

        const textEl = card.querySelector('.thought-text');

        const editable = getEditableThoughtParts(thought);
        let subtasks = editable.subtasks;
        const bodyText = editable.bodyText;

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
                row.innerHTML = renderSubtaskEditRow(st, value => this.escapeHtml(value));
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
            addRow.innerHTML = renderSubtaskAddRow();
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
        let saveStarted = false;
        const saveAndExit = () => {
            if (saveStarted) return;
            saveStarted = true;
            const newText = textarea.value.trim();
            const nextSubItems = cleanSubItems(subtasks);

            const hasTextChanged = newText !== thought.text;
            const hasSubsChanged = JSON.stringify(nextSubItems) !== JSON.stringify(thought.subItems || []);

            if (hasTextChanged || hasSubsChanged) {
                thought.text = newText;
                thought.subItems = nextSubItems;
                thought.updatedAt = Date.now();
                this.exitEditMode(card);
                this.render();
                this.apiClient.overwrite(thought.id, thought)
                    .then(data => {
                        if (data?.thought) Object.assign(thought, data.thought);
                    })
                    .catch(err => {
                        console.error('Failed to save thought:', err);
                        this.enqueueThoughtOverwrite(thought);
                        this.render();
                    });
                return;
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
        const { sublist, createdSublist } = this.ensureSubtaskList(card);
        const addBtn = sublist.querySelector('.subtask-add-inline');
        const footerAddBtn = card.querySelector('.subtask-add-footer');

        if (addBtn) addBtn.style.display = 'none';
        if (footerAddBtn) footerAddBtn.style.display = 'none';
        const row = this.insertSubtaskInlineAddRow(sublist, addBtn);
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
            appendLocalSubItem(thought, text);
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

    ensureSubtaskList(card) {
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
        return { sublist, createdSublist };
    }

    insertSubtaskInlineAddRow(sublist, addBtn) {
        const row = document.createElement('div');
        row.className = 'subtask';
        row.innerHTML = renderSubtaskInlineAddRow();
        if (addBtn) {
            sublist.insertBefore(row, addBtn);
        } else {
            sublist.appendChild(row);
        }
        return row;
    }

    inlineEditSubtask(card, thought, textSpan) {
        const subtaskEl = textSpan.closest('.subtask');
        const subId = subtaskEl.dataset.subid;
        const originalText = textSpan.textContent;

        const input = this.replaceSubtaskTextWithInlineInput(textSpan, originalText);

        const commit = async () => {
            await this.commitInlineSubtaskEdit({ input, textSpan, thought, subId, originalText });
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { input.replaceWith(textSpan); }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => { if (input.parentNode) commit(); }, 100);
        });
    }

    replaceSubtaskTextWithInlineInput(textSpan, originalText) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'subtask-inline-input';
        input.value = originalText;
        input.style.margin = '0';
        textSpan.replaceWith(input);
        input.focus();
        input.select();
        return input;
    }

    async commitInlineSubtaskEdit({ input, textSpan, thought, subId, originalText }) {
        const newText = input.value.trim();
        if (newText === originalText) {
            input.replaceWith(textSpan);
            return;
        }

        try {
            const edit = applyLocalSubItemTextEdit(thought, subId, newText);
            if (edit.action === 'delete') {
                this.render();
                await this.apiClient.deleteSubitem(thought.id, subId);
            } else {
                this.render();
                await this.apiClient.updateSubitem(thought.id, subId, edit.text);
            }
        } catch (err) {
            console.error('Failed to edit subtask:', err);
            this.enqueueThoughtOverwrite(thought);
            this.render();
        }
    }

    async toggleSubtask(id, subId) {
        const thought = this.thoughts.find(t => t.id === id);
        if (!thought) return;
        this.focusExpandedThought(id);

        // If legacy data (subtask parsed from text), migrate on toggle
        if (subId.startsWith('legacy_') && !(thought.subItems || []).length) {
            if (!migrateAndToggleLegacySubItem(thought, subId)) return;
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

        // Optimistic update
        if (!toggleLocalSubItemCompletion(thought, subId)) return;
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
        return formatThoughtText(text, value => this.escapeHtml(value));
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
        return escapeThoughtHtml(text);
    }

}
