# DumbPad 项目技术介绍

本文档描述当前 DumbPad 的主要技术边界和本轮低风险重构后的模块职责。目标是让后续继续添加 Thought、AI、同步和数据空间功能时，优先沿已有边界扩展，而不是继续向大文件堆逻辑。

## 1. 技术栈

- 后端：Node.js、Express、WebSocket。
- 前端：Vanilla JS ES modules、CSS、Vditor、Marked。
- 存储：本地 JSON/txt 文件或 S3 兼容对象存储。
- 搜索：服务端 Fuse.js，数据由 `storage.getSearchDocuments()` 汇总。
- AI：OpenAI-compatible chat、embedding、可选 rerank、手动 Thought insight；无 key 时使用 noop provider。
- PWA：运行时生成 manifest 和 asset manifest，service worker 负责缓存静态资源。

## 2. 后端边界

`server.js` 是当前后端入口，仍集中注册静态资源、鉴权、WebSocket、分享页、Notepad API、Thought API、Trash API 和搜索 API。数据管理 API 已拆到 `routes/data-management-routes.js`，Trash API 已拆到 `routes/trash-routes.js`，都由 `server.js` 通过显式 context 注册。后续继续拆分 route 时应保持 URL、HTTP status、response body 和 WebSocket 副作用不变。

关键模块：

- `scripts/storage.js`：唯一的用户数据读写边界。调用方通过同一套方法读写 Notepad、Thought、Trash、AI meta、relations、indexes，不直接关心 local/S3 或 legacy/split layout。
- `scripts/ai-provider.js`：封装 AI provider。关系分析使用 chat/embedding/rerank；手动 Thought insight 使用独立 `AI_INSIGHT_MODEL`，没有可用配置时降级为 noop provider。
- `scripts/ai-queue.js`：负责后台 AI 队列、pending meta、extract、embedding、relations、rebuild 和状态广播；同时提供手动 insight 生成函数，但 insight 不进入自动队列。
- `scripts/s3-service.js`、`scripts/s3-prefix-tools.js`：负责 S3 对象操作、prefix inventory、backup、delete 和 data space 列表。
- `routes/data-management-routes.js`：负责 `/api/data-management/*` 路由，包含状态读取、数据空间列表/切换、inventory、backup、delete、本地导入 S3、双向覆盖。
- `routes/trash-routes.js`：负责 `/api/trash/*` 路由，恢复和永久删除都只调用 storage 边界，不在 route 层拼接本地路径或 S3 key。

## 3. 前端边界

前端没有构建步骤，所有浏览器代码都通过原生 ES module 加载。新增模块时要同时确认 service worker asset manifest 能覆盖新文件。
Thought 前端 helper 拆分模块有聚合测试入口：`npm run test:thought-modules`。

核心模块：

