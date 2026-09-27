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
    const { TodayDraftsStore, createTodayDraft, localDayKey, dayWindowKeys } = loadModule(
        'public/managers/today-drafts/today-drafts-store.js',
        ['TodayDraftsStore', 'createTodayDraft', 'localDayKey', 'dayWindowKeys']
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
    assert(tomorrowStore.load().items.length === 1, 'drafts should survive into the next day inside the 3-day window');

    const lastWeekStore = new TodayDraftsStore({ storage: localStorage, now: () => new Date('2026-08-10T09:00:00') });
    assert(lastWeekStore.load().items.length === 0, 'drafts older than the 3-day window should be dropped on load');

    assert(JSON.stringify(dayWindowKeys(monday)) === JSON.stringify(['2026-08-01', '2026-08-02', '2026-08-03']),
        'the retention window should list today plus the two previous days from oldest to newest');
    const stamped = createTodayDraft('带日期的草稿', monday.getTime());
    assert(stamped.day === '2026-08-03', 'a new draft should carry the local day it was created on');

    const rendered = renderTodayDrafts([{ id: 'draft-1', text: '<unsafe>', completed: true }]);
    assert(rendered.includes('&lt;unsafe&gt;'), 'today draft rendering should escape user text');
    assert(rendered.includes('checked'), 'completed today drafts should render a checked control');
    const linkedDraft = renderTodayDraftItem({ id: 'draft-link', text: '打开 https://example.com/path?q=1, 或 www.example.org' });
    assert(linkedDraft.includes('data-today-draft-text-display'), 'today drafts should render a non-editing display state');
    assert(linkedDraft.includes('class="today-draft-link"'), 'today drafts should identify links independently from editable text');
    assert(linkedDraft.includes('href="https://example.com/path?q=1"'), 'https links should preserve their destination');
    assert(linkedDraft.includes('href="https://www.example.org"'), 'www links should receive an https scheme');
    assert(linkedDraft.includes('target="_blank"') && linkedDraft.includes('rel="noopener noreferrer"'), 'today draft links should open safely in a new tab');
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
    const readonlyRendered = renderTodayDrafts([{ id: 'draft-old', text: '昨天的记录', day: '2026-08-02' }], { readonly: true });
    assert(readonlyRendered.includes('is-readonly'), 'historical-day rows should render read-only');
    assert(readonlyRendered.includes('加入今日') && readonlyRendered.includes('转为 Thought') && !readonlyRendered.includes('松开删除'),
        'historical-day rows offer copy-to-today and copy-to-thought swipes, never delete');
    assert(readonlyRendered.indexOf('转为 Thought') < readonlyRendered.indexOf('加入今日'),
        'historical rows put 转为 Thought on the left-swipe slot and 加入今日 on the right-swipe slot');
    assert(readonlyRendered.includes('disabled'), 'historical-day completion controls should not be togglable');
    assert(readonlyRendered.includes('data-today-draft-text-display') === false, 'historical-day text should not enter the editing affordance');

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
    const styles = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'styles.css'), 'utf8');
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
    assert(indexSource.includes('dumbpad_last_workspace_v1'), 'the document should resolve the last workspace before the app bundle starts');
    assert(indexSource.includes('id="thoughts-stylesheet"'), 'Thought styles should have a dedicated first-paint stylesheet handle');
    assert(indexSource.indexOf('dumbpad_last_workspace_v1') < indexSource.indexOf('id="thoughts-stylesheet"'), 'the first-paint workspace must resolve before Thought stylesheet priority is selected');
    assert(indexSource.includes("dataset.initialWorkspace === 'thoughts'"), 'Thought refreshes should promote their stylesheet before the view becomes visible');
    assert(indexSource.includes("dataset.thoughtsStylesReady='true'"), 'Thought stylesheet completion should explicitly release the protected view');
    assert(styles.includes('html[data-initial-workspace="today"] main.three-column-layout'), 'the first paint should hide the editor for the today workspace');
    assert(styles.includes('html[data-initial-workspace="thoughts"] #thoughts-view'), 'the first paint should show the thoughts workspace');
    assert(styles.includes('html:not([data-thoughts-styles-ready]) #thoughts-view'), 'unstyled Thought controls should stay hidden until their stylesheet is ready');
    assert(appSource.includes('router.applyShellState(initialWorkspace)'), 'the app should apply the workspace shell before remote data loads');
    assert(appSource.includes('registerServiceWorker().catch(() => {})'), 'service worker registration should not block workspace startup');
    assert(indexSource.includes('class="today-drafts-writing-area"'), 'today drafts should use a dedicated continuous writing surface');
    assert(indexSource.includes('<textarea id="today-drafts-input"'), 'the new-draft composer should be a wrapping textarea, not a single-line input');
    assert(todayManagerSource.includes("document.createElement('textarea')"), 'row editing should swap the display for a wrapping textarea');
    assert(todayManagerSource.includes('scrollHeight'), 'both composers should auto-grow with their content');
    assert(todayManagerSource.includes('event.isComposing'), 'IME confirm Enter must not submit or split drafts');
    assert(indexSource.includes('<p class="today-drafts-subtitle">保留最近 3 天，左右滑动翻页。</p>'), 'today drafts should explain the 3-day window and paging under the title');
    assert(indexSource.includes('id="today-drafts-pager"') && indexSource.includes('id="today-drafts-flip-static"') && indexSource.includes('id="today-drafts-flip-flap"'),
        'the flip pager should own the whole paper card plus the static and mirrored curl copies');
    const pagerIndex = indexSource.indexOf('id="today-drafts-pager"');
    const baseCardIndex = indexSource.indexOf('<div id="today-drafts-base" class="today-drafts-sheet today-drafts-page">');
    const headerIndex = indexSource.indexOf('class="today-drafts-header"');
    const writingIndex = indexSource.indexOf('id="today-drafts-writing-area"');
    assert(baseCardIndex > pagerIndex && headerIndex > baseCardIndex && writingIndex > headerIndex,
        'the flip pager must wrap the entire paper card so the title turns together with the page');
    assert(indexSource.includes('<h2>今日草稿<span class="today-drafts-eyebrow" id="today-drafts-eyebrow">'),
        'the current page date should sit as a subscript beside the title, not a tab bar or its own line');
    assert(todayManagerSource.includes("'2d ago', 'yest', 'today'"), 'day labels should use compact English abbreviations');
    assert(/\.today-drafts-eyebrow\s*\{[^}]*vertical-align:\s*-0\.22em/.test(todayStyles), 'the date subscript should hang at the title baseline');
    assert(!indexSource.includes('<footer class="today-drafts-footer">'), 'today drafts should not repeat the lifetime hint at the bottom of the page');
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
    assert(todayStyles.includes('padding: 65px 0 0;'), 'desktop today drafts must clear the fixed app header without reintroducing empty space');
    assert(todayStyles.includes('flex: 1 1 auto;'), 'desktop today draft paper should extend to the bottom of the workspace');
    assert(todayStyles.includes('padding: 26px 48px 28px;'), 'desktop today drafts should keep the footer close to the notebook edge');
    assert(todayStyles.includes('.today-drafts-writing-area'), 'the draft page should reserve a visible writing area when no items exist');
    assert(todayStyles.includes('.today-drafts-subtitle'), 'the disposable lifetime hint should have a dedicated subtitle style');
    assert(/\.today-draft-text-display\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/.test(todayStyles), 'displayed today drafts should wrap onto the ruled rhythm instead of truncating');
    assert(/\.today-draft-text-display\s*\{[^}]*line-height:\s*44px;/.test(todayStyles), 'each wrapped text line should sit on one 44px ruled band');
    assert(/\.today-draft-text-display\s*\{[^}]*text-indent:\s*36px;[^}]*white-space:\s*pre-wrap;/.test(todayStyles), 'the first line keeps the checkbox indent while wrapped lines start flush at the paper edge');
    assert(/\.today-draft-check\s*\{[^}]*z-index:\s*1;/.test(todayStyles), 'the checkbox must stay clickable above the flush text box');
    assert(todayStyles.includes('.today-draft-row.is-readonly .today-draft-swipe-action--delete'), 'the historical left-slot swipe is a copy action and must not wear the destructive red');
    assert(todayManagerSource.includes('copyDraftToThought'), 'historical rows should expose the right-swipe copy-to-thought action');
    assert(/\.today-drafts-header\s*\{[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*0 0 4px;/.test(todayStyles), 'the title group should connect to the writing paper without the former footer-sized gap');
    assert(todayStyles.includes('repeating-linear-gradient'), 'the empty writing area should retain subtle ruled-paper lines');
    assert(todayManagerSource.includes("this.writingArea?.classList.toggle('is-empty', todayItems.length === 0);"), 'the composer should move between the first and next available line as today items change');
    assert(todayManagerSource.includes('bindPagerFlipActions') && todayManagerSource.includes('this.viewDay'), 'the manager should own the day paging state and flip gesture');
    assert(todayManagerSource.includes('copyDraftToToday'), 'historical rows should expose the copy-to-today action');
    assert(todayManagerSource.includes('completed: item.completed === true'), 'copying a historical draft into today should preserve its completion state');
    assert(todayManagerSource.includes('toaster?.show'), 're-adding a historical draft into today should surface a toast confirmation');
    assert(todayManagerSource.includes('setHeaderStats(this.viewDay)'), 'the status line should describe the day being viewed, not always today');
    assert(todayManagerSource.includes('setHeaderStats(targetDay)'), 'the pre-laid target page should carry the target day stats before the flip commits');
    assert(todayManagerSource.includes('dayWindowKeys'), 'the manager should scope rendering and sync to the 3-day window');
    assert(!todayStyles.includes('perspective:'), 'the page turn is a 2D clip + mirror curl, never a door-panel 3D rotation');
    assert(/#today-drafts-flip-flap\s*\{[^}]*transform-origin:\s*0\s*0;/.test(todayStyles), 'the mirrored back face must hinge at the left edge so the crease reflection math holds');
    assert(todayStyles.includes('.today-drafts-flip-layer'), 'the turning copies are dedicated absolutely-positioned layers');
    assert(/#today-drafts-flip-crease\s*\{/.test(todayStyles) && /#today-drafts-flip-shadow\s*\{/.test(todayStyles), 'the fold line and its feathered drop shadows are dedicated overlay layers');
    assert(todayStyles.includes('@media (prefers-reduced-motion: reduce)'), 'reduced motion must be able to still the paper immediately');
    assert(todayManagerSource.includes('applyFlipFrame') && todayManagerSource.includes('scaleX(-1)'), 'the turning page renders its back face by mirroring the sheet around the moving crease');
    assert(todayManagerSource.includes('animateFlipRelease'), 'the release should tween the crease to its landing or bounce');
    assert(todayManagerSource.includes('FLIP_COMMIT_RATIO = 0.25'), 'release commits past a quarter of the page width');
    assert(!todayManagerSource.includes('rotateY'), 'the page must not swing like a rigid door');
    // 纸背拷贝复用卡片类 .today-drafts-sheet 是有意的（它们就是整页纸面的镜像），
    // 但卡片规则本身绝不能自带 position:absolute——绝对定位只属于 .today-drafts-flip-layer。
    assert(!/\.today-drafts-sheet\s*\{[^}]*position:\s*absolute/.test(todayStyles), 'the card class must never be absolutely positioned');
    assert(/\.today-drafts-sheet\s*\{[^}]*padding:\s*26px 36px 20px;/.test(todayStyles), 'the paper card keeps its own geometry');
    assert(todayStyles.includes('.today-draft-row.is-copied'), 'a copied historical row should flash a confirmation tint');
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
    assert(todayStyles.includes('var(--muted-text) 38%'), 'empty notebook lines should remain clearly visible through the final paper line');
    assert(!todayStyles.includes('var(--muted-text) 28%'), 'empty notebook lines should not use the former too-faint rule contrast');
    assert(todayStyles.includes('radial-gradient('), 'the writing surface should retain a subtle paper-grain texture');
    assert(todayStyles.includes('background-size: 100% 44px, 9px 9px, 13px 13px;'), 'paper grain should remain fine and independent from the writing-line rhythm');
    assert(!todayStyles.includes('border-bottom: 1px solid color-mix(in srgb, var(--muted-text) 28%, transparent);'), 'the writing surface should not add an off-rhythm closing rule now that the footer has moved into the title');
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
