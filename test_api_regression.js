const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = __dirname;
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
}

function assertThoughtsFrontendRegressions() {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const thoughtsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const thoughtRoutesSource = fs.readFileSync(path.join(ROOT, 'routes', 'thought-routes.js'), 'utf8');
    const thoughtAIStatusSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-ai-status.js'), 'utf8');
    const thoughtCardRendererSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-card-renderer.js'), 'utf8');
    const thoughtRelationsPanelSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-relations-panel.js'), 'utf8');
    const thoughtApiClientSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-api-client.js'), 'utf8');
    const thoughtOutboxSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-outbox.js'), 'utf8');
    const hybridEditorSource = fs.readFileSync(path.join(ROOT, 'public', 'hybrid-editor.js'), 'utf8');
    const thoughtsCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'thoughts.css'), 'utf8');
    const iosThemeCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'ios-theme.css'), 'utf8');
    const indexSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert(
        !thoughtsSource.includes('statusEl.outerHTML = this.renderAIStatus'),
        'AI status relation update should not replace the button without rebinding click events'
    );
    assert(
        thoughtAIStatusSource.includes('待评估'),
        'AI detail counts should use user-facing 待评估 wording instead of 候选'
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
        thoughtsSource.includes('enqueueThoughtOverwrite(thought)') &&
        thoughtOutboxSource.includes("kind: 'relation'") &&
        thoughtOutboxSource.includes("kind: 'create'"),
        'thought create, overwrite, and relation operations should be covered by the outbox'
    );
    assert(
        thoughtsSource.includes("e.key === 'Enter' && (e.ctrlKey || e.metaKey)") &&
        !thoughtsSource.includes("e.key === 'Enter' && !e.shiftKey") &&
        thoughtsSource.includes('const tempThought = createLocalPendingThought') &&
        thoughtsSource.includes('this.thoughts.unshift(tempThought)') &&
        thoughtsSource.indexOf('this.closeQuickAdd();') < thoughtsSource.indexOf('await this.apiClient.create'),
        'Quick Add should support multiline input and optimistically insert local pending thoughts before network completion'
    );
    assert(
        thoughtsSource.includes('this.exitEditMode(card);') &&
        thoughtsSource.includes('this.apiClient.overwrite(thought.id, thought)') &&
        !thoughtsSource.includes('await this.apiClient.overwrite(thought.id, thought);'),
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
        thoughtsSource.includes('queueManualRelationSearch') &&
        thoughtsSource.includes('manualRelationSearchSeq') &&
        thoughtsSource.includes('limit: 8, light: true') &&
        thoughtRelationsPanelSource.includes('summaryHtml = highlightPlainText') &&
        thoughtRelationsPanelSource.includes('textSnippetAroundQuery'),
        'manual relation search should be debounced, lightweight, stale-safe, and keyword-highlighted'
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
        thoughtRoutesSource.includes('return res.json(thoughts.map(thought => ({'),
        'thought routes should expose a lightweight search response that skips meta and relation-count reads'
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
    const thoughtFadeInStart = thoughtsCss.indexOf('@keyframes thoughtFadeIn');
    const thoughtFadeInEnd = thoughtFadeInStart >= 0 ? thoughtsCss.indexOf('}', thoughtsCss.indexOf('to {', thoughtFadeInStart)) : -1;
    const thoughtFadeInSource = thoughtFadeInStart >= 0 && thoughtFadeInEnd > thoughtFadeInStart
        ? thoughtsCss.slice(thoughtFadeInStart, thoughtFadeInEnd)
        : '';
    assert(
        thoughtFadeInSource &&
        !thoughtFadeInSource.includes('transform:'),
        'Thought view fade-in should not transform the view container because fixed FAB children drift with transformed ancestors'
    );
    assert(
        hybridEditorSource.includes("target.closest('.vditor-copy, .code-lang-copy-button')") &&
        hybridEditorSource.indexOf("target.closest('.vditor-copy, .code-lang-copy-button')") <
            hybridEditorSource.indexOf("target.closest('.vditor-reset')"),
        'reading mode click guard should allow code block copy buttons before blocking editor clicks'
    );
    const initializeStart = appSource.indexOf('const initializeApp = async () =>');
    const initializeSource = initializeStart >= 0 ? appSource.slice(initializeStart) : '';
    assert(
        thoughtsSource.includes("const THOUGHTS_CACHE_KEY = 'dumbpad_thoughts_cache_v1'") &&
        thoughtsSource.includes('loadThoughtsCache()') &&
        thoughtsSource.includes('saveThoughtsCache(thoughts)') &&
        initializeSource.includes('scheduleIdleTask(() =>') &&
        initializeSource.indexOf('scheduleIdleTask(() =>') < initializeSource.indexOf('await loadNotepads()'),
        'Thoughts view should load its module early and render cached thoughts before the network refresh'
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
        websocketSource.includes('function broadcastUpdate(notepadId, content, senderId = \'api\', version = undefined)') &&
        websocketSource.includes('version') &&
        appSource.includes('const remoteVersion = Number(detail.version)') &&
        appSource.includes('setCurrentNoteVersion(currentNotepadId, remoteVersion)') &&
        appSource.includes('cacheSyncedNote(currentNotepadId, detail.content || \'\', { version: remoteVersion })'),
        'remote note updates should carry and apply the saved version to avoid false 409 conflicts across devices'
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

        let result = await request('/api/notepads');
        assert(result.response.ok, 'GET /api/notepads should succeed');
        assert(Array.isArray(result.body.notepads_list), 'notepads_list should be an array');

        result = await request('/api/notepads', {
            method: 'POST',
            body: JSON.stringify({ name: 'API Regression Note', content: 'hello' })
        });
        assert(result.response.ok, 'POST /api/notepads should succeed');
        const notepadId = result.body.id;
        assert(notepadId, 'created notepad should have an id');

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

        result = await request(`/api/notepads/${notepadId}`, {
            method: 'PUT',
            body: JSON.stringify({ name: 'API Regression Note Renamed' })
        });
        assert(result.response.ok, 'PUT /api/notepads/:id should succeed');
        assert(result.body.name === 'API Regression Note Renamed', 'renamed notepad should return the new name');

        result = await request(`/api/notes/${notepadId}`);
        assert(result.response.ok, 'GET /api/notes/:id after rename should succeed');
        assert(result.body.content === 'hello world', 'renamed note should keep content');

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

        result = await request(`/api/thoughts/${completedThoughtId}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'overwrite', text: 'API completed thought updated', completed: false })
        });
        assert(result.response.ok, 'PATCH overwrite completed thought should succeed');
        assert(result.body.thought.completed === false, 'PATCH overwrite should preserve completed state for local outbox replay');

        const generatedMeta = await waitForJSONFile(
            path.join(dataDir, 'thoughts.meta', `${thoughtId}.json`),
            meta => meta?.status === 'ready',
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
        assert(result.body.thought.aiStatus === 'ready', 'PATCH ready thought should keep current AI status instead of stale pending');
        assert(Number.isFinite(result.body.thought.relationCount), 'PATCH ready thought should include current relation count');
        let editedThoughtVersion = result.body.thought.version;

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

        result = await request(`/api/thoughts/${targetThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE relation target thought should succeed');

        result = await request(`/api/thoughts/${completedThoughtId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE completed thought should succeed');

        result = await request(`/api/notepads/${notepadId}`, { method: 'DELETE' });
        assert(result.response.ok, 'DELETE /api/notepads/:id should succeed');

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
