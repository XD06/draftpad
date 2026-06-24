import { stripHybridDisplayArtifacts } from './managers/hybrid-display-sanitizer.js';
import {
    buildTimeMarker,
    buildUpdatedTimeMarker,
    deleteTimeMarker,
    handleTimeCommandKeydown,
    renderTimeMarkers,
    replaceTimeMarker,
    TIME_COMMAND
} from './managers/time-command.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MARK_PROTECTED_SELECTOR = [
    'pre:not(.vditor-reset)',
    'code',
    '.mermaid',
    '.mermaid-block',
    '.language-mermaid',
    '.md-time-marker'
].join(',');

function slugify(text, seen) {
    const base = String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-') || 'section';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
}

function debounce(fn, wait = 80) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

export class HybridMarkdownEditor {
    constructor(container, { input } = {}) {
        const Vditor = window.Vditor;
        if (!Vditor) {
            throw new Error('Vditor failed to load.');
        }

        this.container = container;
        this.onInput = input || (() => {});
        this.listeners = new Map();
        this.isReadingMode = false;
        this.headingLineBySlug = new Map();
        this.headingIds = [];
        this._lastValue = '';
        this.ready = false;
        this.pendingValue = '';
        this.sourceMode = false;
        this.currentSelectionData = null;
        this.suppressInput = false;

        this.container.innerHTML = '';
        this.container.classList.add('typora-editor-shell');

        this.editor = new Vditor(this.container, {
            height: '100%',
            mode: 'wysiwyg',
            cdn: '/vendor/vditor-package',
            icon: false,
            value: '',
            cache: { enable: false },
            counter: { enable: false },
            resize: { enable: false },
            theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'classic',
            toolbarConfig: {
                hide: true,
                pin: false
            },
            customWysiwygToolbar: () => {},
            input: () => {
                if (!this.isDecorating && !this.suppressInput) this.emitChange();
            },
            after: () => {
                this.ready = true;
                this.createSourceModeControls();
                if (this.pendingValue) {
                    this.suppressProgrammaticInput();
                    this.editor.setValue(this.prepareDisplayValue(this.pendingValue));
                    if (this.sourceTextarea) this.sourceTextarea.value = this.pendingValue;
                    this.pendingValue = '';
                }
                this.syncTheme();
                this.setEditable(!this.isReadingMode);
                this.buildHeadingIndex();
                this.bindAnnotationPopover();
                this.bindTimeMarkerPopover();
                this.scheduleDecorateRenderedMarks();
            }
        });

        this.emitChange = debounce(() => {
            const value = this.sourceMode && this.sourceTextarea
                ? this.sourceTextarea.value
                : this.stripDisplayGuards(this.editor?.getValue?.() || this._lastValue || '');
            this._lastValue = value;
            this.buildHeadingIndex();
            this.scheduleDecorateRenderedMarks();
            this.onInput(value);
            this.dispatch('input', { value });
            this.dispatch('change', { value });
        }, 120);

        this.syncTheme();
        this.themeObserver = new MutationObserver(() => this.syncTheme());
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        this.setupSelectionMenu();
        this.bindReadingModeGuard();
        this.bindTimeCommand();
        this.buildHeadingIndex();
    }

    suppressProgrammaticInput() {
        this.suppressInput = true;
        clearTimeout(this.suppressInputTimer);
        this.suppressInputTimer = setTimeout(() => {
            this.suppressInput = false;
        }, 180);
    }

    getValue() {
        if (this.sourceMode && this.sourceTextarea) return this.sourceTextarea.value;
        if (!this.ready || !this.editor?.getValue) return this.stripDisplayGuards(this.pendingValue || this._lastValue || '');
        return this.stripDisplayGuards(this._lastValue || this.pendingValue || '');
    }

    setValue(value = '', emit = true) {
        const normalized = this.stripDisplayGuards(value);
        this._lastValue = normalized;
        if (this.ready && this.editor?.setValue) {
            if (!emit) this.suppressProgrammaticInput();
            this.editor.setValue(this.prepareDisplayValue(normalized));
            this.setEditable(!this.isReadingMode);
            this.decorateRenderedMarks();
            this.scheduleDecorateRenderedMarks();
        } else {
            this.pendingValue = normalized;
        }
        if (this.sourceTextarea) this.sourceTextarea.value = normalized;
        this.buildHeadingIndex();
        if (emit) {
            this.onInput(normalized);
            this.dispatch('input', { value: normalized });
        }
    }

    notifyEditorValueChanged(value = '') {
        const normalized = this.stripDisplayGuards(value);
        this._lastValue = normalized;
        if (this.sourceTextarea) this.sourceTextarea.value = normalized;
        this.buildHeadingIndex();
        this.onInput(normalized);
        this.dispatch('input', { value: normalized });
        this.dispatch('change', { value: normalized });
    }

    renderAfterMutation(scrollTop = 0) {
        const restoreScroll = () => {
            const nextScroller = this.container.querySelector('.vditor-wysiwyg');
            if (nextScroller) nextScroller.scrollTop = scrollTop;
        };
        this.decorateRenderedMarks();
        this.scheduleDecorateRenderedMarks();
        requestAnimationFrame(() => {
            restoreScroll();
            this.decorateRenderedMarks();
        });
        setTimeout(() => {
            restoreScroll();
            this.decorateRenderedMarks();
        }, 80);
        setTimeout(() => {
            restoreScroll();
            this.decorateRenderedMarks();
        }, 240);
    }

    focus() {
        if (this.isReadingMode) return;
        if (this.sourceMode) {
            this.sourceTextarea?.focus();
            return;
        }
        this.editor?.focus?.();
    }

    get selectionStart() {
        return 0;
    }

    get selectionEnd() {
        return this.selectionStart;
    }

