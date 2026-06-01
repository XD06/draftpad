# DumbPad API 文档

Base URL: `http://localhost:PORT`  
认证方式: Cookie (`dumbpad_auth`) 或 Header (`Authorization: Bearer <PIN>`)

除 `/api/verify-pin`、`/api/pin-required`、`/api/config` 外，`/api/*` 默认需要通过 PIN 认证。浏览器端通常使用 Cookie；脚本或集成可以使用 `Authorization: Bearer <PIN>`。

---

## Auth 与配置 API

### POST /api/verify-pin

校验 PIN，成功后写入 `dumbpad_auth` HTTP-only Cookie。

**请求体：**

```json
{ "pin": "123456" }
```

**响应：**

```json
{ "success": true }
```

**错误：**

- `400` — PIN 格式非法。
- `401` — PIN 错误。
- `429` — 登录失败次数过多，临时锁定。

### GET /api/pin-required

读取当前是否需要 PIN。

**响应：**

```json
{
  "required": true,
  "length": 6,
  "locked": false
}
```

### GET /api/config

读取前端启动配置。

**响应：**

```json
{
  "siteTitle": "DumbPad",
  "baseUrl": "http://localhost:3000",
  "version": "1.0.8-abcd1234",
  "highlightLanguages": ["javascript", "python"]
}
```

---

## Notepad API

Notepad 是文章元数据；正文内容通过 Note API 读写。

### GET /api/notepads

读取文章列表。

**Query 参数：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `title` | string | 按标题包含过滤 |
| `sortBy` | string | 排序字段，默认 `updatedAt` |
| `order` | string | `asc` 或 `desc`，默认 `desc` |

**响应：**

```json
{
  "notepads_list": [
    {
      "id": "default",
      "name": "Default",
      "version": 1,
      "createdAt": 1778966668430,
      "updatedAt": 1778966668430
    }
  ],
  "note_history": "default"
}
```

### POST /api/notepads

创建文章，并写入初始正文。

**请求体：**

```json
{
  "name": "新文章",
  "content": "# Hello"
}
```

**响应：** 新 Notepad 元数据。

### PUT /api/notepads/:id

重命名文章。

**请求体：**

```json
{
  "name": "新标题",
  "baseVersion": 1
}
```

**响应：**

```json
{
  "id": "1778966668430",
  "name": "新标题",
  "version": 2,
  "createdAt": 1778966668430,
  "updatedAt": 1778966669000,
  "nameChanged": false
}
```

**错误：**

- `404` — Notepad 不存在。
- `409` — 服务端版本比 `baseVersion` 新。

### DELETE /api/notepads/:id

删除文章。`default` 文章不能删除。

**响应：**

```json
{
  "success": true,
  "message": "Notepad deleted successfully"
}
```

### POST /api/upload

上传原始文本内容并创建文章。

请求 body 是原始文本；文件名通过 `x-filename` header 传入。

```bash
curl -X POST http://localhost:3000/api/upload \
  -H "x-filename: notes.md" \
  --data-binary @notes.md
```

---

## Note API

Note 是某个 Notepad 的正文内容。保存接口使用 `baseVersion` 做乐观并发保护。

### GET /api/notes/:id

读取正文。

**响应：**

```json
{
  "content": "# Hello",
  "version": 1
}
```

### POST /api/notes/:id

覆盖保存正文。

**请求体：**

```json
{
  "content": "# Updated",
  "baseVersion": 1,
  "userId": "browser-tab-id"
}
```

**响应：**

```json
{
  "success": true,
  "version": 2
}
```

**错误：**

- `400` — Notepad id 非法。
- `409` — 服务端版本比 `baseVersion` 新。

### PATCH /api/notes/:id

局部修改正文。

**请求体：**

```json
{
  "action": "append",
  "text": "\n追加内容",
  "baseVersion": 1,
  "userId": "api"
}
```

支持的 `action`：

| action | 说明 |
|---|---|
| `append` | 在末尾追加 `text` |
| `prepend` | 在开头插入 `text` |
| `replace` | 替换所有 `target` |
| `replace_first` | 只替换第一个 `target` |
| `overwrite` | 用 `text` 覆盖全文 |

**响应：**

```json
{
  "success": true,
  "content": "# Updated",
  "modified": true,
  "version": 2
}
```

---

## Quick Thoughts API

Thought 是一个**主任务 + 子任务（最多二层）**的待办结构。

