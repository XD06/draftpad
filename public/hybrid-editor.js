import { marked } from '/js/marked/marked.esm.js';
// We'll try to load hljs dynamically
let hljs;
import('/js/@highlightjs/highlight.min.js')
    .then(module => { hljs = module.default; })
    .catch(e => console.warn('hljs not found for hybrid editor'));

const EMPTY_LINE = '\u00a0';

export class HybridMarkdownEditor {
    constructor(container, { input } = {}) {
        this.container = container;
        this.onInput = input || (() => { });
        this.lines = [''];
        this.activeLine = -1; // -1 means no line is currently being edited
        this.activeColumn = 0;
        this.renderToken = 0;
        this.renderCache = new Map();
        this.isReadingMode = false;
        this.headingIds = [];
        this.currentSelectionData = null;
        this.headingLineBySlug = new Map();
        this.codeBlockLines = new Set();
        this.tableBlocks = new Map(); // startIndex -> endIndex
        this.lineInTable = new Map(); // index -> startIndex
        this.codeBlocks = new Map();  // startIndex -> endIndex
        this.lineInCode = new Map();  // index -> startIndex
        this.activeBlock = null; // { type, start, end }
        this.renderCache = new Map();
        this.listeners = new Map();

        // History for undo/redo
        this.history = [];
        this.historyIndex = -1;
        this.maxHistory = 100;
        this.isUndoing = false;

        this.scroller = document.createElement('div');
        this.scroller.className = 'hybrid-editor-scroller';
        this.container.innerHTML = '';
        this.container.appendChild(this.scroller);

        this.container.addEventListener('click', (event) => {
            if (this.isReadingMode) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return;

            if (event.target === this.container || event.target === this.scroller) {
                this.focusLine(Math.max(0, this.lines.length - 1), this.lines[this.lines.length - 1]?.length || 0);
            }
        });

        this.setupGlobalShortcuts();
        this.setupSelectionMenu();

        if (window.mermaid) {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            mermaid.initialize({
                startOnLoad: false,
                theme: isDark ? 'dark' : 'default',
                securityLevel: 'loose',
                fontFamily: 'inherit'
            });
        }
    }

    getValue() {
        return this.lines.join('\n');
    }

    setValue(value = '', emit = true) {
        this.lines = String(value).split('\n');
        if (this.lines.length === 0) this.lines = [''];
        this.activeLine = -1; // Reset to preview mode by default
        this.activeColumn = 0;
        this.activeBlock = null;
        this.buildHeadingIndex();
        this.renderAll();
        if (emit) this.emitInput();
    }

    focus() {
        this.focusLine(this.activeLine, this.activeColumn);
    }

    jumpToKeyword(keyword) {
        if (!keyword) return;
        const lowKeyword = keyword.toLowerCase();
        for (let i = 0; i < this.lines.length; i++) {
            const idx = this.lines[i].toLowerCase().indexOf(lowKeyword);
            if (idx !== -1) {
                this.focusLine(i, idx);
                requestAnimationFrame(() => {
                    const el = this.scroller.querySelector(`[data-line="${i}"]`);
                    if (el) {
                        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        el.classList.add('is-jump-target');
                        setTimeout(() => el.classList.remove('is-jump-target'), 2000);
                    }
                });
                return;
            }
        }
    }

    get selectionStart() {
        return this.offsetFromLineColumn(this.activeLine, this.activeColumn);
    }

    get selectionEnd() {
        return this.selectionStart;
    }

    setSelectionRange(start) {
        const pos = this.lineColumnFromOffset(start || 0);
        this.focusLine(pos.line, pos.column);
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
        this.listeners.get(type)?.delete(handler);
    }

    dispatch(type, detail = {}) {
        this.listeners.get(type)?.forEach(handler => handler({ type, target: this, ...detail }));
    }

    getHTML() {
        return marked.parse(this.getValue());
    }

