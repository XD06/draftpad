# DumbPad 项目长期记忆

## 定位
本地优先极简 Markdown 草稿本。核心：混合编辑、Quick Thoughts 待办、AI 关系分析、S3 兼容存储、WebSocket 同步、PWA 移动端。

## 技术栈
- 后端：Node.js + Express（server.js 入口，routes/* 9 个路由模块）
- 前端：Vanilla JS（无构建工具），public/managers/* 拆分 Thought 逻辑
- 渲染：Vditor / Marked + highlight.js
- 存储：scripts/storage.js 统一本地 JSON / S3 接口；layout 分 legacy(单文件) / split(拆分)
- 搜索：Fuse.js，数据源 storage.getSearchDocuments()
- 实时：ws，事件 thoughts_update / notes_update / relations_update / notepad_change
- AI：scripts/ai-queue.js（异步队列）+ ai-provider.js（chat/embedding/rerank/insight，OpenAI 兼容，无 key 降级 noop）

## 数据模型
- Notepad：文章元数据（id/name/version/createdAt/updatedAt），正文走 Note API
- Note：正文内容，baseVersion 乐观并发
- Thought：主任务 + 子任务(二层)，tags，version，AI meta(summary/entity/topic/intent/keywords/embedding)，relations
- Trash：trash/index.json + trash/notepads|thoughts/<trashId>.json

## 关键约束（重构/改动必守）
- 不改变用户可见行为，除非显式要求
- 存储统一走 scripts/storage.js，上层不直接碰文件/S3
- AI、S3、WebSocket 不得阻塞 Thought 快速写入
- AI relations 与 manual relations 分离；suppressed 误判记忆
- PWA 未版本化资源网络优先+缓存回退，勿改回纯缓存优先
- 保留多端 Note 版本冲突处理
- Thought CRUD 走 withThoughtWriteLock 互斥锁
- Note 写入用 temp+rename 原子写

## 验证命令
npm run check / test:api / test:thought-modules / test:note-sync / test:pwa-cache / test:ai-queue / test:relations / test:s3-storage / test:s3-prefix
（test:s3-real 需真实 S3 环境，勿随意跑）

## 文档入口
- AGENT_CONTEXT.md：新会话首读
- docs/README.md：文档地图（current vs archive）
- docs/technical-overview.md / sync-boundaries.md / storage-interface.md / ai-pipeline-interface.md
- api.md：完整 REST API
- 根目录保持精简：server.js + test_*.js（仅 package.json 引用的为当前测试）

## 布局
- 入口：server.js
- 路由：routes/{auth,note,notepad,thought,search,share,trash,data-management,static}-routes.js
- 后端能力：server/{indexing,websocket}.js, scripts/{storage,ai-queue,ai-provider,s3-service,s3-prefix-tools,migrate-local-to-s3}.js
- 前端：public/app.js + public/managers/*（thought-api-client/outbox/card-renderer/tags/ai-status/relations-panel/relations-state/editor/quick-add/text-formatting, note-sync-controller, settings-data-panel, ws-client 等）
