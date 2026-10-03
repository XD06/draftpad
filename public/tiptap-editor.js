/**
 * Tiptap 黑盒适配器：导出与旧 Vditor 封装同名的 HybridMarkdownEditor 类，
 * 保持 getValue/setValue/光标/导航/阅读模式等公开契约不变（app.js 零改造）。
 * 序列化格式与旧编辑器逐字节对齐，roundtrip 由 test/test_tiptap_roundtrip.js 固化。
 */
import {
    Editor,
    StarterKit,
    Markdown,
    Table,
    TableRow,
    TableCell,
    TableHeader,
    lowlight,
} from './managers/tiptap-runtime.js';
import {
    AnnotationMark,
    DrawMark,
    DumbPadUnderline,
    MdHighlight,
    MdSoftBreak,
    SoftEnterShortcut,
    QuoteBackspaceShortcut,
    SoftBreakBlockRules,
    CodeFenceInputShortcut,
    DividerInputShortcut,
    FrontmatterLeadInputShortcut,
    DumbPadMixedTaskListGuard,
    DumbPadEmptyTaskItemParseRule,
    DumbPadEmptyListMarkerParseRule,
    DumbPadFrontmatterParseRule,
    SearchHitHighlight,
    searchHitPluginKey,
    JumpTargetHighlight,
    jumpTargetPluginKey,
    TaskListInputShortcut,
    DumbPadTaskList,
    DumbPadCodeBlock,
    DumbPadTaskItem,
    HeadingAnchor,
    headingAnchorPluginKey,
    TimeCommandShortcut,
    TimeMarkerNode,
    DumbPadListBlankLineBackspace,
    DumbPadTaskItemInPlaceShortcut,
} from './managers/tiptap-extensions.js';
import { TiptapSelectionMenu } from './managers/tiptap-selection-menu.js';
import { TiptapSlashMenu } from './managers/tiptap-slash-menu.js';
import { createFileCommandController, TiptapArticleUploadProgress } from './managers/tiptap-file-command.js';
import { DEFAULT_ARTICLE_IMAGE_WIDTH } from './managers/article-file-command.js';
import {
    DumbPadArticleFileLink,
    DumbPadImage,
    TiptapImageInteractions,
} from './managers/tiptap-image-interactions.js';
import { DumbPadMedia } from './managers/tiptap-media.js';
import { buildMarkdownHeadingIndex } from './managers/heading-index.js';

// frontmatter 假代码块按 YAML 高亮（官方插件对未注册语言会回退
// highlightAuto，产生随机着色）。
lowlight.registerAlias('yaml', 'dumbpad-frontmatter');

const EMPTY_LIST_MARKER_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]*$/;
const LIST_MARKER_LINE_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 空列表项的序列化形态（行首只有标记、没有内容）在 Markdown 里有唯一的解析歧义：
 * 空条目**不能打断段落**（CommonMark），前一行是段落文字时它会退化成惰性续行，
 * 而只由 `-` 组成的行又恰好是 setext 标题下划线——`- 甲\n  - ` 重新解析变成
 * `## 甲`（父行被吞成二级标题、空项消失）。「列表下唯一的空嵌套项」（回车 + Tab
 * 的正常打字流）和「段落后的空列表」（打字流：回车 + `- ` 后未输入）都会踩中。
 *
 * 本归一化在序列化出口为这类行补一个空行（空行关闭段落，空条目即可正常起列表，
 * 实测该形态往返逐字节稳定）：仅当**空标记行的缩进比上一非空行的列表标记更深**
 * （新起一层）或上一行不是列表行时触发；同缩进的后续空项（`- 乙` 之后的 `  - `）
 * 本来就解析正确，不动。幂等：补过空行后上一行是空行，规则不再命中。
 * 围栏代码块、`$$` 数学块与文首 frontmatter 内部一律跳过。
 */
