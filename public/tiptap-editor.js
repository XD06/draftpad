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
    lowlight,
} from './managers/tiptap-runtime.js';
import {
    AnnotationMark,
    DrawMark,
    MdHighlight,
    MdSoftBreak,
    SoftEnterShortcut,
    TaskListInputShortcut,
    DumbPadTaskList,
    DumbPadCodeBlock,
    DumbPadTaskItem,
    HeadingAnchor,
    headingAnchorPluginKey,
    TimeCommandShortcut,
    TimeMarkerNode,
} from './managers/tiptap-extensions.js';
import { buildMarkdownHeadingIndex } from './managers/heading-index.js';

// frontmatter 假代码块按 YAML 高亮（官方插件对未注册语言会回退
// highlightAuto，产生随机着色）。
lowlight.registerAlias('yaml', 'dumbpad-frontmatter');

export class HybridMarkdownEditor {
    constructor(container, { input, performanceMonitor = null, onCaretChange = null } = {}) {
        if (!globalThis.DumbPadTiptap) {
            throw new Error('Tiptap failed to load.');
        }

        this.container = container;
        this.container.classList.add('typora-editor-shell', 'vditor');
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

        // 滚动层：旧编辑器的 DOM 形状是 #hybrid-editor > .vditor-wysiwyg(滚动) >
        // pre.vditor-reset(内容)。styles/ios-theme 的滚动与高度规则全部挂在
        // .vditor-wysiwyg 上，缺了这层页面会无法滚动。
        this.scroller = document.createElement('div');
        this.scroller.className = 'vditor-wysiwyg';
        container.appendChild(this.scroller);

        this.editor = new Editor({
            element: this.scroller,
            editorProps: {
                // 复用旧 vditor 的全部内容区样式（styles.css 117 条规则），
                // 保证切换内核后视觉零变化。
                attributes: { class: 'tiptap ProseMirror vditor-reset' },
                // 自定义 NodeView 不在此处挂载：Tiptap v3 的 createView 只认
                // 扩展 addNodeView（见 tiptap-extensions.js 的
                // DumbPadCodeBlock / DumbPadTaskItem）。
            },
            extensions: [
                SoftEnterShortcut,
                TaskListInputShortcut,
                Markdown.configure({
                    html: true,
                    linkify: false,
                    breaks: true,
                    transformPastedText: true,
                    transformCopiedText: true,
                }),
                StarterKit.configure({
                    hardBreak: false,
                    // 代码块交给官方 CodeBlockLowlight（PM Decoration 高亮）
                    codeBlock: false,
                }),
                AnnotationMark,
                DrawMark,
                MdHighlight,
                MdSoftBreak,
                HeadingAnchor,
                TimeCommandShortcut,
                TimeMarkerNode,
                Image,
                Table.configure({ resizable: false }),
                TableRow,
                TableHeader,
                TableCell,
                DumbPadTaskList,
                DumbPadTaskItem.configure({ nested: true }),
                // frontmatter 假代码块按 YAML 高亮，避免官方插件对未注册
                // 语言回退 highlightAuto 产生的随机着色。
                DumbPadCodeBlock.configure({
                    lowlight,
                }),
            ],
            content: '',
            autofocus: false,
        });

        this.editor.on('create', () => {
            this.ready = true;
            this._resolveReady();
        });

        this.editor.on('update', ({ transaction }) => {
            // Tiptap v3 的 setEditable（阅读模式切换）也会 emit update，
            // 必须过滤掉未改变文档的事务，否则启动即上报空变更、
            // 触发脏笔记保存与 409 冲突（"内容已在其他设备更新"）。
            if (transaction && !transaction.docChanged) return;
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

    whenReady() {
        return this.readyPromise;
    }

    /* ---------------- 值读写 ---------------- */

    getValue() {
        if (this.sourceMode) {
            return this.getSourceTextarea()?.value ?? this._lastValue;
        }
        return this.fenceToFrontmatter(this.editor.storage.markdown.getMarkdown());
    }

    /**
     * YAML frontmatter 在文档内以 language=dumbpad-frontmatter 的代码块呈现
     * （与旧编辑器一致：WYSIWYG 可见可编辑，作为卡片内的代码块渲染），
     * 序列化时映射回 --- 包裹的原文形态。只处理文档最前方的块，
     * 字节级还原由 test/test_tiptap_roundtrip.js 固化。
     */
    frontmatterToFence(value) {
        const FRONTMATTER_LEAD_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
        const match = String(value ?? '').match(FRONTMATTER_LEAD_RE);
        if (!match) return String(value ?? '');
        const inner = match[0].slice(4, match[0].length - 4);
        return '```dumbpad-frontmatter\n' + inner + '```\n' + String(value ?? '').slice(match[0].length);
    }

    fenceToFrontmatter(markdown) {
        const FENCE_RE = /^```dumbpad-frontmatter\n([\s\S]*?)\n?```(?:\n|$)/;
        const match = String(markdown ?? '').match(FENCE_RE);
        if (!match) return markdown;
        return '---\n' + match[1] + '\n---\n' + markdown.slice(match[0].length);
    }

    setValue(value, emit = true) {
        const nextValue = String(value ?? '');
        this._lastValue = nextValue;
        this.editor.commands.setContent(this.frontmatterToFence(nextValue), { emitUpdate: false });
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
        this.container.classList.toggle('is-reading-mode', this.isReadingMode);
        if (this.isReadingMode) {
            this.renderMermaidDiagrams();
        }
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
        this.onInput(value);
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
            scrollTop: Number(this.scroller.scrollTop || 0),
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
            if (this.scroller && Number.isFinite(Number(snapshot.scrollTop))) {
                this.scroller.scrollTop = Number(snapshot.scrollTop);
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
            this.scroller.style.setProperty('display', 'none');
        } else if (textarea) {
            const nextValue = textarea.value;
            textarea.style.display = 'none';
            this.scroller.style.removeProperty('display');
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
        // id 以 PM 节点 Decoration 渲染（HeadingAnchor 扩展）：直接改 PM
        // 管辖 DOM 的属性会被 DOMObserver 在重绘时抹掉。meta 事务不含步骤，
        // 不进撤销历史、docChanged=false 不会触发保存。id 与上次相同则跳过
        // 派发（app.js 的滚动高亮每帧都会调用本方法，必须幂等）。
        const ids = toc.map(entry => (entry?.id ? entry.id : ''));
        if (ids.join('\u0001') === this._lastHeadingAnchorIds) return;
        this._lastHeadingAnchorIds = ids.join('\u0001');
        if (!this.ready) {
            this.whenReady().then(() => {
                this._lastHeadingAnchorIds = null;
                this.syncRenderedHeadingIds(toc);
            }).catch(() => {});
            return;
        }
        this.editor.view.dispatch(this.editor.state.tr.setMeta(headingAnchorPluginKey, ids));
    }

    scrollToHeadingId(id) {
        if (!id) return false;
        const heading = this.container.querySelector(`.tiptap h1[id="${CSS.escape(id)}"], .tiptap h2[id="${CSS.escape(id)}"], .tiptap h3[id="${CSS.escape(id)}"], .tiptap h4[id="${CSS.escape(id)}"], .tiptap h5[id="${CSS.escape(id)}"], .tiptap h6[id="${CSS.escape(id)}"]`);
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
        if (!target) return;
        // 与旧 vditor 适配器同机制：手算偏移后在真正承载滚动的容器上
        // scrollTo。不能用 target.scrollIntoView({smooth})——它会被点击
        // 流程里紧随其后的其他滚动/焦点处理取消（实测跳转后 scrollTop
        // 纹丝不动），而旧实现自算偏移量不受影响。桌面端在
        // .vditor-wysiwyg 内滚动；移动端（ios-theme）整页滚动。
        const scroller = this.getScrollContainer();
        const isPageScroll = scroller === document.scrollingElement
            || scroller === document.documentElement;
        const viewTop = isPageScroll ? 0 : scroller.getBoundingClientRect().top;
        const targetRect = target.getBoundingClientRect();
        const nextTop = scroller.scrollTop + targetRect.top - viewTop - Math.max(24, scroller.clientHeight * 0.18);
        scroller.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
        target.classList.add('is-jump-target');
        setTimeout(() => target.classList.remove('is-jump-target'), 1600);
    }

    getScrollContainer() {
        const wysiwyg = this.scroller || this.container.querySelector('.vditor-wysiwyg');
        if (wysiwyg && wysiwyg.scrollHeight - wysiwyg.clientHeight > 1) return wysiwyg;
        return document.scrollingElement || document.documentElement;
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
                // 与旧实现一致：滚动统一走 scrollRenderedElementIntoView
                // （scrollIntoView 会被同一点击流程内的其他滚动取消）。
                this.scrollRenderedElementIntoView(mark);
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

    /* ---------------- Mermaid 阅读模式隔离渲染 ---------------- */

    loadMermaidRuntime() {
        if (!this.mermaidRuntimePromise) {
            this.mermaidRuntimePromise = new Promise((resolve, reject) => {
                if (globalThis.DumbPadMermaid) {
                    resolve(globalThis.DumbPadMermaid);
                    return;
                }
                const script = document.createElement("script");
                script.src = "/vendor/tiptap/tiptap-mermaid.bundle.js";
                script.onload = () => resolve(globalThis.DumbPadMermaid);
                script.onerror = () => {
                    script.remove();
                    this.mermaidRuntimePromise = null;
                    reject(new Error("Mermaid runtime failed to load."));
                };
                document.head.appendChild(script);
            });
        }
        return this.mermaidRuntimePromise;
    }

    async renderMermaidDiagrams() {
        const codeBlocks = this.container.querySelectorAll(".tiptap pre code.language-mermaid");
        if (!codeBlocks.length) return;
        let mermaidRuntime = null;
        try {
            mermaidRuntime = await this.loadMermaidRuntime();
        } catch (_error) {
            Array.from(codeBlocks).forEach((code) => this.showMermaidError(code));
            return;
        }
        const mermaid = mermaidRuntime && (mermaidRuntime.default || mermaidRuntime);
        if (!mermaid || typeof mermaid.render !== "function") return;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const blocks = Array.from(codeBlocks);
        for (let index = 0; index < blocks.length; index += 1) {
            const code = blocks[index];
            const source = code.textContent || "";
            try {
                const renderId = `dumbpad-mermaid-${Date.now()}-${index}`;
                const { svg } = await mermaid.render(renderId, source);
                code.innerHTML = svg;
                code.classList.add("mermaid-rendered");
            } catch (_error) {
                this.showMermaidError(code);
            }
        }
    }

    showMermaidError(code) {
        const pre = code.closest("pre");
        if (!pre) return;
        pre.classList.add("dumbpad-mermaid-error");
        if (!pre.querySelector(".mermaid-error-hint")) {
            const hint = document.createElement("div");
            hint.className = "mermaid-error-hint";
            hint.textContent = "Mermaid 图表语法有误，已保留源码，不影响其他内容编辑。";
            pre.appendChild(hint);
        }
    }
}
