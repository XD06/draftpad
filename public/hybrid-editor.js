import { stripHybridDisplayArtifacts } from './managers/hybrid-display-sanitizer.js';
import {
    buildTimeMarker,
    buildUpdatedTimeMarker,
    deleteTimeMarker,
    handleTimeCommandKeydown,
    moveTimeMarker,
    renderTimeMarkers,
    replaceTimeMarker,
    TIME_COMMAND
} from './managers/time-command.js';
import { ARTICLE_FILE_ACCEPT, AssetApiClient, isImageFile } from './managers/asset-api-client.js';
import {
    buildArticleFileMarkdown,
    FILE_COMMAND,
    findFileCommandBeforeCursor,
    findFileCommandInMarkdownBlock,
    replaceFileCommand
} from './managers/article-file-command.js';
import { moveStandaloneMarkdownBlock, splitTopLevelMarkdownBlocks } from './managers/article-block-move.js';
import {
    findCodeLanguageSuggestions,
    getCodeLanguageIconPath,
    resolveCodeLanguage
} from './managers/code-language-catalog.js';
import {
    buildCodeFenceMarkdown,
    buildPendingCodeFenceText,
    normalizeCodeFenceLanguage,
    parseCodeFenceCommand,
    PENDING_CODE_FENCE_GUARD,
    readCodeFenceBody,
    readCodeFenceLanguage,
    replaceCodeFenceLanguage
} from './managers/code-fence-command.js';
import { lexer as lexMarkdown } from '/js/marked/marked.esm.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MARK_PROTECTED_SELECTOR = [
    'pre:not(.vditor-reset)',
    'code',
    '.mermaid',
    '.mermaid-block',
    '.language-mermaid',
    '.md-time-marker'
].join(',');

