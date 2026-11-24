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
    const scored = [];
    slashCommandRegistry.forEach((entry, index) => {
        const id = String(entry.id || '').toLowerCase();
        const title = String(entry.title || '').toLowerCase();
        const keywords = (entry.keywords || []).map(k => String(k || '').toLowerCase());
        let rank = Number.POSITIVE_INFINITY;
        if (id === needle) rank = 0;
        else if (id.startsWith(needle)) rank = 1;
        else if (title.startsWith(needle)) rank = 2;
        else if (keywords.some(k => k.startsWith(needle))) rank = 3;
        else if (id.includes(needle) || title.includes(needle) || keywords.some(k => k.includes(needle))) rank = 4;
        if (Number.isFinite(rank)) scored.push({ entry, rank, index });
    });
    scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return scored.map(item => item.entry);
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
const CODE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
const MERMAID_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="6" rx="1.5"></rect><rect x="14" y="15" width="7" height="6" rx="1.5"></rect><path d="M6.5 9v4a2 2 0 0 0 2 2H14"></path><path d="M17.5 15V9a2 2 0 0 0-2-2H10"></path></svg>';
const TODO_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="m8 12 2.8 2.8L16.5 9"></path></svg>';
const DOING_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M8.5 12h7"></path></svg>';
const HEADING_ICON_SVG = (level) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h8"></path><path d="M4 18V6"></path><path d="M12 18V6"></path><text x="15" y="18" font-size="9" font-weight="700" fill="currentColor" stroke="none">${level}</text></svg>`;
const QUOTE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"></path></svg>';
const HR_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"></line></svg>';
const TABLE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="10" x2="9" y2="20"></line><line x1="15" y1="10" x2="15" y2="20"></line></svg>';
const FRONTMATTER_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 10h10"></path><path d="M4 14h16"></path><path d="M4 18h8"></path></svg>';

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

/**
 * 清理斜杠命令并隔离出干净块起点：
 * - 若命令前只有硬换行/段首空白，吞掉相邻 `<br>`，避免把同一段落的前文卷入目标块；
 * - 若命令前有实文本，自动拆块使目标块独占一行。
 */
function runBlockSlashCommand(editor, range, applyChain) {
    const state = editor.state;
    const $from = state.doc.resolve(range.from);
    const paraStart = $from.start();
    const beforeText = state.doc.textBetween(paraStart, range.from, '\n');

    let cutFrom = range.from;
    if (/^\s*$/.test(beforeText.replace(/\n/g, ''))) {
        cutFrom = paraStart;
    } else {
        while (cutFrom > paraStart) {
            const nodeBefore = state.doc.nodeAt(cutFrom - 1);
            if (nodeBefore?.type.name === 'hardBreak') {
                cutFrom -= 1;
                continue;
            }
            if (nodeBefore?.isText) {
                const text = nodeBefore.text || '';
                if (/^[ \t\u00A0]+$/.test(text)) {
                    cutFrom -= nodeBefore.nodeSize;
                    continue;
                }
            }
            break;
        }
    }

    const needSplit = cutFrom > paraStart;
    let chain = editor.chain().focus().deleteRange({ from: cutFrom, to: range.to });
    if (needSplit) chain = chain.splitBlock();
    applyChain(chain).scrollIntoView().run();
}