- `public/app.js`：应用启动、Notepad 编辑与保存、设置页、同步状态、全局快捷键和主视图协调。
- `public/hybrid-editor.js`：Vditor 封装，负责混合编辑、源码模式、阅读模式、目录索引、批注和高亮装饰。
- `public/managers/thoughts.js`：Thought UI 协调层。负责 DOM 插入、每卡事件绑定、乐观更新、toast、筛选、AI/relations 面板入口；全局事件初始化按 Quick Add、视图切换、搜索筛选、outbox、socket 分段，`render()` 负责列表生成，单卡交互集中在 `bindThoughtCardEvents()`，relation panel 事件分发集中在 `handleRelationsPanelClick()`，inline 子任务编辑的输入替换和提交协调分开维护。
- `public/managers/thought-api-client.js`：Thought HTTP client。负责 URL 拼接、`encodeURIComponent`、JSON 请求和带 `status` 的错误。
- `public/managers/thought-outbox.js`：Thought 本地 outbox。负责 localStorage key、队列合并、create/patch/delete/relation 队列项构造、服务端列表合并和 retry。
- `public/managers/thought-ai-status.js`：Thought AI 状态边界。负责 AI 状态/阶段归一化、pending 最短显示时间计算、socket detail 应用到 Thought 对象、标签文案、按钮图标、状态详情 HTML、手动 insight 区块、loading/error 片段；`ThoughtsManager` 保留 timer 调度、点击、拉取状态、Markdown hydrate、重试和 insight 触发协调。
- `public/managers/thought-card-renderer.js`：Thought 卡片纯 HTML 渲染边界。负责正文、legacy checkbox 子任务、标签、AI 状态入口、关系计数和折叠子任务摘要；`ThoughtsManager` 只保留 DOM 插入、复制文本和交互事件绑定。
- `public/managers/thought-relations-panel.js`：关系面板纯渲染 helper。负责关系列表、推荐列表、手动关联输入控件、候选摘要截断/高亮和空状态 HTML；保留事件、防抖、API 协调在 `ThoughtsManager`。
- `public/managers/thought-editor.js`：Thought 编辑 helper。负责 legacy 子任务解析、编辑态正文/子任务拆分、子任务清理/排序、编辑行与 inline 新增子任务输入 HTML 片段，以及新增/修改/删除/toggle 子任务的本地对象变更；保存触发、失焦、快捷键和 API 协调仍保留在 `ThoughtsManager`。
- `public/managers/thought-renderer.js`：Thought 过滤和排序 helper。
- `public/managers/thought-quick-add.js`：Quick Add 数据构造 helper。负责服务端创建成功后的本地 pending AI 标记、离线 local pending Thought 构造和 create outbox payload；弹层、焦点、提交时序、API 和 outbox 协调仍保留在 `ThoughtsManager`。
- `public/managers/thought-tags.js`：Thought 标签边界。负责标签归一化、`dumbpad_thought_tags` 持久化、标签收集，以及标签筛选、Quick Add 标签、AI 建议标签 HTML 片段渲染；`ThoughtsManager` 只保留事件协调。
- `public/managers/thought-text-formatting.js`：Thought 文本格式化 helper。负责 HTML 转义、URL linkify 和正则转义；DOM 依赖的搜索高亮仍保留在 `ThoughtsManager`。
- `public/managers/time-command.js`：`/time` 快捷命令边界。负责本地时间格式化、光标前 `/time` 替换、`[[time:create:...]]` / `[[time:update:...]]` 标记渲染，以及旧 `[[time:...]]` 标记兼容；文章编辑器和 Thought 输入共同复用。
- `public/managers/thought-relations-state.js`：Thought 关系本地状态 helper。负责关系计数归一化、手动关联成功/失败和删除成功/失败时的本地 relation count/localPending/ready 状态变更；API、panel 刷新和 outbox 协调仍保留在 `ThoughtsManager`。
- `public/managers/note-sync-controller.js`：启动缓存与 Note cache 读写控制器，避免缓存细节继续散落在 `app.js`。
- `public/managers/settings-data-panel.js`：设置页数据空间、垃圾桶和云端维护 API adapter。
- `public/managers/ws-client.js`：轻量 WebSocket 客户端，把服务端事件转成浏览器 `CustomEvent`。

## 4. Thought 写入流程

1. 用户创建、修改、删除 Thought。
2. `ThoughtsManager` 先做 UI 乐观更新。
3. HTTP 请求统一通过 `ThoughtApiClient`。
4. 请求失败时，`ThoughtsManager` 把待同步操作交给 `ThoughtOutbox`。
5. `ThoughtOutbox` 保留原有 outbox 数据格式，写入 `localStorage`。
6. 网络恢复或用户点击“待同步”按钮时，`ThoughtsManager` 调用 `ThoughtOutbox.retry(apiClient)`。
7. 服务端成功写入 Thought 后，AI 队列异步生成 meta 和 relation；前端通过 WebSocket 刷新状态。

这个流程要求快速记录不等待 AI，不等待 S3 之外的额外流程，也不因为离线而丢失本地输入。

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
