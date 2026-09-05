# DumbPad 项目技术介绍

本文档描述当前 DumbPad 的主要技术边界和本轮低风险重构后的模块职责。目标是让后续继续添加 Thought、AI、同步和数据空间功能时，优先沿已有边界扩展，而不是继续向大文件堆逻辑。

## 1. 技术栈

- 后端：Node.js、Express、WebSocket。
- 前端：Vanilla JS ES modules、CSS、Vditor、Marked。
- 存储：本地 JSON/txt 文件或 S3 兼容对象存储。
- 搜索：服务端 Fuse.js，数据由 `storage.getSearchDocuments()` 汇总。
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
- `routes/today-drafts-routes.js`：负责 `/api/today-drafts/*` 路由；在独立写锁内按服务端当前日期过滤并清理过期草稿，对单条 PUT/DELETE 校验 `baseVersion`，完成后广播 `today_drafts_update`。

## 3. 前端边界

前端没有构建步骤，所有浏览器代码都通过原生 ES module 加载。新增模块时要同时确认 service worker asset manifest 能覆盖新文件。
Thought 前端 helper 拆分模块有聚合测试入口：`npm run test:thought-modules`。

核心模块：

- `public/app.js`：应用启动、Notepad 编辑与保存、设置页、同步状态、全局快捷键和主视图协调。
- `public/hybrid-editor.js`：Vditor 封装，负责混合编辑、源码模式、阅读模式、目录索引、批注和高亮装饰。
- `public/managers/thoughts.js`：Thought UI 协调层。负责 DOM 插入、每卡事件绑定、乐观更新、toast、筛选、AI/relations 面板入口；全局事件初始化按 Quick Add、视图切换、搜索筛选、outbox、socket 分段，`render()` 负责列表生成，单卡交互集中在 `bindThoughtCardEvents()`，relation panel 事件分发集中在 `handleRelationsPanelClick()`，inline 子任务编辑的输入替换和提交协调分开维护。
- `public/managers/thought-api-client.js`：Thought HTTP client。负责 URL 拼接、`encodeURIComponent`、JSON 请求和带 `status` 的错误。
- `public/managers/thought-outbox.js`：Thought 本地 outbox。负责 localStorage key、队列合并、create/patch/delete/relation 队列项构造、服务端列表合并和 retry。
- `public/managers/today-drafts/`：日期草稿的独立前端模块。store 只保留当天的本机缓存，API client 与 outbox 负责按条重试和版本更新，manager 协调编辑、当天切换、WebSocket 合并与转 Thought 手势。
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
- `public/managers/note-sync-controller.js`：启动缓存与 Note cache 读写控制器，避免缓存细节继续散落在 `app.js`。目录只筛选文章标题；选择已有文章时 `app.js` 先以 `loadNotes(..., { deferRemote: true })` 渲染缓存、再后台校验远端版本。非目录调用仍同步确认，避免该性能优化扩散到保存和冲突处理边界。
- `public/managers/settings-data-panel.js`：设置页数据空间、垃圾桶和云端维护 API adapter。
- `public/managers/ws-client.js`：轻量 WebSocket 客户端，把服务端事件转成浏览器 `CustomEvent`。

### 严重 bug 记录：文章输入时光标乱跳与特殊样式闪烁

**记录日期：2026-09-05。状态：修复已通过独立浏览器回归，用户初步反馈可用；完整真机验收尚未完成。**

症状：在时间标记、高亮前输入，或在已完成/未完成待办项中进行中文组合输入时，特殊样式可能退回源码、闪烁，光标可能跳到其他列表项；此前曾出现“先跳走，再被拉回来”的短暂纠正过程。用户同时报告图片上方输入时视口跳动。此问题按严重编辑体验 bug 记录，因为错误光标位置可能导致后续文字插入错误位置；本次没有确认持久化数据丢失。

根因证据：当前安装的 Vditor 在 `src/ts/wysiwyg/input.ts` 中通过 `SpinVditorDOM` 重新解析输入块，列表场景会重建整个顶层列表及相邻列表，然后利用 `<wbr>` 恢复光标。应用层对同一 DOM 的自定义装饰和光标纠正与该流程产生竞争。独立 Chrome 测试在第二个待办项输入 `abc` 后，修复前两项时间标记均消失并暴露源码，修复后逐帧检查保持标记与当前列表项光标。历史说明中的“约 90ms 异步重建”不是本次确认的固定时序，不应作为设计依据。

失败方案与教训：旧方案使用块文本指纹和偏移定位，在 IME 提交后微任务及 120/280ms 定时器中恢复光标，用户仍能看到跳动后纠正。随后尝试在每次 `MutationObserver` 回调中套用旧快照，用户反馈乱跳加重；该修改已撤掉。不能把任何 DOM 变化都视为需要回放旧光标的位置恢复事件，也不能仅用源码包含某段恢复逻辑的断言证明交互稳定。

