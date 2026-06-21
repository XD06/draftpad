import { WSClient } from './managers/ws-client.js';
import { ToastManager } from './managers/toaster.js';
import StorageManager from './managers/storage.js';
import SettingsManager from './managers/settings.js'
import ConfirmationManager from './managers/confirmation.js';
import NoteSyncController from './managers/note-sync-controller.js';
import SettingsDataPanel from './managers/settings-data-panel.js';
import { renderSidebar, renderRecentFiles, trackRecentFile, updateSidebarSelection } from './sidebar.js';

document.addEventListener('DOMContentLoaded', async () => {
    const DEBUG = false;
    const THEME_KEY = 'dumbpad_theme';
    let appSettings = {};
    let isApplyingRemoteUpdate = false;
    let hasUnsavedChanges = false;
    let editorInstance = null;
    let editorLoader = null;
    let pendingEditorValue = '';

    const editor = {
        get value() { return editorInstance ? editorInstance.getValue() : pendingEditorValue; },
        set value(val) {
            pendingEditorValue = val || '';
            if (editorInstance) editorInstance.setValue(pendingEditorValue, false);
        },
        focus: () => editorInstance?.focus(),
        get selectionStart() { return editorInstance?.selectionStart || 0; },
        get selectionEnd() { return editorInstance?.selectionEnd || 0; },
        setSelectionRange: (start, end) => editorInstance?.setSelectionRange(start, end),
        addEventListener: (...args) => editorInstance?.addEventListener(...args),
        removeEventListener: (...args) => editorInstance?.removeEventListener(...args),
        setReadingMode: (enabled) => editorInstance?.setReadingMode(enabled),
        get isReadingMode() { return editorInstance?.isReadingMode || false; }
    };

    const themeToggle = document.getElementById('theme-toggle');
    const copyAllBtn = document.getElementById('copy-all');
    const scrollBtn = document.getElementById('scroll-helper');
    const floatingActions = document.querySelector('.floating-actions');
    const toaster = new ToastManager(document.getElementById('toast-container'));
    window.toaster = toaster;
    const copyLinkBtn = document.getElementById('copy-link');
    const newNotepadBtn = document.getElementById('new-notepad');
    const renameNotepadBtn = document.getElementById('rename-notepad');
    const downloadNotepadBtn = document.getElementById('download-notepad');
    const printNotepadBtn = document.getElementById('print-notepad');
    const previewMarkdownBtn = document.getElementById('preview-markdown');
    const deleteNotepadBtn = document.getElementById('delete-notepad');
    const newNotepadSidebarBtn = document.getElementById('new-notepad-sidebar');
    const newNotepadHeaderBtn = document.getElementById('new-notepad-header');
    const downloadNotepadHeaderBtn = document.getElementById('download-notepad-header');
    const printNotepadHeaderBtn = document.getElementById('print-notepad-header');
    const renameModal = document.getElementById('rename-modal');
    const deleteModal = document.getElementById('delete-modal');
    const renameInput = document.getElementById('rename-input');
    const renameCancel = document.getElementById('rename-cancel');
    const renameConfirm = document.getElementById('rename-confirm');
    const deleteCancel = document.getElementById('delete-cancel');
    const deleteConfirm = document.getElementById('delete-confirm');
    const tooltips = document.querySelectorAll('[data-tooltip]');
    const downloadModal = document.getElementById('download-modal');
    const downloadTxt = document.getElementById('download-txt');
    const downloadMd = document.getElementById('download-md');
    const downloadCancel = document.getElementById('download-cancel');
    const settingsButton = document.getElementById('settings-button');
    const settingsModal = document.getElementById('settings-modal');
    const settingsCancel = document.getElementById('settings-cancel');
    const settingsSave = document.getElementById('settings-save');
    const settingsReset = document.getElementById('settings-reset');
    const settingsInputAutoSaveStatusInterval = document.getElementById('autosave-status-interval-input');
    const settingsConflictSection = document.getElementById('settings-conflict-section');
    const settingsSyncSummary = document.getElementById('settings-sync-summary');
    const settingsConflictMessage = document.getElementById('settings-conflict-message');
    const settingsConflictContent = document.getElementById('settings-conflict-content');
    const settingsLocalVersion = document.getElementById('settings-local-version');
    const settingsServerVersion = document.getElementById('settings-server-version');
    const settingsCacheTime = document.getElementById('settings-cache-time');
    const settingsDirtyNotes = document.getElementById('settings-dirty-notes');
    const settingsRetryLocalSync = document.getElementById('settings-retry-local-sync');
    const settingsCopyLocalContent = document.getElementById('settings-copy-local-content');
    const settingsDiscardLocalContent = document.getElementById('settings-discard-local-content');
    const settingsDataCloudSubtitle = document.getElementById('settings-data-cloud-subtitle');
    const settingsCloudStatus = document.getElementById('settings-cloud-status');
    const settingsSpaceList = document.getElementById('settings-space-list');
    const settingsSourceDataDir = document.getElementById('settings-source-data-dir');
    const settingsTargetPrefix = document.getElementById('settings-target-prefix');
    const settingsBackupPrefix = document.getElementById('settings-backup-prefix');
    const settingsConfirmPrefix = document.getElementById('settings-confirm-prefix');
    const settingsCloudResult = document.getElementById('settings-cloud-result');
    const settingsCloudRefresh = document.getElementById('settings-cloud-refresh');
    const settingsCloudInventory = document.getElementById('settings-cloud-inventory');
    const settingsImportDryRun = document.getElementById('settings-import-dry-run');
    const settingsImportRun = document.getElementById('settings-import-run');
    const settingsBackupDryRun = document.getElementById('settings-backup-dry-run');
    const settingsBackupRun = document.getElementById('settings-backup-run');
    const settingsDeleteDryRun = document.getElementById('settings-delete-dry-run');
    const settingsDeleteRun = document.getElementById('settings-delete-run');
    const settingsLocalOverwriteCloudDryRun = document.getElementById('settings-local-overwrite-cloud-dry-run');
    const settingsLocalOverwriteCloud = document.getElementById('settings-local-overwrite-cloud');
    const settingsCloudOverwriteLocalDryRun = document.getElementById('settings-cloud-overwrite-local-dry-run');
    const settingsCloudOverwriteLocal = document.getElementById('settings-cloud-overwrite-local');
    const settingsAutoSyncStatus = document.getElementById('settings-auto-sync-status');
    const settingsTrashRefresh = document.getElementById('settings-trash-refresh');
    const settingsTrashList = document.getElementById('settings-trash-list');
    const settingsTrashEmpty = document.getElementById('settings-trash-empty');
    const startupSyncStatus = document.getElementById('startup-sync-status');

    let saveTimeout;
    let saveRetryTimeout;
    const saveNotesInFlight = new Map();
    const pendingNoteSaveIds = new Set();
    let noteConflictToastEl = null;
    let lastSaveTime = Date.now();
    const SAVE_INTERVAL = 2000;
    let currentNotepadId = 'default';
    let currentNoteVersion = null;
    let currentNotepads = []; 
    let isInitialLoad = true;
    let notepadIdToDelete = null;
    let notepadIdToRename = null;
    let _siteTitle = 'DumbPad';
    let isReadingMode = false;
    let startupSyncSnapshot = {
        state: 'idle',
        label: '同步状态',
        kind: 'idle'
    };

    function createSaveId() {
        const randomPart = window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
        return `${userId}-${Date.now()}-${randomPart}`;
    }

    function createClientNotepadId() {
        const uuid = window.crypto?.randomUUID?.();
        const randomPart = uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10);
        return `note-${Date.now()}-${randomPart}`;
    }

    function noteContentMatches(detail, localContent) {
        if (typeof detail.content === 'string') return detail.content === localContent;
        return false;
    }

    function setHeaderTitle(text) {
        const h1 = document.getElementById('header-title')?.querySelector('h1');
        if (h1) { h1.textContent = text; h1.title = text; }
    }

    function applyReadingModeTitle() {
        const name = getCurrentNotepadName();
        setHeaderTitle(name);
    }

    function setStartupSyncStatus(state = 'idle', text = '') {
        if (!startupSyncStatus) return;
        const label = text || '同步状态';
        const kind = getStartupSyncKind(state, label);
        startupSyncSnapshot = { state, label, kind };
        startupSyncStatus.dataset.state = state;
        startupSyncStatus.dataset.kind = kind;
        startupSyncStatus.title = label;
        startupSyncStatus.setAttribute('aria-label', label);
        startupSyncStatus.setAttribute('role', 'button');
        startupSyncStatus.setAttribute('tabindex', state === 'idle' ? '-1' : '0');
        startupSyncStatus.innerHTML = `
            <span class="sync-status-icon" aria-hidden="true">${getStartupSyncIcon(kind)}</span>
            <span class="sync-status-text">${escapeHtml(label)}</span>
        `;
    }

    function getStartupSyncKind(state, text = '') {
        if (state === 'synced') return 'synced';
        if (state === 'syncing') return 'syncing';
        if (state === 'error') return 'unsynced';
        if (state === 'cached') {
            return /未同步|本地已保留|保存失败|远端更新/.test(text) ? 'unsynced' : 'cached';
        }
        return 'idle';
    }

    function getStartupSyncIcon(kind) {
        if (kind === 'unsynced') {
            return `
                <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M7.2 17.5H6a4 4 0 0 1-.5-8 6.2 6.2 0 0 1 11.8-1.7A4.8 4.8 0 0 1 18.2 17" />
                    <path d="M15.5 15.5 20 20" />
                    <path d="M20 15.5 15.5 20" />
                </svg>
            `;
        }
        return `
            <svg viewBox="0 0 24 24" focusable="false">
                <path d="M7 18h10.5a4.5 4.5 0 0 0 .7-8.95 6.25 6.25 0 0 0-12.15 1.4A3.85 3.85 0 0 0 7 18Z" />
            </svg>
        `;
    }

    const storageManager = new StorageManager();
    const noteSyncController = new NoteSyncController({ storageManager });
    let settingsDataPanel = null;
    let thoughtsManager = null;
    let thoughtsManagerLoader = null;
    let openCommandSearch = null;
    let markedLoader = null;
    let currentTheme = storageManager.load(THEME_KEY);
    const settingsManager = new SettingsManager(storageManager, applySettings);
    const confirmationManager = new ConfirmationManager();

    function scheduleIdleTask(callback) {
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(callback, { timeout: 2500 });
            return;
        }
        setTimeout(callback, 600);
    }

    function ensureThoughtsManager() {
        if (!thoughtsManagerLoader) {
            thoughtsManagerLoader = import('./managers/thoughts.js')
                .then(({ ThoughtsManager }) => {
                    thoughtsManager = new ThoughtsManager({
                        toaster,
                        confirmationManager,
                        openEditorView: () => openEditorView()
                    });
                    thoughtsManager.app.openSearch = () => openCommandSearch?.();
                    return thoughtsManager;
                })
                .catch((error) => {
                    thoughtsManagerLoader = null;
                    console.warn('Failed to load thoughts manager:', error);
                    toaster.show('Failed to load thoughts', 'error', true);
                    throw error;
                });
        }
        return thoughtsManagerLoader;
    }

    function renderMarkdown(markdown) {
        markedLoader ||= import('/js/marked/marked.esm.js');
        return markedLoader.then(({ marked }) => marked.parse(markdown || ''));
    }
    
    // Stub PreviewManager since Vditor handles rendering
    const previewManager = { 
        getPreviewMode: () => false, 
        updatePreviewIfActive: () => {}, 
        updateHighlightTheme: () => {}, 
        updatePreviewStyles: () => {}, 
        toggleMarkdownPreview: () => {}, 
        clearPreview: () => {}, 
        addEventListeners: () => {},
        addCopyLangButtonsToCodeBlocks: () => {},
        initializeMarkdown: () => Promise.resolve(),
        preparePrintContent: async () => ({ formattedContent: await renderMarkdown(editor.value), mainStyles: '', previewStyles: '', highlightStyles: '', printStyles: '' })
    };

    // Generate user ID for lightweight multi-tab update filtering.
    const userId = Math.random().toString(36).substring(2, 15);
    window.userId = userId; 
    const wsClient = new WSClient({ debug: DEBUG });
    if (navigator.onLine) wsClient.connect();
    window.addEventListener('online', () => {
        wsClient.connect();
        loadNotepads().then(syncCurrentDirtyNote).catch(err => {
            console.warn('Error syncing after reconnect:', err);
        });
    });
    window.addEventListener('offline', () => wsClient.close());

    window.addEventListener('notes_update', (event) => {
        const detail = event.detail || {};
        if (detail.notepadId !== currentNotepadId) return;
        const remoteVersion = Number(detail.version);
        const isSavedUpdate = Number.isFinite(remoteVersion);
        const isOwnAck = detail.userId === userId || (detail.saveId && pendingNoteSaveIds.has(detail.saveId));
        if (detail.saveId) pendingNoteSaveIds.delete(detail.saveId);
        if (isOwnAck) {
            if (isSavedUpdate) {
                setCurrentNoteVersion(currentNotepadId, remoteVersion);
                if (noteContentMatches(detail, editor.value)) {
                    hasUnsavedChanges = false;
                    cacheSyncedNote(currentNotepadId, editor.value, { version: remoteVersion });
                    dirtyConflictNotepadIds.delete(currentNotepadId);
                    hideNoteConflictToast();
                    setStartupSyncStatus('synced', '已同步');
                }
            }
            return;
        }

        if (!isSavedUpdate) {
            return;
        }

        if (hasUnsavedChanges) {
            if (noteContentMatches(detail, editor.value)) {
                hasUnsavedChanges = false;
                setCurrentNoteVersion(currentNotepadId, remoteVersion);
                cacheSyncedNote(currentNotepadId, editor.value, { version: remoteVersion });
                dirtyConflictNotepadIds.delete(currentNotepadId);
                hideNoteConflictToast();
                setStartupSyncStatus('synced', '已同步');
                return;
            }
            showNoteConflictToast('warning', 5000);
            return;
        }

        isApplyingRemoteUpdate = true;
        editor.value = detail.content || '';
        isApplyingRemoteUpdate = false;
        setCurrentNoteVersion(currentNotepadId, remoteVersion);
        cacheSyncedNote(currentNotepadId, detail.content || '', { version: remoteVersion });
        dirtyConflictNotepadIds.delete(currentNotepadId);
        setStartupSyncStatus('synced', '已同步');
        debouncedUpdateToC();
    });

    window.addEventListener('notepad_change', () => {
        loadNotepads();
    });

    async function fetchWithPin(url, options = {}) {
        options.credentials = 'same-origin';
        try {
            return await fetch(url, options); 
        } catch (error) {
            console.warn(error);
            toaster.show(error?.message || String(error), "error", true);
            throw error;
        }
    }

    async function fetchJSON(url, options = {}) {
        const response = await fetchWithPin(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
        return payload;
    }

    settingsDataPanel = new SettingsDataPanel({ requestJSON: fetchJSON });

    function formatBytes(bytes = 0) {
        const size = Number(bytes) || 0;
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }

    function setCloudBusy(isBusy) {
        [
            settingsCloudRefresh,
            settingsCloudInventory,
            settingsImportDryRun,
            settingsImportRun,
            settingsBackupDryRun,
            settingsBackupRun,
            settingsDeleteDryRun,
            settingsDeleteRun,
            settingsLocalOverwriteCloudDryRun,
            settingsLocalOverwriteCloud,
            settingsCloudOverwriteLocalDryRun,
            settingsCloudOverwriteLocal,
            settingsAutoSyncStatus
        ].forEach(button => {
            if (button) button.disabled = isBusy;
        });
    }

    function setCloudResult(data, label = '') {
        if (!settingsCloudResult) return;
        settingsCloudResult.textContent = label
            ? `${label}\n${JSON.stringify(data, null, 2)}`
            : JSON.stringify(data, null, 2);
    }

    function renderCloudStatus(status) {
        if (!settingsCloudStatus) return;
        const inventory = status.inventory || {};
        const stats = [
            ['当前来源', status.backend === 's3' ? '云端 S3' : '本地 data'],
            ['存储布局', status.layout || '-'],
            ['Bucket', status.s3?.bucket || '-'],
            ['应用根目录', status.s3?.spaceRoot || '-'],
            ['数据空间', status.s3?.prefix || '-'],
            ['对象数量', Number.isFinite(inventory.objectCount) ? inventory.objectCount : '-'],
            ['空间大小', Number.isFinite(inventory.totalBytes) ? formatBytes(inventory.totalBytes) : '-'],
            ['区域', status.s3?.region || '-'],
            ['本地目录', status.dataDir || '-']
        ];
        settingsCloudStatus.innerHTML = stats.map(([label, value]) => `
            <div class="settings-cloud-stat">
                <span>${escapeHtml(label)}</span>
                <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
            </div>
        `).join('');
        if (settingsDataCloudSubtitle) {
            settingsDataCloudSubtitle.textContent = status.backend === 's3'
                ? '当前正在使用 S3 云端数据源。'
                : '当前正在使用本地数据源。';
        }
        if (settingsTargetPrefix && !settingsTargetPrefix.value) {
            settingsTargetPrefix.value = status.s3?.prefix || '';
        }
        if (settingsSourceDataDir && !settingsSourceDataDir.value) {
            settingsSourceDataDir.value = status.dataDir || '';
        }
        if (settingsBackupPrefix && !settingsBackupPrefix.value) {
            const prefix = status.s3?.prefix || 'dumbpad';
            const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            settingsBackupPrefix.value = `${prefix}-backup-${stamp}`;
        }
    }

    function formatSpaceTime(value) {
        if (!value) return '-';
        const timestamp = new Date(value).getTime();
        return formatCacheTime(timestamp);
    }

    function renderSpaceList(data) {
        if (!settingsSpaceList) return;
        const spaces = Array.isArray(data?.spaces) ? data.spaces : [];
        const currentPrefix = data?.currentPrefix || '';
        if (data?.backend !== 's3') {
            settingsSpaceList.innerHTML = '<div class="settings-space-empty">当前使用本地 data，未连接云端数据空间。</div>';
            return;
        }
        if (spaces.length === 0) {
            settingsSpaceList.innerHTML = '<div class="settings-space-empty">当前 bucket 下没有可选择的数据空间。</div>';
            return;
        }

        settingsSpaceList.innerHTML = spaces.map(space => {
            const isActive = space.prefix === currentPrefix;
            const badges = [
                space.hasNotepads ? '文章' : '',
                space.hasThoughts ? 'Thought' : '',
                space.hasRelations ? '关联' : ''
            ].filter(Boolean);
            return `
                <button class="settings-space-item${isActive ? ' is-active' : ''}" type="button"
                    data-prefix="${escapeHtml(space.prefix)}" ${isActive ? 'disabled' : ''}>
                    <span class="settings-space-name">${escapeHtml(space.name || space.prefix)}</span>
                    <span class="settings-space-path">${escapeHtml(space.prefix)}</span>
                    <span class="settings-space-meta">
                        ${Number.isFinite(space.objectCount) ? `${space.objectCount} 对象` : '-'}
                        · ${Number.isFinite(space.totalBytes) ? formatBytes(space.totalBytes) : '-'}
                        · ${formatSpaceTime(space.lastModified)}
                    </span>
                    <span class="settings-space-badges">
                        ${badges.map(badge => `<span>${escapeHtml(badge)}</span>`).join('')}
                        ${space.layout === 'nested' ? '<span>新结构</span>' : '<span>旧路径</span>'}
                        ${isActive ? '<strong>当前使用</strong>' : '<em>点击切换</em>'}
                    </span>
                </button>
            `;
        }).join('');
    }

    async function refreshSpaceList() {
        if (!settingsSpaceList) return null;
        settingsSpaceList.innerHTML = '<div class="settings-space-empty">正在读取数据空间...</div>';
        const data = await settingsDataPanel.spaces();
        renderSpaceList(data);
        return data;
    }

    async function selectCloudSpace(prefix) {
        if (!prefix) return;
        const confirmed = await confirmationManager.show({
            title: '切换云端数据空间',
            message: `将当前读写位置切换到「${prefix}」。页面会刷新以重新加载该数据空间。`,
            confirmText: '切换并刷新',
            cancelText: '取消',
            confirmType: 'danger'
        });
        if (!confirmed) return;

        setCloudBusy(true);
        try {
            const result = await settingsDataPanel.selectSpace(prefix);
            setCloudResult(result, '数据空间已切换');
            toaster.show('数据空间已切换，正在刷新', 'success', false, 1200);
            setTimeout(() => window.location.reload(), 450);
        } catch (error) {
            toaster.show(error.message || '数据空间切换失败', 'error', false, 4000);
            setCloudResult({ error: error.message }, '切换失败');
        } finally {
            setCloudBusy(false);
        }
    }

    async function refreshCloudStatus(showToast = false) {
        if (!settingsCloudStatus) return;
        setCloudBusy(true);
        try {
            const status = await settingsDataPanel.status();
            renderCloudStatus(status);
            let spaces = null;
            if (status.backend === 's3') {
                spaces = await refreshSpaceList();
            } else {
                renderSpaceList({ backend: status.backend, spaces: [] });
            }
            setCloudResult({
                backend: status.backend,
                layout: status.layout,
                dataDir: status.dataDir,
                s3: status.s3,
                inventory: status.inventory,
                spaces
            }, '当前状态');
            if (showToast) toaster.show('云端状态已刷新', 'success');
        } catch (error) {
            toaster.show(error.message || '云端状态读取失败', 'error', false, 3000);
            setCloudResult({ error: error.message }, '读取失败');
        } finally {
            setCloudBusy(false);
        }
    }

    function cloudPayload({ dryRun = true } = {}) {
        return {
            sourceDataDir: settingsSourceDataDir?.value?.trim() || '',
            prefix: settingsTargetPrefix?.value?.trim() || '',
            backupPrefix: settingsBackupPrefix?.value?.trim() || '',
            confirmPrefix: settingsConfirmPrefix?.value?.trim() || '',
            targetDataDir: settingsSourceDataDir?.value?.trim() || '',
            dryRun
        };
    }

    async function runCloudAction(action) {
        const payload = cloudPayload({ dryRun: !action.endsWith(':run') });
        const isDanger = action.endsWith(':run');
        if (isDanger) {
            const confirmed = await confirmationManager.show({
                title: '确认云端操作',
                message: `即将执行 ${action}。确认 prefix 必须与目标 prefix 完全一致。`,
                confirmText: '继续执行',
                cancelText: '取消',
                confirmType: 'danger'
            });
            if (!confirmed) return;
        }

        setCloudBusy(true);
        try {
            const result = await settingsDataPanel.runAction(action, payload);
            setCloudResult(result, '操作结果');
            toaster.show(payload.dryRun ? '预览完成' : '操作完成', 'success', false, 1800);
            await refreshCloudStatus(false);
        } catch (error) {
            toaster.show(error.message || '云端操作失败', 'error', false, 4000);
            setCloudResult({ error: error.message }, '操作失败');
        } finally {
            setCloudBusy(false);
        }
    }

    function summarizeCloudPreview(action, result) {
        if (action === 'local-overwrite-s3') {
            return [
                `目标 prefix：${result.prefix || '-'}`,
                `云端现有对象：${result.before?.objectCount ?? '-'}`,
                `将上传对象：${result.import?.uploaded ?? '-'}`,
                `备份 prefix：${result.backupPrefix || '-'}`
            ].join('\n');
        }
        if (action === 's3-overwrite-local') {
            return [
                `来源 prefix：${result.prefix || '-'}`,
                `云端对象：${result.inventory?.objectCount ?? '-'}`,
                `本地目录：${result.targetDataDir || '-'}`
            ].join('\n');
        }
        return '预览完成。';
    }

    async function runGuidedCloudAction(action, previewAction) {
        setCloudBusy(true);
        try {
            const previewPayload = cloudPayload({ dryRun: true });
            let preview;
            if (previewAction === 'local-overwrite-s3:dry-run') {
                preview = await settingsDataPanel.localOverwriteS3(previewPayload);
            } else if (previewAction === 's3-overwrite-local:dry-run') {
                preview = await settingsDataPanel.s3OverwriteLocal(previewPayload);
            }
            setCloudResult(preview, '执行前预览');

            const confirmed = await confirmationManager.show({
                title: '确认数据覆盖',
                message: `${summarizeCloudPreview(action.replace(':run', ''), preview)}\n\n确认后继续执行。`,
                confirmText: '确认执行',
                cancelText: '取消',
                confirmType: 'danger'
            });
            if (!confirmed) return;

            const runPayload = {
                ...cloudPayload({ dryRun: false }),
                confirmPrefix: previewPayload.prefix
            };
            const result = action === 'local-overwrite-s3:run'
                ? await settingsDataPanel.localOverwriteS3(runPayload)
                : await settingsDataPanel.s3OverwriteLocal(runPayload);
            setCloudResult(result, '操作结果');
            toaster.show('操作完成', 'success', false, 1800);
            await refreshCloudStatus(false);
        } catch (error) {
            toaster.show(error.message || '云端操作失败', 'error', false, 4000);
            setCloudResult({ error: error.message }, '操作失败');
        } finally {
            setCloudBusy(false);
        }
    }

    async function showAutoSyncStatus() {
        await refreshCloudStatus(false);
        setCloudResult({
            mode: 'auto-sync',
            note: '基础保存、启动缓存、WebSocket 更新和 AI 后台分析由应用自动处理。需要强制覆盖时再使用本地覆盖云端或云端覆盖本地。'
        }, '自动同步');
        toaster.show('自动同步状态已刷新', 'success', false, 1800);
    }

    function compactTrashThoughtTitle(title) {
        const text = String(title || '').replace(/\s+/g, ' ').trim();
        if (!text) return '未命名';
        const limit = 16;
        return text.length > limit ? `${text.slice(0, limit)}...` : text;
    }

    function renderTrashItems(items = []) {
        if (!settingsTrashList) return;
        if (!Array.isArray(items) || items.length === 0) {
            settingsTrashList.innerHTML = '<div class="settings-trash-empty">垃圾桶为空。</div>';
            if (settingsTrashEmpty) settingsTrashEmpty.disabled = true;
            return;
        }
        if (settingsTrashEmpty) settingsTrashEmpty.disabled = false;
        settingsTrashList.innerHTML = items.map(item => {
            const typeLabel = item.type === 'thought' ? 'Thought' : '文章';
            const displayTitle = item.type === 'thought' ? compactTrashThoughtTitle(item.title) : item.title || 'Untitled';
            const deletedAt = item.deletedAt ? formatCacheTime(item.deletedAt) : '-';
            return `
                <div class="settings-trash-item" data-trash-id="${escapeHtml(item.trashId)}">
                    <div class="settings-trash-main">
                        <div class="settings-trash-title">${escapeHtml(displayTitle)}</div>
                        <div class="settings-trash-meta">${typeLabel} · 删除于 ${escapeHtml(deletedAt)}</div>
                    </div>
                    <div class="settings-trash-actions">
                        <button type="button" data-trash-action="restore">恢复</button>
                        <button type="button" class="danger" data-trash-action="delete">永久删除</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    async function refreshTrashList(showToast = false) {
        if (!settingsDataPanel || !settingsTrashList) return;
        settingsTrashList.innerHTML = '<div class="settings-trash-empty">正在读取垃圾桶...</div>';
        try {
            const data = await settingsDataPanel.trashList();
            renderTrashItems(data.items || []);
            if (showToast) toaster.show('垃圾桶已刷新', 'success', false, 1400);
        } catch (error) {
            settingsTrashList.innerHTML = `<div class="settings-trash-empty">读取失败：${escapeHtml(error.message || '未知错误')}</div>`;
            toaster.show(error.message || '垃圾桶读取失败', 'error', false, 2600);
        }
    }

    async function restoreTrashItem(trashId) {
        const confirmed = await confirmationManager.show({
            title: '恢复项目',
            message: '恢复后会重新写入当前数据空间，并从垃圾桶移除。',
            confirmText: '恢复',
            cancelText: '取消'
        });
        if (!confirmed) return;
        const result = await settingsDataPanel.restoreTrashItem(trashId);
        await refreshTrashList(false);
        if (result.restored?.type === 'notepad') {
            await loadNotepads();
        } else if (thoughtsManager?.isActive) {
            await thoughtsManager.fetchThoughts();
        }
        toaster.show('已恢复', 'success', false, 1600);
    }

    async function deleteTrashItemPermanently(trashId) {
        const confirmed = await confirmationManager.show({
            title: '永久删除',
            message: '此操作会从垃圾桶中移除备份，无法再恢复。',
            confirmText: '永久删除',
            cancelText: '取消',
            confirmType: 'danger'
        });
        if (!confirmed) return;
        await settingsDataPanel.deleteTrashItem(trashId);
        await refreshTrashList(false);
        toaster.show('已永久删除', 'success', false, 1600);
    }

    async function emptyTrash() {
        const confirmed = await confirmationManager.show({
            title: '清空垃圾桶',
            message: '垃圾桶中的文章和 Thought 备份都会被永久删除。',
            confirmText: '清空',
            cancelText: '取消',
            confirmType: 'danger'
        });
        if (!confirmed) return;
        await settingsDataPanel.emptyTrash();
        await refreshTrashList(false);
        toaster.show('垃圾桶已清空', 'success', false, 1600);
    }

    async function copyCurrentNotepadLink() {
        try {
            const response = await fetchWithPin(`/api/share/${currentNotepadId}`);
            if (!response.ok) throw new Error('Failed to generate share link');
            const data = await response.json();
            await navigator.clipboard.writeText(data.shareUrl);
            toaster.show('Secure share link copied!', 'success');
        } catch (err) {
            console.error(err);
            toaster.show('Failed to copy share link', 'error');
        }
    }

    function updateUrlWithNotepad(notepadName) {
        if (!notepadName) return;
        const url = new URL(window.location);
        url.searchParams.set('id', notepadName);
        window.history.pushState({ notepadName }, '', url.toString());
    }

    function isValidNotepadId(id) {
        return typeof id === 'string' && id.trim() !== '' && id !== 'undefined' && id !== 'null';
    }

    function findNotepadByIdOrName(notepadsList, value) {
        if (!isValidNotepadId(value) || !Array.isArray(notepadsList)) return null;
        const normalizedValue = value.toLowerCase();
        return notepadsList.find(n => (
            isValidNotepadId(n?.id) &&
            (n.id === value || String(n.name || '').toLowerCase() === normalizedValue)
        )) || null;
    }

    function getFallbackNotepadId(notepadsList) {
        if (!Array.isArray(notepadsList)) return 'default';
        return notepadsList.find(n => isValidNotepadId(n?.id))?.id || 'default';
    }

    function loadStartupCache() {
        const cache = noteSyncController.loadStartupCache();
        if (!cache) return null;
        return {
            ...cache,
            notepads: cache.notepads.filter(notepad => isValidNotepadId(notepad?.id))
        };
    }

    function saveStartupCache(patch = {}) {
        return noteSyncController.saveStartupCache(patch);
    }

    function cacheNotepads(noteHistory, selectedId = currentNotepadId) {
        if (!Array.isArray(currentNotepads) || currentNotepads.length === 0) return;
        noteSyncController.cacheNotepads({
            currentNotepadId: selectedId,
            noteHistory: isValidNotepadId(noteHistory) ? noteHistory : selectedId,
            notepads: currentNotepads
        });
    }

    function cacheNote(notepadId, content, options = {}) {
        if (!isValidNotepadId(notepadId)) return;
        noteSyncController.cacheNote(notepadId, content, options, { notepads: currentNotepads });
    }

    function cacheDirtyNote(notepadId, content, options = {}) {
        if (!isValidNotepadId(notepadId)) return;
        noteSyncController.cacheDirtyNote(notepadId, content, {
            ...options,
            notepads: currentNotepads
        });
    }

    function cacheSyncedNote(notepadId, content, options = {}) {
        if (!isValidNotepadId(notepadId)) return;
        noteSyncController.cacheSyncedNote(notepadId, content, {
            ...options,
            notepads: currentNotepads
        });
    }

    function cacheConflictNote(notepadId, content, options = {}) {
        if (!isValidNotepadId(notepadId)) return;
        noteSyncController.cacheConflictNote(notepadId, content, {
            ...options,
            notepads: currentNotepads
        });
    }

    function renderNotepadLists(selectedId = currentNotepadId, noteHistory = selectedId) {
        renderSidebar(currentNotepads, selectedId, selectNotepad, deleteNotepadById, renameNotepadById);
        renderRecentFiles(selectedId, currentNotepads, selectNotepad, deleteNotepadById, renameNotepadById);
        cacheNotepads(noteHistory, selectedId);
    }

    function getCachedNote(notepadId) {
        if (!isValidNotepadId(notepadId)) return null;
        return noteSyncController.getCachedNote(notepadId);
    }

    function getDirtyCachedNotes() {
        return noteSyncController.getDirtyCachedNotes({
            currentNotepads,
            conflictIds: dirtyConflictNotepadIds
        }).filter(note => isValidNotepadId(note.id));
    }

    function renderCachedNotepad(notepadId, content) {
        if (!findNotepadByIdOrName(currentNotepads, notepadId)) return false;
        currentNotepadId = notepadId;
        isApplyingRemoteUpdate = true;
        if (editor.value !== (content || '')) editor.value = content || '';
        isApplyingRemoteUpdate = false;
        hasUnsavedChanges = false;
        const cachedNote = loadStartupCache()?.notes?.[notepadId];
        const noteIsDirty = !!cachedNote?.dirty;
        setCurrentNoteVersion(notepadId, cachedNote?.version);
        setStartupSyncStatus('cached', noteIsDirty ? '本地未同步' : '本地快照');

        const emptyState = document.getElementById('empty-state');
        const hybridEditor = document.getElementById('hybrid-editor');
        if (emptyState) emptyState.style.display = 'none';
        if (hybridEditor) hybridEditor.style.display = 'block';

        updateSidebarSelection(notepadId);
        renderRecentFiles(notepadId, currentNotepads, selectNotepad, deleteNotepadById, renameNotepadById);
        const name = getCurrentNotepadName();
        updateUrlWithNotepad(name);
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) pageTitle.textContent = `${name} - DumbPad`;
        return true;
    }

    async function fetchNoteData(notepadId) {
        const response = await fetchWithPin('/api/notes/' + encodeURIComponent(notepadId));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    let notePrefetchRun = 0;
    async function prefetchNotepadNotes(preferredIds = []) {
        const runId = ++notePrefetchRun;
        const cached = loadStartupCache()?.notes || {};
        const preferred = preferredIds.filter(Boolean);
        const ids = [
            ...preferred,
            ...currentNotepads.map(note => note.id).filter(Boolean)
        ].filter((id, index, list) => (
            id !== currentNotepadId &&
            list.indexOf(id) === index &&
            !cached[id]?.dirty &&
            !cached[id]?.content
        ));
        const concurrency = 2;
        let cursor = 0;
        const worker = async () => {
            while (cursor < ids.length && runId === notePrefetchRun) {
                const id = ids[cursor++];
                try {
                    const data = await fetchNoteData(id);
                    const existing = getCachedNote(id);
                    if (!existing?.dirty) {
                        cacheSyncedNote(id, data.content || '', { version: data.version });
                    }
                } catch (error) {
                    console.info('[sync] note prefetch skipped notepadId=%s reason=%s', id, error.message);
                }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }

    function hydrateStartupCache() {
        const cache = loadStartupCache();
        if (!cache || cache.notepads.length === 0) return false;

        currentNotepads = cache.notepads;
        renderSidebar(currentNotepads, currentNotepadId, selectNotepad, deleteNotepadById, renameNotepadById);

        const selectedId = handleQueryParameterSelection(currentNotepads, cache.currentNotepadId || cache.noteHistory);
        const note = selectedId ? cache.notes?.[selectedId] : null;
        if (!selectedId || !note) return false;
        return renderCachedNotepad(selectedId, note.content || '');
    }

    function escapeHtml(value = '') {
        return String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]);
    }

    function getCurrentNotepad() {
        return currentNotepads.find(p => p.id === currentNotepadId) || currentNotepads[0] || { id: 'default', name: 'Default Notepad' };
    }

    function getCurrentNotepadName() {
        return getCurrentNotepad().name || 'Untitled';
    }

    function setCurrentNoteVersion(notepadId, version) {
        const nextVersion = Number(version);
        if (!Number.isFinite(nextVersion)) return;
        if (notepadId === currentNotepadId) currentNoteVersion = nextVersion;
        const notepad = currentNotepads.find(n => n.id === notepadId);
        if (notepad) notepad.version = nextVersion;
    }

    function showNoteConflictToast(type = 'error', timeoutMs = 6000) {
        if (noteConflictToastEl?.parentNode) return noteConflictToastEl;
        noteConflictToastEl = toaster.show('内容已在其他设备更新，请刷新后再保存或复制当前内容', type, true, timeoutMs);
        return noteConflictToastEl;
    }

    function hideNoteConflictToast() {
        if (!noteConflictToastEl) return;
        toaster.hide(noteConflictToastEl);
        noteConflictToastEl = null;
    }

    function formatCacheTime(timestamp) {
        const value = Number(timestamp);
        if (!Number.isFinite(value) || value <= 0) return '-';
        try {
            return new Intl.DateTimeFormat('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }).format(new Date(value));
        } catch {
            return new Date(value).toLocaleString();
        }
    }

    function handleQueryParameterSelection(notepadsList, defaultId) {
        if (!Array.isArray(notepadsList) || notepadsList.length === 0) return null;

        if (!isInitialLoad) {
            return findNotepadByIdOrName(notepadsList, currentNotepadId)?.id
                || findNotepadByIdOrName(notepadsList, defaultId)?.id
                || getFallbackNotepadId(notepadsList);
        }

        const id = new URLSearchParams(window.location.search).get('id');
        if (isValidNotepadId(id)) {
            const found = findNotepadByIdOrName(notepadsList, id);
            if (found) return found.id;
            toaster.show(`Notepad '${id}' not found`, 'error');
        }

        return findNotepadByIdOrName(notepadsList, defaultId)?.id || getFallbackNotepadId(notepadsList);
    }

    async function loadNotepads({ loadCurrentNote = true } = {}) {
        try {
            if (!navigator.onLine) {
                setStartupSyncStatus('error', '服务器不可用，本地可读');
                return;
            }
            setStartupSyncStatus('syncing', '同步中');
            const response = await fetchWithPin('/api/notepads');
            const data = await response.json();
            currentNotepads = Array.isArray(data.notepads_list) ? data.notepads_list : [];
            renderSidebar(currentNotepads, currentNotepadId, selectNotepad, deleteNotepadById, renameNotepadById);
            
            currentNotepadId = handleQueryParameterSelection(currentNotepads, data['note_history']);
            cacheNotepads(data['note_history']);
            if (loadCurrentNote) {
                if (findNotepadByIdOrName(currentNotepads, currentNotepadId)) await selectNotepad(currentNotepadId);
                else currentNotepadId = await selectNextNotepad(false);
                setTimeout(() => prefetchNotepadNotes(Array.isArray(data['note_history']) ? data['note_history'] : []), 300);
            } else if (findNotepadByIdOrName(currentNotepads, currentNotepadId)) {
                updateSidebarSelection(currentNotepadId);
                renderRecentFiles(currentNotepadId, currentNotepads, selectNotepad, deleteNotepadById, renameNotepadById);
            }
        } catch (err) {
            console.warn('Error loading notepads:', err);
            setStartupSyncStatus('error', '服务器不可用，本地可读');
        }
    }

    let loadingNotepadId = null;
    const dirtyConflictNotepadIds = new Set();
    async function loadNotes(notepadId) { 
        if (!findNotepadByIdOrName(currentNotepads, notepadId)) return;
        await ensureEditor();
        const cachedBeforeFetch = getCachedNote(notepadId);
        if (cachedBeforeFetch?.content || cachedBeforeFetch?.dirty) {
            renderCachedNotepad(notepadId, cachedBeforeFetch.content || '');
        }
        if (!navigator.onLine) {
            setStartupSyncStatus('error', '服务器不可用，本地可读');
            return;
        }
        if (loadingNotepadId === notepadId) return; // Prevent redundant loading
        loadingNotepadId = notepadId;
        try { 
            const data = await fetchNoteData(notepadId);
            if (loadingNotepadId !== notepadId) return;

            const cachedNote = getCachedNote(notepadId);
            if (cachedNote?.dirty && currentNotepadId === notepadId) {
                setCurrentNoteVersion(notepadId, cachedNote.version);
                if (Number(data.version) > Number(cachedNote.version || 0)) {
                    if ((data.content || '') === (cachedNote.content || '')) {
                        dirtyConflictNotepadIds.delete(notepadId);
                        cacheSyncedNote(notepadId, cachedNote.content || '', { version: data.version });
                        setCurrentNoteVersion(notepadId, data.version);
                        hasUnsavedChanges = false;
                        hideNoteConflictToast();
                        setStartupSyncStatus('synced', '已同步');
                        return;
                    }
                    cacheConflictNote(notepadId, cachedNote.content || '', {
                        localVersion: cachedNote.version,
                        remoteVersion: data.version
                    });
                    dirtyConflictNotepadIds.add(notepadId);
                    setStartupSyncStatus('error', '有远端更新，本地已保留');
                    return;
                }
                dirtyConflictNotepadIds.delete(notepadId);
                cacheDirtyNote(notepadId, cachedNote.content || '', { version: cachedNote.version });
                setStartupSyncStatus('cached', '本地未同步');
                return;
            }

            if (editor.value !== (data.content || '')) editor.value = data.content || '';
            hasUnsavedChanges = false;
            dirtyConflictNotepadIds.delete(notepadId);
            setCurrentNoteVersion(notepadId, data.version);
            cacheSyncedNote(notepadId, data.content || '', { version: data.version });
            setStartupSyncStatus('synced', '已同步');

            const currentNotepad = currentNotepads.find(n => n.id === notepadId); 
            if (currentNotepad) trackRecentFile(currentNotepad); 
            
            updateSidebarSelection(notepadId);
            renderRecentFiles(notepadId, currentNotepads, selectNotepad, deleteNotepadById, renameNotepadById); 
        } catch (err) { 
            console.warn('Error loading notes:', err);
            setStartupSyncStatus('error', '服务器不可用，本地可读');
        } finally {
            if (loadingNotepadId === notepadId) loadingNotepadId = null;
        } 
    }

    let remoteUpdateTimeout;
    let tocUpdateTimeout;
    function debouncedUpdateToC() {
        clearTimeout(tocUpdateTimeout);
        tocUpdateTimeout = setTimeout(() => updateToC(), 500);
    }

    function updateToC() {
        const tocContainer = document.getElementById('toc-container');
        const tocList = document.getElementById('toc-list');
        if (!editorInstance || !editor.isReadingMode || !currentNotepadId) {
            tocContainer?.classList.remove('visible');
            document.body.classList.remove('toc-active');
            return;
        }

        const toc = editorInstance.generateToC();
        if (toc.length === 0) {
            tocContainer?.classList.remove('visible');
            document.body.classList.remove('toc-active');
            return;
        }

        tocContainer?.classList.add('visible');
        document.body.classList.add('toc-active');
        editorInstance.syncRenderedHeadingIds(toc);
        tocList.innerHTML = toc.map(item => `
            <div class="toc-item h${item.level}" data-index="${item.line}" data-heading-id="${escapeHtml(item.id)}">
                ${escapeHtml(item.text)}
            </div>
        `).join('');

        tocList.querySelectorAll('.toc-item').forEach(el => {
            el.onclick = () => {
                const index = parseInt(el.dataset.index);
                if (!editor.isReadingMode) {
                    editorInstance.focusLine(index, 0);
                } else {
                    const headingId = el.dataset.headingId || '';
                    if (!editorInstance.scrollToHeadingId(headingId)) {
                        editorInstance.scrollToLine(index);
                    }
                }
            };
        });
    }

    function loadStylesheetOnce(id, href) {
        const existing = document.getElementById(id) || document.querySelector(`link[href="${href}"]`);
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = () => resolve(link);
            link.onerror = () => reject(new Error(`Failed to load stylesheet: ${href}`));
            document.head.appendChild(link);
        });
    }

    function loadScriptOnce(id, src) {
        if (window.Vditor && src.includes('/vendor/vditor/')) return Promise.resolve();
        const existing = document.getElementById(id);
        if (existing) {
            if (existing.dataset.loaded === 'true') return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
                existing.addEventListener('load', () => resolve(existing), { once: true });
                existing.addEventListener('error', () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
            });
        }

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.id = id;
            script.src = src;
            script.async = true;
            script.onload = () => {
                script.dataset.loaded = 'true';
                resolve(script);
            };
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
        });
    }

    async function ensureEditor() {
        if (editorInstance) return editorInstance;
        if (!editorLoader) {
            editorLoader = (async () => {
                const vditorStyles = loadStylesheetOnce('vditor-editor-css', '/vendor/vditor/index.css');
                const vditorScript = loadScriptOnce('vditor-editor-js', '/vendor/vditor/index.min.js');
                const hybridEditorModule = import('./hybrid-editor.js');
                const [{ HybridMarkdownEditor }] = await Promise.all([
                    hybridEditorModule,
                    vditorStyles,
                    vditorScript
                ]);
                editorInstance = new HybridMarkdownEditor(document.getElementById('hybrid-editor'), {
                    input: (value) => {
                        pendingEditorValue = value || '';
                        if (isApplyingRemoteUpdate) return;
                        hasUnsavedChanges = true;
                        debouncedSave(value);
                        debouncedUpdateToC();
                        clearTimeout(remoteUpdateTimeout);
                        remoteUpdateTimeout = setTimeout(() => {
                            wsClient.sendUpdate('update', { notepadId: currentNotepadId, content: value, userId });
                        }, 700);
                    }
                });
                if (pendingEditorValue) editorInstance.setValue(pendingEditorValue, false);
                editorInstance.setReadingMode(isReadingMode);
                return editorInstance;
            })().catch(error => {
                editorLoader = null;
                console.warn('Failed to initialize editor:', error);
                toaster.show('编辑器加载失败', 'error', false, 3000);
                throw error;
            });
        }
        return editorLoader;
    }

    async function createNotepad() {
        const previousNotepads = [...currentNotepads];
        const previousNotepadId = currentNotepadId;
        const now = Date.now();
        const optimisticNotepad = {
            id: createClientNotepadId(),
            name: `Notepad ${currentNotepads.length + 1}`,
            version: 1,
            createdAt: now,
            updatedAt: now
        };

        currentNotepads = [
            optimisticNotepad,
            ...currentNotepads.filter(note => note.id !== optimisticNotepad.id)
        ];
        currentNotepadId = optimisticNotepad.id;
        currentNoteVersion = 1;
        cacheSyncedNote(optimisticNotepad.id, '', { version: 1 });
        renderNotepadLists(optimisticNotepad.id);
        renderCachedNotepad(optimisticNotepad.id, '');

        try {
            const response = await fetchWithPin('/api/notepads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: optimisticNotepad.id, name: optimisticNotepad.name, content: '' })
            });
            if (!response) throw new Error('Network error');
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const msg = payload?.error || 'Error creating new notepad';
                throw new Error(msg);
            }
            const newNotepad = payload;
            if (!newNotepad?.id) {
                throw new Error(payload?.error || 'Create notepad succeeded but missing id');
            }
            currentNotepads = [
                { ...optimisticNotepad, ...newNotepad },
                ...currentNotepads.filter(note => note.id !== optimisticNotepad.id && note.id !== newNotepad.id)
            ];
            cacheSyncedNote(newNotepad.id, '', { version: newNotepad.version || 1 });
            renderNotepadLists(newNotepad.id);
            if (currentNotepadId === optimisticNotepad.id || currentNotepadId === newNotepad.id) {
                renderCachedNotepad(newNotepad.id, editor.value || '');
                setCurrentNoteVersion(newNotepad.id, newNotepad.version || 1);
            }
            toaster.show(`New notepad: ${newNotepad.name}`, 'success');
        } catch (err) {
            console.error('Error creating notepad:', err);
            currentNotepads = previousNotepads;
            renderNotepadLists(previousNotepadId);
            if (findNotepadByIdOrName(currentNotepads, previousNotepadId)) {
                await selectNotepad(previousNotepadId);
            }
            toaster.show(err?.message || 'Error creating notepad', 'error', true);
        }
    }

    async function renameNotepadById(id) {
        const notepad = currentNotepads.find(n => n.id === id);
        if (!notepad) return;
        
        notepadIdToRename = id;
        renameInput.value = notepad.name;
        
        // Auto-close sidebar
        document.getElementById('sidebar-left')?.classList.remove('visible');
        document.getElementById('sidebar-overlay')?.classList.remove('visible');
        
        showModal(renameModal, renameInput);
    }

    async function renameNotepad() {
        const newName = renameInput.value.trim();
        if (!newName || !notepadIdToRename) return;
        
        const id = notepadIdToRename;
        const notepad = currentNotepads.find(n => n.id === id);
        if (!notepad) return;
        const previousNotepad = { ...notepad };
        Object.assign(notepad, {
            name: newName,
            updatedAt: Date.now(),
            version: (notepad.version || 1) + 1
        });
        renderNotepadLists(currentNotepadId);
        if (currentNotepadId === id) {
            updateUrlWithNotepad(newName);
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.textContent = `${newName} - DumbPad`;
        }
        hideModal(renameModal);

        try {
            const response = await fetchWithPin(`/api/notepads/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName, baseVersion: previousNotepad.version }),
            });
            const result = await response.json();
            if (!response.ok) {
                throw Object.assign(new Error(result?.error || 'Error renaming notepad'), {
                    status: response.status,
                    payload: result
                });
            }
            Object.assign(notepad, result);
            renderNotepadLists(currentNotepadId);
            if (currentNotepadId === id) {
                updateUrlWithNotepad(result.name);
                const pageTitle = document.getElementById('page-title');
                if (pageTitle) pageTitle.textContent = `${result.name} - DumbPad`;
            }
            wsClient.sendUpdate('notepad_change', { action: 'rename', notepadId: id, newName: result.name });
            toaster.show('Renamed notepad');
        } catch (err) {
            console.error('Error renaming notepad:', err);
            Object.assign(notepad, previousNotepad);
            renderNotepadLists(currentNotepadId);
            if (currentNotepadId === id) {
                updateUrlWithNotepad(previousNotepad.name);
                const pageTitle = document.getElementById('page-title');
                if (pageTitle) pageTitle.textContent = `${previousNotepad.name} - DumbPad`;
            }
            const message = err?.status === 409
                ? '该 Notepad 已在其他设备更新，请刷新后再重命名'
                : 'Error renaming notepad';
            toaster.show(message, 'error', true);
        }
    }

    async function saveNotes(content, isAutoSave, showStatus = true, retryCount = 0, targetNotepadId = currentNotepadId) {
        const queueKey = isValidNotepadId(targetNotepadId) ? targetNotepadId : currentNotepadId;
        const previousSave = saveNotesInFlight.get(queueKey) || Promise.resolve();
        const queuedSave = previousSave
            .catch(() => undefined)
            .then(() => performSaveNotes(content, isAutoSave, showStatus, retryCount, targetNotepadId));
        saveNotesInFlight.set(queueKey, queuedSave);
        try {
            return await queuedSave;
        } finally {
            if (saveNotesInFlight.get(queueKey) === queuedSave) {
                saveNotesInFlight.delete(queueKey);
            }
        }
    }

    async function performSaveNotes(content, isAutoSave, showStatus = true, retryCount = 0, targetNotepadId = currentNotepadId) {
        let baseVersion;
        let saveId;
        try {
            if (!findNotepadByIdOrName(currentNotepads, targetNotepadId) || currentNotepadId !== targetNotepadId) return;
            if (!navigator.onLine) {
                setStartupSyncStatus('error', '保存失败，本地已保留');
                return false;
            }
            baseVersion = targetNotepadId === currentNotepadId
                ? currentNoteVersion
                : currentNotepads.find(n => n.id === targetNotepadId)?.version;
            saveId = createSaveId();
            pendingNoteSaveIds.add(saveId);
            const payload = { content, userId, saveId };
            if (Number.isFinite(baseVersion)) payload.baseVersion = baseVersion;
            const response = await fetchWithPin(`/api/notes/${targetNotepadId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = await response.json().catch(() => ({}));
            if (!response?.ok) {
                throw Object.assign(new Error(result?.error || `Save failed (${response?.status || 'network'})`), {
                    status: response.status,
                    payload: result
                });
            }
            pendingNoteSaveIds.delete(saveId);
            clearTimeout(saveRetryTimeout);
            saveRetryTimeout = null;
            lastSaveTime = Date.now();
            setCurrentNoteVersion(targetNotepadId, result.version);
            const savedContentStillCurrent = currentNotepadId === targetNotepadId && editor.value === content;
            if (showStatus) {
                if (isAutoSave && savedContentStillCurrent) {
                    const settings = settingsManager.getSettings();
                    toaster.show('Saved', 'success', false, settings.saveStatusMessageInterval); 
                } else if (!isAutoSave && savedContentStillCurrent) toaster.show('Saved');
            }
            if (savedContentStillCurrent) {
                hasUnsavedChanges = false;
                cacheSyncedNote(targetNotepadId, content, { version: result.version });
                setStartupSyncStatus('synced', '已同步');
                dirtyConflictNotepadIds.delete(targetNotepadId);
                hideNoteConflictToast();
            } else if (currentNotepadId === targetNotepadId) {
                cacheDirtyNote(targetNotepadId, editor.value, { version: result.version });
                setStartupSyncStatus('cached', '本地已保留');
            }
            return true;
        } catch (err) {
            if (saveId) pendingNoteSaveIds.delete(saveId);
            console.warn('Error saving notes:', err);
            if (err?.status === 409) {
                dirtyConflictNotepadIds.add(targetNotepadId);
                const remoteVersion = Number(err?.payload?.currentVersion);
                cacheConflictNote(targetNotepadId, content, {
                    localVersion: baseVersion,
                    remoteVersion: Number.isFinite(remoteVersion) ? remoteVersion : undefined
                });
                setStartupSyncStatus('error', '有远端更新，本地已保留');
                showNoteConflictToast('error', 6000);
                return false;
            }
            if (isAutoSave && retryCount < 3 && currentNotepadId === targetNotepadId) {
                clearTimeout(saveRetryTimeout);
                saveRetryTimeout = setTimeout(() => {
                    saveNotes(content, true, false, retryCount + 1, targetNotepadId);
                }, 1200 * (retryCount + 1));
            }
            setStartupSyncStatus('error', '保存失败，本地已保留');
            toaster.show('Error saving', 'error', false, 3000);
            return false;
        }
    }

    let dirtySyncInFlight = false;
    async function syncCurrentDirtyNote() {
        if (dirtySyncInFlight) {
            console.info('[sync] skip dirty sync reason=in_flight');
            return;
        }
        const cachedNote = getCachedNote(currentNotepadId);
        const decision = noteSyncController.canSyncDirtyNote({
            notepadId: isValidNotepadId(currentNotepadId) ? currentNotepadId : '',
            cachedNote,
            editorContent: editor.value,
            isOnline: navigator.onLine,
            notepadExists: !!findNotepadByIdOrName(currentNotepads, currentNotepadId),
            conflictIds: dirtyConflictNotepadIds
        });
        if (!decision.ok) {
            if (decision.reason === 'no_dirty') return;
            if (decision.reason === 'conflict') {
                console.info('[sync] skip dirty sync reason=conflict notepadId=%s localVersion=%s remoteVersion=%s',
                    currentNotepadId,
                    cachedNote?.version ?? '-',
                    cachedNote?.remoteVersion ?? '-'
                );
                return;
            }
            console.info('[sync] skip dirty sync reason=%s notepadId=%s', decision.reason, currentNotepadId);
            return;
        }

        dirtySyncInFlight = true;
        clearTimeout(saveTimeout);
        setCurrentNoteVersion(currentNotepadId, cachedNote.version);
        setStartupSyncStatus('syncing', '同步本地修改');
        try {
            const synced = await saveNotes(cachedNote.content || '', true, false, 0, currentNotepadId);
            if (synced) cacheSyncedNote(currentNotepadId, cachedNote.content || '', { version: currentNoteVersion });
        } finally {
            dirtySyncInFlight = false;
        }
    }

    function updateSettingsConflictSection() {
        if (!settingsConflictSection || !settingsConflictContent || !settingsConflictMessage) return;
        const cachedNote = getCachedNote(currentNotepadId);
        const hasLocalContent = !!cachedNote?.dirty;
        const isConflict = dirtyConflictNotepadIds.has(currentNotepadId) || !!cachedNote?.conflict;
        const isOffline = !navigator.onLine || startupSyncSnapshot.label.includes('服务器不可用');
        const serverVersion = Number.isFinite(Number(currentNoteVersion)) ? currentNoteVersion : null;
        const localVersion = Number.isFinite(Number(cachedNote?.version)) ? cachedNote.version : serverVersion;
        const remoteVersion = Number.isFinite(Number(cachedNote?.remoteVersion))
            ? Number(cachedNote.remoteVersion)
            : serverVersion;
        const summaryKind = isConflict
            ? 'conflict'
            : hasLocalContent
                ? 'dirty'
                : isOffline
                    ? 'offline'
                    : startupSyncSnapshot.kind === 'unsynced'
                        ? 'error'
                        : 'synced';
        const summaryText = {
            synced: '已同步',
            dirty: '本地未同步',
            conflict: '远端冲突',
            offline: '服务器不可用',
            error: '需要处理'
        }[summaryKind] || '同步状态';

        settingsConflictSection.hidden = false;
        settingsConflictSection.classList.toggle('is-clean', !hasLocalContent);
        if (settingsSyncSummary) {
            settingsSyncSummary.dataset.kind = summaryKind;
            settingsSyncSummary.textContent = summaryText;
        }
        if (settingsLocalVersion) settingsLocalVersion.textContent = localVersion ?? '-';
        if (settingsServerVersion) settingsServerVersion.textContent = remoteVersion ?? '-';
        if (settingsCacheTime) settingsCacheTime.textContent = formatCacheTime(cachedNote?.savedAt);
        if (settingsDirtyNotes) {
            const dirtyNotes = getDirtyCachedNotes();
            settingsDirtyNotes.hidden = dirtyNotes.length === 0;
            settingsDirtyNotes.innerHTML = dirtyNotes.length ? `
                <div class="settings-dirty-notes-title">本地未同步：${dirtyNotes.length} 个</div>
                ${dirtyNotes.map(note => `
                    <button type="button" class="settings-dirty-note-item" data-sync-note-id="${escapeHtml(note.id)}">
                        <span class="settings-dirty-note-name">${escapeHtml(note.name)}</span>
                        <span class="settings-dirty-note-state">${note.conflict ? '远端冲突' : formatCacheTime(note.savedAt)}</span>
                    </button>
                `).join('')}
            ` : '';
        }
        if (settingsRetryLocalSync) {
            settingsRetryLocalSync.hidden = !hasLocalContent;
            settingsRetryLocalSync.disabled = !hasLocalContent || isConflict || !navigator.onLine;
            settingsRetryLocalSync.title = isConflict
                ? '远端已有更新，不能自动覆盖'
                : !navigator.onLine
                    ? '服务器不可用'
                    : hasLocalContent
                        ? '重新保存当前本地内容'
                        : '没有本地未同步内容';
        }

        if (!hasLocalContent) {
            settingsConflictContent.value = '';
            const name = getCurrentNotepadName();
            settingsConflictMessage.textContent = `${name} 当前状态：${startupSyncSnapshot.label || '已同步'}。没有本地保留内容。`;
            return;
        }

        const name = getCurrentNotepadName();
        settingsConflictMessage.textContent = isConflict
            ? `${name} 有远端更新，本地内容仍保留在浏览器中。请复制本地内容或加载远端版本。`
            : `${name} 有本地未同步内容。`;
        settingsConflictContent.value = cachedNote.content || '';
    }

    function openSettingsModal(options = {}) {
        settingsManager.loadSettings();
        updateSettingsConflictSection();
        refreshCloudStatus(false);
        refreshTrashList(false);
        const focusTarget = options.focusSyncPanel ? settingsConflictSection : settingsInputAutoSaveStatusInterval;
        showModal(settingsModal, focusTarget);
        if (options.focusSyncPanel && settingsConflictSection) {
            settingsConflictSection.scrollIntoView({ block: 'nearest' });
        }
    }

    async function copyCurrentLocalContent() {
        const cachedNote = getCachedNote(currentNotepadId);
        if (!cachedNote?.dirty) return;
        try {
            await navigator.clipboard.writeText(cachedNote.content || '');
            toaster.show('Local content copied', 'success');
        } catch (err) {
            console.warn('Failed to copy local content:', err);
            toaster.show('Failed to copy local content', 'error');
        }
    }

    async function discardCurrentLocalContent() {
        const cachedNote = getCachedNote(currentNotepadId);
        if (!cachedNote?.dirty) return;
        const confirmed = await confirmationManager.show({
            title: '放弃本地保留内容',
            message: '这会清除当前 note 的本地未同步内容，并重新加载服务器版本。建议先复制本地内容。',
            confirmText: '加载远端',
            cancelText: '取消',
            confirmType: 'danger'
        });
        if (!confirmed) return;

        cacheSyncedNote(currentNotepadId, cachedNote.content || '', { version: cachedNote.version });
        dirtyConflictNotepadIds.delete(currentNotepadId);
        await loadNotes(currentNotepadId);
        updateSettingsConflictSection();
        setStartupSyncStatus('synced', '已加载远端');
    }

    async function retryCurrentLocalSync() {
        const cachedNote = getCachedNote(currentNotepadId);
        if (!cachedNote?.dirty || dirtyConflictNotepadIds.has(currentNotepadId) || cachedNote.conflict) {
            updateSettingsConflictSection();
            return;
        }
        setStartupSyncStatus('syncing', '同步本地修改');
        const synced = await saveNotes(cachedNote.content || '', false, true, 0, currentNotepadId);
        if (synced) {
            updateSettingsConflictSection();
        } else {
            updateSettingsConflictSection();
        }
    }

    async function selectDirtyCachedNote(id) {
        if (!findNotepadByIdOrName(currentNotepads, id)) return;
        await selectNotepad(id);
        updateSettingsConflictSection();
    }

    function debouncedSave(content) {
        cacheDirtyNote(currentNotepadId, content);
        setStartupSyncStatus('cached', '本地已保留');
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            await saveNotes(content, true);
        }, 300);
    }

    async function deleteNotepad() {
        if (!findNotepadByIdOrName(currentNotepads, currentNotepadId)) return;
        await deleteNotepadById(currentNotepadId);
    }

    async function deleteNotepadById(id) {
        const notepad = currentNotepads.find(n => n.id === id);
        if (!notepad) return;
        if (id === 'default') return toaster.show('Cannot delete the default notepad', 'error');
        
        notepadIdToDelete = id;
        
        // Auto-close sidebar to prevent overlapping with modal
        document.getElementById('sidebar-left')?.classList.remove('visible');
        document.getElementById('sidebar-overlay')?.classList.remove('visible');

        const messageEl = deleteModal.querySelector('.modal-message');
        if (messageEl) messageEl.textContent = `确定将 '${notepad.name}' 移入垃圾桶吗？之后可以在设置里恢复。`;
        showModal(deleteModal, deleteCancel);
    }

    async function doDeleteNotepad() {
        if (!notepadIdToDelete) return;
        const id = notepadIdToDelete;
        const previousNotepads = [...currentNotepads];
        const previousNotepadId = currentNotepadId;
        const previousContent = currentNotepadId === id ? editor.value : (getCachedNote(id)?.content || '');
        const notepad = currentNotepads.find(n => n.id === id);
        currentNotepads = currentNotepads.filter(note => note.id !== id);
        const nextNotepadId = currentNotepadId === id
            ? (currentNotepads[0]?.id || 'default')
            : currentNotepadId;
        currentNotepadId = nextNotepadId;
        deleteModal.classList.remove('visible');
        notepadIdToDelete = null;
        renderNotepadLists(nextNotepadId);
        if (previousNotepadId === id && findNotepadByIdOrName(currentNotepads, nextNotepadId)) {
            const cachedNext = getCachedNote(nextNotepadId);
            if (cachedNext) renderCachedNotepad(nextNotepadId, cachedNext.content || '');
            else await selectNotepad(nextNotepadId);
        }

        try {
            const response = await fetchWithPin(`/api/notepads/${id}`, { method: 'DELETE' });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload?.error || 'Error deleting notepad');
            }
            if (notepad) wsClient.sendUpdate('notepad_change', { action: 'delete', notepadId: id, notepadName: notepad.name });
            toaster.show('已移入垃圾桶');
        } catch (err) {
            console.error('Error deleting notepad:', err);
            currentNotepads = previousNotepads;
            renderNotepadLists(previousNotepadId);
            if (previousNotepadId === id) {
                renderCachedNotepad(id, previousContent);
            }
            toaster.show('Error deleting notepad', 'error', true);
        }
    }

    function downloadNotepad(extension) {
        const name = getCurrentNotepadName();
        const blob = new Blob([editor.value], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.${extension}`;
        a.click();
        URL.revokeObjectURL(url);
        toaster.show('Downloading...');
    }

    let jsZipLoader = null;
    async function ensureJSZip() {
        if (typeof JSZip !== 'undefined') return JSZip;
        jsZipLoader ||= new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.async = true;
            script.onload = () => resolve(window.JSZip);
            script.onerror = () => reject(new Error('JSZip failed to load'));
            document.head.appendChild(script);
        });
        return jsZipLoader;
    }

    async function exportAllAsZip() {
        try {
            await ensureJSZip();
        } catch (_error) {
            toaster.show('JSZip library not loaded', 'error');
            return;
        }
        const zip = new JSZip();
        toaster.show('Preparing ZIP export...', 'info');
        try {
            for (const notepad of currentNotepads) {
                const response = await fetchWithPin('/api/notes/' + notepad.id);
                if (!response.ok) continue;
                const data = await response.json();
                const filename = (notepad.name || 'untitled').replace(/[\/\\?%*:|"<>]/g, '_');
                zip.file(`${filename}.md`, data.content || '');
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `dumbpad-export-${new Date().toISOString().split('T')[0]}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toaster.show('Export complete', 'success');
        } catch (err) {
            console.error('ZIP Export Error:', err);
            toaster.show('Failed to create ZIP', 'error');
        }
    }

    async function printNotepad() {
        const name = getCurrentNotepadName();
        const printWindow = window.open('', '_blank');
        try {
            const data = await previewManager.preparePrintContent(editor.value, name, settingsManager.getSettings(), currentTheme);
            printWindow.document.write(`<html><head><title>${name}</title><style>${data.mainStyles}${data.previewStyles}${data.highlightStyles}${data.printStyles}</style></head><body>${data.formattedContent}</body></html>`);
            printWindow.document.close();
            setTimeout(() => { printWindow.print(); printWindow.close(); }, 250);
        } catch (error) {
            printWindow.close();
        }
    }

    let selectionToken = 0;
    async function openEditorView() {
        if (currentNotepads.length === 0) {
            await loadNotepads({ loadCurrentNote: false });
        }
        const target = findNotepadByIdOrName(currentNotepads, currentNotepadId)?.id || getFallbackNotepadId(currentNotepads);
        if (target) {
            await selectNotepad(target);
        } else {
            await ensureEditor();
        }
    }

    async function selectNotepad(id, query = "") {
        const token = ++selectionToken;
        const selectedNotepad = findNotepadByIdOrName(currentNotepads, id);
        currentNotepadId = selectedNotepad?.id || null;
        
        // --- UI Visibility ---
        const emptyState = document.getElementById('empty-state');
        const hybridEditor = document.getElementById('hybrid-editor');
        if (currentNotepadId) {
            emptyState.style.display = 'none';
            hybridEditor.style.display = 'block';
        } else {
            emptyState.style.display = 'flex';
            hybridEditor.style.display = 'none';
            // No valid notepad selected — avoid any further loading/rendering
            document.getElementById('page-title').textContent = `${_siteTitle} - DumbPad`;
            return;
        }

        // Hide mobile sidebar on selection
        document.getElementById('sidebar-left')?.classList.remove('visible');
        document.getElementById('sidebar-overlay')?.classList.remove('visible');

        await loadNotes(currentNotepadId);
        if (token !== selectionToken) return;

        updateToC(); // Update TOC on selection

        // Update header title if in reading mode
        if (isReadingMode) applyReadingModeTitle();

        if (query && editorInstance) {
            setTimeout(() => editorInstance.jumpToKeyword(query), 100);
        }
        // editor.focus(); // Disabled to allow opening in full preview mode
        const name = getCurrentNotepadName();
        updateUrlWithNotepad(name);
        document.getElementById('page-title').textContent = `${name} - DumbPad`;
    }

    async function selectNextNotepad(forward = true) {
        if (currentNotepads.length === 0) return currentNotepadId;
        const currentIdx = Math.max(0, currentNotepads.findIndex(p => p.id === currentNotepadId));
        const nextIdx = forward ? (currentIdx + 1) % currentNotepads.length : (currentIdx - 1 + currentNotepads.length) % currentNotepads.length;
        const nextId = currentNotepads[nextIdx].id;
        await selectNotepad(nextId);
        return nextId;
    }

    function hideModal(modal, msg) {
        modal.classList.remove('visible');
        if (msg) toaster.show(msg);
        editor.focus();
    }

    function showModal(modal, focusEl) {
        closeAllModals();
        modal.classList.add('visible');
        if (focusEl) focusEl.focus();
    }

    function closeAllModals() {
        document.querySelectorAll('.modal').forEach(m => m.classList.remove('visible'));
    }

    function addEventListeners() {
        // --- Command Palette Implementation ---
        const commandPalette = {
            overlay: null,
            input: null,
            results: null,
            selectedIndex: 0,
            isActive: false,
            currentQuery: '',
            searchTimeout: null,

            init() {
                this.overlay = document.getElementById('command-palette-overlay');
                this.input = document.getElementById('command-input');
                this.results = document.getElementById('command-results');

                this.input.addEventListener('input', () => this.search());
                this.input.addEventListener('keydown', (e) => this.handleKeydown(e));
                this.overlay.addEventListener('click', (e) => {
                    if (e.target === this.overlay) this.close();
                });

                window.addEventListener('keydown', (e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                        e.preventDefault();
                        this.open();
                    }
                    if (e.key === 'Escape' && this.isActive) this.close();
                });
            },

            open() {
                this.isActive = true;
                this.overlay.classList.add('active');
                this.input.value = '';
                this.currentQuery = '';
                this.input.focus();
                this.results.innerHTML = '';
            },

            close() {
                this.isActive = false;
                this.overlay.classList.remove('active');
            },

            async search() {
                const query = this.input.value.trim();
                this.currentQuery = query;
                if (!query) {
                    this.results.innerHTML = '';
                    return;
                }

                // Debounce: wait 200ms after last keystroke
                clearTimeout(this.searchTimeout);
                this.searchTimeout = setTimeout(async () => {
                    if (!this.isActive) return;
                    try {
                        this.results.innerHTML = '<div class="command-item"><span>Searching…</span></div>';
                        const response = await fetchWithPin(`/api/search?q=${encodeURIComponent(query)}`);
                        const data = await response.json();
                        if (this.currentQuery !== query) return; // stale
                        this.render(data.results || []);
                    } catch (err) {
                        console.error('Search failed:', err);
                        this.results.innerHTML = '<div class="command-item"><span>Search failed</span></div>';
                    }
                }, 200);
            },

            render(items) {
                this.selectedIndex = 0;
                if (!items.length) {
                    this.results.innerHTML = '<div class="command-item" style="color:var(--muted-text)"><span>No results</span></div>';
                    return;
                }

                this.results.innerHTML = items.map((item, index) => `
                    <div class="command-item ${index === 0 ? 'selected' : ''}" data-id="${this.escapeAttr(item.id)}">
                        <div class="command-item-main">
                            <span class="command-item-title">${this.escapeHtml(item.title || item.name)}</span>
                            ${item.matchType === 'content' && item.snippet
                                ? `<span class="command-item-snippet">${this.escapeHtml(item.snippet)}</span>`
                                : ''}
                        </div>
                        <kbd>Enter</kbd>
                    </div>
                `).join('');

                const query = this.currentQuery;
                const els = this.results.querySelectorAll('.command-item');
                els.forEach((el, index) => {
                    el.onclick = () => {
                        selectNotepad(el.dataset.id, query);
                        this.close();
                    };
                });
            },

            handleKeydown(e) {
                const items = this.results.querySelectorAll('.command-item');
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.selectedIndex = (this.selectedIndex + 1) % items.length;
                    this.updateSelection(items);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
                    this.updateSelection(items);
                } else if (e.key === 'Enter') {
                    if (items[this.selectedIndex]) {
                        items[this.selectedIndex].click();
                    }
                }
            },

            updateSelection(items) {
                items.forEach((item, index) => {
                    item.classList.toggle('selected', index === this.selectedIndex);
                    if (index === this.selectedIndex) item.scrollIntoView({ block: 'nearest' });
                });
            },

            escapeHtml(text) {
                if (!text) return '';
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            },

            escapeAttr(text) {
                if (!text) return '';
                return text.replace(/"/g, '&quot;').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
        };

        commandPalette.init();

        // Wire search toggle button: editor mode → command palette, thoughts mode → expand filter
        openCommandSearch = () => commandPalette.open();
        document.getElementById('toggle-thoughts')?.addEventListener('click', async (event) => {
            if (thoughtsManager) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            try {
                await ensureThoughtsManager();
                window.location.hash = window.location.hash === '#thoughts' ? '' : 'thoughts';
            } catch (_error) {
                // ensureThoughtsManager already reports load errors to the user.
            }
        }, { capture: true });

        copyAllBtn.addEventListener('click', async () => {
            const raw = editor.value;
            if (!raw) return toaster.show('Nothing to copy', 'info');

            // Render markdown to HTML
            const temp = document.createElement('div');
            temp.innerHTML = await renderMarkdown(raw);

            // Strip annotation badges from copy
            temp.querySelectorAll('.annotation-badge').forEach(b => b.remove());

            let html = temp.innerHTML;

            // Wrap annotations (span data-note + sub data-note-label) in <div>
            html = html.replace(/(<span\s+data-note="[^"]*?"[^>]*?>[\s\S]*?<\/span>\s*<sub\s+data-note-label[^>]*?>[\s\S]*?<\/sub>)/g, '<div>$1</div>');
            // Wrap highlights (span data-draw) in <div>
            html = html.replace(/(<span\s+data-draw[^>]*?>[\s\S]*?<\/span>)/g, '<div>$1</div>');

            // Try ClipboardItem API first (keeps HTML formatting)
            try {
                const htmlBlob = new Blob([html], { type: 'text/html' });
                const textBlob = new Blob([raw], { type: 'text/plain' });
                await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })]);
                toaster.show('已复制（含格式）', 'success');
                return;
            } catch (e) { /* fall through to DOM method */ }

            // Fallback: DOM-based copy (preserves HTML reliably)
            try {
                const clone = document.createElement('div');
                clone.innerHTML = html;
                clone.style.position = 'fixed';
                clone.style.left = '-9999px';
                document.body.appendChild(clone);
                const range = document.createRange();
                range.selectNodeContents(clone);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('copy');
                sel.removeAllRanges();
                document.body.removeChild(clone);
                toaster.show('已复制', 'success');
            } catch (err) {
                toaster.show('复制失败', 'error');
            }
        });


        copyLinkBtn.addEventListener('click', copyCurrentNotepadLink);
        if (newNotepadBtn) newNotepadBtn.addEventListener('click', () => createNotepad());
        if (newNotepadHeaderBtn) newNotepadHeaderBtn.addEventListener('click', () => createNotepad());
        if (downloadNotepadHeaderBtn) downloadNotepadHeaderBtn.addEventListener('click', () => showModal(downloadModal, downloadCancel));
        if (printNotepadHeaderBtn) printNotepadHeaderBtn.addEventListener('click', printNotepad);
        if (newNotepadSidebarBtn) newNotepadSidebarBtn.addEventListener('click', () => {
            createNotepad();
            document.getElementById('sidebar-left').classList.remove('visible');
            document.getElementById('sidebar-overlay')?.classList.remove('visible');
        });
        if (renameNotepadBtn) {
            renameNotepadBtn.addEventListener('click', () => {
                renameNotepadById(currentNotepadId);
            });
        }
        renameConfirm.addEventListener('click', renameNotepad);
        renameCancel.addEventListener('click', () => hideModal(renameModal));
        if (deleteNotepadBtn) {
            deleteNotepadBtn.addEventListener('click', () => showModal(deleteModal, deleteCancel));
        }
        deleteConfirm.addEventListener('click', doDeleteNotepad);
        deleteCancel.addEventListener('click', () => hideModal(deleteModal));
        if (downloadNotepadBtn) downloadNotepadBtn.addEventListener('click', () => showModal(downloadModal, downloadCancel));
        downloadTxt.addEventListener('click', () => { downloadNotepad('txt'); hideModal(downloadModal); });
        downloadMd.addEventListener('click', () => { downloadNotepad('md'); hideModal(downloadModal); });
        document.getElementById('download-zip').addEventListener('click', () => { exportAllAsZip(); hideModal(downloadModal); });
        downloadCancel.addEventListener('click', () => hideModal(downloadModal));
        if (printNotepadBtn) printNotepadBtn.addEventListener('click', printNotepad);
        if (settingsButton) {
            settingsButton.addEventListener('click', () => {
                openSettingsModal();
            });
        }
        if (startupSyncStatus) {
            startupSyncStatus.addEventListener('click', (event) => {
                event.stopPropagation();
                openSettingsModal({ focusSyncPanel: true });
            });
            startupSyncStatus.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                openSettingsModal({ focusSyncPanel: true });
            });
        }
        if (settingsCancel) settingsCancel.addEventListener('click', () => hideModal(settingsModal));
        if (settingsSave) settingsSave.addEventListener('click', () => { settingsManager.saveSettings(); hideModal(settingsModal, 'Settings Saved'); });
        if (settingsReset) settingsReset.addEventListener('click', () => { settingsManager.saveSettings(true); settingsManager.loadSettings(); toaster.show('Settings reset', 'success'); });
        if (settingsRetryLocalSync) settingsRetryLocalSync.addEventListener('click', retryCurrentLocalSync);
        if (settingsDirtyNotes) {
            settingsDirtyNotes.addEventListener('click', (event) => {
                const item = event.target.closest('.settings-dirty-note-item');
                if (!item?.dataset.syncNoteId) return;
                selectDirtyCachedNote(item.dataset.syncNoteId);
            });
        }
        if (settingsCopyLocalContent) settingsCopyLocalContent.addEventListener('click', copyCurrentLocalContent);
        if (settingsDiscardLocalContent) settingsDiscardLocalContent.addEventListener('click', discardCurrentLocalContent);
        if (settingsCloudRefresh) settingsCloudRefresh.addEventListener('click', () => refreshCloudStatus(true));
        if (settingsSpaceList) {
            settingsSpaceList.addEventListener('click', (event) => {
                const item = event.target.closest('.settings-space-item');
                if (!item || item.disabled) return;
                selectCloudSpace(item.dataset.prefix || '');
            });
        }
        if (settingsCloudInventory) settingsCloudInventory.addEventListener('click', () => runCloudAction('inventory'));
        if (settingsImportDryRun) settingsImportDryRun.addEventListener('click', () => runCloudAction('import:dry-run'));
        if (settingsImportRun) settingsImportRun.addEventListener('click', () => runCloudAction('import:run'));
        if (settingsBackupDryRun) settingsBackupDryRun.addEventListener('click', () => runCloudAction('backup:dry-run'));
        if (settingsBackupRun) settingsBackupRun.addEventListener('click', () => runCloudAction('backup:run'));
        if (settingsDeleteDryRun) settingsDeleteDryRun.addEventListener('click', () => runCloudAction('delete:dry-run'));
        if (settingsDeleteRun) settingsDeleteRun.addEventListener('click', () => runCloudAction('delete:run'));
        if (settingsLocalOverwriteCloudDryRun) settingsLocalOverwriteCloudDryRun.addEventListener('click', () => runCloudAction('local-overwrite-s3:dry-run'));
        if (settingsLocalOverwriteCloud) settingsLocalOverwriteCloud.addEventListener('click', () => runGuidedCloudAction('local-overwrite-s3:run', 'local-overwrite-s3:dry-run'));
        if (settingsCloudOverwriteLocalDryRun) settingsCloudOverwriteLocalDryRun.addEventListener('click', () => runCloudAction('s3-overwrite-local:dry-run'));
        if (settingsCloudOverwriteLocal) settingsCloudOverwriteLocal.addEventListener('click', () => runGuidedCloudAction('s3-overwrite-local:run', 's3-overwrite-local:dry-run'));
        if (settingsAutoSyncStatus) settingsAutoSyncStatus.addEventListener('click', showAutoSyncStatus);
        if (settingsTrashRefresh) settingsTrashRefresh.addEventListener('click', () => refreshTrashList(true));
        if (settingsTrashEmpty) settingsTrashEmpty.addEventListener('click', emptyTrash);
        if (settingsTrashList) {
            settingsTrashList.addEventListener('click', (event) => {
                const button = event.target.closest('[data-trash-action]');
                const item = event.target.closest('[data-trash-id]');
                if (!button || !item) return;
                if (button.dataset.trashAction === 'restore') {
                    restoreTrashItem(item.dataset.trashId);
                } else if (button.dataset.trashAction === 'delete') {
                    deleteTrashItemPermanently(item.dataset.trashId);
                }
            });
        }
        
        const readModeBtn = document.getElementById('toggle-reading-mode');
        isReadingMode = localStorage.getItem('dumbpad_reading_mode') === 'true';

        function updateReadingMode(showToast = false) {
            if (!readModeBtn) return;
            editor.setReadingMode(isReadingMode);

            // Update icons
            readModeBtn.querySelector('.read-icon').style.display = isReadingMode ? 'none' : 'block';
            readModeBtn.querySelector('.edit-icon').style.display = isReadingMode ? 'block' : 'none';
            readModeBtn.classList.toggle('active', isReadingMode);

            if (isReadingMode) {
                document.body.classList.add('reading-mode-active');
                applyReadingModeTitle();
            } else {
                document.body.classList.remove('reading-mode-active');
                setHeaderTitle(_siteTitle);
            }

            updateToC(); // Update TOC when toggling mode

            localStorage.setItem('dumbpad_reading_mode', isReadingMode);
            if (showToast) {
                toaster.show(isReadingMode ? 'Reading Mode' : 'Editing Mode', 'info');
            }
        }

        if (readModeBtn) {
            readModeBtn.addEventListener('click', () => {
                isReadingMode = !isReadingMode;
                updateReadingMode(true);
            });
        }

        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', currentTheme);
                previewManager.updateHighlightTheme(currentTheme);
                storageManager.save(THEME_KEY, currentTheme);
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAllModals();
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveNotes(editor.value); }
            if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 'ArrowDown') { e.preventDefault(); selectNextNotepad(true); }
            if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 'ArrowUp') { e.preventDefault(); selectNextNotepad(false); }
            if (e.altKey && e.key.toLowerCase() === 'r') {
                e.preventDefault();
                isReadingMode = !isReadingMode;
                updateReadingMode(true);
            }
        });

        window.addEventListener('popstate', (e) => {
            const id = new URLSearchParams(window.location.search).get('id');
            if (id) {
                const found = currentNotepads.find(n => n.id === id || n.name.toLowerCase() === id.toLowerCase());
                if (found) selectNotepad(found.id);
            }
        });

        document.getElementById('toggle-sidebar-left')?.addEventListener('click', () => {
            const side = document.getElementById('sidebar-left');
            side.style.display = side.style.display === 'none' ? 'flex' : 'none';
        });
        document.getElementById('toggle-sidebar-right')?.addEventListener('click', () => {
            const side = document.getElementById('sidebar-right');
            side.style.display = side.style.display === 'none' ? 'flex' : 'none';
        });
        
        const overlay = document.getElementById('sidebar-overlay');
        const sidebarLeft = document.getElementById('sidebar-left');
        const mobileSidebarHost = document.querySelector('main.three-column-layout');

        const setMobileSidebarVisible = (visible) => {
            if (!sidebarLeft) return;
            sidebarLeft.classList.toggle('visible', visible);
            overlay?.classList.toggle('visible', visible);
            document.body.classList.toggle('mobile-sidebar-open', visible);

            if (!mobileSidebarHost) return;
            if (visible && document.body.classList.contains('thoughts-mode')) {
                if (!mobileSidebarHost.dataset.sidebarRestoreDisplay) {
                    mobileSidebarHost.dataset.sidebarRestoreDisplay = mobileSidebarHost.style.display || '';
                }
                mobileSidebarHost.style.display = 'block';
                mobileSidebarHost.classList.add('mobile-sidebar-host');
                return;
            }

            if (mobileSidebarHost.classList.contains('mobile-sidebar-host')) {
                mobileSidebarHost.style.display = mobileSidebarHost.dataset.sidebarRestoreDisplay || '';
                delete mobileSidebarHost.dataset.sidebarRestoreDisplay;
                mobileSidebarHost.classList.remove('mobile-sidebar-host');
            }
        };

        document.getElementById('mobile-menu-toggle')?.addEventListener('click', () => {
            setMobileSidebarVisible(!sidebarLeft.classList.contains('visible'));
        });

        document.getElementById('close-sidebar-left')?.addEventListener('click', () => {
            setMobileSidebarVisible(false);
        });

        overlay?.addEventListener('click', () => {
            setMobileSidebarVisible(false);
        });

        setupSidebarTabs();

        if (readModeBtn) {
            updateReadingMode(false);
        }

        // Scroll Helper Logic
        // Icon follows scroll direction: scrolling down → ↓↓, scrolling up → ↑↑
        let scrollDir = 'down';
        let lastScrollY = 0;

        if (scrollBtn) {
            const getActiveScrollTarget = () => {
                const sourceEditor = document.querySelector('.typora-editor-shell.is-source-mode .typora-source-editor');
                if (sourceEditor && sourceEditor.scrollHeight > sourceEditor.clientHeight + 2) return sourceEditor;

                const wysiwyg = document.querySelector('.typora-editor-shell .vditor-wysiwyg');
                if (wysiwyg && wysiwyg.scrollHeight > wysiwyg.clientHeight + 2) return wysiwyg;

                const thoughtsArea = document.querySelector('.thoughts-scroll-area');
                if (thoughtsArea && thoughtsArea.offsetParent !== null && thoughtsArea.scrollHeight > thoughtsArea.clientHeight + 2) return thoughtsArea;

                return document.scrollingElement || document.documentElement;
            };

            const updateIcon = () => {
                if (scrollDir === 'down') {
                    scrollBtn.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M7 13l5 5 5-5M7 6l5 5 5-5"></path>
                        </svg>`;
                } else {
                    scrollBtn.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M7 11l5-5 5 5M7 18l5-5 5 5"></path>
                        </svg>`;
                }
            };

            window.addEventListener('scroll', () => {
                const el = document.scrollingElement || document.documentElement;
                const y = el.scrollTop;
                const maxScroll = el.scrollHeight - el.clientHeight;
                if (maxScroll <= 0) return;
                if (y === lastScrollY) return;

                let dir;
                if (y <= 2) {
                    dir = 'down';           // at top → only useful direction is down
                } else if (y >= maxScroll - 2) {
                    dir = 'up';             // at bottom → only useful direction is up
                } else {
                    dir = y > lastScrollY ? 'down' : 'up';
                }
                lastScrollY = y;
                if (scrollDir !== dir) {
                    scrollDir = dir;
                    updateIcon();
                }
            }, { passive: true });

            setTimeout(() => {
                [
                    document.querySelector('.typora-editor-shell .vditor-wysiwyg'),
                    document.querySelector('.typora-source-editor'),
                    document.querySelector('.thoughts-scroll-area')
                ].filter(Boolean).forEach(el => {
                    el.addEventListener('scroll', () => {
                        const y = el.scrollTop;
                        const maxScroll = el.scrollHeight - el.clientHeight;
                        if (maxScroll <= 0) return;
                        let dir;
                        if (y <= 2) {
                            dir = 'down';
                        } else if (y >= maxScroll - 2) {
                            dir = 'up';
                        } else {
                            dir = y > lastScrollY ? 'down' : 'up';
                        }
                        lastScrollY = y;
                        if (scrollDir !== dir) {
                            scrollDir = dir;
                            updateIcon();
                        }
                    }, { passive: true });
                });
            }, 800);

            let scrollAnim = null;

            scrollBtn.addEventListener('click', () => {
                const el = getActiveScrollTarget();
                const startY = el.scrollTop;
                const maxScroll = el.scrollHeight - el.clientHeight;
                const direction = startY >= maxScroll - 2 ? 'up' : (startY <= 2 ? 'down' : scrollDir);
                const endY = direction === 'down' ? maxScroll : 0;
                const distance = endY - startY;
                if (Math.abs(distance) < 2) return;

                // Cancel any running animation
                if (scrollAnim) cancelAnimationFrame(scrollAnim);

                const duration = Math.min(1200, Math.max(400, Math.abs(distance) / 2));
                const startTime = performance.now();

                const animate = (now) => {
                    const elapsed = now - startTime;
                    const progress = Math.min(1, elapsed / duration);
                    // easeInOutCubic
                    const eased = progress < 0.5
                        ? 4 * progress * progress * progress
                        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
                    el.scrollTop = startY + distance * eased;
                    if (progress < 1) {
                        scrollAnim = requestAnimationFrame(animate);
                    }
                };

                scrollAnim = requestAnimationFrame(animate);
            });
        }

    }

    function setupSidebarTabs() {
        const tabDirectory = document.getElementById('tab-directory');
        const tabRecent = document.getElementById('tab-recent');
        const directoryTree = document.getElementById('directory-tree');
        const recentFilesMobile = document.getElementById('recent-files-mobile');

        if (tabDirectory && tabRecent) {
            tabDirectory.addEventListener('click', () => {
                tabDirectory.classList.add('active');
                tabRecent.classList.remove('active');
                directoryTree.classList.add('active');
                recentFilesMobile.classList.remove('active');
            });

            tabRecent.addEventListener('click', () => {
                tabRecent.classList.add('active');
                tabDirectory.classList.remove('active');
                recentFilesMobile.classList.add('active');
                directoryTree.classList.remove('active');
            });
        }
    }

    function applySettings(s) {
        if (!s) return;
    }

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        try {
            const registration = await navigator.serviceWorker.register('/service-worker.js', {
                updateViaCache: 'none'
            });

            // Check for updates immediately and every 5 minutes
            const checkUpdate = async () => {
                try {
                    await registration.update();
                    if (registration.waiting) {
                        // New SW is waiting; tell it to skip waiting
                        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                    }
                } catch (e) { /* ignore */ }
            };
            checkUpdate();
            setInterval(checkUpdate, 5 * 60 * 1000);

            // Also check when app becomes visible (PWA wake from background)
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') checkUpdate();
            });

            // Handle update notifications from SW
            let updateToastEl = null;
            navigator.serviceWorker.addEventListener('message', (event) => {
                const { type, version } = event.data || {};

                if (type === 'UPDATE_AVAILABLE') {
                    // Show a persistent toast; clicking it reloads the page
                    if (updateToastEl) toaster.hide(updateToastEl);
                    updateToastEl = toaster.show(
                        `新版本 ${version} 可用，点击刷新`,
                        'info',
                        true,
                        0,
                        () => window.location.reload()
                    );
                } else if (type === 'CACHE_INSTALLED') {
                    toaster.show('已缓存，离线可用', 'success', false, 3000);
                }
            });

            // If a new SW is already waiting when we load, prompt immediately
            if (registration.waiting) {
                registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            }

            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                newWorker?.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        // New SW installed but waiting; skip waiting so it activates
                        newWorker.postMessage({ type: 'SKIP_WAITING' });
                    }
                });
            });
        } catch (error) {
            console.warn('Service worker registration failed:', error);
        }
    }

    async function loadAppConfig() {
        try {
            if (!navigator.onLine) return;
            const config = await (await fetch('/api/config')).json();
            _siteTitle = config.siteTitle;
            if (!isReadingMode) setHeaderTitle(_siteTitle);
        } catch (err) {
            console.warn('Error loading config:', err);
        }
    }

    const initializeApp = async () => {
        const startsInThoughts = window.location.hash === '#thoughts';
        addEventListeners();
        appSettings = settingsManager.loadSettings();
        if (startsInThoughts) {
            await ensureThoughtsManager();
        } else {
            await ensureEditor();
            hydrateStartupCache();
            scheduleIdleTask(() => {
                ensureThoughtsManager().catch(() => {});
            });
        }
        loadAppConfig();
        await loadNotepads({ loadCurrentNote: !startsInThoughts });
        if (!startsInThoughts) await syncCurrentDirtyNote();
        applySettings(appSettings);
        await registerServiceWorker();
        isInitialLoad = false;
    };

    initializeApp();
});
