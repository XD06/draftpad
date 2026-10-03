# DumbPad 项目技术介绍

本文档描述当前 DumbPad 的主要技术边界和本轮低风险重构后的模块职责。目标是让后续继续添加 Thought、AI、同步和数据空间功能时，优先沿已有边界扩展，而不是继续向大文件堆逻辑。

## 1. 技术栈

- 后端：Node.js、Express、WebSocket。
- 前端：Vanilla JS ES modules、CSS、Tiptap/ProseMirror（编辑器内核，离线 bundle）、Marked。
- 存储：本地 JSON/txt 文件或 S3 兼容对象存储。
- 搜索：全局搜索走 `server/search/` 的领域 provider 注册表（精确多关键词 AND，notepad/thought/today_draft 三个 provider），语料来自 `storage.getSearchDocuments()` 的内存缓存；Fuse.js 索引保留仅供交互 Agent 的 recall_context 候选。
- AI：OpenAI-compatible chat、embedding、可选 rerank、手动 Thought insight，以及默认关闭的独立交互 Agent；无 key 时后台 pipeline 使用 noop provider。
- PWA：运行时生成 manifest 和 asset manifest，service worker 负责缓存静态资源。

## 2. 后端边界

`server.js` 是当前后端入口，仍集中注册静态资源、鉴权、WebSocket、分享页、Notepad API、Thought API、Today Draft API、Trash API 和搜索 API。数据管理 API 已拆到 `routes/data-management-routes.js`，Trash API 已拆到 `routes/trash-routes.js`，都由 `server.js` 通过显式 context 注册。后续继续拆分 route 时应保持 URL、HTTP status、response body 和 WebSocket 副作用不变。

关键模块：

- `scripts/storage.js`：唯一的用户数据读写边界。调用方通过同一套方法读写 Notepad、Thought、Today Draft、Trash、AI meta、relations、indexes，不直接关心 local/S3 或 legacy/split layout。
- `scripts/ai-provider.js`：封装 AI provider。关系分析使用 chat/embedding/rerank；手动 Thought insight 使用独立 `AI_INSIGHT_MODEL`，没有可用配置时降级为 noop provider。
- `scripts/ai-queue.js`：负责后台 AI 队列、pending meta、extract、embedding、relations、rebuild 和状态广播；同时提供手动 insight 生成函数，但 insight 不进入自动队列。
- `scripts/agent/`：交互 Agent 的独立边界。`agent-run-service.js` 维护可取消运行和 SSE 事件；`agent-context-service.js`/`agent-tool-registry.js` 限制只读来源与上下文预算；`agent-model-client.js` 只读取显式 `AI_AGENT_*` 配置；这些模块不调用 `ai-queue` 或用户内容写入路由。
- `routes/agent-routes.js`：负责 `/api/agent/*` 的 HTTP 参数、主体边界和 SSE 适配；阶段 A 只允许 Thought 的 `recall_context`。
- `scripts/s3-service.js`、`scripts/s3-prefix-tools.js`：负责 S3 对象操作、prefix inventory、backup、delete 和 data space 列表。
- `routes/data-management-routes.js`：负责 `/api/data-management/*` 路由，包含状态读取、数据空间列表/切换、inventory、backup、delete、本地导入 S3、双向覆盖。
- `routes/trash-routes.js`：负责 `/api/trash/*` 路由，恢复和永久删除都只调用 storage 边界，不在 route 层拼接本地路径或 S3 key。
- `routes/today-drafts-routes.js`：负责 `/api/today-drafts/*` 路由；在独立写锁内按服务端 3 天窗口（今天 + 前 2 天）过滤并清理滑出窗口的草稿，对单条 PUT/DELETE 校验 `baseVersion`（创建可携带窗口内的 `day`，更新保留原 `day`），完成后广播 `today_drafts_update`。
- `server/search/`：全局搜索（`GET /api/search`）的领域 provider 架构。`matcher.js` 是纯匹配原语（空白分词 AND、按行 occurrences、围栏感知章节映射——复用 `scripts/note-edits.js` 的 `buildOutline`、确定性排序）；`providers/` 下每个数据域一个 provider（notepad 读索引语料缓存、thought 走 `searchThoughtsLight` 的索引短名单、today-draft 直读 3 天窗口数据）；`registry.js` 聚合并隔离单域故障。匹配是精确 AND，不做模糊；Fuse（`server/indexing.js`）只为 Agent recall_context 保留，其语料缓存通过 `getSearchCorpus()` 与 HTTP 搜索共享。新增数据域 = 注册一个 provider + 前端 `registerResultType`，搜索核心不变。

## 3. 前端边界

前端没有构建步骤，所有浏览器代码都通过原生 ES module 加载。新增模块时要同时确认 service worker asset manifest 能覆盖新文件。
Thought 前端 helper 拆分模块有聚合测试入口：`npm run test:thought-modules`。

核心模块：

