const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const storage = require('./storage');

const DEMO_EPOCH = Date.parse('2026-07-15T09:00:00+08:00');

function timestamp(minutes) {
    return DEMO_EPOCH + minutes * 60 * 1000;
}

function readAgentSkill() {
    return fsSync.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
}

function demoNote(id, name, content, offset, options = {}) {
    const createdAt = timestamp(offset);
    return {
        id,
        name,
        version: 1,
        createdAt,
        updatedAt: createdAt,
        ...(options.pinned ? { pinned: true, pinnedAt: createdAt } : {}),
        content
    };
}

function demoThought(id, text, options = {}) {
    const createdAt = timestamp(options.offset || 0);
    return {
        id,
        text,
        subItems: options.subItems || [],
        tags: options.tags || [],
        completed: options.completed === true,
        pinned: options.pinned === true,
        ...(options.pinned ? { pinnedAt: createdAt } : {}),
        attachments: options.attachments || [],
        version: options.version || 1,
        createdAt,
        updatedAt: timestamp(options.updatedOffset ?? options.offset ?? 0)
    };
}

const NOTES = [
    demoNote('default', '欢迎使用 DumbPad', `# 欢迎使用 DumbPad

这是一份可重复生成的演示数据。它既用于体验产品，也用于验证常用编辑、搜索、同步和 API 路径。

## 从这里开始

1. 点击正文进入混合编辑；点击空白区域回到阅读状态。
2. 使用左侧搜索“乐观并发”“上传进度”或“可信设备”，验证文章名搜索、正文定位与高亮。
3. 切到 Thoughts，查看置顶、标签、子任务、附件、关联和完成状态。

## 时间图标

在编辑器输入 \`/time\` 后按 Enter，会插入当前时间图标。下面是已经写入文档的示例：

创建记录 [[time:create:2026-07-15 09:00:00]]

更新时间 [[time:update@2:2026-07-15 09:08:00]]

在可视编辑模式中可以拖动时间图标；拖动时会显示落点光标。跨段落、列表和普通文本拖动时，请在目标文本附近松开。

## 数据与同步

- Notepad 正文通过 \`baseVersion\` 使用乐观并发保存。
- Thought 保存会先更新界面，并在后台同步；离线时会进入本地 outbox，恢复网络后重试。
- AI、S3 和关系计算是后台能力；未配置时不妨碍写作和待办保存。

继续阅读“文件、图片与代码块”“数据安全与个人模式”“开发者 API 指南”“skill.md”和“发布前手动回归清单”，可以覆盖完整演示流程。`, 0),
    demoNote('demo-hybrid-editor', '混合编辑与时间图标', `# 混合编辑与时间图标

## 编辑方式

DumbPad 使用混合编辑器：可视编辑方便直接书写，源码模式保留 Markdown 的可控性，阅读模式专注浏览。

### 时间图标演示

项目创建 [[time:create:2026-07-15 09:05:00]]

第一次更新 [[time:update:2026-07-15 09:20:00]]

第二次更新 [[time:update@2:2026-07-15 09:35:00]]

- 在可视模式把任意一个时间图标拖到本列表的文字之间。
- 拖动过程中会出现落点光标，松开后图标应移动到该 Markdown 位置。
- 在源码模式可以看到时间图标的原始标记，适合验证内容没有丢失。

## 搜索与跳转

搜索“时间图标”或“Markdown”。点击结果后，编辑器会滚动到命中位置并短暂高亮。`, 5, { pinned: true }),
    demoNote('demo-assets-code', '文件、图片与代码块', `# 文件、图片与代码块

## 使用 /file 插入资源

在可视编辑模式单独输入 \`/file\` 并按 Enter，可以选择一个或多个图片、文本、PDF、压缩包等允许的文件。

- 上传期间显示文件名、大小、百分比进度条和“服务器处理中”状态。
- 普通附件显示为卡片；编辑态点击卡片可下载或删除，独占段落的附件可以拖到其他块级位置。
- 图片上传后正文只保存资源地址，不保存长串 Base64，因此大图不会拖慢整篇文章的文字编辑。
- 普通附件默认上限为 20MB；\`ASSET_MAX_FILE_BYTES\` 可以调整，但服务端硬上限为 100MB。

## 图片交互

- 阅读模式单击图片进入居中的大图视图，可以下载原图。
- 编辑模式单击图片显示尺寸、下载、全屏和删除按钮；拖动时用块级落点线选择位置。
- 原图与预览图分离：预览用于快速加载，下载仍返回未降质的原文件。

## 代码块

输入三个反引号后，如果编辑器已经渲染代码块，可以在右上角填写语言类型。长代码会在文章宽度内自动换行。

\`\`\`javascript
const features = ['line numbers', 'copy button', 'stable editing'];
console.log(features.join(', '));
\`\`\`

行号只属于阅读态和所见即所得编辑态的视觉层，不会写入 Markdown，也不会进入复制内容。阅读态和编辑态都提供复制图标，进入编辑时代码块高度保持稳定，不遮挡下一行。`, 8),
    demoNote('demo-api-guide', '开发者 API 指南', `# 开发者 API 指南

完整契约见 [api.md](../api.md) 和 \`/openapi.json\`。所有客户端都应只通过 HTTP API 操作内容，不应直接读写 \`data/\`。

## Notepad 与 Note

\`GET /api/notepads\` 返回文章元数据；\`GET /api/notes/:id\` 返回正文和版本号。

保存正文时带上当前 \`baseVersion\`：

\`POST /api/notes/:id\`

\`{ "content": "# 更新后的内容", "baseVersion": 1, "userId": "demo-client" }\`

若服务端版本更新，接口返回 \`409\` 和 \`currentVersion\`。客户端应读取最新内容并合并，而不是用旧内容强制覆盖。

## Thoughts 的高频读取与同步

- \`GET /api/thoughts?q=API&light=1\`：用于搜索候选，避免读取 AI meta。
- \`GET /api/thoughts?format=page&light=1&limit=50&updatedSince=<ms>\`：游标分页与增量同步。
- \`PATCH /api/thoughts/:id\`：每次写入携带 \`baseVersion\`，冲突同样返回 \`409\`。
- \`GET /api/search?q=乐观并发\`：搜索 Notepad 与 Thought 文本。

## 可作为 API 测试夹具的固定 ID

| 类型 | ID |
| --- | --- |
| Notepad | \`demo-api-guide\` |
| Thought | \`demo-thought-api\` |
| Thought | \`demo-thought-sync\` |
| Thought | \`demo-thought-release\` |

搜索“乐观并发”可以跳到这一段，也能验证 API 搜索索引。`, 10),
    demoNote('demo-thought-workflow', 'Thought 工作流与同步', `# Thought 工作流与同步

Thought 适合快速记录一件事，以及紧随其后的可执行子任务。

## 可体验的状态

- “阅读 API 并验证并发”是置顶 Thought，带多个子任务和标签。
- “检查离线 outbox 同步状态”用于验证保存提示、重试和 WebSocket 更新。
- “演示附件下载”包含一个很小的纯文本附件。
- “已完成的发布回归项”用于验证完成筛选与已完成样式。

## 同步可感知性

Thought 写入后界面先立即更新，再显示同步状态。其他页面或设备收到 \`thoughts_update\` 事件后应自动刷新相关内容；离线失败不会丢弃本地修改，而是进入 outbox 等待重试。

## AI 降级

AI 关联、摘要和思考扩展均为可选后台能力。未配置模型或请求失败时，Thought 的文本、标签和子任务仍可正常保存和检索。`, 15),
    demoNote('demo-data-safety', '数据安全与个人模式', `# 数据安全与个人模式

DumbPad 的首要原则是：日常记录要轻，危险操作要重，数据丢失必须有恢复路径。

## 删除与恢复

- 删除 Notepad 或 Thought 时先进入垃圾桶，不直接永久删除正文。
- 清空垃圾桶、空间切换、恢复等高风险操作必须经过后端策略校验，普通 API token 不具备存储管理权限。
- S3 运行数据、备份数据和测试数据应使用不同桶或不同 prefix，不能复用真实数据空间做测试。

## 备份

- 备份由宿主机定时执行，不由浏览器或 AI 自动操作。
- 文本和 JSON 先压缩；图片、PDF、ZIP 等已经压缩的文件保留原始字节，不降低图片质量。
- 本地与远端备份仓库各自限制为 1GiB，通过去重、每日/每周/每月保留规则控制资源消耗。
- 恢复只允许写入新的空目录或空 S3 prefix，不覆盖当前活动数据。

## 个人认证

启用 \`AUTH_V2_ENABLED\` 后，新设备使用主密码和 TOTP 登录；可信设备在会话过期后只需主密码。恢复码、可信设备撤销和 API token 都由独立安全目录管理，不进入文章数据或 S3 运行桶。

AI 可以继续分析正文和关系，但拿不到 S3 密钥、备份密钥、认证 secret，也不能调用数据管理接口。`, 17),
    demoNote('demo-agent-skill', 'skill.md', readAgentSkill(), 18, { pinned: true }),
    demoNote('demo-release-check', '发布前手动回归清单', `# 发布前手动回归清单

## Notepad

- [ ] 在可视编辑模式输入 \`/time\` 并按 Enter，确认显示时间图标。
- [ ] 拖动时间图标到普通段落、列表项和另一段文字，确认有落点光标且松手后位置正确。
- [ ] 在源码、可视和阅读模式之间切换，确认光标和视线保持在编辑位置。
- [ ] 输入 \`/file\` 并按 Enter，确认文件选择器、上传百分比和服务器处理状态出现。
- [ ] 上传一张图片和一个文本附件，检查图片尺寸/下载/全屏/删除菜单以及附件下载/删除/拖动。
- [ ] 输入三个反引号，确认代码块语言输入、行号、编辑态复制按钮和长行自动换行。
- [ ] 搜索“乐观并发”，点击结果确认跳转和关键词高亮。
- [ ] 页面滚动到中段后确认悬浮按钮方向与实际位置一致。

## Thoughts 与 API

- [ ] 新建、编辑、完成和置顶 Thought，检查保存/同步状态。
- [ ] 临时离线后编辑 Thought，再恢复网络，确认 outbox 会重试。
- [ ] 请求 \`/api/thoughts?format=page&light=1\`，确认有分页结构。
- [ ] 用过期 \`baseVersion\` 提交更新，确认返回 \`409\` 而非静默覆盖。

## 数据安全

- [ ] 删除一条测试 Thought 后从垃圾桶恢复，确认正文、标签和子任务完整。
- [ ] 检查普通内容 API token 无法访问认证与数据管理端点。
- [ ] 运行一次本地备份清单或 dry-run，确认不会覆盖活动目录。

## 已修复回归边界

普通段落 Enter 曾产生额外可编辑空段；当前使用受限软换行路径修复。不要把所有 Enter 完全交给 Vditor，也不要自动压缩用户 Markdown 中原本存在的空行。`, 20)
];

