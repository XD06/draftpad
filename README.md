# DumbPad - 极简混合 Markdown 草稿本

DumbPad 是一款专注于速度、美感与跨端体验的极简 Markdown 编辑器。它采用了“混合编辑”模式，将 Markdown 的强大功能与所见即所得的直观性完美结合，特别针对移动端进行了深度交互优化。

## 🌟 核心特性

### 1. 混合编辑体验 (Hybrid Editor)
- **无缝切换**：点击即进入编辑模式，离开即自动渲染，无需手动切换预览。
- **高性能渲染**：基于 Tiptap / ProseMirror 内核（离线 bundle，黑盒适配器保持原编辑器 API 不变），支持完整的 Markdown 语法与代码语法高亮（highlight.js 常用语言内置）。
- **本地优先的保存**：输入即写入浏览器本地缓存，停止输入 5 秒后才同步到服务器；内容未变化的保存不计入修改次数，多设备冲突自动合并。
- **文章记录水印**：滚到文章末尾时，卡片正下方以淡灰小字显示创建时间、最近更新时间与修改次数（跟随卡底、不进入正文与打印，也不影响编辑器滚动与光标行为）。

### 2. 深度移动端优化
- **双标签侧边栏**：「目录」与「最近」以图标标签切换子页面（PC 与移动端一致）。
- **文章内目录**：PC 右侧栏显示当前文章的标题目录（编辑/阅读模式均可用，带级别图标、滚动高亮、点击跳转）；移动端由悬浮「目录」按钮打开同一目录抽屉。
- **悬浮按钮收缩**：移动端悬浮按钮组默认收起，只保留目录、智能滚动与「更多」，点击展开其余按钮，刷新后自动收起。
- **智能分组**：侧边栏自动按日期（今天、昨天、2 天前等）对文件进行分组，并自动折叠较旧的记录。
- **目录标题搜索与快速切换**：目录搜索仅匹配文章标题；切换已有文章时先展示本地启动缓存，再在后台校验服务端新版本，减少目录切换的等待感。
- **触控友好**：移动端支持**长按**唤出重命名与删除按钮，防止单手操作误触。
- **全 HTML 模态框**：弃用原生弹窗，统一使用精心设计的移动端友好交互界面。

### 3. 精准搜索与导航
- **全局模糊搜索**：支持中文搜索，即便文件众多也能秒速定位。
- **关键词直达**：搜索结果点击后，编辑器会自动滚动到关键词所在行并进行高亮闪烁提示。
- **链接高亮可点击**：文章中的裸 URL 与 Markdown 链接统一样式高亮，点击直接打开（阅读模式同样可点击）。

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
  - 右滑卡片 → 删除整条 Thought（弹窗确认后移入垃圾桶）
  - 右滑子任务行 → 删除该子任务（触屏/触控笔，越过半行宽即生效）
- **置顶功能**：卡片右上角置顶按钮，置顶内容优先排序并显示金色边框
- **附件支持**：支持插入图片和文件（Base64 存储，单文件最大 4MB），编辑模式下可管理附件
- **输入与排序细节**：子任务输入框按 Enter 自动开启下一条；在折叠卡片上添加子任务会先自动展开，新行与续输输入框始终可见；勾选子任务只刷新当前卡片并原位重排时间线，不再整表重建；时间线排序让“多个子任务完成了一部分”的想法优先展示；手动关联搜索走索引化轻量接口，打字时后台刷新不再顶掉移动端键盘。

### 6. 今日草稿

- **用完即走**：独立于文章和 Thought 的当日单行清单，次日自动清空，不会积累为长期待办。
- **单条同步**：每条记录拥有版本号，支持跨端实时更新与离线重试。
- **快捷整理**：横向手势可删除当前条目或转成可长期保留的 Thought。

### 7. AI Relations

