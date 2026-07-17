# DumbPad - 极简混合 Markdown 草稿本

DumbPad 是一款专注于速度、美感与跨端体验的极简 Markdown 编辑器。它采用了“混合编辑”模式，将 Markdown 的强大功能与所见即所得的直观性完美结合，特别针对移动端进行了深度交互优化。

## 🌟 核心特性

### 1. 混合编辑体验 (Hybrid Editor)
- **无缝切换**：点击即进入编辑模式，离开即自动渲染，无需手动切换预览。
- **高性能渲染**：基于 Vditor 核心，支持完整的 Markdown 语法及实时代码高亮。

### 2. 深度移动端优化
- **双标签侧边栏**：移动端专属“目录”与“最近”双面板切换，最大化利用屏幕空间。
- **智能分组**：侧边栏自动按日期（今天、昨天、2 天前等）对文件进行分组，并自动折叠较旧的记录。
- **目录标题搜索与快速切换**：目录搜索仅匹配文章标题；切换已有文章时先展示本地启动缓存，再在后台校验服务端新版本，减少目录切换的等待感。
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
- **置顶功能**：卡片右上角置顶按钮，置顶内容优先排序并显示金色边框
- **附件支持**：支持插入图片和文件（Base64 存储，单文件最大 4MB），编辑模式下可管理附件

### 6. AI Relations

- **AI 元数据**：创建 Thought 后异步生成摘要、实体、主题、意图、关键词、标签和 embedding；语义编辑后会标记为“AI 待更新”，由用户在 AI 面板手动重新运行。
- **准确优先关联**：本地召回候选后，可选用专用 reranker 排序，再由 LLM 判断 `relationType`、置信度和原因。
- **关系管理**：前端可展开关联列表、查看关联原因、跳转高亮目标 Thought、删除误判关联。
- **手动关联搜索**：可搜索 Thought 并手动建立关联，候选项会高亮关键词；搜索使用轻量接口和前端防抖，避免 S3 场景下频繁读取 AI meta 和 relation count。
- **误判记忆**：删除过的误判会写入 `relations.suppressed/`，后续重算不会立刻恢复。
- **找回相关内容（可选）**：用户可在 Thought 的 AI 分析折叠区主动启动只读 `recall_context` 工作流，在有限候选中找回旧想法和文章片段，并查看可点击的结构化引用；不改写用户内容。
- **降级可用**：没有 AI Key 或 AI 服务失败时，核心保存流程不受影响。

### 7. 安全、同步与存储
- **PIN 码保护**：支持访问权限校验，保护私密草稿。
- **多端同步**：基于轻量 WebSocket 事件同步 `notes_update`、`thoughts_update`、`relations_update`、`notepad_change`。
- **多后端存储**：支持本地文件存储和 S3 兼容对象存储，前端 API 保持不变。
- **文章资源命令**：编辑文章时输入 `/file` 后按 Enter，即可从系统选择一个或多个图片/附件；图片以内联预览显示，普通文件显示为下载卡片。普通附件默认单文件上限为 20MB（可通过 `ASSET_MAX_FILE_BYTES` 调整），正文不保存 Base64。
- **PWA 支持**：可作为应用安装到手机或桌面，支持离线查看及沉浸式全屏体验。Service Worker 会缓存核心静态资源；字体和编辑器运行时资源在实际使用后写入缓存，避免首次安装额外下载大文件。
- **移动端视口优化**：支持 `100dvh` 动态视口高度，降低手机浏览器地址栏收起、键盘弹出时造成的布局跳动。

## 🧱 架构边界

DumbPad 当前保持无构建工具的 Vanilla JS 前端和 Express 后端。重构原则是小步提取高内聚模块，不改变 API、数据结构和用户可见行为。

