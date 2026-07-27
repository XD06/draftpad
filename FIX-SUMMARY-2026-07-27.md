# DumbPad 安全加固补充 (2026-07-27)

承接 `audit-2026-07-06.md` 审计与 `FIX-SUMMARY-2026-07-06.md` 首轮修复，本轮为**安全加固补充 + 预存测试失败修复**。原则：只做“安全且不破坏既有行为”的改动，每项配套回归测试，用**全量测试套件锁定**。

## 本轮修复（4 项）

| 编号 | 问题 | 修复 | 文件 | 回归测试 |
|---|---|---|---|---|
| S1 | 分享页 XSS 纵深防御不足：`marked` v15 不过滤原始 HTML，`sanitizeHtml` 是唯一屏障，原实现可被实体编码/空白拆分/单遍正则重组等手法绕过 | `sanitizeHtml` 改为**定点循环**剥离危险标签（script/iframe/object/embed/form/srcdoc）与 `on*` 事件属性；`javascript:`/`vbscript:`/`data:text/html` 等危险 scheme（含 `javascript&#58;`、`jav\tascript:`、大小写/前导空白混淆）统一中和为 `href="#"`；放行 `data:image` 光栅图与 https/相对链接；保留渲染管线的 `@@MARK_TOKEN@@` 占位符 | `routes/share-routes.js` | `test_share_sanitizer.js` |
| S2 | **SHARE_SECRET 硬编码默认值**（完成 audit P0-3）：`process.env.SHARE_SECRET \|\| PIN \|\| 'dumbpad_default_secret_9988'`，任何读过源码者可为任意 notepad id 伪造 share token（在既未设 SHARE_SECRET 也未设 PIN 的部署上） | 移除世界已知常量；未设 secret/PIN 时改用 `crypto.randomBytes(32)` **随机 per-boot secret**；保留 `SHARE_SECRET → PIN` 的既有回退语义；**token 派生与长度不变**（不破坏已设 SHARE_SECRET 用户的现有链接）；warning 区分“派生自 PIN”与“随机 per-boot” | `server.js` | `test_share_secret.js` |
| S3 | WebSocket 帧无上限：`ws` 默认 100 MiB，单连接可耗尽内存（DoS） | `createWebSocketHub` 增加 `maxPayloadBytes` 参数并设 `maxPayload` 上限 **50 MiB**（与 HTTP 上传上限一致；实时协作帧仅承载 Markdown 文本，远低于此），保留原有函数签名 | `server/websocket.js` | 由 `test_api_regression.js` 源码断言覆盖 |
| S4 | 预存失败的性能测试（首轮遗留红） | `beginSwitch` 轨迹补 `stableAfterRetryMs`/`stableScheduled` 初始化，`finishSwitch`/`scheduleFinish` 正确写入稳定耗时 | `public/managers/editor-performance.js` | `test_editor_performance.js` |

## 测试结果

```
全量套件           total=74  pass=74  fail=0   (~29s，排除需真实凭证的 test_s3_real_smoke)
npm run check      ✓  193 files + server startup verified
```

新增测试已注册进 `package.json`（`test:share-sanitizer` / `test:share-secret`）并并入 `test:safety` 聚合链。

## 刻意保持现状（经用户确认，不在本轮改动）

以下项**会改变线上行为或已被测试锁定为既定行为**，用户已明确选择不动，仅在此登记以免后续 agent 误改：

- **legacy 无 PIN 可写**：`test_api_regression.js` 以无 PIN + development 启动并断言可写，属既定行为——用户选择“完全不动”。
- **CORS 默认 `ALLOWED_ORIGINS='*'`**：收紧会影响用户现有线上部署——用户选择“暂时不管”。
- **请求体 `50mb` 上限**：故意与 `/api/upload` 上传上限一致，非缺陷。
- **CSP `unsafe-inline`**：分享页/登录页依赖内联脚本；XSS 已在源头（S1 sanitizer）缓解。
- **`STORAGE_LAYOUT=legacy` 默认**：改默认值对既有数据有迁移风险。

## 未处理的大重构（需单独评审 + 真机/压测环境）

详见 `audit-sync-performance.md`。这些改动触及编辑器基线（README 声明不可乱改）或核心数据路径，缺少真实数据量压测环境时风险偏高，不属于“安全且不破坏既有”的范畴，作为后续独立工作：

- **P0 写放大**：Thought 写路径全量读写，S3+split 下放大严重（切换单文件写 + 增量索引）。
- **同步冲突 UX**（根因 A/C/D/E）：收到远端保存先本地三路合并再提示；修复版本漂移。
- **编辑器光标/序列化**（#9 反斜杠累积 / #7 占位符落盘 / #13 编辑附件回滚 / #1/#4/#5 光标）：高风险区，需逐条 + 真机回归。

## 涉及文件清单

**后端**：`server.js`、`routes/share-routes.js`、`server/websocket.js`
**前端**：`public/managers/editor-performance.js`
**测试**：`test_share_sanitizer.js`（新增）、`test_share_secret.js`（新增）、`package.json`（脚本注册）