- **AI 元数据**：创建 Thought 后异步生成摘要、实体、主题、意图、关键词、标签和 embedding；语义编辑后会标记为“AI 待更新”，由用户在 AI 面板手动重新运行。
- **准确优先关联**：本地召回候选后，可选用专用 reranker 排序，再由 LLM 判断 `relationType`、置信度和原因。
- **关系管理**：前端可展开关联列表、查看关联原因、跳转高亮目标 Thought、删除误判关联。
- **手动关联搜索**：可搜索 Thought 并手动建立关联，候选项会高亮关键词；搜索使用轻量接口和前端防抖，避免 S3 场景下频繁读取 AI meta 和 relation count。
- **误判记忆**：删除过的误判会写入 `relations.suppressed/`，后续重算不会立刻恢复。
- **找回相关内容（可选）**：用户可在 Thought 的 AI 分析折叠区主动启动只读 `recall_context` 工作流，在有限候选中找回旧想法和文章片段，并查看可点击的结构化引用；不改写用户内容。
- **降级可用**：没有 AI Key 或 AI 服务失败时，核心保存流程不受影响。

### 8. 安全、同步与存储
- **PIN 码保护**：支持访问权限校验，保护私密草稿。
- **多端同步**：基于轻量 WebSocket 事件同步 `notes_update`、`thoughts_update`、`relations_update`、`notepad_change`。
- **多后端存储**：支持本地文件存储和 S3 兼容对象存储，前端 API 保持不变。
- **文章资源命令**：编辑文章时输入 `/file` 后按 Enter，即可从系统选择一个或多个图片/附件；图片以内联预览显示，普通文件显示为下载卡片。普通附件默认单文件上限为 20MB（可通过 `ASSET_MAX_FILE_BYTES` 调整），正文不保存 Base64。
- **PWA 支持**：可作为应用安装到手机或桌面，支持离线查看及沉浸式全屏体验。Service Worker 会缓存核心静态资源；字体和编辑器运行时资源在实际使用后写入缓存，避免首次安装额外下载大文件。
- **移动端视口优化**：支持 `100dvh` 动态视口高度，降低手机浏览器地址栏收起、键盘弹出时造成的布局跳动。

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
   默认地址为 `http://localhost:3000`（端口由 `PORT` 控制，默认 `3000`）

## 🧱 项目结构

无构建步骤：浏览器直接加载原生 ES module，服务端一个 Express 进程同时提供 HTTP API、静态资源和 WebSocket。

```
server.js            后端入口，注册 13 个 route 模块
routes/              HTTP 边界（auth/note/notepad/thought/today-drafts/trash/...）
scripts/storage.js   ★ 唯一的用户数据读写出口，收敛 local/S3 与 legacy/split
scripts/ai-*.js      后台 AI 管线（异步，不阻塞写入）
scripts/agent/       交互 Agent 独立运行线（只读 recall_context + SSE）
public/              前端：app.js、hybrid-editor.js、managers/、service-worker.js
data/                运行时数据（已 gitignore）
test/                全部回归测试 test/test_*.js
docs/                文档；docs/archive/ 为本地历史存档（不推送）
```

模块边界、依赖规则与已知取舍见 [ARCHITECTURE.md](ARCHITECTURE.md)。

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

个人安全模式在准备好独立持久目录后才启用：设置 `AUTH_V2_ENABLED=true`、`AUTH_STATE_DIR=/var/lib/dumbpad-security` 和一个随机 32 字节 `AUTH_MASTER_KEY`。Docker Compose 会把该宿主机目录挂载到容器内 `/app/security`，认证状态、可信设备、API token 与审计链不会因重建容器丢失。首次访问用旧 PIN 或一次性 `AUTH_BOOTSTRAP_TOKEN` 完成主密码、TOTP 与恢复码设置；以后已登录设备不被打断，可信设备在会话过期后只要求主密码，新设备和高危数据操作才要求 TOTP。不要把 `AUTH_MASTER_KEY` 放进仓库、浏览器或应用数据桶。

