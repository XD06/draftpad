# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 规范，版本号对应 `package.json` 的 `version`。

> **关于早期版本**：仓库在 `1.0.9` 之前没有打过 git tag，也无法从历史中还原各版本的发布时点。因此 `1.0.9` 之前的变更按**提交里程碑 + 日期**记录，不虚构版本号。以提交信息为准，日期为提交时间（UTC+8）。

## [未发布]

`package.json` 仍为 `1.0.9`，以下变更尚未发版（最新提交 2026-08-23）。

### 新增

- **文章记录水印**：文章卡片正下方以淡灰小字显示创建时间、最近更新时间与修改次数（`version - 1`）。水印是 `.editor-main` 上的独立覆盖层，通过滚动/ResizeObserver 跟随卡底（间距恒定 14px），未滚到文末时被 `overflow:hidden` 自然裁剪；不进入 Vditor 滚动容器与正文序列化，不影响打字、软回车、滚动稳定与 boot 交棒，打印时隐藏。新增 `public/managers/article-meta-footer.js`，`app.js` 仅在选文/保存/远端更新等路径追加只读调用，未修改任何现有函数逻辑。
- **子任务滑动删除**：Thought 卡片内每条子任务行支持右滑删除（触屏/触控笔，越过半行宽时出现垃圾桶提示并震动，松开即删除并同步；legacy 文本解析出的子任务仍走双击编辑）。此前删除子任务需要双击进入行内编辑、清空文本后回车。整卡右滑删除此前已存在，保持确认弹窗不变。
- **文章内目录（文章目录面板）**：PC 右侧栏从「最近编辑」改为当前文章的标题目录（文章内目录），编辑与阅读模式都可用；每条目带 H1–H6 级别徽标（对应编辑器内的标题标记）、按级别缩进（H2 低于 H1 一级）与加粗分层；各标题区段内的加粗/划线/高亮/批注片段作为子条目列出（带类型徽标，点击直接跳到该片段），有序/无序列表和待办不进目录。滚动时高亮当前标题、点击跳转；移动端由悬浮「目录」按钮打开同一目录的抽屉。左侧栏顶部以「目录 / 最近」图标标签切换两个子页面（PC 与移动端一致，不再上下分栏），侧栏与目录面板的汉字标题替换为图标；「最近」列表字号与「目录」列表统一。
- **移动端悬浮按钮组收缩**：新增「更多」按钮，默认只保留目录、智能滚动与更多按钮，其余（复制、今日草稿、快速记录、Thoughts）点击展开；展开为临时状态，点击文章其他区域或刷新后自动收起。
- **Thought 轻量搜索 API**：新增 `GET /api/thoughts/search`，基于 thoughts 索引（含全文语料）过滤，只为命中项读取完整对象；手动关联搜索改走该接口，S3 后端不再每次按键全量读取。索引缺字段时自动回退全量读取保证结果完整。
- **文章链接高亮可点击**：编辑器内的链接（Lute 渲染的裸 URL 与 `[text](url)`）有统一的高亮样式；裸 URL 点击直接打开，阅读模式全部链接可点击。
- **API（面向 Agent 的细粒度编辑）**：新增受保护的笔记局部编辑能力，支持按段落结构定位的 section 编辑，以及原子批量编辑（一次请求内多步修改要么全部生效要么全部回滚）。配合新增的 notepad 元数据接口、能力发现与资产发现接口，Agent 不必再全量覆盖长文。
- **资产去重与复用**：上传按内容哈希去重；文章中可直接引用已存在的资产而无需重复上传。
- **Tiptap 编辑器选区浮动菜单**：选中文字段落、**释放鼠标后**出现「画线 / 高亮 / 批注 / 复制」浮动菜单（旧 Vditor 编辑器的能力，Tiptap 迁移后恢复）。实现为编辑器扩展 `TiptapSelectionMenu`（`public/managers/tiptap-selection-menu.js`）：ProseMirror 插件 view 负责菜单 DOM 生命周期，拖拽选字期间不显示（mousedown 进入拖拽态、mouseup 宏任务后主动补一次显示判断，等价旧实现的 mouseup → handleSelectionChange），按 `coordsAtPos` 定位（复用既有 `.selection-menu.typora-selection-menu` 样式，移动端仍为选中下方、桌面为选中上方）；**动作全部走框架 mark 命令**（`DrawMark` / `MdHighlight` / `AnnotationMark`），不再回到 Markdown 源码做字符串查找 + `setValue` 全量重刷（旧实现的字符串手术路线随 Vditor 一起退役）——事务进撤销历史（可 Undo）、自然触发保存、序列化与旧编辑器逐字节对齐；落标记/复制后光标折叠到标记起点，退出选中状态。**点击已标记文字弹「取消」popover**（取消画线 / 取消高亮，批注为编辑+取消，对应旧 mark-popover / removeInlineMark）：取消与编辑走框架 `removeMark` / mark attrs 更新，同样可撤销；popover 定位在标记元素上方，点击其他处收起。代码块/内联代码/时间标记选区不显示菜单（mark 禁区，对应旧受保护内容）；源码模式不显示（`setSourceMode` 现在同步切换容器 `is-source-mode` 类，与阅读模式同构）；批注输入框带 Enter 提交 / Escape 取消，输入期间焦点不会被编辑器抢走。回归：`npm run test:tiptap-selection-menu`（已加入 `npm test`）。
- **文章图片/附件交互层（Tiptap）**：把 Vditor 时期迁移时丢失的图片交互补回框架内。编辑模式点图片弹尺寸菜单（窄 360 / 中 720 / 宽 1080 / 自适应）与下载原图、查看大图、删除图片；阅读模式点图片开 lightbox（带下载原图）；附件链接点按弹下载 / 删除附件菜单；图片支持指针拖拽换位（鼠标与触屏同一套指针流程，含落点提示线）。**宽度与类名以 PM 节点 Decoration 渲染**（`Decoration.node` 的 attrs 合并到 `<img>` 上）：`title="dumbpad-width=N"` ↔ `style.width`，自适应清空 title——`/file` 命令写入的默认宽度（现为 360）从此真正生效（此前 Tiptap 路径没有任何代码读取它）。尺寸 / 删除 / 换位全部走框架命令（`setNodeMarkup` / `delete` / `delete`+`insert` 单事务），进撤销历史并自然触发保存，存储形态不变（仍是 `![alt](url "dumbpad-width=N")`），图片菜单与 lightbox 复用既有 `.article-image-size-menu` / `.article-image-lightbox` / `.article-file-menu` / `.dumbpad-article-image` 样式（附件 chip 见下方「变更」）。附件链接的类由 link mark 的全局属性条件渲染（`Decoration.inline` 只会把 class 落在内层 `<span>`，命不中既有 CSS）。新增 `public/managers/tiptap-image-interactions.js` 与 `npm run test:tiptap-image-menu`（已加入 `npm test`）。
- **悬浮功能按钮可配置隐藏 + 反思占位**：新增 `DUMBPAD_HIDDEN_FLOATING_ACTIONS`（按钮 id 黑名单，逗号分隔）→ `config/index.js` 解析 → `GET /api/config` 的 `hiddenFloatingActions` → 新增的 `public/managers/floating-actions-config.js` 把它落到 DOM：只切按钮的 `hidden` 属性，不删节点、不解绑事件，所以从配置里去掉 id 功能立刻回来，无需改代码。`fab-toggle-group`（移动端「更多」）与 `scroll-helper` 属界面外壳必需，出现在配置里会被忽略并在控制台回报原因（`protected` / `unknown` / `missing-in-dom`）；显式置空表示什么都不隐藏；未设置时用默认名单（当前是 `clipboard-import-trigger`，见「变更」）。同步新增「反思」占位按钮（`#toggle-reflections`，对话气泡问号图标）：暂无页面，点击提示「反思功能开发中」，标记里的初始 `hidden` 与默认名单保持一致，以免配置到达前闪现或缺失。`styles.css` 补 `.floating-btn[hidden] { display: none !important; }`（`.floating-btn` 自身是 `display: flex`，否则 `hidden` 属性无效）；新模块已加入 service worker `CORE_ASSETS`。回归：`npm run test:floating-actions-config`（已加入 `npm test`）与 `test:auth-routes` 中新增的 `/api/config` 断言。
- **批注气泡徽标 + 点徽标看批注内容（Tiptap）**：补回 Vditor 时期有、迁移时丢掉的批注显示层。`AnnotationMark.renderHTML` 现在渲染成 `<span class="has-annotation" data-note data-comment><span style="…wavy…">文字</span><span class="annotation-badge"><svg…></span></span>`——内层 span 承载波浪线并持有内容洞，徽标作为它的兄弟节点（**ProseMirror 规定内容洞必须是父节点唯一的子节点**，所以徽标不能与洞平级挂在 `.has-annotation` 上，必须多包一层；这一层也正是旧 Vditor 的 DOM 形态，因此既有 `.annotation-badge{position:absolute}` 与 `.has-annotation{position:relative}` 规则原生命中，无需新增 CSS）。徽标是**纯显示元素**：Markdown 序列化走 `addStorage.markdown.serialize`，不经过 `renderHTML`，实测（含 HTML 粘贴 / `insertContent` 路径、打字、撤销、多条批注）都不会漏进正文；复制全文另有 `app.js` 的 `.annotation-badge` 兜底清理。**点徽标 = 只读查看批注内容**（复用旧 `.comment-only-popover` / `.mark-popover-inline-content` 样式：气泡图标 + 批注正文，无动作按钮），**点正文仍是「编辑 / 取消」**，两条路径靠 `closest('.annotation-badge')` 分流。只读卡必须活过编辑器 blur（徽标本身在 `contenteditable` 内部，点它必然伴随 blur），因此 `handleBlur` 只在非只读态收起菜单，收起统一交给 document 上的 mousedown——与旧实现一致。回归：`test:tiptap-selection-menu` 新增 17/18 两组断言（徽标存在与形态、不进 markdown、点徽标弹只读卡、活过 blur、点外部关闭、点正文仍是编辑/取消、多条批注各自一个徽标）。

