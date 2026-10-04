# 笔记同步问题实施方案

> 日期：2026-10-04
> 范围：文章正文同步、PWA 恢复同步、WebSocket 重连同步、自动保存节流
> 目标：优先保证当前页面及时拿到服务端最新版本，在不引入全量同步和复杂新存储结构的前提下，减少冲突、缩短同步等待、控制 S3 读写压力。

## 1. 现状与关键问题

### 1.1 PWA 无法拉取最新正文的根因

当前启动流程大致是：

1. `loadNotepads()` 先请求文章列表，得到服务端版本，例如 `42`。
2. 之后从 `localStorage` 恢复旧文章缓存，例如版本 `38`。
3. `public/app.js` 中 `renderCachedNotepad()` 调用 `setCurrentNoteVersion(38)`。
4. 现有 `setCurrentNoteVersion()` 不仅更新当前编辑器变量，也会更新 `currentNotepads[].version`。
5. `loadNotes()` 在 `currentNotepads[].version === currentNoteVersion` 时跳过正文 GET。
6. 因此页面把服务端列表版本 `42` 污染成 `38`，随后误以为正文已经是最新版本，最终继续显示旧正文。

这解释了“PC 端显示服务端版本 42、PWA 始终为 38”的现象，也解释了为什么附件可能已经同步而正文没有同步：附件和正文走的是不同的请求/缓存路径，不能因为附件同步成功就推断正文对账链路正常。

### 1.2 当前页面没有稳定的恢复对账入口

目前主要只监听 `online` 事件。以下情况没有可靠触发当前文章正文对账：

- WebSocket 重新连接成功；
- PWA 从后台回到前台；
- 移动浏览器触发 `pageshow`；
- 页面启动时缓存恢复完成之后的服务端版本确认。

WebSocket 重连目前只派发 `ws_connected`，没有顺带触发当前文章的 HTTP 版本确认。因此连接恢复后页面可能仍停留在旧缓存。

### 1.3 自动保存目前过于滞后且缺少后台兜底

正文自动保存静默时间目前约为 5 秒，只在停止输入后 POST。PWA 进入后台时，浏览器可能冻结或延迟定时器，导致待保存内容没有及时提交。当前代码已有 `lastSaveTime`，但没有形成明确的最小保存间隔控制。

### 1.4 启动时会预取其他文章正文

`loadNotepads()` 在启动后延迟预取其他文章正文。这个行为对当前页面同步没有帮助，却会在 S3 后端产生额外读取，尤其是文章数量较多时会放大启动期间的请求量。

### 1.5 API 缺少显式禁止缓存响应头

Service Worker 已经绕过 `/api/*`，但浏览器、代理或嵌入式 WebView 仍可能按照默认策略缓存 API 响应。同步检查接口应明确返回：

```http
Cache-Control: no-store, private
```

## 2. 设计原则

本次修复遵循以下原则：

1. **当前页面优先**：先确认正在编辑的文章，再考虑其他文章。
2. **版本先行、正文后取**：先用轻量元数据确认版本，只有远端版本更高时才拉正文。
3. **增量请求而非全量同步**：不重做全库同步，不启动时拉取全部文章正文。
4. **保存与对账分离**：自动保存负责提交本地编辑，对账负责发现远端更新，不能互相覆盖 dirty 内容。
5. **不采用最后写入覆盖**：服务端 `baseVersion` 冲突仍然是保护边界，前端必须恢复而不是强行覆盖。
6. **可恢复而非静默失败**：网络恢复、PWA 回前台、WebSocket 重连都应重新对账；失败要保留 dirty 内容并允许重试。
7. **幂等与节流**：同一文章的对账请求复用进行中的 Promise，并设置最短间隔，避免事件风暴。
8. **保守修改**：第一轮不修改数据格式、不改 Service Worker 缓存策略、不改 S3 存储层。
9. **可观测**：同步状态、远端版本、当前编辑器版本的含义要分开，避免显示旧缓存版本冒充服务端实时版本。
10. **失败响亮**：冲突、无 base、解析失败或网络失败都不能被当成“已同步”。

## 3. 第一轮最小修改方案

### 3.1 修复缓存恢复时的版本污染

文件：`public/app.js`

位置：约 `1370` 行附近的 `renderCachedNotepad()`。

操作：

- 删除或绕开对 `setCurrentNoteVersion(cached.version)` 的调用；
- 恢复缓存正文时，只设置当前编辑器使用的 `currentNoteVersion`；
- 不得修改 `currentNotepads[].version`，该字段必须保留 `loadNotepads()` 刚从服务端得到的版本；
- 缓存恢复完成后，继续进入一次远端版本确认流程。

建议抽出语义明确的内部操作，例如：