    renderMarkdownLine(text, index) {

        const isCodeBlock = this.codeBlockLines.has(index);

        if (!text && !isCodeBlock) return `<p class="md-empty">${EMPTY_LINE}</p>`;



        if (isCodeBlock) {
            const blockStart = this.lineInCode.get(index);
            const blockEnd = this.codeBlocks.get(blockStart);
            const isAnyRowActive = (this.activeLine >= blockStart && this.activeLine <= blockEnd);

            if (!isAnyRowActive) {
                if (index === blockStart) {
                    const blockContent = this.lines.slice(blockStart, blockEnd + 1).join('\n');
                    const langMatch = this.lines[blockStart]?.match(/```(\w+)/);
                    const lang = langMatch ? langMatch[1] : '';

                    let html = `<div class="md-code-block">`;
                    if (lang) html += `<div class="md-code-lang">${lang}</div>`;

                    if (lang === 'mermaid') {
                        const content = this.lines.slice(blockStart + 1, blockEnd).join('\n');
                        html += `<div class="mermaid-block"><div class="mermaid">${this.escapeHtml(content)}</div></div>`;
                    } else {
                        html += marked.parse(blockContent);
                    }
                    html += `</div>`;
                    return html;
                }
                return ''; // Placeholder
            }
            const isFence = text?.trim().startsWith('```');
            if (isFence) {
                return `<div class="md-code-fence">${this.escapeHtml(text || '')}</div>`;
            }

            let highlighted = this.escapeHtml(text || '');
            if (hljs) {
                try {
                    const lang = this.getLanguageAtLine(index);
                    if (lang && hljs.getLanguage(lang)) {
                        highlighted = hljs.highlight(text || '', { language: lang }).value;
                    } else {
                        highlighted = hljs.highlightAuto(text || '').value;
                    }
                } catch (e) { }
            }
            return `<div class="md-code-line">${highlighted}</div>`;
        }

        if (this.lineInTable.has(index)) {
            const tableStart = this.lineInTable.get(index);
            const tableEnd = this.tableBlocks.get(tableStart);
            const isAnyRowActive = (this.activeLine >= tableStart && this.activeLine <= tableEnd);

            if (!isAnyRowActive) {
                if (index === tableStart) {
                    const tableContent = this.lines.slice(tableStart, tableEnd + 1).join('\n');
                    return `<div class="md-table-block" data-start="${tableStart}">${marked.parse(tableContent)}</div>`;
                }
                return '';
            }
        }

        const headingId = this.headingIds[index] || '';
        const cacheKey = `${headingId}:${text}:${this.isReadingMode}`;
        if (this.renderCache.size > 1500) this.renderCache.clear();
        if (this.renderCache.has(cacheKey)) return this.renderCache.get(cacheKey);

        let marks = [];
        let textForMarked = text;
        const replaceMark = (regex, type) => {
            textForMarked = textForMarked.replace(regex, (match, ...groups) => {
                let id = marks.length;
                marks.push({ type, raw: match, groups });
                return `@@MARK_TOKEN_${id}@@`;
            });
        };

        replaceMark(/<mark note="([^"]+)">(.+?)<\/mark>/g, 'annotation');
        replaceMark(/==(.+?)==\{(?:用户批注:\s*)?(.*?)\}/g, 'annotation_legacy');
        replaceMark(/==(.+?)==/g, 'highlight');
        replaceMark(/<mark>(.+?)<\/mark>/g, 'mark');

        let html = marked.parse(textForMarked);
        html = html.trim() || `<p>${EMPTY_LINE}</p>`;

        const parseInline = (str) => {
            return marked.parse(str).replace(/^<p>|<\/p>\n?$/g, '');
        };

        html = html.replace(/@@MARK_TOKEN_(\d+)@@/g, (match, idStr) => {
            let m = marks[parseInt(idStr, 10)];
            if (!m) return match;

            const raw = btoa(encodeURIComponent(m.raw));
            if (m.type === 'annotation') {
                const comment = this.escapeAttribute(m.groups[0]);
                const textInner = m.groups[1];
                const badge = `<span class="annotation-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>`;
                return `<span class="has-annotation" data-raw="${raw}" data-text="${this.escapeAttribute(textInner)}" data-comment="${comment}">${parseInline(textInner)}${badge}</span>`;
            } else if (m.type === 'annotation_legacy') {
                const textInner = m.groups[0];
                const comment = this.escapeAttribute(m.groups[1]);
                const badge = `<span class="annotation-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>`;
                return `<span class="has-annotation" data-raw="${raw}" data-text="${this.escapeAttribute(textInner)}" data-comment="${comment}">${parseInline(textInner)}${badge}</span>`;
            } else if (m.type === 'highlight') {
                return `<mark class="md-highlight" data-raw="${raw}" data-text="${this.escapeAttribute(m.groups[0])}">${parseInline(m.groups[0])}</mark>`;
            } else if (m.type === 'mark') {
                return `<mark class="md-mark" data-raw="${raw}" data-text="${this.escapeAttribute(m.groups[0])}">${parseInline(m.groups[0])}</mark>`;
            }
        });

        if (headingId) {
            html = html.replace(/<(h[1-6])([^>]*)>/i, `<$1$2 id="${this.escapeAttribute(headingId)}">`);
        }
        this.renderCache.set(cacheKey, html);
        return html;
    }

    renderAll() {
        const token = ++this.renderToken;
        this.scroller.innerHTML = '';
        const chunkSize = 180;
        let index = 0;

        const renderChunk = () => {
            if (token !== this.renderToken) return;
            const fragment = document.createDocumentFragment();
            const end = Math.min(index + chunkSize, this.lines.length);
            for (; index < end; index++) {
                fragment.appendChild(this.createLineElement(index));
            }
            this.scroller.appendChild(fragment);
            if (index < this.lines.length) {
                requestAnimationFrame(renderChunk);
            } else {
                this.renderMermaid();
                if (this.activeLine >= 0 && !token.noFocus) {
                    this.focusLine(this.activeLine, this.activeColumn, { preventScroll: true, noRerender: true });
                }
            }
        };

        renderChunk();
    }

    async renderMermaid() {
        if (!window.mermaid) return;
        // Wait a tiny bit for the DOM to settle
        setTimeout(async () => {
            try {
                // Find all mermaid divs that haven't been rendered yet
                const charts = this.scroller.querySelectorAll('.mermaid:not([data-processed="true"])');
                if (charts.length > 0) {
                    await mermaid.run({
                        nodes: charts
                    });
                }
            } catch (e) {
                console.error('Mermaid render failed:', e);
            }
        }, 50);
    }

    createLineElement(index) {
        const line = document.createElement('div');
        line.className = 'hybrid-line';
        line.dataset.line = String(index);

        // For blocks (table or code), only show the first line. Subsequent lines are hidden.
        // The first line will either render the whole block (if not active) or show a block-level textarea (if active).
        let isSubsequentBlockLine = false;
        if (this.activeBlock && index > this.activeBlock.start && index <= this.activeBlock.end) {
            isSubsequentBlockLine = true;
        } else if (this.lineInTable.has(index)) {
            const tableStart = this.lineInTable.get(index);
            if (index > tableStart) isSubsequentBlockLine = true;
        } else if (this.lineInCode.has(index)) {
            const blockStart = this.lineInCode.get(index);
            if (index > blockStart) isSubsequentBlockLine = true;
        }

        if (isSubsequentBlockLine) {
            line.style.display = 'none';
            return line;
        }

        if (this.codeBlockLines.has(index)) line.classList.add('is-code');
        if (this.lineInTable.has(index)) line.classList.add('is-table-row');

        line.addEventListener('click', (event) => {
            const badgeEl = event.target.closest('.annotation-badge');
            const markEl = event.target.closest?.('.has-annotation, .md-highlight, .md-mark');
            if (markEl && line.contains(markEl)) {
                event.preventDefault();
                event.stopPropagation();
                if (badgeEl) {
                    this.showAnnotationComment(markEl);
                } else {
                    this.showMarkActionMenu(index, markEl);
                }
                return;
            }

            const anchor = event.target.closest?.('a');
            if (anchor && line.contains(anchor)) {
                event.preventDefault();
                event.stopPropagation();
                this.handleAnchorClick(anchor);
                return;
            }

            if (this.isReadingMode) {
                return;
            }

            // Try to estimate the click position in characters
            const column = getCaretCharacterOffsetWithin(line, event.clientX, event.clientY);
            this.focusLine(index, column, { blockOffset: column });
        });

        if (this.activeBlock && index === this.activeBlock.start) {
            line.classList.add('is-active', 'is-block-editor');
            line.appendChild(this.createBlockTextarea(this.activeBlock));
        } else if (index === this.activeLine && !this.activeBlock) {
            line.classList.add('is-active');
            line.appendChild(this.createTextarea(index));
        } else {
            line.classList.add('is-rendered');
            if (this.codeBlockLines.has(index)) {
                if (!this.codeBlockLines.has(index - 1)) line.classList.add('is-code-start');
                if (!this.codeBlockLines.has(index + 1)) line.classList.add('is-code-end');
            }
            line.innerHTML = this.renderMarkdownLine(this.lines[index], index);
        }
        return line;
    }

    rerenderLine(index) {
        const oldLine = this.scroller.querySelector(`[data-line="${index}"]`);
        if (!oldLine) return;
        const newLine = this.createLineElement(index);
        oldLine.replaceWith(newLine);
        this.renderMermaid();
        return newLine;
    }

    rerenderRange(start, end) {
        // Find existing elements to replace
        const linesToReplace = [];
        for (let i = start; i <= end; i++) {
            const el = this.scroller.querySelector(`[data-line="${i}"]`);
            if (el) linesToReplace.push({ index: i, el });
        }

        linesToReplace.forEach(item => {
            const newLine = this.createLineElement(item.index);
            item.el.replaceWith(newLine);
        });
        this.renderMermaid();
    }

    rerenderFrom(startIndex) {
        const token = ++this.renderToken;
        const nodes = Array.from(this.scroller.querySelectorAll('.hybrid-line'));
        for (let i = nodes.length - 1; i >= startIndex; i--) nodes[i].remove();
        let index = startIndex;
        const chunkSize = 180;
        const renderChunk = () => {
            if (token !== this.renderToken) return;
            const fragment = document.createDocumentFragment();
            const end = Math.min(index + chunkSize, this.lines.length);
            for (; index < end; index++) fragment.appendChild(this.createLineElement(index));
            this.scroller.appendChild(fragment);
            if (index < this.lines.length) {
                requestAnimationFrame(renderChunk);
            } else {
                this.renderMermaid();
            }
        };
        renderChunk();
    }

    createTextarea(index) {
        const textarea = document.createElement('textarea');
        textarea.className = 'hybrid-source-line';
        textarea.rows = 1;
        textarea.spellcheck = true;
        textarea.value = this.lines[index] || '';
        textarea.addEventListener('input', (event) => this.handleInput(event));
        textarea.addEventListener('keydown', (event) => this.handleKeydown(event, textarea));
        textarea.addEventListener('paste', (event) => this.handlePaste(event, textarea));
        textarea.addEventListener('click', (event) => {
            event.stopPropagation();
            this.activeColumn = textarea.selectionStart || 0;
        });
        textarea.addEventListener('keyup', () => {
            this.activeColumn = textarea.selectionStart || 0;
        });
        requestAnimationFrame(() => {
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(this.activeColumn, this.activeColumn);
            this.autosize(textarea);
        });
        return textarea;
    }

    focusLine(index, column = 0, options = {}) {
        const previousLine = this.activeLine;
        const previousBlock = this.activeBlock;

        if (index < 0) {
            this.activeLine = -1;
            this.activeColumn = 0;
            this.activeBlock = null;
            if (previousBlock) this.rerenderRange(previousBlock.start, previousBlock.end);
            else if (previousLine >= 0) this.rerenderLine(previousLine);
            return;
        }

        index = Math.max(0, Math.min(index, this.lines.length - 1));
        this.activeLine = index;
        this.activeColumn = Math.max(0, Math.min(column, this.lines[index]?.length || 0));

        // Determine if we should enter a block mode
        let newBlock = null;
        if (this.lineInTable.has(index)) {
            const start = this.lineInTable.get(index);
            newBlock = { type: 'table', start, end: this.tableBlocks.get(start), clickLineIndex: index, clickOffset: options.blockOffset };
        } else if (this.codeBlockLines.has(index)) {
            let start = index;
            while (start > 0 && this.codeBlockLines.has(start - 1)) start--;
            let end = index;
            while (end < this.lines.length - 1 && this.codeBlockLines.has(end + 1)) end++;
            newBlock = { type: 'code', start, end, clickLineIndex: index, clickOffset: options.blockOffset };
        }

        this.activeBlock = newBlock;

        if (options.noRerender) return;

        if (previousBlock && (!newBlock || previousBlock.start !== newBlock.start)) {
            this.rerenderRange(previousBlock.start, previousBlock.end);
        }

        if (newBlock) {
            this.rerenderRange(newBlock.start, newBlock.end);
        } else {
            if (previousLine >= 0 && previousLine !== index) this.rerenderLine(previousLine);
            if (previousLine !== index) this.rerenderLine(index);
        }

        const current = this.scroller.querySelector(`[data-line="${newBlock ? newBlock.start : index}"]`);
        if (current && !options.preventScroll) current.scrollIntoView({ block: 'nearest' });
    }

    createBlockTextarea(block) {
        const textarea = document.createElement('textarea');
        textarea.className = 'hybrid-source-line hybrid-block-source';
        textarea.value = this.lines.slice(block.start, block.end + 1).join('\n');

        textarea.addEventListener('input', (event) => {
            const val = textarea.value;
            const newLines = val.split('\n');
            const oldCount = block.end - block.start + 1;
            this.lines.splice(block.start, oldCount, ...newLines);
            block.end = block.start + newLines.length - 1;
            this.buildHeadingIndex();
            this.emitInput();
            this.autosize(textarea);
        });

        textarea.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' || (event.key === 'Enter' && event.ctrlKey)) {
                event.preventDefault();
                this.activeBlock = null;
                this.renderAll();
            }
        });

