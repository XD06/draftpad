# DumbPad 代码审查报告：性能缺陷 + 数据同步冲突

- 审查方式：静态代码走查（只读，未运行、未修改任何代码）
- 代码基线：`v1.0.8`（Express 5 + Vanilla JS，本地 JSON / S3 双后端）
- 重点：① 严重性能缺陷；② **数据同步冲突（用户反馈“时常遇到冲突”，本次重点深挖）**

---

## 0. 结论速览（TL;DR）

- **同步没有“会丢数据”的严重 bug**：写锁、版本乐观并发、三路合并、AI 源签名都实现正确。
- **但“时常遇到冲突”是真实且可解释的**，根因不是丢数据，而是**冲突判定过于激进 + 多客户端模型天然易触发**：
  1. 收到远端保存时，只要本地“脏”就**立刻弹冲突提示，且没有先尝试合并**（最主要噪音来源）。
  2. 每个标签页/PWA 实例都有**独立随机 userId**，同一用户开两个页面 = 被当成两台设备，只要都有未保存改动就判冲突。
  3. 实时 `update` 广播在**接收端被丢弃**，跨端看不到对方正在输入，导致“无预警地并发编辑”，保存时才爆冲突。
  4. `deferRemote` 缓存切换路径存在**版本漂移**：缓存无 version 时 `currentNoteVersion` 会残留上一篇的值。
- **性能上最严重的是 P0**：Thought 每次写操作都“全量读 + 全量写”，S3+split（推荐的多端配置）下会把“勾一个待办”放大成上千次串行请求。

---

## 1. 架构速览

| 层 | 关键文件 | 职责 |
|---|---|---|
| 入口 | `server.js` | 路由注册、鉴权、WS、静态资源 |
| 存储边界 | `scripts/storage.js` | 本地/S3、legacy/split 统一读写，含 3 个进程内写锁 |
| HTTP 路由 | `routes/thought-routes.js`、`routes/note-routes.js` | CRUD + 乐观并发（baseVersion / 409） |
| 同步 | `server/websocket.js`、`public/managers/ws-client.js` | 轻量事件广播 |
| AI 后台 | `scripts/ai-queue.js` | 关系/摘要/embedding 异步队列 |
| 前端同步 | `public/app.js`、`public/managers/note-sync-controller.js` | 保存队列、三路合并、启动缓存、冲突提示 |

---

## 2. 数据同步冲突（重点章节）

### 2.1 现有机制是正确的（先说清楚“没丢数据”）

| 机制 | 位置 | 说明 |
|---|---|---|
| 进程内写锁串行化 read-modify-write | `storage.js` L60-L87 | POST/PATCH/DELETE 整个读改写包在锁内，杜绝 last-writer 丢数据 |
| 乐观并发 + 409 | `note-routes.js` L68-L74；`thought-routes.js` L700-L708 | 校验 `baseVersion`，冲突返回 409 |
| POST “同内容即成功” | `note-routes.js` L69-L72 | 远端正文 == 本次正文时返回 `unchanged`，避免误报 |
| 三路自动合并 | `note-sync-controller.js` L102-L143 | 单编辑点检测，disjoint 自动合并，仅 overlap 才判冲突 |
| 前端保存队列 + revision 守卫 | `app.js` L1483-L1497、L1288 | 按 notepad 串行；`editorRevision` 防过期重试 |
| 切换前 flush 待保存 | `app.js` L1993-L2000 | 换 notepad 前先把 pending save 落盘 |
| AI 源签名防陈旧 | `ai-queue.js` L94-L103 | Thought 处理期间被改则丢弃 AI 结果，不覆盖用户新数据 |
| WS 拒绝伪造事件 | `websocket.js` L126-L142 | 客户端不能伪造 `thoughts_update`/`relations_update` |

**所以：冲突是“提示层/客户端模型”的问题，不是“服务端会覆盖数据”的问题。**

### 2.2 为什么“时常遇到冲突”——根因分析（按可能性排序）

#### 🥇 根因 A：收到远端保存时先弹冲突提示，却没先尝试合并（最主要噪音源）

`app.js` L384-L396 的 `notes_update` 处理：

```js
if (hasUnsavedChanges) {
    if (noteContentMatches(detail, editor.value)) { /* 同内容→清理，标记已同步 */ return; }
    showNoteConflictToast('warning', 5000);   // ← 只要本地脏且内容不同，立刻弹“冲突”
    return;                                     //    没有尝试三路合并，也没标 conflict
}
```