const THOUGHTS = [
    demoThought('demo-thought-api', '阅读 API 指南并验证 Notepad 乐观并发。用过期 baseVersion 保存一次，确认返回 409 而不是静默覆盖。', {
        offset: 30,
        pinned: true,
        tags: ['API', '测试夹具', '乐观并发'],
        subItems: [
            { id: 'demo-api-read', text: '打开 api.md 与 /openapi.json，对照 Notepad 和 Note 端点。', completed: true },
            { id: 'demo-api-conflict', text: '用旧 baseVersion 发送 POST /api/notes/:id，检查 409 与 currentVersion。', completed: false },
            { id: 'demo-api-search', text: '调用 /api/search?q=乐观并发，检查文章和 Thought 是否都可命中。', completed: false }
        ]
    }),
    demoThought('demo-thought-time', '输入 /time 后按 Enter，确认生成时间图标；然后在可视编辑模式中拖动图标。', {
        offset: 35,
        tags: ['时间图标', '编辑器', '回归'],
        subItems: [
            { id: 'demo-time-insert', text: '在普通段落输入 /time 并按 Enter。', completed: false },
            { id: 'demo-time-list', text: '在列表项中再次验证 /time。', completed: false },
            { id: 'demo-time-drag', text: '拖到另一段落的文字中间，观察落点光标。', completed: false }
        ]
    }),
    demoThought('demo-thought-search', '搜索“乐观并发”并点击匹配结果，验证关键词高亮、跳转位置和中文搜索。', {
        offset: 40,
        tags: ['搜索', '中文', '回归'],
        subItems: [
            { id: 'demo-search-note', text: '在文章列表搜索“拖拽”。', completed: false },
            { id: 'demo-search-thought', text: '在 Thoughts 搜索“API”。', completed: false }
        ]
    }),
    demoThought('demo-thought-editor-assets', '使用 /file 插入图片和普通附件，观察上传进度，再验证资源菜单、块级拖动和代码块语言/复制。', {
        offset: 42,
        tags: ['文件', '图片', '代码块'],
        subItems: [
            { id: 'demo-assets-progress', text: '选择一个较大文件，确认上传百分比与服务器处理状态可见。', completed: false },
            { id: 'demo-assets-image-menu', text: '编辑态点击图片，检查尺寸、下载、全屏和删除按钮。', completed: false },
            { id: 'demo-assets-file-drag', text: '把独占段落的普通附件拖到标题或列表块前后。', completed: false },
            { id: 'demo-assets-code-copy', text: '填写代码块语言并点击复制图标，确认复制内容不含行号。', completed: false }
        ]
    }),
    demoThought('demo-thought-sync', '检查离线 outbox 同步状态：断网后编辑一条 Thought，恢复网络后确认状态可见且修改被自动重试。', {
        offset: 45,
        pinned: true,
        tags: ['同步', 'Outbox', 'WebSocket'],
        subItems: [
            { id: 'demo-sync-offline', text: '在开发者工具离线模式下编辑本条 Thought。', completed: false },
            { id: 'demo-sync-retry', text: '恢复网络后点击或等待 outbox 重试。', completed: false },
            { id: 'demo-sync-other-view', text: '在另一页面确认 thoughts_update 触发内容更新。', completed: false }
        ]
    }),
    demoThought('demo-thought-relations', '打开关联面板，查看这条 Thought 与 API 回归项之间的手动关联；它不依赖 AI 配置。', {
        offset: 50,
        tags: ['关联', '手动关联', 'AI降级'],
        subItems: [
            { id: 'demo-relations-open', text: '打开关联面板，确认能看到关联的 Thought。', completed: false },
            { id: 'demo-relations-remove', text: '可尝试删除关联，再用 seed:demo 重置测试数据。', completed: false }
        ]
    }),
    demoThought('demo-thought-ai-fallback', 'AI 未配置或请求失败时，Thought 仍须立即保存，关系和洞察仅显示降级状态，不阻塞记录。', {
        offset: 55,
        tags: ['AI', '降级', '本地优先'],
        subItems: [
            { id: 'demo-ai-save', text: '不配置 AI Key 也可以新建、编辑和完成 Thought。', completed: true },
            { id: 'demo-ai-status', text: '打开 AI 状态面板，确认错误信息不会影响正文。', completed: false }
        ]
    }),
    demoThought('demo-thought-security', '检查个人数据安全边界：日常删除进入垃圾桶，备份恢复写入新目标，AI 和普通 API token 不拥有存储管理权限。', {
        offset: 58,
        tags: ['安全', '备份', '可信设备'],
        subItems: [
            { id: 'demo-security-trash', text: '删除并恢复一条测试 Thought，确认数据完整。', completed: false },
            { id: 'demo-security-backup', text: '查看 1GiB 去重备份、保留规则和恢复到新目标的配置。', completed: true },
            { id: 'demo-security-auth', text: '确认新设备需要 TOTP，可信设备日常登录只需主密码。', completed: true },
            { id: 'demo-security-ai', text: '确认 AI 工具中不存在 S3、备份或认证管理权限。', completed: true }
        ]
    }),
    demoThought('demo-thought-attachment', '演示附件下载：本条 Thought 附有一个很小的纯文本文件，用于验证附件卡片和下载行为。', {
        offset: 60,
        tags: ['附件', '交互'],
        attachments: [{
            id: 'demo-attachment-text',
            name: 'dumbpad-demo.txt',
            type: 'text/plain',
            size: 29,
            dataUrl: 'data:text/plain;base64,RHVtYlBhZCBkZW1vIGF0dGFjaG1lbnQu'
        }],
        subItems: [
            { id: 'demo-attachment-download', text: '点击附件并确认可下载 dumbpad-demo.txt。', completed: false }
        ]
    }),
    demoThought('demo-thought-pagination', '使用 format=page、light=1、limit 与 updatedSince 查询 Thoughts，验证游标分页和增量同步。', {
        offset: 65,
        tags: ['API', '分页', '同步'],
        subItems: [
            { id: 'demo-page-list', text: '请求 /api/thoughts?format=page&light=1&limit=3。', completed: false },
            { id: 'demo-page-cursor', text: '把 nextCursor 作为 cursor 请求下一页。', completed: false }
        ]
    }),
    demoThought('demo-thought-release', '已完成的发布回归项：运行静态检查、API 回归和 Thought 模块测试。', {
        offset: 70,
        updatedOffset: 75,
        completed: true,
        tags: ['发布', '已完成', '回归'],
        subItems: [
            { id: 'demo-release-check', text: 'npm run check', completed: true },
            { id: 'demo-release-api', text: 'npm run test:api', completed: true },
            { id: 'demo-release-thoughts', text: 'npm run test:thought-modules', completed: true }
        ]
    }),
    demoThought('demo-thought-known-bug', '历史回归：可视编辑器普通 Enter 曾产生可编辑空段，当前已通过受限软换行路径修复；不要改为完全交给 Vditor 或直接清理已有 Markdown 空行。', {
        offset: 80,
        completed: true,
        tags: ['已修复', '编辑器', '历史回归'],
        subItems: [
            { id: 'demo-enter-doc', text: 'README 与技术概览已记录修复边界和回归测试。', completed: true },
            { id: 'demo-enter-test', text: '运行 npm run test:hybrid-editor-time-command。', completed: true }
        ]
    })
];

