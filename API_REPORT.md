# DumbPad API 自动化管理深度报告 (v1.3)

## 1. 应用概述 (App Purpose)
DumbPad 是一款专为 **AI Agent 友好**、**沉浸式阅读**与**快速记录**设计的极简草稿本应用。
- **混合编辑**：支持 Markdown 实时渲染与原位编辑。
- **双向同步**：API 触发的所有修改将通过 WebSocket 实时推送到已打开的浏览器页面。
- **Agent 优先**：提供精准的局部修改接口（Append/Replace/Prepend），而非传统的全量覆盖，极大地降低了 AI 处理长文本时的 Token 消耗。

---

## 2. 鉴权体系 (Authentication)
所有 API 均受 `DUMBPAD_PIN` 保护。
- **机制**：HTTP Bearer Token
- **Header 格式**：`Authorization: Bearer <Your_PIN>`
- **注意**：如果 `.env` 中未设置 PIN，API 将返回 `401 Unauthorized`。

---

## 3. 核心接口详解

### 3.1 获取文章列表 (List Notepads)
- **Endpoint**: `GET /api/notepads`
- **功能**: 获取所有草稿文件的元数据。
- **查询参数 (Query)**:
    - `q` (string): 按标题过滤关键词。
    - `title` (string): `q` 的别名。
    - `sortBy` (string): 排序字段，可选 `updatedAt` (默认), `name`, `createdAt`。
    - `order` (string): 排序顺序，可选 `desc` (默认), `asc`。
- **返回字段**:
    - `id` (string): 文章唯一标识符（时间戳字符串）。
    - `name` (string): 文章标题。
    - `createdAt` (number): 创建时间戳（ms）。
    - `updatedAt` (number): 最后修改时间戳（ms）。

### 3.2 创建文章 (Create)
- **Endpoint**: `POST /api/notepads`
- **Body (JSON)**:
    - `name` (string): 文章标题（必填）。
    - `content` (string): 初始正文内容（可选）。
- **字段说明**: 标题如果重复，系统会自动添加序号（如 `MyNote (1)`）。

### 3.3 快速二进制上传 (Binary Upload)
- **Endpoint**: `POST /api/upload`
- **功能**: 无需 JSON 封装，直接上传原始文件流（Agent 推荐使用）。
- **Headers**:
    - `X-Filename` (string): 文件名（包含扩展名，系统会自动提取标题）。
    - `Content-Type`: 建议设为 `application/octet-stream`。
- **Body**: 文件的原始二进制流/文本流。

### 3.4 全文搜索 (Full-text Search)
- **Endpoint**: `GET /api/search`
- **查询参数 (Query)**:
    - `q` (string): 搜索关键词（必填）。
    - `query` (string): `q` 的别名。
    - `page` (number): 页码（默认 1）。
- **响应结果字段**:
    - `results` (Array):
        - `id`: 文章 ID。
        - `title`: 文章完整标题。
        - `snippet`: 高亮匹配的上下文片段。
        - `matchType`: 匹配类型 (`title` 或 `content`)。
    - `totalPages`: 总页数。
    - `currentPage`: 当前页码。

### 3.5 局部内容更新 (Partial Patch)
- **Endpoint**: `PATCH /api/notes/:id`
- **功能**: 对文章内容进行原子级精准操作。
- **Body (JSON)**:
    - `action` (string): 必需，可选值如下：
        - `append`: 在文章末尾追加内容。
        - `prepend`: 在文章开头插入内容。
        - `replace`: 替换**所有**匹配的 `target` 文本。
        - `replace_first`: 仅替换**第一个**匹配的 `target` 文本。
        - `overwrite`: 覆盖全文。
    - `text` (string): 要追加/插入/覆盖的新文本（用于 `append`, `prepend`, `overwrite`）。
    - `target` (string): 要被替换的原始文本（仅用于 `replace`, `replace_first`）。
    - `replacement` (string): 替换后的新文本（仅用于 `replace`, `replace_first`）。
- **错误处理**:
    - 如果 `action` 为 `replace` 或 `replace_first` 且文档中未找到 `target`，接口将返回 `400 Bad Request`，错误信息为 `"Target text not found in document"`。
    - 如果 `target` 为空字符串，将返回 `400` 错误。
- **响应 (JSON)**:
    - `success` (boolean): 操作是否成功。
    - `modified` (boolean): 内容是否真正发生了改变。
    - `content` (string): 修改后的完整正文。

### 3.6 读取与删除 (Read/Delete)
- **GET** `/api/notes/:id`: 返回文章的原始 Markdown 文本。
- **DELETE** `/api/notepads/:id`: 永久删除文章及其本地文件。
- **PUT** `/api/notepads/:id`: 重命名文章标题。
    - `Body`: `{"name": "New Title"}`
- **GET** `/api/share/:id`: 生成一个带签名的公开分享链接。
    - `返回`: `{"shareUrl": "http://.../s/id?t=token"}`

### 3.7 公开访问接口 (Public Access)
- **Endpoint**: `GET /s/:id`
- **功能**: 无需 PIN 码访问带签名的公开分享页（只读渲染）。
- **查询参数**:
    - `t` (string): 必需的签名 Token，由 `/api/share` 接口生成。

---

## 4. 实时性保障
DumbPad 使用 WebSocket 监听所有 API 调用。当 Agent 通过 API 修改内容时，所有处于该文章页面的用户浏览器会收到 `update` 信号并静默同步 DOM，无需刷新页面，且不会中断用户当前的输入状态。

---
*报告生成时间：2026-05-17*
