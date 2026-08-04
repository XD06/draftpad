const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relativePath, names) {
    const filename = path.join(ROOT, relativePath);
    const source = fs.readFileSync(filename, 'utf8')
        .replace(/export class /g, 'class ')
        .replace(/export function /g, 'function ')
        .replace(/export \{[^}]+\};?\s*/g, '')
        + `\nmodule.exports = { ${names.join(', ')} };\n`;
    const context = {
        module: { exports: {} },
        exports: {},
        Date,
        Math,
        URLSearchParams,
        globalThis: { crypto: null }
    };
    vm.runInNewContext(source, context, { filename });
    return context.module.exports;
}

function run() {
    const { TodayDraftsStore, createTodayDraft, localDayKey } = loadModule(
        'public/managers/today-drafts/today-drafts-store.js',
        ['TodayDraftsStore', 'createTodayDraft', 'localDayKey']
    );
    const { formatTodayDraftTime, renderTodayDrafts, renderTodayDraftItem } = loadModule(
        'public/managers/today-drafts/today-drafts-renderer.js',
        ['formatTodayDraftTime', 'renderTodayDrafts', 'renderTodayDraftItem']
    );
    const { getTodayDraftSwipeState } = loadModule(
        'public/managers/today-drafts/today-drafts-swipe.js',
        ['getTodayDraftSwipeState']
    );
    const { ImportTargetRegistry } = loadModule(
        'public/managers/import-target-registry.js',
        ['ImportTargetRegistry']
    );
    const { readLastWorkspace, persistLastWorkspace, resolveWorkspace } = loadModule(
        'public/managers/workspace-router.js',
        ['readLastWorkspace', 'persistLastWorkspace', 'resolveWorkspace']
    );

    const storage = new Map();
    const localStorage = {
        getItem: key => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value)
    };
    const monday = new Date('2026-08-03T10:00:00');
    const store = new TodayDraftsStore({ storage: localStorage, now: () => monday });
    const draft = createTodayDraft('立即处理', 100);
    assert(draft.text === '立即处理' && draft.completed === false, 'new today drafts should be simple incomplete text rows');
    store.save({ day: localDayKey(monday), items: [draft] });
    assert(store.load().items.length === 1, 'today drafts should survive within the same day');

    const tomorrowStore = new TodayDraftsStore({ storage: localStorage, now: () => new Date('2026-08-04T09:00:00') });
    assert(tomorrowStore.load().items.length === 0, 'stale today drafts should be cleared on the next calendar day');

    const rendered = renderTodayDrafts([{ id: 'draft-1', text: '<unsafe>', completed: true }]);
    assert(rendered.includes('&lt;unsafe&gt;'), 'today draft rendering should escape user text');
    assert(rendered.includes('checked'), 'completed today drafts should render a checked control');
    assert(renderTodayDrafts([]) === '', 'an empty today draft page should leave the writing surface available instead of rendering an empty-state message');
    const morning = new Date(2026, 7, 3, 9, 5).getTime();
    assert(formatTodayDraftTime(morning) === '09:05', 'today draft timestamps should use a compact local HH:mm format');
    assert(renderTodayDraftItem({ id: 'draft-time', text: '有时间的草稿', createdAt: morning }).includes('<time'), 'each today draft should render its creation time');
    const leftSwipe = getTodayDraftSwipeState(-72, 64, 92);
    assert(leftSwipe.direction === 'thought' && leftSwipe.ready, 'left swipes should prepare a move into Thought');
    assert(leftSwipe.swipeX === -72, 'left swipes should keep their signed direction for the row transform');
    const rightSwipe = getTodayDraftSwipeState(72, 64, 92);
    assert(rightSwipe.direction === 'delete' && rightSwipe.ready, 'right swipes should prepare a local delete');
    assert(rightSwipe.swipeX === 72, 'right swipes should keep their signed direction for the row transform');
    const idleSwipe = getTodayDraftSwipeState(0, 64, 92);
    assert(idleSwipe.direction === null && !idleSwipe.ready && idleSwipe.actionOpacity === 0, 'an untouched row must not expose either swipe action');

    const registry = new ImportTargetRegistry();
    const received = [];
    registry.register({ id: 'today', importText: text => received.push(text) });
    registry.importText('today', '来自剪贴板');
    assert(received[0] === '来自剪贴板', 'import targets should receive the edited clipboard text through a shared registry');
    assert.throws(() => registry.register({ id: 'invalid' }), /requires/, 'invalid import targets should fail fast');

    const workspaceStorage = new Map();
    const workspacePreferences = {
        getItem: key => workspaceStorage.get(key) || null,
        setItem: (key, value) => workspaceStorage.set(key, value)
    };
    assert(readLastWorkspace(workspacePreferences) === 'editor', 'a first visit should retain the editor as the workspace fallback');
    assert(persistLastWorkspace(workspacePreferences, 'today'), 'a valid workspace should be persisted');
    assert(resolveWorkspace({ storage: workspacePreferences }) === 'today', 'a return visit without a route should resume the last workspace');
    assert(resolveWorkspace({ hash: '#thoughts', storage: workspacePreferences }) === 'thoughts', 'an explicit workspace route must override the persisted workspace');
    assert(resolveWorkspace({ search: '?id=article-42', storage: workspacePreferences }) === 'editor', 'an explicit article URL must override the persisted workspace');
    assert(!persistLastWorkspace(workspacePreferences, 'unknown'), 'invalid workspace values must never be stored');

    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const indexSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const swSource = fs.readFileSync(path.join(ROOT, 'public', 'service-worker.js'), 'utf8');
    const todayStyles = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'today-drafts.css'), 'utf8');
    const todayManagerSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'today-drafts', 'today-drafts-manager.js'), 'utf8');
    const todayRendererSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'today-drafts', 'today-drafts-renderer.js'), 'utf8');
    assert(appSource.includes('new WorkspaceRouter'), 'top-level view routing should be centrally coordinated');
    const routerSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'workspace-router.js'), 'utf8');
    assert(routerSource.includes("editorView.style.display = isEditor ? 'flex' : 'none'"), 'returning to the editor must restore the existing three-column flex layout');
    assert(routerSource.includes("todayView.style.display = isToday ? '' : 'none'"), 'today drafts should let responsive CSS choose the mobile and desktop layout mode');
    assert(routerSource.includes("this.todayToggle?.addEventListener('click'"), 'the today drafts entry must work before its lazy manager has loaded');
    assert(!todayManagerSource.includes("this.toggleButton?.addEventListener('click'"), 'the today drafts manager must not own the global workspace entry listener');
    assert(appSource.includes('new ImportTargetRegistry'), 'clipboard destinations should use a registry');
    assert(indexSource.includes('id="today-drafts-view"'), 'the isolated today drafts view should be present in the app shell');
    assert(indexSource.includes('class="today-drafts-writing-area"'), 'today drafts should use a dedicated continuous writing surface');
    assert(!indexSource.includes('today-drafts-add'), 'today drafts should submit through Enter without a separate add button');
    assert(!indexSource.includes('today-drafts-clear-completed'), 'today drafts should not retain a global clear-completed action once rows support swipe actions');
    assert(indexSource.includes('id="clipboard-import-dialog"'), 'the clipboard import dialog should be present in the app shell');
    assert(indexSource.includes('<div class="clipboard-import-header">'), 'the clipboard dialog heading must be isolated from global app-header styles');
    assert(swSource.includes('/managers/today-drafts/today-drafts-manager.js'), 'the PWA should cache the today drafts manager');
    assert(swSource.includes('/managers/today-drafts/today-drafts-api-client.js'), 'the PWA should cache the today draft API client');
    assert(swSource.includes('/managers/today-drafts/today-drafts-outbox.js'), 'the PWA should cache the today draft sync outbox');
    assert(swSource.includes('/managers/today-drafts/today-drafts-swipe.js'), 'the PWA should cache the today draft swipe helper');
    assert(swSource.includes('/managers/clipboard-import-coordinator.js'), 'the PWA should cache the clipboard import coordinator');
    assert(todayStyles.includes('@media (min-width: 981px)'), 'desktop today drafts must define their own safe inset below the fixed app header');
    assert(todayStyles.includes('height: calc(100dvh - 24px);'), 'desktop today drafts should fill the available application height');
    assert(todayStyles.includes('width: min(100%, 820px);'), 'desktop today drafts should retain a readable notebook width');
    assert(todayStyles.includes('padding: 84px 0 0;'), 'desktop today drafts must clear the fixed app header');
    assert(todayStyles.includes('flex: 1 1 auto;'), 'desktop today draft paper should extend to the bottom of the workspace');
    assert(todayStyles.includes('padding: 26px 48px 28px;'), 'desktop today drafts should keep the footer close to the notebook edge');
    assert(todayStyles.includes('.today-drafts-writing-area'), 'the draft page should reserve a visible writing area when no items exist');
    assert(todayStyles.includes('repeating-linear-gradient'), 'the empty writing area should retain subtle ruled-paper lines');
    assert(todayManagerSource.includes("this.writingArea?.classList.toggle('is-empty', this.items.length === 0);"), 'the composer should move between the first and next available line as items change');
    assert(todayManagerSource.includes("if (!input.value.trim()) return;"), 'Enter on an empty draft line should not create accidental blank records');
    assert(!rendered.includes('data-today-draft-remove'), 'today drafts should not render a per-row delete action');
    assert(!todayRendererSource.includes('data-today-draft-remove'), 'single-draft deletion should remain outside the paper row renderer');
    assert(!todayManagerSource.includes('data-today-draft-remove'), 'the manager should not restore removed row-level delete controls');
    assert(todayManagerSource.includes('bindDraftSwipeActions'), 'today draft rows should bind their own directional swipe actions');
    assert(todayManagerSource.includes('this.onMoveToThought'), 'moving a draft into Thought should stay behind an application-level callback');
    assert(todayManagerSource.includes('this.movingDraftIds'), 'a draft being moved into Thought should not be transferred twice');
    assert(todayManagerSource.includes('mergeRemoteItems') && todayManagerSource.includes('retryOutbox'), 'today drafts should merge server state and retry local pending writes');
    assert(appSource.includes('createTodayDraftThought(draft.text)'), 'the application should transfer a left-swiped today draft into Thought');
    assert(todayStyles.includes('grid-template-columns: 36px minmax(0, 1fr) auto;'), 'today draft rows should end with a compact timestamp column');
    assert(todayStyles.includes('min-height: 44px;'), 'text rows should align with the notebook ruling');
    assert(todayStyles.includes('transparent 43px,'), 'the ruled-paper background must match the 44px draft row rhythm');
    assert(todayStyles.includes('var(--muted-text) 28%'), 'empty notebook lines should be distinct enough to guide writing');
    assert(todayStyles.includes('radial-gradient('), 'the writing surface should retain a subtle paper-grain texture');
    assert(todayStyles.includes('background-size: 100% 44px, 9px 9px, 13px 13px;'), 'paper grain should remain fine and independent from the writing-line rhythm');
    assert(todayStyles.includes('border-bottom: 1px solid color-mix(in srgb, var(--muted-text) 28%, transparent);'), 'the writing surface should close with a full rule before the footer');
    assert(!todayStyles.includes('border-bottom: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);'), 'the title area must not stack a second divider above the ruled paper');
    assert(!todayStyles.includes('background-color: color-mix(in srgb, var(--header-bg) 94%, var(--bg-color));'), 'the writing texture should not create a second surface edge beneath the title');
    assert(!todayStyles.includes('left: 36px;'), 'the writing surface must not cut through content with a full-height margin line');
    assert(!todayStyles.includes('box-shadow: inset 2px 0'), 'editing a row must not add a competing vertical focus stripe');
    assert(todayStyles.includes('border-radius: 2px;'), 'today draft completion controls should use a square checkbox');
    assert(todayStyles.includes('touch-action: pan-y;'), 'today draft rows should preserve vertical page scrolling while enabling horizontal swipes');
    assert(todayStyles.includes('.today-draft-swipe-action--thought'), 'today draft rows should expose a left-swipe Thought affordance');
    assert(todayStyles.includes('.today-draft-swipe-action--delete'), 'today draft rows should expose a right-swipe delete affordance');
    assert(todayStyles.includes('transform: translate(-50%, -65%) rotate(-45deg);'), 'the completion mark should be centered within the square rather than positioned with fixed offsets');
    assert(!todayStyles.includes('.today-draft-text:focus-visible,'), 'row editing should avoid a detached input outline');

    console.log('Today drafts workspace checks passed');
}

run();