function relation(ownerId, targetId, relationType, reason) {
    return {
        id: ownerId,
        version: 2,
        computedAt: timestamp(90),
        edges: [{
            targetId,
            score: 1,
            confidence: 1,
            relationType,
            method: 'manual',
            source: 'manual',
            reasons: [reason],
            signals: { manual: 1 },
            createdAt: timestamp(90)
        }],
        suggestions: []
    };
}

const RELATIONS = [
    relation('demo-thought-api', 'demo-thought-relations', 'related_context', '两条 Thought 都用于演示 API 与手动关联。'),
    relation('demo-thought-relations', 'demo-thought-api', 'related_context', '从关联面板可以跳转到 API 回归 Thought。'),
    relation('demo-thought-time', 'demo-thought-release', 'step_sequence', '时间图标验证是发布前手动回归的一部分。'),
    relation('demo-thought-release', 'demo-thought-time', 'step_sequence', '发布回归清单包含时间图标验证。'),
    relation('demo-thought-editor-assets', 'demo-thought-release', 'step_sequence', '文件、图片和代码块验证属于发布前编辑器回归。'),
    relation('demo-thought-security', 'demo-thought-ai-fallback', 'related_context', 'AI 降级与权限隔离共同保证记录能力不阻塞且不越权。')
];

