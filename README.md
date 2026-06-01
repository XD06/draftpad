# DumbPad - 极简混合 Markdown 草稿本

DumbPad 是一款专注于速度、美感与跨端体验的极简 Markdown 编辑器。它采用了“混合编辑”模式，将 Markdown 的强大功能与所见即所得的直观性完美结合，特别针对移动端进行了深度交互优化。

## 🌟 核心特性

### 1. 混合编辑体验 (Hybrid Editor)
- **无缝切换**：点击即进入编辑模式，离开即自动渲染，无需手动切换预览。
- **高性能渲染**：基于 Vditor 核心，支持完整的 Markdown 语法及实时代码高亮。

### 2. 深度移动端优化
- **双标签侧边栏**：移动端专属“目录”与“最近”双面板切换，最大化利用屏幕空间。
- **智能分组**：侧边栏自动按日期（今天、昨天、2 天前等）对文件进行分组，并自动折叠较旧的记录。
- **触控友好**：移动端支持**长按**唤出重命名与删除按钮，防止单手操作误触。
- **全 HTML 模态框**：弃用原生弹窗，统一使用精心设计的移动端友好交互界面。

### 3. 精准搜索与导航
- **全局模糊搜索**：支持中文搜索，即便文件众多也能秒速定位。
- **关键词直达**：搜索结果点击后，编辑器会自动滚动到关键词所在行并进行高亮闪烁提示。

### 4. 极致交互 UX
- **悬浮助手组**：
  - **智能滚动**：根据阅读位置自动切换“一键触底”或“一键回顶”。
  - **快速复制**：侧边悬浮复制按钮，随时随地一键提取全文。
- **沉浸式阅读**：滑动页面时，所有悬浮按钮会自动渐隐隐藏，停止滑动后平滑出现，确保阅读无干扰。
- **全局快捷键**：
  - `Ctrl + Z`：连续撤销更改。
  - `Ctrl + Y`：重做更改。
  - 支持在非编辑模式下直接触发撤销。

### 5. Quick Thoughts 待办

- **主任务 + 子任务**：支持二层待办结构，子任务独立管理完成状态。
- **结构化存储**：子任务以结构化数组存储，可通过 API 精确操作。
- **状态筛选**：全部 / 待办 / 已完成 三态快速切换。
- **关键词搜索**：搜索同时覆盖主任务和子任务文本。
- **日期过滤**：按日期浏览历史待办记录。
- **兼容老数据**：自动识别文本中的 `- [ ]` / `- [x]` 格式，编辑保存后迁移为新格式。
- **交互手势**：
  - 单击文本 → 展开/收起长内容
  - 双击文本 → 进入编辑模式（Ctrl+Enter 保存，Esc 取消）
  - 长按文本 → 删除
  - 点击圆点 → 切换完成状态

### 6. AI Relations

- **AI 元数据**：创建或更新 Thought 后异步生成摘要、实体、主题、意图、关键词、标签和 embedding。
- **准确优先关联**：本地召回候选后，可选用专用 reranker 排序，再由 LLM 判断 `relationType`、置信度和原因。
- **关系管理**：前端可展开关联列表、查看关联原因、跳转高亮目标 Thought、删除误判关联。
- **误判记忆**：删除过的误判会写入 `relations.suppressed/`，后续重算不会立刻恢复。
- **降级可用**：没有 AI Key 或 AI 服务失败时，核心保存流程不受影响。

### 7. 安全、同步与存储
- **PIN 码保护**：支持访问权限校验，保护私密草稿。
- **多端同步**：基于轻量 WebSocket 事件同步 `notes_update`、`thoughts_update`、`relations_update`、`notepad_change`。
- **多后端存储**：支持本地文件存储和 S3 兼容对象存储，前端 API 保持不变。
- **PWA 支持**：可作为应用安装到手机或桌面，支持离线查看及沉浸式全屏体验。

## 🧱 架构边界

DumbPad 当前保持无构建工具的 Vanilla JS 前端和 Express 后端。重构原则是小步提取高内聚模块，不改变 API、数据结构和用户可见行为。

- `server.js` 仍是后端入口，负责静态资源、鉴权、WebSocket、Notepad/Thought API、搜索和数据管理。
- `scripts/storage.js` 是本地/S3、legacy/split layout 的统一存储边界，上层不直接关心数据落在哪里。
- `scripts/ai-queue.js` 和 `scripts/ai-provider.js` 负责后端 AI pipeline；AI、S3、WebSocket 都不能阻塞 Thought 快速写入。
- `public/managers/thought-api-client.js` 封装 Thought HTTP 细节，统一 URL 编码和非 `ok` 错误。
- `public/managers/thought-outbox.js` 管理 Thought 浏览器本地 outbox 的持久化、合并和重试。
- `public/managers/thought-relations-panel.js`、`thought-editor.js`、`thought-renderer.js` 承接 Thought 关系面板、编辑 helper、过滤排序等高变化逻辑。
- `public/managers/note-sync-controller.js` 管理启动缓存和 Note cache 读写，`app.js` 继续协调编辑器和设置页 DOM。
- `public/managers/settings-data-panel.js` 封装设置页数据空间和云端维护 API，前端不直接散落数据管理 URL。
- `routes/data-management-routes.js` 承接后端数据管理 route，`server.js` 只负责注册。
- `public/managers/thoughts.js` 保留 Thought UI 协调职责：渲染、事件绑定、toast、乐观更新和调用 API/outbox 模块。

