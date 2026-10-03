/**
 * Tiptap 斜杠命令菜单：段落里输入 `/`（行首或空白之后）浮出快捷操作菜单，
 * 继续输入按 id/标题/关键词过滤，↑↓ 选择、Enter/Tab 执行、Escape 关闭，
 * 也支持点击/触摸直接执行。命令走注册表（registerSlashCommand），后续扩展
 * 只需注册描述符，不必改菜单本身。执行动作全部经框架命令改文档；/file 的
 * 选择器与上传复用 tiptap-file-command.js（openPickerAt），/time 复用
 * time-command.js 的标记构造，存储形态与手打 /time + Enter 完全一致。
 */
import { Extension, PM } from './tiptap-runtime.js';
import { buildTimeMarker, parseTimeMarkerText } from './time-command.js';

const { Plugin, PluginKey, TextSelection } = PM.state;

export const slashMenuPluginKey = new PluginKey('dumbpadSlashMenu');

/** 命令文本（`/query`）的最大长度：超长即视为普通文本，不再浮菜单。 */
const QUERY_MAX_LENGTH = 20;
/** 匹配串往前看的窗口：只需覆盖 query 上限 + 一个分隔字符。 */
const LOOKBACK = QUERY_MAX_LENGTH + 2;

const SLASH_QUERY_RE = /(?:^|[\t\n ]|\u00A0)\/([\w-]{0,20})$/;

/**
 * 斜杠命令注册表。描述符：
 *   { id, title, hint?, keywords?, icon?, run({ editor, adapter, range }) }
 * run 收到的 range 是命令文本（`/query`）在文档里的区间，由 run 自己决定
 * 是否删除（内置两条都会先删再插入/打开选择器，单事务可撤销）。
 */
export const slashCommandRegistry = [];

export function registerSlashCommand(definition) {
    if (!definition?.id || typeof definition.run !== 'function') {
        throw new Error('[slash-menu] command requires id and run()');
    }
    if (slashCommandRegistry.some(entry => entry.id === definition.id)) return;
    slashCommandRegistry.push({
        hint: `/${definition.id}`,
        keywords: [],
        icon: '',
        ...definition,
    });
}

export function filterSlashCommands(query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [...slashCommandRegistry];
    const prefix = `/${needle}`;
    return slashCommandRegistry.filter(entry => (
        `/${String(entry.id).toLowerCase()}`.startsWith(prefix)
        || String(entry.title || '').toLowerCase().includes(needle)
        || (entry.keywords || []).some(keyword => String(keyword).toLowerCase().includes(needle))
    ));
}

/** 光标与「/命令文本」的位置关系：命中返回 { query, from, to }，否则 null。 */
export function findSlashQueryBeforeCaret(state) {
    const selection = state.selection;
    if (!selection.empty) return null;
    const $from = selection.$from;
    // 命令禁区与 /time、/file 的现有守卫一致：代码块、行内代码不触发。
    if ($from.parent.type.spec.code) return null;
    if ($from.marks().some(mark => mark.type.name === 'code')) return null;
    if ($from.parent.type.name !== 'paragraph') return null;
    // textBetween 用段落内容相对坐标（0 基），parentOffset 同一坐标系；
    // $from.start() 是绝对位置，不能拿来当下界（会得到空窗口）。
    const lookbackStart = Math.max(0, $from.parentOffset - LOOKBACK);
    const textBefore = $from.parent.textBetween(lookbackStart, $from.parentOffset);
    const match = SLASH_QUERY_RE.exec(textBefore);
    if (!match) return null;
    const commandLength = match[1].length + 1;
    return {
        query: match[1],
        from: selection.from - commandLength,
        to: selection.from,
    };
}

/* 内置命令 -------------------------------------------------------------- */

const CLOCK_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';
const FILE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>';

function insertTimeMarkerAt(editor, pos) {
    const marker = buildTimeMarker(new Date(), 'create', 1);
    const parsed = parseTimeMarkerText(marker);
    const nodeType = editor.state.schema.nodes.timeMarker;
    if (!parsed || !nodeType) return;
    const node = nodeType.create({
        source: parsed.source,
        kind: parsed.kind,
        level: parsed.level,
        stamp: parsed.stamp,
        label: parsed.label,
    });
    editor.chain().command(({ tr }) => {
        tr.replaceWith(pos, pos, node);
        tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize));
        tr.scrollIntoView();
        return true;
    }).run();
}

registerSlashCommand({
    id: 'time',
    title: '插入时间标记',
    keywords: ['时间', 'timestamp'],
    icon: CLOCK_ICON_SVG,
    run: ({ editor, range }) => {
        editor.chain().command(({ tr }) => {
            tr.delete(range.from, range.to);
            return true;
        }).run();
        insertTimeMarkerAt(editor, range.from);
    },
});

registerSlashCommand({
    id: 'file',
    title: '插入文件或图片',
    keywords: ['附件', '图片', 'upload'],
    icon: FILE_ICON_SVG,
    run: ({ editor, adapter, range }) => {
        editor.chain().command(({ tr }) => {
            tr.delete(range.from, range.to);
            return true;
        }).run();
        // pendingPos 传给 file-command：上传期间用户继续编辑由既有的
        // transaction 重映射兜住；取消上传时焦点由 restoreEditorFocus 归还。
        adapter?.fileCommand?.openPickerAt(range.from);
    },
});