function parseArgs(argv = process.argv.slice(2)) {
    return {
        reset: argv.includes('--reset'),
        merge: argv.includes('--merge')
    };
}

function isManagedDemoId(id) {
    const value = String(id || '');
    return value === 'default' || value.startsWith('demo-');
}

function mergeDemoRecord(template, previous, now) {
    if (!previous) return template;
    return {
        ...template,
        version: Math.max(Number(template.version) || 1, (Number(previous.version) || 0) + 1),
        createdAt: Number(previous.createdAt) || template.createdAt,
        updatedAt: now
    };
}

async function resetLocalData() {
    const dataDir = path.resolve(storage.paths.DATA_DIR);
    if (path.basename(dataDir).toLowerCase() !== 'data') {
        throw new Error(`Refusing to reset a directory not named data: ${dataDir}`);
    }
    await fs.rm(dataDir, { recursive: true, force: true });
}

async function mergeLocalDemoData() {
    await storage.init();
    const now = Date.now();
    const currentMeta = await storage.readNotepadsMeta();
    const existingNotepads = Array.isArray(currentMeta?.notepads) ? currentMeta.notepads : [];
    const existingNotepadById = new Map(existingNotepads.map(item => [item.id, item]));
    const mergedNotes = NOTES.map(note => mergeDemoRecord(note, existingNotepadById.get(note.id), now));
    const preservedNotepads = existingNotepads.filter(item => !isManagedDemoId(item.id));

    await storage.saveNotepadsMeta({
        notepads: [
            ...mergedNotes.map(({ content, ...notepad }) => notepad),
            ...preservedNotepads
        ]
    });
    for (const note of mergedNotes) {
        await storage.writeNoteContent(note, note.content);
    }

    const existingThoughts = await storage.readThoughts();
    const existingThoughtById = new Map(existingThoughts.map(item => [item.id, item]));
    const mergedThoughts = THOUGHTS.map(item => mergeDemoRecord(item, existingThoughtById.get(item.id), now));
    const preservedThoughts = existingThoughts.filter(item => !isManagedDemoId(item.id));
    await storage.saveThoughts([...mergedThoughts, ...preservedThoughts]);

    for (const item of RELATIONS) {
        await storage.writeRelations(item.id, { ...item, computedAt: now });
    }
    await storage.rebuildIndexes();

    return {
        mode: 'merge',
        backend: storage.backend,
        layout: storage.layout,
        dataDir: storage.paths.DATA_DIR,
        notepads: mergedNotes.length,
        thoughts: mergedThoughts.length,
        relationFiles: RELATIONS.length,
        preservedNotepads: preservedNotepads.length,
        preservedThoughts: preservedThoughts.length
    };
}