更详细的模块说明见 [项目技术介绍](docs/technical-overview.md)。

## 🚀 快速开始

1. **安装依赖**：
   ```bash
   npm install
   ```

2. **配置环境变量**：
   参考 `.env.example` 创建 `.env` 文件，设置你的 `DUMBPAD_PIN` 等参数。

3. **启动应用**：
   ```bash
   npm run dev
   ```

4. **访问**：
   默认地址为 `http://localhost:3000`

## ⚙️ 存储与 AI 配置

默认使用本地存储：

```env
DATA_DIR=./data
STORAGE_BACKEND=local
STORAGE_LAYOUT=legacy
```

使用 S3 兼容存储：

```env
STORAGE_BACKEND=s3
STORAGE_LAYOUT=split
S3_ENDPOINT=https://s3-cn-east-1.qiniucs.com
S3_REGION=s3-cn-east-1
S3_BUCKET=dumbpad
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_PREFIX=optional-prefix
```

说明：
- `STORAGE_LAYOUT=legacy` 会把 Thought 保存在 `thoughts.json`，适合本地单机。
- `STORAGE_LAYOUT=split` 会把 Thought 拆到 `thoughts/<id>.json`，推荐配合 S3 使用，避免大文件频繁读写。
- `S3_PREFIX` 是数据集隔离边界，测试数据、真实数据、备份数据应使用不同 prefix。
- `S3_SECRET_KEY` 可用 `S3_API_KEY` 代替；前端不会直接连接 S3，所有云端操作都走后端 API。

AI 关联使用 OpenAI-compatible 接口；不配置 Key 时自动使用 noop provider：

```env
AI_BASE_URL=https://example.com/v1
AI_API_KEY=your-api-key
AI_CHAT_MODEL=deepseek-v4-flash
AI_EMBEDDING_BASE_URL=https://example.com/v1
AI_EMBEDDING_API_KEY=your-embedding-key
AI_EMBEDDING_MODEL=text-embedding-3-small
AI_RERANK_BASE_URL=https://api.siliconflow.cn/v1
AI_RERANK_API_KEY=your-rerank-key
AI_RERANK_MODEL=BAAI/bge-reranker-v2-m3
AI_TIMEOUT_MS=60000
AI_QUEUE_CONCURRENCY=3
AI_PENDING_RECOVERY_MS=120000
AI_BACKFILL_TIMEOUT_MS=900000
```

AI 运行规则：
- 创建或更新 Thought 后，AI 在后端队列异步运行，不阻塞快速记录。
- `AI_QUEUE_CONCURRENCY` 控制后台并发，个人机器建议保持 `2-4`。
- 关系重建优先使用已有 ready meta；需要强制重新分析时使用 backfill 脚本的 `--force`。

Relations 重建接口只使用已有 ready meta，不重新提取 Thought，不重新生成 embedding：

```bash
curl -X POST http://localhost:3000/api/thoughts/relations-rebuild \
  -H "Content-Type: application/json" \
  -d '{"limit": 100}'
```

S3 后端会保存 `thoughts/`、`thoughts.meta/`、`relations/`、`relations.suppressed/`、`indexes/` 和 notepad 数据。应用仍然保持本地优先思路：AI 和 S3 都是后台能力，不应阻塞首屏和快速写入。

真实数据迁移建议先走 staging prefix：先 dry-run，再导入到新 prefix，确认页面可读后再运行 AI backfill。不要直接清空 bucket，也不要把测试 prefix 当成真实数据源。

## ✅ 验证命令

```bash
npm run check
npm run test:api
npm run test:ai-provider
npm run test:ai-queue
npm run test:relations
npm run test:s3-storage
```

真实 S3 smoke 需要先配置 S3 环境变量和唯一 `S3_PREFIX`：

```bash
npm run test:s3-real
```

## ⌨️ 快捷键指南

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + Z` | 撤销 (Undo) |
| `Ctrl + Y` | 重做 (Redo) |
| `Ctrl + P` | 打印当前文档 |
| `Ctrl + \` | 搜索文档 (Search) |

## 📚 文档

- [API 文档](api.md) — 完整的 Thoughts REST API 参考
- [项目技术介绍](docs/technical-overview.md) — 当前模块边界、数据流和后续重构顺序
- [Storage Interface](docs/storage-interface.md) — 本地/S3 存储接口约束
- [AI Pipeline Interface](docs/ai-pipeline-interface.md) — AI 队列、provider 与 relation 写入约束
- [同步边界说明](docs/sync-boundaries.md) — Notepad、Thought、AI、S3 和 WebSocket 的同步职责

## 🛠️ 技术栈
- **后端**：Node.js + Express
- **前端**：Vanilla JS + CSS3 (Glassmorphism)
- **渲染**：Vditor / Marked
- **存储**：本地 JSON / S3 兼容对象存储
- **搜索**：服务端 Fuse.js，数据源来自 `storage.getSearchDocuments()`

---

*让记录回归简单。*