### 数据模型

```json
{
  "id": "1778966668430",
  "text": "完成项目报告",
  "subItems": [
    { "id": "sub_001", "text": "收集数据",    "completed": false },
    { "id": "sub_002", "text": "写初稿",      "completed": true  }
  ],
  "completed": false,
  "createdAt": 1778966668430,
  "updatedAt": 1778966668486
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 主任务唯一标识 |
| `text` | string | 主任务内容 |
| `subItems` | array | 子任务列表 |
| `subItems[].id` | string | 子任务唯一标识 |
| `subItems[].text` | string | 子任务内容 |
| `subItems[].completed` | boolean | 子任务完成状态 |
| `completed` | boolean | 主任务完成状态 |
| `tags` | array | 用户可见标签 |
| `version` | number | 乐观并发版本号 |
| `createdAt` | number | 创建时间戳 |
| `updatedAt` | number | 更新时间戳 |

---

### GET /api/thoughts

获取所有 Thoughts，支持搜索和日期过滤。

**Query 参数：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `q` | string | 搜索关键词（匹配主任务 + 子任务文本） |
| `date` | string | 日期过滤，格式 `YYYY-MM-DD` |
| `tag` | string | 按用户标签精确过滤 |
| `limit` | number | 限制返回数量，最大 50 |
| `light` | `1` / `true` | 轻量列表模式，只返回基础 Thought 字段，不读取 AI meta 和 relation count。用于手动关联搜索等高频输入场景。 |

**响应：** `Thought[]`

列表项会额外包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `relationCount` | number | 当前 Thought 已生成的关联数量 |

**示例：**
```bash
# 获取全部
curl http://localhost:3000/api/thoughts

# 搜索
curl "http://localhost:3000/api/thoughts?q=报告"

# 手动关联等轻量搜索
curl "http://localhost:3000/api/thoughts?q=报告&limit=8&light=1"

# 按日期
curl "http://localhost:3000/api/thoughts?date=2026-05-17"