/* 菜单本体 -------------------------------------------------------------- */

export const TiptapSlashMenu = Extension.create({
    name: 'tiptapSlashMenu',

    addOptions() {
        return {
            // 宿主（HybridMarkdownEditor 适配器）经构造时的 configure 注入，
            // run({ adapter }) 由此取得 fileCommand 等适配器能力。
            getContext: () => null,
        };
    },

    addProseMirrorPlugins() {
        const options = this.options;
        const extensionEditor = this.editor;
        let menuView = null;

        return [
            new Plugin({
                key: slashMenuPluginKey,
                state: {
                    init: () => ({ open: false, query: '', from: -1, to: -1, dismissed: null }),
                    apply(tr, value) {
                        const meta = tr.getMeta(slashMenuPluginKey);
                        if (meta?.type === 'dismiss') {
                            return { ...value, open: false, dismissed: { from: value.from, to: value.to, query: value.query } };
                        }
                        if (meta?.type === 'close') {
                            return { ...value, open: false, dismissed: null };
                        }
                        // 文档被改（含撤销）后重新派生；被 Escape 压制的只是
                        // 「同一位置、同一 query」这个形状，换个字符立刻回来。
                        // tr.selection 是事务结束后的选区，tr.doc 是事务后的文档。
                        const next = findSlashQueryBeforeCaret({ selection: tr.selection });
                        const dismissed = value.dismissed;
                        const stillDismissed = dismissed
                            && next
                            && dismissed.from === next.from
                            && dismissed.to === next.to
                            && dismissed.query === next.query;
                        return {
                            open: Boolean(next) && !stillDismissed,
                            query: next ? next.query : '',
                            from: next ? next.from : -1,
                            to: next ? next.to : -1,
                            dismissed: stillDismissed ? dismissed : null,
                        };
                    },
                },
                props: {
                    handleKeyDown: (view, event) => {
                        const state = slashMenuPluginKey.getState(view.state);
                        // 无候选项时菜单已隐藏，键位交还原有语义（Enter 走软换行等）。
                        if (!state?.open || !menuView || !menuView.items.length) return false;
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            menuView.moveSelection(1);
                            return true;
                        }
                        if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            menuView.moveSelection(-1);
                            return true;
                        }
                        if (event.key === 'Enter' || event.key === 'Tab') {
                            event.preventDefault();
                            menuView.executeSelected();
                            return true;
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            menuView.dismiss();
                            return true;
                        }
                        return false;
                    },
                },
                view(editorView) {
                    menuView = new SlashMenuView(editorView, options, extensionEditor);
                    return menuView;
                },
            }),
        ];
    },
});

class SlashMenuView {
    constructor(view, options, editor) {
        this.view = view;
        this.options = options;
        this.editor = editor;
        this.items = [];
        this.selectedIndex = 0;
        this.visible = false;

        this.root = document.createElement('div');
        this.root.className = 'slash-command-menu';
        this.root.style.display = 'none';
        this.root.setAttribute('role', 'listbox');
        this.root.setAttribute('aria-label', '快捷命令');
        // 按下不能把编辑器焦点/选区抢走（浏览器把焦点移到菜单上，
        // PM 选区折叠，命令区间随之丢失）。
        this.root.addEventListener('mousedown', (event) => event.preventDefault());
        this.root.addEventListener('click', (event) => {
            const item = event.target.closest('[data-slash-index]');
            if (!item) return;
            event.preventDefault();
            this.selectedIndex = Number(item.dataset.slashIndex) || 0;
            this.executeSelected();
        });
        this.root.addEventListener('mouseover', (event) => {
            const item = event.target.closest('[data-slash-index]');
            if (!item) return;
            this.setSelected(Number(item.dataset.slashIndex) || 0);
        });
        document.body.appendChild(this.root);

        this.handleScroll = () => this.position();
        this.handleResize = () => this.position();
        // 点编辑器外（其他面板/正文）收起菜单：编辑器 blur 即收。
        // 菜单自身的 mousedown 已 preventDefault，不会触发这条路径。
        this.handleBlur = () => this.hide();
        document.addEventListener('scroll', this.handleScroll, { capture: true, passive: true });
        window.addEventListener('resize', this.handleResize);
        view.dom.addEventListener('blur', this.handleBlur, true);
    }

    /** 菜单是否允许出现：阅读模式/源码模式下编辑器 DOM 不可交互。 */
    menuAllowed() {
        if (!this.view.editable) return false;
        const shell = this.view.dom.closest?.('.typora-editor-shell');
        if (shell?.classList.contains('is-source-mode')) return false;
        return true;
    }