- `public/app.js`：应用启动、Notepad 编辑与保存、设置页、同步状态、全局快捷键和主视图协调。
- `public/managers/command-search/`：全局搜索面板（Ctrl+F / Ctrl+K，任何视图统一打开）。`command-search-manager.js` 负责请求防抖、分组渲染（当前文章命中展开置顶、其余按域分组）、多关键词高亮、键盘导航；`result-type-registry.js` 是 `type → 徽标文案/样式/跳转` 的注册表，域的跳转行为在 app.js 注册（notepad→selectNotepad、thought→`revealThoughtById`、today_draft→`revealDraftById`），新增域只加一条注册。
- `public/tiptap-editor.js` + `public/managers/tiptap-*.js`：Tiptap/ProseMirror 编辑器适配层，负责混合编辑、源码模式、阅读模式、目录索引、批注和高亮装饰。导出与旧 Vditor 封装同名的 `HybridMarkdownEditor` 类，`app.js` 契约不变；序列化与旧编辑器逐字节对齐（`test/test_tiptap_roundtrip.js` 固化）。编辑内核打包为离线单文件 `public/vendor/tiptap/tiptap.bundle.js`（`scripts/build-tiptap-bundle.js` 生成，含 tiptap-markdown、lowlight/highlight.js 常用语言）。
- `public/hybrid-editor.js`：旧 Vditor 封装，已被 Tiptap 适配层取代，运行时不再加载，文件待删除（保留期间仅作行为对照）。
- `public/managers/thoughts.js`：Thought UI 协调层。负责 DOM 插入、每卡事件绑定、乐观更新、toast、筛选、AI/relations 面板入口；全局事件初始化按 Quick Add、视图切换、搜索筛选、outbox、socket 分段，`render()` 负责列表生成，单卡交互集中在 `bindThoughtCardEvents()`，relation panel 事件分发集中在 `handleRelationsPanelClick()`，inline 子任务编辑的输入替换和提交协调分开维护。
- `public/managers/thought-api-client.js`：Thought HTTP client。负责 URL 拼接、`encodeURIComponent`、JSON 请求和带 `status` 的错误。
- `public/managers/thought-outbox.js`：Thought 本地 outbox。负责 localStorage key、队列合并、create/patch/delete/relation 队列项构造、服务端列表合并和 retry。
- `public/managers/today-drafts/`：日期草稿的独立前端模块。store 保留 3 天窗口的本机缓存（`dayWindowKeys` 与路由层同语义），API client 与 outbox 负责按条重试和版本更新（outbox 克隆携带 `day`），manager 协调编辑、整页仿真翻页（今天可编辑、历史日只读；竖直折痕实时跟随指尖，右滑看更早、左滑拉回更新，标题随整张纸卡一起翻）、WebSocket 合并与转 Thought 手势。`today-drafts-paging.js` 是分页纯函数（不碰 DOM）：把「一页纸放得下几条 44px 行」和「每条草稿实际吃掉几行」切成页边界，并把「日」和「页」拉平成一条时间线（`day#index`），让右滑=更早、左滑=更新在跨日与跨页两种边界上语义一致；行数只能从真实布局量，所以 manager 用一份同宽的隐藏 sizer 副本读一轮 `offsetHeight` 再喂进来，量不到布局时预算按 `Infinity` 处理（整日一页，宁可滚也不按假数据打散）。行内编辑由 `hasActiveDraftInput()` 保护：用户打字与输入法输入期间的异步网络回填一律记账到 `pendingRender`，避免打字中途撕毁活跃 DOM；`isRendering` 锁屏蔽 DOM 替换引发的脱轨 `focusout`，防止重入报错。
- `public/managers/thought-ai-status.js`：Thought AI 状态边界。负责 AI 状态/阶段归一化、pending 最短显示时间计算、socket detail 应用到 Thought 对象、标签文案、按钮图标、状态详情 HTML、手动 insight 区块、loading/error 片段；`ThoughtsManager` 保留 timer 调度、点击、拉取状态、Markdown hydrate、重试和 insight 触发协调。
- `public/managers/agent-api-client.js`、`thought-agent-state.js`、`thought-agent-panel.js`、`thought-agent-controller.js`：交互 Agent 的 API、纯状态、纯视图和 SSE 生命周期边界；Thought 卡片只提供明确入口和局部面板，不混入后台 AI 状态面板。
- `public/managers/thought-card-renderer.js`：Thought 卡片纯 HTML 渲染边界。负责正文、legacy checkbox 子任务、标签、AI 状态入口、关系计数和折叠子任务摘要；`ThoughtsManager` 只保留 DOM 插入、复制文本和交互事件绑定。
- `public/managers/thought-attachments.js`：Thought 附件纯逻辑边界。负责统一的 4 MB 校验、文件读取结果归一化、附件对象构造和图片附件筛选；Quick Add、编辑态和卡片浏览态复用同一流程。
- `public/managers/thought-relations-panel.js`：关系面板纯渲染 helper。负责关系列表、推荐列表、手动关联输入控件、候选摘要截断/高亮和空状态 HTML；保留事件、防抖、API 协调在 `ThoughtsManager`。
- `public/managers/thought-editor.js`：Thought 编辑 helper。负责 legacy 子任务解析、编辑态正文/子任务拆分、子任务清理/排序、编辑行与 inline 新增子任务输入 HTML 片段，以及新增/修改/删除/toggle 子任务的本地对象变更；保存触发、失焦、快捷键和 API 协调仍保留在 `ThoughtsManager`。
- `public/managers/thought-renderer.js`：Thought 过滤和排序 helper。
- `public/managers/thought-quick-add.js`：Quick Add 数据构造 helper。负责服务端创建成功后的本地 pending AI 标记、离线 local pending Thought 构造和 create outbox payload；弹层、焦点、提交时序、API 和 outbox 协调仍保留在 `ThoughtsManager`。
- `public/managers/thought-tags.js`：Thought 标签边界。负责标签归一化、`dumbpad_thought_tags` 持久化、标签收集，以及标签筛选、Quick Add 标签、AI 建议标签 HTML 片段渲染；`ThoughtsManager` 只保留事件协调。
- `public/managers/thought-text-formatting.js`：Thought 文本格式化 helper。负责 HTML 转义、URL linkify 和正则转义；DOM 依赖的搜索高亮仍保留在 `ThoughtsManager`。
- `public/managers/time-command.js`：`/time` 快捷命令边界。负责本地时间格式化、光标前 `/time` 替换、`[[time:create:...]]` / `[[time:update:...]]` 标记渲染，以及旧 `[[time:...]]` 标记兼容；文章编辑器和 Thought 输入共同复用。
- `public/managers/thought-relations-state.js`：Thought 关系本地状态 helper。负责关系计数归一化、手动关联成功/失败和删除成功/失败时的本地 relation count/localPending/ready 状态变更；API、panel 刷新和 outbox 协调仍保留在 `ThoughtsManager`。
- `public/managers/thought-swipe.js`：Thought 滑动删除视觉状态 helper。把手势距离归一化为位移、进度、动作层透明度和删除阈值状态，DOM 手势与确认流程仍由 `ThoughtsManager` 协调。
- `public/managers/today-drafts/today-drafts-swipe.js`：今日草稿行滑动的纯 helper。`getTodayDraftSwipeState` 把行程归一化成位移 / 进度 / 方向 / 动作层透明度；`isTodayDraftPagerEdge`（草稿行两端各占约 22% 宽度、至少 72px 归整页翻页，中间约 56% 正文区留给草稿行操作）作为横向手势归属的**唯一判据**。手势起手定归属，中途绝不交棒变异，保证草稿操作与整页翻页动效严格隔离不串台。
- `public/managers/file-type-icons.js`：文件类型与精致矢量图标引擎。根据扩展名与 MIME 类型将文件归纳为 PDF、Word、表格、演示文稿、压缩包、代码、音视频、文本文档等 10 大类别，提供对应类别的主题色、类别徽章与 24x24 纯矢量无依赖 SVG 图标。为附件管理弹窗缩略图及编辑器内附件胶囊提供统一视觉语言。
- `public/managers/tiptap-file-command.js`：文章编辑器的 `/file` 附件命令与上传进度控制器。在 WYSIWYG 编辑器内通过 `TiptapArticleUploadProgress` 扩展向 ProseMirror 派发 `Decoration.widget` 渲染 `.article-upload-card` 进度卡片，支持多文件队列、实时百分比/状态平滑更新与错误处理；上传完成后自动替换为分类 Markdown 引用；源码模式通过 `window.toaster` 提供进度反馈。控制器另暴露 `openPickerAt(pos)` 供斜杠菜单的 `/file` 入口复用（挂起位置由菜单给定，取消上传由 `restoreEditorFocus` 归还焦点）。菜单路径在开选择器前已删掉命令文本，`deletePendingCommand` 复查时位置必须先夹紧到文档内容范围——越界的 `textBetween` 会抛 TypeError 中断整个上传链（曾导致「选择器弹出但上传从不发生」）。
- `public/managers/tiptap-slash-menu.js`：斜杠快捷命令菜单（`TiptapSlashMenu`）。段落里输入 `/`（行首或空白之后，防 URL 误触发）浮出命令面板，query 按 id/标题/关键词过滤；↑↓/Enter/Tab/Escape 键位只在有候选项时接管（无匹配时 Enter 落回软换行），点击/触摸直接执行；IME 组合、代码块/行内代码、非段落、非空选区、阅读与源码模式均不触发。命令走注册表（`registerSlashCommand` 描述符），内置 `/time`（单事务删 query + 插入 timeMarker）、`/file`（删 query + `openPickerAt`）。执行后命令文本由各命令自己的事务删除；扩展必须排在适配器扩展列表**末尾**（PM 的 handleKeyDown 按插件注册逆序咨询），directProps（/file 的 Enter 拦截）永远最先。菜单定位 `coordsAtPos` + rAF，移动端条目 44px 触控目标、以 `visualViewport` 为界。
- `public/managers/note-sync-controller.js`：启动缓存与 Note cache 读写控制器，避免缓存细节继续散落在 `app.js`。目录只筛选文章标题；选择已有文章时 `app.js` 先以 `loadNotes(..., { deferRemote: true })` 渲染缓存、再后台校验远端版本。非目录调用仍同步确认，避免该性能优化扩散到保存和冲突处理边界。
- `public/managers/settings-data-panel.js`：设置页数据空间、垃圾桶和云端维护 API adapter。
- `public/managers/ws-client.js`：轻量 WebSocket 客户端，把服务端事件转成浏览器 `CustomEvent`。
- `public/managers/floating-actions-config.js`：悬浮功能按钮的显示配置边界。把 `/api/config` 的 `hiddenFloatingActions` 黑名单落到 DOM：只切按钮的 `hidden` 属性，不删节点、不解绑事件，因此配置里去掉 id 就恢复原状；本文件持有「可配置 id」与「外壳必需 id（`fab-toggle-group` / `scroll-helper`）」两份清单，被丢弃的条目按 `protected` / `unknown` / `missing-in-dom` 回报，由唯一调用点 `app.js` 的 `loadAppConfig()` 打 `console.warn`。`styles.css` 的 `.floating-btn[hidden]` 是它生效的前提（`.floating-btn` 自身是 `display: flex`）。回归：`npm run test:floating-actions-config`（jsdom + 配置解析）与 `npm run test:floating-actions-config-browser`（真实浏览器 computed display、图标 getBBox、移动端「更多」展开）。

### 严重 bug 记录：文章输入时光标乱跳与特殊样式闪烁（Vditor 内核时期，记录保留）

**记录日期：2026-09-05。状态：修复已通过独立浏览器回归，用户初步反馈可用；完整真机验收尚未完成。**

症状：在时间标记、高亮前输入，或在已完成/未完成待办项中进行中文组合输入时，特殊样式可能退回源码、闪烁，光标可能跳到其他列表项；此前曾出现“先跳走，再被拉回来”的短暂纠正过程。用户同时报告图片上方输入时视口跳动。此问题按严重编辑体验 bug 记录，因为错误光标位置可能导致后续文字插入错误位置；本次没有确认持久化数据丢失。