备份由宿主机而非应用容器执行。`deploy/systemd/backup.env.example` 是 root-only 备份配置模板；它使用 `BACKUP_DIR=/var/lib/dumbpad-backups`、每仓库 1GiB 硬上限的去重加密仓库和独立 `BACKUP_S3_*` 桶。备份 CLI 不再自动加载项目 `.env`，无参数时只运行只读 `health`；写快照必须显式使用 `snapshot`。S3 源 Adapter 只暴露读取能力，运行桶与备份桶、两套凭证相同都会被写路径拒绝。

最小部署步骤：将模板复制为仅 root 可读的 `/etc/dumbpad/backup.env`，填入只读运行桶凭证、仅用于备份桶的另一套凭证及独立 `BACKUP_MASTER_KEY`；先运行 `node scripts/backup/backup-cli.js readiness` 查看脱敏配置检查，再显式运行 `snapshot` 和 `health`。安装 `systemd` service/timer 后，快照成功会自动追加一次完整性健康检查。`restore-local` 只接受空的新目录；`restore-s3` 还必须临时提供独立的 `RESTORE_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY`，并拒绝活动数据 prefix、其父子 prefix、备份桶及复用凭证。恢复完成后会回读全部文件/对象并校验字节，且不会自动删除演练目标。备份容量和保留规则见[数据安全 V1 设计](docs/superpowers/specs/2026-07-16-data-safety-v1-design.md)。

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

固定测试 ID 见“开发者 API 指南”演示文章；完整 HTTP 契约见 [docs/api.md](docs/api.md) 与 [`/openapi.json`](/openapi.json)。

## 🧷 编辑器回归记录

### 严重 bug：输入时光标乱跳与特殊样式闪烁

在待办项及时间标记、高亮附近输入时，Vditor 块解析与应用层装饰、光标纠正产生竞争，可能暴露标记源码或让光标跳到其他位置。当前修复在解析阶段保护自定义节点并保留原生光标锚点，适配器启用后停用旧 IME 指纹恢复与延时纠正。浏览器回归通过，用户初步验证可用；完整真机输入法及原图片场景仍待验收。

详细根因、失败方案、回归命令和限制见 [技术总览中的严重 bug 记录](docs/technical-overview.md)。升级 Vditor 必须运行 `npm run test:editor-input-browser`；本次不改变普通 Enter 的兼容性边界。

### 已修复：普通 Enter 生成可编辑空段

症状：可视编辑模式中，普通文本按一次 Enter 可能在源码模式出现额外可编辑空行，并在阅读模式表现为异常大的段落间距。