文章输入解析通过 `HybridMarkdownEditor.installInputRenderAdapter()` 包装当前 Vditor 实例的 `lute.SpinVditorDOM`。已渲染的时间标记、高亮、批注、划线和上传卡片在脱离页面的 HTML 中临时替换为占位文本，Lute 完成块解析后原样还原，随后由 Vditor 写入 DOM 并使用自己的 `<wbr>` 定位光标。占位符或光标锚点不能完整还原时回退原始解析，不允许临时文本进入正文。适配器启用时不再执行 IME 指纹光标恢复和 120/280ms 定时纠正；不支持该内部接口时保留旧兼容路径。升级 Vditor 时必须重跑浏览器回归。

`npm run test:editor-input-browser` 使用临时静态服务器和独立 Chrome 页面，不访问用户数据。测试需要可导入的 `playwright` 和本机 Chrome；也可用 `DUMBPAD_PLAYWRIGHT_MODULE` 指定已安装 Playwright 模块的绝对路径。覆盖逐帧标记/光标检查、CDP 中文组合输入、提交后主动移动光标、高亮编辑、撤销/重做及图片附近视口检查。CDP 组合输入不替代真实系统输入法验收；该浏览器测试不包含在 `npm test` 中。

本次已通过 `npm run check`、`test:hybrid-editor-time-command`、`test:hybrid-editor-caret-stability`、`test:source-mode-roundtrip`、`test:editor-noop-save-guard` 和 `test:editor-input-browser`；没有运行全量 `npm test`。图片跳动未在独立样例中复现，相关视口检查通过不能代表原复杂文档的问题已解决，本次未修改滚动逻辑。移动端系统输入法、复杂嵌套列表和原图片场景仍保留为后续验收项；本次先固化稳定点，不继续扩展修复或更换编辑器内核。

### 普通 Enter 的兼容性边界

`HybridMarkdownEditor` 不把所有 Enter 交给 Vditor。顶层普通段落使用 `handleWysiwygSoftEnter()`：它仅在无修饰键、非组合输入、同一顶层 `p` 且不在内联代码时拦截事件，插入软换行和零宽光标保护字符，再异步走 `notifyEditorValueChanged()`。这样源码模式不会产生额外的可编辑空段。

标题、列表、引用、代码块和其他非普通段落必须继续由 Vditor 的原生块模型处理。不要把这一分支改写为 `editor.insertValue('\n')`、`execCommand('insertLineBreak')` 或“完全不拦截普通 Enter”：这些看似简单的改动曾分别导致首次 Enter 被吞、块模型错乱或源码出现空段。行为基线是 `refactor-ai-s3-thoughts` 分支；对应结构回归检查为 `npm run test:hybrid-editor-time-command`，任何调整还必须做一次真实编辑器手动回归。

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

今日草稿是日期范围内的一行用户数据，存放在独立的 `today-drafts.json`（S3 同名 key）中，不进入 Thought 的 AI、标签、关系或垃圾桶流程。服务端以自己的本地日期为准：每次读写先清理过期项，再在 Today Draft 写锁内创建、更新或删除当前日单条记录。前端先保存本机当天缓存并写入 outbox；联网后按 id 回放 PUT/DELETE，服务端成功后以返回版本更新本机项。`today_drafts_update` 只携带受影响记录，收到后对未处于本地待同步状态的单条记录做局部合并。

### Thought 时间线分页与局部更新

Thought 页面使用 `GET /api/thoughts?format=page&light=1&limit=30&sort=timeline`：首屏只请求 30 条，底部“加载更多”和滚动哨兵按相同游标继续取数。`sort=timeline` 是页面专用排序，严格复用前端的置顶、完成状态、创建时间顺序；默认分页仍按 `updatedAt` 排序，保留给同步程序使用，二者不能混用游标。

服务端在 `STORAGE_LAYOUT=split` 下会通过 `storage.listThoughtsPage()` 读取既有的 `indexes/thoughts-index.json`，先在索引中完成标签、日期、完成状态与游标筛选排序，再只读取当前页的 Thought 文件。索引缺失、旧索引没有时间线字段、对象缺失、`legacy` 布局以及任意关键词全文搜索时，都回退到完整读取；回退会修复 split 索引，不能以不完整结果代替用户搜索结果。这样 S3 的无关键词列表从“列举并读取全部对象”降为“一份索引加最多 30 个对象”。

`ThoughtsManager` 将“已从服务端取到的条数”和“已插入 DOM 的卡片数”分开管理：前者由游标追加，后者仍按 30 张批量插入。完成和置顶不调用 `render()` 清空时间线，而是仅重建被操作卡片，并在当前可见批次内移动、补入或移除卡片。筛选条件改变时重置游标重新请求，避免只对已加载的局部数据筛选造成漏项。

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

Service Worker 的核心缓存包含入口页面、主 JS/CSS、Thought 拆分模块和图标。Vditor、Lute 和 `hybrid-editor.js` 从安装核心资源中移出，由文章模式按需加载并走运行时静态资源缓存，避免直接进入 `#thoughts` 时抢占移动端首屏网络。`WARM_ASSETS` 额外预热中文字体、代码字体和 highlight 主包；这些资源较大但变化很少，第一次安装或版本更新时缓存，后续打开直接复用。

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