根因证据：当前安装的 Vditor 在 `src/ts/wysiwyg/input.ts` 中通过 `SpinVditorDOM` 重新解析输入块，列表场景会重建整个顶层列表及相邻列表，然后利用 `<wbr>` 恢复光标。应用层对同一 DOM 的自定义装饰和光标纠正与该流程产生竞争。独立 Chrome 测试在第二个待办项输入 `abc` 后，修复前两项时间标记均消失并暴露源码，修复后逐帧检查保持标记与当前列表项光标。历史说明中的“约 90ms 异步重建”不是本次确认的固定时序，不应作为设计依据。

失败方案与教训：旧方案使用块文本指纹和偏移定位，在 IME 提交后微任务及 120/280ms 定时器中恢复光标，用户仍能看到跳动后纠正。随后尝试在每次 `MutationObserver` 回调中套用旧快照，用户反馈乱跳加重；该修改已撤掉。不能把任何 DOM 变化都视为需要回放旧光标的位置恢复事件，也不能仅用源码包含某段恢复逻辑的断言证明交互稳定。

文章输入解析通过 `HybridMarkdownEditor.installInputRenderAdapter()` 包装当前 Vditor 实例的 `lute.SpinVditorDOM`。已渲染的时间标记、高亮、批注、划线和上传卡片在脱离页面的 HTML 中临时替换为占位文本，Lute 完成块解析后原样还原，随后由 Vditor 写入 DOM 并使用自己的 `<wbr>` 定位光标。占位符或光标锚点不能完整还原时回退原始解析，不允许临时文本进入正文。适配器启用时不再执行 IME 指纹光标恢复和 120/280ms 定时纠正；不支持该内部接口时保留旧兼容路径。升级 Vditor 时必须重跑浏览器回归。

`npm run test:editor-input-browser` 使用临时静态服务器和独立 Chrome 页面，不访问用户数据。测试需要可导入的 `playwright` 和本机 Chrome；也可用 `DUMBPAD_PLAYWRIGHT_MODULE` 指定已安装 Playwright 模块的绝对路径。覆盖逐帧标记/光标检查、CDP 中文组合输入、提交后主动移动光标、高亮编辑、撤销/重做及图片附近视口检查。CDP 组合输入不替代真实系统输入法验收；该浏览器测试不包含在 `npm test` 中。

本次已通过 `npm run check`、`test:hybrid-editor-time-command`、`test:hybrid-editor-caret-stability`、`test:source-mode-roundtrip`、`test:editor-noop-save-guard` 和 `test:editor-input-browser`；没有运行全量 `npm test`。图片跳动未在独立样例中复现，相关视口检查通过不能代表原复杂文档的问题已解决，本次未修改滚动逻辑。移动端系统输入法、复杂嵌套列表和原图片场景仍保留为后续验收项；本次先固化稳定点，不继续扩展修复或更换编辑器内核。

### 普通 Enter 的兼容性边界（Tiptap 适配器）

`HybridMarkdownEditor`（Tiptap 适配器）不把所有 Enter 交给内核。`SoftEnterShortcut`（`public/managers/tiptap-extensions.js`）仅在无修饰键、非组合输入、同一顶层普通段落且不在内联代码时拦截事件，用框架命令插入软换行并异步同步编辑器值；标题、列表、引用、代码块继续走 Tiptap 原生键位。不要把它改写为“完全交给内核”或“直接清理 Markdown 空行”：Vditor 时期这些改法曾分别导致首次 Enter 被吞、块模型错乱或源码出现空段。行为基线是 `refactor-ai-s3-thoughts` 分支（Vditor 时期）；回归检查为 `npm run test:tiptap-roundtrip`、`npm run test:tiptap-caret`，任何调整还必须做一次真实编辑器手动回归。

> 补充（Tiptap 时期的新增）：软换行之后的「视觉行首」在输入块标记（`# `、`- `/`* `/`+ `、`1. `、`> `）时会**就地拆块并应用块类型**，与刷新后的解析结果一致——机制见下面要点里的 `SoftBreakBlockRules`；回归是 `npm run test:tiptap-soft-enter-block-rules`（jsdom，结构与往返）与 `npm run test:editor-input-browser`（真实按键 + 「打字结果 == 重新解析结果」）。

> 历史（Vditor 内核时期）：对应实现为 `public/hybrid-editor.js` 的 `handleWysiwygSoftEnter()`，拦截条件与现在一致，插入零宽光标保护字符并异步走 `notifyEditorValueChanged()`；结构回归检查为 `npm run test:hybrid-editor-time-command`。

### Tiptap 适配器要点