// Vditor renders `language-mermaid` during every WYSIWYG setValue/input pass.
// Keep Mermaid source intact while using a private display-only language so a
// malformed or expensive diagram cannot block the editor itself.
const DISPLAY_MERMAID_LANGUAGE = 'dumbpad-mermaid';

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
        this.isComposing = false;
        this.assetApi = new AssetApiClient();
        this.assetUploadTasks = new Set();
        this.articleUploadStates = new Map();
        this.articleFileCommand = null;
        this.codeLanguagePopover = null;
        this.activeCodeLanguageBlock = null;
        this.activeCodeLanguageAnchor = null;
        this.codeLanguageSuggestions = [];
        this.activeCodeLanguageSuggestion = -1;
        this.isCodeLanguageComposing = false;
        this.decorationGeneration = 0;
        this.articleDecorationTimers = new Set();
        this.codeDecorationFrame = 0;

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
            input: () => this.handleVditorInput(),
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
                this.bindTimeMarkerDragging();
                this.decorateArticleImages();
                // Connect marker protection immediately now that
                // Vditor's DOM is available, rather than waiting for
                // the 100 ms polling loop in bindMarkerProtection.
                this.connectMarkerObserver();
                // Multi-pass decoration: Vditor performs async
                // re-processing (Lute re-parse, syntax highlighting,
                // etc.) that can strip rendered inline marks back to
                // raw source text.  Retry at increasing delays to
                // catch each wave of re-processing.
                this.decorateRenderedMarks();
                this.scheduleDecorateRenderedMarks();
                setTimeout(() => this.decorateRenderedMarks(), 80);
                setTimeout(() => this.decorateRenderedMarks(), 240);
                this.scheduleArticleDecorationPass();
            }
        });

        this.emitChange = debounce(() => {
            const value = this.sourceMode && this.sourceTextarea
                ? this.sourceTextarea.value
                : this.readWysiwygMarkdownValue(this._lastValue || '');
            this._lastValue = value;
            this.buildHeadingIndex();
            this.onInput(value);
            this.dispatch('input', { value });
            this.dispatch('change', { value });
        }, 120);

        this.syncTheme();
        this.themeObserver = new MutationObserver(() => this.syncTheme());
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        this.setupSelectionMenu();
        this.bindReadingModeGuard();
        this.bindArticleFileInteractions();
        this.bindMermaidPasteNormalization();
        this.bindArticleImageInteractions();
        this.bindArticleUploadInteractions();
        this.createArticleFileInput();
        this.bindCompositionEvents();
        this.bindTimeCommand();
        this.bindCodeBlockCaretPlacement();
        this.bindMarkerProtection();
        this.buildHeadingIndex();
    }

    suppressProgrammaticInput() {
        this.suppressInput = true;
        clearTimeout(this.suppressInputTimer);
        this.suppressInputTimer = setTimeout(() => {
            this.suppressInput = false;
        }, 180);
    }

    suppressNextVditorInput() {
        this.skipNextVditorInput = true;
        clearTimeout(this.skipNextVditorInputTimer);
        this.skipNextVditorInputTimer = setTimeout(() => {
            this.skipNextVditorInput = false;
            this.skipNextVditorInputTimer = null;
        }, 1200);
    }

    handleVditorInput() {
        if (this.skipNextVditorInput) {
            this.skipNextVditorInput = false;
            clearTimeout(this.skipNextVditorInputTimer);
            this.skipNextVditorInputTimer = null;
            return;
        }
        this.scheduleMissingCodeBlockDecoration();
        this.preferLastValueUntilInput = false;
        if (this.isDecorating || this.suppressInput || this.isComposing) return;
        if (this.handlePendingCodeFenceInput()) return;
        this.handleWysiwygInput();
    }

    scheduleMissingCodeBlockDecoration() {
        cancelAnimationFrame(this.missingCodeDecorationFrame);
        this.missingCodeDecorationFrame = requestAnimationFrame(() => {
            this.missingCodeDecorationFrame = 0;
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!root || this.sourceMode || this.isComposing) return;
            const missing = new Set(
                Array.from(root.querySelectorAll('pre > code')).filter(code =>
                    !code.parentElement?.querySelector(':scope > .dumbpad-code-header')
                )
            );
            if (missing.size) this.decorateCodeBlockLineNumbers(root, missing);
        });
    }

    getValue() {
        if (this.sourceMode && this.sourceTextarea) return this.sourceTextarea.value;
        if (this.preferLastValueUntilInput) return this.stripDisplayGuards(this._lastValue || this.pendingValue || '');
        if (!this.ready || !this.editor?.getValue) return this.stripDisplayGuards(this.pendingValue || this._lastValue || '');
        return this.readWysiwygMarkdownValue(this._lastValue || this.pendingValue || '');
    }

    setValue(value = '', emit = true) {
        const normalized = this.stripDisplayGuards(value);
        this.cancelPendingArticleDecorations();
        clearTimeout(this.pendingCodeFenceFocusTimer);
        this.pendingCodeFenceFocusTimer = null;
        this.preferLastValueUntilInput = false;
        this._lastValue = normalized;
        if (this.ready && this.editor?.setValue) {
            if (!emit) this.suppressProgrammaticInput();
            this.editor.setValue(this.prepareDisplayValue(normalized));
            this.setEditable(!this.isReadingMode);
            this.decorateRenderedMarks();
            this.decorateArticleImages();
            this.scheduleDecorateRenderedMarks();
            this.scheduleArticleDecorationPass();
            // Vditor's async re-processing can strip inline marks after the
            // synchronous pass; keep the mark-only retries, not full scans.
            setTimeout(() => this.decorateRenderedMarks(), 80);
            setTimeout(() => this.decorateRenderedMarks(), 240);
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

    setWysiwygValueAtMarkdownOffset(value = '', markdownOffset = 0, emit = true) {
        const normalized = this.stripDisplayGuards(value);
        this.cancelPendingArticleDecorations();
        this.preferLastValueUntilInput = false;
        const safeOffset = Math.min(Math.max(0, Number(markdownOffset) || 0), normalized.length);
        const marker = '\uE001';
        const valueWithCaretMarker = `${normalized.slice(0, safeOffset)}${marker}${normalized.slice(safeOffset)}`;
        this._lastValue = normalized;

        if (this.ready && this.editor?.setValue) {
            this.suppressProgrammaticInput();
            this.wysiwygCaretRestore = { marker, markdownOffset: safeOffset };
            this.editor.setValue(this.prepareDisplayValue(valueWithCaretMarker));
            this.setEditable(!this.isReadingMode);
            this.restoreWysiwygCaretFromMarker();
            this.decorateRenderedMarks();
            this.decorateArticleImages();
            this.scheduleDecorateRenderedMarks();
            this.scheduleArticleDecorationPass();
            setTimeout(() => {
                this.restoreWysiwygCaretFromMarker();
                this.decorateRenderedMarks();
            }, 80);
            setTimeout(() => {
                if (!this.restoreWysiwygCaretFromMarker()) this.restoreWysiwygCaretFallback();
                this.decorateRenderedMarks();
            }, 240);
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

    restoreWysiwygCaretFromMarker() {
        const pending = this.wysiwygCaretRestore;
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!pending || !root) return false;

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const index = String(node.nodeValue || '').indexOf(pending.marker);
            if (index < 0) continue;
            node.nodeValue = `${node.nodeValue.slice(0, index)}${node.nodeValue.slice(index + pending.marker.length)}`;
            const range = document.createRange();
            range.setStart(node, index);
            range.collapse(true);
            this.editor?.focus?.();
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            this.wysiwygCaretRestore = null;
            requestAnimationFrame(() => this.scrollRangeIntoView(range));
            return true;
        }
        return false;
    }

    restoreWysiwygCaretFallback() {
        const pending = this.wysiwygCaretRestore;
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!pending || !root) return false;
        this.editor?.focus?.();
        this.restoreSelectionOffset(root, pending.markdownOffset);
        this.wysiwygCaretRestore = null;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) requestAnimationFrame(() => this.scrollRangeIntoView(range));
        return Boolean(range);
    }

    scrollRangeIntoView(range) {
        const scroller = this.container.querySelector('.vditor-wysiwyg');
        if (!scroller || !range) return;
        const rangeRect = range.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        if (!rangeRect.height || !scrollerRect.height) return;
        const upperBound = scrollerRect.top + 48;
        const lowerBound = scrollerRect.bottom - 72;
        if (rangeRect.top >= upperBound && rangeRect.bottom <= lowerBound) return;
        scroller.scrollTop += rangeRect.top - scrollerRect.top - Math.max(48, (scrollerRect.height - rangeRect.height) / 2);
    }

    notifyEditorValueChanged(value = '') {
        const normalized = !this.sourceMode && this.ready
            ? this.readWysiwygMarkdownValue(value || this._lastValue || '')
            : this.stripDisplayGuards(value);
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
        this.decorateArticleImages();
        this.scheduleDecorateRenderedMarks();
        requestAnimationFrame(() => {
            restoreScroll();
            this.decorateRenderedMarks();
            this.decorateArticleImages({ decorateCode: false });
        });
        this.scheduleArticleDecorationPass(120);
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

    prepareMermaidDisplayValue(value = '') {
        return String(value || '')
            .replace(/(^|\n)([ \t]*`{3,})mermaid([ \t]*)(?=\n|$|\uE001)/gi, `$1$2${DISPLAY_MERMAID_LANGUAGE}$3`);
    }

    prepareDisplayValue(value = '') {
        return this.prepareMermaidDisplayValue(value)
            .split('\n')
            .map(line => /^\s*<(?:mark\b|span\s+data-(?:draw|note)\b)/i.test(line) ? `\u200B${line}` : line)
            .join('\n');
    }

    stripDisplayGuards(value = '') {
        return stripHybridDisplayArtifacts(value);
    }

    readWysiwygMarkdownValue(fallback = '') {
        const rawValue = this.editor?.getValue?.() || fallback || '';
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');

        // Check if DOM has any rendered marks that editor.getValue()
        // might not preserve (Lute may strip or convert them).
        const hasRenderedMarks = root?.querySelector?.(
            '.md-time-marker[data-time-source], mark.md-mark, [data-draw], .has-annotation, .article-upload-card[data-article-upload-token], pre.dumbpad-code-lines[data-line-numbers], pre > .dumbpad-code-header, .vditor-wysiwyg__block[data-type="code-block"]'
        );

        if (!hasRenderedMarks || typeof this.editor?.html2md !== 'function') {
            return this.restoreEditorDisplayLanguages(this.stripDisplayGuards(rawValue));
        }

        return this.serializeWysiwygRoot(root, rawValue);
    }

    serializeWysiwygRoot(root, fallback = '', { preservePendingCodeFence = false } = {}) {
        if (!root || typeof this.editor?.html2md !== 'function') {
            return this.restoreEditorDisplayLanguages(this.stripDisplayGuards(fallback));
        }
        const codeLanguages = Array.from(
            root.querySelectorAll(':scope > .vditor-wysiwyg__block[data-type="code-block"]')
        ).map(block => {
            const code = block.querySelector('.vditor-wysiwyg__pre > code, .vditor-wysiwyg__preview > code');
            return this.getRenderedCodeBlockLanguage(code);
        });
        const clone = root.cloneNode(true);
        clone.querySelectorAll('.dumbpad-mermaid-render').forEach(render => render.remove());
        this.restoreArticleUploadPlaceholders(clone);
        this.restoreCodeBlockLineNumberDecorations(clone);
        this.restoreRenderedTimeMarkers(clone);
        this.restoreAllRenderedMarks(clone);
        const rawSerialized = this.editor.html2md(clone.innerHTML) || fallback;
        const cleanSerialized = preservePendingCodeFence
            ? this.stripDisplayGuardsPreservingPendingCodeFence(rawSerialized)
            : this.stripDisplayGuards(rawSerialized);
        const serialized = this.restoreEditorDisplayLanguages(cleanSerialized);
        return this.restoreSerializedCodeLanguages(serialized, codeLanguages);
    }

    stripDisplayGuardsPreservingPendingCodeFence(value = '') {
        return String(value || '')
            .split(PENDING_CODE_FENCE_GUARD)
            .map(part => this.stripDisplayGuards(part))
            .join(PENDING_CODE_FENCE_GUARD);
    }

    restoreSerializedCodeLanguages(value = '', codeLanguages = []) {
        const parsed = splitTopLevelMarkdownBlocks(value, lexMarkdown);
        if (!parsed.ok) return value;
        const codeBlockIndexes = parsed.blocks
            .map((block, index) => block.type === 'code' ? index : -1)
            .filter(index => index >= 0);
        if (codeBlockIndexes.length !== codeLanguages.length) return value;
        let changed = false;
        let codeIndex = 0;
        const blocks = parsed.blocks.map(block => {
            if (block.type !== 'code') return block.raw;
            const language = String(codeLanguages[codeIndex++] || '');
            if (!language) return block.raw;
            const current = readCodeFenceLanguage(block.raw);
            if (current === language) return block.raw;
            const replacement = replaceCodeFenceLanguage(block.raw, language);
            if (replacement === null) return block.raw;
            changed = true;
            return replacement;
        });
        if (!changed) return value;
        return parsed.gaps[0] + blocks.map((block, index) => block + parsed.gaps[index + 1]).join('');
    }

    restoreEditorDisplayLanguages(value = '') {
        return String(value || '').replace(
            new RegExp(`(^|\\n)([ \\t]*` + '`{3,})' + DISPLAY_MERMAID_LANGUAGE + `([ \\t]*)(?=\\n|$|\\uE001)`, 'gi'),
            `$1$2mermaid$3`
        );
    }

    cancelPendingArticleDecorations() {
        this.decorationGeneration += 1;
        this.articleDecorationTimers.forEach(timer => clearTimeout(timer));
        this.articleDecorationTimers.clear();
        if (this.codeDecorationFrame) cancelAnimationFrame(this.codeDecorationFrame);
        this.codeDecorationFrame = 0;
    }

    scheduleArticleDecorationPass(delay = 120) {
        const generation = this.decorationGeneration;
        const timer = setTimeout(() => {
            this.articleDecorationTimers.delete(timer);
            if (generation !== this.decorationGeneration) return;
            this.decorateArticleImages();
            if (this.isReadingMode) this.renderMermaidDiagrams();
        }, delay);
        this.articleDecorationTimers.add(timer);
    }

    /**
     * Restore rendered inline marks (highlight, draw, annotation) back
     * to their source HTML form in a cloned DOM tree.
     *
     * We use TEXT NODES (not real HTML elements) because html2md (Lute)
     * strips unknown HTML elements like <span data-draw>.  By creating
     * text nodes containing the raw HTML source, the browser escapes
     * them as &lt;span...&gt; in innerHTML.  Lute's HTML2MD then
     * preserves them as text, and when the markdown is later loaded
     * by setValue(), Lute decodes the entities back to raw HTML text
     * in a text node, which renderInlineMarks() then converts to
     * rendered elements.
     */
    restoreAllRenderedMarks(root) {
        if (!root) return;

        // Restore <mark class="md-mark"> back to <mark>text</mark>
        root.querySelectorAll('mark.md-mark').forEach(mark => {
            const text = mark.textContent || '';
            mark.replaceWith(document.createTextNode(`<mark>${text}</mark>`));
        });

        // Restore [data-draw] back to source HTML
        root.querySelectorAll('[data-draw]').forEach(span => {
            const text = span.textContent || '';
            span.replaceWith(document.createTextNode(
                `<span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">${text}</span>`
            ));
        });

        // Restore .has-annotation back to source HTML
        root.querySelectorAll('.has-annotation').forEach(span => {
            const comment = span.dataset.comment || '';
            const markedText = span.querySelector('span[style*="wavy"]')?.textContent || span.textContent || '';
            const safeComment = this.escapeAttribute(comment);
            const htmlLabel = this.escapeHtml(comment);
            span.replaceWith(document.createTextNode(
                `<span data-note="${safeComment}" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">${markedText}</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（${htmlLabel}）</sub>`
            ));
        });
    }

    restoreRenderedTimeMarkers(root) {
        root?.querySelectorAll?.('.md-time-marker[data-time-source]').forEach(marker => {
            marker.replaceWith(document.createTextNode(marker.dataset.timeSource || ''));
        });
    }

    restoreArticleUploadPlaceholders(root) {
        root?.querySelectorAll?.('.article-upload-card[data-article-upload-token]').forEach(card => {
            card.replaceWith(document.createTextNode(card.dataset.articleUploadToken || ''));
        });
    }

    restoreCodeBlockLineNumberDecorations(root) {
        root?.querySelectorAll?.('pre').forEach(pre => {
            pre.querySelector(':scope > .dumbpad-code-header')?.remove();
            pre.querySelector(':scope > .dumbpad-code-tools')?.remove();
            pre.querySelector(':scope > .dumbpad-code-language-badge')?.remove();
            pre.classList.remove('dumbpad-code-lines');
            delete pre.dataset.lineNumbers;
            delete pre.dataset.dumbpadCodeSignature;
        });
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
        const needle = String(keyword).trim();
        if (!needle) return;
        const lower = needle.toLowerCase();
        const value = this.getValue();
        const markdownIndex = value.toLowerCase().indexOf(lower);
        if (this.sourceMode && this.sourceTextarea && markdownIndex >= 0) {
            this.sourceTextarea.setSelectionRange(markdownIndex, markdownIndex + needle.length);
            this.sourceCaretOffset = markdownIndex;
            this.sourceTextarea.focus();
            return;
        }

        const range = this.findRenderedTextRange(needle);
        if (range) {
            const target = this.closestElement(range.startContainer, 'p, li, h1, h2, h3, h4, h5, h6, blockquote') || this.renderedRoot();
            this.showKeywordHighlight(range);
            this.scrollRenderedElementIntoView(target);
            return;
        }

        const lineIndex = value
            .split('\n')
            .findIndex(line => line.toLowerCase().includes(lower));
        if (lineIndex >= 0) this.scrollToLine(lineIndex, keyword);
    }

    findRenderedTextRange(keyword) {
        const root = this.renderedRoot();
        if (!root || !keyword) return null;
        const lower = String(keyword).toLowerCase();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (this.isMarkProtectedNode(node)) continue;
            const start = String(node.nodeValue || '').toLowerCase().indexOf(lower);
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + keyword.length);
            return range;
        }
        return null;
    }

    showKeywordHighlight(range) {
        clearTimeout(this.keywordHighlightTimer);
        const highlights = window.CSS?.highlights;
        if (!highlights || typeof window.Highlight !== 'function') return;
        this.keywordHighlight = new window.Highlight(range);
        highlights.set('dumbpad-search-hit', this.keywordHighlight);
        this.keywordHighlightTimer = setTimeout(() => {
            highlights.delete('dumbpad-search-hit');
            this.keywordHighlight = null;
        }, 1800);
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
        this.hideCodeLanguagePopover(false);
        this.hideSelectionMenu();
        window.getSelection()?.removeAllRanges();
        if (this.isReadingMode && this.sourceMode) {
            this.setSourceMode(false);
        }
        this.container.classList.toggle('is-reading-mode', this.isReadingMode);
        if (this.sourceToggle) this.sourceToggle.hidden = this.isReadingMode;
        this.setEditable(!this.isReadingMode);
        if (this.isReadingMode) this.renderMermaidDiagrams();
        else this.restoreMermaidCodePreviews();
    }

    bindCodeBlockCaretPlacement() {
        this.container.addEventListener('pointerdown', event => {
            if (this.isReadingMode || this.sourceMode || event.button !== 0) return;
            clearTimeout(this.pendingCodeFenceFocusTimer);
            this.pendingCodeFenceFocusTimer = null;
            const preview = event.target?.closest?.('.vditor-wysiwyg__preview');
            const block = preview?.closest?.('.vditor-wysiwyg__block[data-type="code-block"]');
            const source = block?.querySelector?.('.vditor-wysiwyg__pre > code');
            if (!preview || !source) return;
            const previewRect = preview.getBoundingClientRect();
            this.pendingCodePointer = {
                contentX: Math.max(0, event.clientX - previewRect.left),
                contentY: Math.max(0, event.clientY - previewRect.top),
                source
            };
        }, true);
        this.container.addEventListener('click', event => {
            const pending = this.pendingCodePointer;
            this.pendingCodePointer = null;
            if (!pending?.source?.isConnected || this.isReadingMode || this.sourceMode) return;
            requestAnimationFrame(() => this.restoreCodeCaretFromPointer(pending));
        }, true);
    }

    restoreCodeCaretFromPointer({ contentX, contentY, source }) {
        const documentAtPoint = source.ownerDocument;
        const sourceRect = source.getBoundingClientRect();
        const clientX = sourceRect.left + contentX;
        const clientY = sourceRect.top + contentY;
        let range = documentAtPoint.caretRangeFromPoint?.(clientX, clientY) || null;
        if (!range && documentAtPoint.caretPositionFromPoint) {
            const position = documentAtPoint.caretPositionFromPoint(clientX, clientY);
            if (position) {
                range = documentAtPoint.createRange();
                range.setStart(position.offsetNode, position.offset);
                range.collapse(true);
            }
        }
        if (!range || !source.contains(range.startContainer)) {
            const text = source.textContent || '';
            const rect = source.getBoundingClientRect();
            const style = getComputedStyle(source);
            const lineHeight = parseFloat(style.lineHeight) || 20;
            const lines = text.split('\n');
            const lineIndex = Math.min(lines.length - 1, Math.max(0, Math.floor((clientY - rect.top) / lineHeight)));
            const before = lines.slice(0, lineIndex).reduce((count, line) => count + line.length + 1, 0);
            const averageWidth = Math.max(6, (parseFloat(style.fontSize) || 13) * 0.62);
            const column = Math.min(lines[lineIndex]?.length || 0, Math.max(0, Math.round((clientX - rect.left) / averageWidth)));
            const walker = documentAtPoint.createTreeWalker(source, NodeFilter.SHOW_TEXT);
            let node;
            let remaining = before + column;
            while ((node = walker.nextNode())) {
                if (remaining <= node.nodeValue.length) {
                    range = documentAtPoint.createRange();
                    range.setStart(node, remaining);
                    range.collapse(true);
                    break;
                }
                remaining -= node.nodeValue.length;
            }
        }
        if (!range || !source.contains(range.startContainer)) return;
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    renderMermaidDiagrams() {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!root || !window.Vditor?.mermaidRender) return;
        let hasMermaid = false;
        root.querySelectorAll('.vditor-wysiwyg__preview > code').forEach(code => {
            if (this.getRenderedCodeBlockLanguage(code) !== 'mermaid') return;
            const preview = code.parentElement;
            const block = preview?.closest?.('.vditor-wysiwyg__block[data-type="code-block"]');
            if (!block || block.querySelector(':scope > .dumbpad-mermaid-render')) return;
            const render = document.createElement('div');
            render.className = 'dumbpad-mermaid-render language-mermaid';
            render.setAttribute('contenteditable', 'false');
            render.textContent = code.textContent || '';
            block.appendChild(render);
            hasMermaid = true;
        });
        if (!hasMermaid) return;
        window.Vditor.mermaidRender(
            root,
            '/vendor/vditor-package',
            document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'classic'
        );
    }

    restoreMermaidCodePreviews() {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        root?.querySelectorAll?.('.dumbpad-mermaid-render').forEach(render => render.remove());
        this.decorateCodeBlockLineNumbers(root);
    }

    handleWysiwygInput() {
        this.scheduleDecorateRenderedMarks();
        requestAnimationFrame(() => this.decorateArticleImages({ decorateCode: false }));
        clearTimeout(this.typingDecorateTimer);
        this.typingDecorateTimer = setTimeout(() => this.decorateRenderedMarks(), 80);
        this.emitChange();
    }

    emitSourceInput() {
        this.sourceCaretOffset = this.sourceTextarea.selectionStart;
        this._lastValue = this.sourceTextarea.value;
        this.buildHeadingIndex();
        this.onInput(this._lastValue);
        this.dispatch('input', { value: this._lastValue });
        this.dispatch('change', { value: this._lastValue });
    }

    isEditorInputTarget(target) {
        return target === this.sourceTextarea || Boolean(target?.closest?.('.vditor-wysiwyg'));
    }

    bindCompositionEvents() {
        this.container.addEventListener('compositionstart', (event) => {
            if (!this.isEditorInputTarget(event.target)) return;
            this.isComposing = true;
            clearTimeout(this.typingDecorateTimer);
        }, true);

        this.container.addEventListener('compositionend', (event) => {
            if (!this.isEditorInputTarget(event.target)) return;
            this.isComposing = false;

            requestAnimationFrame(() => {
                if (this.sourceMode && event.target === this.sourceTextarea) {
                    this.emitSourceInput();
                    return;
                }
                this.handleWysiwygInput();
            });
        }, true);
    }

    setEditable(enabled) {
        if (!this.ready) return;
        if (enabled && this.editor?.enable) {
            this.editor?.enable?.();
        }
        this.container.querySelectorAll('[contenteditable]').forEach(el => {
            if (el.classList?.contains('md-time-marker') || el.classList?.contains('article-upload-card') ||
                el.closest?.('.dumbpad-code-header')) return;
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
        this.sourceTextarea.addEventListener('input', (event) => {
            this.sourceCaretOffset = this.sourceTextarea.selectionStart;
            this._lastValue = this.sourceTextarea.value;
            if (event.isComposing || this.isComposing) return;
            this.emitSourceInput();
        });
        ['select', 'click', 'keyup'].forEach(type => {
            this.sourceTextarea.addEventListener(type, () => {
                this.sourceCaretOffset = this.sourceTextarea.selectionStart;
            });
        });
        this.sourceCommandKeydownHandler = (event) => {
            if (this.isReadingMode || !this.sourceMode || this.isComposing) return;
            if (this.handleSourceFileCommand(event)) return;
            handleTimeCommandKeydown(event);
        };
        this.sourceTextarea.addEventListener('keydown', this.sourceCommandKeydownHandler);

        this.sourceToggle = document.createElement('button');
        this.sourceToggle.type = 'button';
        this.sourceToggle.className = 'typora-source-toggle';
        this.sourceToggle.setAttribute('aria-label', 'Toggle Markdown source');
        this.sourceToggle.setAttribute('data-tooltip', 'Markdown Source');
        this.sourceToggle.textContent = '</>';
        this.sourceToggle.hidden = this.isReadingMode;
        this.sourceToggle.addEventListener('click', () => this.setSourceMode(!this.sourceMode));

        this.container.appendChild(this.sourceTextarea);
        this.sourceToggleAnchor = document.createComment('source-toggle-anchor');
        this.container.appendChild(this.sourceToggleAnchor);
        this.container.appendChild(this.sourceToggle);

        this.sourceToggleMedia = window.matchMedia('(min-width: 981px)');
        this.syncSourceTogglePlacement = () => {
            const floatingActions = document.querySelector('.floating-actions');
            if (this.sourceToggleMedia.matches && floatingActions) {
                this.sourceToggle.classList.add('floating-btn', 'floating-source-toggle');
                floatingActions.appendChild(this.sourceToggle);
                return;
            }

            this.sourceToggle.classList.remove('floating-btn', 'floating-source-toggle');
            this.sourceToggleAnchor.after(this.sourceToggle);
        };
        this.sourceToggleMedia.addEventListener?.('change', this.syncSourceTogglePlacement);
        this.syncSourceTogglePlacement();
    }

    scheduleDecorateRenderedMarks() {
        cancelAnimationFrame(this.decorateFrame);
        this.decorateFrame = requestAnimationFrame(() => this.decorateRenderedMarks());
    }

    decorateRenderedMarks(preserveCaret = true) {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!root || this.sourceMode || this.isComposing) return;

        this.isDecorating = true;

        // --- Phase 1: Scan for raw marker source in text nodes ---
        // This is the cheapest check and determines whether we need
        // to do any DOM modifications at all.
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

        // --- Phase 2: Quick-check for code-wrapped marks ---
        // Vditor sometimes wraps raw HTML like <mark> in <code> tags.
        // Check if any <code> element contains such raw HTML.
        let hasCodeWrappedMarks = false;
        if (targets.length === 0) {
            for (const codeEl of root.querySelectorAll('code')) {
                const t = codeEl.textContent || '';
                if (t.includes('<mark') || t.includes('<span data-draw') || t.includes('<span data-note') || t.includes('</mark>') || t.includes('</span>')) {
                    hasCodeWrappedMarks = true;
                    break;
                }
            }
        }

        // --- Phase 3: Early return if nothing to do ---
        // This is the critical optimisation: when the user is just
        // typing normal text (no raw markers), we skip ALL DOM
        // operations — no decorateCodeTagMarks, no
        // decorateCodeWrappedTags, no lockInlineMarks, no caret
        // save/restore.  This prevents cursor jumping during typing.
        if (targets.length === 0 && !hasCodeWrappedMarks) {
            this.isDecorating = false;
            return;
        }

        // --- Phase 4: Process code-wrapped marks if needed ---
        if (hasCodeWrappedMarks || targets.length > 0) {
            root.querySelectorAll('p, li').forEach(parent => {
                if (!this.isMarkProtectedNode(parent)) this.decorateCodeTagMarks(parent);
            });
        }

        // Re-scan after code-wrapped mark processing may have
        // converted <code> elements into text nodes
        if (hasCodeWrappedMarks && targets.length === 0) {
            const w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            while ((node = w2.nextNode())) {
                if (this.isMarkProtectedNode(node)) continue;
                const text = node.nodeValue || '';
                if (text.includes('==') || text.includes('[[time:') || text.includes('<mark') || text.includes('<span data-draw') || text.includes('<span data-note')) {
                    targets.push(node);
                }
            }
        }

        if (targets.length === 0) {
            // Code-wrapped marks were processed but no text node
            // targets remain.  Just lock and return.
            this.lockInlineMarks(root);
            this.isDecorating = false;
            return;
        }

        let didReplace = false;

        // --- Caret preservation using zero-width marker ---
        // Insert \uFEFF at the caret position in the target text node.
        // renderInlineMarks preserves \uFEFF (it only strips \u200B).
        // After all DOM operations, find \uFEFF and place the caret there.
        //
        // This is far more robust than text-counting approaches because
        // the marker travels through the HTML transformation intact,
        // regardless of how many characters are consumed by decoration
        // (e.g. ==text== → <mark>text</mark> changes text length by -4).
        //
        // We only need to do this when the caret is INSIDE a target
        // text node — if the caret is elsewhere, replacing target nodes
        // doesn't affect it.
        const CARET_MARKER = '\uFEFF';
        const caretSnapshot = preserveCaret ? this.saveCaretSnapshot(root) : null;
        let caretMarked = false;
        if (preserveCaret) {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0 && selection.isCollapsed) {
                const range = selection.getRangeAt(0);
                const caretNode = range.startContainer;
                const caretOffset = range.startOffset;
                for (const target of targets) {
                    if (caretNode === target) {
                        const text = target.nodeValue || '';
                        target.nodeValue = text.slice(0, caretOffset) + CARET_MARKER + text.slice(caretOffset);
                        caretMarked = true;
                        break;
                    }
                }
            }
        }

        for (const textNode of targets) {
            const html = this.renderInlineMarks(textNode.nodeValue || '');
            if (!html) continue;
            const template = document.createElement('template');
            template.innerHTML = html;
            textNode.parentNode?.replaceChild(template.content, textNode);
            didReplace = true;
        }

        if (didReplace) {
            this.ensureTimeMarkerTrailingGuard(root);
            // Only process code-wrapped tags when we actually replaced
            // text nodes — otherwise it's an expensive no-op that
            // reads/writes innerHTML and can cause cursor jumps.
            this.decorateCodeWrappedTags(root);
        }

        this.lockInlineMarks(root);

        // --- Restore caret from zero-width marker ---
        if (caretMarked) {
            const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = w.nextNode())) {
                const text = n.nodeValue || '';
                const idx = text.indexOf(CARET_MARKER);
                if (idx >= 0) {
                    n.nodeValue = text.slice(0, idx) + text.slice(idx + 1);
                    try {
                        const range = document.createRange();
                        range.setStart(n, idx);
                        range.collapse(true);
                        const selection = window.getSelection();
                        selection?.removeAllRanges();
                        selection?.addRange(range);
                    } catch (_e) {}
                    break;
                }
            }
        } else if (didReplace && caretSnapshot) {
            this.restoreCaretSnapshot(root, caretSnapshot);
        }

        this.isDecorating = false;
    }

    /**
     * MutationObserver that watches for Vditor breaking rendered inline
     * marks (time markers, highlights, etc.) back into raw source text.
     * When detected, immediately re-decorates in the same microtask,
     * before the browser paints, so the user never sees the raw source.
     */
    bindMarkerProtection() {
        this.markerObserver = new MutationObserver(records => {
            if (this.isDecorating || this.sourceMode || this.isComposing) return;
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!root) return;

            const changedCode = new Set();
            let inspectMarks = false;
            records.forEach(record => {
                const origin = record.target?.nodeType === Node.ELEMENT_NODE
                    ? record.target
                    : record.target?.parentElement;
                if (origin?.closest?.('.dumbpad-code-header, .dumbpad-code-language-popover')) return;
                const code = origin?.closest?.('pre > code');
                if (code) changedCode.add(code);
                if (record.type === 'characterData') inspectMarks = true;
                record.addedNodes?.forEach(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;
                    node.querySelectorAll?.('pre > code').forEach(item => changedCode.add(item));
                    if (!node.closest?.('pre, code, .dumbpad-code-header')) inspectMarks = true;
                });
            });
            if (changedCode.size) {
                cancelAnimationFrame(this.codeDecorationFrame);
                this.codeDecorationFrame = requestAnimationFrame(() => {
                    this.codeDecorationFrame = 0;
                    this.decorateCodeBlockLineNumbers(root, changedCode);
                });
            }
            if (!inspectMarks) return;

            // Check if any text node now contains raw marker source
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            let needsFix = false;
            while ((node = walker.nextNode())) {
                if (this.isMarkProtectedNode(node)) continue;
                const text = node.nodeValue || '';
                if (text.includes('[[time:') || text.includes('==') ||
                    text.includes('<mark') || text.includes('<span data-draw') ||
                    text.includes('<span data-note')) {
                    needsFix = true;
                    break;
                }
            }
            if (needsFix) this.scheduleDecorateRenderedMarks();
        });

        // Attempt to connect immediately; if Vditor's DOM isn't ready
        // yet, the `after` callback will call connectMarkerObserver()
        // again as soon as Vditor finishes initialising.
        this.connectMarkerObserver();
    }

    /**
     * Connect (or re-connect) the MutationObserver to Vditor's content
     * root.  Safe to call multiple times — disconnects first to avoid
     * duplicate observers.  Called from bindMarkerProtection() in the
     * constructor and again from the Vditor `after` callback to ensure
     * the observer is active as early as possible.
     */
    connectMarkerObserver() {
        if (!this.markerObserver) return;
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (root) {
            this.markerObserver.disconnect();
            this.markerObserver.observe(root, {
                childList: true,
                subtree: true,
                characterData: true
            });
        } else {
            // Vditor not ready yet — retry shortly.
            setTimeout(() => this.connectMarkerObserver(), 100);
        }
    }

    /**
     * Save a snapshot of the caret position using text context
     * rather than numeric offsets.  This is robust against DOM
     * mutations because we search for the same text context
     * after decoration to find the correct position.
     */
    saveCaretSnapshot(root) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        if (!root.contains(range.startContainer)) return null;
        if (!range.collapsed) return null;

        const container = range.startContainer;
        const offset = range.startOffset;

        // Build a text snapshot: all visible text before the caret.
        const preRange = document.createRange();
        preRange.selectNodeContents(root);
        preRange.setEnd(container, offset);
        const beforeText = preRange.toString().replace(/\u200B/g, '');

        return { beforeText };
    }

    /**
     * Restore caret from a snapshot by finding the text position
     * that matches the saved 'beforeText' length.
     * Unlike restoreSelectionOffset, this counts ALL visible text
     * (including text inside protected nodes like time markers)
     * because Vditor's serialization includes marker source text.
     */
    restoreCaretSnapshot(root, snapshot) {
        if (!snapshot) return;
        const target = snapshot.beforeText.length;

        if (target === 0) {
            // Caret was at the very beginning of the content.
            // Place it at the start of the first editable text node
            // to prevent cursor loss on mobile (which closes keyboard).
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let firstNode;
            while ((firstNode = walker.nextNode())) {
                if (!this.isMarkProtectedNode(firstNode)) break;
            }
            if (firstNode) {
                try {
                    const range = document.createRange();
                    range.setStart(firstNode, 0);
                    range.collapse(true);
                    const selection = window.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                } catch (_e) {}
            }
            return;
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let count = 0;
        let node;
        while ((node = walker.nextNode())) {
            const text = (node.nodeValue || '').replace(/\u200B/g, '');
            const len = text.length;
            if (count + len >= target) {
                // Found the right text node
                let actualOffset = 0;
                let visibleCount = 0;
                for (const ch of node.nodeValue || '') {
                    if (visibleCount >= target - count) break;
                    actualOffset++;
                    if (ch !== '\u200B') visibleCount++;
                }
                try {
                    const range = document.createRange();
                    range.setStart(node, actualOffset);
                    range.collapse(true);
                    const selection = window.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                } catch (_e) {}
                return;
            }
            count += len;
        }
    }

    /** Keep time markers atomic while leaving user-authored marked text editable. */
    lockInlineMarks(root) {
        root.querySelectorAll('.md-time-marker').forEach(el => {
            // Only set the attribute if it's not already set.
            // Setting the same value still triggers MutationObserver
            // callbacks and can cause unnecessary browser re-layouts.
            if (el.getAttribute('contenteditable') !== 'false') {
                el.setAttribute('contenteditable', 'false');
            }
        });
    }

    /**
     * Save the collapsed caret position as a visible-character offset,
     * skipping text inside protected nodes (code blocks, time markers, etc).
     * Both save and restore use the same counting logic so offsets stay
     * consistent across DOM mutations.
     */
    saveSelectionOffset(root) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        if (!root.contains(range.startContainer)) return null;
        if (!range.collapsed) return null;

        // Fast path: caret is inside a text node
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
            if (this.isMarkProtectedNode(range.startContainer)) return null;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let count = 0;
            let node;
            while ((node = walker.nextNode())) {
                if (this.isMarkProtectedNode(node)) continue;
                if (node === range.startContainer) {
                    const visibleBefore = String(node.nodeValue || '')
                        .slice(0, range.startOffset)
                        .replace(/\u200B/g, '').length;
                    return count + visibleBefore;
                }
                count += (node.nodeValue || '').replace(/\u200B/g, '').length;
            }
        }

        // Slow path: caret is between elements (e.g. right after a time marker span)
        // Walk all child nodes of the start container to find the position
        const container = range.startContainer;
        const offset = range.startOffset;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let count = 0;
        let node;
        let found = false;
        while ((node = walker.nextNode())) {
            if (this.isMarkProtectedNode(node)) continue;
            if (found) break;
            // Check if this text node is at or after the caret position
            const parent = node.parentElement;
            if (parent === container) {
                const childIndex = Array.from(container.childNodes).indexOf(node);
                if (childIndex >= offset) {
                    found = true;
                    break;
                }
            }
            // Also check ancestors
            if (container !== root && container.contains?.(node)) {
                // The caret is before this text node in the tree
                found = true;
                break;
            }
            count += (node.nodeValue || '').replace(/\u200B/g, '').length;
        }
        return count;
    }

    restoreSelectionOffset(root, offset) {
        if (offset == null || offset < 0) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        let count = 0;
        while ((node = walker.nextNode())) {
            if (this.isMarkProtectedNode(node)) continue;
            const text = (node.nodeValue || '').replace(/\u200B/g, '');
            const len = text.length;
            if (count + len >= offset) {
                let actualOffset = 0;
                let visibleCount = 0;
                for (const ch of node.nodeValue || '') {
                    if (visibleCount >= offset - count) break;
                    actualOffset++;
                    if (ch !== '\u200B') visibleCount++;
                }
                try {
                    const range = document.createRange();
                    range.setStart(node, actualOffset);
                    range.collapse(true);
                    const selection = window.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                } catch (_e) {
                    // node may have been removed during decoration
                }
                return;
            }
            count += len;
        }

        // Fallback: place caret at end of last non-protected text node
        let last = null;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
            if (!this.isMarkProtectedNode(n)) last = n;
        }
        if (last) {
            try {
                const range = document.createRange();
                range.setStart(last, last.nodeValue?.length || 0);
                range.collapse(true);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
            } catch (_e) {}
        }
    }

    ensureTimeMarkerTrailingGuard(root) {
        root.querySelectorAll('.md-time-marker').forEach(marker => {
            const next = marker.nextSibling;
            if (!next || next.nodeType !== Node.TEXT_NODE || !next.nodeValue) {
                marker.after(document.createTextNode('\u200B'));
            }
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
        html = renderTimeMarkers(html, 'md-time-marker', { draggable: true });
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
        // Preserve newlines: HTML parser collapses \n in text content
        // into whitespace, which would merge adjacent lines.  Convert
        // them to <br> so that soft breaks survive the text-to-HTML
        // conversion.  This is safe because all generated HTML tags
        // (mark, span, time-marker) contain no literal \n.
        html = html.replace(/\n/g, '<br>');
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

    async copyTextToClipboard(text) {
        const value = String(text || '');
        if (!value) return false;
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch (_error) {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            return copied;
        }
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
            if (text) await this.copyTextToClipboard(text);
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
            const clickedBadge = Boolean(event.target.closest('.annotation-badge'));
            if (this.isReadingMode || clickedBadge) {
                event.preventDefault();
                event.stopPropagation();
            }
            this.showAnnotationPopover(annotation, clickedBadge);
        });
    }

    bindTimeMarkerPopover() {
        if (this.timeMarkerPopoverBound) return;
        this.timeMarkerPopoverBound = true;
        this.container.addEventListener('click', (event) => {
            const marker = event.target.closest('.md-time-marker');
            if (!marker || !this.container.contains(marker)) return;
            if (Date.now() - (this.lastTimeMarkerDragAt || 0) < 250) return;
            event.preventDefault();
            event.stopPropagation();
            this.hideSelectionMenu();
            this.showTimeMarkerMenu(marker);
        });
    }

    bindTimeMarkerDragging() {
        if (this.timeMarkerDragBound) return;
        this.timeMarkerDragBound = true;

        this.container.addEventListener('pointerdown', (event) => {
            if (this.isReadingMode || this.sourceMode) return;
            const marker = event.target.closest('.md-time-marker[data-time-draggable="true"]');
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!marker || !root?.contains(marker)) return;
            const sourceOffset = this.getMarkdownOffsetBeforeNode(root, marker);
            const source = marker.dataset.timeSource || '';
            if (!Number.isInteger(sourceOffset) || !source) return;
            this.timeMarkerPointerDrag = {
                marker,
                source,
                sourceOffset,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                active: false
            };
            marker.setPointerCapture?.(event.pointerId);
        });

        this.container.addEventListener('pointermove', (event) => {
            const drag = this.timeMarkerPointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
            drag.active = true;
            event.preventDefault();
            drag.marker.classList.add('is-dragging');
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            root?.classList.add('is-time-marker-drop-target');
            drag.dropOffset = root ? this.showTimeMarkerDropCaret(root, event) : null;
        });

        const finishPointerDrag = (event) => {
            const drag = this.timeMarkerPointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            this.timeMarkerPointerDrag = null;
            drag.marker.classList.remove('is-dragging');
            this.container.querySelector('.vditor-reset')?.classList.remove('is-time-marker-drop-target');
            this.hideTimeMarkerDropCaret();
            drag.marker.releasePointerCapture?.(event.pointerId);
            if (!drag.active) return;
            event.preventDefault();
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!root) return;
            const dropOffset = Number.isInteger(drag.dropOffset)
                ? drag.dropOffset
                : this.getMarkdownDropOffset(root, event);
            this.moveTimeMarkerToOffset(drag, dropOffset);
        };
        this.container.addEventListener('pointerup', finishPointerDrag);
        this.container.addEventListener('pointercancel', finishPointerDrag);
    }

    moveTimeMarkerToOffset(drag, dropOffset) {
        if (!drag || !Number.isInteger(dropOffset)) return false;
        const value = this.readWysiwygMarkdownValue(this._lastValue || '');
        const next = moveTimeMarker(value, drag.source, drag.sourceOffset, dropOffset);
        if (next === value) return false;

        const caretOffset = this.getMovedTimeMarkerCaretOffset(drag, dropOffset, next.length);
        this.setWysiwygValueAtMarkdownOffset(next, caretOffset, true);
        this.lastTimeMarkerDragAt = Date.now();
        return true;
    }

    getMovedTimeMarkerCaretOffset(drag, dropOffset, valueLength) {
        const offsetAfterMarker = dropOffset < drag.sourceOffset
            ? dropOffset + drag.source.length
            : dropOffset;
        return Math.min(Math.max(0, offsetAfterMarker), valueLength);
    }

    getMarkdownOffsetBeforeNode(root, node) {
        const parent = node?.parentNode;
        if (!parent) return null;
        const offset = Array.prototype.indexOf.call(parent.childNodes, node);
        return offset < 0 ? null : this.getMarkdownOffsetForDomPoint(root, parent, offset);
    }

    getCaretRangeFromPoint(clientX, clientY) {
        let range = document.caretRangeFromPoint?.(clientX, clientY) || null;
        if (!range && document.caretPositionFromPoint) {
            const position = document.caretPositionFromPoint(clientX, clientY);
            if (position) {
                range = document.createRange();
                range.setStart(position.offsetNode, position.offset);
                range.collapse(true);
            }
        }
        return range;
    }

    getMarkdownDropOffset(root, event) {
        const range = this.getCaretRangeFromPoint(event.clientX, event.clientY);
        if (!range || !root.contains(range.startContainer)) return null;
        return this.getMarkdownOffsetForDomPoint(root, range.startContainer, range.startOffset);
    }

    ensureTimeMarkerDropCaret() {
        if (this.timeMarkerDropCaret) return this.timeMarkerDropCaret;
        const caret = document.createElement('div');
        caret.className = 'time-marker-drop-caret';
        caret.setAttribute('aria-hidden', 'true');
        caret.hidden = true;
        document.body.appendChild(caret);
        this.timeMarkerDropCaret = caret;
        return caret;
    }

    showTimeMarkerDropCaret(root, event) {
        const range = this.getCaretRangeFromPoint(event.clientX, event.clientY);
        if (!range || !root.contains(range.startContainer)) {
            this.hideTimeMarkerDropCaret();
            return null;
        }

        const dropOffset = this.getMarkdownOffsetForDomPoint(root, range.startContainer, range.startOffset);
        if (!Number.isInteger(dropOffset)) {
            this.hideTimeMarkerDropCaret();
            return null;
        }

        const rect = range.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 24;
        const height = Math.max(16, rect.height || lineHeight);
        const left = rect.width || rect.height
            ? rect.left
            : Math.min(Math.max(event.clientX, rootRect.left), rootRect.right);
        const top = rect.height
            ? rect.top
            : Math.min(Math.max(event.clientY - height / 2, rootRect.top), rootRect.bottom - height);
        const caret = this.ensureTimeMarkerDropCaret();
        caret.classList.remove('is-block-drop-caret');
        caret.style.removeProperty('width');
        caret.style.left = `${Math.round(left)}px`;
        caret.style.top = `${Math.round(top)}px`;
        caret.style.height = `${Math.round(height)}px`;
        caret.hidden = false;
        return dropOffset;
    }

    hideTimeMarkerDropCaret() {
        if (!this.timeMarkerDropCaret) return;
        this.timeMarkerDropCaret.hidden = true;
        this.timeMarkerDropCaret.classList.remove('is-block-drop-caret');
        this.timeMarkerDropCaret.style.removeProperty('width');
    }

    showTimeMarkerMenu(marker) {
        const menu = this.ensureTimeMarkerMenu();
        const source = marker.dataset.timeSource || '';
        if (!source) return;
        this.activeTimeMarker = { source, marker };
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
        const marker = this.activeTimeMarker?.marker;
        if (!this.sourceMode && marker?.isConnected && this.container.contains(marker)) {
            this.hideTimeMarkerMenu();
            const nextMarker = action === 'delete' ? '' : buildUpdatedTimeMarker(source, new Date());
            this.replaceRenderedTimeMarker(marker, nextMarker);
            this.notifyEditorValueChanged();
            this.scheduleDecorateRenderedMarks();
            return;
        }

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

    replaceRenderedTimeMarker(marker, nextMarker = '') {
        if (!marker) return;
        const replacement = nextMarker
            ? this.createRenderedTimeMarker(nextMarker)
            : document.createTextNode('');
        marker.replaceWith(replacement);
        if (nextMarker && replacement.nodeType === Node.ELEMENT_NODE) {
            this.placeCaretAfterNode(replacement);
        }
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
            if (target.closest('.vditor-copy, .code-lang-copy-button, .dumbpad-code-copy')) return;
            if (target.closest('.vditor-reset img[data-dumbpad-asset], .vditor-reset img[src*="/api/assets/"], .vditor-reset img[src^="data:image/"]')) return;
            if (target.closest('.vditor-reset a.dumbpad-article-file')) return;
            if (target.closest('.vditor-reset')) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
    }

    createArticleFileInput() {
        if (this.articleFileInput) return this.articleFileInput;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = ARTICLE_FILE_ACCEPT;
        input.className = 'article-file-command-input';
        input.tabIndex = -1;
        input.setAttribute('aria-hidden', 'true');
        input.addEventListener('change', () => this.handleArticleFileSelection());
        input.addEventListener('cancel', () => {
            this.articleFileCommand = null;
        });
        this.container.appendChild(input);
        this.articleFileInput = input;
        return input;
    }

    requestArticleFileSelection(commandRange) {
        const input = this.createArticleFileInput();
        if (!commandRange) return false;
        this.articleFileCommand = { ...commandRange };
        input.value = '';
        input.click();
        return true;
    }

    createArticleUploadToken() {
        return `[[资源上传中 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}]]`;
    }

    replaceArticleFileCommandWithPlaceholders(commandRange, tokens) {
        const replacement = tokens.join('\n\n');
        if (this.sourceMode && this.sourceTextarea) {
            const replaced = replaceFileCommand(this.sourceTextarea.value, commandRange, replacement);
            if (!replaced) return false;
            this.sourceTextarea.value = replaced.value;
            this.sourceTextarea.setSelectionRange(replaced.selectionStart, replaced.selectionEnd);
            this.emitSourceInput();
            return true;
        }

        const value = this.getValue();
        const replaced = replaceFileCommand(value, commandRange, replacement);
        if (!replaced) return false;
        this.setWysiwygValueAtMarkdownOffset(replaced.value, replaced.selectionStart, true);
        return true;
    }

    handleArticleFileSelection() {
        const commandRange = this.articleFileCommand;
        this.articleFileCommand = null;
        const input = this.articleFileInput;
        const files = Array.from(input?.files || []);
        if (!commandRange || files.length === 0) return;

        const tokens = files.map(() => this.createArticleUploadToken());
        if (!this.replaceArticleFileCommandWithPlaceholders(commandRange, tokens)) {
            this.editor?.tip?.('插入位置已变化，请重新输入 /file', 3500);
            return;
        }
        files.forEach((file, index) => {
            this.queueArticleAssetUpload(file, { token: tokens[index], alreadyInserted: true });
        });
    }

    bindArticleFileInteractions() {
        if (this.articleFileInteractionsBound) return;
        this.articleFileInteractionsBound = true;

        this.bindArticleFileDragging();

        this.container.addEventListener('dragstart', event => {
            const link = event.target.closest('.vditor-reset a.dumbpad-article-file');
            if (link && !this.isReadingMode) event.preventDefault();
        });

        this.container.addEventListener('click', event => {
            const link = event.target.closest('.vditor-reset a.dumbpad-article-file');
            if (!link || this.isReadingMode) return;
            if (Date.now() - (this.lastArticleFileDragAt || 0) < 250 || Date.now() - (this.lastArticleFileTapAt || 0) < 450) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            this.openArticleFileMenu(link);
        }, true);
    }

    bindArticleFileDragging() {
        if (this.articleFileDragBound) return;
        this.articleFileDragBound = true;

        this.container.addEventListener('pointerdown', event => {
            if (this.isReadingMode || this.sourceMode || (event.pointerType === 'mouse' && event.button !== 0)) return;
            const file = event.target.closest('.vditor-reset a.dumbpad-article-file');
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!file || !root?.contains(file) || !this.getArticleFileBlock(file, root)) return;

            if (event.pointerType !== 'mouse') event.preventDefault();
            this.articleFilePointerDrag = {
                file,
                pointerId: event.pointerId,
                pointerType: event.pointerType,
                startX: event.clientX,
                startY: event.clientY,
                active: false
            };
            file.setPointerCapture?.(event.pointerId);
        });

        this.container.addEventListener('pointermove', event => {
            const drag = this.articleFilePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;

            drag.active = true;
            event.preventDefault();
            this.hideArticleFileMenu();
            drag.file.classList.add('is-article-file-dragging');
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            root?.classList.add('is-article-image-drop-target');
            if (!root) return;
            drag.lastClientX = event.clientX;
            drag.lastClientY = event.clientY;
            drag.dropTarget = this.getArticleImageDropTarget(root, event);
            this.showArticleImageDropCaret(root, drag.dropTarget, event);
            this.startArticleFileDragAutoScroll(drag);
        });

        const finishPointerDrag = event => {
            const drag = this.articleFilePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            this.articleFilePointerDrag = null;
            drag.file.classList.remove('is-article-file-dragging');
            this.container.querySelector('.vditor-reset')?.classList.remove('is-article-image-drop-target');
            this.stopArticleImageDragAutoScroll(drag);
            this.hideTimeMarkerDropCaret();
            drag.file.releasePointerCapture?.(event.pointerId);
            if (!drag.active) {
                if (drag.pointerType !== 'mouse') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.lastArticleFileTapAt = Date.now();
                    this.openArticleFileMenu(drag.file);
                }
                return;
            }

            event.preventDefault();
            this.lastArticleFileDragAt = Date.now();
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!root) return;
            const dropTarget = drag.dropTarget || this.getArticleImageDropTarget(root, event);
            this.moveArticleFileToTarget(drag, dropTarget);
        };

        this.container.addEventListener('pointerup', finishPointerDrag);
        this.container.addEventListener('pointercancel', finishPointerDrag);
    }

    getArticleFileBlock(link, root) {
        if (!link || !root) return null;

        let block = link;
        while (block.parentElement && block.parentElement !== root) {
            block = block.parentElement;
        }
        if (block.parentElement !== root) return null;

        const links = Array.from(block.querySelectorAll('a.dumbpad-article-file'));
        const isNestedContent = Boolean(link.closest('li, blockquote, td, th'));
        const text = String(block.textContent || '').replace(/\u200B/g, '').trim();
        const linkText = String(link.textContent || '').replace(/\u200B/g, '').trim();
        if (links.length !== 1 || links[0] !== link || isNestedContent || text !== linkText) return null;
        if (block.matches('ul, ol, table, blockquote')) return null;
        return block;
    }

    startArticleFileDragAutoScroll(drag) {
        const scroller = this.container.querySelector('.vditor-wysiwyg');
        if (!drag || !scroller) return;
        const rect = scroller.getBoundingClientRect();
        const edge = Math.min(72, Math.max(40, rect.height * 0.16));
        const topDistance = drag.lastClientY - rect.top;
        const bottomDistance = rect.bottom - drag.lastClientY;
        if (topDistance < edge) {
            drag.autoScrollSpeed = -Math.max(4, Math.round((edge - topDistance) / 5));
        } else if (bottomDistance < edge) {
            drag.autoScrollSpeed = Math.max(4, Math.round((edge - bottomDistance) / 5));
        } else {
            this.stopArticleImageDragAutoScroll(drag);
            return;
        }

        if (drag.autoScrollFrame) return;
        const tick = () => {
            if (this.articleFilePointerDrag !== drag || !drag.active || !drag.autoScrollSpeed) {
                this.stopArticleImageDragAutoScroll(drag);
                return;
            }
            scroller.scrollTop += drag.autoScrollSpeed;
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (root) {
                const pointer = { clientX: drag.lastClientX, clientY: drag.lastClientY };
                drag.dropTarget = this.getArticleImageDropTarget(root, pointer);
                this.showArticleImageDropCaret(root, drag.dropTarget, pointer);
            }
            drag.autoScrollFrame = requestAnimationFrame(tick);
        };
        drag.autoScrollFrame = requestAnimationFrame(tick);
    }

    moveArticleFileToTarget(drag, dropTarget) {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const sourceBlock = this.getArticleFileBlock(drag?.file, root);
        const targetBlock = dropTarget?.block;
        if (!root || !sourceBlock || !targetBlock || !root.contains(targetBlock)) return false;
        if (sourceBlock === targetBlock) return false;

        const before = this.getSafeArticleFileDragValue(root, drag.file);
        if (!before) {
            this.editor?.tip?.('附件需独占一段，且源码中只能出现一次', 3000);
            return false;
        }

        const sourceIndex = Array.from(root.children).indexOf(sourceBlock);
        const targetIndex = Array.from(root.children).indexOf(targetBlock);
        const targetFingerprint = this.createArticleMoveDropTargetFingerprint(root, targetBlock);
        const moved = moveStandaloneMarkdownBlock({
            value: before.value,
            markdown: before.fileMarkdown,
            sourceIndex,
            targetIndex,
            placement: dropTarget.placement,
            lexer: lexMarkdown,
            expectedBlockCount: root.children.length
        });
        if (!moved.ok || !this.isSafeArticleFileMove(before, moved.value, drag.file)) {
            if (!drag.structureRetryAttempted && this.scheduleArticleAssetMoveRetry({
                kind: 'file',
                sourceIdentity: this.createArticleMoveSourceIdentity('file', drag.file),
                targetFingerprint,
                placement: dropTarget.placement,
                value: before.value
            })) return false;
            this.editor?.tip?.('附件移动未保存，文章块结构与源码不一致', 3000);
            return false;
        }

        if (dropTarget.placement === 'before') {
            if (sourceBlock.nextElementSibling === targetBlock) return false;
            targetBlock.before(sourceBlock);
        } else {
            if (sourceBlock.previousElementSibling === targetBlock) return false;
            targetBlock.after(sourceBlock);
        }

        this.commitArticleImageDragValue(moved.value, sourceBlock);
        return true;
    }

    getSafeArticleFileDragValue(root, link) {
        if (!root || !link) return null;
        const value = this.stripDisplayGuards(this._lastValue || this.pendingValue || '');
        const fileMarkdown = this.findStandaloneArticleFileMarkdown(value, link);
        return value && fileMarkdown ? { value, fileMarkdown } : null;
    }

    findStandaloneArticleFileMarkdown(value, link) {
        const href = String(link?.getAttribute?.('href') || '');
        const title = String(link?.getAttribute?.('title') || '');
        if (!href || !title.startsWith('dumbpad-file=1')) return null;
        const escapedHref = this.escapeRegExp(href);
        const escapedTitle = this.escapeRegExp(title);
        const expression = new RegExp(`\\[(?:\\\\.|[^\\]\\n])*\\]\\(${escapedHref}\\s+"${escapedTitle}"\\)`, 'g');
        const matches = Array.from(String(value || '').matchAll(expression));
        if (matches.length !== 1) return null;

        const match = matches[0];
        const start = match.index;
        const markdown = match[0];
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEndIndex = value.indexOf('\n', start + markdown.length);
        const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
        if (value.slice(lineStart, lineEnd).trim() !== markdown) return null;
        return markdown;
    }

    removeStandaloneArticleFileMarkdown(value, markdown) {
        const start = value.indexOf(markdown);
        if (start < 0 || value.indexOf(markdown, start + markdown.length) >= 0) return null;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEndIndex = value.indexOf('\n', start + markdown.length);
        const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex + 1;
        if (value.slice(lineStart, lineEnd).trim() !== markdown) return null;
        return `${value.slice(0, lineStart)}${value.slice(lineEnd)}`
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    isSafeArticleFileMove(before, next, link) {
        const markdown = before?.fileMarkdown;
        if (!markdown || !next) return false;
        const beforeWithoutFile = this.removeStandaloneArticleFileMarkdown(before.value, markdown);
        const nextWithoutFile = this.removeStandaloneArticleFileMarkdown(next, markdown);
        return beforeWithoutFile !== null && nextWithoutFile !== null && beforeWithoutFile === nextWithoutFile;
    }

    bindMermaidPasteNormalization() {
        if (this.mermaidPasteBound) return;
        this.mermaidPasteBound = true;
        this.container.addEventListener('paste', event => {
            if (event.dumbpadMermaidNormalized) return;
            if (this.isReadingMode || this.sourceMode || !this.isEditorInputTarget(event.target)) return;
            if (event.clipboardData?.files?.length) return;

            const selection = window.getSelection();
            const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
            if (range && this.closestElement(range.startContainer, 'code')) return;
            if (event.target?.closest?.('code, .vditor-wysiwyg__pre')) return;

            const text = event.clipboardData?.getData('text/plain') || '';
            if (!text) return;
            const displayValue = this.prepareMermaidDisplayValue(text);
            if (displayValue === text) return;

            let normalizedEvent;
            try {
                const transfer = new DataTransfer();
                transfer.setData('text/plain', displayValue);
                normalizedEvent = new ClipboardEvent('paste', {
                    clipboardData: transfer,
                    bubbles: true,
                    cancelable: true,
                    composed: true
                });
                Object.defineProperty(normalizedEvent, 'dumbpadMermaidNormalized', { value: true });
            } catch (_error) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            event.target.dispatchEvent(normalizedEvent);
        }, true);
    }

    bindArticleImageInteractions() {
        this.bindArticleImageDragging();

        this.container.addEventListener('paste', event => {
            if (this.isReadingMode || !this.isEditorInputTarget(event.target)) return;
            const files = Array.from(event.clipboardData?.files || []).filter(isImageFile);
            if (!files.length) return;
            event.preventDefault();
            // Vditor handles image files even when the event is default-prevented.
            // Stop it here so it cannot add a second Base64 image beside ours.
            event.stopImmediatePropagation?.();
            files.forEach(file => this.queueArticleImageUpload(file));
        }, true);

        this.container.addEventListener('click', event => {
            const image = event.target.closest('.vditor-reset img');
            const assetId = this.getArticleAssetId(image);
            if (!image || (!assetId && !this.isLegacyArticleImage(image))) return;
            if (Date.now() - (this.lastArticleImageDragAt || 0) < 250) return;
            if (Date.now() - (this.lastArticleImageTouchTapAt || 0) < 450) return;
            event.preventDefault();
            event.stopPropagation();
            if (this.isReadingMode) {
                this.hideArticleImageSizeMenu();
                this.openArticleImageLightbox(image, assetId);
                return;
            }
            this.openArticleImageSizeMenu(image);
        });
    }

    bindArticleImageDragging() {
        if (this.articleImageDragBound) return;
        this.articleImageDragBound = true;

        // Native image drag conflicts with Vditor's contenteditable model and
        // can leave the browser's drag selection active. Pointer events give
        // us a deterministic cleanup path and reuse the existing drop caret.
        this.container.addEventListener('dragstart', event => {
            const image = event.target.closest('.vditor-reset img.dumbpad-article-image');
            if (image && !this.isReadingMode) event.preventDefault();
        });

        this.container.addEventListener('pointerdown', event => {
            if (this.isReadingMode || this.sourceMode || (event.pointerType === 'mouse' && event.button !== 0)) return;
            const image = event.target.closest('.vditor-reset img.dumbpad-article-image');
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!image || !root?.contains(image)) return;

            if (!this.getArticleImageBlock(image, root)) return;

            // A touch on contenteditable otherwise focuses Vditor before the
            // click handler runs, which opens the mobile keyboard and moves
            // its selection even when the user only wants image controls.
            if (event.pointerType !== 'mouse') event.preventDefault();

            this.articleImagePointerDrag = {
                image,
                pointerId: event.pointerId,
                pointerType: event.pointerType,
                startX: event.clientX,
                startY: event.clientY,
                active: false
            };
            image.setPointerCapture?.(event.pointerId);
        });

        this.container.addEventListener('pointermove', event => {
            const drag = this.articleImagePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;

            drag.active = true;
            event.preventDefault();
            this.hideArticleImageSizeMenu();
            drag.image.classList.add('is-article-image-dragging');
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            root?.classList.add('is-article-image-drop-target');
            if (!root) return;
            drag.lastClientX = event.clientX;
            drag.lastClientY = event.clientY;
            drag.dropTarget = this.getArticleImageDropTarget(root, event);
            this.showArticleImageDropCaret(root, drag.dropTarget, event);
            this.startArticleImageDragAutoScroll(drag);
        });

        const finishPointerDrag = event => {
            const drag = this.articleImagePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            this.articleImagePointerDrag = null;
            drag.image.classList.remove('is-article-image-dragging');
            this.container.querySelector('.vditor-reset')?.classList.remove('is-article-image-drop-target');
            this.stopArticleImageDragAutoScroll(drag);
            this.hideTimeMarkerDropCaret();
            drag.image.releasePointerCapture?.(event.pointerId);
            if (!drag.active) {
                if (drag.pointerType !== 'mouse') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.lastArticleImageTouchTapAt = Date.now();
                    this.openArticleImageSizeMenu(drag.image);
                }
                return;
            }

            event.preventDefault();
            this.lastArticleImageDragAt = Date.now();
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!root) return;
            const dropTarget = drag.dropTarget || this.getArticleImageDropTarget(root, event);
            this.moveArticleImageToTarget(drag, dropTarget);
        };

        this.container.addEventListener('pointerup', finishPointerDrag);
        this.container.addEventListener('pointercancel', finishPointerDrag);
    }

    getArticleImageBlock(image, root) {
        if (!image || !root) return null;

        let block = image;
        while (block.parentElement && block.parentElement !== root) {
            block = block.parentElement;
        }
        if (block.parentElement !== root) return null;

        const images = Array.from(block.querySelectorAll('img.dumbpad-article-image'));
        const isNestedContent = Boolean(image.closest('li, blockquote, td, th'));
        const text = String(block.textContent || '').replace(/\u200B/g, '').trim();
        if (images.length !== 1 || images[0] !== image || isNestedContent || text) return null;
        if (block.matches('ul, ol, table, blockquote')) return null;
        return block;
    }

    getArticleImageDropTarget(root, event) {
        const blocks = Array.from(root?.children || []);
        if (!blocks.length) return null;

        let pointElement = document.elementFromPoint(event.clientX, event.clientY);
        let block = null;
        while (pointElement && pointElement.parentElement !== root) {
            pointElement = pointElement.parentElement;
        }
        if (pointElement?.parentElement === root) block = pointElement;

        if (!block) {
            const firstBlock = blocks[0];
            const lastBlock = blocks[blocks.length - 1];
            if (event.clientY <= firstBlock.getBoundingClientRect().top) {
                return { block: firstBlock, placement: 'before' };
            }
            if (event.clientY >= lastBlock.getBoundingClientRect().bottom) {
                return { block: lastBlock, placement: 'after' };
            }
            block = blocks.reduce((nearest, candidate) => {
                const candidateRect = candidate.getBoundingClientRect();
                const nearestRect = nearest.getBoundingClientRect();
                const candidateDistance = Math.abs(event.clientY - (candidateRect.top + candidateRect.height / 2));
                const nearestDistance = Math.abs(event.clientY - (nearestRect.top + nearestRect.height / 2));
                return candidateDistance < nearestDistance ? candidate : nearest;
            }, firstBlock);
        }

        const rect = block.getBoundingClientRect();
        return {
            block,
            placement: !rect.height || event.clientY < rect.top + (rect.height / 2) ? 'before' : 'after'
        };
    }

    showArticleImageDropCaret(root, target, event) {
        if (!root || !target?.block) {
            this.hideTimeMarkerDropCaret();
            return;
        }
        const rootRect = root.getBoundingClientRect();
        const blockRect = target.block.getBoundingClientRect();
        const caret = this.ensureTimeMarkerDropCaret();
        caret.classList.add('is-block-drop-caret');
        caret.style.left = `${Math.round(rootRect.left)}px`;
        caret.style.top = `${Math.round(target.placement === 'before' ? blockRect.top - 1 : blockRect.bottom - 1)}px`;
        caret.style.width = `${Math.max(24, Math.round(rootRect.width))}px`;
        caret.style.height = '2px';
        caret.hidden = false;
    }

    startArticleImageDragAutoScroll(drag) {
        const scroller = this.container.querySelector('.vditor-wysiwyg');
        if (!drag || !scroller) return;
        const rect = scroller.getBoundingClientRect();
        const edge = Math.min(72, Math.max(40, rect.height * 0.16));
        const topDistance = drag.lastClientY - rect.top;
        const bottomDistance = rect.bottom - drag.lastClientY;
        if (topDistance < edge) {
            drag.autoScrollSpeed = -Math.max(4, Math.round((edge - topDistance) / 5));
        } else if (bottomDistance < edge) {
            drag.autoScrollSpeed = Math.max(4, Math.round((edge - bottomDistance) / 5));
        } else {
            this.stopArticleImageDragAutoScroll(drag);
            return;
        }

        if (drag.autoScrollFrame) return;
        const tick = () => {
            if (this.articleImagePointerDrag !== drag || !drag.active || !drag.autoScrollSpeed) {
                this.stopArticleImageDragAutoScroll(drag);
                return;
            }
            scroller.scrollTop += drag.autoScrollSpeed;
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (root) {
                const pointer = { clientX: drag.lastClientX, clientY: drag.lastClientY };
                drag.dropTarget = this.getArticleImageDropTarget(root, pointer);
                this.showArticleImageDropCaret(root, drag.dropTarget, pointer);
            }
            drag.autoScrollFrame = requestAnimationFrame(tick);
        };
        drag.autoScrollFrame = requestAnimationFrame(tick);
    }

    stopArticleImageDragAutoScroll(drag) {
        if (!drag) return;
        if (drag.autoScrollFrame) cancelAnimationFrame(drag.autoScrollFrame);
        drag.autoScrollFrame = null;
        drag.autoScrollSpeed = 0;
    }

    moveArticleImageToTarget(drag, dropTarget) {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const sourceBlock = this.getArticleImageBlock(drag?.image, root);
        const targetBlock = dropTarget?.block;
        if (!root || !sourceBlock || !targetBlock || !root.contains(targetBlock)) return false;
        if (sourceBlock === targetBlock) return false;

        const before = this.getSafeArticleImageDragValue(root, drag.image);
        if (!before) {
            this.editor?.tip?.('图片需独占一段，且源码中只能出现一次', 3000);
            return false;
        }

        const sourceIndex = Array.from(root.children).indexOf(sourceBlock);
        const targetIndex = Array.from(root.children).indexOf(targetBlock);
        const targetFingerprint = this.createArticleMoveDropTargetFingerprint(root, targetBlock);
        const moved = moveStandaloneMarkdownBlock({
            value: before.value,
            markdown: before.imageMarkdown,
            sourceIndex,
            targetIndex,
            placement: dropTarget.placement,
            lexer: lexMarkdown,
            expectedBlockCount: root.children.length
        });
        if (!moved.ok || !this.isSafeArticleImageMove(before, moved.value, drag.image)) {
            if (!drag.structureRetryAttempted && this.scheduleArticleAssetMoveRetry({
                kind: 'image',
                sourceIdentity: this.createArticleMoveSourceIdentity('image', drag.image),
                targetFingerprint,
                placement: dropTarget.placement,
                value: before.value
            })) return false;
            this.editor?.tip?.('图片移动未保存，文章块结构与源码不一致', 3000);
            return false;
        }

        if (dropTarget.placement === 'before') {
            if (sourceBlock.nextElementSibling === targetBlock) return false;
            targetBlock.before(sourceBlock);
        } else {
            if (sourceBlock.previousElementSibling === targetBlock) return false;
            targetBlock.after(sourceBlock);
        }

        this.commitArticleImageDragValue(moved.value, sourceBlock);
        return true;
    }

    createArticleMoveSourceIdentity(kind, element) {
        if (kind === 'image') {
            return {
                assetId: this.getArticleAssetId(element),
                source: String(element?.getAttribute?.('src') || '')
            };
        }
        return {
            href: String(element?.getAttribute?.('href') || ''),
            title: String(element?.getAttribute?.('title') || '')
        };
    }

    createArticleMoveDropTargetFingerprint(root, block) {
        const children = Array.from(root?.children || []);
        const image = block?.querySelector?.('img.dumbpad-article-image');
        const file = block?.querySelector?.('a.dumbpad-article-file');
        return {
            index: children.indexOf(block),
            tagName: String(block?.tagName || '').toLowerCase(),
            text: String(block?.textContent || '').replace(/\u200B/g, '').trim().slice(0, 180),
            imageAssetId: this.getArticleAssetId(image),
            imageSource: String(image?.getAttribute?.('src') || ''),
            fileHref: String(file?.getAttribute?.('href') || ''),
            fileTitle: String(file?.getAttribute?.('title') || '')
        };
    }

    resolveArticleMoveDropTarget(root, targetFingerprint) {
        const blocks = Array.from(root?.children || []);
        if (!blocks.length || !targetFingerprint) return null;
        const scored = blocks.map((block, index) => {
            const current = this.createArticleMoveDropTargetFingerprint(root, block);
            let score = -Math.abs(index - targetFingerprint.index);
            if (current.tagName === targetFingerprint.tagName) score += 4;
            if (targetFingerprint.text && current.text === targetFingerprint.text) score += 12;
            if (targetFingerprint.imageAssetId && current.imageAssetId === targetFingerprint.imageAssetId) score += 18;
            else if (targetFingerprint.imageSource && current.imageSource === targetFingerprint.imageSource) score += 14;
            if (targetFingerprint.fileHref && current.fileHref === targetFingerprint.fileHref) score += 18;
            if (targetFingerprint.fileTitle && current.fileTitle === targetFingerprint.fileTitle) score += 4;
            return { block, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored[0]?.block || null;
    }

    findArticleMoveSource(root, kind, identity) {
        if (!root || !identity) return null;
        if (kind === 'image') {
            return Array.from(root.querySelectorAll('img.dumbpad-article-image')).find(image => {
                const assetId = this.getArticleAssetId(image);
                const source = String(image.getAttribute('src') || '');
                return (identity.assetId && assetId === identity.assetId) || (identity.source && source === identity.source);
            }) || null;
        }
        return Array.from(root.querySelectorAll('a.dumbpad-article-file')).find(link => (
            String(link.getAttribute('href') || '') === identity.href &&
            String(link.getAttribute('title') || '') === identity.title
        )) || null;
    }

    scheduleArticleAssetMoveRetry({ kind, sourceIdentity, targetFingerprint, placement, value }) {
        if (this.pendingArticleMoveRetry || !sourceIdentity || !targetFingerprint || !value) return false;
        this.pendingArticleMoveRetry = { kind, sourceIdentity, targetFingerprint, placement };
        const scrollTop = this.container.querySelector('.vditor-wysiwyg')?.scrollTop || 0;
        this.editor?.tip?.('正在校准旧文章结构…', 1800);
        this.setValue(value, false);

        setTimeout(() => {
            const pending = this.pendingArticleMoveRetry;
            this.pendingArticleMoveRetry = null;
            if (!pending) return;
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            const scroller = this.container.querySelector('.vditor-wysiwyg');
            if (scroller) scroller.scrollTop = scrollTop;
            this.decorateArticleImages();
            const source = this.findArticleMoveSource(root, pending.kind, pending.sourceIdentity);
            const target = this.resolveArticleMoveDropTarget(root, targetFingerprint);
            if (!source || !target) {
                this.editor?.tip?.('资源移动未保存，请重试', 3000);
                return;
            }
            const retryDrag = pending.kind === 'image'
                ? { image: source, structureRetryAttempted: true }
                : { file: source, structureRetryAttempted: true };
            const retryTarget = { block: target, placement: pending.placement };
            if (pending.kind === 'image') this.moveArticleImageToTarget(retryDrag, retryTarget);
            else this.moveArticleFileToTarget(retryDrag, retryTarget);
        }, 120);
        return true;
    }

    getSafeArticleImageDragValue(root, image) {
        if (!root || !image) return null;
        const value = this.stripDisplayGuards(this._lastValue || this.pendingValue || '');
        const imageMarkdown = this.findStandaloneArticleImageMarkdown(value, image);
        return value && imageMarkdown ? { value, imageMarkdown } : null;
    }

    findStandaloneArticleImageMarkdown(value, image) {
        const source = String(image?.getAttribute?.('src') || '');
        if (!source || /^data:image\//i.test(source)) return null;
        const escapedSource = this.escapeRegExp(source);
        const expression = new RegExp(`!\\[(?:\\\\.|[^\\]\\n])*\\]\\(${escapedSource}(?:\\s+"(?:\\\\.|[^"\\n])*")?\\)`, 'g');
        const matches = Array.from(String(value || '').matchAll(expression));
        if (matches.length !== 1) return null;

        const match = matches[0];
        const start = match.index;
        const markdown = match[0];
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEndIndex = value.indexOf('\n', start + markdown.length);
        const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
        if (value.slice(lineStart, lineEnd).trim() !== markdown) return null;
        return markdown;
    }

    removeStandaloneArticleImageMarkdown(value, markdown) {
        const start = value.indexOf(markdown);
        if (start < 0 || value.indexOf(markdown, start + markdown.length) >= 0) return null;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEndIndex = value.indexOf('\n', start + markdown.length);
        const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex + 1;
        if (value.slice(lineStart, lineEnd).trim() !== markdown) return null;
        return `${value.slice(0, lineStart)}${value.slice(lineEnd)}`
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    isSafeArticleImageMove(before, next, image) {
        const markdown = before?.imageMarkdown;
        if (!markdown || !next) return false;
        const beforeWithoutImage = this.removeStandaloneArticleImageMarkdown(before.value, markdown);
        const nextWithoutImage = this.removeStandaloneArticleImageMarkdown(next, markdown);
        return beforeWithoutImage !== null && nextWithoutImage !== null && beforeWithoutImage === nextWithoutImage;
    }

    commitArticleImageDragValue(value, sourceBlock) {
        this._lastValue = value;
        this.preferLastValueUntilInput = true;
        if (this.sourceTextarea) this.sourceTextarea.value = value;
        this.buildHeadingIndex();

        const range = document.createRange();
        range.selectNodeContents(sourceBlock);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        this.suppressNextVditorInput();
        sourceBlock.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertReplacementText'
        }));

        this.onInput(value);
        this.dispatch('input', { value });
        this.dispatch('change', { value });
        this.renderAfterMutation(this.container.querySelector('.vditor-wysiwyg')?.scrollTop || 0);
    }

    isLegacyArticleImage(image) {
        const source = String(image?.getAttribute?.('src') || image?.currentSrc || image?.src || '');
        return /^data:image\//i.test(source);
    }

    getArticleAssetId(image) {
        if (!image) return '';
        if (image.dataset?.dumbpadAsset) return image.dataset.dumbpadAsset;
        try {
            const pathname = new URL(image.currentSrc || image.src || '', window.location.href).pathname;
            return pathname.match(/^\/api\/assets\/([a-f0-9-]{16,64})\/(?:preview|original)$/i)?.[1] || '';
        } catch {
            return '';
        }
    }

    getArticleImageWidth(image) {
        const match = String(image?.getAttribute('title') || '').match(/dumbpad-width=(\d{2,4})/);
        return match ? Number(match[1]) : 0;
    }

    decorateArticleImages({ decorateCode = true } = {}) {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        root?.querySelectorAll('img').forEach(image => {
            const id = this.getArticleAssetId(image);
            if (!id && !this.isLegacyArticleImage(image)) return;
            if (id) image.dataset.dumbpadAsset = id;
            else delete image.dataset.dumbpadAsset;
            image.classList.add('dumbpad-article-image');
            image.draggable = false;
            const width = this.getArticleImageWidth(image);
            if (width) image.style.width = `${width}px`;
            else image.style.removeProperty('width');
        });
        this.decorateArticleFileLinks(root);
        this.decorateArticleUploadPlaceholders(root);
        if (decorateCode) this.decorateCodeBlockLineNumbers(root);
    }

    decorateCodeBlockLineNumbers(root = this.container.querySelector('.vditor-wysiwyg .vditor-reset'), codePres = null) {
        const candidateSet = codePres
            ? new Set(codePres)
            : Array.from(root?.querySelectorAll?.('pre > code') || []);
        if (codePres) {
            Array.from(codePres).forEach(code => {
                code.closest('.vditor-wysiwyg__block[data-type="code-block"]')
                    ?.querySelectorAll('pre > code')
                    .forEach(pair => candidateSet.add(pair));
            });
        }
        const candidates = Array.from(candidateSet);
        candidates.forEach(code => {
            const pre = code.parentElement;
            if (!pre || pre.closest('.mermaid, .mermaid-block')) return;
            const normalized = String(code.textContent || '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
            const lineCount = Math.max(1, normalized.split('\n').length);
            const lineNumbers = Array.from({ length: lineCount }, (_item, index) => index + 1).join('\n');
            const language = this.getRenderedCodeBlockLanguage(code);
            const signature = `${pre.classList.contains('vditor-wysiwyg__preview') ? 'preview' : 'edit'}:${language}:${normalized}`;
            const hasHeader = Boolean(pre.querySelector(':scope > .dumbpad-code-header'));
            if (pre.dataset.dumbpadCodeSignature === signature && hasHeader &&
                pre.dataset.lineNumbers === lineNumbers) return;
            pre.classList.add('dumbpad-code-lines');
            if (pre.dataset.lineNumbers !== lineNumbers) pre.dataset.lineNumbers = lineNumbers;

            const displayLanguage = language || 'plaintext';
            if (pre.classList.contains('vditor-wysiwyg__preview')) {
                pre.querySelector(':scope > .dumbpad-code-language-badge')?.remove();
                let header = pre.querySelector(':scope > .dumbpad-code-header.is-readonly');
                if (!header) {
                    header = document.createElement('span');
                    header.className = 'dumbpad-code-header is-readonly';
                    header.setAttribute('contenteditable', 'false');
                    header.setAttribute('aria-label', '代码块工具栏');
                    pre.appendChild(header);
                }
                let languageBadge = header.querySelector(':scope > .dumbpad-code-language-badge');
                if (!languageBadge) {
                    languageBadge = document.createElement('span');
                    languageBadge.className = 'dumbpad-code-language-badge is-readonly';
                    languageBadge.setAttribute('contenteditable', 'false');
                    languageBadge.setAttribute('aria-label', '代码块语言');
                    header.appendChild(languageBadge);
                }
                if (languageBadge.dataset.codeLanguage !== language) {
                    this.renderCodeLanguageBadge(languageBadge, displayLanguage);
                    languageBadge.dataset.codeLanguage = language;
                }
                let copyButton = header.querySelector(':scope > .dumbpad-code-copy');
                if (!copyButton) {
                    copyButton = this.createCodeCopyButton(pre);
                    header.appendChild(copyButton);
                }
                pre.dataset.dumbpadCodeSignature = signature;
                return;
            }

            if (!pre.classList.contains('vditor-wysiwyg__pre')) return;
            const block = pre.closest('.vditor-wysiwyg__block[data-type="code-block"]');
            if (!block) return;
            const existingTools = pre.querySelector(':scope > .dumbpad-code-tools');
            if (existingTools) {
                const languageButton = existingTools.querySelector(':scope > .dumbpad-code-language-badge');
                if (languageButton && languageButton.dataset.codeLanguage !== language) {
                    this.renderCodeLanguageBadge(languageButton, displayLanguage);
                    languageButton.dataset.codeLanguage = language;
                    languageButton.title = `设置代码块语言：${displayLanguage}`;
                    languageButton.setAttribute('aria-label', `设置代码块语言，当前为 ${displayLanguage}`);
                }
                pre.dataset.dumbpadCodeSignature = signature;
                return;
            }
            const tools = document.createElement('span');
            tools.className = 'dumbpad-code-header dumbpad-code-tools';
            tools.setAttribute('contenteditable', 'false');
            tools.setAttribute('aria-label', '代码块工具栏');

            const copyButton = this.createCodeCopyButton(pre);

            const languageButton = document.createElement('button');
            languageButton.type = 'button';
            languageButton.className = 'dumbpad-code-language-badge';
            this.renderCodeLanguageBadge(languageButton, displayLanguage);
            languageButton.dataset.codeLanguage = language;
            languageButton.title = `设置代码块语言：${displayLanguage}`;
            languageButton.setAttribute('aria-label', `设置代码块语言，当前为 ${displayLanguage}`);
            languageButton.setAttribute('aria-haspopup', 'listbox');
            languageButton.setAttribute('aria-expanded', 'false');
            languageButton.setAttribute('contenteditable', 'false');
            languageButton.addEventListener('mousedown', event => {
                event.preventDefault();
                event.stopPropagation();
            });
            languageButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.openCodeLanguagePopover(block, languageButton);
            });

            tools.append(languageButton, copyButton);
            pre.appendChild(tools);
            pre.dataset.dumbpadCodeSignature = signature;
        });
    }

    createCodeCopyButton(pre) {
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'dumbpad-code-copy';
        copyButton.title = '复制代码';
        copyButton.setAttribute('aria-label', '复制代码');
        copyButton.setAttribute('contenteditable', 'false');
        copyButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
        copyButton.addEventListener('mousedown', event => {
            event.preventDefault();
            event.stopPropagation();
        });
        copyButton.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const currentCode = pre.querySelector(':scope > code');
            const copied = await this.copyTextToClipboard(currentCode?.textContent || '');
            if (!copied) return;
            copyButton.classList.add('is-copied');
            copyButton.title = '已复制';
            this.editor?.tip?.('代码已复制', 1200);
            clearTimeout(copyButton._copiedTimer);
            copyButton._copiedTimer = setTimeout(() => {
                copyButton.classList.remove('is-copied');
                copyButton.title = '复制代码';
            }, 1200);
        });
        return copyButton;
    }

    renderCodeLanguageBadge(badge, language) {
        const displayLanguage = String(language || 'plaintext').trim().toLowerCase() || 'plaintext';
        const iconPath = getCodeLanguageIconPath(displayLanguage);
        const parts = [];
        if (iconPath) {
            const icon = document.createElement('img');
            icon.className = 'dumbpad-code-language-icon';
            icon.src = iconPath;
            icon.alt = '';
            icon.width = 12;
            icon.height = 12;
            icon.draggable = false;
            icon.setAttribute('aria-hidden', 'true');
            parts.push(icon);
        }
        const token = document.createElement('span');
        token.className = 'dumbpad-code-language-token';
        token.setAttribute('translate', 'no');
        token.dataset.languageLabel = displayLanguage;
        token.setAttribute('aria-hidden', 'true');
        parts.push(token);
        badge.replaceChildren(...parts);
    }

    getRenderedCodeBlockLanguage(code) {
        const languageClass = Array.from(code?.classList || []).find(name => name.startsWith('language-'));
        const language = languageClass ? languageClass.slice('language-'.length) : '';
        return language === DISPLAY_MERMAID_LANGUAGE ? 'mermaid' : language;
    }

    ensureCodeLanguagePopover() {
        if (this.codeLanguagePopover?.isConnected) return this.codeLanguagePopover;
        const popover = document.createElement('div');
        popover.className = 'dumbpad-code-language-popover';
        popover.hidden = true;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', '设置代码块语言');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dumbpad-code-language-input';
        input.placeholder = 'plaintext';
        input.setAttribute('aria-label', '搜索或输入代码块语言');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-controls', 'dumbpad-code-language-list');
        input.setAttribute('aria-expanded', 'true');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');

        const list = document.createElement('div');
        list.id = 'dumbpad-code-language-list';
        list.className = 'dumbpad-code-language-list';
        list.setAttribute('role', 'listbox');

        input.addEventListener('compositionstart', () => {
            this.isCodeLanguageComposing = true;
        });
        input.addEventListener('compositionend', () => {
            this.isCodeLanguageComposing = false;
            this.renderCodeLanguageSuggestions();
        });
        input.addEventListener('input', () => {
            if (!this.isCodeLanguageComposing) this.renderCodeLanguageSuggestions();
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.hideCodeLanguagePopover(true);
                return;
            }
            if (this.isCodeLanguageComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                this.moveCodeLanguageSuggestion(direction);
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                const selected = this.codeLanguageSuggestions[this.activeCodeLanguageSuggestion];
                this.commitCodeLanguageSelection(selected?.id || input.value);
            }
        });

        list.addEventListener('mousedown', event => event.preventDefault());
        list.addEventListener('click', event => {
            const option = event.target.closest('[data-code-language-option]');
            if (!option) return;
            event.preventDefault();
            this.commitCodeLanguageSelection(option.dataset.codeLanguageOption);
        });

        popover.append(input, list);
        document.body.appendChild(popover);
        document.addEventListener('mousedown', event => {
            if (popover.hidden) return;
            if (popover.contains(event.target) || this.activeCodeLanguageAnchor?.contains?.(event.target)) return;
            this.hideCodeLanguagePopover(false);
        });
        document.addEventListener('scroll', () => this.positionCodeLanguagePopover(), true);
        window.addEventListener('resize', () => this.positionCodeLanguagePopover());
        this.codeLanguagePopover = popover;
        return popover;
    }

    openCodeLanguagePopover(block, anchor) {
        const popover = this.ensureCodeLanguagePopover();
        const input = popover.querySelector('.dumbpad-code-language-input');
        this.activeCodeLanguageBlock = block;
        this.activeCodeLanguageAnchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        input.value = anchor.dataset.codeLanguage || '';
        input.removeAttribute('aria-invalid');
        popover.classList.remove('is-invalid');
        popover.hidden = false;
        this.renderCodeLanguageSuggestions();
        this.positionCodeLanguagePopover();
        requestAnimationFrame(() => {
            input.focus({ preventScroll: true });
            input.select();
        });
    }

    renderCodeLanguageSuggestions() {
        const popover = this.codeLanguagePopover;
        const input = popover?.querySelector('.dumbpad-code-language-input');
        const list = popover?.querySelector('.dumbpad-code-language-list');
        if (!input || !list) return;
        this.codeLanguageSuggestions = findCodeLanguageSuggestions(input.value, 3);
        this.activeCodeLanguageSuggestion = -1;
        input.removeAttribute('aria-activedescendant');
        list.innerHTML = '';
        this.codeLanguageSuggestions.forEach((item, index) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.id = `dumbpad-code-language-option-${index}`;
            option.className = 'dumbpad-code-language-option';
            option.dataset.codeLanguageOption = item.id;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.setAttribute('translate', 'no');
            option.textContent = item.id;
            list.appendChild(option);
        });
        const visibleTokens = [input.value.trim(), ...this.codeLanguageSuggestions.map(item => item.id)].filter(Boolean);
        const longestToken = visibleTokens.reduce((length, token) => Math.max(length, Array.from(token).length), 0);
        const popoverSize = Math.max(4, Math.min(12, longestToken || 9));
        popover.style.setProperty('--code-language-popover-size', String(popoverSize));
        list.hidden = this.codeLanguageSuggestions.length === 0;
        this.positionCodeLanguagePopover();
    }

    moveCodeLanguageSuggestion(direction) {
        const count = this.codeLanguageSuggestions.length;
        if (!count) return;
        const next = this.activeCodeLanguageSuggestion < 0
            ? (direction > 0 ? 0 : count - 1)
            : (this.activeCodeLanguageSuggestion + direction + count) % count;
        this.activeCodeLanguageSuggestion = next;
        const options = Array.from(this.codeLanguagePopover?.querySelectorAll('[data-code-language-option]') || []);
        options.forEach((option, index) => option.setAttribute('aria-selected', index === next ? 'true' : 'false'));
        const active = options[next];
        const input = this.codeLanguagePopover?.querySelector('.dumbpad-code-language-input');
        if (active && input) input.setAttribute('aria-activedescendant', active.id);
    }

    positionCodeLanguagePopover() {
        const popover = this.codeLanguagePopover;
        const anchor = this.activeCodeLanguageAnchor;
        if (!popover || popover.hidden || !anchor?.isConnected) return;
        const rect = anchor.getBoundingClientRect();
        const width = popover.offsetWidth || 120;
        const height = popover.offsetHeight || 120;
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
        let top = rect.bottom + 5;
        if (top + height > window.innerHeight - 8 && rect.top > height + 8) top = rect.top - height - 5;
        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(Math.max(8, top))}px`;
    }

    commitCodeLanguageSelection(value) {
        const language = resolveCodeLanguage(value);
        const popover = this.codeLanguagePopover;
        const input = popover?.querySelector('.dumbpad-code-language-input');
        if (!language) {
            input?.setAttribute('aria-invalid', 'true');
            popover?.classList.add('is-invalid');
            return false;
        }
        const block = this.activeCodeLanguageBlock;
        this.hideCodeLanguagePopover(false);
        return this.updateCodeBlockLanguage(block, language);
    }

    hideCodeLanguagePopover(restoreFocus = false) {
        const popover = this.codeLanguagePopover;
        if (!popover || popover.hidden) return;
        const anchor = this.activeCodeLanguageAnchor;
        popover.hidden = true;
        popover.classList.remove('is-invalid');
        anchor?.setAttribute?.('aria-expanded', 'false');
        this.activeCodeLanguageBlock = null;
        this.activeCodeLanguageAnchor = null;
        this.codeLanguageSuggestions = [];
        this.activeCodeLanguageSuggestion = -1;
        this.isCodeLanguageComposing = false;
        if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    }

    resolveCodeBlockMarkdownContext(root, block, value) {
        const parsed = splitTopLevelMarkdownBlocks(value, lexMarkdown);
        if (!parsed.ok) return null;
        const domIndex = Array.from(root.children).indexOf(block);
        let markdownBlock = domIndex >= 0 && parsed.blocks.length === root.children.length
            ? parsed.blocks[domIndex]
            : null;
        if (markdownBlock?.type !== 'code') markdownBlock = null;
        if (!markdownBlock) {
            const codeText = String(block.querySelector('.vditor-wysiwyg__pre > code')?.textContent || '')
                .replace(/\r\n?/g, '\n')
                .replace(/\n$/, '');
            const candidates = parsed.blocks.filter(item => (
                item.type === 'code' && String(readCodeFenceBody(item.raw) ?? '').replace(/\n$/, '') === codeText
            ));
            markdownBlock = candidates.length === 1 ? candidates[0] : null;
        }
        return markdownBlock ? { domIndex, markdownBlock } : null;
    }

    updateCodeBlockLanguage(block, requestedLanguage) {
        const language = normalizeCodeFenceLanguage(requestedLanguage);
        if (language === null) {
            this.editor?.tip?.('语言仅支持字母、数字和 _ + . # -', 2200);
            return false;
        }
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!root || !block || block.parentElement !== root) return false;
        const value = this.getValue();
        const context = this.resolveCodeBlockMarkdownContext(root, block, value);
        if (!context) {
            this.editor?.tip?.('未能定位代码块源码', 2200);
            return false;
        }
        const currentLanguage = readCodeFenceLanguage(context.markdownBlock.raw);
        if (currentLanguage === language) return false;
        const replacement = replaceCodeFenceLanguage(context.markdownBlock.raw, language);
        if (replacement === null) return false;
        const next = `${value.slice(0, context.markdownBlock.start)}${replacement}${value.slice(context.markdownBlock.end)}`;
        this.setWysiwygCodeFenceValue(next, context.domIndex);
        return true;
    }

    decorateArticleFileLinks(root = this.container.querySelector('.vditor-wysiwyg .vditor-reset')) {
        root?.querySelectorAll('a').forEach(link => {
            const href = String(link.getAttribute('href') || '');
            const title = String(link.getAttribute('title') || '');
            if (!title.startsWith('dumbpad-file=1') || !/^\/api\/assets\/[a-f0-9-]{16,64}\/download$/i.test(href)) return;
            link.classList.add('dumbpad-article-file');
            link.setAttribute('download', '');
            link.setAttribute('contenteditable', 'false');
            link.draggable = false;
            link.setAttribute('aria-label', `下载附件：${link.textContent || '文件'}`);
        });
    }

    queueArticleImageUpload(file) {
        return this.queueArticleAssetUpload(file, { imageOnly: true });
    }

    setAssetMaxFileBytes(value) {
        return this.assetApi.setMaxFileBytes(value);
    }

    queueArticleAssetUpload(file, { token = this.createArticleUploadToken(), alreadyInserted = false, imageOnly = false } = {}) {
        const isImage = imageOnly || isImageFile(file);
        this.articleUploadStates.set(token, {
            token,
            file,
            isImage,
            phase: 'uploading',
            loaded: 0,
            total: Number(file?.size || 0),
            percent: 0,
            error: ''
        });
        if (!alreadyInserted) this.insertArticleUploadPlaceholder(token);
        this.decorateArticleUploadPlaceholders();
        requestAnimationFrame(() => this.decorateArticleUploadPlaceholders());
        const uploadOptions = {
            onProgress: progress => this.updateArticleUploadState(token, progress)
        };
        const upload = isImage ? this.assetApi.uploadImage(file, uploadOptions) : this.assetApi.uploadFile(file, uploadOptions);
        const task = upload
            .then(asset => {
                this.articleUploadStates.delete(token);
                this.replaceArticleUploadPlaceholder(token, isImage ? this.buildArticleImageMarkdown(asset) : buildArticleFileMarkdown(asset));
            })
            .catch(error => {
                console.error(`Failed to upload article ${isImage ? 'image' : 'file'}:`, error);
                const label = isImage ? '图片' : '文件';
                this.updateArticleUploadState(token, {
                    phase: 'error',
                    error: error?.message || `${label}上传失败`
                });
                this.editor?.tip?.(`${label}上传失败`, 3000);
            })
            .finally(() => this.assetUploadTasks.delete(task));
        this.assetUploadTasks.add(task);
        return task;
    }

    bindArticleUploadInteractions() {
        if (this.articleUploadInteractionsBound) return;
        this.articleUploadInteractionsBound = true;
        this.container.addEventListener('click', event => {
            const action = event.target.closest('[data-article-upload-action]');
            const card = action?.closest?.('.article-upload-card[data-article-upload-token]');
            if (!action || !card) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            const token = card.dataset.articleUploadToken || '';
            if (action.dataset.articleUploadAction === 'retry') {
                this.retryArticleUpload(token);
            } else if (action.dataset.articleUploadAction === 'remove') {
                this.removeArticleUploadPlaceholder(token);
            }
        }, true);
    }

    updateArticleUploadState(token, progress = {}) {
        const current = this.articleUploadStates.get(token);
        if (!current) return;
        const next = { ...current, ...progress };
        if (next.phase === 'processing') next.percent = 100;
        next.percent = Math.min(100, Math.max(0, Number(next.percent) || 0));
        this.articleUploadStates.set(token, next);
        this.updateArticleUploadCard(token, next);
    }

    retryArticleUpload(token) {
        const state = this.articleUploadStates.get(token);
        if (!state?.file || state.phase !== 'error') return false;
        this.queueArticleAssetUpload(state.file, {
            token,
            alreadyInserted: true,
            imageOnly: state.isImage
        });
        return true;
    }

    removeArticleUploadPlaceholder(token) {
        if (!token) return false;
        this.articleUploadStates.delete(token);
        this.replaceArticleUploadPlaceholder(token, '');
        return true;
    }

    decorateArticleUploadPlaceholders(root = this.container.querySelector('.vditor-wysiwyg .vditor-reset')) {
        if (!root || this.articleUploadStates.size === 0) return;
        const tokens = Array.from(this.articleUploadStates.keys());
        const existingTokens = new Set();
        root.querySelectorAll('.article-upload-card[data-article-upload-token]').forEach(card => {
            const token = card.dataset.articleUploadToken || '';
            existingTokens.add(token);
            const state = this.articleUploadStates.get(token);
            if (state) this.renderArticleUploadCard(card, state);
        });

        const pendingTokens = tokens.filter(token => !existingTokens.has(token));
        if (pendingTokens.length === 0) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) {
            const protectedAncestor = node.parentElement?.closest?.('code, pre, .article-upload-card');
            if (protectedAncestor && protectedAncestor !== root) continue;
            if (pendingTokens.some(token => String(node.nodeValue || '').includes(token))) nodes.push(node);
        }

        nodes.forEach(textNode => {
            let remaining = String(textNode.nodeValue || '');
            const fragment = document.createDocumentFragment();
            let decorated = false;
            while (remaining) {
                const match = pendingTokens
                    .map(token => ({ token, index: remaining.indexOf(token) }))
                    .filter(item => item.index >= 0)
                    .sort((a, b) => a.index - b.index)[0];
                if (!match) break;
                if (match.index > 0) fragment.append(document.createTextNode(remaining.slice(0, match.index)));
                const state = this.articleUploadStates.get(match.token);
                if (state) {
                    fragment.append(this.createArticleUploadCard(state));
                    decorated = true;
                } else {
                    fragment.append(document.createTextNode(match.token));
                }
                remaining = remaining.slice(match.index + match.token.length);
            }
            if (!decorated) return;
            if (remaining) fragment.append(document.createTextNode(remaining));
            textNode.replaceWith(fragment);
        });
    }

    createArticleUploadCard(state) {
        const card = document.createElement('span');
        card.className = 'article-upload-card';
        card.dataset.articleUploadToken = state.token;
        card.setAttribute('contenteditable', 'false');
        card.setAttribute('role', 'status');
        this.renderArticleUploadCard(card, state);
        return card;
    }

    updateArticleUploadCard(token, state) {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const card = Array.from(root?.querySelectorAll('.article-upload-card[data-article-upload-token]') || [])
            .find(item => item.dataset.articleUploadToken === token);
        if (!card) {
            this.decorateArticleUploadPlaceholders(root);
            return;
        }
        this.renderArticleUploadCard(card, state);
    }

    renderArticleUploadCard(card, state) {
        const phase = state.phase || 'uploading';
        const percent = Math.round(Number(state.percent) || 0);
        const name = state.file?.name || (state.isImage ? '图片' : '文件');
        const size = this.formatArticleUploadBytes(state.total || state.file?.size || 0);
        const status = phase === 'error'
            ? (state.error || '上传失败')
            : phase === 'processing'
                ? '服务器处理中…'
                : `上传中 ${percent}%`;
        card.classList.toggle('is-error', phase === 'error');
        card.dataset.uploadPhase = phase;
        card.setAttribute('aria-label', `${name}，${status}`);
        card.innerHTML = '';

        const icon = document.createElement('span');
        icon.className = 'article-upload-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = state.isImage ? '▧' : '↥';
        const content = document.createElement('span');
        content.className = 'article-upload-content';
        const heading = document.createElement('span');
        heading.className = 'article-upload-heading';
        const fileName = document.createElement('span');
        fileName.className = 'article-upload-name';
        fileName.textContent = name;
        const fileSize = document.createElement('span');
        fileSize.className = 'article-upload-size';
        fileSize.textContent = size;
        heading.append(fileName, fileSize);
        const statusRow = document.createElement('span');
        statusRow.className = 'article-upload-status';
        statusRow.textContent = status;
        const progress = document.createElement('span');
        progress.className = 'article-upload-progress';
        const progressFill = document.createElement('span');
        progressFill.className = 'article-upload-progress-fill';
        progressFill.style.width = `${phase === 'error' ? Math.max(4, percent) : percent}%`;
        progress.append(progressFill);
        content.append(heading, statusRow, progress);
        card.append(icon, content);

        if (phase === 'error') {
            const actions = document.createElement('span');
            actions.className = 'article-upload-actions';
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.dataset.articleUploadAction = 'retry';
            retry.textContent = '重试';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.articleUploadAction = 'remove';
            remove.textContent = '移除';
            actions.append(retry, remove);
            card.append(actions);
        }
    }

    formatArticleUploadBytes(bytes) {
        const value = Math.max(0, Number(bytes) || 0);
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
        return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    }

    insertArticleUploadPlaceholder(token) {
        if (this.sourceMode && this.sourceTextarea) {
            const start = this.sourceTextarea.selectionStart || 0;
            const end = this.sourceTextarea.selectionEnd || start;
            this.sourceTextarea.setRangeText(token, start, end, 'end');
            this.emitSourceInput();
            return;
        }
        this.editor?.focus?.();
        this.editor?.insertMD?.(token);
        this.handleWysiwygInput();
    }

    buildArticleImageMarkdown(asset) {
        const alt = String(asset?.name || '图片').replace(/[\[\]\\]/g, '\\$&');
        return `![${alt}](${asset.previewUrl} "dumbpad-width=720")`;
    }

    getCurrentWysiwygMarkdownOffset() {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!root || !range || !root.contains(range.startContainer)) return this.getValue().length;
        return this.getMarkdownOffsetForDomPoint(root, range.startContainer, range.startOffset) ?? this.getValue().length;
    }

    replaceArticleUploadPlaceholder(token, replacement) {
        const imageMarkdown = typeof replacement === 'string' ? replacement : this.buildArticleImageMarkdown(replacement);
        if (this.sourceMode && this.sourceTextarea) {
            const current = this.sourceTextarea.value;
            const index = current.indexOf(token);
            if (index < 0) return;
            const caret = this.sourceTextarea.selectionStart || 0;
            const nextCaret = caret > index ? caret + imageMarkdown.length - token.length : caret;
            this.sourceTextarea.value = `${current.slice(0, index)}${imageMarkdown}${current.slice(index + token.length)}`;
            this.sourceTextarea.setSelectionRange(nextCaret, nextCaret);
            this.emitSourceInput();
            return;
        }

        const value = this.getValue();
        const index = value.indexOf(token);
        if (index < 0) return;
        const caret = this.getCurrentWysiwygMarkdownOffset();
        const nextCaret = caret > index ? caret + imageMarkdown.length - token.length : caret;
        const next = `${value.slice(0, index)}${imageMarkdown}${value.slice(index + token.length)}`;
        this.setWysiwygValueAtMarkdownOffset(next, nextCaret, true);
    }

    ensureArticleImageLightbox() {
        if (this.articleImageLightbox) return this.articleImageLightbox;
        const lightbox = document.createElement('div');
        lightbox.className = 'article-image-lightbox';
        lightbox.hidden = true;
        lightbox.tabIndex = -1;
        lightbox.setAttribute('role', 'dialog');
        lightbox.setAttribute('aria-modal', 'true');
        lightbox.setAttribute('aria-label', '文章图片预览');
        lightbox.innerHTML = `
            <div class="article-image-lightbox-bar">
                <span class="article-image-lightbox-name"></span>
                <a class="article-image-lightbox-download" download title="下载原图" aria-label="下载原图">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>
                </a>
                <button type="button" class="article-image-lightbox-close" title="关闭" aria-label="关闭图片预览">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
                </button>
            </div>
            <img class="article-image-lightbox-image" alt="">
        `;
        lightbox.addEventListener('click', event => {
            if (event.target === lightbox) this.closeArticleImageLightbox();
        });
        lightbox.querySelector('.article-image-lightbox-close').addEventListener('click', () => this.closeArticleImageLightbox());
        lightbox.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeArticleImageLightbox();
            }
        });
        document.body.appendChild(lightbox);
        this.articleImageLightbox = lightbox;
        return lightbox;
    }

    openArticleImageLightbox(image, assetId) {
        const lightbox = this.ensureArticleImageLightbox();
        lightbox.hidden = false;
        document.body.classList.add('article-image-lightbox-open');
        const name = image.alt || '图片';
        lightbox.querySelector('.article-image-lightbox-name').textContent = name;
        const fullImage = lightbox.querySelector('.article-image-lightbox-image');
        fullImage.alt = name;
        const originalUrl = assetId
            ? `/api/assets/${assetId}/original`
            : (image.currentSrc || image.src || '');
        fullImage.src = originalUrl;
        const download = lightbox.querySelector('.article-image-lightbox-download');
        download.href = assetId ? `/api/assets/${assetId}/download` : originalUrl;
        download.download = name;
        this.articleImageLightboxTrigger = image;
        lightbox.querySelector('.article-image-lightbox-close').focus({ preventScroll: true });
    }

    closeArticleImageLightbox() {
        if (!this.articleImageLightbox) return;
        this.articleImageLightbox.hidden = true;
        document.body.classList.remove('article-image-lightbox-open');
        this.articleImageLightboxTrigger?.focus?.({ preventScroll: true });
        this.articleImageLightboxTrigger = null;
    }

    ensureArticleImageSizeMenu() {
        if (this.articleImageSizeMenu) return this.articleImageSizeMenu;
        const menu = document.createElement('div');
        menu.className = 'article-image-size-menu';
        menu.hidden = true;
        menu.innerHTML = `
            <button type="button" data-image-width="360" title="窄">窄</button>
            <button type="button" data-image-width="720" title="中">中</button>
            <button type="button" data-image-width="1080" title="宽">宽</button>
            <button type="button" data-image-width="0" title="自适应">自适应</button>
            <span class="article-image-size-menu-divider" aria-hidden="true"></span>
            <a class="article-image-download" data-image-download download title="下载原图" aria-label="下载原图">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>
            </a>
            <button type="button" class="article-image-fullscreen" data-image-fullscreen title="查看大图" aria-label="查看大图">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5"></path><path d="M16 3h5v5"></path><path d="M21 16v5h-5"></path><path d="M3 16v5h5"></path></svg>
            </button>
            <button type="button" class="article-image-delete" data-image-delete title="删除图片" aria-label="删除图片">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>
            </button>
        `;
        menu.addEventListener('mousedown', event => event.preventDefault());
        menu.addEventListener('click', event => {
            const fullscreenButton = event.target.closest('[data-image-fullscreen]');
            if (fullscreenButton && this.activeArticleImage) {
                const image = this.activeArticleImage;
                const assetId = this.getArticleAssetId(image);
                this.hideArticleImageSizeMenu();
                this.openArticleImageLightbox(image, assetId);
                return;
            }
            const deleteButton = event.target.closest('[data-image-delete]');
            if (deleteButton && this.activeArticleImage) {
                this.deleteArticleImage(this.activeArticleImage);
                return;
            }
            const button = event.target.closest('[data-image-width]');
            if (!button || !this.activeArticleImage) return;
            this.setArticleImageWidth(this.activeArticleImage, Number(button.dataset.imageWidth || 0));
        });
        document.body.appendChild(menu);
        document.addEventListener('mousedown', event => {
            if (!menu.hidden && !menu.contains(event.target) && event.target !== this.activeArticleImage) {
                this.hideArticleImageSizeMenu();
            }
        });
        this.articleImageSizeMenu = menu;
        return menu;
    }

    openArticleImageSizeMenu(image) {
        this.activeArticleImage = image;
        const menu = this.ensureArticleImageSizeMenu();
        const assetId = this.getArticleAssetId(image);
        const originalUrl = assetId
            ? `/api/assets/${assetId}/download`
            : (image.currentSrc || image.src || '');
        const download = menu.querySelector('[data-image-download]');
        download.href = originalUrl;
        download.download = image.alt || '图片';
        const rect = image.getBoundingClientRect();
        menu.hidden = false;
        const menuWidth = menu.offsetWidth || 210;
        const centeredLeft = rect.left + ((rect.width - menuWidth) / 2);
        menu.style.left = `${Math.max(10, Math.min(window.innerWidth - menuWidth - 10, centeredLeft))}px`;
        menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 10, rect.bottom + 8)}px`;
    }

    hideArticleImageSizeMenu() {
        if (this.articleImageSizeMenu) this.articleImageSizeMenu.hidden = true;
        this.activeArticleImage = null;
    }

    setArticleImageWidth(image, requestedWidth) {
        if (!image) return;
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const maxWidth = Math.max(240, Math.floor(root?.clientWidth || window.innerWidth - 48));
        const width = requestedWidth ? Math.min(Math.max(160, requestedWidth), maxWidth) : 0;
        if (width) {
            image.setAttribute('title', `dumbpad-width=${width}`);
            image.style.width = `${width}px`;
        } else {
            image.removeAttribute('title');
            image.style.removeProperty('width');
        }
        this.hideArticleImageSizeMenu();
        this.notifyEditorValueChanged();
    }

    deleteArticleImage(image) {
        if (!image?.isConnected) return;
        const block = image.closest('.vditor-wysiwyg__block');
        image.remove();
        if (block && !block.querySelector('img') && !String(block.textContent || '').trim()) {
            block.remove();
        }
        this.hideArticleImageSizeMenu();
        this.notifyEditorValueChanged();
        this.editor?.focus?.();
    }

    ensureArticleFileMenu() {
        if (this.articleFileMenu) return this.articleFileMenu;
        const menu = document.createElement('div');
        menu.className = 'article-file-menu';
        menu.hidden = true;
        menu.setAttribute('role', 'toolbar');
        menu.setAttribute('aria-label', '附件操作');
        menu.innerHTML = `
            <a class="article-file-download" data-file-download download title="下载附件" aria-label="下载附件">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>
            </a>
            <button type="button" class="article-file-delete" data-file-delete title="删除附件" aria-label="删除附件">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>
            </button>
        `;
        menu.addEventListener('mousedown', event => event.preventDefault());
        menu.addEventListener('click', event => {
            const deleteButton = event.target.closest('[data-file-delete]');
            if (!deleteButton || !this.activeArticleFile) return;
            const link = this.activeArticleFile;
            this.deleteArticleFile(link);
        });
        document.body.appendChild(menu);
        document.addEventListener('mousedown', event => {
            if (!menu.hidden && !menu.contains(event.target) && event.target !== this.activeArticleFile) {
                this.hideArticleFileMenu();
            }
        });
        this.articleFileMenu = menu;
        return menu;
    }

    openArticleFileMenu(link) {
        if (!link?.isConnected || this.isReadingMode) return;
        this.activeArticleFile = link;
        const menu = this.ensureArticleFileMenu();
        const download = menu.querySelector('[data-file-download]');
        download.href = link.getAttribute('href') || '';
        download.download = String(link.textContent || '附件').replace(/^📎\s*/, '').split('·')[0].trim() || '附件';
        const rect = link.getBoundingClientRect();
        menu.hidden = false;
        const menuWidth = menu.offsetWidth || 68;
        const centeredLeft = rect.left + ((rect.width - menuWidth) / 2);
        menu.style.left = `${Math.max(10, Math.min(window.innerWidth - menuWidth - 10, centeredLeft))}px`;
        menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 10, rect.bottom + 8)}px`;
    }

    hideArticleFileMenu() {
        if (this.articleFileMenu) this.articleFileMenu.hidden = true;
        this.activeArticleFile = null;
    }

    deleteArticleFile(link) {
        if (!link?.isConnected) return;
        const caretGuard = document.createTextNode('\u200B');
        link.replaceWith(caretGuard);
        this.hideArticleFileMenu();
        this.notifyEditorValueChanged();
        this.editor?.focus?.();
        this.placeCaretInTextNode(caretGuard);
    }

    bindTimeCommand() {
        this.timeCommandKeydownHandler = (event) => {
            if (this.isReadingMode) return;
            if (this.sourceMode) return;
            if (this.handlePendingCodeFenceTyping(event)) return;
            if (this.handlePendingCodeFenceEnter(event)) return;
            if (this.handleWysiwygFileCommand(event)) return;
            if (this.handleWysiwygTimeCommand(event)) return;
            this.handleWysiwygSoftEnter(event);
        };
        this.container.addEventListener('keydown', this.timeCommandKeydownHandler, true);
        this.pendingCodeFenceBeforeInputHandler = (event) => {
            if (event.inputType !== 'insertText' || !String(event.data || '').includes('`')) return;
            this.handlePendingCodeFenceTyping(event);
        };
        this.container.addEventListener('beforeinput', this.pendingCodeFenceBeforeInputHandler, true);
    }

    handlePendingCodeFenceTyping(event) {
        const insertedText = event?.key || event?.data || '';
        if (!event || !insertedText.includes('`') || event.ctrlKey || event.metaKey || event.altKey) {
            return false;
        }
        if (!event.target?.closest?.('.vditor-wysiwyg')) return false;

        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!root || !range?.collapsed || !root.contains(range.startContainer)) return false;
        if (this.closestElement(range.startContainer, 'code, .md-time-marker')) return false;

        let paragraph = this.closestElement(range.startContainer, 'p');
        try {
            if (!paragraph) paragraph = this.ensurePendingCodeFenceParagraph(root, range);
            let pendingText = null;
            if (paragraph?.parentElement === root) {
                const prefix = document.createRange();
                prefix.selectNodeContents(paragraph);
                prefix.setEnd(range.startContainer, range.startOffset);
                const suffix = document.createRange();
                suffix.selectNodeContents(paragraph);
                suffix.setStart(range.startContainer, range.startOffset);
                pendingText = buildPendingCodeFenceText(
                    this.readPendingCodeFenceRangeText(prefix),
                    this.readPendingCodeFenceRangeText(suffix),
                    insertedText
                );
            }
            if (!pendingText) return false;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            paragraph.textContent = pendingText;
            paragraph.classList.add('dumbpad-pending-code-fence');
            this.placeCaretInTextNode(paragraph.firstChild);
            return true;
        } catch (_error) {
            return false;
        }
    }

    readPendingCodeFenceRangeText(range) {
        if (!range?.cloneContents) return range?.toString?.() || '';
        const fragment = range.cloneContents();
        fragment.querySelectorAll?.('span[data-type="backslash"]').forEach(wrapper => {
            const slash = wrapper.firstElementChild;
            if (slash?.textContent === '\\' && wrapper.textContent === '\\`') slash.remove();
        });
        return fragment.textContent || '';
    }

    ensurePendingCodeFenceParagraph(root, range) {
        if (!root || !range?.collapsed) return null;
        if (range.startContainer?.nodeType === Node.TEXT_NODE && range.startContainer.parentNode === root) {
            const source = range.startContainer;
            const paragraph = document.createElement('p');
            paragraph.dataset.block = '0';
            paragraph.textContent = source.nodeValue || '';
            const offset = Math.min(range.startOffset, paragraph.textContent.length);
            source.replaceWith(paragraph);
            range.setStart(paragraph.firstChild || paragraph, offset);
            range.collapse(true);
            return paragraph;
        }
        if (range.startContainer !== root) return null;

        const offset = Math.min(Math.max(0, range.startOffset), root.childNodes.length);
        const previous = root.childNodes[offset - 1];
        if (previous?.nodeType === Node.TEXT_NODE && /^[\u200B\uFEFF`]*$/.test(previous.nodeValue || '')) {
            const paragraph = document.createElement('p');
            paragraph.dataset.block = '0';
            paragraph.textContent = previous.nodeValue || '';
            previous.replaceWith(paragraph);
            range.setStart(paragraph.firstChild || paragraph, paragraph.textContent.length);
            range.collapse(true);
            return paragraph;
        }

        const paragraph = document.createElement('p');
        paragraph.dataset.block = '0';
        paragraph.appendChild(document.createTextNode(''));
        root.insertBefore(paragraph, root.childNodes[offset] || null);
        range.setStart(paragraph.firstChild, 0);
        range.collapse(true);
        return paragraph;
    }

    handlePendingCodeFenceInput() {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!root) return false;
        const pending = Array.from(root.children).find(block =>
            String(block.textContent || '').includes(PENDING_CODE_FENCE_GUARD)
        );
        if (!pending) return false;

        const language = parseCodeFenceCommand(pending.textContent || '');
        if (language !== null) {
            pending.classList.add('dumbpad-pending-code-fence');
            return true;
        }

        pending.classList.remove('dumbpad-pending-code-fence');
        const walker = document.createTreeWalker(pending, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue?.includes(PENDING_CODE_FENCE_GUARD)) {
                node.nodeValue = node.nodeValue.replaceAll(PENDING_CODE_FENCE_GUARD, '');
            }
        }
        return false;
    }

    handlePendingCodeFenceEnter(event) {
        if (!this.isArticleFileCommandKeydown(event) || !event.target?.closest?.('.vditor-wysiwyg')) return false;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const paragraph = range ? this.closestElement(range.startContainer, 'p') : null;
        const language = paragraph ? parseCodeFenceCommand(paragraph.textContent || '') : null;
        if (language === null) return false;

        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        if (!root || paragraph.parentElement !== root || typeof this.editor?.html2md !== 'function') return false;
        const rawValue = this.serializeWysiwygRoot(root, this._lastValue || '', {
            preservePendingCodeFence: true
        });
        const parsed = splitTopLevelMarkdownBlocks(rawValue, lexMarkdown);
        if (!parsed.ok) return false;

        const domIndex = Array.from(root.children).indexOf(paragraph);
        let markdownBlock = domIndex >= 0 && parsed.blocks.length === root.children.length
            ? parsed.blocks[domIndex]
            : null;
        if (!markdownBlock?.raw.includes(PENDING_CODE_FENCE_GUARD)) {
            const guardedBlocks = parsed.blocks.filter(block => block.raw.includes(PENDING_CODE_FENCE_GUARD));
            markdownBlock = guardedBlocks.length === 1 ? guardedBlocks[0] : null;
        }
        if (!markdownBlock) return false;

        const built = buildCodeFenceMarkdown(language);
        const next = `${rawValue.slice(0, markdownBlock.start)}${built.markdown}${rawValue.slice(markdownBlock.end)}`;
        this.stopArticleFileCommandEvent(event);
        this.setWysiwygCodeFenceValue(next, domIndex);
        return true;
    }

    setWysiwygCodeFenceValue(value, blockIndex) {
        this.wysiwygCaretRestore = null;
        this.setValue(value, true);
        this.focusInsertedCodeBlock(blockIndex);
    }

    focusInsertedCodeBlock(blockIndex) {
        clearTimeout(this.pendingCodeFenceFocusTimer);
        let attempts = 0;
        const tryFocus = () => {
            attempts += 1;
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            if (!root) return false;
            let block = root.children[Math.max(0, Number(blockIndex) || 0)];
            if (!block?.matches?.('.vditor-wysiwyg__block[data-type="code-block"]')) {
                const blocks = Array.from(root.querySelectorAll(':scope > .vditor-wysiwyg__block[data-type="code-block"]'));
                block = blocks[blocks.length - 1] || null;
            }
            if (!block) return false;

            const sourcePre = block.querySelector('.vditor-wysiwyg__pre');
            const preview = block.querySelector('.vditor-wysiwyg__preview');
            if (!sourcePre) return false;
            if (getComputedStyle(sourcePre).display === 'none') {
                preview?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }

            const code = sourcePre.querySelector('code');
            if (!code || getComputedStyle(sourcePre).display === 'none') return false;
            const textNode = code.firstChild?.nodeType === Node.TEXT_NODE
                ? code.firstChild
                : code.insertBefore(document.createTextNode(''), code.firstChild || null);
            const range = document.createRange();
            range.setStart(textNode, 0);
            range.collapse(true);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            root.focus({ preventScroll: true });
            this.decorateCodeBlockLineNumbers(root);
            requestAnimationFrame(() => this.scrollRangeIntoView(range));
            return true;
        };

        if (tryFocus()) return true;
        const retry = () => {
            if (tryFocus() || attempts >= 4) return;
            this.pendingCodeFenceFocusTimer = setTimeout(retry, attempts * 80);
        };
        this.pendingCodeFenceFocusTimer = setTimeout(retry, 40);
        return false;
    }

    isArticleFileCommandKeydown(event) {
        return Boolean(
            event && event.key === 'Enter' && !event.ctrlKey && !event.metaKey &&
            !event.altKey && !event.shiftKey && !event.isComposing && !this.isComposing
        );
    }

    stopArticleFileCommandEvent(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    }

    handleSourceFileCommand(event) {
        if (!this.isArticleFileCommandKeydown(event) || event.target !== this.sourceTextarea) return false;
        const commandRange = findFileCommandBeforeCursor(
            this.sourceTextarea.value,
            this.sourceTextarea.selectionStart,
            this.sourceTextarea.selectionEnd
        );
        if (!commandRange) return false;
        this.stopArticleFileCommandEvent(event);
        this.requestArticleFileSelection(commandRange);
        return true;
    }

    getCurrentWysiwygBlockCommandContext(root, range) {
        if (!root || !range || !range.collapsed || !root.contains(range.startContainer)) return null;
        let block = range.startContainer?.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer?.parentElement;
        while (block?.parentElement && block.parentElement !== root) block = block.parentElement;
        if (!block || block.parentElement !== root) return null;

        try {
            const prefix = document.createRange();
            prefix.selectNodeContents(block);
            prefix.setEnd(range.startContainer, range.startOffset);
            return {
                blockIndex: Array.from(root.children).indexOf(block),
                blockCount: root.children.length,
                textBeforeCursor: prefix.toString().replace(/\u200B/g, '')
            };
        } catch (_error) {
            return null;
        }
    }

    handleWysiwygFileCommand(event) {
        if (!this.isArticleFileCommandKeydown(event) || !event.target?.closest?.('.vditor-wysiwyg')) return false;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range && this.closestElement(range.startContainer, 'code, .md-time-marker')) return false;
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const context = this.getCurrentWysiwygBlockCommandContext(root, range);
        if (!context) return false;
        const value = this.getValue();
        const parsed = splitTopLevelMarkdownBlocks(value, lexMarkdown);
        if (!parsed.ok) return false;

        let commandRange = null;
        if (context.blockCount === parsed.blocks.length && context.blockIndex >= 0) {
            commandRange = findFileCommandInMarkdownBlock(
                parsed.blocks[context.blockIndex],
                context.textBeforeCursor
            );
        }
        if (!commandRange) {
            const candidates = parsed.blocks
                .map(block => findFileCommandInMarkdownBlock(block, context.textBeforeCursor))
                .filter(Boolean);
            if (candidates.length === 1) [commandRange] = candidates;
        }
        if (!commandRange) return false;
        this.stopArticleFileCommandEvent(event);
        this.requestArticleFileSelection(commandRange);
        return true;
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
        const markerText = buildTimeMarker();
        this.editor.deleteValue();
        this.editor.insertValue(markerText, true);
        setTimeout(() => {
            this.scheduleDecorateRenderedMarks();
            this.emitChange();
        }, 0);
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

        setTimeout(() => {
            this.notifyEditorValueChanged(this.editor?.getValue?.() || this._lastValue || '');
            this.scheduleDecorateRenderedMarks();
        }, 0);
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
        if (this.isCaretAdjacentToTimeMarker(range)) return null;

        const visibleText = startParagraph.textContent.replace(/\u200B/g, '').trim();
        if (!visibleText && range.collapsed) return null;

        return range.cloneRange();
    }

    isCaretAdjacentToTimeMarker(range) {
        if (!range?.collapsed) return false;
        if (this.closestElement(range.startContainer, '.md-time-marker')) return true;

        let previous = null;
        if (range.startContainer?.nodeType === Node.TEXT_NODE) {
            const beforeCaret = String(range.startContainer.nodeValue || '')
                .slice(0, range.startOffset)
                .replace(/[\u200B\uFEFF]/g, '');
            if (beforeCaret.trim()) return false;
            previous = range.startContainer.previousSibling;
        } else if (range.startContainer?.nodeType === Node.ELEMENT_NODE) {
            previous = range.startContainer.childNodes[Math.max(0, range.startOffset - 1)] || null;
        }

        while (previous?.nodeType === Node.TEXT_NODE && !String(previous.nodeValue || '').replace(/[\u200B\uFEFF]/g, '').trim()) {
            previous = previous.previousSibling;
        }
        return Boolean(previous?.nodeType === Node.ELEMENT_NODE && previous.matches?.('.md-time-marker'));
    }

    createRenderedTimeMarker(markerText) {
        const template = document.createElement('template');
        template.innerHTML = renderTimeMarkers(this.escapeHtml(markerText), 'md-time-marker', { draggable: true });
        const el = template.content.firstElementChild;
        if (el) el.setAttribute('contenteditable', 'false');
        return el || document.createTextNode(markerText);
    }

    insertRenderedTimeMarkerAtRange(range, markerText = buildTimeMarker()) {
        if (!range) return null;
        range.deleteContents();
        const marker = this.createRenderedTimeMarker(markerText);
        const trailingGuard = document.createTextNode('\u200B');
        range.insertNode(marker);
        marker.after(trailingGuard);
        this.placeCaretInTextNode(trailingGuard);
        return marker;
    }

    restoreCaretAfterTimeMarker(markerText) {
        const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
        const marker = Array.from(root?.querySelectorAll('.md-time-marker') || [])
            .find(element => element.dataset.timeSource === markerText);
        if (!marker) return;
        let guard = marker.nextSibling;
        if (!guard || guard.nodeType !== Node.TEXT_NODE) {
            guard = document.createTextNode('\u200B');
            marker.after(guard);
        }
        this.placeCaretInTextNode(guard);
    }

    placeCaretAfterNode(node) {
        if (!node) return;
        const range = document.createRange();
        range.setStartAfter(node);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    placeCaretInTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return;
        const range = document.createRange();
        range.setStart(node, node.nodeValue?.length || 0);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
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

        if (this.closestElement(range.startContainer, 'code, .md-time-marker')) return null;

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
        if (!element || !nextComment) return;

        // Update the comment directly in the DOM, then sync the
        // editor value.  This avoids relying on getValue() to
        // preserve the annotation HTML in the markdown string.
        element.dataset.comment = nextComment;

        const sub = element.querySelector('sub');
        if (sub) {
            sub.textContent = '（' + nextComment + '）';
        }

        this.notifyEditorValueChanged();
        this.scheduleDecorateRenderedMarks();
    }

    removeInlineMark(element, type, comment = '') {
        if (!element) return;

        // Extract the plain text from the rendered element
        const text = type === 'annotation'
            ? (element.querySelector('span[style*="wavy"]')?.textContent || element.textContent || '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim()
            : (element.textContent || '').trim();
        if (!text) return;

        // Replace the DOM element directly with a text node.
        // This is more reliable than trying to regex-match the mark
        // in the markdown value, because editor.getValue() may not
        // preserve <mark>, <span data-draw>, or <span data-note> tags.
        const textNode = document.createTextNode(text);
        element.replaceWith(textNode);

        // Sync the editor value from the modified DOM
        this.notifyEditorValueChanged();
        this.scheduleDecorateRenderedMarks();
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

    getNodePath(root, node) {
        const path = [];
        let current = node;
        while (current && current !== root) {
            const parent = current.parentNode;
            if (!parent) return null;
            path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
            current = parent;
        }
        return current === root ? path : null;
    }

    getNodeAtPath(root, path = []) {
        return path.reduce((node, index) => node?.childNodes?.[index], root) || null;
    }

    getMarkdownOffsetForDomPoint(root, node, offset) {
        if (!root || !node || typeof this.editor?.html2md !== 'function') return null;
        const path = this.getNodePath(root, node);
        if (!path) return null;
        const clone = root.cloneNode(true);
        const cloneNode = this.getNodeAtPath(clone, path);
        if (!cloneNode) return null;

        const marker = '\uE000';
        try {
            const range = document.createRange();
            const maxOffset = cloneNode.nodeType === Node.TEXT_NODE
                ? cloneNode.nodeValue.length
                : cloneNode.childNodes.length;
            range.setStart(cloneNode, Math.min(Math.max(0, offset), maxOffset));
            range.collapse(true);
            const caretNode = document.createTextNode(marker);
            range.insertNode(caretNode);
            clone.querySelectorAll('.dumbpad-mermaid-render').forEach(render => render.remove());
            this.restoreCodeBlockLineNumberDecorations(clone);
            this.restoreRenderedTimeMarkers(clone);
            this.restoreAllRenderedMarks(clone);
            const markdown = this.restoreEditorDisplayLanguages(
                this.stripDisplayGuards(this.editor.html2md(clone.innerHTML) || '')
            );
            const markdownOffset = markdown.indexOf(marker);
            return markdownOffset >= 0 ? markdownOffset : null;
        } catch (_error) {
            return null;
        }
    }

    setSourceMode(enabled) {
        if (this.isReadingMode) enabled = false;
        this.hideCodeLanguagePopover(false);
        this.sourceMode = Boolean(enabled);
        this.container.classList.toggle('is-source-mode', this.sourceMode);
        this.sourceToggle?.classList.toggle('active', this.sourceMode);

        if (this.sourceMode) {
            const root = this.container.querySelector('.vditor-wysiwyg .vditor-reset');
            const selection = window.getSelection();
            const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
            const sourceOffset = range && root?.contains(range.startContainer)
                ? this.getMarkdownOffsetForDomPoint(root, range.startContainer, range.startOffset)
                : Math.min(this.sourceCaretOffset || 0, (this._lastValue || '').length);
            this.markerObserver?.disconnect();
            const value = this.readWysiwygMarkdownValue(this._lastValue || this.pendingValue || '');
            this._lastValue = value;
            this.sourceTextarea.value = value;
            this.sourceCaretOffset = Math.min(Math.max(0, sourceOffset ?? 0), value.length);
            requestAnimationFrame(() => {
                this.sourceTextarea.setSelectionRange(this.sourceCaretOffset, this.sourceCaretOffset);
                this.sourceTextarea.focus();
            });
        } else if (this.ready && this.editor?.setValue && this.sourceTextarea) {
            const sourceValue = this.sourceTextarea.value || '';
            this.sourceCaretOffset = Math.min(Math.max(0, this.sourceTextarea.selectionStart || 0), sourceValue.length);
            this.setWysiwygValueAtMarkdownOffset(sourceValue, this.sourceCaretOffset, false);
            // Re-connect marker protection and add delayed retries
            // to survive Vditor's async re-processing.
            this.connectMarkerObserver();
        }
    }
}
