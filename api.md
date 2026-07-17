# DumbPad API 文档

Base URL: `http://localhost:PORT`  
认证方式取决于部署模式：默认兼容旧 PIN；启用个人安全模式后使用浏览器会话或受限 API token。

机器可读 OpenAPI 3.1 文档：`/openapi.json`。API token 只应存在于受信任的本地脚本或服务端自动化中，不能嵌入浏览器前端或公开客户端。

除登录和配置端点外，`/api/*` 默认需要认证。浏览器使用 HttpOnly Cookie；自动化使用 `Authorization: Bearer <token>`。启用 `AUTH_V2_ENABLED=true` 后，旧 PIN Cookie 与 PIN Bearer 都不再可用，token 只可访问内容 API，不能访问认证、数据空间、备份或恢复管理端点。

---

## Auth 与配置 API

### 认证模式

| 模式 | 启用条件 | 浏览器认证 | 自动化认证 |
|---|---|---|---|
| Legacy | 默认 | `dumbpad_auth` PIN Cookie | `Authorization: Bearer <PIN>`，拥有完整权限，仅用于迁移兼容 |
| Personal security V1 | `AUTH_V2_ENABLED=true` | `dumbpad_auth_session` 随机会话 Cookie | `Authorization: Bearer <API token>`，仅 `content:*` / `thoughts:*` scope |

Personal security V1 的初次设置用旧 PIN 或一次性 `AUTH_BOOTSTRAP_TOKEN` 验证。设置完成后，登录使用主密码；可信设备可跳过日常 TOTP，新设备和高风险数据管理操作需要 TOTP。API token 不能调用 `/api/auth/*` 或 `/api/data-management/*`，也没有存储、备份、认证管理 scope。

### GET /api/auth/status

读取认证状态，不泄露认证密钥或配置值。未启用 V2 时响应 `{ "mode": "legacy" }`；启用且尚未初始化时返回 `{ "mode": "setup" }`，初始化后返回 `{ "mode": "login" }`。

### POST /api/auth/setup/start

仅在 V2 未初始化时可用。请求体包含 `legacyPin` 或 `bootstrapToken`、至少 12 字符的 `password` 和可选 `deviceLabel`。成功响应返回 10 分钟有效的 `setupId`、`totpSecret` 和 `otpAuthUri`；密钥只用于随后的本次设置，不能写入日志。

### POST /api/auth/setup/confirm

请求 `{ "setupId": "...", "totpCode": "123456" }`。验证 TOTP 后创建认证状态、首次会话和十个仅显示一次的 `recoveryCodes`。恢复码必须由用户自行保存，服务端只保存其哈希。

### POST /api/auth/login

请求：

```json
{
  "password": "long administrator password",
  "totpCode": "123456",
  "trustDevice": true,
  "deviceLabel": "Windows · browser"
}
```

可信设备只需要主密码；新设备必须同时提供 `totpCode`。成功后写入随机会话 Cookie；最多保存五台可信设备。达到上限时登录仍成功，但响应 `deviceTrustLimited: true`，不签发新的可信设备 Cookie，也不会自动挤掉旧设备。

### POST /api/auth/recovery/start 与 POST /api/auth/recovery/confirm

当验证器不可用时，先用主密码和一枚恢复码调用 `recovery/start`，再用返回的临时新 `totpSecret` 配置验证器，并将 `recoveryId` 与新验证码提交到 `recovery/confirm`。恢复码只能使用一次；完成后旧 TOTP 密钥失效。

### POST /api/auth/elevate

已登录浏览器提交 `{ "totpCode": "123456" }` 后获得最多 10 分钟的高风险验证。创建/撤销 API token、撤销可信设备和任何非只读数据管理请求均需要此状态。

### POST /api/auth/logout

撤销当前浏览器会话并清除认证 Cookie。

### API token 与可信设备