- **bundle 与运行时转发**：`scripts/tiptap/entry.js` 把 `@tiptap/core`、StarterKit、tiptap-markdown、扩展与 lowlight 打包为 IIFE（`window.DumbPadTiptap`）；`public/managers/tiptap-runtime.js` 以 ESM 形式转发。改依赖后必须 `npm run build:tiptap` 重建并提交产物。
- **自定义 NodeView 必须挂扩展 `addNodeView`**：Tiptap v3 的 `createView` 只认 `extensionManager.nodeViews`；`editorProps.nodeViews` 会在首次 `setEditable` 前被整体忽略（此前仅靠阅读模式切换间接触发生效）。现挂载点：`DumbPadCodeBlock`、`DumbPadTaskItem`（`public/managers/tiptap-extensions.js`）。
- **代码块高亮走官方 `CodeBlockLowlight`**：PM Decoration 给文本加 `hljs-*` 类，不动 DOM；lowlight 常用语言随 bundle 分发，frontmatter 假代码块通过 YAML 别名高亮。浅色 token 配色来自 `index.html` 直接加载的 `github.min.css`，暗色覆盖在 `styles.css`。
- **frontmatter 有三条入口，存储形态必须同一个**：`setValue` 靠 `frontmatterToFence` 把文档最前方的 `---…---` 预转成 ```` ```dumbpad-frontmatter ```` 围栏，`getValue` 的 `fenceToFrontmatter` 反向映射回原文；**粘贴不走这条路**——tiptap-markdown 的 `clipboardTextParser` 直接 `md.render(粘贴文本)`。所以 markdown-it 的 block ruler 里必须有 `dumbpad_frontmatter` 规则（`DumbPadFrontmatterParseRule` 只借 `storage.markdown.parse.setup` 注册，不新增节点，与 `DumbPadMixedTaskListGuard` 同套路），否则首个 `---` 解析成 `<hr>`、第二个被 setext 当标题下划线吃掉，`---\ntitle: x\n---` 落库变成 `<h2>` 且少一行 `---`（保存后不可逆）。规则条件与 `FRONTMATTER_LEAD_RE` 同宽：只在首行、要求闭合 `---` 独占一行且中间至少隔一行（`---\n---` 是两条分隔线，不是 frontmatter），否则两条路径互相错开导致解析抖动。注意 `setup` 每次 parse 都会被 tiptap-markdown 重跑，注册必须按 markdownit 实例去重（WeakSet），否则 `__rules__` 随粘贴次数线性增长。**第三条是打字**：`FrontmatterLeadInputShortcut` 让文章**最开头**手打 `---` 当场转正为同一个代码块（Typora 语义），门槛=文档第一个块 + `doc > paragraph` + 段落里只有这三个连字符 + 光标在段末 + 空选区，转正用单事务 `replaceRangeWith`（只有一个空段落时「先删后插」会留下非法空 doc），光标落进块首直接打 YAML；其它位置的 `---` 仍产分隔线。`priority: 110` 是显式的：实测降到 1 就被官方 HorizontalRule 抢走，与官方同为默认 100 时靠扩展声明顺序恰好也能赢，但那个并列次序是实现细节、不该依赖。上面这套与未注册的 `FrontmatterNode`（自有节点方案）是两条路线，不要同时启用。回归：`npm run test:tiptap-roundtrip` §9、`npm run test:tiptap-frontmatter-input`、真机 `npm run test:editor-input-browser`。**真机渲染形态与 jsdom 不同**：NodeView 的 `<code>` 只有 `hljs` 类，语言在 `.dumbpad-code-language-token[data-language-label="frontmatter"]` 徽标上，DOM 断言别按 `code.language-*` 写。
- **分隔线的实时转换只补「视觉行首」这一档（`DividerInputShortcut`）**：官方 HorizontalRule 只有 `/^(?:---|—-|___\s|\*\*\*\s)$/` 一条规则，`^` 锚 PM 块首，而 Enter 造的是段内 `<br>`（`MdSoftBreak`）不是新块——`甲` + Enter + `---` 在屏幕上永远是字面文本，序列化仍是 `甲\n---`，**重新解析被 setext 当成标题下划线**（`甲` 变二级标题、`---` 被吃掉），这是「打字时 ≠ 刷新后」里最重的一档：静默改内容。修法与 `SoftBreakBlockRules` 同形状（`softBreakRulePosition` 复核真 hardBreak 并吞掉连续软换行 → 删「软换行+缩进+标记」→ `splitBlock` → `setHorizontalRule`），落盘 `甲\n\n---` 两个方向都稳定；粘贴 `甲\n---` 仍按标准 Markdown 解析成 H2（另一条入口，自身往返稳定）。三个刻意决定：① 按分隔线解释而不是当场把上一块变 H2（setext 不是笔记场景要的结果）；② **不**放宽 `___` / `***` 的尾随空格门槛——那是上游留给强调标记的护身符，放宽会把打一半的 `***重点***` 当场切成线；③ 不补 PM 块首分支——块首第 3 个连字符就被官方命中，`----` 的实测结果是「线 + 后面段落一个游离 `-`」，加 `^` 分支只会多一条抢不到的死规则。作用域与围栏规则一致（只有 `doc > paragraph` + 空选区；代码块内、引用块 / 列表项内的软换行不接管——那一档的 setext 漂移是既有缺口，尚未处理）。回归：`npm run test:tiptap-divider-input`、真机 `npm run test:editor-input-browser`。
- **载入文章必须排除出撤销历史（`setValue` 的 `setMeta('addToHistory', false)`）**：编辑器以 `content: ''` 创建、正文靠 `setContent` 灌进来，而它默认进历史，于是栈底那一步就是「空文档 → 整篇正文」：打开文章后按 Ctrl+Z 撤掉的是载入本身，整篇瞬间变空白（用户读作「编辑器不支持撤销，只会清空」）；更糟的是撤销能跨文章——在 A 文里撤出 B 文的内容，autosave 随即把 A 文覆盖掉。boot textarea 交接、WS 远端更新、源码模式切回都走 `setValue`，所以一条 meta 全覆盖。另一半是**撤销粒度**：ProseMirror 把 `newGroupDelay`（默认 500ms）内的连续按键并进同一个撤销组，测试里合成按键之间不留停顿就会「一次撤销把整段打字全撤掉」，需要断言单步可逆时必须跨过这个窗口。回归：`npm run test:tiptap-undo-history`、真机 `npm run test:editor-input-browser`（真按键 Ctrl+Z / Ctrl+Y，且必须用一个干净实例——同一实例里前面用例的打字会让 `can().undo()` 非空）。
- **标题锚点 id 用 PM 节点 Decoration 渲染（`HeadingAnchor`）**：直接改 PM 管辖 DOM 的属性会被 DOMObserver 在重绘时抹掉；id 同步经 meta 事务（不含步骤，不进历史、不触发保存），id 不带前缀，与 `app.js` 的目录查询契约一致。
- **目录跳转的落点闪光用 PM Decoration（`JumpTargetHighlight`）**：与 HeadingAnchor 同一教训——旧实现给落点元素加 `is-jump-target` DOM 类，编辑模式下会被 DOMObserver 抹掉（真机实测从未露面）。适配器 `flashJumpTarget()` 经 pluginKey meta 传入 doc 坐标（`posAtDOM` 反查目标所在块，粒度与搜索块级高亮一致：列表项里的片段闪整个条目），Decoration 渲染 `article-jump-target` 类；docChanged 经 mapping 跟随，2.2s 后 clear meta 摘除。视觉是左侧主色竖条（`::before` 伪元素渐隐）+ 落点文字短暂变主色再渐回 `--text-color`，**不做整块背景**。目录跳转与搜索是两条独立反馈链路：编辑模式点目录走 `focusEditorHeading → scrollToHeadingId({flash:true})`，**绝不把标题文字喂给 `jumpToKeyword`**——那是搜索命中管线，会按全文第一次出现处落高亮（常常不是被点击的标题）并闪 4s 黄块；搜索跳转的 `landHit → scrollRenderedElementIntoView(blockEl)` 不带 flash（默认关），词级+块级黄色高亮不变。回归：`npm run test:toc-jump-highlight`。
- **目录（`app.js` updateToC）的三个时序/降噪约束**：① 片段子条目（划线/高亮/批注；**加粗不进目录**——调研类文章加粗动辄几十处，会淹没标题层级）扫描的是编辑器 DOM，而「缓存先渲染、远端刷新随后改写」流程里 updateToC 先于远端写入执行，收集到旧/空 DOM 后不再重建——远端内容真正写入编辑器后必须补一次 `debouncedUpdateToC()`；② 每区段默认只列前 `TOC_MARKS_PER_SECTION`（3）条，超出折叠为「+N 展开」，展开态存 `tocExpandedMarkGroups`、随文章切换清空；折叠条目（`data-mark-group`/`data-mark-collapse`）没有正文落点，`updateActiveTocItem` 的 resolveTarget 必须返回 null；③ 滚动高亮监听 `.vditor-wysiwyg` scroll **与 window scroll 双通道**——≤980px 整页滚动时编辑器容器自身不滚，只挂容器会漏掉移动端跟随；标题元素按条目缓存（`__tocTarget`，断连重查），滚动帧不再逐条 querySelector。探针线（容器 top + max(24, 高度×18%) + 2）与跳转锚点 18% 是一对，改动必须同步。
- **批注波浪线的连续性有两层，缺一层都还是「断断续续」**：① **schema 层**——PM 渲染行内 mark 时按 schema rank 排序取共同前缀决定开闭元素，`AnnotationMark` 的 `priority` 必须高于 Link（1000），否则一条覆盖链接的批注被切成三个 `.has-annotation` + 三个徽标，序列化还会把 `<sub>（批注）</sub>` 写进链接 label 内部（`[<span data-note>…</span><sub>…</sub>](url)`）；跨行内代码靠另一条机制——`code` mark 的 `excluded` 里豁免装饰类 mark（`tiptap-editor.js` 的 `create` 钩子，名单是 `annotation` / `draw` / `mdHighlight`），两者都要。历史数据里已经存成「批注-代码-批注」拆段形态的，由 `normalizeDecorationMarks()`（三个装饰 mark 共用一条事务）在 parse 后用 `addMark` 连接（事务带 `dumbpadNormalize` meta：不进撤销历史、不触发保存；**gap 里只要有一个节点不带 `code` mark 就不连**——裸文本、加粗、链接都算，所以用户故意分开的两条不会被误合并）。② **绘制层**——Chrome 的 `text-decoration-skip-ink` 默认 `auto`，会在空格与标点这类「无墨」处把波浪剪断，`styles.css` 用一条 `text-decoration-skip-ink: none` 覆盖 `.has-annotation > span`（编辑器）与 `span[data-note]`（分享页 / Thought 卡片的内联 style 形态）。**不要把 skip-ink 写进 `ANNOTATION_SPAN_STYLE`**——那串 style 是落盘内容的一部分，改它等于改数据格式。回归：`npm run test:tiptap-underline-annotation` §11–13 + `npm run test:tiptap-underline-annotation-browser`（computed 值只有真浏览器算得准）。
- **画线 / 高亮的「一次操作 = 一个整体」同样靠 mark rank（`DrawMark: 1090` / `MdHighlight: 1080`）**：与批注一条根因、一条修法。rank 在 link / bold / code 之后时，一次画线跨链接会被 `<a>` 前后各断一次，落盘是三段 `<span data-draw>`，刷新后 `getMarkRange`（选区菜单 `posRangeForElement` 的取消范围）只能沿连续段展开成 `1-2 / 3-5 / 6-7`——**点一次「取消画线」只去掉一段**。抬到 Link 之上后实测跨链接 / 跨加粗 / 跨斜体删除线下划线 / 跨时间标记 / 画线与高亮互相叠加都是单 span，且「打字时的取消范围 == 刷新后的取消范围」、序列化幂等；次序固定为 annotation 1100 > draw 1090 > mdHighlight 1080 > Link 1000（批注必须始终最外层，徽标归属靠它）。两条边界要知道：① mark 组合变化处 DOM **必然**分段（`前` / 批注里的 `批注` / `后` 三个 span，这是 PM 渲染规则、与 rank 无关），但 `getMarkRange` 沿「带该 mark 的相邻文字」展开会跨过去，所以取消仍是整体；② 行内代码**不再是禁区**：`code.excluded` 的豁免名单从「只给 annotation」扩到 `draw` / `mdHighlight`（`tiptap-editor.js` 的 `create` 钩子只过滤这一个数组，`bold` / `italic` / `link` 保持默认排除语义），跨代码片段是单 span，且 `<code>` 仍在外层 span 内部——代码自己的 monospace 不丢（真机实测画线 `underline solid 2px`、高亮背景 `rgba(255, 214, 10, 0.35)`、打字与刷新一致），取消一次清干净；反向「先画线再给中间文字打行内代码」同样不再切断画线。旧数据里已经固化成两段的由 `normalizeDecorationMarks()` 载入时连回一条。原先那条「跨代码时每段以空格收尾，刷新后取消范围比打字时短一个空格」的偏差随拆段一起消失——它本来就是分段造成的。**仍然存在的边界**：跨**段落**的选区是每个 textblock 一个 mark 实例，而 `getMarkRange` 只在同一 textblock 的兄弟节点间展开，所以取消仍要按段点（Ctrl+Z 撤掉一次多段应用仍是一步）。要让跨段也是一个整体，就得给操作一个可持久化的身份属性，那是存储格式变更，不在这里做。回归：`npm run test:tiptap-selection-menu`（含端到端点击取消、跨代码单段、旧数据自愈、gap 非代码时不合并）+ 真机 `npm run test:tiptap-underline-annotation-browser` §8。
- **移动端卡片几何**：编辑卡片（`pre.vditor-reset` / `.tiptap`）的移动端实测几何（贴顶、10px 内边距）与桌面几何（64px margin / 24px 上下 padding）分别在 `styles.css` 与 `ios-theme.css` 的对应 media 块内，两代卡片元素必须同时写进选择器。
- **选区浮动菜单（TiptapSelectionMenu）**：`public/managers/tiptap-selection-menu.js`，作为扩展挂进编辑器；插件 view 负责菜单 DOM 生命周期（不监听全局 selectionchange），定位用 PM `coordsAtPos`，jsdom 等无布局环境定位失败只跳过、不隐藏菜单。菜单只在**鼠标释放后**出现：mousedown 进入拖拽态拦住选区事务期间的显示，mouseup 宏任务后主动补一次显示判断（拖拽后没有新事务，不能只靠 update()）——这一步在空选区 / 受保护选区必须走 `hide()` 而不是直接 `return`，否则「先选中文字、再点图片」会把上一次的菜单留在图片上（拖拽态已拦住 `update()` 的隐藏分支，只靠它收不掉）。动作必须走框架 mark 命令（`DrawMark` / `MdHighlight` / `AnnotationMark`），落标记/复制后光标折叠到标记起点；禁止回到 Markdown 源码做字符串查找 + `setValue` 全量重刷（旧 Vditor 时期的字符串手术路线，会重引入 IME/光标/撤销的补丁对抗）。点击已标记文字弹「取消」popover：直接在 `view.dom` 挂 click 监听（与旧 `bindAnnotationPopover` 同机制），**不要用 PM 的 `handleClick` prop**——它依赖 PM 鼠标管线（posAtCoords / view.mouseDown 状态机），无布局环境与部分真实场景不可靠；取消/编辑走 `removeMark` / mark attrs 更新（可撤销）。代码块、内联代码、时间标记与**图片**选区不显示菜单（mark 禁区；点图片产生的是非空 NodeSelection，图片让位给 `TiptapImageInteractions` 的尺寸/大图菜单）；源码模式不显示（`setSourceMode` 切换容器 `is-source-mode` 类，与 `is-reading-mode` 同构）。回归：`npm run test:tiptap-selection-menu`。
- **文章图片/附件交互（TiptapImageInteractions）**：`public/managers/tiptap-image-interactions.js`，作为扩展挂进编辑器。图片宽度与 `dumbpad-article-image` 类名由 PM 节点 Decoration 渲染（`Decoration.node` 的 attrs 会合并到 `<img>` 上，与 `HeadingAnchor` 同机制）；**不要**改成 NodeView 或直接改 PM 管辖 DOM，也不要把宽度塞进存储形态——markdown 仍是 `![alt](url "dumbpad-width=N")`。插入图片的默认宽度是 `article-file-command.js` 的 `DEFAULT_ARTICLE_IMAGE_WIDTH`（360，窄档），`/file` 与「设置 → 附件」的插入共用它。尺寸 / 删除 / 换位走框架命令（`setNodeMarkup` / `delete`；换位是 `delete`+`insert` 单个事务，进撤销历史并自然触发保存）。位置一律反查、不猜文本，元素被重绘替换时放弃动作，且**收起菜单要排在守卫之前**（目标失效时不能把浮层留在屏幕上）。换位靠指针流程（`pointerdown/move/up` + 6px 阈值）：`DumbPadImage = Image.configure({ allowBase64: true }).extend({ draggable: false, addStorage })`——`draggable: false` 只关掉 PM 自己的节点拖拽，`<img>` 自身的原生拖拽必须另用 `view.dom` 的 dragstart 拦截（附件链接同理，否则内容会被拖出编辑器或触发 drop 插入）。`allowBase64: true` 与自带的 markdown 序列化是**两处内核默认会做错**的地方，改动前先读：内核默认 `allowBase64: false`，schema 里 `img[src]:not([src^="data:"])` 会把旧笔记的 Base64 内联图片整节点丢掉（静默删内容）；内核内置的 image 序列化不回 `closeBlock`，块级图片后面会让下一个块粘在图片 markdown 后面（`![图](url)\n\n段落` → `![图](url)段落`，重新解析图文合并——紧贴的 `# 标题` 会退化成段落里的 `\# 标题` 源码），所以这里逐字节复刻内核实现（alt 走 `state.esc`、src 只转义括号、title 只转义引号）再补 `closeBlock`。落点优先用 `document.elementFromPoint` 找顶层块、按指针与块中线决定前/后（拿不到块高时算「块之前」，与旧实现一致）；拿不到块时按「首块之前 / 末块之后 / 垂直最近的块」兜底，否则拖到文末会静默失效。**块 DOM → 文档落点不能用 `posAtDOM(block, 0)`**：它对非叶子块返回的是「块内容起点」（起点 + 1），空段落会解析成 `null`（拖拽静默失效），非空段落会算成块内位置（插入时把段落切开）；要按 doc 子节点顺序用 `view.nodeDOM(pos)` 身份比对取块边界。菜单与 lightbox 的 DOM 生命周期挂在插件 view 上，点击走 `view.dom` 的 DOM 监听、挂在**捕获阶段**（`addEventListener('click', handler, true)`），不用 PM 的 `handleClick` prop。**但捕获阶段的 click 拦截挡不住 Tiptap 的 Link 扩展**：Link 默认 `openOnClick: true` 注册的那个 PM `handleClick` 由 prosemirror-view 在 **`mouseup`** 里派发（`LeftMouseDown.up → handleSingleClick → someProp('handleClick')`，`view.dom` 上并没有 click 监听器），永远早于 `click` 事件本身，所以任何 click 阶段（含捕获）的 `preventDefault` / `stopPropagation` 都追不上它——它对链接调 `window.open(href, target="_blank")`，附件的 `/download` 于是表现为「先下载、菜单随后才出现」。正确出口是在扩展接线处关掉：`public/tiptap-editor.js` 的 `StarterKit.configure({ link: { openOnClick: false } })`。关掉之后编辑模式「裸 URL 可点开」的能力由本文件的 `openBareLink()` 按旧 Vditor 基线补回：只有「链接文本就是 URL」的链接打开，`[文字](url)` 不打开（阅读模式一直是浏览器原生行为，不经过 PM 的 handleClick）。捕获监听仍然保留——它抢在同节点其它冒泡监听之前拿到这次点击，并 `preventDefault` 兜住浏览器原生激活。**jsdom 的 DOM 探针只能证明「事件未到达目标元素」，证明不了 PM 的真实行为**（jsdom 里 PM 走不到 `posAtCoords` / `view.mouseDown` 鼠标管线），断言必须落在真实浏览器里：零 `window.open`、零下载、只弹一个菜单，见 `npm run test:tiptap-attachment-click-browser`；除动作路径外还有三条收起路径——document 级 mousedown（点菜单外，触发元素本身除外，否则触屏补发的兼容 mousedown 会刚开就关）、插件 view 的 `update()`（目标 `isConnected` 为 false 或切到源码模式）、动作成功路径。附件链接：`a.dumbpad-article-file` 类由 link mark 的全局属性（`DumbPadArticleFileLink`）条件渲染——`Decoration.inline` 只会把 class 落在内层 `<span>`，命不中既有 CSS；判定只看 `title` 前缀（不要求 href 形如 `/download`）；label 不再带 `📎`（图标由 `styles.css` 的 `a.dumbpad-article-file::before` 以 mask 提供，与 Thoughts 附件卡同一套视觉），旧 label 的 `📎` 由同一扩展的 `addStorage().markdown.parse.updateDOM`（解析期归一化 `stripLegacyFileLabelEmoji`）去掉；附件链接的文本范围以渲染元素自身的 DOM 范围为准（`pos+1` 的 mark 反查在「单字符链接紧邻另一个链接」时会命中邻居）。`/file` 打开的是原生文件对话框，期间焦点在隐藏 input 上，插入完成 / 取消 / 源码模式三条路径都要 `restoreEditorFocus()` 把焦点与光标交还编辑器，否则用户看不到插入点、要继续打字得先手动点一下。回归：`npm run test:tiptap-image-menu`、`npm run test:tiptap-roundtrip`；附件点击的下载路径只能在真实浏览器里断言，`npm run test:tiptap-attachment-click-browser`。
- **段内软换行绝不能继承 `link` mark**：Enter（`SoftEnterShortcut`）与 Shift/Mod-Enter（`MdSoftBreak.setHardBreak`）统一走 `tiptap-extensions.js` 的 `insertSoftBreak()`。PM 的 `tr.replaceSelectionWith(node)` 默认让插入节点**继承光标处的活跃 mark**，而链接文本里的活跃 mark 就是 `link`（Link 还是 inclusive 的，光标贴在链接右边界时也算）——`<br>` 于是落进 `<a>` 里：`inline-flex` 的附件胶囊被撑成一整块空白（多次回车越来越高），且序列化会把换行写进链接 label（`[甲\n乙](url)`），保存后重新解析就坏了，属数据损坏。规则：光标在链接文本**内部** → 换行插到整条链接之后并把光标跟过去（用户按回车要的是「下一行」，不是把 label 剪开）；光标贴在链接**边界** → 位置不变但 `inheritMarks = false`；与链接无关的段落保持原语义（普通段落仍是段内软换行、空段落仍由框架默认分段）。另一条坑：命令实现必须用 Tiptap 传进来的 `(state, dispatch)`，不要自己拿 `editor.view.dispatch`，否则会撞上 `Applying a mismatched transaction`。回归：`npm run test:tiptap-soft-enter-link`（jsdom 断言结构与 markdown）+ `npm run test:tiptap-attachment-click-browser`（断言真实高度：回车前后 chip 高度差 ≤1px）。
- **软换行的「视觉行首」= 块标记的触发点（`SoftBreakBlockRules`）**：Enter 造的是段内 `<br>`，不是新块，而 StarterKit 的块级输入规则全部 `^` 锚定、只认 PM 块首，所以 `# `/`- `/`1. `/`> ` 曾经只在真块首生效，软回车后留下字面文本要刷新才渲染。磁盘格式本来就正确（`Markdown.configure({breaks:true})` 下 `甲\n# 乙` 重新解析就是 `paragraph` + `heading`），缺的只是输入那一刻的行首判定，因此**不动回车语义、不动存储格式、不迁移老文章**，只补规则。实现要点：① find 以 `\n` 开头（`MdSoftBreak` 的 `leafText: () => '\n'` 是前提，否则 runner 的匹配串与 textBetween 复核都对不上）；② 不能只放宽官方规则的锚定——`textblockTypeInputRule` 与 `wrappingInputRule` 的 handler 作用范围是整个块（`setBlockType(块范围)` / `findWrapping(块范围)`），会把上一视觉行一起吞进块类型；③ 所以命中后自己拆：`deleteRange(软换行 → 光标)` 一次吃掉「换行 + 缩进 + 标记」→ `splitBlock()` → 只对后半块跑框架命令（`setNode('heading',{level})` / `toggleBulletList()` / `toggleOrderedList()` + `updateAttributes('orderedList',{start})` / `toggleBlockquote()`），保持单个事务（撤销是一步，不会留下「标记删了没拆块」的半截态）；④ 门槛与 `SoftEnterShortcut` 一致：只有 `doc > paragraph`，且拆块点必须真是 `hardBreak` 节点——文本节点里的裸 `\n`（异常/粘贴数据）不算软换行，实测不会误拆；⑤ 换行与标记之间只允许 `[ \t]`（不是 `\s`），连按两次 Enter 的空行会被拆块点一并吞掉，不在上一块尾部留游离 `<br>`，缩进也不会写回源里（`甲\n\n    - 乙` 重新解析会变缩进代码块）。与列表内 `[ ]` 规则天然接力（软换行 → `- ` → `[ ] ` = 任务项）；⑥ **非空选区不接管**：runner 的匹配串只取到选区**起点**，能命中这条规则的形状是「选区在标记右侧」，少了 `state.selection.empty` 守卫，`deleteRange` 会连选中的文字一起删掉并换成空标题（静默丢内容）。`---` 分隔线、表格等整块语法不在这里扩展（``` 围栏跨行且要整体转块，拆块表达不了，由下一条的 `CodeFenceInputShortcut` 接管）。回归：`npm run test:tiptap-soft-enter-block-rules` + `npm run test:editor-input-browser`。
- **手打围栏的当场转正（`CodeFenceInputShortcut`）与混排列表守卫（`DumbPadMixedTaskListGuard`）**：① 旧 Vditor 靠「软换行后异步同步编辑器值 → Lute 重解析」顺手把段落里敲的 ```` ``` ```` 变成代码块；Tiptap 没有这一步，反引号留在段落里被序列化转义成 `\``，源码从此被污染、围栏永远变不成代码块（解析侧正常：未转义源码 `setValue` 直接解析成 codeBlock）。`CodeFenceInputShortcut` 两条输入规则：**开栏行 + 回车当场开块（主路径）**——```` ```c ```` + 回车立即得到代码块、光标落进块内，此后输入都在块内，不必再敲收尾围栏（退出走官方三连回车 / 方向键 / Mod-Enter）；**完整围栏补转（兜底）**——收尾反引号落下时把围栏整体转正为 `codeBlock` 插到段落之后，前缀留在原段落、吃满整段时段落让位，单事务可撤销。关键内核细节：runner 在 Enter 键位上以**串尾虚拟 `"\n"`** 补跑规则（IME `compositionend` 补跑则是空串），开栏 find 容忍可选串尾 `\n`；「匹配串去掉虚拟换行后与文档尾段逐字一致」的复核挡住逐字打字的抢跑（```` ```cp ```` 打到 `c` 时不把想继续打的 `pp` 关进块）。守卫：`doc > paragraph`、空选区、光标在段末（「```尾文」不是合法 CommonMark 收尾）、开栏在视觉行首（软换行分支要求 `range.from` 是 `hardBreak` 并向前吞连续软换行；块首分支要求 `range.from === $caret.start()`，防 runner 500 字符窗口截断让 `^` 误中段中）。只认反引号围栏；空段落 ```` ``` ```` + 空格仍由官方 CodeBlock 规则接管。已被转义污染的存量源码不迁移（转义反引号是合法字面文本）。已知取舍：块自动打开后习惯性敲的收尾 ```` ``` ```` 是块内字面文本。回归：`npm run test:tiptap-code-fence-input`。② `- [ ] 甲` 与 `- 乙` 同列表时（谁打头、怎么交错都算） markdown-it 输出单个 `ul.contains-task-list`，tiptap-markdown 的 `TaskList.parse.updateDOM` 无条件整条盖 `data-type="taskList"` 章——普通 li 塞不进 `taskItem+` 内容模型，PM 装配凭空吐一个空 taskItem（页面多一个空待办）并在保存时固化成 `- [ ] `。守卫扩展在解析 DOM 上把混排列表**就地拆成同级的纯种列表段**（按条目顺序：连续任务项归 `ul[data-type="taskList"]` 段、连续普通项归普通 ul 段，原 ul 退位；纯任务列表不动）——只撤章不够：任务项打头的混排里，撤章后的普通 ul 首个孩子装不进 `listItem+` 内容模型，PM 同样会凭空插一个空 listItem（空圆点，保存固化成 `- `）。**不能靠覆盖 `addStorage` 实现**：内核收集 markdown 配置是浅合并（`{...默认, ...storage.markdown}`），覆盖 `parse` 会把上游 `setup`（github-task-lists 插件，`[ ]` 识别全靠它）挤掉。已知取舍：紧凑混排首次保存后两列表间多一个空行（之后幂等）。回归：`npm run test:tiptap-mixed-task-list`。
- **引用块（`>`）的按键语义与视觉**：`blockquote > paragraph` 与 `doc > paragraph` 共用软换行通道（`tiptap-extensions.js` 的 `softBreakScope()`），所以块内回车是段内 `<br>`（存成 `> 甲\n> 乙`，中间无空行），不再走 PM 的 `splitBlock`——后者会写出 `> 甲\n>\n> 乙` 这种「中间一行只有 `>`」的污染源，重新解析就是一个幽灵空行。空视觉行上回车 = `exitBlockquoteLine()` 离开引用块，并且必须**删掉刚插入的那个 `<br>`**（留着会序列化成 `> 甲\n> `，下次解析又是空行）；`$pos.before(depth)` 指向段落的开标记，所以内容位 0 = `paraStart + 1`，删 br 的偏移是 `paraStart + start` 而不是 `-1`。行首退格由 `QuoteBackspaceShortcut`（**`priority: 1000`**，必须早于 PM 基础键位，否则默认 `joinBackward` 先把整行抬出引用区）交给 `joinQuoteParagraph()`：同一引用块内用 `tr.join()` 并段；单段引用且上一块是同类型文本块时用「合并后的整块 `replaceWith`」——**PM 的 `delete` 会把「只删包装标记」的区间规范化成无操作**（实测事务无变化并报 `Inconsistent open depths`），所以 delete+join 那条路走不通。老数据不迁移，按一次退格即自愈。视觉：3px 圆角浅灰竖线由 `blockquote::before` 画（伪元素不进 DOM，PM 解析/存储不受影响），正文 `font-style: normal` + 比正文浅一档的 `color-mix`；块内最后一个子块 `margin-bottom: 0` 必须写两处——桌面端 `.vditor-reset p { margin-bottom: 14px }` 优先级更高，`ios-theme.css` 里同段还要再压一次。回归：`npm run test:tiptap-blockquote-input`（jsdom 状态转移）+ `npm run test:blockquote-style-browser`（真 Chrome computed style，含亮度与悬空像素两条量化断言）。
- **Mermaid 渲染归代码块 NodeView 管**：`\`\`\`mermaid` 的语言只存在 `node.attrs.language`（渲染出的 `<code>` 只有 `hljs` 类，徽章上是 `data-language-label`），所以任何 `pre code.language-mermaid` 形式的选择器都命中 0 个节点——旧 `renderMermaidDiagrams()` 就是这么静默失效的。现在：`public/managers/mermaid-render.js` 负责按需注入 bundle、按 `data-theme` 初始化、清掉 mermaid 塞进 `<body>` 的临时节点、只返回 svg 字符串；`tiptap-code-block-view.js` 负责状态机。三条硬约束：① svg 必须插进 wrapper 的**兄弟 div**，绝不能写进 `contentDOM`（`code`），否则 PM 丢代码文本、第二次渲染还会把 SVG 当源码；② 「光标是否在块内」要同时看选区范围**与 `editor.isFocused`**，并用严格包含（`from > pos && to < pos + nodeSize`）——PM 初始光标正好落在首块内容位起点，只看范围的话以 mermaid 开头的文章会永久停在源码态；③ `setEditable()`（阅读模式）不派事务，靠 `document` 上的 `dumbpad-mermaid-refresh` 事件补，`NodeSelection` 靠 `selectNode`/`deselectNode` 补；`ignoreMutation` 对 contentDOM 之外的一切返回 true。语法错误 mermaid v11 直接 reject，处理是保留源码 + 一行提示，存储里永远只有源码。写测试时的坑：`commands.insertContent('\nB-->C…')` 按 HTML 解析字符串，会把 `>` 变成 `&gt;`（假故障），改源码必须走 `tr.insertText`。另外 `new CustomEvent()` 在只挂 `global.window` 的 jsdom 宿主里会解析到 Node 自带实现、被 jsdom 的 `dispatchEvent` 拒收，所以构造器要从 `document` 所属 window 取。回归：`npm run test:mermaid-preview-browser`。
- **样式完整性守卫（`npm run test:css-integrity`）**：两次真实崩坏（误删 `editorProps.attributes` 里的 `tiptap ProseMirror vditor-reset`；误删 `styles.css` 某条规则的收尾 `}`）在 console 里都没有任何 JS 报错，看日志查不出来——未闭合的 CSS 规则会被解析器一路吞到下一个 `}`，那条之后的所有规则集体失效。`npm run check` 只做 `node --check`，不校验 CSS，所以这条守卫是唯一的自动闸门：每个 `public/Assets/*.css` 剥掉注释与字符串后 `{`/`}` 必须配平、引用块那几条规则必须还在、编辑器内容根必须真的带上那三个类。**改 CSS 或编辑器骨架字符串后必须跑它。**
- **保存语义**：前端输入即写本地脏缓存，静默 `NOTE_SAVE_DEBOUNCE_MS`（5s）后 POST；切换笔记与 `pagehide` 时由 `flushPendingNoteSave()` 兜底（keepalive，≤60KB）。服务端对内容未变化的保存返回 `unchanged` 且不计版本、不刷 `updatedAt`、不广播（契约见 `docs/api.md`）——只有真实内容变化才计入一次修改。