- **软换行之后的「视觉行首」实时按块渲染（`SoftBreakBlockRules`）**：Typora 式体验——在**任意一行**的开头打 `# `（`##`…`######`）、`- `/`* `/`+ `、`1. `/`3. `、`> `，编辑器**当场**把它变成标题 / 列表 / 引用，不再要刷新一次才生效（用户报的「为什么行首输入 `#` 要刷新才渲染，Typora 任何行都实时渲染」）。**存储与回车语义都不变**：磁盘格式本来就是对的（`breaks: true` 下 `甲\n# 乙` 重新解析就是 `paragraph` + `heading`，不要求空行，老文章不需要迁移），修的只是编辑器在打字那一刻把软换行当成段内换行、不当成行首。实现（`public/managers/tiptap-extensions.js`）：官方块级输入规则全部 `^` 锚定（只认 PM 块首，一个段落只有一个），而且它们的 handler 作用范围是**整个块**（`textblockTypeInputRule` 直接 `setBlockType(块范围)`、`wrappingInputRule` 直接 `findWrapping(块范围)`）——只放宽锚定去复用官方规则会把上一视觉行一起吞进块类型，那是错的。所以新增扩展 `SoftBreakBlockRules` 自带四条**以 `\n` 开头**的 find（前提是 `MdSoftBreak` 声明了 `leafText: () => '\n'`，见「修复」里的对应条目），命中后自己拆块：`deleteRange(软换行 → 光标)` 一次吃掉「换行 + 缩进 + 标记」→ `splitBlock()` → 只对拆出来的后半块跑框架命令 `setNode('heading', {level})` / `toggleBulletList()` / `toggleOrderedList()`（再 `updateAttributes('orderedList', {start})` 保住 `3.` 的起始号）/ `toggleBlockquote()`。单个事务（撤销历史里是一步，不会留下「标记删了但没拆块」的半截状态）、走 input rule 的 undoable 元数据、自然触发保存。门槛与 `SoftEnterShortcut` 造软换行的条件一致：只有 `doc > paragraph`，且拆块点必须真是 `hardBreak` 节点（文本节点里的裸 `\n` 不算，实测不会误拆）；**非空选区直接放行给普通输入**——runner 的匹配串只取到选区**起点**，所以「选区在标记右侧」恰好是够得着这条规则的形状，没有这条守卫时 `deleteRange` 会连用户选中的文字一起吃掉、再拆出一个空标题（变异验证：删掉守卫，回归 §14 必红）；换行与标记之间只允许空格/制表符（`[ \t]`，不是 `\s`），所以连按两次 Enter 造出的空行会被拆块点一并吞掉，不在上一块尾部留游离 `<br>`。与列表内的 `[ ]` 规则天然接力：软换行 → `- ` → `[ ] ` 直接得到任务项。不在本次范围：`---` 分隔线、``` 围栏、表格等整块语法。回归：新增 `npm run test:tiptap-soft-enter-block-rules`（jsdom 51 项，自动纳入 `npm test`）与 `npm run test:editor-input-browser` 的真实按键四组（块结构 / level 与 start / 无残留换行 / 源文本，并断言「打字结果与同一份源重新解析逐项相等」）加行中标记的反向用例。

- **Mermaid 图表在编辑器里真的渲染出来（Typora 式编辑态实时预览）**：此前 ` ```mermaid ` 从来没画成图过，而且不报错——旧的 `renderMermaidDiagrams()` 挂在 `.tiptap pre code.language-mermaid` 上，而代码块 NodeView 渲染出的 `<code>` 只有 `hljs` 类，语言只存在 `node.attrs.language` 与徽章的 `data-language-label` 里，选择器实测命中 0 个节点。现在渲染收进代码块 NodeView 自己管：新增 `public/managers/mermaid-render.js`（bundle 只在文章真出现 mermaid 时才注入、按 `data-theme` 初始化、清掉 mermaid 塞进 `<body>` 的临时测量节点、只返回 svg 字符串）；`tiptap-code-block-view.js` 里维护一个状态机——渲染容器是 wrapper 的**兄弟节点**（绝不写进 `contentDOM`，否则 PM 会丢掉代码文本），光标在块内 = `is-mermaid-editing` 露源码，离开块 = `is-mermaid-preview` 看图，220ms 防抖，`data-theme` 由 MutationObserver 触发重画。三个容易漏的触发点：`setEditable()`（阅读模式）不派事务，靠 `dumbpad-mermaid-refresh` 文档事件补；整块 NodeSelection 时 `selectNode`/`deselectNode` 必须显式切态；**判定「光标在不在块内」还要看 `editor.isFocused`**——PM 的初始光标正好落在首块的第一个内容位，只看选区范围的话，「打开一篇以 mermaid 开头的文章」会永久停在源码态。语法错误时 mermaid v11 直接 reject，处理是保留源码 + 一行提示，绝不吞内容；存储里永远只有 ` ```mermaid ` 源码。回归：新增 `npm run test:mermaid-preview-browser`（真 Chrome 七组：空闲出图 / 进块回源码 / 改完离开重画并出现新节点标签 / 主题切换 fill 真的变了 / 坏语法保留源码 + 提示可见 / 阅读模式出图 / 普通 js 代码块一个 mermaid 类都不许出现 + 落盘文本永不含 `<svg`）。踩坑记录：`commands.insertContent('\nB-->C…')` 会按 HTML 解析字符串，把 `>` 变成 `&gt;`，测「改源码后重画」必须走 `tr.insertText`，否则是脚手架的假故障。
### 变更

- **引用块视觉：一条细竖线 + 浅一档的正体字**：编辑器里的 `>` 不再是「主色左边框 + 斜体」（中文斜体是浏览器合成的伪斜体，观感很差），改成 3px 圆角浅灰竖线 + 比正文浅一档的正体字，宽窄屏同一套形态（先前试过的实心灰卡片按用户要求撤掉）。竖线由 `blockquote::before` 画——伪元素不进 DOM，PM 的解析与存储完全不受影响，同时还能带圆角、上下各缩 `0.15em`，比 `border-left` 更接近设计稿；窄屏 `padding-left: 22px`、≥981px `26px`。块内最后一个子块的 `margin-bottom` 必须归零，否则单行引用在文字下面多出一整条空隙（看起来又是一个空行）；桌面端 `.vditor-reset p { margin-bottom: 14px }` 优先级更高，所以 `ios-theme.css` 里同段还要再压一次。回归：新增 `npm run test:blockquote-style-browser`（真 Chrome 取 computed style，宽窄两轮 × 单行 / 老数据双行，含「引用文字亮度确实高于正文」与「文字下方悬空恰好 0px」两条量化断言）。
- **悬浮按钮默认名单改为收起「快速记录（剪贴板）」、显示「反思」**：`DUMBPAD_HIDDEN_FLOATING_ACTIONS` 未设置时的默认值从 `toggle-reflections` 换成 `clipboard-import-trigger`（用户要求）。机制不变——仍是黑名单、仍只切 `hidden`、显式置空仍表示什么都不隐藏；`index.html` 里两个按钮的初始 `hidden` 同步翻转，保证 `/api/config` 到达前那一帧既不闪也不缺。注意反思按钮现在默认可见，但它仍是占位实现：点击只提示「反思功能开发中」，页面尚未做。回归：`npm run test:floating-actions-config`（默认值与「标记初始态 == 默认配置效果」由同一条推导断言钉住）与 `npm run test:floating-actions-config-browser`（默认态 / 显式值覆盖默认 / 移动端折叠三组）。

- **图片默认插入宽度改为 360（窄档）**：`/file` 插图与「设置 → 附件」的插入都改用共享常量 `DEFAULT_ARTICLE_IMAGE_WIDTH = 360`（旧默认 720 在窄屏上几乎占满纸面）；插入后仍可用图片尺寸菜单改成中 / 宽 / 自适应。
- **附件 chip 样式重做**：附件链接换成与 Thoughts 附件卡同一套视觉语言（10px 圆角、细描边、悬停主色高亮、轻微上浮），图标由 `a.dumbpad-article-file::before` 的线稿文件 SVG（mask 着色，明暗主题分别取 `--muted-text` / `--primary-color`）提供，不再依赖 label 里的 emoji。附件 label 同步去掉 `📎` 前缀，旧 label 由解析期归一化（`stripLegacyFileLabelEmoji`）在载入时去掉该前缀——避免「主题图标 + 📎」双图标；改动过的旧文章会在下次保存时把 label 里的 `📎` 移除（文件名与大小信息不变）。
- **Thoughts 悬浮按钮图标改为填充图形**：`#toggle-thoughts` 由 24×24 描边灯泡换成 1024×1024 填充羽毛笔 + 双星芒（`fill="currentColor"`，跟随按钮文字色，明暗主题自适应）。激活态仍由 `#toggle-thoughts.active` 的 `color`/背景区分（`thoughts.css` 里 `stroke-width: 2.5` 那条对填充图形不起作用，保留无副作用）。文章侧栏「文章 Thoughts」按钮与面板标题图标未改。