async function seedDemoData({ reset = false, merge = false } = {}) {
    if (storage.backend !== 'local') {
        throw new Error(`Demo data can only be seeded on the local backend; current backend is ${storage.backend}.`);
    }
    if (reset && merge) {
        throw new Error('Choose either --reset or --merge, not both.');
    }
    if (merge) return mergeLocalDemoData();
    if (!reset) {
        throw new Error('Choose --reset for a clean demo dataset or --merge to preserve non-demo local data.');
    }

    await resetLocalData();
    await storage.init();

    const notepads = NOTES.map(({ content, ...notepad }) => notepad);
    await storage.saveNotepadsMeta({ notepads });
    for (const note of NOTES) {
        await storage.writeNoteContent(note, note.content);
    }

    await storage.saveThoughts(THOUGHTS);
    for (const item of RELATIONS) {
        await storage.writeRelations(item.id, item);
    }
    await storage.rebuildIndexes();

    return {
        backend: storage.backend,
        layout: storage.layout,
        dataDir: storage.paths.DATA_DIR,
        notepads: notepads.length,
        thoughts: THOUGHTS.length,
        relationFiles: RELATIONS.length
    };
}

if (require.main === module) {
    seedDemoData(parseArgs())
        .then(summary => console.log(JSON.stringify({ success: true, ...summary }, null, 2)))
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {
    NOTES,
    THOUGHTS,
    isManagedDemoId,
    mergeDemoRecord,
    seedDemoData
};