- 弹出的文案是 `showNoteConflictToast`（L1034）：**“内容已在其他设备更新，请刷新后再保存或复制当前内容”**——非常吓人。
- 真正的三路合并**只在 409 路径**（`app.js` L1560-L1616）里才跑。也就是说：远端一保存，本地只要有未保存改动就先挨一记“冲突”提示；等本地这次防抖保存真正发出去、拿到 409、再去 merge，很多时候其实**能自动合并成功**（disjoint），随后又弹“已自动合并远端修改”。
- 用户视角：一次正常的双端编辑，先看到“冲突！请刷新”，再看到“已自动合并”，于是形成“**这软件老是冲突**”的强烈印象。

> 关键：L394 这条提示是**过早的、悲观的**。它既没先合并，也没阻止后续保存，纯属“预警噪音”。

#### 🥈 根因 B：每个标签页/PWA 都是独立 userId，同一用户开两个页面就互相判冲突

- `userId` 每次加载页面随机生成：`app.js` L347 `Math.random()...`。
- 自我确认（own-ack）依赖 `detail.userId === userId`（L364）。**两个标签页 userId 不同**，彼此不认为是自己。
- 于是：同一用户在“手机 PWA + 桌面浏览器”或“两个标签页”打开同一篇，只要两边都有未保存改动，一边自动保存（300ms 防抖，非常频繁）就会让另一边命中根因 A 的冲突分支。
- 这是纯 version + last-writer 模型的固有代价（没有实时 OT/CRDT），但**独立 userId 让“同一个人的多个页面”也被当成并发设备**，进一步放大。

#### 🥉 根因 C：实时 `update` 广播在接收端被丢弃 → 跨端无“正在输入”预警

- 编辑时前端会发实时广播：`app.js` L1291-L1294 `wsClient.sendUpdate('update', { notepadId, content, userId })`（无 version）。
- 服务端原样转发为 `notes_update`（`websocket.js` L132-L139，仍无 version）。
- 但接收端 `app.js` L380 `if (!isSavedUpdate) return;`——**无 version 的实时更新被直接丢弃**。
- 结果：这套“实时协同预览”实际上是**失效的**。跨端看不到对方正在编辑，双方就会“无感知地并发改同一篇”，直到某一端保存才在另一端爆出冲突（回到根因 A/B）。

#### 4. 根因 D：`deferRemote` 缓存切换路径的版本漂移（潜在真冲突）

- 切换 notepad 走 `loadNotes(id, { deferRemote: true })`（`app.js` L2022），先用缓存渲染、后台再校验远端。
- 缓存渲染时 `renderCachedNotepad` 调 `setCurrentNoteVersion(id, cachedNote?.version)`（L935）。
- 而 `setCurrentNoteVersion`（L1024-L1030）对非有限数字**直接 return**：若缓存里 `version` 缺失/undefined → `Number(undefined)=NaN` → **不更新，`currentNoteVersion` 残留上一篇的值**。
- `deferRemote` 会立即返回（L1176-L1178 `void refreshFromServer()`）。若用户在后台刷新完成**之前**就开始输入，这次保存用的 `baseVersion` 就是错的（上一篇的版本），要么误触 409，要么因版本偏高**反而绕过冲突检测**。属于确定性的版本漂移隐患。

#### 5. 根因 E：自动合并强依赖 `baseContent`，缺失即降级为真冲突

- 409 合并需要 `base = cachedNote?.baseContent`（`app.js` L1567）。
- 若 `baseContent` 缺失（首次编辑、缓存被清、或某些切换路径没存 base），`mergeContents` 返回 `missing_base`（`note-sync-controller.js` L104），直接落到 L1608 的“真冲突”缓存分支并弹错误提示。

### 2.3 同步问题修复建议（仅建议，未改动代码）

| 优先级 | 根因 | 建议方向 |
|---|---|---|
| P0 | A 过早提示 | 收到远端保存且本地脏时，**先在本地跑一次 `mergeContents(base, local, remote)`**：disjoint 就静默合并、只提示“已自动合并”；仅 overlap 才弹真正的冲突提示。把 L394 的悲观 toast 移到合并失败之后。 |
| P0 | C 实时广播失效 | 要么恢复实时预览（接收端处理无 version 的 `update`，只做只读预览、不参与冲突判定），要么干脆去掉 L1293 的发送（当前是纯浪费带宽 + 误导）。 |
| P1 | B 多页 userId | 用**稳定的设备级 userId**（`localStorage` 持久化），让“同一浏览器的多个标签页”能被识别为同源，减少自我冲突；或对同源标签页用 `BroadcastChannel` 先本地合并。 |
| P1 | D 版本漂移 | `renderCachedNotepad` 里当缓存无 version 时，应把 `currentNoteVersion` 显式**置为 null**（表示未知），而不是残留上一篇；保存时 baseVersion 未知则先拉远端确认。 |
| P2 | E baseContent 缺失 | 首次进入即建立 base 快照；合并 `missing_base` 时优先“拉远端并以远端为 base 重试”，而非直接判冲突。 |
| P2 | 提示文案 | 区分“已自动合并”（info）与“需人工处理的真冲突”（error），避免可自动解决的情况使用“请刷新”这种吓人措辞。 |