### 修复

- **引用块里回车拆段、退格「退出引用区」并留下空行 / 空引用**：`>` 内的回车走的是 PM 默认 `splitBlock`，把一段拆成两段，落盘变成 `> 甲` + 一行只有 `>` 的 `> 乙`——重新解析就在两行之间渲染出一个幽灵空行（用户报的「引用里回车会多出一个空行」）；反方向按退格时，`joinBackward` 取的切点越过 `blockquote` 这一层，把整行**抬出**引用区而不是并回上一行，留下一个空引用块（用户报的「退格应该回到上一行，实际却退出了区域」）。修复分三条：① `softBreakScope()` 把软换行的适用范围从 `doc > paragraph` 扩到 `blockquote > paragraph`，引用块内回车与普通段落一致——段内 `<br>`，存成 `> 甲\n> 乙`，中间无空行；② 空视觉行上回车走 `exitBlockquoteLine()` 离开引用块，并**删掉刚插入的那个 `<br>`**（不删就会序列化成 `> 甲\n> `，下次解析又是空行）；③ 新增 `QuoteBackspaceShortcut`（`priority: 1000`，必须早于 PM 基础键位，否则默认行为先把它抬走）→ `joinQuoteParagraph()` 同一引用块内显式并段；单段引用且上一块是同类型文本块时，用「合并后的整块 `replaceWith`」把上一行与引用行合成一块——PM 的 `delete` 会把「只删包装标记」的区间规范化成无操作，所以 delete+join 那条路走不通（实测事务无变化并报 `Inconsistent open depths`）。老数据不需要迁移：打开后按一次退格即自愈。回归：新增 `npm run test:tiptap-blockquote-input`（jsdom 19 项，自动纳入 `npm test`），覆盖软换行 / 退出 / 退出后继续输入 / 老数据自愈 / 文档首块退格 / 往返稳定，并反向钉住「列表项与标题的回车仍然拆块」（防范围扩过头）。
- **编辑器内容区样式整片崩坏（`styles.css` 一条规则丢了收尾大括号）**：给引用块加样式的一次行编辑把 `.typora-editor-shell .vditor-reset blockquote > :last-child { margin-bottom: 0;` 的 `}` 吃掉了。CSS 解析器对未闭合规则的处理是**一路吞到下一个 `}`**，于是那条之后的所有规则（内联代码高亮、搜索命中、图片、代码块头部……）同时失效，表现就是「内容区裸渲染、样式被打乱」，而 console 里一条 JS 报错都没有——看日志永远查不出来。上一轮同类事故（`editorProps` 的 `attributes: { class: 'tiptap ProseMirror vditor-reset' }` 被误删，100+ 条挂在 `.vditor-reset` 上的规则集体失效）也是同一个形状：**改 CSS / 编辑器骨架的字符串与括号，diff 里看不见破坏，运行时也没有异常**。除了补回 `}`，新增常驻守卫 `npm run test:css-integrity`（jsdom + 纯文本扫描，自动纳入 `npm test`）：每个 `public/Assets/*.css` 的 `{`/`}` 必须配平（先剥注释与字符串，`content: '{'` 不算结构）、引用块那几条规则必须还在、编辑器内容根必须真的带上 `tiptap ProseMirror vditor-reset` 三个类。`npm run check` 只做 `node --check`，不校验 CSS，所以这条守卫是唯一的自动闸门。
- **批注 / 划线刷新后多出一条直线下划线，并把 `<u>` 写回正文**：根因不在我们的样式，而在 Tiptap 上游 `Underline` 的解析判定 `value.includes('underline')`。ProseMirror 的 style 规则是**按规则名去查内联样式**（`getPropertyValue('text-decoration')`），浏览器会把长属性折回简写：实测 Chrome 对批注的 `text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px` 返回 `underline 2.5px wavy rgb(231, 76, 60)`，对划线的 `underline blue` 返回 `underline 2px blue`——都含 `underline`，于是批注 / 划线被额外套上 underline mark，波浪线上面多压一条直线，并且下一次保存把 `<u>` 落进正文（存进去是 `<span data-note=…>`，刷新再保存变成 `<u><span data-note=…></u>`）。实测只写长属性（`text-decoration-line: underline`）时 `getPropertyValue('text-decoration')` 返回空串，所以换成长属性确实躲得开——但那要改批注 / 划线的存储形态，而且救不了已经被污染成 `<u>` 的老文章，因此在 schema 层收窄：新增 `DumbPadUnderline`（`public/managers/tiptap-extensions.js`，配 `StarterKit.configure({ underline: false })` 关掉原版，renderHTML / 命令 / Mod+U / markdown 位全部继承上游），① style 规则只接受「纯 underline」——带颜色 / 粗细 / wavy / dashed / dotted 一律不算，`solid` 是初始值允许显式写；② tag 规则识别并跳过**本 bug 留在老文章里的 `<u>`**（该 `<u>` 自己没有正文文字，内容全是批注 / 划线 span），因此不需要迁移数据：打开后不再解析出 underline，下次保存 `<u>` 自然消失。反向保护同时固化：真 `<u>`、`text-decoration:underline`、`underline solid` 仍照常是下划线，`<u>` 里混着批注时正文的下划线一段都不丢。已知取舍：外部粘贴来的 `underline red` / `underline double` 这类带颜色或线型的装饰不再算下划线。回归：新增 `npm run test:tiptap-underline-annotation`（jsdom 23 项，自动纳入 `npm test`）与 `npm run test:tiptap-underline-annotation-browser`（真 Chrome 6 组，含「选中文字加批注 → 保存 → 刷新后没有 `<u>`」这条真路径与 computed `text-decoration-line`）。两条解析规则各自承重，都做过变异验证：放宽 style 判定红 11 项，去掉 tag 判定只红 5 项自愈断言。
- **软回车后内联 Markdown 规则静默失效（`**粗体**`、`_斜体_` 变成字面文本）**：根因不在我们的代码里，而是 `MdSoftBreak`（`hardBreak`）没有声明 `leafText`。ProseMirror 默认把 inline leaf 在文本视图里塌缩成空串，于是 Tiptap 的 input rule runner 取"光标前文本"时（`L0` → `node.textContent`）拿不到换行、改填字面占位符 `"%leaf%"`，而它随后的复核走 `textBetween`（那里 `<br>` 又是空串），两边永远对不上 → **所有带"行首或空白"前提的内联规则在软回车之后全部不触发**（实测只有无前缀要求的 `` `code` `` 侥幸生效，所以现象看起来像"编辑器时好时坏地丢了实时渲染"）。修复：给 `hardBreak` 声明 `leafText: () => '\n'`——`textContent` 的 getter 本身就读 `spec.leafText`，一个字段同时对齐匹配串与复核。**必须写在 `extendNodeSchema` 里而不是扩展顶层字段**：Tiptap 组装 PM NodeSpec 用白名单（`content/marks/group/inline/atom/selectable/draggable/code/whitespace/linebreakReplacement/defining/isolating/attrs/parseDOM/toDOM`），顶层 `leafText` 会被静默丢弃（实测 `schema.nodes.hardBreak.spec` 里没有它），而 `extendNodeSchema` 的返回值在白名单之前展开；该 hook 对每个节点都会跑，所以按 `node.name` 收窄。附带修好"从编辑器复制纯文本时段内换行丢失"。存储形态不变（Markdown 序列化走 `addStorage.markdown.serialize`，不经过 `leafText`）。回归：`test:editor-input-browser` 新增三组断言（软回车后 bold/italic/code 的 mark 与渲染 DOM、以及 `doc.textContent` 把软换行读成 `\n`）。**这条只补上了内联那一半**：块级规则（`#`、`-`、`>`、`1.`）当时仍以 `^` 锚定、只认 PM 块首，软回车后不生效；现已由「新增」里的 `SoftBreakBlockRules` 解决（不能只放宽锚定——官方 handler 的作用范围是整个块，会把上一视觉行一起吞进块类型，必须自己拆块）。
- **Tiptap 编辑模式下点附件仍然直接下载（要闪一下才弹菜单）**：真正的下载来源是 Tiptap 的 Link 扩展——它默认的 `openOnClick: true` 会注册一个 PM `handleClick`，对链接调 `window.open(href, target="_blank")`，而附件的 `href` 是 `/api/assets/<id>/download`（响应带 `Content-Disposition: attachment`），于是点击即下载。关键点：**PM 派发 `handleClick` 的时机是 `mouseup`，不是 `click`**（prosemirror-view 的 `LeftMouseDown.up → handleSingleClick → someProp('handleClick')`，`view.dom` 上根本没有 click 监听器），所以任何 click 阶段的拦截都追不上它——上一轮把监听改挂**捕获阶段**并没有修掉这个 bug（实测仍有一次 `window.open`）。现在从源头关掉：`StarterKit.configure({ link: { openOnClick: false } })`（`public/tiptap-editor.js`），编辑模式点附件只弹「下载 / 删除」菜单，下载只在菜单里点「下载附件」时发生；阅读模式不受影响（本来就走浏览器原生行为，不经过 PM 的 handleClick）。关掉之后裸 URL 的点开能力按旧 Vditor 基线在 `tiptap-image-interactions.js` 里补回：**只有「链接文本就是 URL」的链接**在编辑模式可点开，`[文字](url)` 不打开（这条与迁移前的旧编辑器一致；改动前 Tiptap 会对任意链接都打开，若要让带文字的链接也点开，去掉 `openBareLink()` 里 `text !== href` 那一行判定即可）。捕获阶段的 click 监听保留（抢在同节点其它冒泡监听之前拿到点击、并 preventDefault 兜住浏览器原生激活），并把 `isArticleFileLink` 的判定放宽为「`title` 标了 `dumbpad-file=1` 或 `href` 就是资产下载 URL」——旧数据里 title 丢失的链接同样拿到 chip 样式与菜单。根因证据与回归：`window.open` 的调用栈停在 `handleClick ← someProp`，且事件流水里 `window.open` 发生在 `click` 之前；jsdom 走不到 PM 的鼠标管线（`posAtCoords` / `view.mouseDown`），因此新增真实浏览器回归 `npm run test:tiptap-attachment-click-browser`（编辑模式点击零下载/零弹窗 + 只弹一个菜单、菜单内下载恰好一次、删除可撤销、裸链仍打开、带文字链接不打开、触屏点按、阅读模式仍直接下载）。