| Endpoint | 说明 |
|---|---|
| `POST /api/auth/api-tokens` | 高风险验证后创建 `{ name, scopes, expiresAt? }`；token 仅在本次响应返回一次。允许 scope：`content:read`、`content:write`、`thoughts:read`、`thoughts:write`。 |
| `GET /api/auth/api-tokens` | 高风险验证后列出 token 元数据，不返回 token 明文。 |
| `DELETE /api/auth/api-tokens/:tokenId` | 高风险验证后立即撤销 token。 |
| `GET /api/auth/devices` | 高风险验证后列出可信设备元数据，不返回设备 token。 |
| `DELETE /api/auth/devices/:deviceId` | 高风险验证后撤销设备及其关联会话。 |

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

### PATCH /api/notepads/:id

更新文章置顶状态。写入使用 `baseVersion` 做乐观并发保护；置顶时服务端写入 `pinnedAt`，目录会把置顶文章排在日期分组之前。

**请求体：**

```json
{
  "pinned": true,
  "baseVersion": 2
}
```

**响应：** 更新后的 Notepad 元数据。

```json
{
  "id": "1778966668430",
  "name": "新文章",
  "pinned": true,
  "pinnedAt": 1778966669500,
  "version": 3
}
```

**错误：**

- `400` — `pinned` 不是布尔值。
- `404` — Notepad 不存在。
- `409` — 服务端版本比 `baseVersion` 新。

### DELETE /api/notepads/:id

将文章移入垃圾桶。`default` 文章不能删除。

**响应：**

```json
{
  "success": true,
  "message": "Notepad moved to trash",
  "trashItem": {
    "trashId": "1778966669000-notepad-abc123",
    "type": "notepad",
    "sourceId": "abc123",
    "title": "新文章",
    "preview": "# Hello",
    "deletedAt": 1778966669000,
    "originalUpdatedAt": 1778966668430,
    "payloadKey": "trash/notepads/1778966669000-notepad-abc123.json"
  }
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

## 文章资源 API

图片与文章附件使用独立资源层保存。图片上传时原始文件完整保留，同时生成浏览用 WebP 预览；普通附件只保存原文件和元数据。文章正文只保存资源 URL，因此不会把文件编码进 Markdown。原图/附件均可保真下载，预览仅用于图片展示。

### POST /api/assets/images

上传一张图片。请求体是原始二进制内容，不是 JSON 或 Base64。支持 JPEG、PNG、WebP、AVIF、GIF；单文件最大 `50MB`。服务端会检查真实图片格式，而不信任请求头。

**请求头：**

| Header | 必填 | 说明 |
|---|---|---|
| `Content-Type` | 是 | 图片 MIME，例如 `image/png` |
| `X-Asset-Name` | 否 | `encodeURIComponent` 编码后的原始文件名，用于下载文件名 |

**响应：**

```json
{
  "id": "f2f621c1-5d64-462f-8e3a-5bc1dd4c16a7",
  "assetId": "f2f621c1-5d64-462f-8e3a-5bc1dd4c16a7",
  "name": "architecture-4k.png",
  "type": "image/png",
  "kind": "image",
  "size": 8240551,
  "previewUrl": "/api/assets/f2f621c1-5d64-462f-8e3a-5bc1dd4c16a7/preview",
  "originalUrl": "/api/assets/f2f621c1-5d64-462f-8e3a-5bc1dd4c16a7/original",
  "downloadUrl": "/api/assets/f2f621c1-5d64-462f-8e3a-5bc1dd4c16a7/download"
}
```

`previewUrl` 返回经缩放的 WebP，可直接放在 `<img>` 中；`originalUrl` 以原始 MIME 返回完整原图；`downloadUrl` 添加附件下载响应头。所有资源 URL 以不可变 id 为键，可按长期缓存处理。

```bash
curl -X POST http://localhost:3000/api/assets/images \
  -H "Authorization: Bearer $DUMBPAD_API_TOKEN" \
  -H "Content-Type: image/png" \
  -H "X-Asset-Name: architecture-4k.png" \
  --data-binary @architecture-4k.png