```js
currentNoteVersion = cached.version;
```

如果现有 `setCurrentNoteVersion()` 同时承担多个调用方职责，则不要贸然改变其全局语义；优先在 `renderCachedNotepad()` 使用只更新编辑器状态的路径，避免影响现有冲突恢复逻辑。

### 3.2 让 `loadNotes()` 支持强制远端刷新

文件：`public/app.js`

位置：约 `1613-1629` 行的 `loadNotes()`，以及所有调用方。

将签名调整为：

```js
async function loadNotes(notepadId, {
  deferRemote = false,
  forceRemote = false,
} = {}) {
```

版本相同的正文 GET 短路条件增加 `!forceRemote`：

```js
if (!forceRemote && remoteVersion === currentVersion) {
  // 保持现有短路行为
}
```

要求：

- 默认行为保持不变；
- 只有版本确认发现远端版本高于当前正文版本时才传 `forceRemote: true`；
- 强制远端刷新仍必须经过现有 dirty 内容、三方合并和冲突保护逻辑；
- 不允许通过 `forceRemote` 绕过 `baseVersion` 冲突检查。

### 3.3 增加当前文章的轻量版本对账

文件：`public/app.js`

建议放在文章加载/同步相关函数附近，不要把逻辑散落在事件监听器中。

新增：

```js
async function fetchNotepadMeta(notepadId) {}
async function reconcileCurrentNote(reason, options = {}) {}
```

`fetchNotepadMeta(notepadId)`：

- 请求 `GET /api/notepads/:id`；
- 使用 `cache: 'no-store'`；
- 只读取文章版本等元数据，不读取正文；
- 响应失败时返回可识别的失败结果，不伪造“已同步”。

`reconcileCurrentNote(reason, options)`：

- 没有当前文章时直接返回；
- 当前文章切换期间或已有同文章请求进行中时复用 Promise；
- 默认 10 秒节流，`force`/明确用户操作可绕过节流；
- 比较服务端文章版本与当前正文版本；
- 远端版本更高时调用：

```js
await loadNotes(currentNotepadId, { forceRemote: true });
```

- 远端版本没有变化时不拉正文；
- 不清理 dirty 状态，不直接用远端正文覆盖未保存的本地内容；
- 保留现有三方合并与冲突提示；
- 在同步状态中记录 `reason`，便于排查是启动、回前台、重连还是网络恢复触发。

推荐状态变量：

```js
let currentReconcilePromise = null;
let lastReconcileAt = 0;
const RECONCILE_MIN_INTERVAL_MS = 10_000;
```

同一时刻只能有一个当前文章对账请求，避免 `online`、`ws_connected`、`visibilitychange` 同时触发三次 GET。

### 3.4 补齐恢复事件

文件：`public/app.js`、`public/managers/ws-client.js`。

在 `public/app.js` 约 `588-596` 行现有 `online` 监听附近增加：

- `window.addEventListener('online', () => reconcileCurrentNote('online', { force: true }))`；
- `document.addEventListener('visibilitychange', ...)`，从 hidden 变为 visible 时对账；
- `window.addEventListener('pageshow', ...)`，用于移动浏览器/PWA 页面恢复；
- 页面启动、当前文章切换完成后各调用一次非强制对账；
- 打开同步面板时可调用一次强制对账，以便用户看到实时版本。

在 `public/managers/ws-client.js` 约 `49-53` 行的 `ws_connected` 派发处：

- 保留现有 `ws_connected` 事件契约；
- 由 `app.js` 监听该事件并触发 `reconcileCurrentNote('ws_connected', { force: true })`；
- 第一轮不让 WebSocket 直接调用文章加载函数，避免同步职责耦合到连接管理模块。

### 3.5 自动保存从 5 秒调整为 2 秒，但增加最小间隔

文件：`public/app.js`

位置：约 `302-305`、`2637-2650` 行。

将静默延迟调整为：

```js
const NOTE_SAVE_DEBOUNCE_MS = 2_000;
const MIN_AUTO_SAVE_INTERVAL_MS = 3_000;
```

实现要求：

- 仍然是“停止输入后保存”，不是每个按键保存；
- 使用现有 `lastSaveTime`，若距离上次自动保存不足 3 秒，则把剩余时间加入下一次定时器；
- 同一文章已有保存请求时合并/复用，不并发 POST；
- 仅正文发生变化才保存；
- 手动保存不应被无意义的自动保存再次重复提交；
- 保存失败保留 dirty 状态，并使用现有错误提示/重试路径。

目标行为：连续输入时约每 3 秒最多一次保存；短暂停顿约 2 秒后保存一次；停止输入后不再产生周期性请求。