- **光标落在附件上按回车，附件胶囊被撑高（并把链接 markdown 写坏）**：普通段落的回车由 `SoftEnterShortcut` 换成段内软换行（`hardBreak` 节点），但插入用的是 `tr.replaceSelectionWith(node)`——PM 默认让插入的节点**继承光标处的活跃 mark**。链接文本里的活跃 mark 就是 `link`（Link 还是 inclusive 的，光标贴在链接右边界时也算），于是 `<br>` 落进 `<a>` 里面：附件胶囊是 `inline-flex`，被撑成一整块空白，多次回车越来越高（实测 34px → 51px → 86px，正是用户看到的「变成图片那种」）。更糟的是序列化会把换行写进链接 label，产出 `[丁尚坤\n-桌面运维.pdf · 234 KB](/api/assets/…/download "…")` 这种**坏掉的链接语法**——保存后重新解析就回不来了，属数据损坏而不只是视觉问题。Shift+Enter（`setHardBreak`）是同一类损坏的另一形态：它把链接劈成两个 `<a>`。现在软换行的插入统一走 `insertSoftBreak()`：光标在链接文本内部 → 换行放到整条链接之后、光标跟到换行后面（用户按回车要的是「下一行」，不是把 label 剪开）；光标贴在链接边界 → 位置不变但不继承 `link`；与链接无关的段落语义完全不变（普通段落仍是软换行、空段落仍走框架默认分段）。回归：新增 `npm run test:tiptap-soft-enter-link`（jsdom 19 项，已自动纳入 `npm test`）与 `npm run test:tiptap-attachment-click-browser` 的真实布局断言（回车前后 chip 高度差 ≤1px、`<a>` 内不得出现 `<br>`、回车后继续输入得到 `[附件]\n文字`）。变异验证：把 `insertSoftBreak` 的链接判定短路 → jsdom 8 项变红，浏览器断言直接报 `Enter inside the chip must not grow it (34px → 51px)`。
- **`/file` 选完文件后编辑器丢焦点**：原生文件对话框打开期间焦点落在隐藏 input 上，选择完成或取消后都没有交还编辑器——用户看不到插入点、要继续打字得先手动点一下编辑区。现在插入完成（WYSIWYG 与源码模式）与取消三条路径都会把焦点/光标交还编辑器。
- **Tiptap 下点图片错误弹出文字选区菜单**：点击图片会产生非空 NodeSelection（旧 Vditor 点图片后文字选区是折叠的，所以不弹），而选区菜单的禁区只列了 `codeBlock` 与 `timeMarker`，图片不在其中——于是「画线 / 高亮 / 批注 / 复制」文字菜单出现在图片上，与图片自己的尺寸菜单抢位置。现在 `image` 也列入 `PROTECTED_NODE_TYPES`，图片让位给 `TiptapImageInteractions` 的尺寸 / 大图菜单。同时修掉这条路径的残留形态：文字选区的菜单**已经显示**后再点图片时，mouseup 的宏任务补判只做了早退（拖拽态已拦住 `update()` 的隐藏分支），旧菜单会连同上一次的选区一起留在图片上，此时点「画线 / 高亮 / 批注」会写到上一次选中的文字上——现在该分支改走 `hide()`。
- **Tiptap 块级图片吞掉块分隔（数据完整性）**：Tiptap 内置的图片序列化（`ht.nodes.image`）写完 `![alt](src "title")` 后不回 `closeBlock`，于是块级图片后面的下一个块会粘在图片 markdown 后面——`![图](/api/assets/…/preview)\n\n正文` 保存后变成 `![图](/api/assets/…/preview)正文`，重新解析时图片与正文合并进同一段。任何编辑过含图片文章的笔记都会被这样改写，`/file` 插图后继续输入正好走这条路。现在 `DumbPadImage` 提供自己的 markdown 序列化（逐字节复刻内核实现：alt 走 `state.esc`、src 只转义括号、title 只转义引号）并在末尾补块分隔；`npm run test:tiptap-roundtrip` 新增 6 组图片契约（单独、带宽度、图片+段落、段落+图片、两图相邻、Base64 老图），每组同时校验字节一致与二次幂等。
- **Tiptap 丢弃旧笔记的内联 Base64 图片（数据完整性）**：图片扩展默认 `allowBase64: false`，schema 的 `img[src]:not([src^="data:"])` 会把 Base64 图片整个节点丢掉——旧文章里以 Base64 内联的图片在编辑保存时被静默删除（实测 `![旧图](data:image/png;base64,…)` 解析后文档直接变空）。现在 `DumbPadImage` 用 `Image.configure({ allowBase64: true })` 承认这类图片：markdown 原样往返，并照旧参与图片装饰、尺寸菜单与 lightbox（旧的 `isLegacyArticleImage` 分支）。
- **移动端代码块折行**：长代码行在窄屏上被 `pre-wrap + anywhere` 拆成多行，代码结构难以阅读。现在 ≤980px 视口下代码块长行不折行，改为容器内横向滑动查看（左右滑条），行号栏是 `pre` 上的绝对定位元素、不随内容滚动；编辑与阅读模式共用该 DOM，规则对两者同时生效，桌面保持折行不变。
- **移动端表格膨胀**：单元格被 `word-break: break-word` 拆行（`toggle_complete` 一词拆成多行），叠加三个遗留因素让行高膨胀到约 90px——vditor 遗留的内联 `code` 自带 `pre-wrap + break-word`、单元格内段落带卡片式 1em 下边距、`td::after` 的空 content 行盒在每行多撑一行。现在 ≤980px 视口下单元格不折行、整表横向滑动，段落边距清零、空行盒清除，行高回到单行 34px；编辑与阅读模式同时生效，桌面保持折行不变。
- **移动端编辑卡片偏下、左右边距过宽**：Tiptap 卡片（`.tiptap`）没有吃到 ios-theme 里为旧 vditor `pre.vditor-reset` 定制的几何规则——移动端仍在用桌面卡片形态（64px 顶部 margin、38px 顶部内边距、40px 左右边距、110px 底部内边距），卡片明显下移、文字两侧留白过大。现在按 boot 卡注释里记录的旧 vditor 移动端实测几何对齐：卡片顶部回到容器顶（margin 0，浮动工具条的让位由容器 padding-top 负责）、内边距 `10px 10px 64px`（文字近乎平铺），桌面几何（64px margin / 24px 上下 padding / 40px 纸面边距）不变，且现在同时覆盖新旧两代卡片元素。
- **文章水印（创建/更新/修改次数）不显示**：水印的卡片锚点按旧 vditor 的 DOM 形状查找（`#hybrid-editor .vditor-wysiwyg pre.vditor-reset`），切换 Tiptap 后内容区是 `div.tiptap.vditor-reset`（没有 `pre`），`getCard()` 恒为空导致水印永远停留在"不可见"分支。改为按 `.vditor-reset` 类查找，同一选择器同时命中新旧两代卡片本体（白底/圆角/边框都在该元素上）。
- **保存/同步过于频繁**：原先输入停止 300ms 就 POST 保存，打字时稍作停顿就发一次请求，"Saved" 提示随之频繁弹出。现在防抖改为 **5 秒无改动才同步**（本地缓存仍每击即写，状态栏保持"本地已保留"，中断风险由本地脏缓存 + 下次启动同步兜底）；切换笔记时的兜底 flush 改为统一 helper，并新增 `pagehide` 兜底 flush（页面关闭/切后台时把还在防抖窗口里的内容带 `keepalive` 立即送出，超 60KB 的报文走常规路径）。状态提示保持只在真正同步时给出一次"已同步"，打字过程不再频繁弹窗。
- **文章"修改次数"重复计数**：保存接口原先只要收到请求就无条件 `version+1` 并刷新 `updatedAt`，哪怕正文与已存内容完全一致（防抖窗口内打了字又撤销、切换笔记时的兜底保存、丢失响应后的重试等都会用相同内容再次 POST），文章水印的"修改次数"随之虚增。现在服务端对内容未变化的保存返回 `unchanged` 且不计版本、不刷 `updatedAt`、不广播（此前该捷径只在客户端版本落后时生效，仅覆盖重试场景）；客户端对 `unchanged` 响应也不再本地刷新更新时间。只有真实内容变化才计入一次保存/一次修改。原版行为与契约记录见 `docs/api.md` 与 API 回归测试（新增同内容保存三种 baseVersion 形态的用例）。
- **目录高亮与跳转落点不一致**：滚动高亮只扫标题条目，点击加粗/高亮/批注片段子条目跳转后，高亮仍停留在其父标题上（如跳到「Hardened Auth V2」片段却高亮「Legacy PIN Or Hardened Token」）。现在片段子条目参与"我正在哪里"判定（目标元素失连时回退标题粒度），并把高亮探针线与跳转落点锚点（视口高度 18%）对齐——点击哪个条目，跳转后高亮的就是哪个条目；普通滚动时高亮切换位置与跳转落点一致。
- **目录把代码块里的 `# 注释` 当成标题**：`buildMarkdownHeadingIndex` 逐行匹配 ATX 标题、不感知围栏代码块，代码示例里的 `# 示例文本`、shell 注释等都会混进文章目录，还会让目录条目数与实际渲染的标题数错位、干扰锚点匹配。现在扫描时跟踪围栏开合（CommonMark 规则：闭合围栏需同字符、长度不小于开启行且不带围栏字符），围栏内的行不再计入目录；这是**行为变更**（旧测试基线明确固化了"围栏内标题进目录"的旧语义，已随用户要求更新）。新旧编辑器共用该模块，同时受益。
- **Tiptap 编辑器代码块无语法高亮**：切换 Tiptap 后代码块一直是纯文本。现在接入 Tiptap 官方 `CodeBlockLowlight`（PM Decoration 机制给文本加 hljs 类，不动 DOM、零手写高亮逻辑），bundle 内置 lowlight 常用 37 种语言，frontmatter 假代码块按 YAML 别名高亮避免随机自动识别；浅色 token 配色复用既有 `github.min.css`（index.html 直接加载），暗色覆盖沿用 styles.css 既有规则。同时把自定义代码块/待办 NodeView 从 `editorProps.nodeViews` 迁到扩展 `addNodeView` 挂载（Tiptap v3 的 `createView` 只认扩展注册表，`editorProps.nodeViews` 会在首次 `setEditable` 前被整体忽略，此前仅靠阅读模式切换间接触发生效），并修复复制按钮取不到代码文本的问题。
- **Tiptap 编辑器目录点击不跳转**：两个根因。其一，目录同步直接改 PM 管辖 DOM 的标题 id，会被 ProseMirror 的 DOMObserver 在重绘时抹掉（实测 ~50ms 内清空），跳转与滚动高亮全部失联；现在标题锚点 id 改由 `HeadingAnchor` 扩展以 PM 节点 Decoration 渲染，`syncRenderedHeadingIds` 经 meta 事务同步（不进撤销历史、不触发保存），id 去掉 `heading-` 前缀对齐旧编辑器与 app.js 的查询契约。其二，跳转滚动用的 `scrollIntoView({smooth})` 会在同一点击流程内被其他滚动/焦点处理取消（实测 scrollTop 纹丝不动），改回旧编辑器的机制：手算偏移后在真正承载滚动的容器上 `scrollTo`，并恢复跳转目标的 `is-jump-target` 高亮。
- **带子任务的卡片滑动删除卡顿**：整卡滑动每次 pointermove 都往卡片写 4 个 CSS 自定义属性和 1 个冗余 inline transform，而自定义属性沿子树继承、每次写入都触发整卡子树的样式重算；有子任务的卡片子树大（几十个行节点），且高刷新率屏幕一帧会收到两次 pointermove，逐帧重算被放大成可见卡顿（无子任务卡片子树小、子任务行滑动只作用于行内，所以都流畅）。现在滑动样式写入合并到 requestAnimationFrame（一帧最多失效一次），并移除没有任何 CSS 消费者的 `--swipe-progress` 和冗余 inline transform（卡片位移本就由 `--swipe-x` 变量驱动）；滑动删除手势与确认/删除动画行为不变。
- **同步冲突弹窗主按钮无样式**：确认弹窗的 `confirmType: 'primary'` 会给确认按钮（如 Thought 同步冲突里的「保留本地」）设置 `primary-btn` 类，但该类从未在任何样式表中定义，按钮一直以浏览器默认的裸样式（白底细边框、无内边距）出现，与旁边的胶囊按钮不协调。现在补齐三套形态：桌面按应用主色填充（与设置页保存按钮同款语言，暗色自动跟随主题色变量），移动端 iOS 主题沿用同组的浅色调胶囊形态。
- **多端 Thought 同步不实时**：远端设备对 Thought 的修改（子任务增删、新建）到达时，如果本机时间线里还有输入框持有焦点（例如刚添加完子任务、链式输入框仍聚焦），`scheduleRender` 的焦点保持逻辑会把这次更新推迟到失焦才渲染——内存模型已是最新但界面长时间不动，看起来就是"另一台设备改了但这边没有"。现在远端更新按卡片原位刷新：焦点不在被更新卡片内时立即只重建该卡片（新建/删除同样原位补入/移除），只有焦点确实在被编辑的那张卡上时才保持焦点优先、推迟到失焦。同时 WS 回声改为对既有对象原位合并而不是替换数组槽位，排队中的连续提交不再因为拿到旧版本号而撞上自己回声的 409。新增双设备浏览器回归 `npm run test:thought-sync-browser`（不在 `npm test` 中）。
- **手机端连续添加子任务键盘闪断**：回车提交子任务会先全量重建时间线（正在聚焦的输入框被销毁、键盘收起），等服务器返回后再重建一次并新开输入框、键盘重新唤起——每加一条子任务键盘就要塌一次。现在回车提交改为同一输入框链式：提交后清空输入值、原位插入一条预览行（不可交互，失焦后的完整渲染会用服务端 id 的绑定行替换它），焦点与键盘全程不离开输入框；回车增加 IME 组合态守卫，中文输入法确认拼音的回车不再误提交半截拼音。根因与边界记录在 [技术总览](docs/technical-overview.md)。
- **严重 bug：文章输入时标记闪烁与光标回跳**：在 Vditor 输入解析的离屏 HTML 中保护已渲染的自定义内联节点，保留原生光标锚点；适配器启用后停用 IME 指纹恢复和延时光标纠正，避免重新解析后暴露时间源码、或将用户已移动的光标拉回。新增独立 Chrome 输入回归测试，用户初步反馈可用；真实系统输入法与原图片跳动场景仍需验收。根因、失败方案和验证边界记录在 [技术总览](docs/technical-overview.md)。

