# AI Pipeline Interface

本文档描述 DumbPad 后端 AI pipeline 的稳定边界。AI 能增强 Thought 的检索和关联，但不能改变用户写入的 Thought 本体。

## 职责

AI pipeline 当前由两个主要模块承担：

- `scripts/ai-provider.js`：封装 chat、embedding、rerank provider，以及手动 Thought insight provider。无配置时返回 noop provider。
- `scripts/ai-queue.js`：调度后台任务，生成 meta、embedding、relation candidates、confirmed relations、suggestions 和 diagnostics；同时提供手动 insight 生成函数，但 insight 不进入自动后台队列。

AI pipeline 必须异步运行，不进入 Thought 创建、编辑、删除的关键路径。
Thought insight 必须由用户在前端手动触发，使用独立 `AI_INSIGHT_MODEL`，不得回退或复用 `AI_CHAT_MODEL`。

## 输入

AI pipeline 可以读取：

- Thought 本体：`id`、`text`、`tags`、`subItems`、`completed`、时间字段。
- 用户标签词表。
- 已有 Thought meta。
- 已有 relations。
- suppressed relations。
- 手动 insight 额外可以读取少量 Notepad 搜索文档摘要，用于补充上下文。

## 输出

AI pipeline 可以写入：

- Thought meta：摘要、实体、主题、意图、关键词、AI tags、embedding 状态。
- Thought meta insight：`status`、`markdown`、`model`、`contextIds`、`generatedAt`、`error`。
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
- embedding provider 失败时，AI pipeline 应记录 embedding 阶段错误，但尽量继续使用抽取出的实体、主题、关键词、标签和 Thought 正文进行 relation 判断。
- provider 不可用时，noop provider 应保持接口可用。
- insight 失败只能更新 `meta.insight.error` 和前端提示，不能影响 Thought 本体或关系。

## 调度约束

- 创建 Thought 后只入队，不等待 AI 完成。
- 修改 Thought 后不自动重新运行 AI；用户可在 Thought AI 面板手动触发关系重跑。
- Thought insight 不自动入队，只能通过 `POST /api/thoughts/:id/ai-insight` 手动运行。
- 队列错误应写入 meta/diagnostics 或日志，不应抛回前端保存请求。
- WebSocket 可通知前端刷新 AI 状态，但不能要求前端阻塞等待。
- relation 候选召回应优先避免明显关系在进入 LLM 判断前被本地阈值过滤；最终确认仍由 rerank/chat 分数和阈值控制。
- 发送给 chat rerank 的候选必须包含候选 Thought 正文摘要，不能只提供抽取后的 AI meta。

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