#### 页面离开/进入后台兜底

继续使用现有 `flushPendingNoteSave()`，补齐两个入口：

- `pagehide`；
- `visibilitychange -> hidden`。

兜底函数必须遵守现有保存锁、鉴权和 `baseVersion` 规则，不在页面销毁阶段开启无限重试。

### 3.6 取消启动时其他文章正文预取

文件：`public/app.js`

位置：`loadNotepads()` 中约 1579-1582 行的延迟 `prefetchNotepadNotes(...)` 调用。

第一轮删除启动路径中的：

```js
setTimeout(() => prefetchNotepadNotes(...), 300);
```

可以暂时保留 `prefetchNotepadNotes()` 函数供以后显式使用，但启动时不再调用。

结果：启动只加载列表、当前文章和必要元数据；用户点击其他文章时再按需加载正文。这样可以显著减少 S3 启动读取，不影响当前文章同步准确性。

### 3.7 API 响应明确禁止缓存

文件：

- `routes/notepad-routes.js`
- `routes/note-routes.js`

为以下 GET 路由增加：

```http
Cache-Control: no-store, private
```

至少覆盖：

- `GET /api/notepads`；
- `GET /api/notepads/:id`；
- `GET /api/notes/:id`；
- `GET /api/notes/:id/outline`。

应使用现有 Express 响应链路统一设置，不改变响应体、状态码和鉴权行为。若项目已有 response helper，优先复用 helper；不要在每个 handler 中重复复杂逻辑。

### 3.8 修正同步面板中的版本语义

文件：`public/app.js` 及同步面板相关前端模块。

版本展示必须区分：

- 当前编辑器正文版本：`currentNoteVersion`；
- 服务端列表/元数据刚确认的版本：`remoteVersion`；
- 本地缓存版本：`cachedVersion`。

同步面板在尚未完成实时确认时，不得把 `cachedVersion` 标为“服务端版本”。建议显示“正在确认”或“上次确认版本”，确认成功后再更新实时远端版本。

## 4. 冲突处理策略

第一轮不重写现有三方合并算法，只保证所有远端更新都进入同一冲突保护入口。

处理优先级：

1. **本地无修改**：直接接受远端正文和版本。
2. **`local === base`**：说明本地没有实质变化，接受远端。
3. **`remote === base`**：说明远端没有变化，保留本地，使用新版本重试保存。
4. **非重叠修改**：执行现有三方合并，合并后以远端最新版本作为新的 `baseVersion`。
5. **重叠修改或没有可靠 base**：保留本地内容，不覆盖远端，提示用户选择。

禁止：

- 以客户端时间戳决定谁赢；
- 以最后一次 POST 覆盖远端；
- 在 dirty 状态下因为页面恢复而直接 `setValue(remoteContent)`；
- 将 WebSocket 通知当作正文已经拉取完成。

## 5. S3 压力与 1～2 秒自动保存的判断

### 5.1 2 秒 debounce 不等于每 2 秒固定读写

2 秒只表示“用户停止输入 2 秒后允许保存”。它不是后台定时器，也不是每个按键一次请求。配合 3 秒最小自动保存间隔后，连续输入最多约每 3 秒产生一次自动保存请求。

### 5.2 第一轮降低压力的手段

- 只对账当前文章；
- 先 GET 轻量版本元数据，版本不变不读取正文；
- 取消启动时其他文章正文预取；
- 对账请求 10 秒节流并复用 in-flight Promise；
- 保存请求串行化，避免同一文章并发 POST；
- 服务端已有 unchanged/版本保护时，重复内容不应产生实际数据变更；
- 网络恢复失败采用退避，不进行紧密循环重试。

因此，第一轮不需要新增 `contentHash` 字段，也不需要修改 S3 对象布局。

### 5.3 第二轮可选优化

如果真实监控表明 S3 GET 仍然是主要成本，再考虑在 `notepads.json` 或等价元数据中持久化 `contentHash`：

- 版本和 hash 都匹配时跳过正文读取；
- 只有版本变化或发生冲突时读取正文；
- 需要设计旧数据迁移、hash 计算成本、回滚和 local/S3 双布局兼容；
- 不应在第一轮同步修复中同时引入，避免把故障定位从前端时序扩散到存储格式迁移。

## 6. 具体文件与测试安排

### 6.1 第一轮允许修改的文件

- `public/app.js`
- `public/managers/ws-client.js`（只在确有必要时修改；优先由 `app.js` 监听已有事件）
- `routes/note-routes.js`
- `routes/notepad-routes.js`
- `test/test_startup_performance.js`
- `test/test_api_regression.js`
- 新增 `test/test_note_sync_reconciliation.js`
- 新增 `test/browser/notepad-sync.js`
- `package.json`（增加浏览器测试脚本）

