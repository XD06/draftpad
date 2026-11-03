# 运维手册（部署 / 附件迁移 / asset 回收）

面向**已经跑起来的实例**：怎么发版、怎么跑数据维护脚本、出问题怎么回滚。
日常开发约定见 `../AGENTS.md`，接口契约见 `api.md`。

> 生产实例：`https://draft.203065.xyz`，VPS 上的检出目录 `/root/draftpad`，
> `docker compose` 项目名 `draftpad`，容器名 `dumbpad`，端口 `9797`。
> 数据在 **S3**（`STORAGE_BACKEND=s3`、`STORAGE_LAYOUT=legacy`），宿主机的
> `/root/draftpad/data` 基本是空的，只在跑维护脚本时用来放备份。

## 1. 发版（日常）

```bash
# 本地
git push origin main

# VPS
ssh locvps
cd /root/draftpad
git pull --ff-only origin main
docker compose build dumbpad
docker compose up -d dumbpad
docker ps --filter name=dumbpad        # 等 (healthy)
curl -s https://draft.203065.xyz/api/config | head -c 200   # version 变了就生效
```

- 前端 `public/**` 变化会让 `BUILD_VERSION` 指纹变化，客户端下次刷新自动换缓存，不用手动清 SW。
- 只改后端/脚本也建议 `build`：镜像里 `COPY . .`，脚本改动同样要进镜像。

## 2. 附件与 asset 维护脚本

两个脚本都在 `scripts/`，都**默认 dry-run**，都不在应用进程内，拿不到
`withThoughtWriteLock` —— 所以：

| 脚本 | 作用 | 停机？ | 破坏性 |
| :-- | :-- | :-- | :-- |
| `migrate-thought-attachments.js` | 把 Thought 里内联的 base64 附件搬进 asset store | **要**（写 4 条 Thought 期间） | 改数据（有备份） |
| `gc-orphan-assets.js` | 删除没有任何引用的 asset | 不需要（但建议低峰） | 删文件（不可逆） |

### 2.1 为什么必须用 `--user root`

容器默认用户是 `node`(uid 1000)，而宿主机的 `data/` 目录是 `root:root 755` 且**基本为空**
（数据在 S3）。脚本要把备份写到 `DATA_DIR/legacy/`，以 `node` 跑会直接
`EACCES: permission denied, mkdir '/app/data/legacy'`。

**用一次性 root 容器跑维护脚本**（不改宿主机权限）：

```bash
docker compose run --rm --no-deps --user root dumbpad node scripts/<脚本>.js ...
```

（如果更愿意保留最小权限：`mkdir -p data/legacy && chown 1000:1000 data/legacy`，之后可以不带 `--user root`。）

### 2.2 内联附件迁移

```bash
cd /root/draftpad

# ① 先看报告（不停机、不写盘）
docker compose run --rm --no-deps --user root dumbpad \
  node scripts/migrate-thought-attachments.js

# ② 停机 → 迁移 → 起服
docker compose stop dumbpad
docker compose run --rm --no-deps --user root dumbpad \
  node scripts/migrate-thought-attachments.js --apply
docker compose start dumbpad
```

要点：

- **备份**：`/app/data/legacy/thoughts-before-attachment-migration-<ts>.json`（宿主机
  `/root/draftpad/data/legacy/…`），就是迁移前的整份集合。回滚 = 把这份 JSON 写回
  `thoughts.json`（S3 上对应 `S3_PREFIX` 下的同名对象）。
- **图片**走图片通道（sharp 生成 webp 预览，与 `/api/assets/images` 同形）。
- **白名单外的老类型**（`ps1` / `html` / `tar.gz` …）默认保持内联；确认要收干净时加
  `--allow-unsupported-types`：会以 `application/octet-stream` 存成只读资产（服务端始终
  `Content-Disposition: attachment`，**不放宽 `/file` 上传白名单**）。
- 幂等：已带 `assetId` 的附件会跳过，重复跑安全。
- 报告里的 `skipped` / `failed` 会逐条给出原因（`undecodable-data-url` /
  `Unsupported file type` …）；`failed` 非空时 CLI 以 exit code 2 退出。

### 2.3 孤儿 asset 回收