## 4. Thought 写入流程

1. 用户创建、修改、删除 Thought。
2. `ThoughtsManager` 先做 UI 乐观更新。
3. HTTP 请求统一通过 `ThoughtApiClient`。
4. 请求失败时，`ThoughtsManager` 把待同步操作交给 `ThoughtOutbox`。
5. `ThoughtOutbox` 保留原有 outbox 数据格式，写入 `localStorage`。
6. 网络恢复或用户点击“待同步”按钮时，`ThoughtsManager` 调用 `ThoughtOutbox.retry(apiClient)`。
7. 服务端成功写入 Thought 后，AI 队列异步生成 meta 和 relation；前端通过 WebSocket 刷新状态。

这个流程要求快速记录不等待 AI，不等待 S3 之外的额外流程，也不因为离线而丢失本地输入。

## 4.1 今日草稿写入流程

今日草稿是一行用户数据，存放在独立的 `today-drafts.json`（S3 同名 key）中，不进入 Thought 的 AI、标签、关系或垃圾桶流程。服务端以自己的本地日期为准，保留 3 天窗口（今天 + 前 2 天）：每次读写先清理滑出窗口的项，再在 Today Draft 写锁内创建、更新或删除窗口内单条记录——创建可携带窗口内的 `day`（离线草稿跨午夜重放时落回原日），更新永远保留原 `day`。前端先保存本机窗口缓存并写入 outbox（克隆携带 `day`）；联网后按 id 回放 PUT/DELETE，服务端成功后以返回版本更新本机项。`today_drafts_update` 只携带受影响记录，收到后对未处于本地待同步状态的单条记录做局部合并。前端翻页视图只在今天页开放编辑与行级滑动手势，历史日整页只读。