        textarea.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        requestAnimationFrame(() => {
            textarea.focus({ preventScroll: true });

            let offset = 0;
            if (typeof block.clickOffset === 'number') {
                offset = block.clickOffset;
            } else if (block.clickLineIndex) {
                offset = this.lines.slice(block.start, block.clickLineIndex).join('\n').length + 1;
            }
            textarea.setSelectionRange(offset, offset);
            this.autosize(textarea);
        });
        return textarea;
    }

    handleKeydown(event, textarea) {
        const start = textarea.selectionStart || 0;
        const end = textarea.selectionEnd || start;
        this.activeColumn = start;

        if (event.key === 'Enter') {
            event.preventDefault();
            const before = textarea.value.slice(0, start);
            const after = textarea.value.slice(end);
            this.lines[this.activeLine] = before;
            this.lines.splice(this.activeLine + 1, 0, after);
            this.activeLine += 1;
            this.activeColumn = 0;
            this.buildHeadingIndex();
            this.emitInput();
            this.rerenderFrom(this.activeLine - 1);
            return;
        }

        if (event.key === 'Backspace' && start === 0 && end === 0 && this.activeLine > 0) {
            event.preventDefault();
            const prevLength = this.lines[this.activeLine - 1].length;
            this.lines[this.activeLine - 1] += this.lines[this.activeLine];
            this.lines.splice(this.activeLine, 1);
            this.activeLine -= 1;
            this.activeColumn = prevLength;
            this.buildHeadingIndex();
            this.emitInput();
            this.rerenderFrom(this.activeLine);
            return;
        }

        if (event.key === 'Delete' && start === textarea.value.length && end === start && this.activeLine < this.lines.length - 1) {
            event.preventDefault();
            this.lines[this.activeLine] += this.lines[this.activeLine + 1];
            this.lines.splice(this.activeLine + 1, 1);
            this.buildHeadingIndex();
            this.emitInput();
            this.rerenderFrom(this.activeLine);
            return;
        }

        if (event.key === 'ArrowUp' && this.activeLine > 0) {
            event.preventDefault();
            this.focusLine(this.activeLine - 1, Math.min(this.activeColumn, this.lines[this.activeLine - 1].length));
            return;
        }

        if (event.key === 'ArrowDown' && this.activeLine < this.lines.length - 1) {
            event.preventDefault();
            this.focusLine(this.activeLine + 1, Math.min(this.activeColumn, this.lines[this.activeLine + 1].length));
            return;
        }

        if (event.key === 'Tab') {
            event.preventDefault();
            const insert = '  ';
            textarea.value = textarea.value.slice(0, start) + insert + textarea.value.slice(end);
            textarea.setSelectionRange(start + insert.length, start + insert.length);
            textarea.dispatchEvent(new Event('input'));
        }
    }

    handleInput(event) {
        const textarea = event.target;
        const val = textarea.value.replace(/\r?\n/g, '');
        const index = this.activeLine;

        this.lines[index] = val;
        this.activeColumn = textarea.selectionStart || 0;
        this.buildHeadingIndex();
        this.autosize(textarea);
        this.saveHistory();
        this.emitInput();
        this.dispatch('change', { value: this.getValue() });
    }

    saveHistory() {
        if (this.isUndoing) return;
        const current = this.getValue();
        if (this.history[this.historyIndex] === current) return;

        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(current);
        if (this.history.length > this.maxHistory) this.history.shift();
        this.historyIndex = this.history.length - 1;
    }

    undo() {
        if (this.historyIndex > 0) {
            this.isUndoing = true;
            this.historyIndex--;
            this.setValue(this.history[this.historyIndex], true);
            this.isUndoing = false;
        }
    }

    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.isUndoing = true;
            this.historyIndex++;
            this.setValue(this.history[this.historyIndex], true);
            this.isUndoing = false;
        }
    }

    setupGlobalShortcuts() {
        document.addEventListener('keydown', (event) => {
            // If focused in another input/textarea that is NOT our editor, skip
            if (event.target.tagName === 'INPUT' || (event.target.tagName === 'TEXTAREA' && !event.target.closest('.hybrid-editor'))) {
                return;
            }

            const isCtrl = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();

            if (isCtrl && key === 'z') {
                event.preventDefault();
                if (event.shiftKey) this.redo();
                else this.undo();
            } else if (isCtrl && key === 'y') {
                event.preventDefault();
                this.redo();
            }
        });
    }

    getLanguageAtLine(index) {
        for (let i = index; i >= 0; i--) {
            const line = this.lines[i].trim();
            if (line.startsWith('```')) {
                const match = line.match(/^```([\w-]+)/);
                return match ? match[1] : null;
            }
        }
        return null;
    }

    handlePaste(event, textarea) {
        const text = event.clipboardData?.getData('text');
        if (!text || !text.includes('\n')) return;
        event.preventDefault();
        const start = textarea.selectionStart || 0;
        const end = textarea.selectionEnd || start;
        const pasted = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        const before = textarea.value.slice(0, start);
        const after = textarea.value.slice(end);
        pasted[0] = before + pasted[0];
        pasted[pasted.length - 1] += after;
        this.lines.splice(this.activeLine, 1, ...pasted);
        this.activeColumn = pasted[pasted.length - 1].length - after.length;
        this.activeLine += pasted.length - 1;
        this.buildHeadingIndex();
        this.emitInput();
        this.rerenderFrom(Math.max(0, this.activeLine - pasted.length + 1));
    }

    emitInput() {
        const value = this.getValue();
        this.onInput(value);
        this.dispatch('input', { value });
    }

    autosize(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.max(28, textarea.scrollHeight)}px`;
    }

    buildHeadingIndex() {
        this.headingIds = new Array(this.lines.length).fill('');
        this.codeBlockLines = new Set();
        this.codeBlocks = new Map();
        this.lineInCode = new Map();
        this.tableBlocks = new Map();
        this.lineInTable = new Map();
        this.headingLineBySlug = new Map();
        const seen = new Map();
        let inCodeBlock = false;

        // Detection state
        let tableStart = -1;
        let codeStart = -1;
        const isTableLine = (l) => /^\s*\|.+\|\s*$/.test(l) && l.trim().length > 2;
        const isTableDelimiter = (l) => /^\s*\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)*\|?\s*$/.test(l);

        this.lines.forEach((line, index) => {
            const trimmed = line.trim();

            // Code block logic
            if (trimmed.startsWith('```')) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeStart = index;
                } else {
                    inCodeBlock = false;
                    this.codeBlocks.set(codeStart, index);
                    for (let i = codeStart; i <= index; i++) {
                        this.codeBlockLines.add(i);
                        this.lineInCode.set(i, codeStart);
                    }
                    codeStart = -1;
                }
                return;
            }
            if (inCodeBlock) {
                return;
            }

            // Table block logic
            if (isTableLine(line)) {
                if (tableStart === -1) tableStart = index;
            } else {
                if (tableStart !== -1) {
                    // Check if it's a valid table (must have a delimiter line)
                    let hasDelimiter = false;
                    for (let i = tableStart; i < index; i++) {
                        if (isTableDelimiter(this.lines[i])) { hasDelimiter = true; break; }
                    }
                    if (hasDelimiter) {
                        this.tableBlocks.set(tableStart, index - 1);
                        for (let i = tableStart; i < index; i++) this.lineInTable.set(i, tableStart);
                    }
                    tableStart = -1;
                }
            }

            const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
            if (!match) return;
            const base = this.slugify(match[2]);
            if (!base) return;
            const count = seen.get(base) || 0;
            seen.set(base, count + 1);
            const slug = count === 0 ? base : `${base}-${count}`;
            this.headingIds[index] = slug;
            this.headingLineBySlug.set(slug, index);
        });
    }

    slugify(text) {
        return String(text)
            .replace(/<[^>]+>/g, '')
            .replace(/[`*_~[\]()]/g, '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[!"#$%&'()+,./:;<=>?@[\\\]^`{|}~]/g, '');
    }

    handleAnchorClick(anchor) {
        const href = anchor.getAttribute('href') || '';
        if (!href) return;
        const url = new URL(href, window.location.href);
        if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.hash) {
            const slug = this.slugify(decodeURIComponent(url.hash.slice(1)));
            const targetLine = this.headingLineBySlug.get(slug) ?? this.headingLineBySlug.get(decodeURIComponent(url.hash.slice(1)));
            if (targetLine !== undefined) {
                this.scrollToLine(targetLine);
                window.history.replaceState(null, '', url.hash);
            }
            return;
        }
        window.open(url.href, '_blank', 'noopener');
    }

    scrollToLine(index) {
        const target = this.scroller.querySelector(`[data-line="${index}"]`);
        if (!target) return;
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        target.classList.add('is-jump-target');
        setTimeout(() => target.classList.remove('is-jump-target'), 1000);
    }

    escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]);
    }


    escapeAttribute(value) {
        return this.escapeHtml(value);
    }

    offsetFromLineColumn(line, column) {
        let offset = 0;
        for (let i = 0; i < line; i++) offset += this.lines[i].length + 1;
        return offset + column;
    }

    lineColumnFromOffset(offset) {
        let remaining = Math.max(0, offset);
        for (let i = 0; i < this.lines.length; i++) {
            if (remaining <= this.lines[i].length) return { line: i, column: remaining };
            remaining -= this.lines[i].length + 1;
        }
        const line = this.lines.length - 1;
        return { line, column: this.lines[line].length };
    }

    setReadingMode(enabled) {
        this.isReadingMode = enabled;
        this.focusLine(-1); // Deactivate current line
        this.renderAll();

        if (enabled) {
            document.addEventListener('copy', this.handleCopy);
        } else {
            document.removeEventListener('copy', this.handleCopy);
        }
    }

    handleCopy = (event) => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        const container = document.createElement('div');
        container.appendChild(range.cloneContents());

        // Process annotations in the copied content
        const annotations = container.querySelectorAll('.has-annotation');
        annotations.forEach(node => {
            const comment = node.dataset.annotation;
            if (comment) {
                const noteText = document.createTextNode(` (${comment})`);
                node.appendChild(noteText);
            }
        });

        const text = container.innerText;
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
    }

    showAnnotationComment(el) {
        if (this.markPopover) {
            this.markPopover.remove();
        }

        const comment = el.dataset.comment || '';

        this.markPopover = document.createElement('div');
        this.markPopover.className = 'mark-popover comment-only-popover';

        let html = `<div class="mark-popover-inline-content">
            <div class="mark-popover-icon-box">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            </div>
            <div class="mark-popover-text">${this.escapeHtml(comment)}</div>
        </div>`;

        this.markPopover.innerHTML = html;
        document.body.appendChild(this.markPopover);

        const badge = el.querySelector('.annotation-badge');
        const rect = badge.getBoundingClientRect();
        requestAnimationFrame(() => {
            const popRect = this.markPopover.getBoundingClientRect();
            let left = rect.left + (rect.width / 2) - (popRect.width / 2);
            let top = rect.top - popRect.height - 6 + window.scrollY;

            if (top < window.scrollY + 10) {
                top = rect.bottom + 6 + window.scrollY;
            }

            if (left + popRect.width > window.innerWidth - 10) left = window.innerWidth - popRect.width - 10;
            if (left < 10) left = 10;

            this.markPopover.style.left = `${left}px`;
            this.markPopover.style.top = `${top}px`;
        });

        setTimeout(() => {
            const closeHandler = (e) => {
                if (this.markPopover && !this.markPopover.contains(e.target) && e.target !== badge) {
                    this.markPopover.remove();
                    this.markPopover = null;
                    document.removeEventListener('mousedown', closeHandler);
                    document.removeEventListener('touchstart', closeHandler);
                }
            };
            document.addEventListener('mousedown', closeHandler);
            document.addEventListener('touchstart', closeHandler);
        }, 10);
    }

    showMarkActionMenu(lineIndex, el) {
        if (this.markPopover) {
            this.markPopover.remove();
        }

        const type = el.classList.contains('has-annotation') ? 'annotation' :
            el.classList.contains('md-highlight') ? 'highlight' : 'mark';

        const rawMatch = decodeURIComponent(atob(el.dataset.raw));
        const text = el.dataset.text;
        const comment = el.dataset.comment || '';

        this.markPopover = document.createElement('div');
        this.markPopover.className = 'mark-popover';

        let html = '';
        if (type === 'annotation') {
            html += `<div class="mark-popover-actions" style="border:none; margin:0; padding:0;">
                <button class="edit-btn">编辑</button>
                <button class="delete-btn">取消批注</button>
            </div>`;
        } else {
            const typeName = type === 'highlight' ? '画线' : '高亮';
            html += `<div class="mark-popover-actions" style="border:none; margin:0; padding:0;">
                <button class="delete-btn">取消${typeName}</button>
            </div>`;
        }

        this.markPopover.innerHTML = html;
        document.body.appendChild(this.markPopover);

        const rect = el.getBoundingClientRect();
        requestAnimationFrame(() => {
            const popRect = this.markPopover.getBoundingClientRect();
            let left = rect.left + (rect.width / 2) - (popRect.width / 2);
            let top = rect.top - popRect.height - 6 + window.scrollY;

            if (top < window.scrollY + 10) {
                top = rect.bottom + 6 + window.scrollY;
            }

            if (left + popRect.width > window.innerWidth - 10) left = window.innerWidth - popRect.width - 10;
            if (left < 10) left = 10;

            this.markPopover.style.left = `${left}px`;
            this.markPopover.style.top = `${top}px`;
        });

        const deleteBtn = this.markPopover.querySelector('.delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                let lineContent = this.lines[lineIndex];
                this.lines[lineIndex] = lineContent.replace(rawMatch, text);
                this.rerenderLine(lineIndex);
                this.emitInput();
                this.markPopover.remove();
                this.markPopover = null;
            });
        }

        const editBtn = this.markPopover.querySelector('.edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.markPopover.innerHTML = `
                    <div class="mark-popover-edit" style="display:flex; flex-direction:column; gap:8px; min-width: 220px; box-sizing: border-box;">
                        <textarea rows="1" placeholder="输入批注内容..." style="width: 100%; box-sizing: border-box; background: transparent; border: 1px solid var(--border-color); color: var(--text-color); padding: 8px; border-radius: 6px; font-size: 13px; outline: none; resize: none; overflow: hidden; line-height: 1.5; max-height: 150px;"></textarea>
                        <div class="mark-popover-actions" style="border:none; margin:0; padding:0; justify-content: flex-end; width: 100%; box-sizing: border-box;">
                            <button class="cancel-btn">取消</button>
                            <button class="save-btn" style="color: var(--primary-color); font-weight: 600;">保存</button>
                        </div>
                    </div>
                `;
                
                const repositionEdit = () => {
                    // Reset position to top-left so the browser can calculate
                    // the element's true unconstrained width without viewport clipping
                    this.markPopover.style.left = '0px';
                    this.markPopover.style.top = '0px';
                    
                    // Force synchronous reflow to get accurate dimensions
                    void this.markPopover.offsetHeight;
                    
                    const freshRect = el.getBoundingClientRect();
                    const popRect = this.markPopover.getBoundingClientRect();
                    
                    let left = freshRect.left + (freshRect.width / 2) - (popRect.width / 2);
                    let top = freshRect.top - popRect.height - 6 + window.scrollY;
                    
                    if (top < window.scrollY + 10) top = freshRect.bottom + 6 + window.scrollY;
                    if (left + popRect.width > window.innerWidth - 10) left = window.innerWidth - popRect.width - 10;
                    if (left < 10) left = 10;
                    
                    this.markPopover.style.left = `${left}px`;
                    this.markPopover.style.top = `${top}px`;
                };

                repositionEdit();

                const textarea = this.markPopover.querySelector('textarea');
                textarea.value = comment;
                textarea.focus();

                const autoResize = () => {
                    textarea.style.height = 'auto';
                    textarea.style.height = textarea.scrollHeight + 'px';
                    repositionEdit(); // 文本框高度变化时重新计算位置，防止溢出屏幕外
                };
                textarea.addEventListener('input', autoResize);
                setTimeout(autoResize, 0);

                this.markPopover.querySelector('.cancel-btn').addEventListener('click', (ce) => {
                    ce.stopPropagation();
                    this.markPopover.remove();
                    this.markPopover = null;
                });

                this.markPopover.querySelector('.save-btn').addEventListener('click', (se) => {
                    se.stopPropagation();
                    const newComment = textarea.value.trim();
                    if (!newComment) return;
                    let newStr = `<mark note="${newComment}">${text}</mark>`;
                    let lineContent = this.lines[lineIndex];
                    this.lines[lineIndex] = lineContent.replace(rawMatch, newStr);
                    this.rerenderLine(lineIndex);
                    this.emitInput();
                    this.markPopover.remove();
                    this.markPopover = null;
                });
            });
        }

        setTimeout(() => {
            const closeHandler = (e) => {
                if (this.markPopover && !this.markPopover.contains(e.target) && e.target !== el && !el.contains(e.target)) {
                    this.markPopover.remove();
                    this.markPopover = null;
                    document.removeEventListener('mousedown', closeHandler);
                    document.removeEventListener('touchstart', closeHandler);
                }
            };
            document.addEventListener('mousedown', closeHandler);
            document.addEventListener('touchstart', closeHandler);
        }, 10);
    }

    setupSelectionMenu() {
        this.selectionMenu = document.createElement('div');
        this.selectionMenu.className = 'selection-menu';
        this.selectionMenu.style.display = 'none';

        const btnGroup = document.createElement('div');
        btnGroup.className = 'menu-btn-group';

        const drawLineBtn = document.createElement('button');
        drawLineBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 0-14h8.5a5.5 5.5 0 1 1 0 11H10a4 4 0 1 1 0-8h5" /></svg> 画线';
        drawLineBtn.addEventListener('click', () => this.applySelectionAction('drawLine'));

        const markBtn = document.createElement('button');
        markBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11.08V12a8 8 0 1 1-4.48-7.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg> 高亮';
        markBtn.addEventListener('click', () => this.applySelectionAction('mark'));

        const annotateBtn = document.createElement('button');
        annotateBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1" /></svg> 批注';

        const inputGroup = document.createElement('div');
        inputGroup.className = 'menu-input-group';
        inputGroup.style.display = 'none';

        const annoInput = document.createElement('textarea');
        annoInput.placeholder = '输入批注...';
        annoInput.rows = 1;
        
        const repositionMenu = () => {
            const data = this.currentSelectionData;
            if (!data || !data.rect) return;
            const rect = data.rect;
            
            const menuRect = this.selectionMenu.getBoundingClientRect();
            let left = rect.left + (rect.width / 2) - (menuRect.width / 2);
            let top = rect.top - menuRect.height - 10 + window.scrollY;
            if (top < window.scrollY + 10) top = rect.bottom + 10 + window.scrollY;
            if (left + menuRect.width > window.innerWidth - 10) left = window.innerWidth - menuRect.width - 10;
            if (left < 10) left = 10;
            this.selectionMenu.style.left = `${left}px`;
            this.selectionMenu.style.top = `${top}px`;
        };

        annoInput.addEventListener('input', () => {
            annoInput.style.height = 'auto';
            annoInput.style.height = annoInput.scrollHeight + 'px';
            repositionMenu();
        });

        annoInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                saveBtn.click();
            }
            if (e.key === 'Escape') {
                this.selectionMenu.style.display = 'none';
                btnGroup.style.display = 'flex';
                inputGroup.style.display = 'none';
            }
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'save-anno-btn';
        saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5l10 -10" /></svg>';

        annotateBtn.addEventListener('click', () => {
            btnGroup.style.display = 'none';
            inputGroup.style.display = 'flex';
            annoInput.value = '';
            annoInput.style.height = 'auto';
            annoInput.focus();
            setTimeout(repositionMenu, 0);
        });

        saveBtn.addEventListener('click', () => {
            const comment = annoInput.value.trim();
            if (comment) {
                this.applySelectionAction('annotate', comment);
            }
            this.selectionMenu.style.display = 'none';
            btnGroup.style.display = 'flex';
            inputGroup.style.display = 'none';
        });

        btnGroup.appendChild(drawLineBtn);
        btnGroup.appendChild(markBtn);
        btnGroup.appendChild(annotateBtn);

        inputGroup.appendChild(annoInput);
        inputGroup.appendChild(saveBtn);

        this.selectionMenu.appendChild(btnGroup);
        this.selectionMenu.appendChild(inputGroup);
        document.body.appendChild(this.selectionMenu);

        document.addEventListener('mouseup', (e) => {
            if (this.selectionMenu && this.selectionMenu.contains(e.target)) {
                return;
            }
            setTimeout(() => this.handleSelectionChange(), 10);
        });

        // Use selectionchange for better mobile support
        let selectionTimeout;
        document.addEventListener('selectionchange', () => {
            if ('ontouchstart' in window) {
                clearTimeout(selectionTimeout);
                selectionTimeout = setTimeout(() => {
                    // Only trigger if the selection is within our editor and NOT collapsed
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed) {
                        this.handleSelectionChange();
                    }
                }, 300);
            }
        });

        // Hide menu on any click elsewhere
        document.addEventListener('mousedown', (e) => {
            if (this.selectionMenu && !this.selectionMenu.contains(e.target)) {
                this.selectionMenu.style.display = 'none';
            }
        });
        document.addEventListener('touchstart', (e) => {
            if (this.selectionMenu && !this.selectionMenu.contains(e.target)) {
                // Don't hide if we are in the middle of selecting
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed) {
                    this.selectionMenu.style.display = 'none';
                }
            }
        });
    }

    findMatchInLine(lineText, searchText) {
        if (!lineText || !searchText) return null;
        let index = lineText.indexOf(searchText);
        if (index !== -1) return { index, text: searchText };

        const escapedText = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const words = escapedText.split(/\s+/).filter(w => w);
        if (words.length > 0) {
            const pattern = words.join('[\\s\\S]*?');
            try {
                const regex = new RegExp(pattern, 'i');
                const match = lineText.match(regex);
                if (match) {
                    return { index: match.index, text: match[0] };
                }
            } catch (e) { }
        }
        return null;
    }

    handleSelectionChange() {
        let selectionLines = [];
        let rect = null;

        const activeEl = document.activeElement;
        if (activeEl && activeEl.tagName === 'TEXTAREA' && activeEl.classList.contains('hybrid-source-line')) {
            const start = activeEl.selectionStart;
            const end = activeEl.selectionEnd;
            if (start !== end) {
                const selectedText = activeEl.value.substring(start, end).trim();
                const lineEl = activeEl.closest('.hybrid-line');
                if (lineEl && selectedText) {
                    const lineIndex = parseInt(lineEl.dataset.line);
                    selectionLines.push({ lineIndex, selectedText });
                    const taRect = activeEl.getBoundingClientRect();
                    rect = {
                        left: taRect.left + taRect.width / 2,
                        top: taRect.top + 10,
                        width: 0,
                        height: 0
                    };
                }
            } else {
                this.selectionMenu.style.display = 'none';
                return;
            }
        } else {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
                this.selectionMenu.style.display = 'none';
                return;
            }

            const range = selection.getRangeAt(0);
            rect = range.getBoundingClientRect();

            // Ensure selection is within our editor
            if (!this.scroller.contains(range.commonAncestorContainer)) {
                this.selectionMenu.style.display = 'none';
                return;
            }

            const startNode = range.startContainer;
            const endNode = range.endContainer;
            const startLineEl = startNode.nodeType === 3 ? startNode.parentElement.closest('.hybrid-line') : startNode.closest('.hybrid-line');
            const endLineEl = endNode.nodeType === 3 ? endNode.parentElement.closest('.hybrid-line') : endNode.closest('.hybrid-line');

            if (!startLineEl || !endLineEl) return;
            const startLineIdx = parseInt(startLineEl.dataset.line);
            const endLineIdx = parseInt(endLineEl.dataset.line);
            const minLine = Math.min(startLineIdx, endLineIdx);
            const maxLine = Math.max(startLineIdx, endLineIdx);

            const selectedTextStr = selection.toString();
            if (!selectedTextStr.trim()) {
                this.selectionMenu.style.display = 'none';
                return;
            }

            if (minLine === maxLine) {
                selectionLines.push({ lineIndex: minLine, selectedText: selectedTextStr.trim() });
            } else {
                const parts = selectedTextStr.split(/\r?\n/);
                let currentLine = minLine;
                for (let part of parts) {
                    part = part.trim();
                    if (!part) continue;
                    let searchLine = currentLine;
                    while (searchLine <= maxLine) {
                        const match = this.findMatchInLine(this.lines[searchLine], part);
                        if (match) {
                            selectionLines.push({ lineIndex: searchLine, selectedText: part });
                            currentLine = searchLine; // Next part can start searching from this line
                            break;
                        }
                        searchLine++;
                    }
                }
            }
        }

        if (selectionLines.length === 0) {
            this.selectionMenu.style.display = 'none';
            return;
        }

        this.currentSelectionData = {
            selectionLines,
            rect: rect
        };

        // Position and show menu
        this.selectionMenu.style.display = 'flex';

        setTimeout(() => {
            const menuRect = this.selectionMenu.getBoundingClientRect();
            let left = rect.left + (rect.width / 2) - (menuRect.width / 2);
            let top = rect.top - menuRect.height - 10 + window.scrollY;
            
            // Mobile Optimization: System menu usually appears ABOVE.
            // We force our menu to appear BELOW the selection to avoid clashing.
            if ('ontouchstart' in window) {
                top = rect.bottom + 15 + window.scrollY;
            } else if (top < window.scrollY + 10) {
                top = rect.bottom + 10 + window.scrollY;
            }
            if (left + menuRect.width > window.innerWidth - 10) left = window.innerWidth - menuRect.width - 10;
            if (left < 10) left = 10; // 绝对保证不会跑到左边屏幕外
            this.selectionMenu.style.left = `${left}px`;
            this.selectionMenu.style.top = `${top}px`;
        }, 0);
    }

    applySelectionAction(action, comment = '') {
        if (!this.currentSelectionData || !this.currentSelectionData.selectionLines) return;

        let changed = false;
        let activeLineIndex = -1;
        let newActiveText = null;

        for (const { lineIndex, selectedText } of this.currentSelectionData.selectionLines) {
            const lineText = this.lines[lineIndex];
            if (lineText === undefined) continue;

            const textToFind = selectedText.trim();
            if (!textToFind) continue;

            const match = this.findMatchInLine(lineText, textToFind);
            if (!match) continue;

            const textIndex = match.index;
            const matchedText = match.text;

            let newText;
            if (action === 'drawLine') {
                newText = lineText.slice(0, textIndex) + `==${matchedText}==` + lineText.slice(textIndex + matchedText.length);
            } else if (action === 'mark') {
                newText = lineText.slice(0, textIndex) + `<mark>${matchedText}</mark>` + lineText.slice(textIndex + matchedText.length);
            } else if (action === 'annotate') {
                newText = lineText.slice(0, textIndex) + `<mark note="${comment}">${matchedText}</mark>` + lineText.slice(textIndex + matchedText.length);
            }

            if (newText && newText !== lineText) {
                this.lines[lineIndex] = newText;
                this.rerenderLine(lineIndex);
                changed = true;

                const activeEl = document.activeElement;
                if (activeEl && activeEl.tagName === 'TEXTAREA' && activeEl.classList.contains('hybrid-source-line')) {
                    const activeLineEl = activeEl.closest('.hybrid-line');
                    if (activeLineEl && parseInt(activeLineEl.dataset.line) === lineIndex) {
                        activeLineIndex = lineIndex;
                        newActiveText = newText;
                    }
                }
            }
        }

        if (changed) {
            this.emitInput();
            if (activeLineIndex !== -1 && newActiveText !== null) {
                const activeEl = document.activeElement;
                if (activeEl) activeEl.value = newActiveText;
            }
        }

        window.getSelection()?.removeAllRanges();
        this.selectionMenu.style.display = 'none';
        this.currentSelectionData = null;
    }
    // Block annotation functions have been removed
    
    generateToC() {
        const toc = [];
        this.lines.forEach((line, index) => {
            const match = line.match(/^(#{1,4})\s+(.+)$/);
            if (match) {
                const level = match[1].length;
                let text = match[2];
                // Clean up markdown markers for a clean TOC
                text = text.replace(/==|{|}|<mark.*?>|<\/mark>/g, '');
                toc.push({ text: text.trim(), level, index });
            }
        });
        return toc;
    }
}

function getCaretCharacterOffsetWithin(element, x, y) {
    let range;
    let offset = 0;

    if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos) {
            range = document.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.setEnd(pos.offsetNode, pos.offset);
        }
    }

    if (range && element.contains(range.startContainer)) {
        const preCaretRange = document.createRange();
        preCaretRange.selectNodeContents(element);
        preCaretRange.setEnd(range.startContainer, range.startOffset);
        offset = preCaretRange.toString().length;
    }
    return offset;
}
