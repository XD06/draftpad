const HASH_BY_WORKSPACE = Object.freeze({
    editor: '#editor',
    thoughts: '#thoughts',
    today: '#today'
});
const LAST_WORKSPACE_KEY = 'dumbpad_last_workspace_v1';
const WORKSPACES = new Set(Object.keys(HASH_BY_WORKSPACE));

function isWorkspace(value) {
    return WORKSPACES.has(value);
}

function workspaceFromHash(hash = '', fallback = 'editor') {
    if (hash === HASH_BY_WORKSPACE.editor) return 'editor';
    if (hash === HASH_BY_WORKSPACE.thoughts) return 'thoughts';
    if (hash === HASH_BY_WORKSPACE.today) return 'today';
    return isWorkspace(fallback) ? fallback : 'editor';
}

export function readLastWorkspace(storage) {
    try {
        const workspace = storage?.getItem(LAST_WORKSPACE_KEY);
        return isWorkspace(workspace) ? workspace : 'editor';
    } catch (_error) {
        return 'editor';
    }
}

export function persistLastWorkspace(storage, workspace) {
    if (!isWorkspace(workspace)) return false;
    try {
        storage?.setItem(LAST_WORKSPACE_KEY, workspace);
        return true;
    } catch (_error) {
        return false;
    }
}

export function resolveWorkspace({ hash = '', search = '', storage } = {}) {
    if (hash === HASH_BY_WORKSPACE.editor || hash === HASH_BY_WORKSPACE.thoughts || hash === HASH_BY_WORKSPACE.today) {
        return workspaceFromHash(hash);
    }
    if (new URLSearchParams(search).has('id')) return 'editor';
    return readLastWorkspace(storage);
}

/**
 * Coordinates which top-level workspace owns the app shell. Feature managers
 * render only inside their own view and never compete over `main` visibility.
 */
export class WorkspaceRouter {
    constructor({ editorView, thoughtsView, todayView, floatingActions, ensureThoughts, ensureToday, openEditorView, storage = globalThis.localStorage }) {
        this.editorView = editorView;
        this.thoughtsView = thoughtsView;
        this.todayView = todayView;
        this.floatingActions = floatingActions;
        this.ensureThoughts = ensureThoughts;
        this.ensureToday = ensureToday;
        this.openEditorView = openEditorView;
        this.storage = storage;
        this.thoughtsToggle = document.getElementById('toggle-thoughts');
        this.todayToggle = document.getElementById('toggle-today-drafts');
        this.activeWorkspace = null;
        this._routeSequence = 0;
        this._onHashChange = () => this.syncFromLocation();
    }

    init() {
        this.thoughtsToggle?.addEventListener('click', () => {
            this.navigate(this.activeWorkspace === 'thoughts' ? 'editor' : 'thoughts');
        });
        this.todayToggle?.addEventListener('click', () => {
            this.navigate(this.activeWorkspace === 'today' ? 'editor' : 'today');
        });
        window.addEventListener('hashchange', this._onHashChange);
        return this.syncFromLocation();
    }

    getWorkspaceFromLocation() {
        return resolveWorkspace({
            hash: window.location.hash,
            search: window.location.search,
            storage: this.storage
        });
    }

    navigate(workspace) {
        const hash = HASH_BY_WORKSPACE[workspace] ?? HASH_BY_WORKSPACE.editor;
        if (window.location.hash === hash) return this.syncFromLocation({ force: true });
        window.location.hash = hash;
        return this.syncFromLocation({ force: true });
    }

    async syncFromLocation({ force = false } = {}) {
        const workspace = this.getWorkspaceFromLocation();
        if (!force && workspace === this.activeWorkspace) return;

        const token = ++this._routeSequence;
        const previousWorkspace = this.activeWorkspace;
        this.activeWorkspace = workspace;
        persistLastWorkspace(this.storage, workspace);
        this.applyShellState(workspace);

        if (previousWorkspace === 'thoughts' && workspace !== 'thoughts') {
            const manager = await this.ensureThoughts();
            if (token !== this._routeSequence) return;
            await manager.deactivate?.();
        }
        if (previousWorkspace === 'today' && workspace !== 'today') {
            const manager = await this.ensureToday();
            if (token !== this._routeSequence) return;
            manager.deactivate?.();
        }

        if (workspace === 'editor') {
            await this.openEditorView?.();
            return;
        }
        if (workspace === 'thoughts') {
            const manager = await this.ensureThoughts();
            if (token !== this._routeSequence) return;
            await manager.activate?.();
            return;
        }

        const manager = await this.ensureToday();
        if (token !== this._routeSequence) return;
        manager.activate?.();
    }

    applyShellState(workspace) {
        const isEditor = workspace === 'editor';
        const isThoughts = workspace === 'thoughts';
        const isToday = workspace === 'today';

        document.body.classList.toggle('thoughts-mode', isThoughts);
        document.body.classList.toggle('today-drafts-mode', isToday);
        if (this.editorView) this.editorView.style.display = isEditor ? 'flex' : 'none';
        if (this.thoughtsView) this.thoughtsView.style.display = isThoughts ? 'flex' : 'none';
        // Let the responsive stylesheet choose block on mobile and flex on desktop.
        if (this.todayView) this.todayView.style.display = isToday ? '' : 'none';
        if (this.floatingActions) this.floatingActions.style.display = isEditor ? 'flex' : 'none';
        document.documentElement.removeAttribute('data-initial-workspace');
    }
}

export { workspaceFromHash };