实现完成后同步更新：

- `docs/sync-boundaries.md`
- `docs/technical-overview.md`
- `CHANGELOG.md`

### 6.2 第一轮明确不修改的文件

- `public/service-worker.js`
- `public/managers/note-sync-controller.js`
- `scripts/storage.js`
- `scripts/s3-service.js`
- `routes/asset-routes.js`
- `public/tiptap-editor.js`

理由：当前已能确认核心故障在前端缓存版本污染、版本短路和恢复事件缺失；扩大到 Service Worker、存储层或附件路由会增加回归面，且不能直接解决版本 42 被降成 38 的问题。

### 6.3 必须新增/更新的测试

新增 `test/test_note_sync_reconciliation.js`，至少覆盖：

1. 服务端版本 `42`、缓存版本 `38` 时，缓存恢复不再覆盖 `currentNotepads[].version`；
2. 版本确认发现 `42 > 38` 时调用强制正文加载；
3. 版本相同且非 force 时仍然短路，不重复 GET 正文；
4. `online`、`ws_connected`、回前台多个事件同时到达时只产生一个 in-flight 对账请求；
5. dirty 内容存在时，对账不会直接覆盖本地编辑器；
6. 自动保存 2 秒 debounce 和 3 秒最小间隔生效；
7. 进入后台/pagehide 会 flush 待保存内容。

更新 `test/test_startup_performance.js`：

- 启动路径不再自动预取其他文章正文；
- 当前文章加载行为保持不变。

更新 `test/test_api_regression.js`：

- 相关 GET API 返回 `Cache-Control: no-store, private`；
- 响应体和状态码契约不变。

新增 `test/browser/notepad-sync.js`，真实浏览器覆盖：

- PWA/普通页面加载旧缓存后能拉取更新正文；
- 模拟 WebSocket 重连后当前文章能重新对账；
- 页面从后台恢复后能对账；
- dirty 内容不会因为远端更新被静默覆盖；
- 同步面板不再长期显示旧缓存版本。

按仓库约定运行：

```bash
npm run test:note-sync
npm run test:pwa-cache
npm run test:startup-performance
node test/test_api_regression.js
npm run check
```

如果修改了前端事件/浏览器行为，再运行对应的真实浏览器测试；不要只用 jsdom 断言代替真实 PWA 生命周期验证。

## 7. 验收标准

完成第一轮后，应满足：

1. 服务端文章版本为 `42`、PWA 本地缓存为 `38` 时，刷新或恢复页面最终显示远端正文和版本 `42`，不需要手动点击同步。
2. WebSocket 重连、网络恢复、PWA 回前台后，当前文章在节流窗口内自动完成版本对账。
3. 远端版本未变化时，不重复拉取正文。
4. 远端版本变化且本地无修改时，自动接受远端内容。
5. 本地有未保存修改时，不被恢复对账静默覆盖；冲突沿现有提示/合并流程处理。
6. 停止输入约 2 秒后可自动保存，但连续输入不会每个按键请求，也不会无限高频请求。
7. 启动不再读取所有其他文章正文。
8. API GET 响应不会被浏览器/代理缓存为旧版本。
9. 附件同步路径保持现状，不因本次正文同步修复而改动。

## 8. 实施顺序

建议按以下顺序提交，便于定位回归：

1. 先修复 `renderCachedNotepad()` 的版本污染，并新增单元测试。
2. 增加 `forceRemote` 与当前文章版本对账，再补恢复事件测试。
3. 调整自动保存 debounce、最小间隔和后台 flush。
4. 删除启动预取其他文章正文。
5. 增加 API `Cache-Control`，更新 API 回归测试。
6. 更新同步边界、技术概览和变更日志。
7. 跑定向测试、`npm run check` 和真实浏览器测试。

每一步都先检查 `git diff`，不触碰工作区中与本任务无关的已有修改，也不提交 `AGENTS.md`、`docs/archive/`、`.env` 或 `data/`。

## 9. 结论

这次问题的关键不是“同步按钮不够自动”，而是 PWA 恢复旧缓存时把旧版本写回了服务端版本状态，导致后续版本短路逻辑错误地跳过正文请求。最小且有效的修复是：

> **缓存版本与服务端版本彻底分离；恢复事件只做当前文章版本对账；版本变化才拉正文；dirty 内容继续走冲突保护；自动保存缩短到 2 秒但增加最小间隔；启动取消全库正文预取。**

这套方案不改变数据结构、不改 S3 存储层、不依赖全量同步，能够优先解决“PWA 始终停在旧版本”和“必须手动触发才同步”两个核心问题，同时控制请求数量和冲突风险。
