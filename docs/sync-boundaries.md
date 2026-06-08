# DumbPad 同步边界说明

本文档定义 DumbPad 当前和后续同步实现的边界。核心原则是：记录入口必须本地优先、快速可用；AI、S3、多端广播都是后台能力，不能阻塞用户创建和编辑。

## 1. 总原则

- Notepad 和 Thought 的用户输入是主数据，必须优先保存。
- AI meta、AI relation、搜索索引、启动缓存都是派生数据，可以重建。
- 手动 relation 和 suppressed relation 是用户判断，必须持久化并优先于 AI。
- 前端不直连 S3；前端只调用 DumbPad 后端 API。
- WebSocket 只做轻量通知和局部刷新，不承担唯一数据源职责。
- S3 是 storage backend 的一种实现，不改变前端 API，也不应该让首屏和快速记录等待额外 AI 流程。
- 顶部同步云图标是同步状态入口；异常状态要能进入设置里的同步面板处理。

## 2. 数据归属

| 数据 | 示例字段/文件 | 归属 | 是否必须同步 | 是否可重建 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Notepad 元数据 | `notepads.json` | 用户数据 | 是 | 否 | 包含 id、name、createdAt、updatedAt、version。 |
| Notepad 内容 | `*.txt` | 用户数据 | 是 | 否 | 用户正文，保存失败时前端启动缓存可兜底。 |
| Thought 本体 | `thoughts.json` 或 `thoughts/*.json` | 用户数据 | 是 | 否 | 包含 text、subItems、tags、completed、version、createdAt、updatedAt。 |
| Thought 用户标签 | `thought.tags` | 用户数据 | 是 | 否 | 标签由用户最终确认，AI 只能建议。 |
| Thought 子任务 | `thought.subItems` | 用户数据 | 是 | 否 | 子任务文本和完成状态属于 Thought 本体。 |
| 手动 relation | `relations/*.json` 中 `source=manual` | 用户数据 | 是 | 否 | 双向写入，AI rebuild 不得删除。 |
| suppressed relation | `relations.suppressed/*.json` | 用户数据 | 是 | 否 | 用户删除关系后的“不要再推荐”记忆。 |
| 垃圾桶 | `trash/index.json`、`trash/notepads/*.json`、`trash/thoughts/*.json` | 用户数据 | 是 | 否 | 保存已删除文章和 Thought 的恢复 payload；永久删除后才移除。 |
| AI meta | `thoughts.meta/*.json` | 派生数据 | 建议同步 | 是 | 保存摘要、实体、主题、embedding、AI 标签建议、状态。同步可提升速度，但丢失后可 backfill。 |
| AI relation | `relations/*.json` 中 `source=ai` | 派生数据 | 建议同步 | 是 | 可通过 `relations-rebuild` 重建。 |
| 搜索索引 | `indexes/*.json` | 派生数据 | 可选 | 是 | 用于加速搜索，启动或迁移后可重建。 |
| 前端启动缓存 | localStorage `dumbpad_startup_cache` | 本机缓存 | 否 | 是 | 只用于快速首屏和离线兜底，不是同步真相。 |

## 3. 存储后端边界

当前 storage 由 `scripts/storage.js` 统一封装：

- `STORAGE_BACKEND=local`：数据写入 `data/`。
- `STORAGE_BACKEND=s3`：数据写入 S3 兼容对象存储。
- `STORAGE_LAYOUT=legacy`：Thought 存在单个 `thoughts.json`。
- `STORAGE_LAYOUT=split`：Thought 拆到 `thoughts/<id>.json`，更适合多端和 S3。

S3 key 结构：

- `notepads.json`
- `<notepad-name>.txt` 或 `default.txt`
- `thoughts.json` 或 `thoughts/<id>.json`
- `thoughts.meta/<id>.json`
- `relations/<id>.json`
- `relations.suppressed/<id>.json`
- `indexes/<name>.json`
- `trash/index.json`
- `trash/notepads/<trashId>.json`
- `trash/thoughts/<trashId>.json`

后续多端同步应优先基于 split layout 设计，因为单文件 `thoughts.json` 在多端同时修改时冲突面更大。

