/**
 * Tiptap 黑盒适配器：导出与旧 Vditor 封装同名的 HybridMarkdownEditor 类，
 * 保持 getValue/setValue/光标/导航/阅读模式等公开契约不变（app.js 零改造）。
 * 序列化格式与旧编辑器逐字节对齐，roundtrip 由 test/test_tiptap_roundtrip.js 固化。
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

        this.editor.on('selectionUpdate', () => {
            this.onCaretChange();
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
        this.editor.commands.setContent(nextValue, { emitUpdate: false });
        if (emit) {
            this.notifyEditorValueChanged(this.getValue());
        } else {
            this._lastValue = this.getValue();
        }
    }

    /** 远端更新（WS notes_update）时保持用户光标位置（issue #5）。 */
    setValuePreservingCaret(value, emit = true) {
        const focused = this.editor.isFocused;
        const snapshot = focused ? this.getInlineCaretSnapshot() : null;
        this.setValue(value, emit);
        if (focused && snapshot !== null) {
            requestAnimationFrame(() => {
                try {
                    this.setCaretAtVisibleOffset(snapshot);
                } catch (_error) {
                    // 光标恢复是尽力而为，绝不打断编辑。
                }
            });
        }
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

    /* ---------------- 光标偏移映射（可见文本偏移 ↔ ProseMirror 位置） ---------------- */

    /** 光标前累计可见文本长度（不含 markdown 语法字符），对应旧 visibleOffset。 */
    getInlineCaretSnapshot() {
        const { state } = this.editor;
        if (!state.selection.empty) return null;
        return this.countVisibleTextBefore(state.selection.from);
    }

    countVisibleTextBefore(pos) {
        const { doc } = this.editor.state;
        let length = 0;
        doc.descendants((node, nodePos) => {
            if (!node.isText) return true;
            const nodeStart = nodePos;
            const nodeEnd = nodePos + node.nodeSize;
            if (pos >= nodeEnd) {
                length += (node.text || '').length;
            } else if (pos > nodeStart) {
                length += pos - nodePos;
            }
            return false;
        });
        return length;
    }

    /** 可见文本偏移 → 最近的光标 ProseMirror 位置（越界时钳制）。 */
    mapVisibleOffsetToPos(target) {
        const { doc } = this.editor.state;
        let acc = 0;
        let mappedPos = null;
        doc.descendants((node, nodePos) => {
            if (mappedPos !== null) return false;
            if (!node.isText) return true;
            const nodeLength = (node.text || '').length;
            if (target <= acc + nodeLength) {
                mappedPos = nodePos + (target - acc);
            } else {
                acc += nodeLength;
            }
            return true;
        });
        if (mappedPos === null) {
            mappedPos = this.editor.state.doc.content.size;
        }
        return Math.max(0, Math.min(mappedPos, this.editor.state.doc.content.size));
    }

    setCaretAtVisibleOffset(target) {
        const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
        const maxPos = this.editor.state.doc.content.size;
        const pos = Math.max(0, Math.min(this.mapVisibleOffsetToPos(Math.max(0, Number(target) || 0)), maxPos));
        const tr = this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, pos));
        // jsdom 等无布局环境没有 Range.getClientRects，滚动定位直接跳过。
        const hasLayout = typeof document.createRange().getClientRects === 'function';
        this.editor.view.dispatch(hasLayout ? tr.scrollIntoView() : tr);
    }

    /* ---------------- 持久化光标（对应旧 getPersistentCaretSnapshot 契约） ---------------- */

    getPersistentCaretSnapshot() {
        if (this.sourceMode) {
            const textarea = this.getSourceTextarea();
            if (!textarea) return null;
            return {
                mode: 'source',
                offset: Number(textarea.selectionStart || 0),
                scrollTop: Number(textarea.scrollTop || 0),
            };
        }
        if (this.isReadingMode) return null;
        const snapshot = this.getInlineCaretSnapshot();
        if (snapshot === null) return null;
        return {
            mode: 'wysiwyg',
            offset: snapshot,
            visibleOffset: snapshot,
            scrollTop: Number(this.container.scrollTop || 0),
        };
    }

    restorePersistentCaret(snapshot = {}) {
        if (!snapshot || this.isReadingMode) return false;
        if (!this.ready) {
            this.whenReady().then(() => this.restorePersistentCaret(snapshot)).catch(() => {});
            return true;
        }
        if (snapshot.mode === 'source' && this.sourceMode) {
            const textarea = this.getSourceTextarea();
            if (!textarea) return false;
            const offset = Math.max(0, Number(snapshot.offset) || 0);
            const apply = () => {
                const max = textarea.value.length;
                textarea.setSelectionRange(Math.min(offset, max), Math.min(offset, max));
                textarea.scrollTop = Number(snapshot.scrollTop) || 0;
            };
            requestAnimationFrame(apply);
            return true;
        }
        const offset = Math.max(0, Number(snapshot.visibleOffset ?? snapshot.offset) || 0);
        requestAnimationFrame(() => {
            try {
                this.setCaretAtVisibleOffset(offset);
            } catch (_error) {
                // 光标恢复是尽力而为，绝不打断编辑。
            }
            if (this.container && Number.isFinite(Number(snapshot.scrollTop))) {
                this.container.scrollTop = Number(snapshot.scrollTop);
            }
        });
        return true;
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

    /* ---------------- 选区（对齐旧 WYSIWYG 行为：无纯文本偏移） ---------------- */

    get selectionStart() {
        return 0;
    }

    get selectionEnd() {
        return 0;
    }

    setSelectionRange() {
        this.focus();
    }

    /* ---------------- 大纲与导航 ---------------- */

    generateToC(markdown = undefined) {
        const value = markdown === undefined
            ? (this._lastValue || this.pendingValue || (this.ready ? this.getValue() : ''))
            : markdown;
        const index = buildMarkdownHeadingIndex(value);
        this.headingLineBySlug = index.headingLineBySlug;
        this.headingIds = index.headingIds;
        this.syncRenderedHeadingIds(index.toc);
        return index.toc;
    }

    syncRenderedHeadingIds(toc = []) {
        const headings = this.container.querySelectorAll('.tiptap h1, .tiptap h2, .tiptap h3, .tiptap h4, .tiptap h5, .tiptap h6');
        headings.forEach((heading, index) => {
            const entry = toc[index];
            if (entry?.id) {
                heading.id = `heading-${entry.id}`;
            } else {
                heading.removeAttribute('id');
            }
        });
    }

    scrollToHeadingId(id) {
        if (!id) return false;
        const heading = this.container.querySelector(`.tiptap h1[id="heading-${id}"], .tiptap h2[id="heading-${id}"], .tiptap h3[id="heading-${id}"], .tiptap h4[id="heading-${id}"], .tiptap h5[id="heading-${id}"], .tiptap h6[id="heading-${id}"]`);
        if (!heading) return false;
        this.scrollRenderedElementIntoView(heading);
        return true;
    }

    scrollToLine(index, keyword) {
        const line = Math.max(0, Number(index) || 0);
        let anchorId = null;
        for (const [slug, line] of this.headingLineBySlug.entries()) {
            if (line <= index) anchorId = slug;
        }
        if (anchorId && this.scrollToHeadingId(anchorId)) {
            if (keyword) this.jumpToKeyword(keyword);
            return true;
        }
        return false;
    }

    scrollRenderedElementIntoView(target) {
        if (!target || !this.container.contains(target)) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    jumpToKeyword(keyword) {
        const query = String(keyword || '').trim();
        if (!query) return false;
        const root = this.container.querySelector('.tiptap');
        if (!root) return false;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
            const value = node.nodeValue || '';
            const hit = value.toLowerCase().indexOf(query.toLowerCase());
            if (hit >= 0 && !node.parentElement?.closest?.('.article-search-hit')) {
                const range = document.createRange();
                range.setStart(node, hit);
                range.setEnd(node, hit + query.length);
                const mark = document.createElement('span');
                mark.className = 'article-search-hit';
                try {
                    range.surroundContents(mark);
                } catch (_error) {
                    // 跨元素关键词退化为滚动定位，不做包裹。
                }
                mark.scrollIntoView({ block: 'center' });
                setTimeout(() => {
                    const parent = mark.parentNode;
                    if (parent) {
                        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
                        mark.remove();
                    }
                }, 1600);
                return true;
            }
            node = walker.nextNode();
        }
        return false;
    }

    /* ---------------- 资产 ---------------- */

    setAssetMaxFileBytes(value) {
        this.assetMaxFileBytes = value;
    }

    insertArticleAssetReference(asset) {
        if (!asset) return false;
        const url = String(asset.url || '');
        if (!url) return false;
        const isImage = asset.kind === 'image' || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(url);
        const label = String(asset.name || asset.filename || (isImage ? 'image' : url));
        const markdown = isImage ? `![${label}](${url})` : `[${label}](${url})`;
        this.editor.commands.insertContentAt(this.editor.state.selection.from, markdown);
        this.notifyEditorValueChanged(this.getValue());
        return true;
    }
}
