/**
 * Tiptap 黑盒适配器：导出与旧 Vditor 封装同名的 HybridMarkdownEditor 类，
 * 保持 getValue/setValue/阅读模式等公开契约不变（app.js 零改造）。
 * 阶段二范围：生命周期、值读写、roundtrip；光标/导航/命令链路见 Phase 3。
 */
import {
    Editor,
    StarterKit,
    Markdown,
    Image,
    Table,
    TableRow,
    TableCell,
    TableHeader,
    TaskList,
    TaskItem,
} from './managers/tiptap-runtime.js';
import {
    AnnotationMark,
    DrawMark,
    MdHighlight,
    MdSoftBreak,
    TimeMarkerNode,
} from './managers/tiptap-extensions.js';
import { buildMarkdownHeadingIndex } from './managers/heading-index.js';

export class HybridMarkdownEditor {
    constructor(container, { input, performanceMonitor = null, onCaretChange = null } = {}) {
        if (!globalThis.DumbPadTiptap) {
            throw new Error('Tiptap failed to load.');
        }

        this.container = container;
        this.onInput = input || (() => {});
        this.onCaretChange = typeof onCaretChange === 'function' ? onCaretChange : (() => {});
        this.performanceMonitor = performanceMonitor;
        this.listeners = new Map();
        this.isReadingMode = false;
        this.headingLineBySlug = new Map();
        this.headingIds = [];
        this._lastValue = '';
        this.ready = false;
        this.pendingValue = '';
        this.sourceMode = false;
        this.assetMaxFileBytes = null;
        this.isComposing = false;

        this.readyPromise = new Promise((resolve) => { this._resolveReady = resolve; });

        this.editor = new Editor({
            element: container,
            extensions: [
                Markdown.configure({
                    html: true,
                    linkify: false,
                    breaks: true,
                    transformPastedText: true,
                    transformCopiedText: true,
                }),
                StarterKit.configure({
                    hardBreak: false,
                }),
                AnnotationMark,
                DrawMark,
                MdHighlight,
                MdSoftBreak,
                TimeMarkerNode,
                Image,
                Table.configure({ resizable: false }),
                TableRow,
                TableHeader,
                TableCell,
                TaskList,
                TaskItem.configure({ nested: true }),
            ],
            content: '',
            autofocus: false,
        });

        this.editor.on('create', () => {
            this.ready = true;
            this._resolveReady();
        });

        this.editor.on('update', () => {
            this.notifyEditorValueChanged(this.getValue());
        });

        this.editor.on('transaction', ({ transaction }) => {
            this.isComposing = transaction.meta?.isComposing || this.isComposing;
        });
    }

    /* ---------------- 事件总线（与旧类同名契约） ---------------- */

    addEventListener(eventName, callback) {
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
        this.listeners.get(eventName).add(callback);
    }

    removeEventListener(eventName, callback) {
        this.listeners.get(eventName)?.delete(callback);
    }

    dispatch(eventName, detail) {
        this.listeners.get(eventName)?.forEach((callback) => callback(detail));
    }

    notifyEditorValueChanged(value) {
        this._lastValue = value;
        this.dispatch('input', { value });
        this.onInput();
    }

    whenReady() {
        return this.readyPromise;
    }

    /* ---------------- 值读写 ---------------- */

    getValue() {
        if (this.sourceMode) {
            return this.getSourceTextarea()?.value ?? this._lastValue;
        }
        return this.editor.storage.markdown.getMarkdown();
    }

    setValue(value, emit = true) {
        const nextValue = String(value ?? '');
        this._lastValue = nextValue;
        this.editor.commands.setContent(nextValue, false);
        if (emit) {
            this.notifyEditorValueChanged(this.getValue());
        } else {
            this._lastValue = this.getValue();
        }
    }

    setValuePreservingCaret(value, emit = true) {
        this.setValue(value, emit);
    }

    /* ---------------- 模式与焦点 ---------------- */

    setReadingMode(enabled) {
        this.isReadingMode = Boolean(enabled);
        this.editor.setEditable(!this.isReadingMode);
        this.container.classList.toggle('article-reading-mode', this.isReadingMode);
    }

    focus() {
        if (this.isReadingMode) return;
        this.editor.commands.focus();
    }

    editorHasFocus() {
        return this.editor.isFocused;
    }

    /* ---------------- 源码模式 ---------------- */

    getSourceTextarea() {
        return this.container.querySelector('.tiptap-source-textarea');
    }

    setSourceMode(enabled) {
        if (Boolean(enabled) === this.sourceMode) return;
        this.sourceMode = Boolean(enabled);
        let textarea = this.getSourceTextarea();
        if (this.sourceMode) {
            if (!textarea) {
                textarea = document.createElement('textarea');
                textarea.className = 'tiptap-source-textarea';
                textarea.setAttribute('aria-label', 'Markdown source');
                this.container.appendChild(textarea);
                textarea.addEventListener('input', () => {
                    this.notifyEditorValueChanged(textarea.value);
                });
            }
            textarea.value = this._lastValue;
            textarea.style.display = 'block';
            this.container.querySelector('.tiptap')?.style.setProperty('display', 'none');
        } else if (textarea) {
            const nextValue = textarea.value;
            textarea.style.display = 'none';
            this.container.querySelector('.tiptap')?.style.removeProperty('display');
            this.setValue(nextValue, false);
        }
    }

    /* ---------------- 选区与光标（Phase 3 完整实现） ---------------- */

    get selectionStart() {
        return 0;
    }

    get selectionEnd() {
        return 0;
    }

    setSelectionRange() {
        this.focus();
    }

    getPersistentCaretSnapshot() {
        return null;
    }

    restorePersistentCaret(_snapshot) {
        // Phase 3: 按文本偏移恢复光标。
    }

    /* ---------------- 大纲与导航（Phase 3 补 DOM 侧） ---------------- */

    generateToC(markdown = undefined) {
        const value = markdown === undefined
            ? (this._lastValue || this.pendingValue || (this.ready ? this.getValue() : ''))
            : markdown;
        const index = buildMarkdownHeadingIndex(value);
        this.headingLineBySlug = index.headingLineBySlug;
        this.headingIds = index.headingIds;
        return index.toc;
    }

    syncRenderedHeadingIds(_toc) {
        // Phase 3: 为渲染后的标题元素写 id 并收集位置。
    }

    scrollToHeadingId(_id) {
        // Phase 3。
    }

    scrollToLine(_index, _keyword) {
        // Phase 3。
    }

    scrollRenderedElementIntoView(_target) {
        // Phase 3。
    }

    jumpToKeyword(_keyword) {
        // Phase 3。
        return false;
    }

    /* ---------------- 资产（Phase 3 接上传卡片） ---------------- */

    setAssetMaxFileBytes(value) {
        this.assetMaxFileBytes = value;
    }

    insertArticleAssetReference(_asset) {
        // Phase 3: 在光标处插入资源引用。
        return false;
    }
}