    update(view, prevState) {
        const next = slashMenuPluginKey.getState(view.state);
        const prev = slashMenuPluginKey.getState(prevState);
        if (!next?.open || !this.menuAllowed() || view.composing) {
            this.hide();
            return;
        }
        const shapeChanged = !prev?.open
            || prev.from !== next.from
            || prev.to !== next.to
            || prev.query !== next.query;
        if (!this.visible || shapeChanged) {
            this.show(next);
            return;
        }
        // 命令区间未变、只是光标或周边内容微动：重定位即可。
        this.position();
    }

    show(state) {
        const items = filterSlashCommands(state.query);
        this.items = items;
        this.selectedIndex = 0;
        this.range = { from: state.from, to: state.to };
        if (!items.length) {
            this.hide();
            return;
        }
        this.renderItems();
        this.root.style.display = 'flex';
        this.visible = true;
        this.position();
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.root.style.display = 'none';
    }

    renderItems() {
        this.root.replaceChildren();
        this.items.forEach((entry, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'slash-command-item' + (index === this.selectedIndex ? ' is-selected' : '');
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', String(index === this.selectedIndex));
            item.dataset.slashIndex = String(index);
            if (entry.icon) {
                const icon = document.createElement('span');
                icon.className = 'slash-command-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.innerHTML = entry.icon;
                item.appendChild(icon);
            }
            const label = document.createElement('span');
            label.className = 'slash-command-label';
            label.textContent = entry.title || entry.id;
            item.appendChild(label);
            const hint = document.createElement('kbd');
            hint.className = 'slash-command-hint';
            hint.textContent = entry.hint || `/${entry.id}`;
            item.appendChild(hint);
            this.root.appendChild(item);
        });
    }

    setSelected(index) {
        if (index === this.selectedIndex) return;
        this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
        Array.from(this.root.children).forEach((item, itemIndex) => {
            item.classList.toggle('is-selected', itemIndex === this.selectedIndex);
            item.setAttribute('aria-selected', String(itemIndex === this.selectedIndex));
        });
    }

    moveSelection(delta) {
        if (!this.items.length) return;
        const count = this.items.length;
        this.setSelected((this.selectedIndex + delta + count) % count);
        this.root.children[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }

    executeSelected() {
        const entry = this.items[this.selectedIndex];
        if (!entry || !this.range) {
            this.hide();
            return;
        }
        // 位置取执行瞬间的插件状态：show 之后用户可能又敲了字符，
        // range 必须跟手而不是 show 时的快照。
        const state = slashMenuPluginKey.getState(this.view.state);
        const range = state?.open ? { from: state.from, to: state.to } : this.range;
        this.hide();
        // 先彻底关掉（清 dismissed），再执行：执行后命令文本已不在文档里，
        // 状态自然回到 closed。
        this.view.dispatch(this.view.state.tr.setMeta(slashMenuPluginKey, { type: 'close' }));
        try {
            entry.run({
                editor: this.editor,
                adapter: this.options.getContext(),
                range,
            });
        } catch (error) {
            console.error('[slash-menu] command failed:', error);
        }
    }

    dismiss() {
        this.hide();
        this.view.dispatch(this.view.state.tr.setMeta(slashMenuPluginKey, { type: 'dismiss' }));
    }

    position() {
        if (!this.visible) return;
        const state = slashMenuPluginKey.getState(this.view.state);
        if (!state?.open || state.from < 0) return;
        requestAnimationFrame(() => {
            if (!this.visible) return;
            let caret;
            try {
                caret = this.view.coordsAtPos(Math.min(state.from, this.view.state.doc.content.size));
            } catch (_error) {
                // jsdom 等无布局环境 coordsAtPos 会 throw：跳过定位，
                // 不能把刚显示的菜单藏掉（真实浏览器不会 throw）。
                return;
            }
            const menuRect = this.root.getBoundingClientRect();
            const isMobile = window.matchMedia?.('(max-width: 720px)').matches;
            const viewportHeight = window.visualViewport?.height || window.innerHeight;
            const scrollX = window.scrollX || 0;
            const scrollY = window.scrollY || 0;
            // 移动端固定在光标下方（上方空间常被系统工具栏挤压）；桌面优先
            // 下方，放不下翻上方。两端都以可视视口为界（软键盘弹出时
            // visualViewport.height 缩小，菜单不被键盘盖住）。
            let top = caret.bottom + scrollY + 8;
            if (!isMobile && top + menuRect.height > scrollY + viewportHeight - 8) {
                top = caret.top + scrollY - menuRect.height - 8;
            }
            top = Math.max(scrollY + 8, top);
            const width = Math.min(menuRect.width || 280, window.innerWidth - 16);
            let left = caret.left + scrollX - width / 2;
            left = Math.min(Math.max(left, scrollX + 8), scrollX + window.innerWidth - width - 8);
            this.root.style.left = `${Math.round(left)}px`;
            this.root.style.top = `${Math.round(top)}px`;
            this.root.style.maxHeight = `${Math.max(160, viewportHeight - 48)}px`;
        });
    }

    destroy() {
        document.removeEventListener('scroll', this.handleScroll, { capture: true });
        window.removeEventListener('resize', this.handleResize);
        this.view.dom.removeEventListener('blur', this.handleBlur, true);
        this.root.remove();
    }
}
