# DumbPad 项目技术介绍

本文档描述当前 DumbPad 的主要技术边界和本轮低风险重构后的模块职责。目标是让后续继续添加 Thought、AI、同步和数据空间功能时，优先沿已有边界扩展，而不是继续向大文件堆逻辑。

## 1. 技术栈

- 后端：Node.js、Express、WebSocket。
- 前端：Vanilla JS ES modules、CSS、Vditor、Marked。
- 存储：本地 JSON/txt 文件或 S3 兼容对象存储。
- 搜索：服务端 Fuse.js，数据由 `storage.getSearchDocuments()` 汇总。
- AI：OpenAI-compatible chat、embedding、可选 rerank；无 key 时使用 noop provider。
- PWA：运行时生成 manifest 和 asset manifest，service worker 负责缓存静态资源。

## 2. 后端边界

`server.js` 是当前后端入口，仍集中注册静态资源、鉴权、WebSocket、分享页、Notepad API、Thought API 和搜索 API。数据管理 API 已拆到 `routes/data-management-routes.js`，由 `server.js` 通过显式 context 注册。后续继续拆分 route 时应保持 URL、HTTP status、response body 和 WebSocket 副作用不变。

关键模块：

- `scripts/storage.js`：唯一的用户数据读写边界。调用方通过同一套方法读写 Notepad、Thought、AI meta、relations、indexes，不直接关心 local/S3 或 legacy/split layout。
- `scripts/ai-provider.js`：封装 AI provider。没有可用配置时降级为 noop provider。
- `scripts/ai-queue.js`：负责后台 AI 队列、pending meta、extract、embedding、relations、rebuild 和状态广播。
- `scripts/s3-service.js`、`scripts/s3-prefix-tools.js`：负责 S3 对象操作、prefix inventory、backup、delete 和 data space 列表。
- `routes/data-management-routes.js`：负责 `/api/data-management/*` 路由，包含状态读取、数据空间列表/切换、inventory、backup、delete、本地导入 S3、双向覆盖。

## 3. 前端边界

前端没有构建步骤，所有浏览器代码都通过原生 ES module 加载。新增模块时要同时确认 service worker asset manifest 能覆盖新文件。

核心模块：

- `public/app.js`：应用启动、Notepad 编辑与保存、设置页、同步状态、全局快捷键和主视图协调。
- `public/hybrid-editor.js`：Vditor 封装，负责混合编辑、源码模式、阅读模式、目录索引、批注和高亮装饰。
- `public/managers/thoughts.js`：Thought UI 协调层。负责 DOM 渲染、事件绑定、乐观更新、toast、筛选、AI/relations 面板入口。
- `public/managers/thought-api-client.js`：Thought HTTP client。负责 URL 拼接、`encodeURIComponent`、JSON 请求和带 `status` 的错误。
- `public/managers/thought-outbox.js`：Thought 本地 outbox。负责 localStorage key、队列合并、create/patch/delete/relation 队列项构造、服务端列表合并和 retry。
- `public/managers/thought-relations-panel.js`：关系面板纯渲染 helper，保留事件和 API 协调在 `ThoughtsManager`。
- `public/managers/thought-editor.js`：Thought 编辑、legacy 子任务解析、子任务清理与排序等纯 helper。
- `public/managers/thought-renderer.js`：Thought 过滤、排序和标签收集 helper。
- `public/managers/note-sync-controller.js`：启动缓存与 Note cache 读写控制器，避免缓存细节继续散落在 `app.js`。
- `public/managers/settings-data-panel.js`：设置页数据空间和云端维护 API adapter。
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

## 5. 重构约束

- 不改变用户数据结构。
- 不改变已有 API 行为。
- 不把 AI、S3、WebSocket、outbox 放进启动关键路径。
- 不为拆文件而拆文件；只有能降低调用方认知负担时才提取模块。
- 每轮只处理一个领域，并运行对应测试。

## 6. 后续建议

本轮已完成的低风险重构：

1. Thought API client、outbox、关系面板渲染、编辑 helper、过滤排序 helper。
2. Note 启动缓存与 cache 控制器。
3. Settings data panel API adapter。
4. 后端 data-management route module。
5. Storage 和 AI pipeline interface 文档。

后续如继续推进，优先选择一个 route 或一个前端交互领域小步迁移，并在迁移后运行对应测试。