- **PC 点击折叠卡片延迟展开**：鼠标单击原先要等 300ms 双击判定计时器到期才展开/收起长卡片，感觉像卡一下（移动端常点摘要行、感知不明显）。现在鼠标单击立即切换展开，双击仍直接进入编辑；触屏的双击消歧保持不变。
- **Thought 子任务点击卡顿**：勾选子任务会触发两次整条时间线的全量重建（乐观更新一次、变更落库再一次），长列表上表现为明显卡顿。现在勾选只原位刷新当前卡片的行状态与进度环，落库后按新排序原位移动卡片（懒加载分页未完成等边界回退到原渲染路径），打开中的面板与滑动状态不再被打断。
- **折叠卡片添加子任务“回车无效”**：折叠卡片只显示前两条子任务，提交的新行落在隐藏区、回车续输的输入框看起来没反应；且 `scheduleRender` 只在调度时检查焦点，WebSocket 回声恰好在一帧窗口内调度时会把刚聚焦的续输输入框销毁。现在进入添加流程先自动展开卡片（提交行与续输输入框始终可见），渲染 flush 时二次检查焦点，后台刷新不再吞掉正在输入的输入框。
- **编辑器标题侧标偏上**：Vditor 内置的 H2–H6 侧标浮动在行盒顶部，看起来标题"偏上"、标记与文字没对齐。现在侧标相对标题垂直居中、更小更淡，H1 也补上标记；移动端横向空间有限，侧标直接隐藏。
- **编辑器列表无法退出**：带时间标记/批注的列表项回车后，新列表项会继承不可见残留（零宽守护符、结构空格、空文本节点），Vditor 视其为非空——继续回车只会不停新建条目、退格先无声删除隐形字符，看起来就是"无法取消列表"。现在每次输入都会清理只有隐形残留的列表项，空项上的回车/退格恢复 Typora 式行为（回车退出列表、退格取消列表）。
- **编辑器视口漂移**：光标位于视口上方（尤其标题内）打字时，折叠光标的矩形可能测量为 0，视口回退逻辑找不到兜底块（标题不在选择器里），每次按键都会把视图向上推一截，直到光标落到屏幕底部。现在兜底覆盖标题、且矩形不可测量时不再触发滚动。
- **移动端文章目录跳转失效**：目录点击的滚动逻辑写死了编辑器内部滚动容器，而移动端真正滚动的是页面本身——点击标题毫无反应。现在按实际滚动容器计算（含页面滚动），并在移动端等键盘弹出、布局稳定后再滚动。
- **Thought 同步死循环**：outbox 重放遇到 `404`（Thought 已在云端删除，或本地临时 id 从未上云）时丢弃该条并清理本地残留，不再永远显示「待同步 1」且点击无效。
- **Thought 子任务冲突**：同一 Thought 的服务器变更改为串行排队，409 时自动重基到远端版本重试一次；快速连续添加/勾选子任务不再频繁弹出「已在其他设备更新」。
- **Thought 键盘被顶掉**：后台数据更新（AI 状态、WebSocket）触发的全量重渲染，在时间线内有输入框持有焦点时推迟到失焦后执行，移动端打字/搜索时键盘不再被关闭。
- **子任务回车续行**：子任务输入框按 Enter 提交后自动开启下一条输入（视图内联与编辑面板均生效），不再一次输入就结束。
- **Thought 排序**：timeline 排序把「多个子任务完成了一部分」的想法排在未动手的想法之前，让进行中的事项优先可见（游标向后兼容旧字段）。
- **移动端键盘白色块**：新增 visualViewport 同步（`--dumbpad-vvh`）与 `interactive-widget=resizes-content`，键盘弹出时应用外壳高度跟随可视区域收缩，向下滑动不再露出页面背景白块。
- **编辑器输入闪烁**：caret-stability 输入路径默认开启（此前为隐藏开关），打字时不再重建光标所在块、去掉 80ms 二次装饰重试，消除 /time、图片等特殊元素附近的 raw→渲染闪烁；可用 `localStorage['dumbpad:caret-stability']='off'` 一键回退。
- **演示数据**：「开发者 API 指南」笔记中指向 `../api.md` 的失效相对链接改为指向仓库 `docs/api.md`。
- **编辑器**：源码模式往返不再损坏内容；启动交接不再触发重排；有损的重新序列化不再在保存时落盘。
- **编辑器（IME 提交稳定器）**：中文候选词上屏的瞬间，Vditor 会异步重建光标所在的列表块——已渲染的 /time、高亮、批注等特殊元素被剥回裸源码（闪烁），光标被重锚到错误的列表项（乱跳）。现在 compositionend 捕获阶段先快照光标（所在块指纹 + 规范化文本偏移，装饰元素不计长度），微任务中等 Vditor 同步处理完成后按指纹找回重建块、回放偏移并同步重装饰；随后 400ms settle 窗口内观察器不再推迟带光标块的装饰，120/280ms 兜底重试覆盖更慢的重建。待办项与时间标记列表项实测：标记在绘制前恢复、光标不再跳出。
- **编辑器（中文输入）**：IME 输入期间视口保持不动，光标在冻结视口前先滚入可见区；列表块内 IME 提交时的滚动抖动已消除，移动端页面级滚动单独适配。
- **编辑器（协同/远端同步）**：远端同步更新落在编辑中途时保留光标；vditor 渲染后恢复列表批注。
- **同步冲突**：Thought 版本冲突从"死锁"改为可恢复，用户不必手动清理。
- **PWA**：冷启动保持登录会话并恢复上次阅读位置；network-first 回退窗口缩短，普通刷新更快拿到新资源。
- **移动端**：从侧边栏选择文章后悬浮按钮（FAB）恢复显示。
- **今日草稿**：修复同步缺口导致的记录陈旧；长条目保持在单行内。