```

### POST /api/assets/files

上传一份普通文章附件。请求体是原始二进制内容，不是 JSON 或 Base64。默认单文件最大 `20MiB`，可通过服务端 `ASSET_MAX_FILE_BYTES` 调整。

允许 PDF、纯文本/Markdown/CSV、Office 文档、音视频和 ZIP/RAR/7z；HTML、SVG、脚本和可执行文件会被拒绝。服务端会校验扩展名与声明 MIME 的匹配，并且所有普通附件都强制下载，不能以内联页面执行。

**请求头：**

| Header | 必填 | 说明 |
|---|---|---|
| `Content-Type` | 是 | 固定为 `application/octet-stream` |
| `X-Asset-Name` | 是 | `encodeURIComponent` 编码后的原始文件名 |
| `X-Asset-Type` | 否 | 浏览器报告的原始 MIME，用于与扩展名交叉校验 |

**响应：** 与图片资源相同，但 `kind` 为 `file`，`previewUrl` 为 `null`。

```bash
curl -X POST http://localhost:3000/api/assets/files \
  -H "Authorization: Bearer $DUMBPAD_API_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Asset-Name: report.pdf" \
  -H "X-Asset-Type: application/pdf" \
  --data-binary @report.pdf
```

### GET /api/assets/:id/:variant

读取图片或普通附件资源。

| `variant` | 行为 |
|---|---|
| `preview` | 仅图片可用，返回 WebP 预览，适合正文渲染 |
| `original` | 返回上传时的原始字节与原始 MIME；普通附件仍强制下载 |
| `download` | 返回原始字节，并带 `Content-Disposition: attachment` |

不存在或非法 id 返回 `404`；`preview`、`original`、`download` 之外的 variant 同样返回 `404`。

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
| `status` | `all` / `todo` / `done` | 按完成状态过滤；省略或 `all` 表示全部。 |
| `limit` | number | 限制返回数量，最大 50 |
| `light` | `1` / `true` | 轻量列表模式，只返回基础 Thought 字段，不读取 AI meta 和 relation count。用于手动关联搜索等高频输入场景。 |
| `format` | `page` | 可选游标分页模式；省略时继续返回兼容的 `Thought[]` 数组。 |
| `cursor` | string | `format=page` 返回的下一页游标。 |
| `sort` | `timeline` | 可选。仅在 `format=page` 下使用，按页面时间线顺序（置顶、未完成、已完成、创建时间）返回，并配套返回专用游标；省略时维持按最近更新排序，适合同步程序。 |
| `updatedSince` | number | 仅返回 `updatedAt` 大于该 Unix 毫秒时间戳的 Thought。 |

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

# 供同步程序使用的游标分页和增量读取
curl "http://localhost:3000/api/thoughts?format=page&light=1&limit=50&updatedSince=1778966668430"

# 按日期
curl "http://localhost:3000/api/thoughts?date=2026-05-17"

# 组合
curl "http://localhost:3000/api/thoughts?q=车&date=2026-05-17"
```

当 `format=page` 时，响应结构为：

