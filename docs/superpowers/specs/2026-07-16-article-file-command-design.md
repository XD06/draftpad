# `/file` 文章图片与附件插入设计

## 目标

为文章编辑器增加一个低干扰的 `/file` 命令：用户在普通文本位置输入 `/file` 并按 Enter，使用系统文件选择器插入图片或普通文件。它复用现有文章图片上传能力，同时补齐文章内普通附件，不引入常驻工具栏或 Base64 正文。

## 范围与交互

- 仅在文章编辑模式有效；阅读模式、组合输入、带修饰键的 Enter 不触发。
- 命令必须是光标前完整的 `/file` token，后方不能紧接字母、数字、`_` 或 `-`。
- 触发后保留命令所在 Markdown 偏移，再打开隐藏的原生 `<input type="file" multiple>`。
- 取消选择时不改写文档，`/file` 保持原样。
- 选择一个或多个文件时，在保存的位置一次插入有序的上传占位符；每个文件独立上传、独立替换。任一失败不会影响其他文件。
- 所见即所得与源码模式都使用同一 Markdown 偏移语义，文件选择器不能导致光标或插入位置漂移。

## 资源类型与渲染

### 图片

- 图片继续请求既有 `POST /api/assets/images`。
- 上传后写入现有标准 Markdown 图片语法：

  ```md
  ![文件名](/api/assets/<id>/preview "dumbpad-width=720")
  ```

- 保留现有尺寸调整、下载、阅读态大图查看、移动和粘贴图片行为。

### 普通附件

- 新增 `POST /api/assets/files`，只接受 `application/octet-stream` 请求体。
- 允许：PDF、纯文本/Markdown/CSV、Office 文档、音视频、ZIP/RAR/7z；拒绝 HTML、SVG、脚本和可执行文件。
- 服务端总是以下载形式返回普通附件，绝不以内联 HTML/SVG 形式响应。
- 文件在文章 Markdown 中保存为普通下载链接，并用受控 title 标记让编辑器装饰成附件卡片：

  ```md
  [📎 报告.pdf · 1.2 MB](/api/assets/<id>/download "dumbpad-file=1;size=1258291;type=application/pdf")
  ```

- 阅读模式点击下载；编辑模式点击附件卡片仍下载，不进入图片尺寸菜单或大图视图。

## 存储与限制

- 默认单文件上限为 `20 MiB`，由 `ASSET_MAX_FILE_BYTES` 环境变量覆盖。
- 图片继续沿用现有图片像素保护；普通文件不生成预览。
- 普通附件只存 `assets/<id>/original` 和 `assets/<id>/meta.json`；图片仍另存 `preview`。
- 文章正文只保存资源 URL 与展示元数据，不保存文件 Base64。
- 首期禁止自动清理孤立资源。文章内容删除或编辑后遗留的 asset 继续保留，避免误删；后续单独实现“扫描 → 资源垃圾桶 → 延迟清理”。

## 模块边界

- `public/managers/article-file-command.js`：纯命令识别、选择位置和 Markdown 生成，不接触 Vditor DOM。
- `public/managers/asset-api-client.js`：增加受限的 `uploadFile(file)`。
- `public/hybrid-editor.js`：将 `/file` 的键盘事件、文件选择器和占位符生命周期接到已有编辑器；不改写既有粘贴图片流程。
- `routes/asset-routes.js`：新增普通附件上传，并在读取时依据元数据强制下载。
- `scripts/asset-storage.js`：支持没有 preview 的普通附件，而不改变图片对象布局。

## 验证

1. `/file` 在源码与所见即所得模式均能在原命令位置插入。
2. 取消文件选择后 `/file` 未丢失；多选顺序稳定。
3. 图片仍生成预览 Markdown；普通文件生成可下载附件链接。
4. 超过 20 MiB、禁止类型和伪造 MIME 均被服务端拒绝。
5. 上传失败仅替换对应占位符，其他文件继续完成。
6. 既有粘贴图片、图片移动、阅读态大图和下载回归通过。
7. S3 与 local 后端都能上传、读取和下载普通附件。