```bash
# ① 报告（只读）
docker compose run --rm --no-deps dumbpad node scripts/gc-orphan-assets.js

# ② 回收：--expect-orphans 必须等于上一步报告里的 orphans
docker compose run --rm --no-deps dumbpad \
  node scripts/gc-orphan-assets.js --apply --expect-orphans <N>
```

要点：

- 引用根：Thought 附件 + 附件 URL + 正文/子任务里贴的 `/api/assets/<id>`、垃圾桶可恢复的
  Thought 与文章正文、所有文章 Markdown、Instant Draft 文本。
- 安全门：文章读取用严格版本（读失败直接中止，不会把"读不出来"当"没有引用"）；扫描期
  出现 S3 `corrupt JSON` 警告即拒绝；`createdAt` 未知的资产跳过；引用根为空拒绝执行。
- `--expect-orphans` 对不上（根集合变了）会拒绝执行——**重新跑 dry-run 拿新数字**。
- 宽限期 `--grace-days`（默认 7）保护"刚上传、引用还没写盘"的资产；但**宽限期不是无引用
  证明**（hash 复用会把新引用挂到老 asset 上、离线 outbox 引用服务端看不到），所以 `--apply`
  仍建议在低峰执行。

## 3. 2026-11-03 上线记录（附件载荷治理）

背景：一条带 3.2MB PDF 的 Thought 让列表响应 4.3MB / 10s、按 id 跳转 4.3MB / 15s；
S3 legacy 下每次 Thought 请求都要拉整份集合。

| 步骤 | 结果 |
| :-- | :-- |
| 发版 `17824ed` | 列表 4,304,465 B → **12,332 B**；跳转详情 4,292,807 B → **674 B** |
| 迁移（`--apply`） | 4 个内联附件 → asset（含 3.2MB PDF）；备份 5,036,056 B |
| 集合读取成本 | 服务端 ~700ms → **~150ms**（RTT 基线 517ms） |
| GC（`--apply --expect-orphans 20`） | 删除 20 个孤儿 / **28,690,198 B** |
| 迁移收尾（`--apply --allow-unsupported-types`） | 剩余 5 个（2 张图片 + ps1/html/tar.gz，393,393 B）全部迁移，`thoughtsWritten=3`，`skipped=0`、`failed=0` |
| 最终状态 | dry-run 复核 `inlineAttachments: 0`；列表里 `anyDataUrl=false`；图片预览 `/api/assets/<id>/preview` → 200 `image/webp` |

遗留（下次可以再看）：

- 集合仍是 legacy 布局（整份 JSON，当前约 1MB+）。想再降延迟可评估迁到 split 布局
  （`scripts/migrate-thoughts-local.js`），但它**不能替代**附件迁移。
- `data/` 仍是 root 拥有且为空；跑维护脚本记得 `--user root`。
- 新附件已默认走 asset（图片 + 白名单内文件）；白名单外的类型仍会回退内联，
  如果经常传 `ps1`/`html`/`tar.gz`，需要评估是否扩展 `scripts/file-asset-policy.js` 白名单。

## 4. 验证命令

```bash
# 容器与版本
docker ps --filter name=dumbpad --format '{{.Names}} {{.Status}}'
curl -s https://draft.203065.xyz/api/config | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])'

# 列表/详情载荷（需要登录态，浏览器 console 里跑）
#   fetch('/api/thoughts?format=page&sort=timeline&limit=30&light=1').then(r=>r.text()).then(t=>t.length)
#   fetch('/api/thoughts/<id>?light=1').then(r=>r.text()).then(t=>t.length)
```

## 5. 常见故障

| 现象 | 处理 |
| :-- | :-- |
| 迁移报 `EACCES … mkdir '/app/data/legacy'` | 用 `--user root`（见 2.1），或先 `chown 1000:1000 data/legacy` |
| GC 报 `refused: no Thought, no notepad and no draft` | `DATA_DIR` / `S3_PREFIX` 配错了，先核对报告里的 `s3Prefix` |
| GC 报 `orphan count changed since the dry-run` | 根集合变了，重跑 dry-run 拿新的 `orphans` 再 apply |
| 附件下载 404 | 迁移后附件走 `/api/assets/<assetId>/download`；老的内联附件走 `/api/thoughts/<id>/attachments/<attId>` |
| 客户端还是旧界面 | 普通刷新即可（`managers/*.js` 是 network-first）；SW 缓存版本随 `BUILD_VERSION` 变 |
