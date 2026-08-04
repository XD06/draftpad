import { createTodayDraft, localDayKey, TodayDraftsStore } from './today-drafts-store.js';
import { renderTodayDrafts } from './today-drafts-renderer.js';
import { getTodayDraftSwipeState } from './today-drafts-swipe.js';
import TodayDraftsApiClient from './today-drafts-api-client.js';
import TodayDraftsOutbox from './today-drafts-outbox.js';

export class TodayDraftsManager {
    constructor({
        store = new TodayDraftsStore(),
        apiClient = new TodayDraftsApiClient(),
        outbox = new TodayDraftsOutbox(),
        onMoveToThought = async () => false
    } = {}) {
        this.store = store;
        this.apiClient = apiClient;
        this.outbox = outbox;
        this.onMoveToThought = onMoveToThought;
        this.view = document.getElementById('today-drafts-view');
        this.writingArea = document.getElementById('today-drafts-writing-area');
        this.list = document.getElementById('today-drafts-list');
        this.input = document.getElementById('today-drafts-input');
        this.form = document.getElementById('today-drafts-form');
        this.toggleButton = document.getElementById('toggle-today-drafts');
        this.items = this.store.load().items;
        this.movingDraftIds = new Set();
        this.isActive = false;
        this.dayTimer = null;
        this.syncTimer = null;
        this.syncInFlight = false;
        this.isComposingDraft = false;
        this.pendingRender = false;
        this.bindEvents();
        window.addEventListener('today_drafts_update', event => this.handleSocketUpdate(event.detail || {}));
        window.addEventListener('ws_connected', () => this.retryOutbox());
        this.render();
    }

