# 文章修改次数：连续编辑会话

用户确认的规则：一次连续编辑只计一次，正文连续一分钟无变化后再修改才计下一次。第一份有效保存立即计数，正文同步保持原来的 2 秒静默保存与版本并发保护。

## 实现范围

- `public/managers/note-sync-controller.js`：在已有本地缓存里保存 `editSessionId`、`previousEditSessionId` 和 `lastEditedAt`。仅输入入口传 `recordActivity: true`；同步确认、合并、远端加载不延长实际编辑活动。没有新增浏览器模块或 PWA manifest 条目。
- `public/app.js`：正文保存随请求携带会话标识，在加入保存队列时捕获，防止排队期间新编辑串入旧请求。同步计数至底部展示，仍使用原版本校验、保存队列和冲突处理。
- `scripts/note-edit-stats.js`、`routes/note-routes.js`：有效 POST、PATCH 和批量编辑在已有写锁/元数据写入内计数。已识别会话持续修改不重复计数；客户端新会话引用已记录的上一会话时开启下一轮，避免 2 秒保存延迟错移一分钟边界。不同设备在一分钟内开始的会话归为同轮，当前轮保留最近 32 个标识。旧客户端/API 缺少标识时按服务端有效保存之间的一分钟空闲分轮。
- `server/websocket.js`：原正文广播附带计数、起点和服务端更新时间，不新增消息类型。
- `public/managers/article-meta-footer.js`：展示独立 `editCount`，悬停说明统计从何时开始；不再显示历史 `version - 1`。

## 边界

统计只在有效正文保存时持久化。重命名、置顶、读取、noop、409 失败均不增加次数。`version` 和 `baseVersion` 不参与会话计算，版本仍随每次有效保存递增。会话时间只用于本机活动划分，服务端统计/更新时间采用服务端时间。

旧数据无需批量迁移；首次有效正文修改从 1 开始。原来显示的 1339 次无法还原为编辑会话，不进行换算。离线缓存保留最后正文快照，离线期间从未上传的中间编辑轮次不补计。服务端重启和刷新均保留已持久化统计；删除/恢复按已有整条元数据存储流程保留字段。

没有新增后台轮询、心跳、S3 请求、存储布局或编辑器内核修改。

## 验证

`test:note-edit-sessions` 覆盖持续输入三分钟但不保存、59.999 秒/60 秒空闲边界、保存延迟、首次计数、每次版本递增、noop/409 不写入、重命名/置顶、PATCH/批量编辑、跨设备会话、刷新缓存和底部统计起点。`test:note-edit-sessions-browser` 使用本机 Chrome、真实键入和 WebSocket，验证自动保存计数、三分钟持续输入、一分钟空闲、远端底部更新与刷新。

额外运行 `test:note-sync`、`test:api`、`test:pwa-cache`、`test:startup-performance`、`test:tiptap-undo-history` 与 `npm run check`；全量 Node 回归由 `npm test` 验证。

已完成验证：`npm run check`（310 个 JS 文件及服务器启动）、`npm test`（121/121，包含同步、API、PWA、S3 和撤销历史回归）、`test:note-edit-sessions`、`test:note-sync`、`test:startup-performance`、`test:api` 与 `test:note-edit-sessions-browser` 均通过。浏览器测试使用真实 Chrome 键入/自动保存/WebSocket，并快进客户端时钟验证三分钟连续输入及一分钟空闲边界；不是移动设备的实际 PWA 生命周期测试。