- `server.js` 仍是后端入口，负责静态资源、鉴权、WebSocket、Notepad/Thought API、搜索和数据管理。
- `scripts/storage.js` 是本地/S3、legacy/split layout 的统一存储边界；split 模式的 Thought 分页复用索引，只读取当前页对象，关键词搜索和 legacy 模式保留完整读取回退。
- `scripts/ai-queue.js` 和 `scripts/ai-provider.js` 负责后端 AI pipeline；AI、S3、WebSocket 都不能阻塞 Thought 快速写入。
- `scripts/agent/` 是交互 Agent 的独立运行线：工作流、只读上下文工具、运行状态、SSE 和模型适配各自隔离，不复用后台队列。
- `public/managers/thought-api-client.js` 封装 Thought HTTP 细节，统一 URL 编码和非 `ok` 错误。
- `public/managers/thought-outbox.js` 管理 Thought 浏览器本地 outbox 的持久化、合并和重试。
- `public/managers/thought-*` 拆分 Thought 前端高变化逻辑：API client、outbox、卡片渲染、标签、AI 状态、关系面板、关系本地状态、Quick Add 数据构造、编辑 helper、文本格式化、过滤排序等。
- `public/managers/note-sync-controller.js` 管理启动缓存和 Note cache 读写，`app.js` 继续协调编辑器和设置页 DOM。
- `public/managers/settings-data-panel.js` 封装设置页数据空间和云端维护 API，前端不直接散落数据管理 URL。
- `routes/data-management-routes.js` 承接后端数据管理 route，`server.js` 只负责注册。
- `routes/auth-routes.js`、`routes/note-routes.js`、`routes/notepad-routes.js`、`routes/search-routes.js`、`routes/share-routes.js`、`routes/static-routes.js`、`routes/thought-routes.js` 承接主要 HTTP route，降低 `server.js` 的耦合度。
- `public/managers/thoughts.js` 保留 Thought UI 协调职责：游标分页、批量卡片插入、局部卡片更新、事件绑定、toast、乐观更新和调用 API/outbox 模块。
- `public/app.js` 的 Thought 视图与 Marked 渲染器采用延迟加载：首屏进入 Notepad 编辑时不再立即解析 Thought 大模块和 Markdown 渲染库。

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

## 🐳 Docker 一键更新

部署机上进入仓库目录后运行：

```bash
npm run docker:update
```

默认流程会先 `git fetch --prune && git pull --ff-only`，再用当前仓库源码重建 `dumbpad` 服务并重启容器，最后轮询 `/health`。常用参数：

```bash
npm run docker:update -- --skip-git-pull
npm run docker:update -- --health-url http://127.0.0.1:3000/health
npm run docker:update -- --service dumbpad --compose-file docker-compose.yml
npm run docker:update -- --image-only
```

说明：`docker-compose.yml` 默认配置了上游镜像；脚本默认会临时追加本地 build override，确保更新的是本仓库当前代码。只有需要直接拉取 compose 中配置的镜像时才使用 `--image-only`。

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
- `DUMBPAD_ENABLE_DESTRUCTIVE_DATA_OPERATIONS=false` 是默认安全开关：空间删除、本地覆盖 S3、S3 覆盖本地和非 dry-run 本地导入会被拒绝。不要在日常运行中开启；后续安全恢复流程会替代这些遗留操作。
- `npm run test:s3-real` 会在结束时删除目标 `S3_PREFIX` 下的对象。运行前必须在命令环境中额外设置 `DUMBPAD_REAL_S3_SMOKE_CONFIRM_PREFIX` 为完全相同的 prefix，并使用专用测试空间。
- 前端不会直接连接 S3，所有云端操作都走后端 API。

个人安全模式在准备好独立持久目录后才启用：设置 `AUTH_V2_ENABLED=true`、`AUTH_STATE_DIR=/var/lib/dumbpad-security` 和一个随机 32 字节 `AUTH_MASTER_KEY`。首次访问用旧 PIN 或一次性 `AUTH_BOOTSTRAP_TOKEN` 完成主密码、TOTP 与恢复码设置；以后已登录设备不被打断，可信设备在会话过期后只要求主密码，新设备和高危数据操作才要求 TOTP。系统最多保存 5 台可信设备，超过时仍能用密码加 TOTP 登录，只是不再自动信任新设备。不要把 `AUTH_MASTER_KEY` 放进仓库、浏览器或应用数据桶。

备份由宿主机而非应用容器执行。`deploy/systemd/backup.env.example` 是 root-only 备份配置模板；它使用 `BACKUP_DIR=/var/lib/dumbpad-backups`、1GiB 去重加密仓库和独立 `BACKUP_S3_*` 桶。主数据使用 S3 时，备份 CLI 要求一套只读 `S3_*` 源凭证和独立备份仓库配置，缺少独立备份桶会拒绝执行。恢复只能写入空的本地目录或新的空 S3 prefix，绝不覆盖正在使用的数据空间。