## 4. 写入触发

### Notepad

- 创建 notepad：写 `notepads.json` 和初始内容文件，广播 `notepad_change`。
- 重命名 notepad：校验 `baseVersion`，更新元数据和内容文件名，广播 `notepad_change`。
- 保存正文：校验 `baseVersion`，写正文文件，更新 `updatedAt/version`，广播 `notes_update`。
- PATCH 正文：校验 `baseVersion`，按 action 修改正文，更新 `updatedAt/version`，广播 `notes_update`。
- 删除 notepad：先写入垃圾桶 payload，再删除活动元数据和正文文件，广播 `notepad_change`。
- 恢复 notepad：从垃圾桶 payload 写回元数据和正文；若 id 或标题冲突，生成恢复用 id/标题，然后从垃圾桶移除该记录。

Notepad 的前端启动缓存只用于：

- 首屏快速显示最近列表和内容。
- 保存失败时保留本地脏内容。
- 恢复在线或 WebSocket 重连后尝试 `syncCurrentDirtyNote()`。
- 设置同步面板展示当前 note 的 dirty/conflict 状态、版本、缓存时间和缓存中的 dirty note 列表。

启动缓存不是多端合并协议，不能覆盖服务端较新版本。

### Thought

- 创建 Thought：先写 Thought 本体，广播 `thoughts_update:create`，再异步入 AI 队列。
- 修改 Thought：校验 `baseVersion`，写 Thought 本体，广播 `thoughts_update:update`，再异步入 AI 队列。
- 删除 Thought：先写入垃圾桶 payload，再删除本体、AI meta、本 thought 的 relation、suppressed relation，并清理其他 thought 指向它的 relation/suppressed 引用，广播 `thoughts_update:delete`。
- 恢复 Thought：从垃圾桶 payload 写回 Thought、AI meta、relation 和 suppressed relation；已不存在的 relation 目标会被过滤，仍存在的目标会补回反向 relation。
- 标签修改：作为 Thought `overwrite` 的一部分写入 `thought.tags`，属于用户数据。
- 子任务修改：作为 Thought PATCH action 写入 `thought.subItems`，属于用户数据。

Thought 创建和修改不能等待 AI extract、embedding、rerank 或 S3 之外的额外流程。后端 API 返回后，AI 状态通过 `ai_status_update` 逐步刷新。

## 5. Relation 边界

`relations/<id>.json` 是混合文件，同时保存用户手动边和 AI 派生边：

- 手动边：`method=manual` 或 `source=manual`，用户数据。
- AI 边：`source=ai`，派生数据。

规则：

- 所有 relation 都应双向可见。
- 用户手动创建 relation 时，A->B 和 B->A 同时写入。
- 用户删除 relation 时，A->B 和 B->A 同时删除，并写入双向 suppressed relation。
- 手动创建 relation 会清除同一 pair 的 suppressed 记录，表示用户重新确认需要关联。
- AI rebuild 只能增删 AI 边，不能删除手动边。
- AI rebuild 遇到 suppressed pair 时不得重新推荐。
- Thought 删除时必须移除其他 relation 文件里指向该 Thought 的边。
- Thought 恢复时只恢复仍指向现存 Thought 的 relation，并同步补回反向边，避免单向关系和错误计数。

## 6. AI 边界

AI 运行在后端，入口包括：

- 创建 Thought 后自动 `queueThought(id, "create")`。
- 用户点击重试后 `POST /api/thoughts/:id/ai-process`。
- 用户在 AI 面板点击思考扩展后 `POST /api/thoughts/:id/ai-insight`。
- 迁移或维护时 `POST /api/thoughts/ai-backfill`。
- 维护时 `POST /api/thoughts/relations-rebuild`。

修改 Thought 后不自动重新运行 AI；需要用户在 AI 面板手动触发。`ai-insight` 也不进入后台关系队列，且必须配置独立 `AI_INSIGHT_MODEL`，不能复用原 `AI_CHAT_MODEL`。

AI 状态：

- `pending`：已经入队或正在处理。
- `ready`：AI meta 和 relation 已完成。
- `empty`：Thought 没有可分析文本。
- `error`：AI 处理失败，可重试。
- `missing`：没有 meta，通常是旧数据或缓存缺失。

