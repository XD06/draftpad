# AI Pipeline Interface

本文档描述 DumbPad 后端 AI pipeline 的稳定边界。AI 能增强 Thought 的检索和关联，但不能改变用户写入的 Thought 本体。

## 职责

AI pipeline 当前由两个主要模块承担：

- `scripts/ai-provider.js`：封装 chat、embedding、rerank provider。无配置时返回 noop provider。
- `scripts/ai-queue.js`：调度后台任务，生成 meta、embedding、relation candidates、confirmed relations、suggestions 和 diagnostics。

AI pipeline 必须异步运行，不进入 Thought 创建、编辑、删除的关键路径。

## 输入

AI pipeline 可以读取：

- Thought 本体：`id`、`text`、`tags`、`subItems`、`completed`、时间字段。
- 用户标签词表。
- 已有 Thought meta。
- 已有 relations。
- suppressed relations。

## 输出

AI pipeline 可以写入：

- Thought meta：摘要、实体、主题、意图、关键词、AI tags、embedding 状态。
- relation candidates。
- confirmed relations。
- suggestions。
- diagnostics 和 provider/model 信息。

## 禁止改写

AI pipeline 不能改写：

- Thought text。
- Thought tags。
- Thought subItems。
- Thought completed。
- Notepad 内容。

这些字段只由用户操作或明确的用户 API 修改。

## 用户行为优先

- manual relation 不能被 AI rebuild 删除。
- suppressed relation 不能被 rebuild 立即重新推荐。
- AI 失败时，Thought 保存仍应成功。
- provider 不可用时，noop provider 应保持接口可用。

## 调度约束

- 创建或修改 Thought 后只入队，不等待 AI 完成。
- 队列错误应写入 meta/diagnostics 或日志，不应抛回前端保存请求。
- WebSocket 可通知前端刷新 AI 状态，但不能要求前端阻塞等待。

## 后续拆分条件

只有当现有 `test:ai-provider`、`test:ai-queue`、`test:relations` 覆盖稳定后，才考虑进一步拆分：

```text
scripts/ai/
  queue.js
  pipeline.js
  meta-writer.js
  relation-builder.js
  diagnostics.js
```

拆分时必须保持 provider 输入/输出和 relation 写入语义不变。