    bindEvents() {
        this.form?.addEventListener('submit', event => {
            event.preventDefault();
            this.add(this.input?.value || '');
        });
        this.list?.addEventListener('change', event => {
            const row = event.target.closest('[data-today-draft-id]');
            if (!row || !event.target.matches('[data-today-draft-complete]')) return;
            this.update(row.dataset.todayDraftId, { completed: event.target.checked });
        });
        this.list?.addEventListener('input', event => {
            const row = event.target.closest('[data-today-draft-id]');
            if (!row || !event.target.matches('[data-today-draft-text]')) return;
            this.update(row.dataset.todayDraftId, { text: event.target.value }, { render: false });
            row.classList.toggle('is-empty', !event.target.value.trim());
        });
        this.list?.addEventListener('compositionstart', event => {
            if (event.target.matches('[data-today-draft-text]')) this.isComposingDraft = true;
        });
        this.list?.addEventListener('compositionend', event => {
            if (!event.target.matches('[data-today-draft-text]')) return;
            this.isComposingDraft = false;
            if (this.pendingRender) this.render();
        });
        this.list?.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            const input = event.target.closest('[data-today-draft-text]');
            if (!input) return;
            event.preventDefault();
            if (!input.value.trim()) return;
            this.addAfter(input.closest('[data-today-draft-id]')?.dataset.todayDraftId);
        });
        this.list?.addEventListener('focusout', event => {
            const input = event.target.closest('[data-today-draft-text]');
            if (!input || input.value.trim()) return;
            const row = input.closest('[data-today-draft-id]');
            if (row) this.remove(row.dataset.todayDraftId);
        });
        this.bindDraftSwipeActions();
    }

    bindDraftSwipeActions() {
        let interaction = null;
        let suppressNextClick = false;

        const releasePointer = (event, row = interaction?.row) => {
            const pointerId = event?.pointerId ?? interaction?.pointerId;
            if (!row || pointerId === undefined) return;
            try {
                if (!row.hasPointerCapture || row.hasPointerCapture(pointerId)) {
                    row.releasePointerCapture?.(pointerId);
                }
            } catch {
                // A cancelled touch can release capture before its cleanup event.
            }
        };

        const resetSwipe = event => {
            const row = interaction?.row;
            releasePointer(event, row);
            row?.classList.remove('is-swiping', 'is-swipe-ready', 'is-swipe-thought', 'is-swipe-delete');
            row?.style.removeProperty('--today-draft-swipe-x');
            row?.style.removeProperty('--today-draft-swipe-opacity');
            interaction = null;
        };

        this.list?.addEventListener('pointerdown', event => {
            if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || interaction) return;
            const row = event.target.closest('[data-today-draft-id]');
            if (!row || event.target.closest('[data-today-draft-complete], .today-draft-check')) return;
            const textInput = event.target.closest('[data-today-draft-text]');
            if (textInput && event.pointerType === 'mouse') return;

            interaction = {
                row,
                id: row.dataset.todayDraftId,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                deltaX: 0,
                isDragging: false,
                threshold: Math.max(64, row.offsetWidth * 0.28),
                maxSwipe: Math.max(92, row.offsetWidth * 0.38)
            };
            try {
                row.setPointerCapture?.(event.pointerId);
            } catch {
                // Pointer capture is an enhancement; touch-action still protects vertical scrolling.
            }
        });

        this.list?.addEventListener('pointermove', event => {
            if (!interaction || event.pointerId !== interaction.pointerId) return;
            const { row, startX, startY } = interaction;
            interaction.deltaX = event.clientX - startX;
            const deltaY = Math.abs(event.clientY - startY);
            if (!interaction.isDragging && Math.abs(interaction.deltaX) > 14 && Math.abs(interaction.deltaX) > deltaY * 1.3) {
                interaction.isDragging = true;
                if (document.activeElement?.matches?.('[data-today-draft-text]')) document.activeElement.blur();
                row.classList.add('is-swiping');
            }
            if (!interaction.isDragging) return;

            event.preventDefault();
            const state = getTodayDraftSwipeState(interaction.deltaX, interaction.threshold, interaction.maxSwipe);
            row.style.setProperty('--today-draft-swipe-x', `${state.swipeX}px`);
            row.style.setProperty('--today-draft-swipe-opacity', String(state.actionOpacity));
            row.classList.toggle('is-swipe-ready', state.ready);
            row.classList.toggle('is-swipe-thought', state.direction === 'thought');
            row.classList.toggle('is-swipe-delete', state.direction === 'delete');
        });

        const finishSwipe = async event => {
            if (!interaction || event.pointerId !== interaction.pointerId) return;
            const current = interaction;
            const state = getTodayDraftSwipeState(current.deltaX, current.threshold, current.maxSwipe);
            const action = current.isDragging && state.ready ? state.direction : null;
            if (current.isDragging) {
                suppressNextClick = true;
                setTimeout(() => {
                    suppressNextClick = false;
                }, 0);
            }
            releasePointer(event, current.row);

            if (!action) {
                resetSwipe();
                return;
            }

            interaction = null;
            current.row.classList.remove('is-swiping');
            current.row.classList.add('is-swipe-ready', action === 'thought' ? 'is-swipe-thought' : 'is-swipe-delete');
            if (action === 'delete') {
                current.row.classList.add('is-swipe-departing');
                await new Promise(resolve => setTimeout(resolve, 160));
                this.remove(current.id);
                return;
            }

            const item = this.items.find(candidate => candidate.id === current.id);
            if (!item || this.movingDraftIds.has(current.id)) return;
            this.movingDraftIds.add(current.id);
            try {
                const moved = await this.onMoveToThought({ ...item });
                if (moved) {
                    this.remove(current.id);
                    return;
                }
            } catch (error) {
                console.warn('Failed to move today draft into Thought:', error);
            } finally {
                this.movingDraftIds.delete(current.id);
            }
            current.row.classList.remove('is-swipe-ready', 'is-swipe-thought');
            current.row.style.removeProperty('--today-draft-swipe-x');
            current.row.style.removeProperty('--today-draft-swipe-opacity');
        };

        this.list?.addEventListener('pointerup', finishSwipe);
        this.list?.addEventListener('pointercancel', resetSwipe);
        this.list?.addEventListener('click', event => {
            if (!suppressNextClick) return;
            suppressNextClick = false;
            event.preventDefault();
            event.stopPropagation();
        }, true);
    }

    activate() {
        this.isActive = true;
        void this.refreshForCurrentDay();
        this.toggleButton?.classList.add('active');
        this.scheduleDayBoundary();
    }

    deactivate() {
        this.isActive = false;
        this.toggleButton?.classList.remove('active');
        clearTimeout(this.dayTimer);
        this.dayTimer = null;
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
    }

    async refreshForCurrentDay() {
        const state = this.store.load();
        this.items = state.items;
        this.render();
        try {
            const remote = await this.apiClient.list();
            this.mergeRemoteItems(remote?.items);
            await this.retryOutbox();
        } catch (error) {
            console.info('Today drafts are currently using local storage:', error?.message || error);
        }
    }

    scheduleDayBoundary() {
        clearTimeout(this.dayTimer);
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setHours(24, 0, 2, 0);
        this.dayTimer = setTimeout(() => {
            const stale = [...this.items];
            this.items = [];
            stale.forEach(item => this.outbox.enqueueDelete(item));
            this.persist();
            this.render();
            this.scheduleSync(0);
            if (this.isActive) this.scheduleDayBoundary();
        }, Math.max(1000, nextDay.getTime() - now.getTime()));
    }

    add(text, { focus = false, afterId = null } = {}) {
        const draft = createTodayDraft(text);
        if (!draft.text && !focus) return null;
        if (afterId) {
            const index = this.items.findIndex(item => item.id === afterId);
            this.items.splice(index < 0 ? this.items.length : index + 1, 0, draft);
        } else {
            this.items.push(draft);
        }
        this.persist();
        this.render();
        this.queueUpsert(draft, 0);
        if (this.input) this.input.value = '';
        if (focus) {
            requestAnimationFrame(() => this.list?.querySelector(`[data-today-draft-id="${draft.id}"] [data-today-draft-text]`)?.focus());
        } else {
            this.input?.focus();
        }
        return draft;
    }

    addAfter(id) {
        return this.add('', { focus: true, afterId: id });
    }

    addImportedText(text) {
        return this.add(text);
    }

    update(id, patch, { render = true } = {}) {
        const item = this.items.find(candidate => candidate.id === id);
        if (!item) return;
        item.text = patch.text === undefined ? item.text : String(patch.text);
        item.completed = patch.completed === undefined ? item.completed : Boolean(patch.completed);
        item.updatedAt = Date.now();
        this.persist();
        this.queueUpsert(item, render ? 0 : 450);
        if (render) this.render();
    }

    remove(id) {
        const removed = this.items.find(item => item.id === id);
        this.items = this.items.filter(item => item.id !== id);
        this.persist();
        this.render();
        if (removed) {
            this.outbox.enqueueDelete(removed);
            this.scheduleSync(0);
        }
    }

    persist() {
        this.store.save({ day: localDayKey(), items: this.items });
    }

    queueUpsert(draft, delay) {
        this.outbox.enqueueUpsert(draft);
        this.scheduleSync(delay);
    }

    scheduleSync(delay = 350) {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.retryOutbox(), delay);
    }

    mergeRemoteItems(remoteItems) {
        const localById = new Map(this.items.map(item => [item.id, item]));
        const remoteById = new Map((Array.isArray(remoteItems) ? remoteItems : []).map(item => [item.id, item]));
        const merged = [];

        for (const remote of remoteById.values()) {
            const local = localById.get(remote.id);
            if (this.outbox.hasPending(remote.id) && local) {
                local.version = remote.version;
                local.day = remote.day;
                merged.push(local);
            } else {
                merged.push(remote);
            }
            localById.delete(remote.id);
        }

        for (const local of localById.values()) {
            merged.push(local);
            this.outbox.enqueueUpsert(local);
        }

        this.items = merged.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        this.persist();
        this.render();
    }

    async retryOutbox() {
        if (this.syncInFlight || this.outbox.load().length === 0) return;
        this.syncInFlight = true;
        try {
            const result = await this.outbox.retry(this.apiClient);
            for (const saved of result.saved) {
                if (saved.item.kind === 'delete') continue;
                const remote = saved.result?.draft;
                const index = this.items.findIndex(item => item.id === saved.item.draftId);
                if (!remote || index < 0) continue;
                if (Number(this.items[index].updatedAt) <= Number(saved.item.draft.updatedAt)) {
                    this.items[index] = remote;
                } else {
                    this.items[index].version = remote.version;
                    this.items[index].day = remote.day;
                }
            }
            this.persist();
            this.render();
        } catch (error) {
            console.info('Today drafts sync will retry later:', error?.message || error);
        } finally {
            this.syncInFlight = false;
        }
    }

    handleSocketUpdate({ action, payload } = {}) {
        const draft = payload && typeof payload === 'object' ? payload : null;
        if (!draft?.id || this.outbox.hasPending(draft.id)) return;
        if (action === 'delete') {
            this.items = this.items.filter(item => item.id !== draft.id);
        } else if (draft.day === localDayKey()) {
            const index = this.items.findIndex(item => item.id === draft.id);
            if (index >= 0) this.items[index] = draft;
            else this.items.push(draft);
            this.items.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        }
        this.persist();
        this.render();
    }

    captureActiveDraftInput() {
        const input = document.activeElement?.matches?.('[data-today-draft-text]')
            ? document.activeElement
            : null;
        const row = input?.closest('[data-today-draft-id]');
        if (!input || !row || !this.list?.contains(input)) return null;
        return {
            id: row.dataset.todayDraftId,
            value: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            selectionDirection: input.selectionDirection
        };
    }

    restoreActiveDraftInput(state) {
        if (!state || !this.list) return;
        const row = [...this.list.querySelectorAll('[data-today-draft-id]')]
            .find(candidate => candidate.dataset.todayDraftId === state.id);
        const input = row?.querySelector('[data-today-draft-text]');
        if (!input) return;
        input.value = state.value;
        try {
            input.focus({ preventScroll: true });
        } catch {
            input.focus();
        }
        if (typeof state.selectionStart !== 'number' || typeof state.selectionEnd !== 'number') return;
        const start = Math.min(state.selectionStart, input.value.length);
        const end = Math.min(state.selectionEnd, input.value.length);
        try {
            input.setSelectionRange(start, end, state.selectionDirection || 'none');
        } catch {
            // Some browser input implementations do not accept a selection direction.
        }
    }

    render() {
        if (this.isComposingDraft) {
            this.pendingRender = true;
            return;
        }
        const activeInput = this.captureActiveDraftInput();
        if (this.list) this.list.innerHTML = renderTodayDrafts(this.items);
        this.restoreActiveDraftInput(activeInput);
        this.pendingRender = false;
        this.writingArea?.classList.toggle('is-empty', this.items.length === 0);
        const count = document.getElementById('today-drafts-count');
        const completed = this.items.filter(item => item.completed).length;
        if (count) count.textContent = this.items.length ? `${completed}/${this.items.length} 已完成` : '用完即走';
    }
}