function runTaskSlashCommand(editor, range, { doing = false } = {}) {
    const state = editor.state;
    const $from = state.doc.resolve(range.from);
    let liDepth = -1;
    for (let d = $from.depth - 1; d >= 1; d -= 1) {
        if (['listItem', 'taskItem'].includes($from.node(d).type.name)) {
            liDepth = d;
            break;
        }
    }

    // 巢状单条目无序/有序列表项就地转待办，保持嵌套层级不被内核抬回根层。
    if (liDepth >= 1 && $from.depth === liDepth + 1 && $from.index(liDepth) === 0) {
        const listDepth = liDepth - 1;
        const list = $from.node(listDepth);
        const taskListType = state.schema.nodes.taskList;
        const taskItemType = state.schema.nodes.taskItem;
        if (['bulletList', 'orderedList'].includes(list.type.name) && list.childCount === 1 && taskListType && taskItemType) {
            const tr = state.tr;
            tr.delete(range.from, range.to);
            const $caret = tr.doc.resolve(Math.min(range.from, tr.doc.content.size));
            const listItem = $caret.node(liDepth);
            const listNode = $caret.node(listDepth);
            const children = [];
            listItem.forEach(child => children.push(child));
            const taskItemNode = taskItemType.create({ checked: false, doing }, children);
            const taskListNode = taskListType.create({ tight: listNode.attrs.tight ?? true }, [taskItemNode]);
            const listFrom = $caret.before(listDepth);
            tr.replaceWith(listFrom, $caret.after(listDepth), taskListNode);
            tr.setSelection(TextSelection.create(tr.doc, listFrom + 3));
            tr.scrollIntoView();
            editor.view.dispatch(tr);
            editor.view.focus();
            return;
        }
    }

    runBlockSlashCommand(editor, range, (chain) => {
        let next = chain.toggleTaskList();
        if (doing) {
            next = next.updateAttributes('taskItem', { checked: false, doing: true });
        }
        return next;
    });
}