    setSelectionRange() {
        this.focus();
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
        this.listeners.get(type)?.delete(handler);
    }

    dispatch(type, detail = {}) {
        this.listeners.get(type)?.forEach(handler => {
            handler({ type, detail, target: this });
        });
    }

    renderMarkdown() {
        return this.container.querySelector('.vditor-reset')?.innerHTML || '';
    }

    prepareDisplayValue(value = '') {
        return String(value || '')
            .split('\n')
            .map(line => /^\s*<(?:mark\b|span\s+data-(?:draw|note)\b)/i.test(line) ? `\u200B${line}` : line)
            .join('\n');
    }

    stripDisplayGuards(value = '') {
        return stripHybridDisplayArtifacts(value);
    }

    generateToC() {
        const seen = new Map();
        this.headingLineBySlug = new Map();
        this.headingIds = [];
        const toc = this.getValue()
            .split('\n')
            .map((line, index) => {
                const match = line.match(HEADING_RE);
                if (!match) return null;
                const text = match[2].replace(/[`*_~[\]()]/g, '').trim();
                const id = slugify(text, seen);
                this.headingLineBySlug.set(id, index);
                this.headingIds[index] = id;
                return {
                    id,
                    text,
                    level: match[1].length,
                    line: index
                };
            })
            .filter(Boolean);
        this.syncRenderedHeadingIds(toc);
        return toc;
    }

    focusLine(index) {
        this.scrollToLine(index);
        this.focus();
    }

    jumpToKeyword(keyword) {
        if (!keyword) return;
        const lower = String(keyword).toLowerCase();
        const lineIndex = this.getValue()
            .split('\n')
            .findIndex(line => line.toLowerCase().includes(lower));
        if (lineIndex >= 0) this.scrollToLine(lineIndex, keyword);
    }

    scrollToLine(index, keyword = '') {
        const lines = this.getValue().split('\n');
        const line = lines[Math.max(0, Math.min(index, lines.length - 1))] || '';
        const headingId = this.headingIds[index];
        if (headingId && this.scrollToHeadingId(headingId)) return;
        const needle = (keyword || line.replace(/^#{1,6}\s+/, '').trim()).slice(0, 80);
        const target = this.findRenderedNode(needle);
        if (target) this.scrollRenderedElementIntoView(target);
    }

    scrollToHeadingId(id) {
        if (!id) return false;
        const root = this.renderedRoot();
        const target = root?.querySelector(`#${CSS.escape(id)}`);
        if (!target) return false;
        this.scrollRenderedElementIntoView(target);
        return true;
    }

    scrollRenderedElementIntoView(target) {
        if (!target) return;
        const scroller = this.container.querySelector('.vditor-wysiwyg') || this.container;
        const scrollerRect = scroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop = scroller.scrollTop + targetRect.top - scrollerRect.top - Math.max(24, scroller.clientHeight * 0.18);
        scroller.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
        target.classList.add('is-jump-target');
        setTimeout(() => target.classList.remove('is-jump-target'), 1600);
    }

    renderedRoot() {
        return this.container.querySelector('.vditor-reset') || this.container.querySelector('.toastui-editor-contents');
    }

    findRenderedNode(text) {
        const searchRoot = this.renderedRoot();
        if (!searchRoot) return null;
        if (!text) return searchRoot;
        const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
            if (node.textContent?.includes(text)) return node;
            node = walker.nextNode();
        }
        return searchRoot;
    }

    syncRenderedHeadingIds(toc = null) {
        const headings = this.renderedRoot()?.querySelectorAll('h1, h2, h3, h4, h5, h6');
        if (!headings?.length) return;
        const items = Array.isArray(toc) ? toc : this.generateToC();
        headings.forEach((heading, index) => {
            const item = items[index];
            if (!item?.id) return;
            heading.id = item.id;
            heading.dataset.headingId = item.id;
        });
    }

    buildHeadingIndex() {
        this.generateToC();
    }

    setReadingMode(enabled) {
        this.isReadingMode = Boolean(enabled);
        this.hideSelectionMenu();
        window.getSelection()?.removeAllRanges();
        if (this.isReadingMode && this.sourceMode) {
            this.setSourceMode(false);
        }
        this.container.classList.toggle('is-reading-mode', this.isReadingMode);
        this.setEditable(!this.isReadingMode);
    }

    setEditable(enabled) {
        if (!this.ready) return;
        if (enabled && this.editor?.enable) {
            this.editor?.enable?.();
        }
        this.container.querySelectorAll('[contenteditable]').forEach(el => {
            el.setAttribute('contenteditable', enabled ? 'true' : 'false');
        });
        this.container.querySelectorAll('textarea').forEach(el => {
            el.readOnly = !enabled;
        });
    }

    syncTheme() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        this.container.classList.toggle('typora-editor-dark', isDark);
        if (this.ready && this.editor?.setTheme) {
            this.editor.setTheme(isDark ? 'dark' : 'classic');
        }
    }

    createSourceModeControls() {
        this.sourceTextarea = document.createElement('textarea');
        this.sourceTextarea.className = 'typora-source-editor';
        this.sourceTextarea.setAttribute('aria-label', 'Markdown source');
        this.sourceTextarea.spellcheck = true;
        this.sourceTextarea.addEventListener('input', () => {
            this._lastValue = this.sourceTextarea.value;
            this.buildHeadingIndex();
            this.onInput(this._lastValue);
            this.dispatch('input', { value: this._lastValue });
            this.dispatch('change', { value: this._lastValue });
        });

        this.sourceToggle = document.createElement('button');
        this.sourceToggle.type = 'button';
        this.sourceToggle.className = 'typora-source-toggle';
        this.sourceToggle.setAttribute('aria-label', 'Toggle Markdown source');
        this.sourceToggle.setAttribute('data-tooltip', 'Markdown Source');
        this.sourceToggle.textContent = '</>';
        this.sourceToggle.addEventListener('click', () => this.setSourceMode(!this.sourceMode));

        this.container.appendChild(this.sourceTextarea);
        this.container.appendChild(this.sourceToggle);
    }

    scheduleDecorateRenderedMarks() {
        cancelAnimationFrame(this.decorateFrame);
        this.decorateFrame = requestAnimationFrame(() => {
            requestAnimationFrame(() => this.decorateRenderedMarks());
        });
    }

    decorateRenderedMarks() {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!root || this.sourceMode) return;

        this.isDecorating = true;
        root.querySelectorAll('p, li').forEach(parent => {
            if (!this.isMarkProtectedNode(parent)) this.decorateCodeTagMarks(parent);
        });

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const targets = [];
        let node;
        while ((node = walker.nextNode())) {
            if (this.isMarkProtectedNode(node)) continue;
            const text = node.nodeValue || '';
            if (text.includes('==') || text.includes('[[time:') || text.includes('<mark') || text.includes('<span data-draw') || text.includes('<span data-note')) {
                targets.push(node);
            }
        }

        for (const textNode of targets) {
            const html = this.renderInlineMarks(textNode.nodeValue || '');
            if (!html) continue;
            const template = document.createElement('template');
            template.innerHTML = html;
            textNode.parentNode?.replaceChild(template.content, textNode);
        }

        this.decorateCodeWrappedTags(root);
        requestAnimationFrame(() => {
            this.isDecorating = false;
        });
    }

    decorateCodeWrappedTags(root) {
        const placeholders = [];
        const protectedNodes = Array.from(root.querySelectorAll('pre, .mermaid, .mermaid-block'));
        protectedNodes.forEach((node, index) => {
            const placeholder = document.createElement('span');
            placeholder.setAttribute('data-mark-protected-placeholder', String(index));
            placeholders.push({ placeholder, node });
            node.replaceWith(placeholder);
        });

        const before = root.innerHTML;
        const codeTag = '<code[^>]*>[\\u200b\\u200c\\ufeff\\s]*';
        const codeClose = '<\\/code>';
        let html = before;

        html = html.replace(
            new RegExp(`${codeTag}&lt;span data-note=&quot;([^&]*)&quot;[\\s\\S]*?&gt;${codeClose}([\\s\\S]*?)${codeTag}&lt;\\/span&gt;${codeClose}\\s*${codeTag}&lt;sub[\\s\\S]*?&gt;${codeClose}([\\s\\S]*?)${codeTag}&lt;\\/sub&gt;${codeClose}`, 'g'),
            (_match, comment, markedText, label) => this.annotationHtml(markedText, comment || label)
        );
        html = html.replace(
            new RegExp(`${codeTag}&lt;span data-draw[\\s\\S]*?&gt;${codeClose}([\\s\\S]*?)${codeTag}&lt;\\/span&gt;${codeClose}`, 'g'),
            '<span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">$1</span>'
        );
        html = html.replace(
            new RegExp(`${codeTag}&lt;mark&gt;${codeClose}([\\s\\S]*?)${codeTag}&lt;\\/mark&gt;${codeClose}`, 'g'),
            '<mark class="md-mark">$1</mark>'
        );

        if (html !== before) root.innerHTML = html;
        placeholders.forEach(({ node }, index) => {
            root.querySelector(`[data-mark-protected-placeholder="${index}"]`)?.replaceWith(node);
        });
    }

    decorateCodeTagMarks(parent) {
        const clean = value => String(value || '').replace(/\u200b/g, '').trim();
        const nodes = Array.from(parent.childNodes);
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node.nodeType !== Node.ELEMENT_NODE || node.tagName !== 'CODE') continue;
            const token = clean(node.textContent);

            if (token === '<mark>') {
                const close = nodes.findIndex((candidate, index) =>
                    index > i && candidate.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'CODE' && clean(candidate.textContent) === '</mark>'
                );
                if (close > i) {
                    this.replaceDecoratedRange(parent, nodes, i, close, document.createElement('mark'), 'md-mark');
                    return this.decorateCodeTagMarks(parent);
                }
            }

            if (token.startsWith('<span data-draw')) {
                const close = nodes.findIndex((candidate, index) =>
                    index > i && candidate.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'CODE' && clean(candidate.textContent) === '</span>'
                );
                if (close > i) {
                    const span = document.createElement('span');
                    span.setAttribute('data-draw', '');
                    span.style.textDecoration = 'underline blue';
                    span.style.textDecorationThickness = '2px';
                    this.replaceDecoratedRange(parent, nodes, i, close, span);
                    return this.decorateCodeTagMarks(parent);
                }
            }

            if (token.startsWith('<span data-note')) {
                const close = nodes.findIndex((candidate, index) =>
                    index > i && candidate.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'CODE' && clean(candidate.textContent) === '</span>'
                );
                if (close > i) {
                    const commentMatch = token.match(/data-note="([^"]*)"/);
                    const comment = commentMatch ? commentMatch[1] : '';
                    const span = document.createElement('span');
                    span.className = 'has-annotation';
                    span.dataset.comment = comment;

                    const underline = document.createElement('span');
                    underline.style.textDecoration = 'underline wavy #e74c3c';
                    underline.style.textDecorationThickness = '2.5px';
                    this.moveRangeContent(nodes, i, close, underline);
                    span.appendChild(underline);
                    span.insertAdjacentHTML('beforeend', '<span class="annotation-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>');
                    if (comment) {
                        const sub = document.createElement('sub');
                        sub.style.cssText = 'color:#e74c3c;font-size:0.65em;margin-left:2px;white-space:nowrap;cursor:default;user-select:none;';
                        sub.textContent = `（${comment}）`;
                        span.appendChild(sub);
                    }
                    parent.replaceChild(span, nodes[i]);
                    let removeEnd = close;
                    const subStart = nodes.findIndex((candidate, index) =>
                        index > close && candidate.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'CODE' && clean(candidate.textContent).startsWith('<sub')
                    );
                    if (subStart > close) {
                        const subEnd = nodes.findIndex((candidate, index) =>
                            index > subStart && candidate.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'CODE' && clean(candidate.textContent) === '</sub>'
                        );
                        if (subEnd > subStart) removeEnd = subEnd;
                    }
                    for (let j = removeEnd; j > i; j--) nodes[j].parentNode?.removeChild(nodes[j]);
                    return this.decorateCodeTagMarks(parent);
                }
            }
        }
    }

    replaceDecoratedRange(parent, nodes, start, end, wrapper, className = '') {
        if (className) wrapper.className = className;
        this.moveRangeContent(nodes, start, end, wrapper);
        parent.replaceChild(wrapper, nodes[start]);
        for (let j = end; j > start; j--) nodes[j].parentNode?.removeChild(nodes[j]);
    }

    moveRangeContent(nodes, start, end, wrapper) {
        for (let j = start + 1; j < end; j++) {
            wrapper.appendChild(nodes[j].cloneNode(true));
        }
    }

    renderInlineMarks(text) {
        let html = this.escapeHtml(text);
        html = html.replace(/\u200B/g, '');
        const original = html;
        html = renderTimeMarkers(html, 'md-time-marker');
        html = html.replace(
            /&lt;span data-note=&quot;([^&]*)&quot;[\s\S]*?&gt;([\s\S]*?)&lt;\/span&gt;\s*&lt;sub[\s\S]*?&gt;[\s\S]*?&lt;\/sub&gt;/g,
            (_match, comment, markedText) => this.annotationHtml(markedText, comment)
        );
        html = html.replace(
            /&lt;mark note=&quot;([^&]*)&quot;&gt;([\s\S]*?)&lt;\/mark&gt;/g,
            (_match, comment, markedText) => this.annotationHtml(markedText, comment)
        );
        html = html.replace(
            /==([^=\n]+?)==\{(?:用户批注:\s*)?([^}]*)\}/g,
            (_match, markedText, comment) => this.annotationHtml(this.escapeHtml(markedText), comment)
        );
        html = html.replace(
            /&lt;span data-draw[\s\S]*?&gt;([\s\S]*?)&lt;\/span&gt;/g,
            '<span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">$1</span>'
        );
        html = html.replace(/&lt;mark&gt;([\s\S]*?)&lt;\/mark&gt;/g, '<mark class="md-mark">$1</mark>');
        html = html.replace(/==([^=\n]+?)==/g, '<mark class="md-mark">$1</mark>');
        return html === original ? '' : html;
    }

    annotationHtml(markedText, comment) {
        const decodedComment = this.decodeHtml(comment || '');
        const safeComment = this.escapeAttribute(decodedComment);
        const label = this.escapeHtml(decodedComment);
        return `<span class="has-annotation" data-comment="${safeComment}"><span style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">${markedText}</span><span class="annotation-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span><sub style="display:none;color:#e74c3c;font-size:0.65em;margin-left:2px;white-space:nowrap;cursor:default;user-select:none;">（${label}）</sub></span>`;
    }

    decodeHtml(text) {
        const div = document.createElement('div');
        div.innerHTML = text || '';
        return div.textContent || '';
    }

    setupSelectionMenu() {
        this.selectionMenu = document.createElement('div');
        this.selectionMenu.className = 'selection-menu typora-selection-menu';

        const btnGroup = document.createElement('div');
        btnGroup.className = 'menu-btn-group';

        const makeButton = (label, title, action) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.title = title;
            btn.textContent = label;
            btn.addEventListener('mousedown', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            btn.addEventListener('click', () => action());
            return btn;
        };

        const underlineBtn = makeButton('画线', '画线', () => this.applySelectionAction('drawLine'));
        const markBtn = makeButton('高亮', '高亮', () => this.applySelectionAction('mark'));
        const annotateBtn = makeButton('批注', '批注', () => {
            this.annotationInputOpen = true;
            btnGroup.style.display = 'none';
            inputGroup.style.display = 'flex';
            annoInput.value = '';
            annoInput.focus();
            this.positionSelectionMenu();
        });
        const copyBtn = makeButton('复制', '复制', async () => {
            const text = this.currentSelectionData?.selectedText || window.getSelection()?.toString() || '';
            if (text) {
                try {
                    await navigator.clipboard.writeText(text);
                } catch (_error) {
                    const textarea = document.createElement('textarea');
                    textarea.value = text;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '-9999px';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    textarea.remove();
                }
            }
            this.hideSelectionMenu();
            window.getSelection()?.removeAllRanges();
        });

        const inputGroup = document.createElement('div');
        inputGroup.className = 'menu-input-group';
        inputGroup.style.display = 'none';

        const annoInput = document.createElement('textarea');
        annoInput.placeholder = '输入批注内容';
        annoInput.rows = 1;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'save-anno-btn';
        saveBtn.textContent = '✓';
        saveBtn.addEventListener('click', () => {
            const comment = annoInput.value.trim();
            if (comment) this.applySelectionAction('annotate', comment);
            this.annotationInputOpen = false;
            btnGroup.style.display = 'flex';
            inputGroup.style.display = 'none';
        });

        annoInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                saveBtn.click();
            }
            if (e.key === 'Escape') {
                this.annotationInputOpen = false;
                this.hideSelectionMenu();
                btnGroup.style.display = 'flex';
                inputGroup.style.display = 'none';
            }
        });

        btnGroup.append(underlineBtn, markBtn, annotateBtn, copyBtn);
        inputGroup.append(annoInput, saveBtn);
        this.selectionMenu.append(btnGroup, inputGroup);
        document.body.appendChild(this.selectionMenu);

        document.addEventListener('mouseup', (event) => {
            if (this.selectionMenu.contains(event.target) || this.sourceMode || this.annotationInputOpen) return;
            setTimeout(() => this.handleSelectionChange(), 20);
        });

        document.addEventListener('mousedown', (event) => {
            if (!this.selectionMenu.contains(event.target)) this.hideSelectionMenu();
        });

        document.addEventListener('selectionchange', () => {
            if (this.sourceMode || this.annotationInputOpen) return;
            clearTimeout(this.selectionTimer);
            this.selectionTimer = setTimeout(() => this.handleSelectionChange(), 180);
        });
    }

    handleSelectionChange() {
        if (this.sourceMode) {
            this.hideSelectionMenu();
            return;
        }
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            this.hideSelectionMenu();
            return;
        }

        const range = selection.getRangeAt(0);
        if (!this.container.contains(range.commonAncestorContainer)) {
            this.hideSelectionMenu();
            return;
        }
        if (this.rangeIntersectsMarkProtectedContent(range)) {
            this.hideSelectionMenu();
            return;
        }

        const selectedText = selection.toString().trim();
        const rect = this.getUsableSelectionRect(range);
        if (!selectedText || rect.width === 0 || rect.height === 0) {
            this.hideSelectionMenu();
            return;
        }

        this.currentSelectionData = {
            selectedText,
            rect,
            occurrenceIndex: this.getSelectionOccurrenceIndex(range, selectedText)
        };
        this.selectionMenu.style.display = 'flex';
        this.selectionMenu.querySelector('.menu-btn-group').style.display = 'flex';
        this.selectionMenu.querySelector('.menu-input-group').style.display = 'none';
        this.positionSelectionMenu();
    }

    getUsableSelectionRect(range) {
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return rect;
        const rects = Array.from(range.getClientRects?.() || []);
        return rects.find(item => item.width > 0 && item.height > 0) || rect;
    }

    getSelectionOccurrenceIndex(range, selectedText) {
        const root = this.container.querySelector('.vditor-reset');
        if (!root || !selectedText) return 0;
        try {
            const before = range.cloneRange();
            before.selectNodeContents(root);
            before.setEnd(range.startContainer, range.startOffset);
            return this.countOccurrences(before.toString(), selectedText);
        } catch (_error) {
            return 0;
        }
    }

    countOccurrences(text, needle) {
        if (!text || !needle) return 0;
        let count = 0;
        let index = 0;
        while ((index = text.indexOf(needle, index)) !== -1) {
            count++;
            index += needle.length;
        }
        return count;
    }

    positionSelectionMenu() {
        const rect = this.currentSelectionData?.rect;
        if (!rect) return;
        requestAnimationFrame(() => {
            const menuRect = this.selectionMenu.getBoundingClientRect();
            const isMobile = window.matchMedia?.('(max-width: 720px)').matches;
            let left = rect.left + rect.width / 2 - menuRect.width / 2;
            let top = isMobile
                ? rect.bottom + window.scrollY + 10
                : rect.top + window.scrollY - menuRect.height - 10;
            if (isMobile && top + menuRect.height > window.scrollY + window.innerHeight - 12) {
                top = rect.top + window.scrollY - menuRect.height - 10;
            }
            if (!isMobile && top < window.scrollY + 10) top = rect.bottom + window.scrollY + 10;
            top = Math.max(top, window.scrollY + 10);
            left = Math.min(Math.max(left, 10), window.innerWidth - menuRect.width - 10);
            this.selectionMenu.style.left = `${left}px`;
            this.selectionMenu.style.top = `${top}px`;
        });
    }

    hideSelectionMenu() {
        if (this.selectionMenu) this.selectionMenu.style.display = 'none';
        this.annotationInputOpen = false;
        this.currentSelectionData = null;
    }

    applySelectionAction(action, comment = '') {
        const selectedText = this.currentSelectionData?.selectedText;
        if (!selectedText) return;

        const occurrenceIndex = this.currentSelectionData?.occurrenceIndex || 0;
        const value = this.getValue();
        const match = this.findMatchInMarkdown(value, selectedText, occurrenceIndex);
        if (!match || this.markdownRangeIntersectsFencedCode(value, match.start, match.end)) {
            window.toaster?.show?.('代码块内不支持高亮、画线或批注', 'info', false, 1800);
            this.hideSelectionMenu();
            return;
        }

        const original = value.slice(match.start, match.end);
        let replacement = original;
        if (action === 'drawLine') {
            replacement = `<span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">${original}</span>`;
        } else if (action === 'mark') {
            replacement = `<mark>${original}</mark>`;
        } else if (action === 'annotate') {
            replacement = `<span data-note="${this.escapeAttribute(comment)}" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">${original}</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（${this.escapeHtml(comment)}）</sub>`;
        }

        const next = value.slice(0, match.start) + replacement + value.slice(match.end);
        const scroller = this.container.querySelector('.vditor-wysiwyg');
        const scrollTop = scroller?.scrollTop || 0;
        this.setValue(next, true);
        this.setEditable(!this.isReadingMode);
        this.renderAfterMutation(scrollTop);
        this.hideSelectionMenu();
        window.getSelection()?.removeAllRanges();
    }

    findMatchInMarkdown(value, selectedText, occurrenceIndex = 0) {
        const direct = this.findNthText(value, selectedText, occurrenceIndex);
        if (direct >= 0) return { start: direct, end: direct + selectedText.length };

        const compactNeedle = selectedText.replace(/\s+/g, ' ').trim();
        const lines = value.split('\n');
        let offset = 0;
        let seen = 0;
        for (const line of lines) {
            const plain = line
                .replace(/<[^>]+>/g, '')
                .replace(/[`*_~[\]()#>-]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            const idx = plain.indexOf(compactNeedle);
            if (idx >= 0) {
                const rawIdx = line.indexOf(compactNeedle);
                if (rawIdx >= 0) {
                    if (seen === occurrenceIndex) return { start: offset + rawIdx, end: offset + rawIdx + compactNeedle.length };
                    seen++;
                }
            }
            offset += line.length + 1;
        }
        return null;
    }

    markdownRangeIntersectsFencedCode(value, start, end) {
        const text = String(value || '');
        const rangeStart = Math.max(0, Number(start) || 0);
        const rangeEnd = Math.max(rangeStart, Number(end) || rangeStart);
        const fenceRe = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[ \t]*(?=\n|$)|$)/g;
        let match;
        while ((match = fenceRe.exec(text)) !== null) {
            const blockStart = match.index + (match[1] ? 1 : 0);
            const blockEnd = match.index + match[0].length;
            if (rangeStart < blockEnd && rangeEnd > blockStart) return true;
        }
        return false;
    }

    isMarkProtectedNode(node) {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return Boolean(element?.closest?.(MARK_PROTECTED_SELECTOR));
    }

    rangeIntersectsMarkProtectedContent(range) {
        if (!range) return false;
        if (this.isMarkProtectedNode(range.startContainer) || this.isMarkProtectedNode(range.endContainer)) return true;
        return this.isMarkProtectedNode(range.commonAncestorContainer);
    }

    findNthText(value, needle, occurrenceIndex = 0) {
        let index = -1;
        let from = 0;
        for (let i = 0; i <= occurrenceIndex; i++) {
            index = value.indexOf(needle, from);
            if (index === -1) return -1;
            from = index + needle.length;
        }
        return index;
    }

    bindAnnotationPopover() {
        if (this.annotationPopoverBound) return;
        this.annotationPopoverBound = true;
        this.container.addEventListener('click', (event) => {
            const annotation = event.target.closest('.has-annotation, [data-note], .md-mark, [data-draw]');
            if (!annotation || !this.container.contains(annotation)) return;
            event.preventDefault();
            event.stopPropagation();
            this.showAnnotationPopover(annotation, Boolean(event.target.closest('.annotation-badge')));
        });
    }

    bindTimeMarkerPopover() {
        if (this.timeMarkerPopoverBound) return;
        this.timeMarkerPopoverBound = true;
        this.container.addEventListener('click', (event) => {
            const marker = event.target.closest('.md-time-marker');
            if (!marker || !this.container.contains(marker)) return;
            event.preventDefault();
            event.stopPropagation();
            this.hideSelectionMenu();
            this.showTimeMarkerMenu(marker);
        });
    }

    showTimeMarkerMenu(marker) {
        const menu = this.ensureTimeMarkerMenu();
        const source = marker.dataset.timeSource || '';
        if (!source) return;
        this.activeTimeMarker = { source };
        document.querySelectorAll('.mark-popover').forEach(el => el.remove());
        menu.hidden = false;
        menu.style.display = 'flex';
        this.positionTimeMarkerMenu(marker.getBoundingClientRect());
    }

    ensureTimeMarkerMenu() {
        if (this.timeMarkerMenu) return this.timeMarkerMenu;
        const menu = document.createElement('div');
        menu.className = 'selection-menu typora-selection-menu time-marker-menu';
        menu.hidden = true;
        menu.innerHTML = `
            <div class="menu-btn-group">
                <button type="button" data-time-action="update" title="更新为当前时间" aria-label="更新为当前时间">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v5l3 2"></path></svg>
                    <span>更新</span>
                </button>
                <button type="button" data-time-action="delete" title="删除时间" aria-label="删除时间">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 16H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>
                    <span>删除</span>
                </button>
            </div>
        `;
        menu.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        menu.addEventListener('click', (event) => {
            const button = event.target.closest('[data-time-action]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            this.applyTimeMarkerAction(button.dataset.timeAction);
        });
        document.body.appendChild(menu);
        document.addEventListener('mousedown', (event) => {
            if (!this.timeMarkerMenu || this.timeMarkerMenu.hidden) return;
            if (!this.timeMarkerMenu.contains(event.target) && !event.target.closest('.md-time-marker')) {
                this.hideTimeMarkerMenu();
            }
        });
        this.timeMarkerMenu = menu;
        return menu;
    }

    positionTimeMarkerMenu(rect) {
        if (!this.timeMarkerMenu || !rect) return;
        requestAnimationFrame(() => {
            const menuRect = this.timeMarkerMenu.getBoundingClientRect();
            const bounds = this.container.getBoundingClientRect();
            let left = rect.left + rect.width / 2 - menuRect.width / 2;
            let top = rect.top + window.scrollY - menuRect.height - 10;
            left = Math.min(
                Math.max(left, bounds.left + 10),
                Math.min(window.innerWidth - menuRect.width - 10, bounds.right - menuRect.width - 10)
            );
            if (top < window.scrollY + 10) top = rect.bottom + window.scrollY + 10;
            this.timeMarkerMenu.style.left = `${left}px`;
            this.timeMarkerMenu.style.top = `${top}px`;
        });
    }

    applyTimeMarkerAction(action) {
        const source = this.activeTimeMarker?.source || '';
        if (!source) return;
        const value = this.getValue();
        const next = action === 'delete'
            ? deleteTimeMarker(value, source)
            : replaceTimeMarker(value, source, buildUpdatedTimeMarker(source, new Date()));
        this.hideTimeMarkerMenu();
        if (next === value) return;
        const scroller = this.container.querySelector('.vditor-wysiwyg');
        const scrollTop = scroller?.scrollTop || 0;
        this.setValue(next, true);
        this.setEditable(!this.isReadingMode);
        this.renderAfterMutation(scrollTop);
    }

    hideTimeMarkerMenu() {
        if (this.timeMarkerMenu) {
            this.timeMarkerMenu.hidden = true;
            this.timeMarkerMenu.style.display = 'none';
        }
        this.activeTimeMarker = null;
    }

    bindReadingModeGuard() {
        this.container.addEventListener('click', (event) => {
            if (!this.isReadingMode) return;
            const target = event.target;
            if (target.closest('.has-annotation, [data-note], .md-mark, [data-draw], .md-time-marker')) return;
            if (target.closest('.vditor-copy, .code-lang-copy-button')) return;
            if (target.closest('.vditor-reset')) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
    }

    bindTimeCommand() {
        this.container.addEventListener('keydown', (event) => {
            if (this.isReadingMode) return;
            if (this.sourceMode) {
                handleTimeCommandKeydown(event);
                return;
            }
            if (this.handleWysiwygTimeCommand(event)) return;
            this.handleWysiwygSoftEnter(event);
        }, true);
    }

    handleWysiwygTimeCommand(event) {
        if (!event || event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) {
            return false;
        }
        const target = event.target;
        if (!target?.closest?.('.vditor-wysiwyg')) return false;

        const commandRange = this.getTimeCommandRangeBeforeCaret();
        if (!commandRange) return false;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(commandRange);
        document.execCommand('delete', false);
        this.editor?.insertValue?.(buildTimeMarker(), true);
        this.notifyEditorValueChanged(this.editor?.getValue?.() || this._lastValue || '');
        this.scheduleDecorateRenderedMarks();
        return true;
    }

    handleWysiwygSoftEnter(event) {
        if (!event || event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) {
            return false;
        }
        const target = event.target;
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!root || !target?.closest?.('.vditor-wysiwyg')) return false;

        const range = this.getPlainParagraphRange(root);
        if (!range) return false;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        range.deleteContents();
        const lineBreak = document.createElement('br');
        const caretGuard = document.createTextNode('\u200B');
        range.insertNode(lineBreak);
        lineBreak.after(caretGuard);

        const nextRange = document.createRange();
        nextRange.setStart(caretGuard, 1);
        nextRange.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(nextRange);

        this.notifyEditorValueChanged(this.editor?.getValue?.() || this._lastValue || '');
        this.scheduleDecorateRenderedMarks();
        return true;
    }

    getPlainParagraphRange(root) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return null;

        const startParagraph = this.closestElement(range.startContainer, 'p');
        const endParagraph = this.closestElement(range.endContainer, 'p');
        if (!startParagraph || startParagraph !== endParagraph || startParagraph.parentElement !== root) return null;

        const startInlineCode = this.closestElement(range.startContainer, 'code');
        const endInlineCode = this.closestElement(range.endContainer, 'code');
        if (startInlineCode || endInlineCode) return null;

        const visibleText = startParagraph.textContent.replace(/\u200B/g, '').trim();
        if (!visibleText && range.collapsed) return null;

        return range.cloneRange();
    }

    closestElement(node, selector) {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return element?.closest?.(selector) || null;
    }

    getTimeCommandRangeBeforeCaret() {
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        if (!this.container.contains(range.commonAncestorContainer)) return null;

        let node = range.startContainer;
        let offset = range.startOffset;
        if (node.nodeType !== Node.TEXT_NODE) {
            node = this.findTextNodeBeforeOffset(node, offset);
            if (!node) return null;
            offset = node.nodeValue.length;
        }

        const before = String(node.nodeValue || '').slice(0, offset);
        if (!before.endsWith(TIME_COMMAND)) return null;
        const commandStart = offset - TIME_COMMAND.length;
        const charAfterCommand = String(node.nodeValue || '')[offset] || '';
        if (/^[A-Za-z0-9_-]$/.test(charAfterCommand)) return null;

        const commandRange = document.createRange();
        commandRange.setStart(node, commandStart);
        commandRange.setEnd(node, offset);
        return commandRange;
    }

    findTextNodeBeforeOffset(node, offset = 0) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
        for (let index = Math.min(offset, node.childNodes.length) - 1; index >= 0; index--) {
            const candidate = this.findLastTextNode(node.childNodes[index]);
            if (candidate) return candidate;
        }
        return null;
    }

    findLastTextNode(node) {
        if (!node) return null;
        if (node.nodeType === Node.TEXT_NODE) return node;
        for (let index = node.childNodes?.length - 1 || 0; index >= 0; index--) {
            const candidate = this.findLastTextNode(node.childNodes[index]);
            if (candidate) return candidate;
        }
        return null;
    }

    showAnnotationPopover(annotation, showAnnotationContent = false) {
        document.querySelectorAll('.mark-popover').forEach(el => el.remove());
        const comment = annotation.dataset.comment || annotation.dataset.note || '';
        const isMark = annotation.matches('.md-mark');
        const isDraw = annotation.matches('[data-draw]');
        const type = comment ? 'annotation' : (isMark ? 'mark' : (isDraw ? 'drawLine' : ''));
        if (!type) return;

        const popover = document.createElement('div');
        popover.className = comment && showAnnotationContent
            ? 'mark-popover comment-only-popover'
            : 'mark-popover';
        const label = comment || (isMark ? '高亮' : '画线');
        popover.innerHTML = comment && showAnnotationContent ? `
            <div class="mark-popover-inline-content">
                <div class="mark-popover-icon-box">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                </div>
                <div class="mark-popover-text">${this.escapeHtml(label)}</div>
            </div>
        ` : comment ? `
            <div class="mark-popover-actions" style="border:none; margin:0; padding:0;">
                <button type="button" class="edit-btn">编辑</button>
                <button type="button" class="delete-btn">取消</button>
            </div>
        ` : `
            <div class="mark-popover-actions" style="border:none; margin:0; padding:0;">
                <button type="button" class="delete-btn">取消${isMark ? '高亮' : '画线'}</button>
            </div>
        `;
        popover.querySelector('.edit-btn')?.addEventListener('click', () => {
            popover.className = 'mark-popover mark-popover-editing';
            popover.innerHTML = `
                <div class="mark-popover-inline-content">
                    <textarea class="mark-popover-edit-input" rows="2">${this.escapeHtml(label)}</textarea>
                </div>
                <div class="mark-popover-actions">
                <button type="button" class="save-btn">保存</button>
                <button type="button" class="cancel-edit-btn">取消</button>
                </div>
            `;
            popover.querySelector('.mark-popover-edit-input')?.focus();
            popover.querySelector('.save-btn')?.addEventListener('click', () => {
                const nextComment = popover.querySelector('.mark-popover-edit-input')?.value.trim();
                if (nextComment) {
                    this.updateAnnotationComment(annotation, comment, nextComment);
                    popover.remove();
                }
            });
            popover.querySelector('.cancel-edit-btn')?.addEventListener('click', () => popover.remove());
        });
        popover.querySelector('.delete-btn')?.addEventListener('click', () => {
            this.removeInlineMark(annotation, type, comment);
            popover.remove();
        });
        document.body.appendChild(popover);
        const rect = annotation.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        const bounds = this.container.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - popRect.width / 2;
        let top = rect.top + window.scrollY - popRect.height - 12;
        left = Math.min(
            Math.max(left, bounds.left + 12),
            Math.min(window.innerWidth - popRect.width - 10, bounds.right - popRect.width - 12)
        );
        if (top < window.scrollY + 10) top = rect.bottom + window.scrollY + 12;
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        setTimeout(() => {
            const close = (event) => {
                if (!popover.contains(event.target)) {
                    popover.remove();
                    document.removeEventListener('mousedown', close);
                }
            };
            document.addEventListener('mousedown', close);
        }, 0);
    }

    updateAnnotationComment(element, oldComment = '', nextComment = '') {
        const value = this.getValue();
        const text = (element.querySelector('span[style*="wavy"]')?.textContent || element.textContent || '')
            .replace(/\s*[（(][^）)]*[）)]\s*$/, '')
            .trim();
        if (!text || !nextComment) return;

        const escapedText = this.escapeRegExp(text);
        const pattern = new RegExp(`<span data-note="[^"]*"([^>]*)>${escapedText}<\\/span><sub data-note-label[^>]*>[\\s\\S]*?<\\/sub>`);
        const safeComment = this.escapeAttribute(nextComment);
        const replacement = `<span data-note="${safeComment}" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">${text}</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（${this.escapeHtml(nextComment)}）</sub>`;
        const next = value.replace(pattern, replacement);
        if (next === value) return;

        const scroller = this.container.querySelector('.vditor-wysiwyg');
        const scrollTop = scroller?.scrollTop || 0;
        this.setValue(next, true);
        this.setEditable(!this.isReadingMode);
        this.renderAfterMutation(scrollTop);
    }

    removeInlineMark(element, type, comment = '') {
        const value = this.getValue();
        const text = type === 'annotation'
            ? (element.querySelector('span[style*="wavy"]')?.textContent || element.textContent || '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim()
            : (element.textContent || '').trim();
        if (!text) return;

        const escapedText = this.escapeRegExp(text);
        let pattern;
        if (type === 'mark') {
            pattern = new RegExp(`<mark>${escapedText}<\\/mark>`);
        } else if (type === 'drawLine') {
            pattern = new RegExp(`<span data-draw[^>]*>${escapedText}<\\/span>`);
        } else if (type === 'annotation') {
            pattern = new RegExp(`<span data-note="[^"]*"[^>]*>${escapedText}<\\/span><sub data-note-label[^>]*>[\\s\\S]*?<\\/sub>`);
        }
        if (!pattern) return;
        const next = value.replace(pattern, text);
        if (next === value) return;
        const scroller = this.container.querySelector('.vditor-wysiwyg');
        const scrollTop = scroller?.scrollTop || 0;
        this.setValue(next, true);
        this.setEditable(!this.isReadingMode);
        this.renderAfterMutation(scrollTop);
    }

    escapeRegExp(text) {
        return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    escapeAttribute(text) {
        return this.escapeHtml(text).replace(/"/g, '&quot;');
    }

    setSourceMode(enabled) {
        if (this.isReadingMode) enabled = false;
        this.sourceMode = Boolean(enabled);
        this.container.classList.toggle('is-source-mode', this.sourceMode);
        this.sourceToggle?.classList.toggle('active', this.sourceMode);

        if (this.sourceMode) {
            const value = this._lastValue || this.pendingValue || '';
            this.sourceTextarea.value = value || '';
            this.sourceTextarea.setSelectionRange(0, 0);
            this.sourceTextarea.scrollTop = 0;
            requestAnimationFrame(() => {
                this.sourceTextarea.setSelectionRange(0, 0);
                this.sourceTextarea.scrollTop = 0;
                this.sourceTextarea.focus({ preventScroll: true });
                setTimeout(() => {
                    this.sourceTextarea.setSelectionRange(0, 0);
                    this.sourceTextarea.scrollTop = 0;
                }, 0);
            });
        } else if (this.ready && this.editor?.setValue && this.sourceTextarea) {
            this.editor.setValue(this.prepareDisplayValue(this.sourceTextarea.value || ''));
            this._lastValue = this.sourceTextarea.value || '';
            this.buildHeadingIndex();
            this.decorateRenderedMarks();
            this.scheduleDecorateRenderedMarks();
        }
    }
}