展示侧的一天不止一页。纸面高度固定、溢出裁掉，所以单日草稿超出纸面时按 44px 纸纹切成同一天的多页，与跨日翻页共用一条页序列（`today-drafts-paging.js` 的纯函数 + manager 在真实布局里量出的行数）：今天页的预算要扣掉输入行，历史日的输入行是 `display:none` 因此吃满整页；整条草稿不跨页，放不下就整体进下一页；多页时标题旁的日期眉标在原文案后追加 `当前页/总页数`，新增草稿与全局搜索跳转都会先翻到目标条目所在页。单条草稿本身高过整页（粘贴长文）时它独占一页，该页加 `is-overflowing` 开纵向滚动——纸纹挂在书写区自己身上，滚动时行仍落在同一节奏上。手势归属判据（`today-drafts-swipe.js` 的 `isTodayDraftPagerEdge`，行与翻页共用）：**草稿中间约 56% 正文区起笔归行自身操作**（右滑删除 / 左滑转 Thought），**纸张两侧各约 22% 宽度（至少 72px 大拇指舒适区）及空白纸面起笔直接归翻整页**——起手定归属，手势中途绝不交棒变异，避免草稿删除与卷纸翻页动效在中途冲突串台。右滑删除接入通用 `ConfirmationManager` 模态弹窗进行二次确认，确认后才执行滑出动画并物理删除，取消平滑回弹复位，彻底防止误触。第二个翻页入口是眉标的 `N/M`（`index.html` 里它是 `<button type="button">`）：点一下翻向更新的一页、末页回到第 1 页，单日一页时置 `disabled`；`flipToAdjacentPage()` 复用既有的 `beginFlip` / `animateFlipRelease`，只把进度从补间 0 推到 1，落页与记账路径和手势完全同一条。眉标不参与拖拽——手势一认领就 `setPointerCapture`，Chrome 会把随后的 `click` 改派到捕获元素，按钮自己收不到点击。认领名单（`input, textarea, button, a, .today-draft-check, [contenteditable]`）必须排除一切需要原生点击语义的元素：复选框的视觉方块是 `label.today-draft-check` 里的 span 且恰好落在纸边翻页热区内，漏排就会让手势捕获吃掉 label 的激活链（复选框点不上）；行尾复制按钮（`[data-today-draft-copy]`）同理。被认领的普通点按也不再有原生「点击外部即失焦」，manager 在认领 pointerdown 时对活跃的行编辑器手动 `blur()`，接住「点空白纸面收起编辑态、删掉空草稿」的路径；捕获必须认领即生效——若推迟到拖拽起步，中间约 14px 的无捕获空窗会被 Chrome 的原生手势（文字选择等）以 `pointercancel` 接管，指针流当场断掉。失焦清场（删空草稿 / 还原展示态）延迟到独立任务执行：focusout 由 mousedown 触发时指针序列还在半途，同步重绘会换掉 mouseup 落点下的元素、click 直接丢失。正文排版与纸纹对齐：时间戳不占网格列（绝对定位挂在右上角，与正文内容区同一条边线），首行用 `::before` 的 44px 右浮块让位，第二行起正文吃满整幅纸宽，编辑态由 `:has(textarea)` 收起时间戳。行尾复制按钮 inline 跟在展示态正文末尾，平时隐藏且不参与命中（防止摸黑误触复制），桌面 hover 行 / 键盘聚焦 / 触摸按住行（`is-copy-reveal`，抬手后短暂保留）时亮出；点击经 `copyDraftText()` 写剪贴板（非安全上下文降级 `execCommand`，双失败以 error toast 响亮报错），成功后行闪高亮、图标短暂切 `is-copy-success` 对勾再自动复原。行内编辑保护：编辑中草稿由 `hasActiveDraftInput()` 守护，450ms 防抖同步与 WebSocket 推送不撕毁 DOM（记账入 `pendingRender`），`isRendering` 锁屏蔽 DOM 脱轨引发的重入报错，强制重绘跟踪活跃条目页码，失焦后安全恢复展示态。跨午夜重置视图时日与页一起回到今天第 1 页。回归：`npm run test:today-drafts`（工作区 + HTTP + outbox + 分页纯函数 + 行内编辑生命周期 + 复制按钮与失焦让路）、`npm run test:today-drafts-reveal`、真机 `npm run test:today-drafts-flip-browser`、`npm run test:today-drafts-paging-browser`（翻页切分、每页不溢出、新增跳页、超长单条可滚到文末、行中间拖拽归行 / 两侧边缘起笔翻页 / 点页码翻页）与 `npm run test:today-drafts-taps-browser`（复选框在无编辑器 / 编辑器打开两种情形下都可点、空草稿点空白即删且 API 与本机缓存干净、认领点按不翻页、复制按钮 hover 显隐与剪贴板写入、触摸亮出）。