### 2.4 一个需要明确的部署约束（非 bug）

三个写锁（`storage.js` L60-L87）都是**单进程内存互斥**，不保证跨进程原子性（代码注释 L79-L81 已承认）。当前单容器部署没问题，但**多实例/多容器共享同一 S3 时并发写仍会 last-writer-wins**。建议在部署文档中显式声明“单实例”约束。

---

## 3. 严重性能问题

### 🔴 P0 — Thought 每次写操作都“全量读 + 全量写”，单文件写原语被完全绕过

**证据：**
- 所有 Thought 写路由都用全量读写：POST `thought-routes.js` L608-L644、PATCH L686-L809（连 `toggle_complete` 也全量）、DELETE L811-L826，全部 `readThoughts()` + `saveThoughts(thoughts)`。
- `saveThoughts` 在 split 下**顺序重写全部文件**：本地 `storage.js` L475-L492；S3 `storage.js` L494-L510（`for...await` 串行 PUT）。
- storage.js **已实现**更优的单文件 `writeThought`/`deleteThought`（L669-L732），但全代码库搜索确认 `storage.writeThought(`/`storage.deleteThought(` **零调用**（仅测试引用）——热路径完全没用。

**影响（设 N 条 Thought）：**

| 配置 | 单次勾选/编辑/新建的代价 |
|---|---|
| local + legacy（默认） | 读整个 `thoughts.json` + 重写整个文件（含全部内联 Base64 附件） |
| **s3 + split（README 推荐多端配置）** | 1 次 listObjects + **N 次 GET + N 次串行 PUT** + 索引重建 |

例：1000 条 Thought，手机上勾一个子任务完成 → 后端约 **2000 次串行 S3 请求**。批量导入 M 条 = O(M²)。
放大器：Thought 附件以 **Base64 内联**存储（`thought-routes.js` L623；请求体上限 `50mb`，`server.js` L243），全量写会把所有附件一起重写。

> 讽刺点：`technical-overview.md` §4 说 split 是为“只读当前页、避免读写全部”而设计——**读路径做到了**（`listThoughtsPage` 走索引），**写路径却退化成全量重写**。

### 🟠 P1 — 索引在每次写时全量重建
即便改用单文件写，`writeThought` 内部仍 `writeThoughtIndex(await readSplitThoughts())`（`storage.js` L690-L693），又把全部 Thought 读一遍重建索引（S3 = O(N) GET）。写放大是**双层**的，修 P0 时需同步改成增量更新索引项。

### 🟠 P1 — 搜索索引全量重建，无增量
`server/indexing.js` L12-L35 `indexNotepads` → `storage.getSearchDocuments()`（`storage.js` L1475-L1502）读取**全部 Thought + 全部 Notepad 正文**重建整个 Fuse 索引。每次 Thought 写（250ms）、每次 Note 保存（1500ms）触发；虽有防抖合并，但每次都是 O(N+M) 全量读。

### 🟡 P2 — 其他
- **AI 关系计算每条 O(N)**：`ai-queue.js` L527 `buildRelations` 每次 `readThoughts()` 全量 + 逐个读候选 meta；批量 O(N²)。属后台派生数据、不阻塞用户写入，有并发上限与源签名缓解。
- **WebSocket 广播完整正文**：`websocket.js` L78-L89 每次保存把整篇 `content` 推给所有客户端，与 `sync-boundaries.md` §7“不应把大正文塞进 WebSocket”自相矛盾。
- **非 light 的 `GET /api/thoughts`**：`thought-routes.js` L579-L600 每条读 relationCount（可能再读 meta），一页 30 条最多 60 次读；前端时间线用 `light=1` 已规避。

---

## 4. 做得好的地方（值得保留）

