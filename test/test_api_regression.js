const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 19003);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function assertSaveNotesConflictScope() {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const toasterSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'toaster.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const noteRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'note-routes.js'), 'utf8');
    const start = appSource.indexOf('async function saveNotes(');
    const end = appSource.indexOf('let dirtySyncInFlight', start);
    assert(start >= 0 && end > start, 'saveNotes function should be discoverable');
    const saveNotesSource = appSource.slice(start, end);
    assert(
        /let\s+baseVersion\s*;[\s\S]*try\s*\{/.test(saveNotesSource),
        'saveNotes should keep baseVersion in catch scope for 409 conflict recovery'
    );
    assert(
        !/const\s+baseVersion\s*=/.test(saveNotesSource),
        'saveNotes should not redeclare baseVersion inside try because catch needs it'
    );
    assert(
        serverSource.includes('registerNoteRoutes(app') &&
        noteRoutesSource.includes("app.post('/api/notes/:id'") &&
        noteRoutesSource.includes('currentVersion: notepad.version || 1'),
        'note save conflict behavior should live in the note route module'
    );
    assert(
        /(noteSaveInFlight|saveNotesInFlight|pendingNoteSave|saveNotesQueue|queuedSaveNotes)/.test(appSource),
        'single-client note saves should be serialized so overlapping autosaves do not reuse a stale baseVersion and masquerade as multi-device conflicts'
    );
    assert(
        saveNotesSource.includes('savedContentStillCurrent') &&
        /cacheDirtyNote\(targetNotepadId, editor\.value, \{[\s\S]*?version:\s*result\.version,[\s\S]*?baseContent:\s*content[\s\S]*?\}\)/.test(saveNotesSource),
        'a completed stale save should advance the merge base while keeping newer editor content dirty until the queued latest save finishes'
    );
    assert(
        /(activeToasts|toastKey|dedupeKey|conflictToastEl|noteConflictToast)/.test(`${appSource}\n${toasterSource}`),
        'static conflict toasts should be deduplicated instead of stacking repeated identical conflict messages'
    );

    const createStart = appSource.indexOf('async function createNotepad()');
    const renameStart = appSource.indexOf('async function renameNotepad()');
    const deleteStart = appSource.indexOf('async function doDeleteNotepad()');
    const downloadStart = appSource.indexOf('function downloadNotepad', deleteStart);
    const createSource = createStart >= 0 && renameStart > createStart ? appSource.slice(createStart, renameStart) : '';
    const renameSource = renameStart >= 0 && deleteStart > renameStart ? appSource.slice(renameStart, deleteStart) : '';
    const deleteSource = deleteStart >= 0 && downloadStart > deleteStart ? appSource.slice(deleteStart, downloadStart) : '';
    assert(
        appSource.includes('function createClientNotepadId()') &&
        appSource.includes('function renderNotepadLists') &&
        createSource.includes('optimisticNotepad') &&
        createSource.includes('body: JSON.stringify({ id: optimisticNotepad.id') &&
        !createSource.includes('await loadNotepads()') &&
        !renameSource.includes('await loadNotepads()') &&
        !deleteSource.includes('await loadNotepads()'),
        'notepad create, rename, and delete should update local UI immediately instead of blocking on a full notepad reload'
    );
}

function assertThoughtsFrontendRegressions() {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const thoughtsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const thoughtRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'thought-routes.js'), 'utf8');
    const trashRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'trash-routes.js'), 'utf8');
    const storageSource = fs.readFileSync(path.join(ROOT, 'scripts', 'storage.js'), 'utf8');
    const thoughtAIStatusSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-ai-status.js'), 'utf8');
    const thoughtCardRendererSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-card-renderer.js'), 'utf8');
    const thoughtRelationsPanelSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-relations-panel.js'), 'utf8');
    const thoughtApiClientSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-api-client.js'), 'utf8');
    const thoughtOutboxSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-outbox.js'), 'utf8');
    const hybridEditorSource = fs.readFileSync(path.join(ROOT, 'public', 'hybrid-editor.js'), 'utf8');
    const openApi = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'openapi.json'), 'utf8'));
    const stylesCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'styles.css'), 'utf8');
    const thoughtsCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'thoughts.css'), 'utf8');
    const iosThemeCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'ios-theme.css'), 'utf8');
    const indexSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert(
        serverSource.includes("registerTrashRoutes(app") &&
        trashRoutesSource.includes("app.get('/api/trash'") &&
        trashRoutesSource.includes("app.post('/api/trash/:trashId/restore'") &&
        storageSource.includes("s3WriteJSON('trash/index.json'") &&
        storageSource.includes('function trashPayloadKey') &&
        storageSource.includes("const folder = type === 'thought' ? 'thoughts' : 'notepads'") &&
        indexSource.includes('id="settings-trash-section"') &&
        appSource.includes('refreshTrashList(false)'),
        'settings trash should be wired through backend routes and storage-backed trash index/payload files'
    );
    assert(
        !appSource.includes('settings-trash-preview') &&
        !appSource.includes('item.preview ||') &&
        appSource.includes('function compactTrashThoughtTitle') &&
        appSource.includes("item.type === 'thought' ? compactTrashThoughtTitle(item.title)") &&
        !appSource.includes('return `Thought · ${text.length'),
        'settings trash list should not render deleted item body previews and should only expose a compact thought title'
    );
    assert(
        thoughtsSource.includes('clearThoughtSelectionForSwipe') &&
        thoughtsSource.includes('captureSwipePointer(event)') &&
        thoughtsSource.includes('suppressNextClick'),
        'thought swipe delete should clear stale text selection, capture pointer from pointerdown, and suppress follow-up clicks'
    );
    assert(
        !thoughtsSource.includes('statusEl.outerHTML = this.renderAIStatus'),
        'AI status relation update should not replace the button without rebinding click events'
    );
    assert(
        thoughtAIStatusSource.includes('待评估'),
        'AI detail counts should use user-facing 待评估 wording instead of 候选'
    );
    assert(
        thoughtRoutesSource.includes("app.post('/api/thoughts/:id/ai-insight'") &&
        thoughtRoutesSource.includes('AI insight model is not configured') &&
        thoughtRoutesSource.includes('insight: normalizeInsight(meta?.insight)') &&
        thoughtApiClientSource.includes('generateInsight(id)') &&
        thoughtAIStatusSource.includes('thought-ai-insight-run') &&
        thoughtAIStatusSource.includes('data-insight-toggle') &&
        thoughtsSource.includes('hydrateAIInsightMarkdown') &&
        thoughtsSource.includes('formatAIInsightError') &&
        thoughtsSource.includes('AI_INSIGHT_MODEL'),
        'manual Thought insight should be wired through a dedicated route, API client, AI detail panel, markdown hydrate, and explicit config error hint'
    );
    const insightGenerateStart = thoughtsSource.indexOf('async generateThoughtInsight(panel, thoughtId)');
    const insightGenerateEnd = thoughtsSource.indexOf('formatAIInsightError', insightGenerateStart);
    const insightGenerateSource = insightGenerateStart >= 0 && insightGenerateEnd > insightGenerateStart
        ? thoughtsSource.slice(insightGenerateStart, insightGenerateEnd)
        : '';
    assert(
        insightGenerateSource && !insightGenerateSource.includes('toaster?.show'),
        'manual Thought insight failures should render inline in the AI detail panel without showing a toast'
    );
    assert(
        thoughtsSource.indexOf("raw.includes('must be configured separately')") <
            thoughtsSource.indexOf("err?.status === 503"),
        'manual Thought insight should show the dedicated same-model error before the generic 503 missing-config hint'
    );
    const expandedInsightStart = thoughtsCss.indexOf('.thought-ai-insight.expanded .thought-ai-insight-markdown');
    const expandedInsightEnd = expandedInsightStart >= 0 ? thoughtsCss.indexOf('}', expandedInsightStart) : -1;
    const expandedInsightSource = expandedInsightStart >= 0 && expandedInsightEnd > expandedInsightStart
        ? thoughtsCss.slice(expandedInsightStart, expandedInsightEnd)
        : '';
    assert(
        expandedInsightSource &&
        !/max-height:\s*420px\b/.test(expandedInsightSource) &&
        !/overflow-y:\s*auto\b/.test(expandedInsightSource),
        'expanded Thought AI insight should show the full markdown in the panel instead of hiding it behind a fixed 420px inner scroller'
    );
    assert(
        thoughtsCss.includes('.thought-card.can-expand:not(.expanded) .subtask-list .subtask-add-inline'),
        'collapsed long cards should only hide subtask-list inline add buttons'
    );
    assert(
        !thoughtsCss.includes('.thought-card.can-expand:not(.expanded) .subtask-add-inline {'),
        'collapsed long cards should not hide footer add-subtask buttons'
    );
    assert(
        indexSource.includes('thoughts-outbox-status') &&
        thoughtsCss.includes('.thoughts-outbox-status'),
        'thoughts view should expose a visible pending outbox retry control'
    );
    assert(
        thoughtsSource.includes("import ThoughtOutbox from './thought-outbox.js'") &&
        thoughtOutboxSource.includes("const DEFAULT_OUTBOX_KEY = 'dumbpad_thoughts_outbox_v1'") &&
        thoughtOutboxSource.includes('mergeThoughts') &&
        thoughtOutboxSource.includes('async retry(apiClient)') &&
        thoughtsSource.includes('retryOutbox'),
        'ThoughtsManager should delegate browser local thought outbox persistence and replay to ThoughtOutbox'
    );
    assert(
        thoughtsSource.includes('enqueueThoughtOverwrite(thought, err)') &&
        thoughtOutboxSource.includes("kind: 'relation'") &&
        thoughtOutboxSource.includes("kind: 'create'") &&
        thoughtOutboxSource.includes('markConflict') &&
        thoughtOutboxSource.includes("item.state === 'conflict'"),
        'thought create, overwrite, relation operations, and version conflicts should be covered by the outbox'
    );
    assert(
        thoughtsSource.includes("e.key === 'Enter' && (e.ctrlKey || e.metaKey)") &&
        !thoughtsSource.includes("e.key === 'Enter' && !e.shiftKey") &&
        thoughtsSource.includes('const tempThought = createLocalPendingThought') &&
        thoughtsSource.includes('this.thoughts.unshift(tempThought)') &&
        thoughtsSource.indexOf('this.closeQuickAdd();') < thoughtsSource.indexOf('await this.apiClient.create'),
        'Quick Add should support multiline input and optimistically insert local pending thoughts before network completion'
    );
    const thoughtEditSaveBlock = thoughtsSource.slice(
        thoughtsSource.indexOf('const saveAndExit = () => {'),
        thoughtsSource.indexOf('// Ctrl+Enter to save')
    );
    assert(
        thoughtEditSaveBlock.includes('this.exitEditMode(card);') &&
        thoughtEditSaveBlock.includes('this.apiClient.overwrite(thought.id, thought)') &&
        !thoughtEditSaveBlock.includes('await this.apiClient.overwrite(thought.id, thought);'),
        'thought editing should exit immediately and save in the background'
    );
    assert(
        thoughtOutboxSource.includes("completed: thought.completed === true"),
        'thought overwrite outbox payload should preserve completed state'
    );
    assert(
        serverSource.includes('registerThoughtRoutes(app') &&
        thoughtRoutesSource.includes('async function withRelationWriteLock') &&
        thoughtRoutesSource.includes('await withRelationWriteLock(async () =>') &&
        thoughtRoutesSource.includes("app.post('/api/thoughts/:id/relations'"),
        'manual relation writes should share the AI relation write lock to avoid confirm/rebuild races'
    );
    assert(
        thoughtsSource.includes("import ThoughtApiClient from './thought-api-client.js'") &&
        thoughtApiClientSource.includes('class ThoughtApiError') &&
        thoughtApiClientSource.includes('encodeURIComponent(id)') &&
        !thoughtsSource.includes("fetch('/api/thoughts") &&
        !thoughtsSource.includes('fetch(`/api/thoughts'),
        'ThoughtsManager should delegate Thought HTTP details to ThoughtApiClient'
    );
    assert(
        thoughtApiClientSource.includes("params.set('light', '1')") &&
        thoughtApiClientSource.includes("params.set('limit'"),
        'ThoughtApiClient should support lightweight limited thought search'
    );
    assert(
        openApi.openapi === '3.1.0' &&
        openApi.paths?.['/api/thoughts'] &&
        openApi.paths?.['/api/notes/{id}'] &&
        openApi.paths?.['/api/assets/files'] &&
        openApi.paths?.['/api/verify-pin'] &&
        openApi.paths?.['/api/pin-required'] &&
        openApi.paths?.['/api/config'] &&
        openApi.paths?.['/api/meta'] &&
        openApi.paths?.['/api/trash'] &&
        openApi.paths?.['/api/thoughts/{id}/relations'] &&
        openApi.paths?.['/api/thoughts/{id}/ai-status'] &&
        openApi.paths?.['/api/notepads/{id}']?.get &&
        openApi.components?.schemas?.ThoughtAttachment &&
        openApi.components?.schemas?.ThoughtMutationResult &&
        openApi.components?.schemas?.FileAsset &&
        openApi.components?.securitySchemes?.pinBearer,
        'developer API contract should expose the public authentication, trash, Notepad, Thought, and attachment APIs'
    );
    assert(
        thoughtsSource.includes('queueManualRelationSearch') &&
        thoughtsSource.includes('manualRelationSearchSeq') &&
        thoughtsSource.includes('this.apiClient.searchTargets(q, 8)') &&
        thoughtRelationsPanelSource.includes('summaryHtml = highlightPlainText') &&
        thoughtRelationsPanelSource.includes('textSnippetAroundQuery'),
        'manual relation search should be debounced, lightweight, stale-safe, and keyword-highlighted'
    );
    assert(
        thoughtRelationsPanelSource.includes('thought-relation-unlink-icon') &&
        thoughtRelationsPanelSource.includes('m15 7 2-2a4.24 4.24') &&
        !thoughtRelationsPanelSource.includes('img.icons8.com/fluency-systems-regular/48/disconnected.png') &&
        thoughtAIStatusSource.includes('AI_RETRY_ICON_SVG') &&
        thoughtAIStatusSource.includes('M20 11a8.1 8.1 0 0 0-15.5-2L3 11') &&
        !thoughtAIStatusSource.includes('AI_RUN_COMMAND_ICON_SRC'),
        'relation deletion and AI retry controls should use inline unlink and refresh icons'
    );
    assert(
        thoughtsSource.includes('scrollFirstSearchHighlight(card)') &&
        thoughtsSource.includes("card.querySelector('.thought-highlight')") &&
        thoughtsSource.includes("target.scrollIntoView({ behavior: 'smooth', block: 'center' })") &&
        thoughtsSource.includes("target.classList.add('is-jump-target')"),
        'clicking a searched thought should jump to the first highlighted keyword'
    );
    assert(
        thoughtsSource.includes('openRelationsPanelIds = new Set()') &&
        thoughtsSource.includes('openAIStatusPanelIds = new Set()') &&
        thoughtsSource.includes('restoreOpenPanelsAfterRender()') &&
        thoughtsSource.includes('this.restoreOpenPanelsAfterRender();') &&
        thoughtsSource.includes('async openRelationsPanel(card, thought)') &&
        thoughtsSource.includes('async openAIStatusPanel(card, thought)') &&
        thoughtsSource.includes('if (!panel.isConnected) return'),
        'thought relation and AI detail panels should stay open across cached/network re-renders and ignore stale async panel updates'
    );
    assert(
        (thoughtsSource.match(/renderTagFilters\(\)\s*\{/g) || []).length === 1,
        'ThoughtsManager should not contain duplicate renderTagFilters definitions'
    );
    assert(
        (thoughtsSource.match(/getAllTags\(\)\s*\{/g) || []).length === 1,
        'ThoughtsManager should not contain duplicate getAllTags definitions'
    );
    assert(
        thoughtRoutesSource.includes('const light =') &&
        thoughtRoutesSource.includes('const limit =') &&
        thoughtRoutesSource.includes('const items = thoughts.map(thought => ({') &&
        thoughtRoutesSource.includes('pageFormat ? { items, nextCursor, hasMore } : items'),
        'thought routes should expose lightweight arrays and compatible cursor-paginated responses without meta reads'
    );
    assert(
        thoughtRoutesSource.includes('function createThoughtId') &&
        thoughtRoutesSource.includes('Math.random().toString(36)'),
        'thought creation should avoid Date.now-only id collisions during rapid creates'
    );
    assert(
        !thoughtRoutesSource.includes('queue reason=update') &&
        !thoughtRoutesSource.includes("queueThought(thought.id, 'update')"),
        'thought edits should not automatically rerun the AI pipeline'
    );
    assert(
        thoughtAIStatusSource.includes('thought-ai-count ${count > 0') &&
        thoughtsSource.includes('updateThoughtToolCounts') &&
        thoughtsSource.includes('updateThoughtRelationCount(targetId, data.targetRelationCount') &&
        thoughtRoutesSource.includes('targetRelationCount') &&
        thoughtRoutesSource.includes("type: 'relations_update'"),
        'AI status buttons should always show a count and relation add/delete should refresh counts without manual reload'
    );
    assert(
        thoughtAIStatusSource.includes("thought-ai-count ${count > 0 ? 'has-count' : 'is-zero'}") &&
        thoughtCardRendererSource.includes("relations-count ${relationCount > 0 ? 'has-count' : 'is-zero'}") &&
        thoughtsCss.includes('.thought-ai-count.has-count') &&
        thoughtsCss.includes('.relations-count.has-count') &&
        thoughtsCss.includes('[data-theme=\"dark\"] .relations-count.has-count'),
        'AI and relation count badges should expose zero/non-zero classes with theme-aware colors'
    );
    assert(
        iosThemeCss.includes('body.thoughts-mode #fab-add-thought') &&
        iosThemeCss.includes('right: 18px;') &&
        iosThemeCss.includes('left: auto;') &&
        iosThemeCss.includes('padding-bottom: max(20px, env(safe-area-inset-bottom, 0px));') &&
        iosThemeCss.includes('#fab-add-thought') &&
        iosThemeCss.includes('transform 0.2s cubic-bezier') &&
        !iosThemeCss.includes('padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 104px);'),
        'mobile Thought FAB should stay on the right without animating position and the scroll area should not reserve a large blank bottom gutter'
    );
    assert(
        !/padding-bottom:\s*calc\(env\(safe-area-inset-bottom,\s*0px\)\s*\+\s*1(?:1[0-9]|2[0-9])px\)\s*!important/.test(iosThemeCss),
        'mobile article editor and reading content should not reserve a fixed 110px+ bottom gutter that creates a blank area at the end'
    );
    const thoughtFadeInStart = thoughtsCss.indexOf('@keyframes thoughtFadeIn');
    const thoughtFadeInEnd = thoughtFadeInStart >= 0 ? thoughtsCss.indexOf('}', thoughtsCss.indexOf('to {', thoughtFadeInStart)) : -1;
    const thoughtFadeInSource = thoughtFadeInStart >= 0 && thoughtFadeInEnd > thoughtFadeInStart
        ? thoughtsCss.slice(thoughtFadeInStart, thoughtFadeInEnd)
        : '';
    assert(
        !thoughtFadeInSource || !thoughtFadeInSource.includes('transform:'),
        'if restored, Thought view fade-in must not transform the view container because fixed FAB children drift with transformed ancestors'
    );
    assert(
        hybridEditorSource.includes("target.closest('.vditor-copy, .code-lang-copy-button, .dumbpad-code-copy')") &&
        hybridEditorSource.indexOf("target.closest('.vditor-copy, .code-lang-copy-button, .dumbpad-code-copy')") <
            hybridEditorSource.indexOf("target.closest('.vditor-reset')"),
        'reading mode click guard should allow code block copy buttons before blocking editor clicks'
    );
    const toggleSubtaskStart = thoughtsSource.indexOf('async toggleSubtask(id, subId)');
    const toggleSubtaskSource = toggleSubtaskStart >= 0 ? thoughtsSource.slice(toggleSubtaskStart) : '';
    assert(
        thoughtsSource.includes('expandedThoughtIds = new Set()') &&
        thoughtsSource.includes("this.expandedThoughtIds.has(thought.id)") &&
        thoughtsSource.includes('setThoughtCardExpanded(card, thought.id') &&
        toggleSubtaskSource.includes('this.focusExpandedThought(id);') &&
        toggleSubtaskSource.indexOf('this.focusExpandedThought(id);') < toggleSubtaskSource.indexOf("if (subId.startsWith('legacy_')"),
        'expanded thought cards should remain expanded across subtask completion renders'
    );
    assert(
        thoughtsSource.includes('bindThoughtSelectionFormatting(card, thought)') &&
        thoughtsSource.includes('bindThoughtInlineStyleClearing(card, thought)') &&
        thoughtsSource.includes('applySelectedThoughtStyle') &&
        thoughtsSource.includes('data-thought-style="highlight"') &&
        thoughtsSource.includes('data-thought-style="draw"') &&
        thoughtsSource.includes("event.target.closest('.thought-inline-highlight, .thought-draw-line, .thought-note-line')") &&
        thoughtsSource.includes("this.showThoughtSelectionToolbar(styledNode.getBoundingClientRect(), { mode: 'clear' })") &&
        thoughtsSource.includes("toolbar.dataset.mode === 'clear' && this.activeThoughtSelection") &&
        thoughtsCss.includes('.thought-selection-toolbar[data-mode="format"] [data-thought-style="clear"]') &&
        thoughtsCss.includes('.thought-selection-toolbar[data-mode="clear"] [data-thought-style="highlight"]') &&
        !thoughtsSource.includes('startLongPress') &&
        !thoughtsSource.includes("textEl.addEventListener('touchstart'"),
        'Thought text styling should use selected text controls, and clear style should appear only when clicking styled text'
    );
    assert(
        thoughtsSource.includes('data-thought-style="copy"') &&
        thoughtsSource.includes('data-copy-icon="true"') &&
        thoughtsSource.includes('aria-label="复制已选文字"') &&
        thoughtsSource.includes('<svg viewBox="0 0 24 24"') &&
        thoughtsSource.includes("if (style === 'copy')") &&
        thoughtsSource.includes('this.copyTextWithFeedback(button, selection.selectedText)') &&
        thoughtsSource.includes('window.getSelection?.().removeAllRanges()'),
        'Thought selected-text toolbar should provide icon actions and copy the selected text through the existing clipboard fallback'
    );
    assert(
        indexSource.includes('id="toggle-thoughts"') &&
        indexSource.includes('M12 2a7 7 0 0 0-4 12.74') &&
        !indexSource.includes('M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19'),
        'the Thought entry action should use a lightbulb icon rather than the editor pencil icon'
    );
    assert(
        thoughtsSource.includes('focusSearch()') &&
        thoughtsSource.includes('this.searchInput.focus()') &&
        appSource.includes("e.key.toLowerCase() === 'f'") &&
        appSource.includes('thoughtsManager?.isActive') &&
        appSource.includes('thoughtsManager.focusSearch()'),
        'Ctrl/Cmd+F should focus Thought search in Thoughts mode and reuse command search elsewhere'
    );
    assert(
        stylesCss.includes('[data-theme="dark"] .vditor-reset pre > code.hljs') &&
        stylesCss.includes('#c9d1d9') &&
        stylesCss.includes('.hljs-comment') &&
        stylesCss.includes('#8b949e'),
        'dark code blocks should use a readable GitHub Dark foreground and syntax token palette'
    );
    assert(
        thoughtsCss.includes('.thought-highlight') &&
        thoughtsCss.includes('background: #dbeafe') &&
        thoughtsCss.includes('color: #1d4ed8') &&
        thoughtsCss.includes('[data-theme="dark"] .thought-highlight'),
        'Thought search hits should use a dedicated blue highlight in light and dark themes'
    );
    assert(
        thoughtsSource.includes('bindThoughtSwipeDelete(card, thought)') &&
        thoughtsSource.includes('deltaX > 14') &&
        thoughtsSource.includes('threshold = card.offsetWidth * 0.5') &&
        thoughtsSource.includes('deltaX >= threshold') &&
        thoughtsSource.includes('getThoughtSwipeState(deltaX, threshold, maxSwipe)') &&
        thoughtsSource.includes('card.style.transform = `translate3d(${state.swipeX}px, 0, 0)`') &&
        thoughtsSource.includes("card.style.setProperty('--swipe-action-opacity'") &&
        !thoughtsSource.includes('const threshold = 88') &&
        thoughtsSource.includes('confirmAndDeleteThought(thought.id, { skipConfirm: true })') &&
        thoughtsCss.includes('translate3d(var(--swipe-x, 0), 0, 0)') &&
        thoughtsCss.includes('.thought-swipe-action') &&
        thoughtsCss.includes('.thought-swipe-action-icon') &&
        thoughtsCss.includes('.thought-card.swiping') &&
        thoughtsCss.includes('.thought-card.swipe-ready') &&
        thoughtsCss.includes('.thought-card.swipe-deleting') &&
        thoughtsCss.includes('.thought-card.swipe-ready .thought-swipe-action-icon') &&
        !thoughtsCss.includes('--swipe-icon-opacity') &&
        !thoughtsCss.includes('--swipe-rail-opacity'),
        'Thought cards should support right-swipe delete with a visible trash action, confirmation, and deletion animation'
    );
    assert(
        thoughtsSource.includes("thought-edit-att-item ${isImage ? 'is-image' : 'is-file'}") &&
        thoughtsSource.includes('thought-edit-att-icon') &&
        thoughtsSource.includes('aria-label="移除附件：${name}"') &&
        thoughtsCss.includes('grid-template-columns: 30px minmax(0, 1fr) 20px') &&
        thoughtsCss.includes('.thought-edit-att-icon') &&
        thoughtsCss.includes('.thought-edit-att-remove:focus-visible'),
        'Thought edit attachments should use compact consistent rows for images and files'
    );
    assert(
        iosThemeCss.includes('body:not(.thoughts-mode) .floating-actions') &&
        iosThemeCss.includes('bottom: calc(env(safe-area-inset-bottom, 0px) + 18px);') &&
        iosThemeCss.includes('min-height: 48px;') &&
        iosThemeCss.includes('.typora-source-toggle') &&
        iosThemeCss.includes('bottom: calc(env(safe-area-inset-bottom, 0px) + 21px) !important;') &&
        iosThemeCss.includes('height: 42px;'),
        'mobile source toggle should be vertically center-aligned with the floating action pill'
    );
    const initializeStart = appSource.indexOf('const initializeApp = async () =>');
    const initializeSource = initializeStart >= 0 ? appSource.slice(initializeStart) : '';
    assert(
        thoughtsSource.includes("const THOUGHTS_CACHE_KEY = 'dumbpad_thoughts_cache_v1'") &&
        thoughtsSource.includes('loadThoughtsCache()') &&
        thoughtsSource.includes('saveThoughtsCache(thoughts)') &&
        initializeSource.includes('const initialWorkspace = router.getWorkspaceFromLocation()') &&
        initializeSource.includes("if (initialWorkspace === 'thoughts')") &&
        initializeSource.includes('await ensureThoughtsManager()') &&
        initializeSource.includes('await loadNotepads({ loadCurrentNote: startsInEditor })') &&
        initializeSource.includes('scheduleIdleTask(() =>') &&
        initializeSource.indexOf('await ensureThoughtsManager()') < initializeSource.indexOf('await loadNotepads({ loadCurrentNote: startsInEditor })'),
        'Thoughts view should load its module immediately on #thoughts and render cached thoughts before the network refresh'
    );
    assert(
        thoughtOutboxSource.includes('dropped404') &&
        thoughtOutboxSource.includes("Number(err?.status) === 404 && item.kind !== 'create'") &&
        thoughtsSource.includes('dropped404') &&
        thoughtsSource.includes('result.dropped404?.length'),
        'outbox replay must drop items whose Thought no longer exists remotely instead of retrying 404s forever'
    );
    assert(
        thoughtsSource.includes('_thoughtMutationQueues') &&
        thoughtsSource.includes('async mutateThought(thought, send') &&
        thoughtsSource.includes("this.apiClient.addSubitem(thought.id, text, thought.version)") &&
        thoughtsSource.includes("this.apiClient.toggleSubitem(id, subId, thought.version)"),
        'subtask mutations must run through the per-Thought serialized queue so rapid edits never reuse a stale baseVersion'
    );
    assert(
        thoughtApiClientSource.includes('searchTargets(query, limit = 8)') &&
        thoughtsSource.includes('this.apiClient.searchTargets(q, 8)') &&
        thoughtRoutesSource.includes("app.get('/api/thoughts/search'") &&
        storageSource.includes('async function searchThoughtsLight('),
        'manual relation search must use the index-backed lightweight search endpoint instead of a full Thought read'
    );
    assert(
        thoughtsSource.includes('const holdsFocus = (element) => {') &&
        thoughtsSource.includes('flushWhenFocusFree'),
        'background Thought re-renders must defer while a timeline input holds focus so mobile keyboards are not dismissed'
    );
    assert(
        hybridEditorSource.includes('bindArticleLinkInteractions()') &&
        hybridEditorSource.includes("target.closest('.vditor-reset a[href]')"),
        'article links (Lute bare-URL autolinks and authored links) must stay clickable in reading mode'
    );
}

function assertDataSpaceSettingsRegression() {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const settingsDataPanelSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'settings-data-panel.js'), 'utf8');
    const indexSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const authRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'auth-routes.js'), 'utf8');
    const websocketSource = fs.readFileSync(path.join(ROOT, 'server', 'websocket.js'), 'utf8');
    const indexingSource = fs.readFileSync(path.join(ROOT, 'server', 'indexing.js'), 'utf8');
    const dataManagementRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'data-management-routes.js'), 'utf8');
    const notepadRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'notepad-routes.js'), 'utf8');
    const searchRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'search-routes.js'), 'utf8');
    const shareRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'share-routes.js'), 'utf8');
    const staticRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'static-routes.js'), 'utf8');
    const storageSource = fs.readFileSync(path.join(ROOT, 'scripts', 'storage.js'), 'utf8');
    const prefixToolsSource = fs.readFileSync(path.join(ROOT, 'scripts', 's3-prefix-tools.js'), 'utf8');

    assert(
        indexSource.includes('settings-space-list'),
        'settings should expose a cloud data space list'
    );
    assert(
        serverSource.includes('registerAuthRoutes(app') &&
        authRoutesSource.includes("app.post('/api/verify-pin'") &&
        authRoutesSource.includes("app.use('/api'") &&
        authRoutesSource.includes("app.get('/api/config'"),
        'auth routes and PIN protection middleware should live in the auth route module'
    );
    assert(
        serverSource.includes('createWebSocketHub({') &&
        websocketSource.includes('function createWebSocketHub') &&
        websocketSource.includes('broadcastWebSocketMessage') &&
        websocketSource.includes('broadcastUpdate'),
        'WebSocket setup and broadcast helpers should live in the websocket server module'
    );
    assert(
        websocketSource.includes('function broadcastUpdate(notepadId, content, senderId = \'api\', version = undefined, meta = {})') &&
        websocketSource.includes('saveId: meta.saveId') &&
        websocketSource.includes('contentHash: meta.contentHash') &&
        appSource.includes('const remoteVersion = Number(detail.version)') &&
        appSource.includes('pendingNoteSaveIds') &&
        appSource.includes('const isOwnAck = detail.userId === userId') &&
        appSource.includes('setCurrentNoteVersion(currentNotepadId, remoteVersion)') &&
        appSource.includes('cacheSyncedNote(currentNotepadId, detail.content || \'\', { version: remoteVersion })'),
        'remote note updates should carry save identity, content hash, and saved version to avoid false conflict warnings'
    );
    assert(
        serverSource.includes('createSearchIndex({') &&
        indexingSource.includes('function createSearchIndex') &&
        indexingSource.includes('searchNotepads(query)') &&
        indexingSource.includes('watchSearchDocuments'),
        'search indexing cache, search, and filesystem watchers should live in the indexing server module'
    );
    assert(
        appSource.includes('import SettingsDataPanel from \'./managers/settings-data-panel.js\'') &&
        settingsDataPanelSource.includes('class SettingsDataPanel') &&
        settingsDataPanelSource.includes('runAction(action, payload)') &&
        !appSource.includes('/api/data-management/s3/spaces') &&
        !appSource.includes('/api/data-management/s3/select-space'),
        'frontend should delegate data-space requests to SettingsDataPanel'
    );
    assert(
        !appSource.includes('S3_ACCESS_KEY') &&
        !appSource.includes('S3_SECRET_KEY') &&
        !appSource.includes('S3_API_KEY'),
        'frontend should not reference S3 secrets'
    );
    assert(
        serverSource.includes('registerDataManagementRoutes(app') &&
        dataManagementRoutesSource.includes("app.get('/api/data-management/s3/spaces'") &&
        dataManagementRoutesSource.includes("app.post('/api/data-management/s3/select-space'"),
        'server should expose data space listing and selection APIs through the data-management route module'
    );
    assert(
        serverSource.includes('registerNotepadRoutes(app') &&
        notepadRoutesSource.includes("app.get('/api/notepads'") &&
        notepadRoutesSource.includes("app.post('/api/upload'") &&
        notepadRoutesSource.includes("app.delete('/api/notepads/:id'"),
        'notepad list, create, upload, rename, and delete routes should live in the notepad route module'
    );
    assert(
        serverSource.includes('registerSearchRoutes(app') &&
        searchRoutesSource.includes("app.get('/api/search'") &&
        searchRoutesSource.includes('searchNotepads(query)'),
        'search route should live in the search route module'
    );
    assert(
        serverSource.includes('registerShareRoutes(app') &&
        shareRoutesSource.includes("app.get('/api/share/:id'") &&
        shareRoutesSource.includes("app.get('/s/:id'") &&
        shareRoutesSource.includes('getShareToken(id)'),
        'share URL and public share rendering routes should live in the share route module'
    );
    assert(
        serverSource.includes('registerStaticRoutes(app') &&
        staticRoutesSource.includes("app.get('/service-worker.js'") &&
        staticRoutesSource.includes("app.get('/asset-manifest.json'") &&
        staticRoutesSource.includes("app.get('/health'"),
        'static app support routes should live in the static route module'
    );
    assert(
        storageSource.includes('activeS3Prefix') &&
        storageSource.includes('setS3Prefix') &&
        storageSource.includes('getS3Prefix'),
        'storage should support a persisted active S3 prefix'
    );
    assert(
        prefixToolsSource.includes('async function listSpaces('),
        'S3 prefix tools should list selectable data spaces'
    );
}