### 变更

- **文档布局**：根目录收敛为四份入口文档（`README.md` / `ARCHITECTURE.md` / `CHANGELOG.md` / `AGENTS.md`，其中 AGENTS 仅本地）；`api.md`、`SKILL.md` 移入 `docs/`，由 `docs/README.md` 统一索引。
- **仓库结构**：回归测试统一收进 `test/`，根目录不再散落测试脚本；带日期的历史文档（含根目录遗留的 API 报告与 2026-06 的 UI/UX 优化计划）移入 `docs/archive/`，且该目录整体转为仅本地存档——从 git 跟踪中移除，不再随仓库推送。
- 忽略规则：误生成的 pnpm lockfile 不再纳入版本控制（项目使用 npm）。
- 样式：草稿/Thought 链接去掉下划线，保留颜色高亮、hover 高亮与点击打开行为。

## [1.0.9] - 2026-07-30

### 新增

- **资产批量管理**：带主题的多选交互，可批量管理附件。
- **编辑器首屏提速**：instant boot 编辑器 + 首屏关键资源预加载。
- **编辑器性能监控与标题索引**（WIP，2026-07-26）。
- **本地备份恢复**：补齐本地备份恢复流程的缺口（2026-07-19）。

### 修复

- **安全加固**：分享页 sanitizer 加固，移除硬编码的分享密钥，WebSocket 载荷大小设上限。
- **同步与编辑器**：解决审计发现的同步冲突、写放大与编辑器往返问题。
- **登录**：PIN 输入掩码化，视觉质感调整。
- 桌面端悬浮操作条定位到侧边栏 gutter。