基准：已部署并人工验证的 [`refactor-ai-s3-thoughts`](https://github.com/XD06/draftpad/tree/refactor-ai-s3-thoughts) 分支保留了正确行为。后续排查不得以 `main` 分支替代该编辑器基线，两个分支的编辑器实现和提交历史并不等价。

修复边界：`public/hybrid-editor.js` 的 `handleWysiwygSoftEnter()` 只接管顶层普通段落，插入软换行与零宽光标保护字符，并在下一任务同步编辑器值；标题、列表、引用、代码、内联代码、组合输入和带修饰键的回车继续交给 Vditor。不要将它替换为“完全交给 Vditor”、`editor.insertValue('\n')` 或直接清理已有 Markdown 空行，这些改法分别会恢复空段、吞掉首次回车或误删用户刻意保留的段落。

防回归：修改这条路径后，至少运行 `npm run test:hybrid-editor-time-command`，并按上方手动回归项验证一次。

### 已修复：Thought 多端同步不实时与移动端子任务键盘闪断

症状：一台设备添加的 Thought 子任务，另一台设备即使刷新也看不到；新建 Thought 无法立刻出现在其他设备。移动端连续添加子任务时每按一次回车键盘就收起再弹出一次。

根因：远端更新到达时若本机 timeline 内有输入框持有焦点，`scheduleRender` 的焦点保持逻辑把渲染推迟到失焦（模型已更新、界面不动）；WS 回声整体替换数组槽位让排队提交拿到旧版本号撞上自己的回声 409。键盘闪断则来自回车提交先全量重建时间线、等服务器返回后再新开输入框。

修复边界：远端更新按卡片原位刷新（`renderSocketDelta`/`patchRenderedThought`），只有焦点在被更新卡片内时才推迟到失焦；WS 回声对既有对象原位合并；inline 子任务新增改为同一输入框链式提交（预览行 + 失焦后完整渲染），回车带 IME 组合态守卫。详细边界见 [技术总览](docs/technical-overview.md)。

防回归：改动后运行 `npm run test:thought-sync-browser`（双设备浏览器回归，需本机 Chrome）与 `npm run test:thought-modules`。

## ✅ 验证命令

所有测试文件位于 `test/` 目录（`test/test_*.js`），不再散落在项目根目录。

```bash
npm run check   # 全量 node --check + 服务器启动冒烟
npm test        # test/ 下的完整回归套件（排除需要真实 S3 的 smoke）
npm run test:<name>   # 单个测试，脚本定义见 package.json
```

常用单项：`test:api`、`test:thought-modules`、`test:agent`、`test:safety`、`test:today-drafts`、`test:pwa-cache`、`test:hybrid-editor-time-command`、`test:s3-storage`。完整对照表与"改哪里跑哪个"见 [AGENTS.md](AGENTS.md)。

真实 S3 smoke 会删除目标 `S3_PREFIX` 下的对象，需要先配置 S3 环境变量、唯一 `S3_PREFIX`，并额外设置完全相同的 `DUMBPAD_REAL_S3_SMOKE_CONFIRM_PREFIX`：

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

根目录只保留四份入口文档，其余全部在 `docs/`。

- [架构说明](ARCHITECTURE.md) — 系统全景、模块边界、关键数据流与技术债务
- [更新日志](CHANGELOG.md) — 版本演进与破坏性变更
- [AI 协作规范](AGENTS.md) — AI Agent 的行为宪章、命令与目录职责（**仅本地，不提交推送**）
- [文档索引](docs/README.md) — 当前文档、历史存档和维护规则

按用途深入：

- [API 文档](docs/api.md) — 完整的 REST API 参考（`/openapi.json` 为机器可读版本）
- [DumbPad API Agent Skill](docs/SKILL.md) — 供 AI Agent 选择文章、Thought 或今日草稿并执行高频 API 操作
- [项目技术介绍](docs/technical-overview.md) — 模块级实现细节、数据流与重构顺序
- [Storage Interface](docs/storage-interface.md) — 本地/S3 存储接口约束
- [AI Pipeline Interface](docs/ai-pipeline-interface.md) — AI 队列、provider 与 relation 写入约束
- [AI 流程与 Agent 框架设计](docs/ai-agent-framework.md) — 交互 Agent 的工作流、工具、引用和渐进实施约束
- [数据安全 V1 设计](docs/superpowers/specs/2026-07-16-data-safety-v1-design.md) — 登录、备份、恢复、审计与部署隔离的执行边界
- [同步边界说明](docs/sync-boundaries.md) — Notepad、Thought、AI、S3 和 WebSocket 的同步职责
- [Cloudflare 部署](docs/cloudflare-deployment.md) — 面向 Cloudflare 的部署说明

## 🛠️ 技术栈
- **后端**：Node.js + Express
- **前端**：Vanilla JS + CSS3 (Glassmorphism)
- **编辑器**：Tiptap / ProseMirror（离线 bundle）+ Marked
- **存储**：本地 JSON / S3 兼容对象存储
- **搜索**：服务端 Fuse.js，数据源来自 `storage.getSearchDocuments()`

---

*让记录回归简单。*