registerSlashCommand({
    id: 'time',
    title: '插入时间标记',
    keywords: ['时间', 'timestamp', 'now'],
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
    keywords: ['附件', '图片', '文件', 'upload'],
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

registerSlashCommand({
    id: 'code',
    title: '代码块',
    keywords: ['代码', 'codeblock', 'pre', '```'],
    icon: CODE_ICON_SVG,
    run: ({ editor, range }) => {
        runBlockSlashCommand(editor, range, chain => chain.setCodeBlock());
    },
});

registerSlashCommand({
    id: 'mermaid',
    title: 'Mermaid 图表',
    keywords: ['mermaid', '图表', '流程图', 'diagram', 'chart'],
    icon: MERMAID_ICON_SVG,
    run: ({ editor, range }) => {
        const template = 'flowchart LR\n    A[开始] --> B[完成]';
        runBlockSlashCommand(editor, range, chain => (
            chain.setCodeBlock({ language: 'mermaid' }).command(({ tr }) => {
                // tr.insertText 直接写入 codeBlock 文本节点；不能用 insertContent(template)，
                // 否则 HTML 解析会把换行后的 "A[开始] --> B[完成]" 拆到代码块外成新段落。
                tr.insertText(template);
                return true;
            })
        ));
    },
});

registerSlashCommand({
    id: 'todo',
    title: '待办事项',
    keywords: ['待办', '任务', 'todo', 'task', 'checkbox', '[]'],
    icon: TODO_ICON_SVG,
    run: ({ editor, range }) => {
        runTaskSlashCommand(editor, range, { doing: false });
    },
});

registerSlashCommand({
    id: 'doing',
    title: '进行中待办',
    keywords: ['进行中', '任务', 'doing', '[~]'],
    icon: DOING_ICON_SVG,
    run: ({ editor, range }) => {
        runTaskSlashCommand(editor, range, { doing: true });
    },
});

registerSlashCommand({
    id: 'h1',
    title: '一级标题',
    keywords: ['标题', '一级标题', 'heading', 'title', '#'],
    icon: HEADING_ICON_SVG(1),
    run: ({ editor, range }) => {
        runBlockSlashCommand(editor, range, chain => chain.setHeading({ level: 1 }));
    },
});

registerSlashCommand({
    id: 'h2',
    title: '二级标题',
    keywords: ['标题', '二级标题', 'heading', '##'],
    icon: HEADING_ICON_SVG(2),
    run: ({ editor, range }) => {
        runBlockSlashCommand(editor, range, chain => chain.setHeading({ level: 2 }));
    },
});

registerSlashCommand({
    id: 'h3',
    title: '三级标题',
    keywords: ['标题', '三级标题', 'heading', '###'],
    icon: HEADING_ICON_SVG(3),
    run: ({ editor, range }) => {
        runBlockSlashCommand(editor, range, chain => chain.setHeading({ level: 3 }));
    },
});

registerSlashCommand({
    id: 'quote',
    title: '引用块',
    keywords: ['引用', 'blockquote', '>'],
    icon: QUOTE_ICON_SVG,
    run: ({ editor, range }) => {
        runBlockSlashCommand(editor, range, chain => chain.setBlockquote());
    },
});

registerSlashCommand({
    id: 'hr',
    title: '分隔线',
    keywords: ['分隔线', '分割线', 'divider', '---'],
    icon: HR_ICON_SVG,
    run: ({ editor, range }) => {
        runBlockSlashCommand(editor, range, chain => chain.setHorizontalRule());
    },
});

registerSlashCommand({
    id: 'table',
    title: '表格 (3×3)',
    keywords: ['表格', 'table', 'grid'],
    icon: TABLE_ICON_SVG,
    run: ({ editor, range }) => {
        runBlockSlashCommand(editor, range, chain => (
            chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        ));
    },
});

registerSlashCommand({
    id: 'frontmatter',
    title: 'YAML 文档属性',
    keywords: ['frontmatter', 'yaml', '属性', 'meta', '---'],
    icon: FRONTMATTER_ICON_SVG,
    run: ({ editor, range }) => {
        const { state } = editor;
        const codeBlock = state.schema.nodes.codeBlock;
        if (!codeBlock) return;
        const tr = state.tr.delete(range.from, range.to);
        const firstChild = tr.doc.firstChild;
        if (firstChild?.type === codeBlock && firstChild.attrs?.language === 'dumbpad-frontmatter') {
            tr.setSelection(TextSelection.create(tr.doc, 1));
        } else {
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            const seed = `title: \ndate: ${today}`;
            const fmNode = codeBlock.create(
                { language: 'dumbpad-frontmatter' },
                state.schema.text(seed)
            );
            tr.insert(0, fmNode);
            tr.setSelection(TextSelection.create(tr.doc, 1 + 'title: '.length));
        }
        tr.scrollIntoView();
        editor.view.dispatch(tr);
        editor.view.focus();
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
            const vv = window.visualViewport;
            const viewportHeight = Number(vv?.height || window.innerHeight || 0);
            const viewportOffsetTop = Number(vv?.offsetTop || 0);
            const scrollX = window.scrollX || 0;
            const scrollY = window.scrollY || 0;
            const visibleTopDoc = scrollY + viewportOffsetTop;
            const visibleBottomDoc = visibleTopDoc + viewportHeight;
            const spaceBelow = visibleBottomDoc - (caret.bottom + scrollY) - 10;
            const spaceAbove = (caret.top + scrollY) - visibleTopDoc - 10;
            const menuHeight = menuRect.height || 240;

            let top;
            let maxHeight;
            if (spaceBelow >= Math.min(menuHeight, 180) || spaceBelow >= spaceAbove) {
                top = caret.bottom + scrollY + 8;
                maxHeight = Math.max(140, Math.min(320, spaceBelow));
            } else {
                maxHeight = Math.max(140, Math.min(320, spaceAbove));
                top = caret.top + scrollY - Math.min(menuHeight, maxHeight) - 8;
            }
            top = Math.max(visibleTopDoc + 8, top);

            const width = Math.min(menuRect.width || 280, window.innerWidth - 16);
            let left = caret.left + scrollX - width / 2;
            left = Math.min(Math.max(left, scrollX + 8), scrollX + window.innerWidth - width - 8);
            this.root.style.left = `${Math.round(left)}px`;
            this.root.style.top = `${Math.round(top)}px`;
            this.root.style.maxHeight = `${Math.round(maxHeight)}px`;
        });
    }

    destroy() {
        document.removeEventListener('scroll', this.handleScroll, { capture: true });
        window.removeEventListener('resize', this.handleResize);
        this.view.dom.removeEventListener('blur', this.handleBlur, true);
        this.root.remove();
    }
}