- 前端渲染：`thoughts.js` DocumentFragment 批量插入（L1191-L1207）、`patchRenderedThought` 单卡手术式更新（L1276-L1311）、游标分页、滚动懒加载、count/status 局部 DOM 更新。
- WS 客户端：重连抖动 + 离线队列上限（`ws-client.js`）。
- 编辑器：Vditor/Marked 延迟加载、性能监控可选（`editor-performance.js`）。
- 数据安全：`writeJSON` 临时文件 + rename 原子写、Windows EPERM 重试（`storage.js` L111-L128）。

---

## 5. 建议的下一步

1. **优先处理同步“噪音”**（根因 A + C）：这是你“时常遇到冲突”的最大来源，且改动小、风险低、见效快。
2. 再处理 **P0 写放大**（切换到单文件写 + 增量索引），尤其在 S3+split 上线前。
3. 部署文档补充“单实例”约束说明。

> 如需，我可以针对根因 A（收到远端更新先本地合并再决定是否提示）给出**不改变数据结构、不改变 API 的最小补丁草案**。

---

## 6. 真实使用 Bug 清单根因（第二轮，只读诊断）

> 结论先行：13 条里 **#9 / #7 / #13 属数据完整性问题（最高危）**；多条编辑器/面板问题共享同一个架构级根因——**后台 `render()` 会清空重建整个列表，破坏正在进行的局部交互**。

### 6.0 贯穿多条的架构级共因（建议优先治理）

`ThoughtsManager.render()`（`thoughts.js` L1153）执行 `this.timeline.innerHTML = ''` 全量重建；而 `handleSocketUpdate`/`handleAIStatusSocketUpdate`（L903/996）都走 `scheduleRender()`（L1117 rAF 合并）。任何后台事件（AI 状态推送、其它端更新、outbox 重试、`ws_connected`→fetchThoughts L410-413）都会重建 DOM，从而：
- 破坏正在编辑的卡片 → **#13 附件编辑丢失**；
- 反复重建展开的 AI 面板 → **#12 闪烁**；
- 放大 **#2 的“正在加载”感**。

**统一修复方向**：socket/AI 驱动的更新一律走**局部 patch**（已有 `patchRenderedThought` L1276、`updateThoughtRelationCount` L954），**编辑中/交互中的卡片不重建**。这一条能同时缓解 #13、#12。

### 6.A 数据完整性（最高优先）