export function normalizeAmbiguousEmptyListMarkers(value = '') {
    const lines = String(value ?? '').split('\n');
    let fenceMarker = null;
    let fenceLength = 0;
    let inMathBlock = false;
    // 文首 frontmatter：第 0 行的开栏 --- 不算闭栏，闭栏之后的行重置为
    // 「块边界」状态（frontmatter 是独立的块，其后的空标记行本就合法）。
    let inFrontmatter = String(value ?? '').startsWith('---\n');
    let frontmatterClosed = false;
    let previousMarkerIndent = -1;
    let previousBlank = true;
    const output = [];
    for (const line of lines) {
        if (inFrontmatter && !frontmatterClosed) {
            output.push(line);
            if (output.length > 1 && line.trim() === '---') {
                frontmatterClosed = true;
                previousMarkerIndent = -1;
                previousBlank = true;
            } else {
                previousMarkerIndent = -1;
                previousBlank = false;
            }
            continue;
        }
        if (!fenceMarker && !inMathBlock && /^\s*\$\$/.test(line)) {
            const dollarPairs = (line.match(/\$\$/g) || []).length;
            if (dollarPairs % 2 === 1) inMathBlock = true;
            output.push(line);
            previousMarkerIndent = -1;
            previousBlank = false;
            continue;
        }
        if (inMathBlock) {
            output.push(line);
            const dollarPairs = (line.match(/\$\$/g) || []).length;
            if (dollarPairs % 2 === 1) {
                inMathBlock = false;
                previousMarkerIndent = -1;
                previousBlank = true;
            }
            continue;
        }
        const fence = line.match(FENCE_OPEN_RE);
        if (fenceMarker) {
            output.push(line);
            if (fence && fence[1][0] === fenceMarker && fence[1].length >= fenceLength
                && !line.trim().slice(fence[1].length).includes(fenceMarker)) {
                fenceMarker = null;
                previousMarkerIndent = -1;
                previousBlank = true;
            }
            continue;
        }
        if (fence) {
            fenceMarker = fence[1][0];
            fenceLength = fence[1].length;
            output.push(line);
            previousMarkerIndent = -1;
            previousBlank = false;
            continue;
        }
        const marker = line.match(EMPTY_LIST_MARKER_RE);
        if (marker && !previousBlank && marker[1].length > previousMarkerIndent) {
            output.push('');
        }
        const listed = line.match(LIST_MARKER_LINE_RE);
        previousMarkerIndent = listed ? listed[1].length : -1;
        previousBlank = !line.trim();
        output.push(line);
    }
    return output.join('\n');
}

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
        this._headingAnchorQueued = false;
        this._lastValue = '';
        this.ready = false;
        this.pendingValue = '';
        this.sourceMode = false;
        this.assetMaxFileBytes = null;
        this.assetApi = null;
        this.isComposing = false;
        this.fileCommand = createFileCommandController(this);

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
                // /file 命令的 Enter 拦截走 directProps：优先级高于
                // SoftEnterShortcut 等插件键位，/file 不会被软换行吃掉。
                handleKeyDown: (view, event) => Boolean(this.fileCommand?.handleKeyDown(view, event)),
            },
            extensions: [
                // AnnotationMark 排在最前，且 priority 高于 Link（见 tiptap-extensions.js）：
                // PM 的 mark 渲染按 schema rank 排序取共同前缀开闭元素，annotation rank
                // 必须小于 code / link，跨行内代码与跨链接的批注才渲染成一个连续的
                // has-annotation span（否则被切成三段、三个徽标）。
                AnnotationMark,
                SoftEnterShortcut,
                QuoteBackspaceShortcut,
                TaskListInputShortcut,
                Markdown.configure({
                    html: true,
                    linkify: false,
                    breaks: true,
                    transformPastedText: true,
                    transformCopiedText: true,
                }),
                // 粘贴的 --- 头与 setValue 走同一条解析（frontmatter → 代码块），
                // 否则首个 --- 变 <hr>、第二个被 setext 吃掉，落库即损坏。
                DumbPadFrontmatterParseRule,
                StarterKit.configure({
                    hardBreak: false,
                    // 代码块交给官方 CodeBlockLowlight（PM Decoration 高亮）
                    codeBlock: false,
                    // 下划线交给 DumbPadUnderline：上游 parseHTML 用 value.includes('underline')
                    // 判定 style 规则，会把批注的 `text-decoration:underline wavy #e74c3c` 和划线
                    // 的 `underline blue` 也算成下划线，于是刷新后多出一条直线下划线，并且 `<u>`
                    // 被写回正文。这里关掉原版，只替换解析判定。
                    underline: false,
                    // 关掉 Link 的 openOnClick。Tiptap 的链接点击处理（PM handleClick，
                    // PluginKey handleClickLink）由 prosemirror-view 在 **mouseup** 里派发
                    // （LeftMouseDown.up → handleSingleClick → someProp('handleClick')），
                    // 永远早于任何 click 事件——DOM 层面（连捕获阶段都）拦不住它。开着的后果：
                    // 编辑模式点附件 chip 会先 window.open('/api/assets/<id>/download', '_blank')
                    // 直接下载，菜单随后才出现。裸 URL「编辑模式可点开」改由
                    // tiptap-image-interactions.js 按旧 Vditor 基线自己实现；阅读模式一直是
                    // 浏览器原生行为，不经过这里。
                    link: { openOnClick: false },
                }),
                DrawMark,
                // 下划线 mark 的解析判定由 DumbPadUnderline 收窄（tiptap-extensions.js）
                DumbPadUnderline,
                MdHighlight,
                MdSoftBreak,
                // 软换行后的「视觉行首」输入块标记（# - 1. >）就地拆块，见 tiptap-extensions.js
                SoftBreakBlockRules,
                // 手打的 ``` 围栏在收尾反引号落下时转正为代码块，见 tiptap-extensions.js
                CodeFenceInputShortcut,
                // 分隔线当场成型：软换行后的视觉行首打 `---` 立刻拆块成线。官方规则只锚 PM
                // 块首，这一档在屏幕上一直是字面文本，而重新解析会被 setext 当成标题下划线
                // （静默改内容），见 tiptap-extensions.js
                DividerInputShortcut,
                // 文章最开头打 --- 当场转正为 frontmatter 块（与粘贴 / setValue 同形态）
                FrontmatterLeadInputShortcut,
                HeadingAnchor,
                // 全局搜索跳转的词级 + 块级命中高亮（PM Decoration，见 tiptap-extensions.js）
                SearchHitHighlight,
                // 目录跳转的落点闪光（PM Decoration，见 tiptap-extensions.js）
                JumpTargetHighlight,
                TimeCommandShortcut,
                TimeMarkerNode,
                // 图片节点由 DumbPadImage 提供（关闭原生 draggable，换位走
                // 指针拖拽事务）；宽度/类名由 PM Decoration 应用。
                DumbPadImage,
                // 嵌入媒体（/file 上传的音视频，内联播放器节点，解析期把
                // dumbpad-video/audio 占位 img 升级成媒体节点）。
                DumbPadMedia,
                Table.configure({ resizable: false }),
                TableRow,
                TableHeader,
                TableCell,
                DumbPadTaskList,
                DumbPadTaskItem.configure({ nested: true }),
                // 空任务项（- [ ] ）解析补丁：必须在 DumbPadTaskList 之后、赶在
                // github-task-lists 之前补尾随空格，见 tiptap-extensions.js
                DumbPadEmptyTaskItemParseRule,
                // 空列表标记行（- 甲\n  - ）不再被 setext 吞掉父行，见 tiptap-extensions.js
                DumbPadEmptyListMarkerParseRule,
                // 混排列表撤 taskList 章（必须在 DumbPadTaskList 之后），见 tiptap-extensions.js
                DumbPadMixedTaskListGuard,
                // frontmatter 假代码块按 YAML 高亮，避免官方插件对未注册
                // 语言回退 highlightAuto 产生的随机着色。
                DumbPadCodeBlock.configure({
                    lowlight,
                }),
                TiptapSelectionMenu,
                TiptapImageInteractions,
                DumbPadArticleFileLink,
                TiptapArticleUploadProgress,
                // 斜杠命令菜单（/time、/file，可经 registerSlashCommand 扩展）。
                // 必须排在扩展列表末尾：PM 的 handleKeyDown 按插件注册的逆序咨询，
                // 菜单要抢在 SoftEnterShortcut / TimeCommandShortcut 之前处理
                // Enter/↑↓/Escape；菜单关闭时全部放行，原语义不变。
                // 注意 directProps（/file 的 editorProps.handleKeyDown）永远先于
                // 一切插件：完整键入 "/file" + Enter 仍走旧路径（文本由选择后
                // 的 deletePendingCommand 删除），菜单主要服务补全与点击/触摸。
                TiptapSlashMenu.configure({ getContext: () => this }),
                // 空列表项退格 = 清除继承标记、原地留缩进空行（无 Tab 嵌套路径的
                // 退格半边，键入半边由官方输入规则在尾部空行上自然生效）。
                // 必须排在 TiptapSlashMenu 之后（handleKeyDown 逆序咨询），
                // 抢在 Tiptap listKeymap 的空项 lift 之前，见 tiptap-extensions.js。
                DumbPadListBlankLineBackspace,
                // 列表项首段落上的 [ ] 就地转待办（内核规则此时会抬升到根，
                // 嵌套待办「渲染到最前面」的根因）。priority 101 先于内核
                // TaskItem 规则咨询，与 SoftBreakBlockRules 同套路，
                // 见 tiptap-extensions.js。
                DumbPadTaskItemInPlaceShortcut,
            ],
            content: '',
            autofocus: false,
        });

        // Tiptap 的 Code mark 排除其他装饰类 marks（excluded 默认含 bold/italic/
        // strike/underline/link/draw/mdHighlight/annotation），行内代码 chip 是
        // schema 层的「mark 禁区」——后果是「标记盖住行内代码」在 addMark 时被 PM
        // 直接丢弃：一条批注/一次画线于 code 边界断开，存储与渲染都变成两段（两个
        // 徽标、波浪线断开），刷新后 getMarkRange 只沿连续段展开，取消一次只去掉一段。
        // 批注/画线/高亮都是**内容层**语义（用户视角「一个操作 = 一个整体」），这里
        // 豁免它们不被 code 排除；代码 chip 自身样式不受影响——code mark 仍在文字上，
        // 只是被外层 span 包住（rank 由 priority 决定：annotation 1100 > draw 1090 >
        // mdHighlight 1080 > code）。bold/italic/link 等文字级语义保持被排除的默认。
        // 只动这一个数组，Code 的其他行为（渲染、序列化、输入规则）不变。
        //
        // 必须在构造函数中同步应用豁免（不能等 this.editor.on('create') 异步触发）：
        // app.js 会在 new HybridMarkdownEditor(...) 之后立刻同步调用 setValue(pendingEditorValue)
        // 载入草稿或首屏文章。若等 create 宏任务，首次 setValue 触发的 normalizeDecorationMarks()
        // 就会因为 codeType.excluded 仍未豁免而被 ProseMirror 静默丢弃 addMark，导致刷新后
        // 跨行内代码的批注/画线/高亮重新裂开成两段。
        this._exemptDecorationMarksFromCode();

        this.editor.on('create', () => {
            this.ready = true;
            this._resolveReady();
            this._exemptDecorationMarksFromCode();
            // 若在 create 宏任务到来前已有内容载入，兜底收敛一次
            this.normalizeDecorationMarks();
        });

        this.editor.on('update', ({ transaction }) => {
            // Tiptap v3 的 setEditable（阅读模式切换）也会 emit update，
            // 必须过滤掉未改变文档的事务，否则启动即上报空变更、
            // 触发脏笔记保存与 409 冲突（"内容已在其他设备更新"）。
            // dumbpadNormalize 是装饰 mark（批注/画线/高亮）的拆段连接事务：修复内容
            // 本身就是加载进来的内容，不能被当作用户编辑触发保存。
            if (!transaction || !transaction.docChanged || transaction.getMeta('dumbpadNormalize')) return;
            this.notifyEditorValueChanged(this.getValue());
        });

        this.editor.on('selectionUpdate', () => {
            this.onCaretChange();
        });

        this.editor.on('transaction', ({ transaction }) => {
            this.isComposing = transaction.meta?.isComposing || this.isComposing;
            // /file 挂起位置的随事务重映射（上传期间用户继续编辑）。
            if (transaction?.docChanged) this.fileCommand?.handleTransaction(transaction);
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
        // 空标记行归一化（见函数注释）：空列表项的歧义形态在重新解析时会被
        // setext 吞掉父行，出口补空行让「打字时 == 刷新后」在空条目上也成立。
        return normalizeAmbiguousEmptyListMarkers(this.fenceToFrontmatter(this.editor.storage.markdown.getMarkdown()));
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
        this._exemptDecorationMarksFromCode();
        const nextValue = String(value ?? '');
        this._lastValue = nextValue;
        // 载入事务必须排除出撤销历史。编辑器以 content:'' 创建，正文是靠 setContent
        // 灌进来的，而它默认进历史——于是「打开文章」自己成了栈底那一步：Ctrl+Z 撤掉的
        // 就是载入，整篇瞬间变空白（boot textarea 交接、WS 远端更新、源码模式切回都走
        // 这条路，所以一打开文章按 Ctrl+Z 就中招）。更糟的是撤销能跨文章：在 A 文里
        // 撤出 B 文的内容，autosave 会把 A 文覆盖掉。
        this.editor.chain().setMeta('addToHistory', false)
            .setContent(this.frontmatterToFence(nextValue), { emitUpdate: false }).run();
        this.normalizeDecorationMarks();
        if (emit) {
            this.notifyEditorValueChanged(this.getValue());
        } else {
            this._lastValue = nextValue;
        }
    }

    _exemptDecorationMarksFromCode() {
        const codeType = this.editor?.state?.schema?.marks?.code;
        const exemptNames = ['annotation', 'draw', 'mdHighlight'];
        if (codeType && Array.isArray(codeType.excluded)) {
            codeType.excluded = codeType.excluded.filter(
                type => !exemptNames.includes(type.name));
        }
    }

    // 存储层无法表达「标记覆盖行内代码」：序列化器的 open/close 包不住 code_inline
    // （markdown-it 的 code_inline 是原子 token），豁免之前落盘的历史内容因此固化成
    // 「标记-代码-标记」两段（批注还是两个徽标）。excluded 豁免（见 create 钩子）之后
    // 新操作不再被切开，这里把**已经存成拆段形态**的旧内容用 addMark 连回一个整体：
    // 渲染恢复单 span 单徽标、线连续，取消一次就清干净。
    //
    // 身份：批注用 note 区分不是同一条；画线 / 高亮没有属性，同类型即同一条。
    // 防误伤（比批注原先的「gap 无裸文本就连接」更紧）：**两段之间的 gap 必须每个
    // 节点都带 code mark** 才连接。加了豁免之后，行内代码是唯一还能把一次操作切成
    // 两段的来源；gap 里出现任何不带 code 的文字（裸文本、或用户刻意跳过的加粗 /
    // 链接）就说明那是两次独立操作，不许合并。gap 里出现同类型的另一条标记也立刻停。
    // 已知代价：同段内「先画 甲、再单独画 丙、中间恰好只有一段行内代码」这种极少见
    // 手会被当成一次操作合并（存储里没有操作身份，无从区分），已由回归钉住该判定。
    // 连接后的文档序列化就是一条（旧文章下次保存自然收敛），
    // normalize→serialize→parse 幂等（实测）。
    // 修复事务带 dumbpadNormalize meta：不进撤销历史、不触发保存。
    normalizeDecorationMarks() {
        const { state } = this.editor;
        const { marks } = state.schema;
        const codeType = marks.code;
        if (!codeType) return;
        // Fast path：连接只发生在「gap 全是行内代码」的两段之间，文档里没有
        // 行内代码就不可能有可连对象，直接返回（长文冷载入省掉下面的逐段建
        // 数组 + 三组扫描）。注意不能用源码字符串预检：豁免之前落盘的旧拆段
        // 是裸 HTML（<code> 无反引号），code mark 只存在于解析后的文档里。
        let hasInlineCode = false;
        state.doc.descendants((node) => {
            if (node.isText && codeType.isInSet(node.marks)) {
                hasInlineCode = true;
                return false;
            }
            return true;
        });
        if (!hasInlineCode) return;
        // identity(node)：null = 该节点不属于这一组；字符串 = 属于，且用它区分「是不是同一条」
        const groups = [
            marks.annotation && {
                identity: (node) => {
                    const mark = marks.annotation.isInSet(node.marks);
                    return mark ? String(mark.attrs.note ?? '') : null;
                },
                restore: (key) => marks.annotation.create({ note: key }),
            },
            marks.draw && {
                identity: (node) => (marks.draw.isInSet(node.marks) ? '' : null),
                restore: () => marks.draw.create(),
            },
            marks.mdHighlight && {
                identity: (node) => (marks.mdHighlight.isInSet(node.marks) ? '' : null),
                restore: () => marks.mdHighlight.create(),
            },
        ].filter(Boolean);
        if (!groups.length) return;
        const { tr } = state;
        let changed = false;
        state.doc.descendants((block, blockPos) => {
            if (!block.isTextblock) return true;
            const children = [];
            let childPos = blockPos + 1;
            block.forEach(child => {
                children.push({ node: child, from: childPos });
                childPos += child.nodeSize;
            });
            for (const group of groups) {
                let i = 0;
                while (i < children.length) {
                    const key = group.identity(children[i].node);
                    if (key === null) { i += 1; continue; }
                    let j = i + 1;
                    while (j < children.length && group.identity(children[j].node) === key) j += 1;
                    // 从 j 向后找下一个同一条的段；gap 里只要有一个节点不带 code 就不连
                    let k = j, target = null, gapIsAllCode = true;
                    while (k < children.length) {
                        const nodeKey = group.identity(children[k].node);
                        if (nodeKey !== null) {
                            if (nodeKey === key) target = k;
                            break;
                        }
                        if (!codeType.isInSet(children[k].node.marks)) gapIsAllCode = false;
                        k += 1;
                    }
                    if (target !== null && gapIsAllCode) {
                        tr.addMark(children[j].from, children[target].from, group.restore(key));
                        changed = true;
                        i = target;
                    } else {
                        i = j;
                    }
                }
            }
            return false;
        });
        if (!changed) return;
        tr.setMeta('dumbpadNormalize', true);
        tr.setMeta('addToHistory', false);
        this.editor.view.dispatch(tr);
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
        // 可编辑状态变了但不会产事务：让 mermaid 的 NodeView 重新判定该显示源码还是图。
        this.notifyMermaidModeChange();
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
        this.container.classList.toggle('is-source-mode', this.sourceMode);
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
                // 源码模式下的 /file 命令（与旧 handleSourceFileCommand 对齐）。
                textarea.addEventListener('keydown', (event) => {
                    this.fileCommand?.handleSourceKeydown(event);
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
        const next = ids.join('\u0001');
        if (next === this._lastHeadingAnchorIds) return;
        // ready 之前只排队、**不写幂等守卫**：守卫先写上的话，后续（create
        // 之后才跑的）updateToC 的 sync 会被它挡住不再派发，标题 id 迟迟落不进
        // DOM，目录的标记扫描整段落空（warm 启动路径下 selectNotepad 的 rAF
        // 跑在 create 之前，是稳定复现入口）。排队去重防每帧重复排队。
        if (!this.ready) {
            if (this._headingAnchorQueued) return;
            this._headingAnchorQueued = true;
            this.whenReady().then(() => {
                this._headingAnchorQueued = false;
                this._lastHeadingAnchorIds = null;
                this.syncRenderedHeadingIds(toc);
            }).catch(() => {});
            return;
        }
        this._lastHeadingAnchorIds = next;
        this.editor.view.dispatch(this.editor.state.tr.setMeta(headingAnchorPluginKey, ids));
    }

    scrollToHeadingId(id, { flash = false } = {}) {
        if (!id) return false;
        const heading = this.container.querySelector(`.tiptap h1[id="${CSS.escape(id)}"], .tiptap h2[id="${CSS.escape(id)}"], .tiptap h3[id="${CSS.escape(id)}"], .tiptap h4[id="${CSS.escape(id)}"], .tiptap h5[id="${CSS.escape(id)}"], .tiptap h6[id="${CSS.escape(id)}"]`);
        if (!heading) return false;
        this.scrollRenderedElementIntoView(heading, { flash });
        return true;
    }

    scrollToLine(index, keyword, { flash = false } = {}) {
        const line = Math.max(0, Number(index) || 0);
        let anchorId = null;
        for (const [slug, line] of this.headingLineBySlug.entries()) {
            if (line <= index) anchorId = slug;
        }
        if (anchorId && this.scrollToHeadingId(anchorId, { flash })) {
            if (keyword) this.jumpToKeyword(keyword);
            return true;
        }
        return false;
    }

    scrollRenderedElementIntoView(target, { flash = false } = {}) {
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
        if (flash) this.flashJumpTarget(target);
    }

    // 落点闪光以 PM Decoration（JumpTargetHighlight 扩展）渲染。不能像旧编辑器
    // 那样给目标元素加 is-jump-target 类：编辑模式下那是写进 PM 管辖 DOM 的
    // 外来属性，DOMObserver 会在重绘时抹掉（实测从未露面）。
    flashJumpTarget(target) {
        const view = this.editor?.view;
        if (!view || !target || !target.isConnected) return;
        try {
            const from = view.posAtDOM(target, 0);
            view.dispatch(view.state.tr.setMeta(jumpTargetPluginKey, { from }));
            clearTimeout(this.jumpTargetClearTimer);
            this.jumpTargetClearTimer = setTimeout(() => {
                const currentView = this.editor?.view;
                if (currentView) currentView.dispatch(currentView.state.tr.setMeta(jumpTargetPluginKey, null));
            }, 2200);
        } catch (_error) {
            // 目标不在视图内（如源码模式）：只滚动，不闪光。
        }
    }

    getScrollContainer() {
        const wysiwyg = this.scroller || this.container.querySelector('.vditor-wysiwyg');
        if (wysiwyg && wysiwyg.scrollHeight - wysiwyg.clientHeight > 1) return wysiwyg;
        return document.scrollingElement || document.documentElement;
    }

    // Jump to a precise hit in the rendered document. `keywords` is an array
    // (multi-keyword search) or a single string; `hitIndex` is the global
    // occurrence index across ALL keywords in document order — the server
    // (server/search/matcher.js) counts source hits with the same semantics,
    // so rendered plain text aligns with the search result rows.
    // Jump to a precise hit in the rendered document. `keywords` is an array
    // (multi-keyword search) or a single string; `hitIndex` is the global
    // occurrence index across ALL keywords in document order — the server
    // (server/search/matcher.js) counts source hits with the same semantics,
    // so rendered plain text aligns with the search result rows. On success
    // the word and its enclosing block are highlighted through PM decorations
    // (SearchHitHighlight extension), which survive the editor's node rebuilds.
    jumpToKeyword(keywords, hitIndex = 0) {
        const list = (Array.isArray(keywords) ? keywords : [keywords])
            .map(keyword => String(keyword || '').trim().toLowerCase())
            .filter(Boolean);
        if (list.length === 0) return false;
        const root = this.container.querySelector('.tiptap');
        if (!root) return false;
        const targetIndex = Math.max(0, Number(hitIndex) || 0);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        let globalIndex = 0;
        let lastHit = null;
        // 落地：把命中位置交给 SearchHitHighlight 扩展（PM Decoration）。
        // 词级 + 命中所在块的高亮都由 PM 在重绘时自行维护——这个编辑器的
        // 块节点会被周期性重建，任何注入 DOM 的高亮（span 或类名）都活不
        // 过一轮重绘，Decoration 是唯一能存活的形态。4.2s 后发 clear meta
        // 摘除；期间的 docChanged 事务经 mapping 跟随内容。
        const landHit = (textNode, at, length) => {
            const anchor = textNode.parentElement;
            const view = this.editor?.view;
            if (view && anchor && root.contains(anchor)) {
                try {
                    const from = view.posAtDOM(textNode, at);
                    view.dispatch(view.state.tr.setMeta(searchHitPluginKey, { from, to: from + length }));
                    clearTimeout(this.searchHitClearTimer);
                    this.searchHitClearTimer = setTimeout(() => {
                        const currentView = this.editor?.view;
                        if (currentView) currentView.dispatch(currentView.state.tr.setMeta(searchHitPluginKey, null));
                    }, 4200);
                } catch (_error) {
                    // posAtDOM 失败（节点不在视图内）：退化为仅滚动。
                }
            }
            const blockEl = anchor ? anchor.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th') : null;
            // 与旧实现一致：滚动统一走 scrollRenderedElementIntoView
            // （scrollIntoView 会被同一点击流程内的其他滚动取消）。
            const scrollEl = blockEl || anchor;
            if (scrollEl) this.scrollRenderedElementIntoView(scrollEl);
        };
        while (node) {
            const value = node.nodeValue || '';
            const lower = value.toLowerCase();
            const hits = [];
            for (const keyword of list) {
                let at = lower.indexOf(keyword);
                while (at >= 0) {
                    hits.push([at, keyword.length]);
                    at = lower.indexOf(keyword, at + Math.max(keyword.length, 1));
                }
            }
            hits.sort((left, right) => left[0] - right[0]);
            for (const [at, length] of hits) {
                // Leftover marks from a previous (not yet expired) jump must
                // not shift the occurrence counting against server-side hits.
                if (node.parentElement?.closest?.('.search-hit-inline, .article-search-hit')) break;
                if (globalIndex === targetIndex) {
                    landHit(node, at, length);
                    return true;
                }
                lastHit = { node, at, length };
                globalIndex += 1;
            }
            node = walker.nextNode();
        }
        // Hit index beyond the rendered hits falls back to the closest one so
        // the jump still lands somewhere useful instead of nowhere.
        if (lastHit) {
            landHit(lastHit.node, lastHit.at, lastHit.length);
            return true;
        }
        return false;
    }

    /* ---------------- 资产 ---------------- */

    setAssetMaxFileBytes(value) {
        this.assetMaxFileBytes = value;
        // /file 控制器可能已创建 AssetApiClient：同步限额。
        this.assetApi?.setMaxFileBytes?.(value);
    }

    insertArticleAssetReference(asset) {
        if (!asset) return false;
        const url = String(asset.url || '');
        if (!url) return false;
        const isImage = asset.kind === 'image' || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(url);
        const label = String(asset.name || asset.filename || (isImage ? 'image' : url));
        // 与 /file 插图保持一致：默认给一个小尺寸，避免新图一进来就占满纸面。
        const markdown = isImage
            ? `![${label}](${url} "dumbpad-width=${DEFAULT_ARTICLE_IMAGE_WIDTH}")`
            : `[${label}](${url})`;
        this.editor.commands.insertContentAt(this.editor.state.selection.from, markdown);
        this.notifyEditorValueChanged(this.getValue());
        return true;
    }

    /* Mermaid 图表由代码块 NodeView 负责渲染与显隐（managers/tiptap-code-block-view.js）。
     * 可编辑状态的变化不产事务，所以切换阅读模式后必须显式通知一次，让 NodeView
     * 重新判定「光标是否还在块内」——否则带着光标进阅读模式会停在源码视图。 */
    notifyMermaidModeChange() {
        // 构造器必须取自 document 所属的那个 window：只把 global.window 挂上、没挂
        // global.CustomEvent 的 jsdom 宿主里，裸 `new CustomEvent()` 会解析到 Node 自带的
        // 实现，jsdom 的 dispatchEvent 直接拒收（"parameter 1 is not of type 'Event'"）。
        const CustomEventCtor = (globalThis.window || globalThis).CustomEvent;
        document.dispatchEvent(new CustomEventCtor('dumbpad-mermaid-refresh'));
    }
}