### Thought 时间线分页与局部更新

Thought 页面使用 `GET /api/thoughts?format=page&light=1&limit=30&sort=timeline`：首屏只请求 30 条，底部“加载更多”和滚动哨兵按相同游标继续取数。`sort=timeline` 是页面专用排序，严格复用前端的置顶、完成状态、创建时间顺序；默认分页仍按 `updatedAt` 排序，保留给同步程序使用，二者不能混用游标。

服务端在 `STORAGE_LAYOUT=split` 下会通过 `storage.listThoughtsPage()` 读取既有的 `indexes/thoughts-index.json`，先在索引中完成标签、日期、完成状态与游标筛选排序，再只读取当前页的 Thought 文件。索引缺失、旧索引没有时间线字段、对象缺失、`legacy` 布局以及任意关键词全文搜索时，都回退到完整读取；回退会修复 split 索引，不能以不完整结果代替用户搜索结果。这样 S3 的无关键词列表从“列举并读取全部对象”降为“一份索引加最多 30 个对象”。

`ThoughtsManager` 将“已从服务端取到的条数”和“已插入 DOM 的卡片数”分开管理：前者由游标追加，后者仍按 30 张批量插入。完成和置顶不调用 `render()` 清空时间线，而是仅重建被操作卡片，并在当前可见批次内移动、补入或移除卡片。筛选条件改变时重置游标重新请求，避免只对已加载的局部数据筛选造成漏项。