#### #9 下划线附近反斜杠无限累积（数据损坏）
- 根因：正文保存走 `getValue()`→`readWysiwygMarkdownValue()`（`hybrid-editor.js` L224-229、L448-471），底层由 Vditor/Lute 把 WYSIWYG DOM 反序列化为 Markdown，会把词内 `_`（如 `top_p`）转义成 `\_` 防斜体。而 `stripDisplayGuards`（L443-500）只清 DumbPad 自己的显示护符/mark，**没有对称的“反转义/归一化”**。于是每轮「保存(序列化)→加载(setValue→Lute 解析)」都可能对已有 `\` 再叠一层：`\_ → \\_ → \\\_`，无上限增长；刷新只是把已损坏内容重新暴露。
- 佐证：项目多处手工转义（`thought-text-formatting.js` L13/L61、`article-file-command.js` L9、`hybrid-editor.js` L3746/L4631），但正文主链路缺少反向归一化。
- 修复方向：在保存前的归一化步骤中**折叠 Lute 过度转义**（非代码区把 `\_`、`\*` 等还原为字面），并保证「序列化↔反序列化幂等」（同内容多轮 round-trip 字节不变）。⚠️ 必须配幂等回归测试。

#### #7 “资源上传中”占位符被存入正文，跨端只见源码
- 根因：`createArticleUploadToken()`（L2298-2300）生成**纯文本** `[[资源上传中 ...]]`，`handleArticleFileSelection`→`replaceArticleFileCommandWithPlaceholders`（L2302-2318）把它写进正文并触发 `onInput`→**300ms 自动保存**。上传是异步的（`queueArticleAssetUpload` L3513-3549），成功才 `replaceArticleUploadPlaceholder`；失败分支（L3537-3545）只标 error 卡片、**不移除正文里的 token**。占位符→卡片的装饰又依赖本机内存 `articleUploadStates`（L3515）。→ 自动保存把 token 写到服务端后，换端/刷新/上传失败都会留下裸 token。
- 修复方向：未完成的上传**不得进入持久正文**。用不参与 Markdown 序列化的挂起区/装饰节点承载“上传中”，`getValue()` 保存时过滤未完成 token；上传失败/放弃清除 token。

#### #13 编辑附件被静默回滚（删除/同名替换丢失）
- 根因：`enterEditMode`（`thoughts.js` L2992+）用**本地工作副本** `editAttachments`（L3004），增删只改副本（L3117-3120、L3033）；提交只在 `saveAndExit`（L3146）。但它有致命守卫 `if (!textarea.isConnected) { saveStarted=true; return; }`（L3148-3151）——textarea 一旦离开 DOM 就**静默放弃保存**。而 §6.0 的后台 `render()` 会清空 timeline 断开该 textarea。→ 编辑附件期间任何一次后台刷新后，点击外部触发的 `saveAndExit` 发现 textarea 已断开→丢弃全部编辑→卡片按原始 `thought.attachments` 重渲染→被删附件“复活”、同名替换失效（下载仍是旧文件）。
- 附带：移除图片附件只删引用，底层 asset（`/api/assets/:id`）**无删除/GC**（`asset-storage.js` 无 delete）→ 永久残留（存储泄漏）。base64 文件附件内联于 thought，删除+成功保存才真正移除。
- 修复方向：(a) 落实 §6.0，编辑中的卡片不被 render 销毁；(b) `saveAndExit` 在 textarea 断开时也用已捕获的副本**提交**而非 return；(c) 为孤儿 asset 增加引用计数/GC。

### 6.B 编辑器光标/视线（#1 #4 #5 #10，共因）

同一套「保存值→`editor.setValue(prepareDisplayValue)`→多轮异步装饰重试(80/240ms)→marker(`\uE001`)恢复光标」机制的副作用（setValue L232-268、setWysiwygValueAtMarkdownOffset L270-311、重试 L253-258/293-300）：
- **#1 删图后光标跳文首**：`setSelectionRange()`（L408-410）是**空实现，仅 focus()**，`focus()`（L391）不带位置 → 落到文首/根起点（多处 `range.collapse(true)`/`selectNodeContents(root)` L1291）。
- **#4 点击编辑光标跳进代码块**：WYSIWYG 点击→caret 映射命中 `pre/code` 区（L2596 等），塌缩到代码块内。
- **#5 偶发丢光标、需刷新**：装饰重试与 `suppressProgrammaticInput`/`preferLastValueUntilInput`（L227/L239）时序竞争，选区/可编辑态丢失。
- **#10 视线乱跳**：80/240ms 猜测式重试 + 渲染后异步 `scrollRenderedElementIntoView` 造成滚动抖动。
- 修复方向：给 `setSelectionRange` 真正按 offset/marker 恢复；删图/局部编辑避免整篇 `setValue`，改局部 DOM 变更；把光标恢复收敛到 Vditor input 稳定后一次完成，去掉猜测式重试。⚠️ 高风险区（README 明确编辑器基线不可乱改），建议单独排期、逐条加回归 + 真机验证。

### 6.C 代码块体验（#6）
- 现状：`decorateCodeBlockLineNumbers` + `dumbpad-code-lines`（L220、L641-642）已有行号。溢出/横向滚动/超长折叠是 CSS/装饰层增强（`styles.css` `.vditor-wysiwyg__pre`）。
- 修复方向：行号列 sticky 不参与横向滚动、代码区 `overflow-x:auto` 且行号不错位、超过 N 行给展开/折叠。纯体验优化、无数据风险。

### 6.D 搜索与加载（#2）
- 根因：每次按键（150ms 防抖）→ `fetchThoughts()`（L642）发服务端 `listPage({query})`；服务端带 `q` 时 `listThoughtsPage` 直接 `return null`（`storage.js` L636）→ 回退**全量 `readThoughts()`**（S3=O(N) GET）→ 慢。清空输入同样触发全量往返，并先置 `_isLoadingThoughtPage=true` 显示“正在加载…”再渲染 → 卡顿。已有 `saveThoughtsCache`（L666，仅无筛选时）但搜索/清空未用于即时恢复。
- 修复方向（回答“缓存如何设计”，核心=想看的先出现）：
  1. **输入即时本地过滤**：先对已加载 `this.thoughts`(+缓存首页)做本地子串匹配并立即渲染，服务端全量搜索作为后台补充 merge。
  2. **清空立即从缓存恢复**：直接用 `saveThoughtsCache` 的未筛选首页同步渲染，不显示 loading、不等网络，随后后台静默刷新。
  3. **服务端搜索走索引**：split 下让关键词搜索先用 `indexes/thoughts-index.json`（其 `textPreview` 存了 300 字，`storage.js` L252-267）粗筛命中 id，再只读命中页，避免每次全量 `readThoughts()`。
  4. 整体与 Notepad 的 `deferRemote`（缓存先渲染→后台校验）思路一致。

### 6.E 同步与网络

#### #3 一边 fail fetch 一边 saved
- 根因：`fetchWithPin`（`app.js` L412-421）对**任何** fetch 异常都弹 `toaster.show(error,'error',true)`。保存主请求成功（→“Saved”）的同时，其它请求（实时 `update` 广播、`/api/notepads` 刷新、prefetch、AI 状态、瞬断）失败就弹 fail。移动端切后台/网络抖动尤其常见。
- 修复方向：区分“关键用户操作”与“后台/派生请求”的错误等级；后台失败静默或降级为同步图标，不弹全局 error；保存成功后抑制并发的非关键失败提示。

#### #8 智能自动同步（设计思考，非 bug）
- 现状边界：本地优先 + version 乐观并发 + 三路合并（仅单编辑点 disjoint）+ 冲突人工；overlap/结构化字段合并/离线队列不在现有能力（`sync-boundaries.md` §8/§9 声明不做完整 CRDT）。
- 建议的分层兜底：
  1. **确定性规则优先**：先把根因 A“先合并再提示”做好，disjoint 自动合并可覆盖绝大多数。
  2. **AI 仅作最后兜底**：仅当确定性合并判为 overlap（真冲突）时，把 base/local/remote 交 AI 产出候选合并稿 + 置信度 + 差异说明，**必须人工确认**。
  3. **硬约束**（与现有 AI 边界一致）：AI 合并是派生、可失败、**不得阻塞保存**；确认前不改主数据；无 Key 自动降级为人工冲突流程；合并前后留 base 快照可撤销。可复用 `agent` 只读框架的隔离思路（独立模型配置、SSE、失败不影响主数据）。

### 6.F 移动端 UI（#11 #12）
- **#11 底部胶囊间距**：纯 CSS——底部用 `env(safe-area-inset-bottom)` + 上下统一 padding，保证胶囊与阅读区上下等距。
- **#12 搜索按钮不收起 / AI 面板闪烁**：搜索按钮缺“已展开则收起”的对称 toggle 分支；AI 面板闪烁 = `ai_status_update`→`scheduleRender()` 反复整表重建（与 §6.0 同源），`restoreOpenPanelsAfterRender`（L1313-1330）虽尝试恢复但频繁 pending/ready 推送反复重建。
- 修复方向：搜索按钮加收起分支；AI 面板改**局部更新**（类 `updateThoughtToolCounts`），不因状态推送触发整表 `scheduleRender`，从根上消除闪烁。

### 6.G 优先级建议

| 级别 | 条目 | 理由 |
|---|---|---|
| P0（数据） | #9、#7、#13 | 会造成正文损坏 / 附件丢失 / 内容被旧版覆盖 |
| P0（架构共因） | §6.0 局部更新化 | 一改同时修 #13、#12，并缓解 #2 |
| P1 | #2、#3 | 高频体验痛点，改动可控 |
| P1 | #1、#5 | 光标丢失/跳首字影响编辑可用性（高风险区，需回归） |
| P2 | #4、#10、#6、#11、#12 | 体验优化 |
| 设计 | #8 | 需求探索，分层兜底 |

> 下一步建议：先做 **§6.0（编辑/交互中卡片不被 render 销毁）+ #9 幂等归一化 + #7 占位符不落盘**，这三项是数据安全的地基，且相互独立、可逐个加回归。是否要我从其中一项开始出**最小改动补丁草案**（仍不动数据结构与 API）？

---

## 7. 优化方案（整改路线：关联性 + 稳妥落地）

### 7.0 “稳妥”的定义（贯穿所有阶段的硬规则）

1. **数据完整性优先**：会造成正文损坏 / 附件丢失 / 覆盖的问题（#9、#7、#13、同步 A/D/E）排在体验问题之前。
2. **每个改动独立可上线、可回滚、可测试**：一个 PR 只碰一个有界的文件集，坏了能单独 revert。
3. **行为不变优先**：不改数据结构、不改 HTTP API、不改编辑器基线行为（README 明确 `refactor-ai-s3-thoughts` 编辑器基线不可乱改）。
4. **先立安全网再动主逻辑**：数据类改动必须**先补回归测试**（尤其幂等 round-trip），用它先复现 bug、再挡回归。
5. **同源问题成簇提交**：碰同一段代码路径的问题一起改，避免“半改”产生新的不一致中间态。
6. **高风险区最后、逐条、真机回归**：编辑器光标/视线（#1/#4/#5/#10）放最后，每条单独上 + 真机验证。
7. **风险改动加开关**：局部更新化、同步合并、光标恢复等，用 feature flag 灰度，异常可秒关回旧路径。

### 7.1 问题关联图谱（谁与谁同源 / 谁挡谁）

| 同源根 | 波及问题 | 关联含义（决定改的方式） |
|---|---|---|
| **`render()` 全量重建**（`thoughts.js` L1153） | #13 触发、#12 闪烁、#2 清空卡顿 | 一处“局部更新化”能同时压下三条；但因触碰更新分发，需先有 #13 的独立防线兜底 |
| **`getValue()` 序列化链路**（`hybrid-editor.js` L224/L448） | #9 反斜杠、#7 占位符落盘 | 同一条“存什么”的路径，合并为一簇；必须先有幂等 round-trip 测试 |
| **`notes_update` + 版本跟踪**（`app.js` L359/L1024/L1499） | 同步 A/D/E（+B/C） | A/D/E 必须一起改，半改会造出新的版本不一致；B/C 是增强可后置 |
| **storage 读取/索引**（`storage.js` L573/L625/L1453） | P0 写放大、#2 服务端搜索 | 后端增量索引做好后，#2 服务端搜索才能提速；两者共用索引层 |
| **附件存储模型**（base64 内联 vs asset） | P0 放大器、#13 asset GC | base64 内联附件放大全量写；迁移到 asset + 引用计数可一并解决 |

**关键顺序约束（不可颠倒）**：
- #13 的“提交防线”（Phase 2）必须**早于**列表局部更新化（Phase 3）——先兜底再重构，Phase 3 即使出问题数据也不丢。
- #9/#7 改动前（Phase 1）必须先有幂等测试（Phase 0）。
- #8（AI 兜底合并）必须在同步确定性合并（Phase 4）稳固之后。
- 后端写放大（Phase 7）与前端各簇解耦，可作为**并行第二条线**推进。

### 7.2 分阶段方案

| 阶段 | 目标问题 | 关键改动（有界文件集） | 稳妥做法（测试 / 回滚 / 开关） | 风险 |
|---|---|---|---|---|
| **P0 前置安全网**（不改行为） | 为 #9/#7/#13 兜底 | 新增：编辑器序列化**幂等 round-trip 测试**（同内容多轮 `getValue`↔`setValue` 字节不变）、Thought 编辑“断开即提交”测试 | 纯新增测试；先让测试**红**（复现 bug）再进入 Phase 1/2 | 无 |
| **1. 编辑器序列化卫生** | #9、#7 | `hybrid-editor.js` `stripDisplayGuards`/保存前归一化：非代码区折叠 `\_`/`\*` 过度转义；`getValue()` 过滤未完成 `[[资源上传中]]` token；上传失败/放弃清除 token | 依赖 Phase 0 幂等测试转绿；只动序列化输出，不动 DOM/光标；`npm run test:hybrid-editor-time-command` + 新幂等测试；可按代码区/非代码区分支灰度 | 中（勿误伤代码块内 `\`） |
| **2. 编辑提交安全网** | #13(b) | `thoughts.js` `saveAndExit`：textarea 断开时用**已捕获副本提交**而非 `return` 丢弃 | 小改、独立；加“编辑中被 render 打断仍保存”单测；出错仅回退到旧 return 分支 | 低 |
| **3. 列表局部更新化（架构共因）** | §6.0 → #12、#2清空、#13触发 | socket/AI 事件改走局部 patch（复用 `patchRenderedThought` L1276 / `updateThoughtToolCounts` L973）；`render()` **跳过正在编辑/展开面板的卡片**；`ai_status_update` 不再触发整表 `scheduleRender` | feature flag 包裹；`npm run test:thought-modules`；灰度期保留旧 `scheduleRender` 兜底；Phase 2 已先兜底 #13，故此阶段即使回滚也不丢数据 | 中 |
| **4. 同步冲突体验** | A→D→E→B→C | `app.js` `notes_update`：**先本地 `mergeContents` 再决定是否提示**（disjoint 静默合并/仅提示“已合并”，overlap 才弹冲突）；`renderCachedNotepad` 版本未知置 `null`（D）；`baseContent` 缺失时拉远端为 base 重试（E）；稳定设备级 `userId`（B）；实时预览只读复活或移除（C） | A/D/E 一次成簇；`npm run test:note-sync` + `test:api`；每步对照 `sync-boundaries.md` §8；flag 可回旧“悲观提示”；B 用 localStorage 持久 id | 中 |
| **5. 搜索与加载** | #2前端、#3 | `thoughts.js`：输入即时**本地过滤**已加载/缓存首页并立即渲染；清空**直接从缓存同步恢复**（不显示 loading、不等网络）；后台静默补齐。`app.js` `fetchWithPin` 错误**分级**（后台请求失败不弹全局 error） | 纯前端、低风险；`test:thought-modules`；服务端全量搜索保留为后台补充，不删旧路径 | 低 |
| **6. 移动端 / CSS 快赢** | #11、#6、#12(toggle) | `styles.css`/`thoughts.css`：底部 `env(safe-area-inset-bottom)`+等距 padding；代码块行号 sticky 不随横滚错位、`overflow-x:auto`、超长折叠；搜索按钮加“已展开则收起”分支 | 纯 CSS + 少量 JS，独立可随时上；视觉回归截图 | 低 |
| **7. 后端写放大（并行线）** | P0-perf、#2服务端 | `thought-routes.js` 改用单文件 `storage.writeThought/deleteThought`；PATCH 只改单条；`storage.js` **增量更新索引项**（不再每次 `readSplitThoughts` 全读）；split 关键词搜索走 `thoughts-index.json` 粗筛 | `npm run test:api`+`test:s3-storage`+`test:s3-prefix`；先本地后 S3；迁移前备份；索引缺失自动回退全量（现有逻辑保留） | 中高（后端数据面） |
| **8. 编辑器光标/视线** | #1、#4、#5、#10 | `hybrid-editor.js`：真正实现 `setSelectionRange`（按 offset/marker 恢复）；删图/局部编辑避免整篇 `setValue`；光标恢复收敛到 Vditor 稳定事件后一次，去掉 80/240ms 猜测式重试 | **逐条单独上**；每条过 `test:editor-performance` + **真机手动回归**；flag 可回旧路径；README 基线约束 | 高 |
| **9. 智能同步 AI 兜底** | #8 | 仅 overlap 真冲突时把 base/local/remote 交 AI 产候选稿+置信度，**必须人工确认** | 复用 `agent` 只读隔离；派生/可失败/不阻塞保存；无 Key 降级人工；`test:agent` | 中（依赖 Phase 4） |

### 7.3 推荐执行顺序与并行

```
前置：Phase 0（安全网测试）
主线（数据→架构→体验）：
  1 编辑器序列化卫生(#9 #7)
  2 编辑提交防线(#13b)          ← 必须早于 3
  3 列表局部更新化(#12/#2清空/#13触发)
  4 同步冲突(A/D/E → B → C)     ← “时常冲突”的正解
  5 搜索与加载(#2前端/#3)
并行线（后端，随时可起）：
  7 后端写放大(P0-perf) → 反哺 5 的服务端搜索
随时可插（低风险）：
  6 移动端/CSS(#11/#6/#12toggle)
最后（高风险，逐条+真机）：
  8 编辑器光标/视线(#1/#4/#5/#10)
后续（设计）：
  9 智能同步 AI 兜底(#8)
```

排序理由（即“为什么这样才稳妥”）：
- **数据不丢是地基**：1、2 先行，且各自独立可回滚。
- **防线先于重构**：2 给 #13 立独立防线，再做 3 的更大重构，任一环回退都不丢数据（**防御纵深**）。
- **高杠杆但有风险的放中段**：3 一次压下三条问题，但因触碰更新分发，放在数据安全网之后并加开关。
- **同步簇整体交付**：4 的 A/D/E 一起改，避免半改产生新版本不一致。
- **后端解耦并行**：7 只碰后端，可与前端并行推进，完成后反哺 5 的服务端搜索。
- **最高风险垫底**：8 放最后，逐条 + 真机回归，尊重编辑器基线约束。

### 7.4 每阶段的验收与回滚

- **验收（每阶段必过）**：对应 `npm run` 测试（见表“稳妥做法”列）全绿 + 该阶段新增回归测试 + 关键路径手动走查一次；数据类阶段额外做“存→刷新→再存”实测确认无损。
- **回滚**：每阶段独立 PR / 独立 flag；发现异常先关 flag 回旧路径，再定位；后端 Phase 7 迁移前对 `data/` 或目标 prefix 备份，索引层保留“缺失即回退全量”的现有兜底。
- **文档**：每阶段完成后同步更新 `docs/sync-boundaries.md`、`technical-overview.md` 及本报告对应条目状态，避免后续 agent 被过期边界误导。

> 说明：以上全部为**方案**，尚未改动任何代码。建议从 **Phase 0 + Phase 1（#9/#7）+ Phase 2（#13b）** 起步——它们是数据安全地基、相互独立、可各自加回归。确认后我可以按此顺序，逐个产出**最小改动补丁**（不动数据结构与 API），每个都附带回归测试。
