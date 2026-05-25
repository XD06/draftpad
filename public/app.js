import { OperationsManager, OperationType } from './managers/operations.js';
import { CollaborationManager } from './managers/collaboration.js';
import { ToastManager } from './managers/toaster.js';
import StorageManager from './managers/storage.js';
import SettingsManager from './managers/settings.js'
import ConfirmationManager from './managers/confirmation.js';
import { renderSidebar, renderRecentFiles, trackRecentFile, updateSidebarSelection } from './sidebar.js';
import { HybridMarkdownEditor } from './hybrid-editor.js';
import { ThoughtsManager } from './managers/thoughts.js';
import { marked } from '/js/marked/marked.esm.js';

document.addEventListener('DOMContentLoaded', async () => {
    const DEBUG = false;
    const THEME_KEY = 'dumbpad_theme';
    let appSettings = {};
    let isApplyingRemoteUpdate = false;
    let editorInstance = null;

    const editor = {
        get value() { return editorInstance ? editorInstance.getValue() : ''; },
        set value(val) { if (editorInstance) editorInstance.setValue(val || ''); },
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
    const settingsEnableRemoteConnectionMessages = document.getElementById('settings-remote-connection-messages');

    let saveTimeout;
    let lastSaveTime = Date.now();
    const SAVE_INTERVAL = 2000;
    let currentNotepadId = 'default';
    let currentNotepads = []; 
    let isInitialLoad = true;
    let notepadIdToDelete = null;
    let notepadIdToRename = null;
    let _siteTitle = 'DumbPad';
    let isReadingMode = false;

    function setHeaderTitle(text) {
        const h1 = document.getElementById('header-title')?.querySelector('h1');
        if (h1) { h1.textContent = text; h1.title = text; }
    }

    function applyReadingModeTitle() {
        const name = getCurrentNotepadName();
        setHeaderTitle(name);
    }

    // Initialize managers
    const operationsManager = new OperationsManager();
    operationsManager.DEBUG = DEBUG;
    
    // Stub CursorManager since Vditor manages its own cursor
    const cursorManager = { 
        handleUserDisconnection: () => {}, 
        updateCursorPosition: () => {}, 
        updateAllCursors: () => {},
        cleanup: () => {},
        DEBUG: DEBUG 
    };

    const storageManager = new StorageManager();
    let currentTheme = storageManager.load(THEME_KEY);
    const settingsManager = new SettingsManager(storageManager, applySettings);
    const confirmationManager = new ConfirmationManager();
    const thoughtsManager = new ThoughtsManager({ toaster, confirmationManager });
    
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
        preparePrintContent: () => ({ formattedContent: marked.parse(editor.value), mainStyles: '', previewStyles: '', highlightStyles: '', printStyles: '' }) 
    };

    // Generate user ID and color for collaboration
    const userId = Math.random().toString(36).substring(2, 15);
    window.userId = userId; 
    const userColor = getRandomColor(userId);

    let collaborationManager = new CollaborationManager({
        userId,
        userColor,
        currentNotepadId,
        operationsManager,
        editor,
        onNotepadChange: loadNotepads,
        onUserDisconnect: (id) => cursorManager.handleUserDisconnection(id),
        onCursorUpdate: (id, pos, col) => cursorManager.updateCursorPosition(id, pos, col),
        settingsManager,
        toaster,
        confirmationManager,
        saveNotes,
        renameNotepad,
        addCopyLangButtonsToCodeBlocks: () => previewManager.addCopyLangButtonsToCodeBlocks()
    });
    collaborationManager.DEBUG = DEBUG;
    collaborationManager.setupWebSocket();
    previewManager.collaborationManager = collaborationManager;

    // Helper functions
    function getRandomColor(userId) {
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD', '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#27AE60', '#F1C40F', '#E74C3C'];
        let hash = 0;
        for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    }

    async function fetchWithPin(url, options = {}) {
        options.credentials = 'same-origin';
        try {
            return await fetch(url, options); 
        } catch (error) {
            console.error(error);
            toaster.show(error, "error", true);
        }
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

    function handleQueryParameterSelection(notepadsList, defaultId) {
        if (!isInitialLoad) return defaultId;
        const id = new URLSearchParams(window.location.search).get('id');
        if (id) {
            const found = notepadsList.find(n => n.id === id || n.name.toLowerCase() === id.toLowerCase());
            if (found) return found.id;
            toaster.show(`Notepad '${id}' not found`, 'error');
        }
        return defaultId;
    }

    async function loadNotepads() {
        try {
            const response = await fetchWithPin('/api/notepads');
            const data = await response.json();
            currentNotepads = data.notepads_list;
            renderSidebar(currentNotepads, currentNotepadId, selectNotepad, deleteNotepadById, renameNotepadById);
            
            currentNotepadId = handleQueryParameterSelection(currentNotepads, data['note_history']);
            if (collaborationManager) {
                if (currentNotepads.some(n => n.id === currentNotepadId)) await selectNotepad(currentNotepadId);
                else currentNotepadId = await selectNextNotepad(false);
            }
        } catch (err) {
            console.error('Error loading notepads:', err);
        }
    }

    let loadingNotepadId = null;
    async function loadNotes(notepadId) { 
        if (loadingNotepadId === notepadId) return; // Prevent redundant loading
        loadingNotepadId = notepadId;
        try { 
            const response = await fetchWithPin('/api/notes/' + notepadId); 
            const data = await response.json(); 
            if (loadingNotepadId !== notepadId) return;

            editor.value = data.content || '';

            const currentNotepad = currentNotepads.find(n => n.id === notepadId); 
            if (currentNotepad) trackRecentFile(currentNotepad); 
            
            updateSidebarSelection(notepadId);
            renderRecentFiles(notepadId, currentNotepads, selectNotepad, deleteNotepadById, renameNotepadById); 
        } catch (err) { 
            console.error('Error loading notes:', err); 
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
        tocList.innerHTML = toc.map(item => `
            <div class="toc-item h${item.level}" data-index="${item.index}">
                ${item.text}
            </div>
        `).join('');

        tocList.querySelectorAll('.toc-item').forEach(el => {
            el.onclick = () => {
                const index = parseInt(el.dataset.index);
                // Only focus/edit if NOT in reading mode
                if (!editor.isReadingMode) {
                    editorInstance.focusLine(index, 0);
                }
                setTimeout(() => {
                    const target = document.querySelector(`[data-line="${index}"]`);
                    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }, 50);
            };
        });
    }

    function initEditor() { 
        editorInstance = new HybridMarkdownEditor(document.getElementById('hybrid-editor'), {
            input: (value) => {
                if (collaborationManager && collaborationManager.isReceivingUpdate) return;
                if (isApplyingRemoteUpdate) return;
                debouncedSave(value);
                debouncedUpdateToC();
                clearTimeout(remoteUpdateTimeout);
                remoteUpdateTimeout = setTimeout(() => {
                    if (collaborationManager && collaborationManager.ws && collaborationManager.ws.readyState === WebSocket.OPEN) { 
                        collaborationManager.ws.send(JSON.stringify({ type: 'update', notepadId: currentNotepadId, content: value, userId })); 
                    }
                }, 700);
            }
        });
    }

    async function createNotepad() {
        try {
            const response = await fetchWithPin('/api/notepads', { method: 'POST' });
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
            await loadNotepads();
            await selectNotepad(newNotepad.id);
            toaster.show(`New notepad: ${newNotepad.name}`, 'success');
        } catch (err) {
            console.error('Error creating notepad:', err);
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
        try {
            const response = await fetchWithPin(`/api/notepads/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
            });
            const result = await response.json();
            await loadNotepads();
            if (currentNotepadId === id) {
                updateUrlWithNotepad(result.name);
            }
            if (collaborationManager.ws && collaborationManager.ws.readyState === WebSocket.OPEN) {
                collaborationManager.ws.send(JSON.stringify({ type: 'notepad_rename', notepadId: id, newName: result.name }));
            }
            hideModal(renameModal);
            toaster.show('Renamed notepad');
        } catch (err) {
            console.error('Error renaming notepad:', err);
            toaster.show('Error renaming notepad', 'error', true);
        }
    }

    async function saveNotes(content, isAutoSave, showStatus = true) {
        try {
            if (!currentNotepadId) return;
            await fetchWithPin(`/api/notes/${currentNotepadId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, userId }),
            });
            lastSaveTime = Date.now();
            if (showStatus) {
                if (isAutoSave) {
                    const settings = settingsManager.getSettings();
                    toaster.show('Saved', 'success', false, settings.saveStatusMessageInterval); 
                } else toaster.show('Saved');
            }
        } catch (err) {
            console.error('Error saving notes:', err);
            toaster.show('Error saving', 'error', false, 3000);
        }
    }

    function debouncedSave(content) {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            await saveNotes(content, true);
        }, 300);
    }

    async function deleteNotepad() {
        if (!currentNotepadId) return;
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
        if (messageEl) messageEl.textContent = `Are you sure you want to delete '${notepad.name}'? This action cannot be undone.`;
        showModal(deleteModal, deleteCancel);
    }

    async function doDeleteNotepad() {
        if (!notepadIdToDelete) return;
        const id = notepadIdToDelete;
        try {
            const notepad = currentNotepads.find(n => n.id === id);
            await fetchWithPin(`/api/notepads/${id}`, { method: 'DELETE' });
            if (notepad && collaborationManager.ws && collaborationManager.ws.readyState === WebSocket.OPEN) {
                collaborationManager.ws.send(JSON.stringify({ type: 'notepad_delete', notepadId: id, notepadName: notepad.name }));
            }
            await loadNotepads();
            if (currentNotepadId === id) {
                await selectNotepad('default');
            }
            deleteModal.classList.remove('visible');
            notepadIdToDelete = null;
            toaster.show('Notepad deleted');
        } catch (err) {
            console.error('Error deleting notepad:', err);
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

    async function exportAllAsZip() {
        if (typeof JSZip === 'undefined') {
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
    async function selectNotepad(id, query = "") {
        const token = ++selectionToken;
        currentNotepadId = id;
        collaborationManager.currentNotepadId = id;
        
        // --- UI Visibility ---
        const emptyState = document.getElementById('empty-state');
        const hybridEditor = document.getElementById('hybrid-editor');
        if (id) {
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

        await loadNotes(id);
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
                this.input.focus();
                this.search();
            },

            close() {
                this.isActive = false;
                this.overlay.classList.remove('active');
            },

            search() {
                const query = this.input.value.toLowerCase();
                const results = currentNotepads.filter(n => n.name.toLowerCase().includes(query))
                                       .slice(0, 8);
                
                this.render(results);
            },

            render(items) {
                this.selectedIndex = 0;
                this.results.innerHTML = items.map((item, index) => `
                    <div class="command-item ${index === 0 ? 'selected' : ''}" data-id="${item.id}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        <span>${item.name}</span>
                        <kbd>Enter</kbd>
                    </div>
                `).join('');

                const els = this.results.querySelectorAll('.command-item');
                els.forEach((el, index) => {
                    el.onclick = () => {
                        selectNotepad(el.dataset.id);
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
            }
        };

        commandPalette.init();
        const searchOpenBtn = document.getElementById('search-open');
        searchOpenBtn?.addEventListener('click', () => commandPalette.open());

        copyAllBtn.addEventListener('click', async () => {
            const raw = editor.value;
            if (!raw) return toaster.show('Nothing to copy', 'info');

            // Render markdown to HTML
            const temp = document.createElement('div');
            temp.innerHTML = marked.parse(raw);

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
            settingsButton.addEventListener('click', () => { settingsManager.loadSettings(); showModal(settingsModal, settingsInputAutoSaveStatusInterval); });
        }
        if (settingsCancel) settingsCancel.addEventListener('click', () => hideModal(settingsModal));
        if (settingsSave) settingsSave.addEventListener('click', () => { settingsManager.saveSettings(); hideModal(settingsModal, 'Settings Saved'); });
        
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

        themeToggle.addEventListener('click', () => {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', currentTheme);
            previewManager.updateHighlightTheme(currentTheme);
            storageManager.save(THEME_KEY, currentTheme);
        });

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

        document.getElementById('mobile-menu-toggle')?.addEventListener('click', () => {
            const isVisible = sidebarLeft.classList.toggle('visible');
            overlay?.classList.toggle('visible', isVisible);
        });

        document.getElementById('close-sidebar-left')?.addEventListener('click', () => {
            sidebarLeft.classList.remove('visible');
            overlay?.classList.remove('visible');
        });

        overlay?.addEventListener('click', () => {
            sidebarLeft.classList.remove('visible');
            overlay.classList.remove('visible');
        });

        setupSidebarTabs();

        initEditor();

        if (readModeBtn) {
            updateReadingMode(false); // Apply saved reading mode state after editor initialization
        }

        // Scroll Helper Logic
        let scrollAction = 'bottom';
        let scrollHideTimer;
        const scroller = editorInstance.scroller;
        
        if (scroller && scrollBtn) {
            scroller.addEventListener('scroll', () => {
                // Hide actions while scrolling
                if (floatingActions) {
                    floatingActions.classList.add('scrolling');
                    clearTimeout(scrollHideTimer);
                    scrollHideTimer = setTimeout(() => {
                        floatingActions.classList.remove('scrolling');
                    }, 600);
                }

                const totalScrollable = scroller.scrollHeight - scroller.clientHeight;
                if (totalScrollable <= 0) return;
                
                const progress = scroller.scrollTop / totalScrollable;
                if (progress < 0.5) {
                    if (scrollAction !== 'bottom') {
                        scrollBtn.innerHTML = `
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M7 13l5 5 5-5M7 6l5 5 5-5"></path>
                            </svg>`;
                        scrollAction = 'bottom';
                    }
                } else {
                    if (scrollAction !== 'top') {
                        scrollBtn.innerHTML = `
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M7 11l5-5 5 5M7 18l5-5 5 5"></path>
                            </svg>`;
                        scrollAction = 'top';
                    }
                }
            });

            scrollBtn.addEventListener('click', () => {
                if (scrollAction === 'bottom') {
                    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
                } else {
                    scroller.scrollTo({ top: 0, behavior: 'smooth' });
                }
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
        if (previewManager.toggleMarkdownPreview) previewManager.toggleMarkdownPreview(false, s.defaultMarkdownPreviewMode || 'off', false);
    }

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        try {
            const registration = await navigator.serviceWorker.register('/service-worker.js');

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

    const initializeApp = async () => {
        addEventListeners();
        appSettings = settingsManager.loadSettings();
        try {
            const config = await (await fetch('/api/config')).json();
            _siteTitle = config.siteTitle;
            if (!isReadingMode) setHeaderTitle(_siteTitle);
            await loadNotepads();
        } catch (err) { console.error(err); }
        applySettings(appSettings);
        await registerServiceWorker();
        isInitialLoad = false;
    };

    initializeApp();
});
