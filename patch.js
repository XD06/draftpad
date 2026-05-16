const fs = require('fs');

let content = fs.readFileSync('public/app.js', 'utf8');

content = content.replace(
    /import \{ PreviewManager \} from '\.\/managers\/preview\.js';\r?\nimport \{ marked \} from '\/js\/marked\/marked\.esm\.js';/,
    `import { renderSidebar, renderRecentFiles, trackRecentFile } from './sidebar.js';`
);

content = content.replace(
    /const editorContainer = document\.getElementById\('editor-container'\);\r?\n\s*const editor = document\.getElementById\('editor'\);\r?\n\s*const previewContainer = document\.getElementById\('preview-container'\);\r?\n\s*const previewPane = document\.getElementById\('preview-pane'\);/,
    `window.vditor = null;
    let isVditorReady = false;
    const editor = { 
        get value() { return window.vditor && isVditorReady ? window.vditor.getValue() : ''; }, 
        set value(val) { if (window.vditor && isVditorReady) { window.vditor.setValue(val || ''); } }, 
        focus: () => { if (window.vditor) window.vditor.focus(); }, 
        addEventListener: () => {} 
    };`
);

content = content.replace(
    /\/\/ Initialize preview manager[\s\S]*?previewManager\.DEBUG = DEBUG;/,
    `const previewManager = { 
        getPreviewMode: () => false, 
        updatePreviewIfActive: () => {}, 
        updateHighlightTheme: (theme) => { if (window.vditor && isVditorReady) window.vditor.setTheme(theme === 'dark' ? 'dark' : 'classic'); }, 
        updatePreviewStyles: () => {}, 
        toggleMarkdownPreview: () => {}, 
        preparePrintContent: () => ({ formattedContent: window.vditor && isVditorReady ? window.vditor.getHTML() : '', mainStyles: '', previewStyles: '', highlightStyles: '', printStyles: '' }) 
    };`
);

content = content.replace(
    /\/\/ Helper function to handle tab indentation[\s\S]*?function addEditorEventListeners\(\) \{[\s\S]*?\}\r?\n    \}/,
    `function initVditor() { 
        window.vditor = new Vditor('vditor', { 
            mode: 'ir', 
            height: '100%', 
            outline: { enable: false }, 
            cache: { enable: false }, 
            toolbarConfig: { hide: true }, 
            theme: currentTheme === 'dark' ? 'dark' : 'classic', 
            input: (value) => { 
                if (collaborationManager && collaborationManager.isReceivingUpdate) return; 
                debouncedSave(value); 
                if (collaborationManager && collaborationManager.ws && collaborationManager.ws.readyState === WebSocket.OPEN) { 
                    collaborationManager.ws.send(JSON.stringify({ type: 'update', notepadId: currentNotepadId, content: value })); 
                } 
            }, 
            after: () => { 
                isVditorReady = true; 
            } 
        }); 
    }

    function addEditorEventListeners() { initVditor(); }`
);

content = content.replace(
    /\/\/ Load notes\r?\n\s*async function loadNotes.*?catch \(err\) \{.*?\r?\n\s*\};/s,
    `// Load notes
    async function loadNotes(notepadId) { 
        try { 
            const response = await fetchWithPin('/api/notes/' + notepadId); 
            const data = await response.json(); 
            previousEditorValue = data.content; 
            const trySetValue = () => { 
                if (window.vditor && isVditorReady) { 
                    window.vditor.setValue(data.content || ''); 
                } else { 
                    setTimeout(trySetValue, 100); 
                } 
            }; 
            trySetValue(); 
            const currentNotepad = currentNotepads.find(n => n.id === notepadId); 
            if (currentNotepad) trackRecentFile(currentNotepad); 
            renderSidebar(currentNotepads, currentNotepadId, selectNotepad); 
            renderRecentFiles(currentNotepadId, selectNotepad); 
        } catch (err) { 
            console.error('Error loading notes:', err); 
        } 
    };`
);

content = content.replace(
    /function addEventListeners\(\) \{/,
    `function addEventListeners() {
        document.getElementById('toggle-sidebar-left')?.addEventListener('click', () => { 
            document.getElementById('sidebar-left').style.display = document.getElementById('sidebar-left').style.display === 'none' ? 'flex' : 'none'; 
        });
        document.getElementById('toggle-sidebar-right')?.addEventListener('click', () => { 
            document.getElementById('sidebar-right').style.display = document.getElementById('sidebar-right').style.display === 'none' ? 'flex' : 'none'; 
        });`
);

fs.writeFileSync('public/app.js', content, 'utf8');
console.log('Refactoring complete');