### 多端 Thought 同步的渲染边界

服务端对 Thought 的 create/update/delete 都会广播 `thoughts_update`；客户端 `handleSocketUpdate()` 先更新内存模型，再交给 `renderSocketDelta()` 决定渲染路径：没有 timeline 输入持有焦点时走常规 `scheduleRender()`；有焦点且焦点在被更新卡片之外时，用 `patchRenderedThought()` 只重建受影响卡片（新建/删除则原位补入或移除），远端变化立即可见；焦点在被更新卡片内部时保持焦点优先，推迟到失焦 flush（此时用户正在该卡上输入，模型已是最新）。`scheduleRender()` 的焦点保持逻辑只应影响“正在编辑的那张卡”，不允许吞掉其他卡的实时更新。

WS 回声应用时对 `this.thoughts` 中的对象做原位 `Object.assign` 合并而不是替换数组槽位：`mutateThought()` 的排队闭包持有同一对象并在轮到时读取 `version`，整体替换会让后续排队请求带旧 `baseVersion` 而撞上自己的回声 409。

inline 子任务新增走“同一输入框链式”流：回车提交后清空输入值、原位插入一条不可交互的预览行（服务端会在落库时重新分配子任务 id，预览行不绑事件避免操作到过期本地 id），输入框保持聚焦，移动端键盘在连续添加期间不收起；失焦或 Escape 后 cleanup 并调度一次完整 render，用服务端 id 的完整绑定行替换预览行。回车带 `isComposing` 守卫，中文输入法确认拼音的回车不会误提交。

多设备同步的浏览器回归：`npm run test:thought-sync-browser`（不在 `npm test` 中，需要本机 Chrome 与可导入的 playwright，环境要求同 `test:editor-input-browser`），覆盖双端互加子任务的实时与刷新可见性、新建 Thought 实时同步、焦点输入期间跨卡片远端更新立即渲染，以及服务端数据与双端 outbox 清空断言。

### 手动关联搜索

Thought 关联面板里的“搜索并手动链接 Thought”使用 `/api/thoughts?q=...&limit=8&light=1`。该轻量模式只返回候选 Thought 的基础字段，不读取每条候选的 AI meta 和 relation count，避免 S3 场景下输入每个字都触发多次远程对象读取。

前端侧由 `ThoughtsManager.queueManualRelationSearch()` 做输入防抖，并使用 `manualRelationSearchSeq` 丢弃过期响应。候选项通过 `highlightSearch()` 高亮当前关键词；如果命中的是子任务文本，候选摘要会同时显示主 Thought 和匹配子任务。

### Thought ID

新建 Thought 使用 `createThoughtId()` 生成 `Date.now()` 加随机后缀的字符串 id，避免同一毫秒内连续创建多个 Thought 时发生 id 碰撞。排序和时间展示仍以 `createdAt/updatedAt` 为准。

## 5. PWA 与移动端性能

PWA 缓存策略分为三层：

- API 请求始终绕过 Service Worker 缓存，保证用户数据实时读取。
- HTML 导航使用 network-first，离线或慢网时回退到缓存的 `index.html`。
- JS/CSS/JSON 这类无 hash 的代码与样式资源使用 network-first，离线或慢网时回退缓存，避免普通刷新继续拿到旧样式或旧模块；图片、字体等稳定大资源仍使用 cache-first。

Service Worker 的核心缓存包含入口页面、主 JS/CSS、Thought 拆分模块和图标。Tiptap bundle（`/vendor/tiptap/tiptap.bundle.js`）和 `tiptap-editor.js` 从安装核心资源中移出，由文章模式按需加载并走运行时静态资源缓存，避免直接进入 `#thoughts` 时抢占移动端首屏网络。`WARM_ASSETS` 额外预热中文字体、代码字体和 highlight 主包；这些资源较大但变化很少，第一次安装或版本更新时缓存，后续打开直接复用。

移动端 CSS 在支持 `100dvh` 的浏览器上覆盖主要容器高度，降低地址栏收起、虚拟键盘弹出时 `100vh` 导致的错位。PWA asset manifest 生成器会排除本地候选图片、临时图标和生成产物，避免把无关资源带进缓存清单。

## 6. 重构约束

- 不改变用户数据结构。
- 不改变已有 API 行为。
- 不把 AI、S3、WebSocket、outbox 放进启动关键路径。
- 不为拆文件而拆文件；只有能降低调用方认知负担时才提取模块。
- 每轮只处理一个领域，并运行对应测试。

## 7. 后续建议

本轮已完成的低风险重构：

1. Thought API client、outbox、关系面板渲染、编辑 helper、过滤排序 helper。
2. Note 启动缓存与 cache 控制器。
3. Settings data panel API adapter。
4. 后端 data-management route module。
5. Storage 和 AI pipeline interface 文档。

后续如继续推进，优先选择一个 route 或一个前端交互领域小步迁移，并在迁移后运行对应测试。
