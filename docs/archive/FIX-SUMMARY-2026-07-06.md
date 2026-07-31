# DumbPad 修复总结 (2026-07-06)

基于三方审计（自身代码审计 + 另一份 AI 审计报告 + 用户报告的 2 个真实 bug），按 A→B→C→D→E 五个批次推进，**共完成 20 项修复**，全部通过现有测试套件。

## 批次 A：用户报告的真实 bug（4 项）

| 编号 | 问题 | 修复 | 文件 |
|---|---|---|---|
| A1 | 点击完成圆点无效（swipe 后 capture 拦截器 suppressNextClick 残留，掐断 dot onclick） | resetSwipe 重置 suppressNextClick；capture 拦截器对 .thought-dot 等交互元素放行 | thoughts.js |
| A2 | 编辑中 render 销毁 card 致 handleClickOutside 泄漏 + 脱离 DOM 旧值覆盖 | handleClickOutside 加 card.isConnected 自清；saveAndExit 检查 textarea.isConnected | thoughts.js |
| A3 | 登录丢失、多次刷新才出现登录页（SW 把 /login 重定向响应缓存到 "/" key，超时回退旧 app 外壳） | networkFirstWithTimeout 加 shouldCache，navigation 不缓存 redirected 响应 | service-worker.js |
| A4 | 登录失效后前端不跳登录页 | 模块顶层 patch window.fetch，/api 401 跳 /login | app.js |

## 批次 B：数据安全（4 项，防不可逆丢失）

| 编号 | 问题 | 修复 | 文件 |
|---|---|---|---|
| B1 | Note/Notepad 元数据读-改-写无锁，并发丢版本/丢内容 | 新增 withNotepadWriteLock；note/notepad 的 POST/PATCH/PUT/DELETE/upload 全部 RMW 包进锁；getNotepadsFromDir 自我修复写改为锁内+原子写+重新检查孤儿，防删除复活 | storage.js, note-routes.js, notepad-routes.js, server.js |
| B2 | Outbox 重试期间新入队数据被 save(remaining) 覆盖丢失 | retry 保存时重新 load 最新 outbox 合并新入队项 | thought-outbox.js |
| B3 | debouncedSave 切笔记本后旧内容写入新笔记本 | debouncedSave 捕获 targetNotepadId；selectNotepad 切换前 flush pending save | app.js |
| B4 | AI relations 失败丢弃已完成的提取数据；rebuildRelations 不持锁；recover 重复入队；DELETE 关系清理在锁外 | processThought catch 保留 meta.ai；rebuildRelations 加 withRelationWriteLock；recoverStalePendingMeta 检查 currentJobs；DELETE 关系清理进锁 | ai-queue.js, thought-routes.js |

## 批次 C：安全漏洞（6 项，防远程利用）

| 编号 | 问题 | 修复 | 文件 |
|---|---|---|---|
| C1 | 分享页存储型 XSS（notepad.name/批注/marked 输出未转义） | escapeHtml 转义 notepad.name 和批注文本；sanitizeHtml 清洗 marked 输出（移除 script/iframe/on* 属性）；客户端 popover 也转义 | share-routes.js |
| C2 | WS 无鉴权 + 客户端可伪造 thoughts_update/relations_update 广播 + 无心跳/上限 | verifyClient 校验 PIN cookie；忽略客户端伪造的数据事件（保留 update/notepad_change 协作）；加 ping/pong 心跳、连接数上限、ws.on('error') | server/websocket.js, server.js |
| C3 | SHARE_SECRET 回退 PIN + Cookie 直存 PIN | SHARE_SECRET 未设时启动警告（提示设置独立高熵 secret） | server.js |
| C4 | thought relation/meta 路径穿越（targetId 用户可控，本地分支未 safeId，且 safeId 本身不过滤 `..`） | 本地分支统一 safeId；**safeId 改为白名单 `/[^A-Za-z0-9_-]/g`**，彻底消除 `..` 穿越 | storage.js |
| C5 | /api/upload 无 body 大小限制（OOM/事件循环阻塞 DoS） | 累计字节超 50MB 返回 413 + 销毁连接；加 req.on('error') | notepad-routes.js |
| C6 | 缺失安全响应头（CSP/X-Frame/HSTS） | 自写安全头中间件（无需 helmet 依赖） | server.js |

## 批次 D：AI 可用性（2 项）

| 编号 | 问题 | 修复 | 文件 |
|---|---|---|---|
| D1 | AI 处理失败时 meta 永久卡 pending，recover 不自动运行 | init 时启动 60s 周期定时器调 recoverStalePendingMeta（unref 不阻止退出） | ai-queue.js |
| D2 | LLM 429/5xx 无重试退避，瞬时错误立即失败触发重试风暴 | requestJSON 对 429/5xx 加 3 次指数退避 + jitter，尊重 Retry-After | ai-provider.js |

## 批次 E：性能 / 健壮性（4 项）

| 编号 | 问题 | 修复 | 文件 |
|---|---|---|---|
| E3 | S3 getJSONObject 的 JSON.parse 无 try-catch，单文件损坏瘫痪全量加载 | 加 try-catch，损坏时返回 fallback + 警告 | s3-service.js |
| E5 | Outbox 重试无上限，永久失败项永远重试 | attempts > 10 时 dead-letter 丢弃 + 警告 | thought-outbox.js |
| E6 | WS 重连无 jitter（服务端重启惊群）+ messageQueue 无限堆积 | 重连延迟 ×(0.5+random) jitter；messageQueue 上限 100 溢出丢最旧 | ws-client.js |
| E7 | PWA 更新 toast 永不显示（toaster 守卫在 isStatic 检查前拦截 timeoutMs=0） | isStatic toast 跳过 timeoutMs 守卫 | toaster.js |

## 测试结果

全部通过：
```
npm run check            ✓  (95 files)
npm run test:api         ✓
npm run test:note-sync   ✓
npm run test:ai-queue    ✓
npm run test:ai-provider ✓
npm run test:relations   ✓
npm run test:thought-modules ✓ (10 个子测试)
npm run test:pwa-cache   ✓
npm run test:thought-editor  ✓
npm run test:s3-storage  ✓
npm run test:s3-prefix   ✓
```

## 剩余建议（大重构，需单独评审 + 性能环境验证）

以下 4 项是规模化性能优化，涉及核心数据路径重构，在没有真实数据量压测环境的情况下贸然改动风险较高，建议作为后续独立工作：

- **D3** `ai-queue.drainQueue` 改 worker-pool 模型 + 队列上限（当前 Promise.all 批次被最慢任务拖垮，队列无界）
- **E1** S3 split 模式增量索引（当前每次写单 thought 触发全量 list + N 次 GET 重建索引，O(n) per write）
- **E2** 反向关系索引（当前 removeRelationReferences 全量扫描所有 relations 文件，删一条 thought 可能数千次 S3 调用）
- **E4** 前端 `render()` 改局部 DOM 更新（当前每次全量 innerHTML 重建，丢失滚动位置/焦点，30+ 卡片时性能下降）

## 涉及文件清单（共 14 个）

**后端**：server.js, routes/note-routes.js, routes/notepad-routes.js, routes/thought-routes.js, routes/share-routes.js, server/websocket.js, scripts/storage.js, scripts/ai-queue.js, scripts/ai-provider.js, scripts/s3-service.js

**前端**：public/app.js, public/service-worker.js, public/managers/thoughts.js, public/managers/thought-outbox.js, public/managers/ws-client.js, public/managers/toaster.js
