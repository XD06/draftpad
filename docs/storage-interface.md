# Storage Interface

本文档描述 `scripts/storage.js` 对上层暴露的稳定接口。重构时应优先保持这些方法的语义、返回结构和错误模式不变，再考虑拆分 implementation。

## 职责

`storage.js` 是 DumbPad 用户数据的唯一读写入口。调用方不应该直接关心数据当前落在本地文件、S3 对象存储、legacy layout 还是 split layout。

它负责：

- 初始化当前 backend 和 layout。
- 隐藏本地路径与 S3 key 规则。
- 维护 active S3 prefix。
- 读写 Notepad、Note、Thought、Relation、AI meta 和搜索 index。
- 兼容 legacy 数据结构。

它不负责：

- HTTP status 和 response body。
- 前端 UI 状态。
- AI prompt、provider 调用或队列调度。
- WebSocket 广播。

## 用户数据接口

这些方法读写用户真实数据，调用方必须把它们视为持久化边界：

- `readNotepadsMeta()`
- `saveNotepadsMeta(data)`
- `readNoteContent(notepad)`
- `writeNoteContent(notepad, content)`
- `readThoughts()`
- `saveThoughts(thoughts)`
- `readThought(id)`
- `writeThought(thought)`
- `deleteThought(id)`
- `readRelations()`
- `writeRelations(relations)`
- `suppressRelation(sourceId, targetId)`

约束：

- 不改变 Notepad、Thought、Relation 的字段含义。
- 不在调用方拼接 S3 key 或本地文件路径。
- 删除 relation 后写入 suppressed，AI rebuild 不能立即恢复被用户否定的关系。

## 派生数据接口

这些方法读写可重建或可缓存的数据：

- `readThoughtMeta(id)`
- `writeThoughtMeta(id, meta)`
- `readIndex()`
- `writeIndex(index)`
- `rebuildIndexes()`

约束：

- 派生数据损坏时应允许重建，不应阻塞核心 Note/Thought 保存。
- AI meta 和 search index 不应改变 Thought 本体字段。

## S3 Prefix 约束

- active prefix 只能通过 `getS3Prefix()` 和 `setS3Prefix(prefix)` 读取与更新。
- `S3_SPACE_ROOT` 只用于列出可选择的数据空间，不应让前端直接接触 S3 credential。
- split layout 的 key 规则必须集中在 storage/S3 工具层，不应散落到 route 或前端。

## 后续拆分条件

只有在当前接口测试稳定后，才考虑把 implementation 拆为：

```text
scripts/storage/
  index.js
  local-adapter.js
  s3-adapter.js
  notes-store.js
  thoughts-store.js
  relations-store.js
  indexes-store.js
```

拆分后仍应由 `scripts/storage.js` 或等价入口提供兼容接口，避免上层调用方集体改动。