最小部署步骤：将模板复制为仅 root 可读的 `/etc/dumbpad/backup.env`，填入只读运行桶凭证、仅用于备份桶的另一套凭证及独立 `BACKUP_MASTER_KEY`；根据实际项目路径调整 `deploy/systemd/dumbpad-backup.service` 中的 `WorkingDirectory` 和 `ExecStart`，安装 service/timer 后运行一次 `node scripts/backup/backup-cli.js snapshot`，再用 `list` 和一次“恢复到新目标”的演练验证。备份容量和保留规则在 [数据安全 V1 设计](docs/superpowers/specs/2026-07-16-data-safety-v1-design.md) 中说明。

AI 关联使用 OpenAI-compatible 接口；不配置 Key 时自动使用 noop provider：

```env
AI_BASE_URL=https://example.com/v1
AI_API_KEY=your-api-key
AI_CHAT_MODEL=deepseek-v4-flash
AI_INSIGHT_BASE_URL=https://example.com/v1
AI_INSIGHT_API_KEY=your-insight-api-key
AI_INSIGHT_MODEL=your-dedicated-insight-model
AI_INSIGHT_MAX_CHARS=800
AI_EMBEDDING_BASE_URL=https://example.com/v1
AI_EMBEDDING_API_KEY=your-embedding-key
AI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
AI_RERANK_BASE_URL=https://api.siliconflow.cn/v1
AI_RERANK_API_KEY=your-rerank-key
AI_RERANK_MODEL=BAAI/bge-reranker-v2-m3
AI_RELATION_META_READ_CONCURRENCY=4
```

AI 运行规则：
- 创建 Thought 后，关系分析 AI 在后端队列异步运行，不阻塞快速记录；修改 Thought 后由用户在 AI 面板中手动重新运行。
- Thought 思考扩展只由用户在 AI 面板中手动触发，必须配置 `AI_INSIGHT_MODEL`，且不能复用 `AI_CHAT_MODEL`。它会向配置的 AI 服务发送当前 Thought、少量关联/相关 Thought 和匹配文章摘要；服务端以 `AI_INSIGHT_MAX_CHARS` 限制存储结果长度。
- 关系重建优先使用已有 ready meta；需要强制重新分析时使用 backfill 脚本的 `--force`。

交互 Agent 默认关闭，且必须使用单独的显式模型配置：

```env
AI_AGENT_ENABLED=false
AI_AGENT_BASE_URL=https://example.com/v1
AI_AGENT_API_KEY=your-agent-key
AI_AGENT_MODEL=your-agent-model
AI_AGENT_MAX_STEPS=3
AI_AGENT_TIMEOUT_MS=45000
```

首期仅实现 Thought 的只读“找回相关内容”。模型、网络、SSE 或 AgentRun 存储失败不会影响 Thought/Notepad 保存；完整边界见 [AI 流程与 Agent 框架设计](docs/ai-agent-framework.md)。

Relations 重建接口只使用已有 ready meta，不重新提取 Thought，不重新生成 embedding：

```bash
curl -X POST http://localhost:3000/api/thoughts/relations-rebuild \
  -H "Content-Type: application/json" \
  -d '{"limit": 100}'
```

S3 后端会保存 `thoughts/`、`thoughts.meta/`、`relations/`、`relations.suppressed/`、`agent-runs/`、`indexes/` 和 notepad 数据。应用仍然保持本地优先思路：AI 和 S3 都是后台能力，不应阻塞首屏和快速写入。

真实数据迁移建议先走 staging prefix：先 dry-run，再导入到新 prefix，确认页面可读后再运行 AI backfill。不要直接清空 bucket，也不要把测试 prefix 当成真实数据源。

## 🧪 演示数据与手动回归

本仓库提供一组固定 ID 的本地演示数据，包含 6 篇 Notepad、文章置顶、10 条 Thought、子任务、完成状态、附件、手动关联、时间图标、搜索关键词、同步与 API 回归场景。它同时可作为手动测试和接口测试夹具。