### 变更

- API 文档补齐资产管理端点，版本提升到 `1.0.9`。

## 早期历史（1.0.9 之前，无版本标签）

### 2026-07-18

- 定义 Mermaid 编辑模式行为；稳定代码块的编辑与渲染。

### 2026-07-17

- 定义文章文件卡片交互；强化安全与草稿工作流；修复资产块移动时丢失源码的问题。

### 2026-07-16

- 定义数据安全 V1 边界（登录、备份、恢复、审计、部署隔离）；定义文章 `/file` 命令。

### 2026-07-15

- Thought、编辑器、资产与 API 的一轮完整增强（含分享密钥、代码语言自动补全等）。

### 2026-07-08

- Thought 支持置顶与附件。

### 2026-07-06

- 数据安全、安全漏洞、性能修复，以及用户报告的两个 bug。

### 2026-06-25

- 数据安全与性能优化：thought 卡片增加铅笔编辑按钮，修复内联标记（时间标记/高亮）输入闪烁与光标跳动、代码块暗色背景、移动端设置自动弹键盘等问题。

### 2026-06-21

- 新增 Docker 一键更新工具链与 Thought 时间控件。

### 2026-06-01

- 开启 `refactor-ai-s3-thoughts` 重构线：S3 兼容存储、AI 关系分析、route 模块化拆分、PWA 冷启动优化、同步可靠性治理。该分支于 2026-07-15 快进合并回 `main`。

### 2026-05-17

- 首次推送：极简 Markdown 草稿本，含混合编辑、PIN 保护、PWA、Thought 模式与面向 Agent 的局部编辑 API。

---

更细的逐提交记录见 `git log`。带日期的审计与修复报告存于 `docs/archive/`（该目录为本地存档，不随仓库推送）。