# 组合
curl "http://localhost:3000/api/thoughts?q=车&date=2026-05-17"
```

---

### GET /api/thoughts/:id

获取单条 Thought。

**响应：** `Thought` 或 `404`

```bash
curl http://localhost:3000/api/thoughts/1778966668430
```

---

### POST /api/thoughts

创建新 Thought。

**请求体：**
```json
{
  "text": "完成项目报告",
  "subItems": [
    { "id": "sub_001", "text": "收集数据", "completed": false },
    { "id": "sub_002", "text": "写初稿",   "completed": false }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 主任务内容（不可为空） |
| `subItems` | 否 | 子任务列表，默认 `[]` |

**响应：** `201` 返回创建的 Thought

**错误：** `400` — `text` 为空或缺失

```bash
curl -X POST http://localhost:3000/api/thoughts \
  -H "Content-Type: application/json" \
  -d '{"text":"买日用品","subItems":[{"id":"a1","text":"牛奶","completed":false}]}'
```

---

### PATCH /api/thoughts/:id

更新 Thought。通过 `action` 字段区分操作类型。

#### action: `toggle_complete`

切换主任务完成状态。

```json
{ "action": "toggle_complete" }
```

#### action: `toggle_subitem`

切换子任务完成状态。

```json
{
  "action": "toggle_subitem",
  "subId": "sub_001"
}
```

**错误：** `404` — 子任务不存在

#### action: `add_subitem`

新增子任务。

```json
{
  "action": "add_subitem",
  "text": "最终审阅"
}
```

**错误：** `400` — `text` 为空

#### action: `update_subitem`

更新子任务内容和/或状态。

```json
{
  "action": "update_subitem",
  "subId": "sub_001",
  "text": "收集数据(已完成)",
  "completed": true
}
```

`text` 和 `completed` 至少传一个。  
**错误：** `404` — 子任务不存在

#### action: `delete_subitem`

删除子任务。

```json
{
  "action": "delete_subitem",
  "subId": "sub_001"
}
```

**错误：** `404` — 子任务不存在

#### action: `overwrite`

批量更新主任务文本和子任务列表。

```json
{
  "action": "overwrite",
  "text": "完成项目报告 v2",
  "subItems": [
    { "id": "sub_001", "text": "收集数据", "completed": true },
    { "id": "sub_002", "text": "写初稿",   "completed": true }
  ]
}
```

`text` 和 `subItems` 至少传一个。

#### action: `append` / `replace`

文本追加/替换（兼容旧版）：

```json
{ "action": "append", "text": " - 追加的内容" }
```

```json
{ "action": "replace", "target": "旧文本", "replacement": "新文本" }
```

---

### DELETE /api/thoughts/:id

删除 Thought。

**响应：** `{ "success": true }`  
**错误：** `404` — Thought 不存在

```bash
curl -X DELETE http://localhost:3000/api/thoughts/1778966668430
```

---

## AI Relations API

AI Relations 是后台派生能力，不阻塞 Thought 创建、编辑和保存。

### GET /api/thoughts/:id/relations

读取某条 Thought 的关联列表。

如果 Thought 不存在，接口返回 `200` 和空列表，避免前端出现可见 404 噪声。

**响应：**

```json
{
  "id": "1778966668430",
  "status": "ready",
  "relations": [
    {
      "thought": {
        "id": "1778966668500",
        "text": "S3 只能作为后台备份",
        "tags": ["S3"],
        "completed": false,
        "createdAt": 1778966668500
      },
      "score": 0.85,
      "confidence": 0.9,
      "relationType": "supports",
      "method": "entity+topic+vector",
      "reasons": ["候选是本地优先原则的具体实现"],
      "signals": {
        "entity": 1,
        "topic": 0.5,
        "vector": 0.78,
        "reranker": 0.98
      }
    }
  ]
}
```

`relationType` 可能值：

```text
duplicate
question_answer
supports
contradicts
step_sequence
cause_effect
same_project
same_topic
example_of
alternative
related_context
loosely_related
```

---

### DELETE /api/thoughts/:id/relations/:targetId

删除一条误判关联。

删除后会：

- 从 `relations/{id}.json` 移除 edge。
- 从反向 `relations/{targetId}.json` 移除 edge。
- 写入 `relations.suppressed/{id}.json`。
- 写入 `relations.suppressed/{targetId}.json`。

后续 relations 重建会跳过 suppressed edge，避免误判立刻回来。

**响应：**

```json
{
  "success": true,
  "removed": true
}
```

---

### POST /api/thoughts/:id/relations

手动创建一条 relation。手动 relation 优先级高于 AI rebuild，不会被后台重算删除。

**请求体：**

```json
{
  "targetId": "1778966668500",
  "relationType": "related_context"
}
```

**响应：**

```json
{
  "success": true,
  "relation": {
    "targetId": "1778966668500",
    "relationType": "related_context",
    "method": "manual",
    "manual": true
  }
}
```

**错误：**

- `400` — 参数非法或不能关联自己。
- `404` — source 或 target Thought 不存在。

---

### POST /api/thoughts/:id/ai-process

手动将单条 Thought 加入 AI 处理队列。

**响应：**

```json
{
  "queued": true,
  "id": "1778966668430"
}
```

---

### POST /api/thoughts/ai-backfill

将缺失或非 ready 的 Thought 加入 AI 处理队列。

**请求体：**

```json
{
  "limit": 50
}
```

**响应：**

```json
{
  "queued": 12
}
```

---

### POST /api/thoughts/relations-rebuild

基于已有 ready AI meta 重建 relations。

该接口不会重新提取 Thought，不会重新生成 embedding；适合在一批 Thought 都已有 meta 后，重新计算关联。

**请求体：**

```json
{
  "limit": 100
}
```

**响应：**

```json
{
  "rebuilt": 100
}
```

---

### GET /api/thoughts/:id/ai-status

读取单条 Thought 的 AI 处理状态。

**响应：**

```json
{
  "id": "1778966668430",
  "status": "ready",
  "meta": { "...": "..." },
  "pending": null,
  "relationsCount": 3,
  "suggestionsCount": 1
}
```

---

### GET /api/thoughts/ai-queue/status

读取后台 AI 队列状态。

**响应：**

```json
{
  "queueSize": 0,
  "processing": 0,
  "concurrency": 3
}
```

---

## Data Management API

数据管理 API 只通过后端操作本地文件和 S3，不会把 S3 credential 暴露给前端。

### GET /api/data-management/status

读取当前存储后端、layout、active S3 prefix 和 inventory。

**响应：**

```json
{
  "backend": "s3",
  "layout": "split",
  "dataDir": "/path/to/data",
  "s3": {
    "configured": true,
    "bucket": "dumbpad",
    "prefix": "dumbpad",
    "spaceRoot": "dumbpad",
    "endpoint": "https://...",
    "region": "s3-cn-east-1"
  },
  "inventory": {
    "prefix": "dumbpad",
    "objectCount": 20,
    "totalBytes": 1024,
    "groups": {}
  }
}
```

### GET /api/data-management/s3/spaces

列出当前 bucket 中可选择的数据空间。非 S3 backend 返回空列表。

**响应：**

```json
{
  "backend": "s3",
  "root": "dumbpad",
  "currentPrefix": "dumbpad",
  "spaces": [
    {
      "prefix": "dumbpad",
      "name": "dumbpad",
      "objectCount": 20,
      "totalBytes": 1024,
      "layout": "nested"
    }
  ]
}
```

### POST /api/data-management/s3/select-space

切换 active S3 prefix。成功后前端应刷新页面。

**请求体：**

```json
{ "prefix": "dumbpad-prod" }
```

**响应：**

```json
{
  "success": true,
  "prefix": "dumbpad-prod",
  "requiresReload": true
}
```

### POST /api/data-management/s3/inventory

读取指定 prefix 的对象统计。

**请求体：**

```json
{ "prefix": "dumbpad-prod" }
```

### POST /api/data-management/s3/backup

备份一个 S3 prefix 到另一个 prefix。

**请求体：**

```json
{
  "prefix": "dumbpad-prod",
  "backupPrefix": "dumbpad-prod-backup-20260531",
  "confirmPrefix": "dumbpad-prod",
  "dryRun": true
}
```

`dryRun: false` 时 `confirmPrefix` 必须和 `prefix` 完全一致。

### POST /api/data-management/s3/delete

删除指定 S3 prefix 下的对象。危险操作必须先 dry-run，再用 `confirmPrefix` 执行。

**请求体：**

```json
{
  "prefix": "dumbpad-test",
  "confirmPrefix": "dumbpad-test",
  "dryRun": true
}
```

### POST /api/data-management/import-local-to-s3

把本地 data 目录导入到 S3 prefix。

**请求体：**

```json
{
  "sourceDataDir": "/path/to/data",
  "prefix": "dumbpad-prod",
  "reportDir": "/path/to/reports",
  "confirmPrefix": "dumbpad-prod",
  "dryRun": true
}
```

### POST /api/data-management/local-overwrite-s3

用本地 data 覆盖 S3 prefix。接口会先计算现有对象、备份和删除预览。

**请求体：**

```json
{
  "sourceDataDir": "/path/to/data",
  "prefix": "dumbpad-prod",
  "backupPrefix": "dumbpad-prod-backup-20260531",
  "confirmPrefix": "dumbpad-prod",
  "dryRun": true
}
```

### POST /api/data-management/s3-overwrite-local

用 S3 prefix 覆盖本地 data 目录。`targetDataDir` 必须是明确命名为 `data` 的目录。

**请求体：**

```json
{
  "prefix": "dumbpad-prod",
  "targetDataDir": "/path/to/data",
  "confirmPrefix": "dumbpad-prod",
  "dryRun": true
}
```

---

## Search 与分享 API

### GET /api/search

全文搜索 Notepad。

**Query 参数：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `q` / `query` | string | 搜索关键词 |
| `page` | number | 页码，默认 `1` |
| `pageSize` | number | 每页数量，默认返回全部 |

**响应：**

```json
{
  "results": [
    {
      "id": "default",
      "title": "Default",
      "content": "...",
      "matches": []
    }
  ],
  "totalPages": 1,
  "currentPage": 1
}
```

### GET /api/share/:id

生成只读分享链接。

**响应：**

```json
{
  "shareUrl": "http://localhost:3000/s/default?t=token"
}
```

### GET /s/:id?t=token

公开只读分享页，返回 HTML。token 无效返回 `403`，文章不存在返回 `404`。

---

## Health API

### GET /health

服务健康检查。

**响应：**

```json
{
  "status": "ok",
  "timestamp": "2026-05-31T00:00:00.000Z"
}
```

---

## WebSocket 事件

Thoughts 的实时广播事件类型为 `thoughts_update`：

```json
{
  "type": "thoughts_update",
  "action": "create | update | delete",
  "payload": { ... }
}
```

Relations 更新事件：

```json
{
  "type": "relations_update",
  "thoughtId": "1778966668430",
  "relationsCount": 3
}
```
