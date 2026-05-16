# DumbPad API 文档

Base URL: `http://localhost:PORT`  
认证方式: Cookie (`dumbpad_auth`) 或 Header (`Authorization: Bearer <PIN>`)

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

**响应：** `Thought[]`

**示例：**
```bash
# 获取全部
curl http://localhost:3000/api/thoughts

# 搜索
curl "http://localhost:3000/api/thoughts?q=报告"

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

## WebSocket 事件

Thoughts 的实时广播事件类型为 `thoughts_update`：

```json
{
  "type": "thoughts_update",
  "action": "create | update | delete",
  "payload": { ... }
}
```