AI 产物：

- `ai.summary/entities/topics/intent/keywords/timeScope/tags/embedding`
- `insight.status/markdown/model/contextIds/generatedAt/error`
- relation 候选和理由
- relation count

AI 标签只作为 `aiTags` 建议返回。用户点击接受后才写入 `thought.tags`。

AI 日志应保留在后端控制台，用于定位任务是否入队、模型是否调用、耗时和失败原因；日志不得输出 API key 或完整敏感正文。

## 7. WebSocket 边界

当前事件：

- `notes_update`：notepad 正文发生变化，其他客户端刷新或更新内容。
- `notepad_change`：notepad 列表发生创建、重命名、删除等变化。
- `thoughts_update`：Thought 本体发生创建、修改、删除。
- `relations_update`：某个 Thought 的 relation 数量或内容发生变化。
- `ai_status_update`：某个 Thought 的 AI 状态发生变化。

WebSocket 只负责通知：

- 客户端收到事件后，应以 API 返回或本地状态合并为准。
- WebSocket 丢失时，刷新页面或重新拉取 API 必须能恢复一致。
- 不应把大正文、完整 AI meta、完整 relation 图谱都塞进 WebSocket。

## 8. 冲突与版本

现有 Notepad 和 Thought 使用 `version/baseVersion` 做乐观并发：

- 客户端保存时带上 `baseVersion`。
- 服务端发现当前版本更高时返回 `409`。
- 前端应提示远端已更新，保留本地内容供用户处理。
- Notepad 保存遇到 `409` 时，前端应把服务端 `currentVersion` 记录到本地缓存的 `remoteVersion`，并标记 `conflict=true`。
- 存在 conflict 标记时，自动恢复同步和手动“重试同步当前内容”都不得覆盖远端。
- 用户可复制本地内容，或明确选择“放弃本地并加载远端”；该操作应清除 dirty/conflict 缓存。

当前不做完整 CRDT/OT。后续如果要增强多端编辑，优先方向是：

- Notepad 正文仍保持整篇版本冲突。
- Thought 因为结构化字段较小，可以按字段或 action 做更细粒度合并。
- 手动 relation 和 suppressed relation 以 pair 为最小合并单位。
- AI 派生数据不参与冲突，必要时重建。

## 9. 启动和离线策略

启动顺序建议：

1. 读取前端启动缓存，快速显示上次 notepad 列表和当前内容。
2. 后台请求 `/api/notepads` 和 `/api/notes/:id`。
3. 服务端返回后比较版本，较新则更新 UI 和缓存。
4. 如果本地有 dirty 内容，恢复在线后尝试保存；遇到 409 不自动覆盖。
5. Thought 视图打开时再请求 `/api/thoughts`，不阻塞 Notepad 首屏。
6. AI 状态、relation 面板按需请求，或通过 WebSocket 轻量刷新。

设置同步面板的职责：

- 点击顶部同步云图标可打开该面板。
- 当前 note 没有 dirty 内容时，显示轻量同步状态，不展示本地内容 textarea。
- 当前 note 有 dirty 内容时，显示本地内容、复制入口、加载远端入口。
- 当前 note 无冲突且在线时，允许手动重试同步当前内容。
- 缓存中存在多个 dirty note 时，列出名称、状态和缓存时间，点击后切换到对应 notepad。
- 该面板只处理可见和当前 note 的恢复动作，不承诺批量离线同步队列。

离线能力当前只覆盖轻量兜底，不承诺完整离线队列。大规模离线创建、删除、合并不在当前阶段范围内。

## 10. 后续实现约束

- 不把 AI backfill 或 relation rebuild 放到启动关键路径。
- 不让 S3 直连暴露到前端。
- 不因为 AI provider 不可用而影响 Thought 创建、修改、删除。
- 不因为 S3 之外的派生数据失败而阻断用户主数据写入。
- 多端同步要先保证用户数据，再优化 AI meta、relation、索引等派生数据。
- 每个新的同步功能都要说明它写入的是用户数据还是派生数据。