async function waitForJSONFile(filePath, predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(filePath)) {
            const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!predicate || predicate(payload)) return payload;
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${filePath}`);
}

async function request(route, options = {}) {
    const response = await fetch(`${BASE_URL}${route}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    const text = await response.text();
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
    }

    return { response, body };
}

async function waitForServer(child) {
    const deadline = Date.now() + 15000;
    let lastError = null;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited early with code ${child.exitCode}`);
        }

        try {
            const { response } = await request('/health');
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(`Timed out waiting for test server: ${lastError?.message || 'no response'}`);
}

function openWebSocket() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(BASE_URL.replace(/^http/, 'ws'));
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function waitForWebSocketMessage(ws, predicate, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off('message', onMessage);
            reject(new Error('Timed out waiting for WebSocket message'));
        }, timeout);

        function onMessage(raw) {
            const message = JSON.parse(String(raw));
            if (!predicate(message)) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(message);
        }

        ws.on('message', onMessage);
    });
}

function prepareDataDir() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-api-'));
    const now = Date.now();
    fs.writeFileSync(
        path.join(dataDir, 'notepads.json'),
        JSON.stringify({
            notepads: [{ id: 'default', name: 'Default Notepad', createdAt: now, updatedAt: now }]
        }, null, 2)
    );
    fs.writeFileSync(path.join(dataDir, 'default.txt'), 'Default content');
    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), '[]');
    return dataDir;
}

function startServer(dataDir) {
    return spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            BASE_URL,
            DATA_DIR: dataDir,
            STORAGE_BACKEND: 'local',
            STORAGE_LAYOUT: 'legacy',
            DUMBPAD_PIN: '',
            AI_API_KEY: '',
            AI_INSIGHT_API_KEY: '',
            AI_INSIGHT_MODEL: '',
            AI_EMBEDDING_API_KEY: '',
            OPENCODE_API_KEY: '',
            SILICON_API_KEY: '',
            NODE_ENV: 'development'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

async function run() {
    assertSaveNotesConflictScope();
    assertThoughtsFrontendRegressions();
    assertDataSpaceSettingsRegression();

    const dataDir = prepareDataDir();
    const child = startServer(dataDir);
    const logs = [];

    child.stdout.on('data', chunk => logs.push(String(chunk)));
    child.stderr.on('data', chunk => logs.push(String(chunk)));

    try {
        await waitForServer(child);

        let result = await request('/health');
        assert(result.response.ok && result.body.status === 'ok', 'GET /health should work for the default non-browser test client');

        result = await request('/api/auth/status');
        assert(result.response.ok && result.body.mode === 'legacy', 'GET /api/auth/status should expose legacy mode without prior API authentication');

        result = await request('/api/meta');
        assert(result.response.ok, 'GET /api/meta should expose public API capabilities without prior authentication');
        assert(result.body.auth?.mode === 'legacy', 'API meta should expose the active authentication mode');
        assert(result.body.storage?.backend === 'local', 'API meta should expose the active storage backend');
        assert(typeof result.body.capabilities?.agent?.ready === 'boolean', 'API meta should expose agent readiness without provider secrets');

        result = await request('/openapi.json');
        assert(result.response.ok && result.body.openapi === '3.1.0', 'GET /openapi.json should expose the machine-readable API contract');

        result = await request('/api/notepads');
        assert(result.response.ok, 'GET /api/notepads should succeed');
        assert(Array.isArray(result.body.notepads_list), 'notepads_list should be an array');

        result = await request('/api/notepads', {
            method: 'POST',
            body: JSON.stringify({ id: 'api-regression-note-id', name: 'API Regression Note', content: 'hello' })
        });
        assert(result.response.ok, 'POST /api/notepads should succeed');
        const notepadId = result.body.id;
        assert(notepadId === 'api-regression-note-id', 'created notepad should honor a safe client-provided id');

        result = await request(`/api/notepads/${notepadId}`);
        assert(result.response.ok, 'GET /api/notepads/:id should return one Notepad metadata record');
        assert(result.body.id === notepadId && result.body.name === 'API Regression Note', 'single Notepad metadata should match the created record');
        assert(result.body.version === 1, 'single Notepad metadata should expose the current optimistic-concurrency version');

        result = await request('/api/notepads/__missing_notepad__');
        assert(result.response.status === 404, 'GET /api/notepads/:id should return 404 for a missing Notepad');

        result = await request(`/api/notes/${notepadId}`);
        assert(result.response.ok, 'GET /api/notes/:id should succeed');
        assert(result.body.content === 'hello', 'created note content should be readable');
        assert(result.body.version === 1, 'created note should expose version 1');

        result = await request(`/api/notes/${notepadId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'append', text: ' world' })
        });
        assert(result.response.ok, 'PATCH /api/notes/:id append should succeed');
        assert(result.body.content === 'hello world', 'append should update note content');
        assert(result.body.version === 2, 'note patch should increment version');

        result = await request(`/api/notes/${notepadId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'append', text: ' stale', baseVersion: 1 })
        });
        assert(result.response.status === 409, 'stale note patch should return 409');
        assert(result.body.currentVersion === 2, 'note conflict should report current version');

        result = await request(`/api/notes/${notepadId}`, {
            method: 'POST',
            body: JSON.stringify({ content: 'hello world', baseVersion: 2, userId: 'api-regression-save', saveId: 'api-regression-save-1' })
        });
        assert(result.response.ok, 'POST /api/notes/:id save should succeed');
        assert(result.body.version === 3, 'note save should increment version');
        assert(result.body.saveId === 'api-regression-save-1', 'note save should echo saveId for client acknowledgement');
        assert(typeof result.body.contentHash === 'string' && result.body.contentHash.length >= 16, 'note save should return a content hash');

        result = await request(`/api/notes/${notepadId}`, {
            method: 'POST',
            body: JSON.stringify({ content: 'hello world', baseVersion: 2, userId: 'api-regression-save', saveId: 'api-regression-save-2' })
        });
        assert(result.response.ok, 'same-content stale note save should be accepted as already synced');
        assert(result.body.version === 3, 'same-content stale note save should not increment version');
        assert(result.body.unchanged === true, 'same-content stale note save should report unchanged');

        // Fine-grained note editing (#1 phase 1): an agent can make a targeted
        // change with an occurrence guard instead of rewriting the whole note.
        result = await request('/api/notepads', {
            method: 'POST',
            body: JSON.stringify({ id: 'api-fine-grained-note', name: 'API Fine Grained Note', content: '# Draft\n\nalpha beta alpha\n\ndone' })
        });
        assert(result.response.ok && result.body.id === 'api-fine-grained-note', 'POST /api/notepads should create the fine-grained edit fixture');

        result = await request('/api/notes/api-fine-grained-note', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'replace', target: 'alpha', replacement: 'ALPHA', expectedCount: 1 })
        });
        assert(result.response.status === 400, 'replace with a mismatched expectedCount should be rejected');
        assert(result.body.matchCount === 2, 'a mismatched replace should report the actual match count');

        result = await request('/api/notes/api-fine-grained-note', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'replace', target: 'alpha', replacement: 'ALPHA', expectedCount: 2 })
        });
        assert(result.response.ok, 'replace with a matching expectedCount should succeed');
        assert(result.body.content === '# Draft\n\nALPHA beta ALPHA\n\ndone', 'replace should swap every occurrence');
        assert(result.body.matchCount === 2 && result.body.replaced === 2, 'replace should report match and replaced counts');

        result = await request('/api/notes/api-fine-grained-note', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'replace_first', target: 'ALPHA', replacement: 'A1' })
        });
        assert(result.response.ok, 'replace_first should succeed');
        assert(result.body.content === '# Draft\n\nA1 beta ALPHA\n\ndone', 'replace_first should change only the first occurrence');
        assert(result.body.replaced === 1 && result.body.matchCount === 2, 'replace_first should report only one replacement out of two matches');

        result = await request('/api/notes/api-fine-grained-note', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'insert_after', target: 'done', text: ' now' })
        });
        assert(result.response.ok && result.body.content === '# Draft\n\nA1 beta ALPHA\n\ndone now', 'insert_after should place text right after the anchor');

        result = await request('/api/notes/api-fine-grained-note', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'insert_before', target: 'zzz-missing', text: 'x' })
        });
        assert(result.response.status === 400, 'insert with a missing anchor should be rejected');

        // Structure-aware editing (#1 phase 2): an agent reads the heading
        // outline, then rewrites a single section by slug without touching the rest.
        result = await request('/api/notepads', {
            method: 'POST',
            body: JSON.stringify({ id: 'api-note-outline', name: 'API Note Outline', content: '# Intro\nwelcome\n## Install\nrun npm i\n## Usage\nuse it' })
        });
        assert(result.response.ok && result.body.id === 'api-note-outline', 'POST /api/notepads should create the outline fixture');

        result = await request('/api/notes/api-note-outline/outline');
        assert(result.response.ok, 'GET /api/notes/:id/outline should succeed');
        assert(typeof result.body.version === 'number', 'outline response should include the note version');
        assert(
            JSON.stringify(result.body.outline) === JSON.stringify([
                { id: 'intro', text: 'Intro', level: 1, line: 0 },
                { id: 'install', text: 'Install', level: 2, line: 2 },
                { id: 'usage', text: 'Usage', level: 2, line: 4 }
            ]),
            'outline should expose the heading tree with slugs and line numbers'
        );

        result = await request('/api/notes/api-note-outline', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'replace_section', section: 'install', text: 'run pnpm i' })
        });
        assert(result.response.ok, 'replace_section should succeed');
        assert(result.body.section === 'install', 'replace_section should echo the resolved section slug');
        assert(result.body.content === '# Intro\nwelcome\n## Install\nrun pnpm i\n## Usage\nuse it', 'replace_section should swap only the targeted section body');

        result = await request('/api/notes/api-note-outline', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'append_to_section', section: 'usage', text: '- step 1' })
        });
        assert(result.response.ok, 'append_to_section should succeed');
        assert(result.body.content === '# Intro\nwelcome\n## Install\nrun pnpm i\n## Usage\nuse it\n- step 1', 'append_to_section should add to the end of the section body');

        result = await request('/api/notes/api-note-outline', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'replace_section', section: 'does-not-exist', text: 'x' })
        });
        assert(result.response.status === 400, 'replace_section with an unknown section should be rejected');
        assert(result.body.section === 'does-not-exist', 'a missing section error should echo the requested section');

        result = await request('/api/notepads', {
            method: 'POST',
            body: JSON.stringify({ id: 'api-note-outline-chinese', name: 'API Chinese Outline', content: '# 今日速览\n旧内容\n## 下一步\n保留内容' })
        });
        assert(result.response.ok, 'POST /api/notepads should create the Chinese outline fixture');

        result = await request('/api/notes/api-note-outline-chinese/outline');
        assert(result.response.ok, 'GET Chinese note outline should succeed');
        assert(result.body.outline[0]?.id === '今日速览', 'Chinese headings should retain a stable outline slug');

        result = await request('/api/notes/api-note-outline-chinese', {
            method: 'PATCH',
            body: JSON.stringify({ action: 'replace_section', section: '今日速览', text: '新内容' })
        });
        assert(result.response.ok, 'replace_section should accept an exact unique Chinese heading');
        assert(result.body.content === '# 今日速览\n新内容\n## 下一步\n保留内容', 'Chinese heading replacement should only modify the targeted section body');

        // Batch atomic editing (#1 phase 3): several edits apply under one lock
        // and a single version bump, or none of them do.
        result = await request('/api/notepads', {
            method: 'POST',
            body: JSON.stringify({ id: 'api-note-batch', name: 'API Note Batch', content: 'v1 draft\n\ntodo' })
        });
        assert(result.response.ok && result.body.id === 'api-note-batch', 'POST /api/notepads should create the batch fixture');

        result = await request('/api/notes/api-note-batch/edits', {
            method: 'POST',
            body: JSON.stringify({ edits: [
                { action: 'replace', target: 'v1', replacement: 'v2', expectedCount: 1 },
                { action: 'append', text: '\ndone' }
            ] })
        });
        assert(result.response.ok, 'POST /api/notes/:id/edits should apply a batch');
        assert(result.body.content === 'v2 draft\n\ntodo\ndone', 'a batch should apply its edits in order');
        assert(Array.isArray(result.body.results) && result.body.results.length === 2, 'a batch should report per-edit results');
        assert(result.body.version === 2, 'a batch should bump the note version once');

        result = await request('/api/notes/api-note-batch/edits', {
            method: 'POST',
            body: JSON.stringify({ edits: [
                { action: 'append', text: ' more' },
                { action: 'replace', target: 'does-not-exist', replacement: 'x' }
            ] })
        });
        assert(result.response.status === 400, 'a batch with any failing edit should be rejected');
        assert(result.body.index === 1, 'a batch failure should report the failing edit index');

        result = await request('/api/notes/api-note-batch');
        assert(result.body.content === 'v2 draft\n\ntodo\ndone' && result.body.version === 2, 'a rejected batch should leave the note untouched');

        result = await request('/api/notes/api-note-batch/edits', {
            method: 'POST',
            body: JSON.stringify({ edits: [] })
        });
        assert(result.response.status === 400, 'an empty batch should be rejected');

        result = await request(`/api/notepads/${notepadId}`, {
            method: 'PUT',
            body: JSON.stringify({ name: 'API Regression Note Renamed' })
        });
        assert(result.response.ok, 'PUT /api/notepads/:id should succeed');
        assert(result.body.name === 'API Regression Note Renamed', 'renamed notepad should return the new name');

        result = await request(`/api/notes/${notepadId}`);
        assert(result.response.ok, 'GET /api/notes/:id after rename should succeed');
        assert(result.body.content === 'hello world', 'renamed note should keep content');

        result = await request('/api/notepads');
        const renamedNotepad = result.body.notepads_list.find(item => item.id === notepadId);
        assert(renamedNotepad?.version === 4, 'renamed notepad should expose the latest version before pinning');

        result = await request(`/api/notepads/${notepadId}`, {
            method: 'PATCH',
            body: JSON.stringify({ pinned: true, baseVersion: renamedNotepad.version })
        });
        assert(result.response.ok, 'PATCH /api/notepads/:id should pin a notepad');
        assert(result.body.pinned === true, 'pin update should persist pinned=true');
        assert(Number.isFinite(result.body.pinnedAt), 'pin update should record pinnedAt');
        assert(result.body.version === renamedNotepad.version + 1, 'pin update should advance the notepad version');

        result = await request(`/api/notepads/${notepadId}`, {
            method: 'PATCH',
            body: JSON.stringify({ pinned: false, baseVersion: renamedNotepad.version })
        });
        assert(result.response.status === 409, 'stale notepad pin updates should return 409');

        result = await request(`/api/notepads/${notepadId}`, {
            method: 'PATCH',
            body: JSON.stringify({ pinned: false, baseVersion: renamedNotepad.version + 1 })
        });
        assert(result.response.ok, 'PATCH /api/notepads/:id should unpin a notepad');
        assert(result.body.pinned === false, 'unpin update should persist pinned=false');
        assert(!Object.prototype.hasOwnProperty.call(result.body, 'pinnedAt'), 'unpin update should clear pinnedAt');

        result = await request('/api/search?q=__definitely_no_match__');
        assert(result.response.ok, 'GET /api/search should succeed');
        assert(Array.isArray(result.body.results), 'search results should be an array');
        assert(result.body.results.length === 0, 'search should return no results for unmatched query');
        assert(result.body.totalPages === 0, 'empty search should return totalPages 0');

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'API regression thought', subItems: [] })
        });
        assert(result.response.ok, 'POST /api/thoughts should succeed');
        const thoughtId = result.body.id;
        assert(thoughtId, 'created thought should have an id');
        assert(result.body.version === 1, 'created thought should expose version 1');

        result = await request('/api/search?q=API%20regression&scope=thoughts');
        assert(result.response.ok, 'Thought-scoped global search should succeed');
        assert(result.body.results.some(item => item.id === thoughtId && item.type === 'thought'), 'Thought-scoped global search should return typed Thought results');

        result = await request('/api/search?q=API%20regression&scope=all');
        assert(result.response.ok, 'All-scope global search should succeed');
        assert(result.body.results.some(item => item.id === thoughtId && item.type === 'thought'), 'All-scope global search should include Thought results');

        result = await request('/api/assets/files', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'x-asset-name': encodeURIComponent('thought-attachment.pdf'),
                'x-asset-type': 'application/pdf'
            },
            body: Buffer.from('%PDF-1.4 thought attachment')
        });
        assert(result.response.ok, 'asset fixture upload for Thought attachment hydration should succeed');
        const attachmentAsset = result.body;

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'Thought with hydrated asset', attachments: [{ assetId: attachmentAsset.id }] })
        });
        assert(result.response.ok, 'Thought creation with an assetId-only attachment should succeed');
        assert(result.body.attachments?.[0]?.name === attachmentAsset.name, 'assetId-only Thought attachments should be hydrated with the asset name');
        assert(result.body.attachments?.[0]?.downloadUrl === attachmentAsset.downloadUrl, 'assetId-only Thought attachments should be hydrated with the download URL');
        const attachmentThoughtId = result.body.id;

        result = await request(`/api/thoughts/${attachmentThoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'overwrite', attachments: [{ assetId: attachmentAsset.id }] })
        });
        assert(result.response.ok, 'Thought overwrite with an assetId-only attachment should succeed');
        assert(result.body.thought.attachments?.[0]?.type === attachmentAsset.type, 'Thought attachment overwrites should also hydrate asset metadata');

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'Invalid asset reference', attachments: [{ assetId: 'a'.repeat(24) }] })
        });
        assert(result.response.status === 400 && result.body.code === 'ASSET_NOT_FOUND', 'missing asset references should return a structured client error');

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'API relation target', tags: ['tech'], subItems: [] })
        });
        assert(result.response.ok, 'POST relation target thought should succeed');
        const targetThoughtId = result.body.id;

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'API completed thought', completed: true, subItems: [] })
        });
        assert(result.response.ok, 'POST completed thought should succeed');
        assert(result.body.completed === true, 'POST /api/thoughts should preserve completed state for local outbox replay');
        const completedThoughtId = result.body.id;

        result = await request('/api/thoughts?format=page&light=1&limit=1&updatedSince=0');
        assert(result.response.ok, 'paged lightweight Thought listing should succeed');
        assert(Array.isArray(result.body.items) && result.body.items.length === 1, 'paged Thought listings should return a bounded items array');
        assert(typeof result.body.hasMore === 'boolean', 'paged Thought listings should report whether more items are available');
        assert(result.body.items[0].version >= 1, 'paged lightweight Thought listings should include mutation versions');
        if (result.body.nextCursor) {
            const firstPageId = result.body.items[0].id;
            const nextPage = await request(`/api/thoughts?format=page&light=1&limit=1&cursor=${encodeURIComponent(result.body.nextCursor)}`);
            assert(nextPage.response.ok, 'the next Thought cursor page should succeed');
            assert(nextPage.body.items[0]?.id !== firstPageId, 'the next cursor page should not repeat the previous item');
        }

        result = await request('/api/thoughts?format=page&light=1&limit=1&sort=timeline&status=todo');
        assert(result.response.ok, 'timeline-sorted Thought pagination should succeed');
        assert(result.body.items.every(item => item.completed !== true), 'timeline page status filtering should exclude completed Thoughts');
        if (result.body.nextCursor) {
            const firstTimelineId = result.body.items[0].id;
            const nextTimelinePage = await request(`/api/thoughts?format=page&light=1&limit=1&sort=timeline&status=todo&cursor=${encodeURIComponent(result.body.nextCursor)}`);
            assert(nextTimelinePage.response.ok, 'the next timeline Thought cursor page should succeed');
            assert(nextTimelinePage.body.items[0]?.id !== firstTimelineId, 'the next timeline cursor page should not repeat the previous item');
        }

        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({
                text: 'API progress thought',
                subItems: [
                    { id: 'progress-sub-1', text: 'step done', completed: true },
                    { id: 'progress-sub-2', text: 'step pending', completed: false }
                ]
            })
        });
        assert(result.response.ok, 'POST partial-progress thought should succeed');
        const progressThoughtId = result.body.id;
        // Created after the progress thought so plain createdAt ordering
        // would put the idle one first — the progress boost must win.
        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'API idle newest thought', subItems: [] })
        });
        assert(result.response.ok, 'POST idle thought should succeed');
        const idleThoughtId = result.body.id;
        result = await request('/api/thoughts?format=page&light=1&limit=1&sort=timeline&status=todo');
        assert(result.response.ok, 'timeline page after progress thoughts should succeed');
        assert(result.body.items[0]?.id === progressThoughtId, 'timeline order should surface partial subtask progress above newer idle Thoughts');

        result = await request('/api/thoughts/search?q=progress');
        assert(result.response.ok, 'GET /api/thoughts/search should succeed');
        assert(Array.isArray(result.body.items), 'light Thought search should return an items array');
        assert(result.body.items.some(item => item.id === progressThoughtId), 'light Thought search should match Thought text');
        assert(result.body.items.every(item => !Array.isArray(item.attachments)), 'light Thought search should stay lightweight');
        result = await request('/api/thoughts/search?q=');
        assert(result.response.ok && result.body.items.length === 0, 'empty light Thought search should return no items');

        result = await request(`/api/thoughts/${idleThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE idle thought cleanup should succeed');
        result = await request(`/api/thoughts/${progressThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE progress thought cleanup should succeed');

        result = await request(`/api/thoughts/${completedThoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'overwrite', text: 'API completed thought updated', completed: false })
        });
        assert(result.response.ok, 'PATCH overwrite completed thought should succeed');
        assert(result.body.thought.completed === false, 'PATCH overwrite should preserve completed state for local outbox replay');

        const generatedMeta = await waitForJSONFile(
            path.join(dataDir, 'thoughts.meta', `${thoughtId}.json`),
            meta => meta?.status === 'ready' && meta?.stages?.relations?.status === 'ready',
            8000
        );
        assert(generatedMeta.status === 'ready', 'Noop AI meta should be written as ready');
        assert(generatedMeta.ai.schemaVersion === 2, 'AI meta should use schema version 2');
        assert(Array.isArray(generatedMeta.ai.entities), 'AI meta should include entities array');
        assert(Array.isArray(generatedMeta.ai.topics), 'AI meta should include topics array');
        assert(generatedMeta.ai.intent === 'note', 'Noop AI meta should include default intent');
        assert(generatedMeta.ai.timeScope === 'reference', 'Noop AI meta should include default timeScope');
        assert(generatedMeta.stages?.analysis?.status === 'ready', 'AI meta should include analysis stage');
        assert(generatedMeta.stages?.embedding?.status === 'ready', 'AI meta should include embedding stage');
        assert(generatedMeta.stages?.relations?.status === 'ready', 'AI meta should include relations stage');

        result = await request(`/api/thoughts/${thoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'overwrite', text: 'API regression thought edited', subItems: [] })
        });
        assert(result.response.ok, 'PATCH ready thought should succeed');
        assert(result.body.thought.aiStatus === 'stale', 'PATCH semantic Thought content should mark existing AI output as stale');
        assert(Number.isFinite(result.body.thought.relationCount), 'PATCH ready thought should include current relation count');
        let editedThoughtVersion = result.body.thought.version;
        result = await request(`/api/thoughts/${thoughtId}/ai-status`);
        assert(result.response.ok && result.body.status === 'stale', 'AI status should expose stale derived content after a semantic Thought edit');

        result = await request(`/api/thoughts/${thoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({
                action: 'overwrite',
                text: 'API regression thought versioned edit',
                subItems: [],
                baseVersion: editedThoughtVersion
            })
        });
        assert(result.response.ok, 'PATCH with the current Thought version should succeed');
        assert(result.body.thought.version === editedThoughtVersion + 1, 'a versioned Thought write should advance the version');
        const currentThoughtVersion = result.body.thought.version;

        result = await request(`/api/thoughts/${thoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({
                action: 'overwrite',
                text: 'stale local edit must not overwrite',
                subItems: [],
                baseVersion: editedThoughtVersion
            })
        });
        assert(result.response.status === 409, 'a stale Thought write should return 409');
        assert(result.body.currentVersion === currentThoughtVersion, 'a Thought conflict should expose the current version');
        editedThoughtVersion = currentThoughtVersion;

        result = await request('/api/thoughts?light=1');
        const lightThought = result.body.find(item => item.id === thoughtId);
        assert(result.response.ok && lightThought, 'lightweight Thought lists should include the edited Thought');
        assert(lightThought.version === currentThoughtVersion, 'lightweight Thought lists should carry version for subsequent mutations');

        fs.writeFileSync(
            path.join(dataDir, 'thoughts.meta', `${thoughtId}.json`),
            JSON.stringify({
                ...generatedMeta,
                status: 'pending',
                queuedAt: Date.now() - 600000,
                updatedAt: Date.now() - 600000
            }, null, 2)
        );
        result = await request('/api/thoughts?q=edited');
        assert(result.response.ok, 'GET thoughts with stale pending meta should succeed');
        assert(
            result.body.find(item => item.id === thoughtId)?.aiStatus !== 'pending',
            'stale pending meta should not render as an active pending state in thought lists'
        );
        result = await request(`/api/thoughts/${thoughtId}/ai-status`);
        assert(result.response.ok, 'GET ai-status with stale pending meta should succeed');
        assert(result.body.status !== 'pending', 'stale pending meta should not render as an active pending state in AI detail');
        result = await request(`/api/thoughts/${thoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'overwrite', text: 'API regression thought edited again', subItems: [] })
        });
        assert(result.response.ok, 'PATCH stale pending thought should succeed');
        assert(result.body.thought.aiStatus !== 'pending', 'PATCH stale pending thought should not broadcast a spinning pending state');
        editedThoughtVersion = result.body.thought.version;

        fs.mkdirSync(path.join(dataDir, 'thoughts.meta'), { recursive: true });
        fs.mkdirSync(path.join(dataDir, 'relations'), { recursive: true });
        fs.writeFileSync(
            path.join(dataDir, 'thoughts.meta', `${thoughtId}.json`),
            JSON.stringify({
                id: thoughtId,
                status: 'ready',
                ai: {
                    keywords: ['api'],
                    tags: ['tech'],
                    embedding: [1, 0],
                    extractModel: 'noop-chat',
                    model: 'noop-embedding',
                    processedAt: Date.now()
                },
                stages: {
                    queued: { status: 'ready' },
                    analysis: { status: 'ready', model: 'noop-chat' },
                    embedding: { status: 'ready', model: 'noop-embedding', dims: 2 },
                    relations: { status: 'ready', candidateCount: 2, confirmedCount: 1, suggestionCount: 1 }
                }
            }, null, 2)
        );
        fs.writeFileSync(
            path.join(dataDir, 'relations', `${thoughtId}.json`),
            JSON.stringify({
                id: thoughtId,
                edges: [{
                    targetId: targetThoughtId,
                    score: 0.87,
                    confidence: 0.78,
                    relationType: 'supports',
                    method: 'keyword+vector',
                    reasons: ['api'],
                    signals: { keyword: 1, vector: 0.8 }
                }],
                suggestions: [{
                    targetId: targetThoughtId,
                    score: 0.66,
                    confidence: 0.64,
                    relationType: 'same_project',
                    method: 'keyword',
                    reasons: ['candidate'],
                    signals: { keyword: 0.6 },
                    source: 'ai_suggestion'
                }],
                diagnostics: {
                    status: 'ready',
                    candidateCount: 2,
                    confirmedCount: 1,
                    suggestionCount: 1,
                    rerankScore: 'skipped',
                    rerankJudge: 'ready'
                },
                version: 1,
                computedAt: Date.now()
            }, null, 2)
        );

        result = await request('/api/thoughts?q=regression');
        assert(result.response.ok, 'GET /api/thoughts search should succeed');
        assert(result.body.some(item => item.id === thoughtId), 'thought search should find created thought');
        assert(
            result.body.find(item => item.id === thoughtId)?.relationCount === 1,
            'thought list should include relationCount'
        );

        result = await request(`/api/thoughts/${thoughtId}/relations`);
        assert(result.response.ok, 'GET /api/thoughts/:id/relations should succeed');
        assert(result.body.status === 'ready', 'relations response should include meta status');
        assert(result.body.relations.length === 1, 'relations response should include one relation');
        assert(result.body.relations[0].thought.id === targetThoughtId, 'relations response should include target thought summary');
        assert(result.body.relations[0].relationType === 'supports', 'relations response should include relationType');
        assert(result.body.relations[0].confidence === 0.78, 'relations response should include confidence');
        assert(result.body.relations[0].signals.keyword === 1, 'relations response should include signals');
        assert(result.body.suggestions.length === 1, 'relations response should include suggested relations');
        assert(result.body.suggestions[0].relationType === 'same_project', 'suggestions response should include relationType');

        result = await request(`/api/thoughts/${thoughtId}/ai-status`);
        assert(result.response.ok, 'GET /api/thoughts/:id/ai-status should succeed');
        assert(result.body.stages?.analysis?.status === 'ready', 'ai-status should include analysis stage');
        assert(result.body.stages?.relations?.confirmedCount === 1, 'ai-status should include relation stage counts');
        assert(result.body.diagnostics?.candidateCount === 2, 'ai-status should include relation diagnostics');
        assert(result.body.suggestionCount === 1, 'ai-status should include suggestion count');
        assert(result.body.insight?.status === 'missing', 'ai-status should include missing insight state before manual generation');

        result = await request('/api/thoughts/__missing_thought__/relations');
        assert(result.response.ok, 'GET missing thought relations should not produce a browser-visible 404');
        assert(result.body.status === 'missing', 'missing thought relations should report missing status');
        assert(Array.isArray(result.body.relations) && result.body.relations.length === 0, 'missing thought relations should return empty relations');

        result = await request(`/api/thoughts/${thoughtId}/relations`, {
            method: 'POST',
            body: JSON.stringify({ targetId: targetThoughtId, relationType: 'suggested' })
        });
        assert(result.response.status === 201, 'POST suggested thought relation should succeed');
        assert(result.body.relation?.method === 'manual', 'confirmed suggestion should be marked as manual');
        assert(result.body.relation?.relationType === 'same_project', 'confirmed suggestion should preserve the AI relation type');
        assert(result.body.relation?.confidence === 0.64, 'confirmed suggestion should preserve AI confidence');
        assert(result.body.relation?.reasons?.includes('candidate'), 'confirmed suggestion should preserve AI reasons');
        assert(result.body.relation?.signals?.keyword === 0.6, 'confirmed suggestion should preserve AI signals');
        assert(result.body.targetRelationCount === 1, 'manual relation response should include the target relation count for immediate UI sync');

        result = await request(`/api/thoughts/${thoughtId}/relations/${targetThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE /api/thoughts/:id/relations/:targetId should succeed');
        assert(result.body.removed === true, 'relation delete should report removed true');
        const suppressed = JSON.parse(fs.readFileSync(path.join(dataDir, 'relations.suppressed', `${thoughtId}.json`), 'utf8'));
        assert(
            suppressed.edges.some(edge => edge.targetId === targetThoughtId && edge.reason === 'user_deleted'),
            'relation delete should record a suppressed edge'
        );

        result = await request(`/api/thoughts/${thoughtId}/relations`);
        assert(result.response.ok, 'GET relations after delete should succeed');
        assert(result.body.relations.length === 0, 'relation should be removed');
        assert(result.body.suggestions.length === 0, 'related suggestion should be removed');

        result = await request(`/api/thoughts/${thoughtId}/relations`, {
            method: 'POST',
            body: JSON.stringify({ targetId: targetThoughtId, relationType: 'manual' })
        });
        assert(result.response.status === 201, 'POST manual thought relation should succeed');
        assert(result.body.relation?.method === 'manual', 'manual relation should be marked as manual');

        result = await request(`/api/thoughts/${targetThoughtId}/relations`);
        assert(result.response.ok, 'GET target relations after manual link should succeed');
        assert(
            result.body.relations.some(relation => relation.thought.id === thoughtId && relation.method === 'manual'),
            'manual relation should be visible from the reverse thought'
        );

        const suppressedAfterManual = JSON.parse(fs.readFileSync(path.join(dataDir, 'relations.suppressed', `${thoughtId}.json`), 'utf8'));
        assert(
            !suppressedAfterManual.edges.some(edge => edge.targetId === targetThoughtId),
            'manual relation should remove the previous suppressed pair'
        );

        const wsA = await openWebSocket();
        const wsB = await openWebSocket();
        let receivedLegacyCollaborationEvent = false;
        wsB.on('message', raw => {
            const message = JSON.parse(String(raw));
            if (['user_connected', 'user_disconnected', 'operation', 'cursor', 'sync_response', 'ack'].includes(message.type)) {
                receivedLegacyCollaborationEvent = true;
            }
        });

        let wsPromise = waitForWebSocketMessage(wsB, message => message.type === 'notes_update');
        wsA.send(JSON.stringify({
            type: 'update',
            notepadId,
            content: 'websocket note update',
            userId: 'api-regression-a'
        }));
        let wsMessage = await wsPromise;
        assert(wsMessage.notepadId === notepadId, 'WebSocket notes_update should include notepad id');
        assert(wsMessage.content === 'websocket note update', 'WebSocket notes_update should include content');

        wsPromise = waitForWebSocketMessage(wsB, message => message.type === 'notepad_change');
        wsA.send(JSON.stringify({
            type: 'notepad_change',
            action: 'rename',
            notepadId,
            userId: 'api-regression-a'
        }));
        wsMessage = await wsPromise;
        assert(wsMessage.notepadId === notepadId, 'WebSocket notepad_change should include notepad id');

        const thoughtCreatePromise = waitForWebSocketMessage(wsB, message => (
            message.type === 'thoughts_update' &&
            message.action === 'create'
        ));
        const relationUpdatePromise = waitForWebSocketMessage(wsB, message => (
            message.type === 'relations_update' &&
            Number.isFinite(message.relationsCount)
        ));
        result = await request('/api/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text: 'WebSocket thought source', subItems: [] })
        });
        assert(result.response.ok, 'POST websocket thought should succeed');
        const websocketThoughtId = result.body.id;

        wsMessage = await thoughtCreatePromise;
        assert(wsMessage.payload?.id === websocketThoughtId, 'WebSocket thoughts_update create should include id');
        assert(wsMessage.payload.text === 'WebSocket thought source', 'WebSocket thoughts_update create should include thought');

        wsMessage = await relationUpdatePromise;
        assert(wsMessage.thoughtId === websocketThoughtId, 'WebSocket relations_update should include thought id');
        assert(wsMessage.relationsCount >= 0, 'WebSocket relations_update should include count');

        wsPromise = waitForWebSocketMessage(wsB, message => (
            message.type === 'thoughts_update' &&
            message.action === 'update' &&
            message.payload?.id === websocketThoughtId
        ));
        result = await request(`/api/thoughts/${websocketThoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'overwrite', text: 'WebSocket thought updated' })
        });
        assert(result.response.ok, 'PATCH websocket thought should succeed');

        wsMessage = await wsPromise;
        assert(wsMessage.payload.text === 'WebSocket thought updated', 'WebSocket thoughts_update update should include changed text');

        wsPromise = waitForWebSocketMessage(wsB, message => (
            message.type === 'thoughts_update' &&
            message.action === 'delete' &&
            message.payload?.id === websocketThoughtId
        ));
        result = await request(`/api/thoughts/${websocketThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE websocket thought should succeed');

        wsMessage = await wsPromise;
        assert(wsMessage.payload.id === websocketThoughtId, 'WebSocket thoughts_update delete should include id');

        assert(!receivedLegacyCollaborationEvent, 'WebSocket should not emit legacy collaboration events');
        wsA.close();
        wsB.close();

        result = await request(`/api/thoughts/${thoughtId}/ai-process`, { method: 'POST' });
        assert(result.response.status === 202, 'POST /api/thoughts/:id/ai-process should return 202');
        assert(result.body.queued === true, 'ai-process should report queued');

        result = await request(`/api/thoughts/${thoughtId}/ai-insight`, { method: 'POST' });
        assert(result.response.status === 503, 'POST /api/thoughts/:id/ai-insight should require a dedicated model');
        assert(
            result.body.error.includes('AI insight model is not configured'),
            'ai-insight should explain that the dedicated insight model is missing'
        );

        result = await request('/api/thoughts/ai-backfill', {
            method: 'POST',
            body: JSON.stringify({ limit: 5 })
        });
        assert(result.response.status === 202, 'POST /api/thoughts/ai-backfill should return 202');
        assert(Number.isFinite(result.body.queued), 'ai-backfill should report queued count');

        result = await request('/api/thoughts/relations-rebuild', {
            method: 'POST',
            body: JSON.stringify({ limit: 5 })
        });
        assert(result.response.status === 202, 'POST /api/thoughts/relations-rebuild should return 202');
        assert(Number.isFinite(result.body.rebuilt), 'relations-rebuild should report rebuilt count');

        result = await request(`/api/thoughts/${thoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'append', text: ' stale', baseVersion: 0 })
        });
        assert(result.response.status === 409, 'stale thought patch should return 409');
        assert(result.body.currentVersion === editedThoughtVersion, 'thought conflict should report current version');

        result = await request(`/api/thoughts/${thoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'add_subitem', text: 'subtask one' })
        });
        assert(result.response.ok, 'PATCH add_subitem should succeed');
        assert(result.body.thought.subItems.length === 1, 'subitem should be added');

        result = await request(`/api/thoughts/${thoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'toggle_complete' })
        });
        assert(result.response.ok, 'PATCH toggle_complete should succeed');
        assert(result.body.thought.completed === true, 'thought should be completed');

        const targetRelationsPath = path.join(dataDir, 'relations', `${targetThoughtId}.json`);
        const targetRelationsBeforeDelete = JSON.parse(fs.readFileSync(targetRelationsPath, 'utf8'));
        targetRelationsBeforeDelete.suggestions = [{
            targetId: thoughtId,
            score: 0.66,
            source: 'ai_suggestion'
        }];
        fs.writeFileSync(targetRelationsPath, JSON.stringify(targetRelationsBeforeDelete, null, 2));

        result = await request(`/api/thoughts/${thoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE /api/thoughts/:id should succeed');
        assert(result.body.trashItem?.type === 'thought', 'DELETE /api/thoughts/:id should return a thought trash item');
        let deletedThoughtTrashId = result.body.trashItem.trashId;
        result = await request(`/api/thoughts/${targetThoughtId}/relations`);
        assert(result.response.ok, 'GET target relations after source delete should succeed');
        assert(
            result.body.relations.every(relation => relation.thought.id !== thoughtId),
            'deleting a thought should remove confirmed relation references from other thoughts'
        );
        assert(
            result.body.suggestions.every(relation => relation.thought.id !== thoughtId),
            'deleting a thought should remove suggested relation references from other thoughts'
        );

        result = await request(`/api/trash/${deletedThoughtTrashId}/restore`, { method: 'POST', body: JSON.stringify({}) });
        assert(result.response.ok, 'POST /api/trash/:id/restore should restore related thought');
        const restoredRelatedThoughtId = result.body.restored.item.id;
        result = await request(`/api/thoughts/${restoredRelatedThoughtId}/relations`);
        assert(result.response.ok, 'GET restored thought relations should succeed');
        assert(
            result.body.relations.some(relation => relation.thought.id === targetThoughtId),
            'trash restore should restore the thought relation payload'
        );
        result = await request(`/api/thoughts/${targetThoughtId}/relations`);
        assert(result.response.ok, 'GET target relations after trash restore should succeed');
        assert(
            result.body.relations.some(relation => relation.thought.id === restoredRelatedThoughtId),
            'trash restore should restore reverse relation references'
        );

        result = await request(`/api/thoughts/${restoredRelatedThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE restored related thought should succeed');
        deletedThoughtTrashId = result.body.trashItem?.trashId;
        assert(deletedThoughtTrashId, 're-deleting restored related thought should create a new trash item');

        result = await request(`/api/thoughts/${targetThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE relation target thought should succeed');

        result = await request(`/api/thoughts/${completedThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE completed thought should succeed');
        const completedThoughtTrashId = result.body.trashItem?.trashId;
        assert(completedThoughtTrashId, 'DELETE completed thought should create a trash item');

        result = await request('/api/trash');
        assert(result.response.ok, 'GET /api/trash should succeed');
        assert(
            result.body.items.some(item => item.trashId === deletedThoughtTrashId && item.type === 'thought'),
            'trash list should include deleted thought'
        );

        result = await request(`/api/trash/${completedThoughtTrashId}/restore`, { method: 'POST', body: JSON.stringify({}) });
        assert(result.response.ok, 'POST /api/trash/:id/restore should restore thought');
        assert(result.body.restored.type === 'thought', 'trash restore should identify restored thought type');
        result = await request(`/api/thoughts/${result.body.restored.item.id}`);
        assert(result.response.ok, 'restored thought should be readable');

        result = await request(`/api/notepads/${notepadId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE /api/notepads/:id should succeed');
        assert(result.body.trashItem?.type === 'notepad', 'DELETE /api/notepads/:id should return a notepad trash item');
        const notepadTrashId = result.body.trashItem.trashId;

        result = await request('/api/trash');
        assert(result.response.ok, 'GET /api/trash after notepad delete should succeed');
        assert(
            result.body.items.some(item => item.trashId === notepadTrashId && item.type === 'notepad'),
            'trash list should include deleted notepad'
        );
        result = await request(`/api/trash/${notepadTrashId}/restore`, { method: 'POST', body: JSON.stringify({}) });
        assert(result.response.ok, 'POST /api/trash/:id/restore should restore notepad');
        const restoredNotepadId = result.body.restored.item.id;
        result = await request(`/api/notes/${restoredNotepadId}`);
        assert(result.response.ok, 'restored notepad content should be readable');
        assert(result.body.content === 'hello world', 'restored notepad should keep original content');

        result = await request(`/api/trash/${deletedThoughtTrashId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE /api/trash/:id should permanently remove trash item');

        console.log('API regression checks passed');
    } catch (error) {
        console.error(logs.join(''));
        throw error;
    } finally {
        child.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