```json
{
  "items": [{ "id": "1778966668430", "version": 4 }],
  "nextCursor": "eyJ1cGRhdGVkQXQiOjE3Nzg5NjY2Njg0MzAsImlkIjoiMTc3ODk2NjY2ODQzMCJ9",
  "hasMore": true
}
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

所有会写入的 PATCH 请求都应带上当前 Thought 的 `baseVersion`。服务端版本更高时返回 `409` 和 `{ "error": "...", "currentVersion": 5 }`；客户端应先读取远端状态并合并，不应使用旧内容覆盖重试。

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

将 Thought 移入垃圾桶，并清理活动 relation 引用。

**响应：**

```json
{
  "success": true,
  "trashItem": {
    "trashId": "1778966669000-thought-1778966668430",
    "type": "thought",
    "sourceId": "1778966668430",
    "title": "完成项目报告",
    "preview": "完成项目报告 收集数据",
    "deletedAt": 1778966669000,
    "originalUpdatedAt": 1778966668486,
    "payloadKey": "trash/thoughts/1778966669000-thought-1778966668430.json"
  }
}
```

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

### POST /api/thoughts/:id/ai-insight

手动为当前 Thought 生成“思考扩展”。该接口不会进入后台关系队列，也不会改写 Thought 正文、标签或子任务；结果写入 Thought meta 的 `insight` 字段。

该功能必须配置独立模型 `AI_INSIGHT_MODEL`，并且不能与 `AI_CHAT_MODEL` 相同。未配置时返回 `503`，不会回退到原 Chat/抽取模型。服务端使用 `AI_INSIGHT_MAX_CHARS`（默认 `800`）限制存储的 Markdown 长度。

**响应：**

```json
{
  "success": true,
  "insight": {
    "status": "ready",
    "markdown": "**下一步**：先验证最小上下文是否足够支持判断。",
    "generatedAt": 1778966669000,
    "updatedAt": 1778966669000,
    "model": "dedicated-insight-model",
    "contextIds": [
      "thought:1778966668000",
      "notepad:research"
    ],
    "error": null
  }
}
```

**错误：**

- `404` — Thought 不存在。
- `503` — 未配置独立 insight 模型，或 insight 模型复用了原 Chat 模型。
- `409` — 生成期间 Thought 的正文、子任务文本或用户标签已变更，旧结果被丢弃；请重新生成。
- `500` — provider 请求失败或返回内容异常；失败信息会写入 `meta.insight.error`。

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

`status` 可能为 `pending`、`ready`、`stale`、`empty`、`error` 或 `missing`。`stale` 表示 Thought 语义内容已修改，已有关联和 insight 基于旧版本。

**响应：**

```json
{
  "id": "1778966668430",
  "status": "ready",
  "relationCount": 3,
  "suggestionCount": 1,
  "aiTags": ["产品"],
  "stages": { "...": "..." },
  "models": {
    "extract": "deepseek-v4-flash",
    "embedding": "Qwen/Qwen3-Embedding-0.6B",
    "rerank": null,
    "insight": "dedicated-insight-model"
  },
  "insight": {
    "status": "ready",
    "markdown": "**下一步**：先验证最小上下文是否足够支持判断。",
    "generatedAt": 1778966669000,
    "updatedAt": 1778966669000,
    "model": "dedicated-insight-model",
    "contextIds": ["thought:1778966668000"],
    "error": null
  },
  "diagnostics": { "...": "..." }
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

## 交互 AI Agent API（阶段 A）

交互 Agent 是用户主动发起的只读工作流，与 Thought 创建后的后台 AI 队列完全独立。首期只开放 `recall_context`：从当前 Thought 中找回有限的相关 Thought/文章片段，返回可核验引用；不会写入 Thought、Notepad、标签、任务或 relation。

需要显式配置 `AI_AGENT_ENABLED=true`、`AI_AGENT_BASE_URL`、`AI_AGENT_API_KEY` 与 `AI_AGENT_MODEL`。未配置时创建运行返回 `503`，不会回退到 `AI_CHAT_MODEL` 或 `AI_INSIGHT_MODEL`。

### GET /api/agent/capability

读取当前 Agent 是否可用，不返回密钥或 provider URL。

```json
{
  "enabled": true,
  "ready": true,
  "reason": null,
  "model": "your-agent-model"
}
```

### POST /api/agent/runs

创建一次异步运行。当前只接受 Thought 来源；相同主体、工作流、来源版本和 `idempotencyKey` 在未结束前会复用同一个运行。

```json
{
  "workflowId": "recall_context",
  "source": { "kind": "thought", "id": "thought-id" },
  "idempotencyKey": "client-generated-unique-key"
}
```

**响应：** `202`（新建）或 `200`（复用）

```json
{
  "runId": "agr_...",
  "status": "queued",
  "reused": false,
  "run": { "id": "agr_...", "workflowId": "recall_context", "status": "queued" }
}
```

### GET /api/agent/runs/:runId

读取运行终态或当前状态。`result` 中的 `claims` 只能引用同一次工具读取实际返回的 `citations`；`sourceStale=true` 表示当前 Thought 已在运行后改变，结果仍可阅读但基于旧版本。

```json
{
  "run": {
    "id": "agr_...",
    "status": "completed",
    "sourceStale": false,
    "result": {
      "summary": "找到两条可回看的旧想法。",
      "claims": [{ "text": "…", "citationIds": ["src_1"] }],
      "citations": [{ "citationId": "src_1", "sourceRef": { "kind": "thought", "id": "...", "version": 3, "excerptHash": "sha256:...", "label": "...", "location": { "start": 0, "end": 120 } } }]
    }
  }
}
```

### GET /api/agent/runs/:runId/events

以 SSE 推送单次运行的用户可见进度。支持 `Last-Event-ID` 或 `?lastEventId=` 续传；内存缓冲不足时发送 `run.reset`，客户端应改用 `GET /api/agent/runs/:runId` 恢复终态。事件包括 `run.started`、`retrieval.started`、`retrieval.completed`、`generation.started`、`text.delta`、`run.completed`、`run.failed` 与 `run.cancelled`。

浏览器同源请求使用登录 Cookie。原生 `EventSource` 不能携带 Bearer header，因此外部 API 客户端若使用 PIN Bearer 认证，应使用可设置请求头的流式 HTTP 客户端，而不是把 PIN 放到 URL。

### POST /api/agent/runs/:runId/cancel

幂等请求取消未结束运行。取消只停止模型/工具调用，不会回滚或改写任何用户内容。

**错误：**

- `400` — 工作流、来源、运行 ID 或幂等键非法。
- `401` / `403` — 未认证或运行不属于当前主体。
- `404` — Thought 或运行不存在。
- `429` — 超出单次工具/上下文/每日运行限制。
- `503` — Agent 模型未配置。

---

## Trash API

垃圾桶保存已删除的文章和 Thought。它属于用户数据，local 和 S3 backend 都通过 `scripts/storage.js` 写入同一组逻辑路径：

- `trash/index.json`
- `trash/notepads/<trashId>.json`
- `trash/thoughts/<trashId>.json`

### GET /api/trash

读取垃圾桶轻量列表。

**响应：**

```json
{
  "items": [
    {
      "trashId": "1778966669000-notepad-abc123",
      "type": "notepad",
      "sourceId": "abc123",
      "title": "新文章",
      "preview": "# Hello",
      "deletedAt": 1778966669000,
      "originalUpdatedAt": 1778966668430,
      "payloadKey": "trash/notepads/1778966669000-notepad-abc123.json"
    }
  ]
}
```

### GET /api/trash/:trashId

读取单个垃圾桶项目和完整 payload。Notepad payload 包含 `{ notepad, content }`；Thought payload 包含 `{ thought, meta, relations, suppressed }`。

### POST /api/trash/:trashId/restore

恢复垃圾桶项目。恢复后会重新写入当前数据空间，并从垃圾桶删除对应 payload 和 index 记录。若恢复 Notepad 时 id 或标题冲突，服务端会生成恢复用 id/标题；恢复 Thought 时会过滤已经不存在的 relation 目标，并补回仍存在目标的反向 relation。

**响应：**

```json
{
  "success": true,
  "restored": {
    "type": "thought",
    "item": {
      "id": "1778966668430",
      "text": "完成项目报告",
      "restoredAt": 1778966669500
    },
    "affectedRelationIds": ["1778966668430", "1778966668500"]
  }
}
```

### DELETE /api/trash/:trashId

永久删除一个垃圾桶项目。只删除垃圾桶 index 记录和 payload，不影响活动数据。

**响应：** `{ "success": true }`

### DELETE /api/trash

清空垃圾桶。

**响应：**

```json
{
  "success": true,
  "deleted": 3
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

> 默认禁用。只有部署环境显式设置 `DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS=true` 时，非 dry-run 请求才可能执行；该遗留接口将被归档/恢复流程替代。

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

> 默认禁用。只有部署环境显式设置 `DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS=true` 时，非 dry-run 请求才可能执行；不得用于日常同步。

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