运行以下命令会**清空当前本地 `data/` 目录**，然后重新生成演示数据；脚本会拒绝在 S3 后端或非 `data` 目录执行：

```bash
npm run seed:demo
```

生成后可从“欢迎使用 DumbPad”开始体验，并重点检查：

- `/time` 生成、时间图标的可视拖拽和跨段落落点光标。
- 普通文本连续输入并按一次 Enter：源码模式中只出现软换行，不产生可编辑空段；标题、列表、引用和代码块仍保留各自的默认回车行为。
- 源码/可视/阅读模式切换时的光标与视线恢复。
- Notepad 和 Thought 的中文搜索、跳转及关键词高亮。
- Thought 的置顶、子任务、附件、手动关联、完成筛选、分页加载和离线 outbox 重试。
- `baseVersion` 的乐观并发、`409` 冲突、Thought 的 `light=1`、`format=page`、`sort=timeline` 和 `updatedSince` API。

固定测试 ID 见“开发者 API 指南”演示文章；完整 HTTP 契约见 [api.md](api.md) 与 [`/openapi.json`](/openapi.json)。

## 🧷 编辑器回归记录

### 已修复：普通 Enter 生成可编辑空段

症状：可视编辑模式中，普通文本按一次 Enter 可能在源码模式出现额外可编辑空行，并在阅读模式表现为异常大的段落间距。

基准：已部署并人工验证的 [`refactor-ai-s3-thoughts`](https://github.com/XD06/draftpad/tree/refactor-ai-s3-thoughts) 分支保留了正确行为。后续排查不得以 `main` 分支替代该编辑器基线，两个分支的编辑器实现和提交历史并不等价。

修复边界：`public/hybrid-editor.js` 的 `handleWysiwygSoftEnter()` 只接管顶层普通段落，插入软换行与零宽光标保护字符，并在下一任务同步编辑器值；标题、列表、引用、代码、内联代码、组合输入和带修饰键的回车继续交给 Vditor。不要将它替换为“完全交给 Vditor”、`editor.insertValue('\n')` 或直接清理已有 Markdown 空行，这些改法分别会恢复空段、吞掉首次回车或误删用户刻意保留的段落。

防回归：修改这条路径后，至少运行 `npm run test:hybrid-editor-time-command`，并按上方手动回归项验证一次。

## ✅ 验证命令

```bash
npm run check
npm run test:hybrid-editor-time-command
npm run test:api
npm run test:ai-provider
npm run test:ai-queue
npm run test:relations
npm run test:thought-modules
npm run test:note-sync
npm run test:pwa-cache
npm run test:s3-storage
npm run test:s3-migration
npm run test:s3-prefix
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

- [Agent Context](AGENT_CONTEXT.md) — 新开 AI 会话时优先阅读的项目入口
- [DumbPad API Agent Skill](SKILL.md) — 供 AI Agent 通过认证 HTTP API 管理文章与 Thoughts
- [文档索引](docs/README.md) — 当前文档、归档文档和维护规则
- [API 文档](api.md) — 完整的 REST API 参考
- [项目技术介绍](docs/technical-overview.md) — 当前模块边界、数据流和后续重构顺序
- [Storage Interface](docs/storage-interface.md) — 本地/S3 存储接口约束
- [AI Pipeline Interface](docs/ai-pipeline-interface.md) — AI 队列、provider 与 relation 写入约束
- [AI 流程与 Agent 框架设计](docs/ai-agent-framework.md) — 交互 Agent 的工作流、工具、引用和渐进实施约束
- [数据安全 V1 设计](docs/superpowers/specs/2026-07-16-data-safety-v1-design.md) — 登录、备份、恢复、审计与部署隔离的执行边界
- [同步边界说明](docs/sync-boundaries.md) — Notepad、Thought、AI、S3 和 WebSocket 的同步职责

## 🛠️ 技术栈
- **后端**：Node.js + Express
- **前端**：Vanilla JS + CSS3 (Glassmorphism)
- **渲染**：Vditor / Marked
- **存储**：本地 JSON / S3 兼容对象存储
- **搜索**：服务端 Fuse.js，数据源来自 `storage.getSearchDocuments()`

---

*让记录回归简单。*
