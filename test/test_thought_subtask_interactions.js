const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const thoughtsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-card-renderer.js'), 'utf8');
const swipeHelperSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-swipe.js'), 'utf8');
const thoughtsCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'thoughts.css'), 'utf8');

function run() {
    // Collapsed cards hide everything past the second subtask, so adding a
    // subtask must expand the card first or the committed row and the
    // chained Enter input land out of sight.
    assert(
        thoughtsSource.includes('async quickAddSubtask(card, thought) {') &&
            /quickAddSubtask\(card, thought\) \{[\s\S]{0,400}?can-expand[\s\S]{0,300}?setThoughtCardExpanded\(card, thought\.id, true, \{ collapseOthers: true \}\)/.test(thoughtsSource),
        'quick add should expand a collapsed card before inserting the inline input'
    );
    // Enter chains on the SAME input: commit must clear the value and keep
    // the field focused instead of rebuilding the card (a full render here
    // dropped focus and collapsed the mobile keyboard after every Enter).
    // The committed row appears as a non-interactive preview until the
    // blur-scheduled render replaces it with a fully bound row.
    const quickAddBody = thoughtsSource.slice(
        thoughtsSource.indexOf('async quickAddSubtask(card, thought) {'),
        thoughtsSource.indexOf('ensureSubtaskList(card) {')
    );
    assert(
        quickAddBody.includes('input.value = \'\';') &&
            quickAddBody.includes('insertPreviewRow(subItem);') &&
            !quickAddBody.includes('this.render();\n            try {') &&
            quickAddBody.includes('this.reorderTimelineInPlace();'),
        'subtask commit must chain on the same focused input without a full card rebuild'
    );
    assert(
        quickAddBody.includes('if (e.isComposing) return;'),
        'the inline add input must not commit while an IME composition is active'
    );

    // Live WebSocket updates must not wait for the focus-hold flush: while a
    // timeline input is focused, updates to OTHER cards rebuild just that
    // card in place; same-card updates defer to the blur flush.
    const socketDeltaBody = thoughtsSource.slice(
        thoughtsSource.indexOf('renderSocketDelta(changedThoughtId) {'),
        thoughtsSource.indexOf('renderSocketDelta(changedThoughtId) {') + 1400
    );
    assert(
        socketDeltaBody.includes('this.patchRenderedThought(changedThoughtId || undefined);') &&
            socketDeltaBody.includes('card?.contains(active)'),
        'socket updates should rebuild only the affected card and defer same-card updates to blur'
    );
    assert(
        thoughtsSource.includes('this.renderSocketDelta(action === \'update\' ? payload?.id : null);'),
        'handleSocketUpdate must route rendering through renderSocketDelta'
    );

    // Toggling a subtask refreshes only the affected card in place; a full
    // timeline rebuild per checkbox tap was the source of the visible lag.
    const toggleBody = thoughtsSource.slice(
        thoughtsSource.indexOf('async toggleSubtask(id, subId) {'),
        thoughtsSource.indexOf('refreshThoughtSubtaskView(thought) {')
    );
    assert(
        toggleBody.includes('this.refreshThoughtSubtaskView(thought);') &&
            toggleBody.includes('this.reorderTimelineInPlace();'),
        'subtask toggle should use the in-place card refresh and in-place reorder'
    );
    const optimisticSlice = toggleBody.slice(
        toggleBody.indexOf('if (!toggleLocalSubItemCompletion(thought, subId)) return;'),
        toggleBody.indexOf('try {')
    );
    assert(
        !optimisticSlice.includes('this.render()'),
        'the optimistic toggle path must not rebuild the whole timeline'
    );

    // In-place reorder must fall back to the scheduled render whenever the
    // DOM does not hold the complete filtered set (lazy batches, empty
    // states, stale ids).
    const reorderBody = thoughtsSource.slice(
        thoughtsSource.indexOf('reorderTimelineInPlace() {'),
        thoughtsSource.indexOf('bindSubtaskSwipeDelete(row, thought) {')
    );
    assert(
        reorderBody.includes('this._renderedCount < this._lastFilteredIds.length') &&
            reorderBody.includes('this.scheduleRender();') &&
            reorderBody.includes("this.timeline.insertBefore(fragment, this.timeline.querySelector('.thoughts-load-more'))"),
        'in-place reorder must preserve lazy-batch fallback and keep the load-more control last'
    );

    // Row-level swipe-to-delete mirrors the card gesture; legacy ids are
    // re-parsed from text each render and stay on dblclick editing.
    assert(
        thoughtsSource.includes('bindSubtaskSwipeDelete(row, thought) {') &&
            thoughtsSource.includes("if (!row.dataset.subid.startsWith('legacy_'))") &&
            thoughtsSource.includes('async deleteSubtaskBySwipe(row, thought, subId) {'),
        'subtask rows should bind swipe-to-delete except for legacy parsed ids'
    );
    const deleteBody = thoughtsSource.slice(
        thoughtsSource.indexOf('async deleteSubtaskBySwipe(row, thought, subId) {'),
        thoughtsSource.indexOf('async deleteSubtaskBySwipe(row, thought, subId) {') + 1600
    );
    assert(
        deleteBody.includes("applyLocalSubItemTextEdit(thought, subId, '')") &&
            deleteBody.includes("this.apiClient.deleteSubitem(thought.id, subId, thought.version)") &&
            deleteBody.includes('swipe-deleting'),
        'swipe delete should reuse the local text-edit delete action and the subitem delete API'
    );
    assert(
        rendererSource.includes('subtask-swipe-action'),
        'rendered subtask rows should carry the swipe action affordance'
    );
    assert(
        thoughtsCss.includes('.subtask.swiping') &&
            thoughtsCss.includes('.subtask-swipe-action') &&
            thoughtsCss.includes('.subtask.swipe-deleting'),
        'row swipe styling should cover dragging, the delete affordance and the exit animation'
    );
    // Row swipe must use its own custom-property names: card swipes set
    // --swipe-x/--swipe-action-opacity on the card and those inherit into
    // every row, which would light up all row trash icons mid-card-swipe.
    assert(
        !/\.subtask-swipe-action\s*{[^}]*--swipe-x/.test(thoughtsCss) &&
            !/\.subtask-swipe-action\s*{[^}]*--swipe-action-opacity/.test(thoughtsCss) &&
            thoughtsCss.includes('var(--subtask-swipe-x') &&
            thoughtsCss.includes('var(--subtask-swipe-opacity'),
        'row swipe styles must read only --subtask-swipe-* vars, never the inherited card vars'
    );
    assert(
        thoughtsSource.includes("setProperty('--subtask-swipe-x'") &&
            thoughtsSource.includes("setProperty('--subtask-swipe-opacity'") &&
            thoughtsSource.includes("removeProperty('--subtask-swipe-x'"),
        'row swipe JS should write and clear only the row-scoped custom properties'
    );

    // The row gesture reuses the shared swipe state helper.
    assert(
        swipeHelperSource.includes('export function getThoughtSwipeState') &&
            thoughtsSource.includes("import { getThoughtSwipeState } from './thought-swipe.js';"),
        'row swipe should share the card swipe state helper'
    );

    console.log('Thought subtask interaction checks passed');
}

run();
