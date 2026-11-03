// Thought 列表/跳转响应里的附件载荷契约。
//
// 背景：附件可以以 base64 dataUrl 内联存储在 Thought 里（非图片文件默认就是
// 这样，上限 4MB → base64 后约 5.3MB）。线上实测：一条带 3.2MB PDF 的 Thought
// 让列表响应变成 4.3MB / 10s、按 id 跳转 4.3MB / 15s。因此：
//   1) light=1 的列表与 ?light=1 的详情只回元数据 + 按需下载 URL；
//   2) 完整详情仍回 dataUrl（下载/离线回放依赖它）；
//   3) 新端点按需吐出字节；
//   4) 客户端把「引用形态」的附件整体提交回来时，服务端必须保留内联载荷。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4391;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const ATTACHMENT_TEXT = 'hello-inline-attachment';
const ATTACHMENT_DATA_URL = `data:text/plain;base64,${Buffer.from(ATTACHMENT_TEXT).toString('base64')}`;
const THOUGHT_ID = 'att-thought-1';
const ATTACHMENT_ID = 'att-1';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function prepareDataDir() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-att-'));
    fs.mkdirSync(path.join(dataDir, 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'notepads.json'), JSON.stringify({
        notepads: [{ id: 'default', name: 'Default', file: 'default.txt', createdAt: Date.now() }],
        currentNotepadId: 'default'
    }));
    fs.writeFileSync(path.join(dataDir, 'default.txt'), 'Default content');
    fs.writeFileSync(path.join(dataDir, 'today-drafts.json'), '[]');
    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), JSON.stringify([
        {
            id: THOUGHT_ID,
            text: '带内联附件的想法',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [{
                id: ATTACHMENT_ID,
                name: 'note.txt',
                type: 'text/plain',
                size: ATTACHMENT_TEXT.length,
                dataUrl: ATTACHMENT_DATA_URL
            }],
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
            version: 1
        },
        {
            id: 'att-thought-2',
            text: '普通想法',
            subItems: [],
            tags: [],
            completed: false,
            pinned: false,
            attachments: [],
            createdAt: 1700000001000,
            updatedAt: 1700000001000,
            version: 1
        }
    ]));
    return dataDir;
}

function startServer(dataDir) {
    return spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            BASE_URL,
            DATA_DIR: dataDir,
            STORAGE_BACKEND: 'local',
            STORAGE_LAYOUT: 'legacy',
            DUMBPAD_PIN: '',
            AI_API_KEY: '',
            AI_INSIGHT_API_KEY: '',
            AI_INSIGHT_MODEL: '',
            AI_EMBEDDING_API_KEY: '',
            NODE_ENV: 'development'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

async function request(route, options = {}) {
    const response = await fetch(`${BASE_URL}${route}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    let body = null;
    if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
    }
    return { response, body, text };
}

async function waitForServer(child) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
        try {
            const { response } = await request('/health');
            if (response.ok) return;
        } catch (_error) {
            // not up yet
        }
        await sleep(200);
    }
    throw new Error('Timed out waiting for test server');
}

async function run() {
    const dataDir = prepareDataDir();
    const child = startServer(dataDir);
    const logs = [];
    child.stdout.on('data', chunk => logs.push(String(chunk)));
    child.stderr.on('data', chunk => logs.push(String(chunk)));

    try {
        await waitForServer(child);

        // 1. 列表（light）不得携带内联载荷，必须给出按需 URL
        let result = await request('/api/thoughts?format=page&sort=timeline&limit=30&light=1');
        assert(result.response.ok, 'list should succeed');
        const items = result.body.items || [];
        const target = items.find(item => item.id === THOUGHT_ID);
        assert(target, 'list should include the thought with an inline attachment');
        const listed = target.attachments[0];
        assert.strictEqual(listed.dataUrl, undefined, 'light list must not ship the inline dataUrl');
        assert.strictEqual(listed.url, `/api/thoughts/${THOUGHT_ID}/attachments/${ATTACHMENT_ID}?v=1`, 'light list must expose the versioned on-demand url');
        assert.strictEqual(listed.name, 'note.txt', 'attachment metadata is preserved');
        assert.strictEqual(listed.size, ATTACHMENT_TEXT.length, 'attachment size is preserved');
        assert(result.text.length < 2000, `light list payload must stay small (got ${result.text.length} bytes)`);

        // 2. 完整详情仍带 dataUrl（下载/离线回放依赖它）
        result = await request(`/api/thoughts/${THOUGHT_ID}`);
        assert(result.response.ok, 'detail should succeed');
        assert.strictEqual(result.body.attachments[0].dataUrl, ATTACHMENT_DATA_URL, 'full detail keeps the inline payload');

        // 3. 跳转用的 ?light=1 详情同样剥掉载荷
        result = await request(`/api/thoughts/${THOUGHT_ID}?light=1`);
        assert(result.response.ok, 'light detail should succeed');
        assert.strictEqual(result.body.attachments[0].dataUrl, undefined, 'light detail must not ship the inline dataUrl');
        assert.strictEqual(result.body.attachments[0].url, `/api/thoughts/${THOUGHT_ID}/attachments/${ATTACHMENT_ID}?v=1`);
        assert.strictEqual(result.body.text, '带内联附件的想法', 'light detail keeps the card text');
        assert(result.text.length < 1000, `light detail payload must stay small (got ${result.text.length} bytes)`);

        // 4. 按需下载端点吐出原始字节
        result = await request(`/api/thoughts/${THOUGHT_ID}/attachments/${ATTACHMENT_ID}`);
        assert(result.response.ok, 'attachment endpoint should succeed');
        assert.strictEqual(result.text, ATTACHMENT_TEXT, 'attachment bytes are served as-is');
        assert(/text\/plain/.test(result.response.headers.get('content-type') || ''), 'content-type comes from the attachment');
        assert(/attachment;/.test(result.response.headers.get('content-disposition') || ''), 'non-image attachments download with their name');

        result = await request(`/api/thoughts/${THOUGHT_ID}/attachments/missing`);
        assert.strictEqual(result.response.status, 404, 'unknown attachment id is a 404');

        // 5. 客户端把引用形态整体提交回来时，服务端必须保留内联载荷
        result = await request(`/api/thoughts/${THOUGHT_ID}`, {
            method: 'PATCH',
            body: JSON.stringify({
                action: 'overwrite',
                text: '带内联附件的想法',
                subItems: [],
                tags: [],
                attachments: [{ id: ATTACHMENT_ID, name: 'note.txt', type: 'text/plain', size: ATTACHMENT_TEXT.length, url: `/api/thoughts/${THOUGHT_ID}/attachments/${ATTACHMENT_ID}?v=1` }],
                baseVersion: 1
            })
        });
        assert(result.response.ok, `overwrite with a reference must succeed (got ${result.response.status})`);
        result = await request(`/api/thoughts/${THOUGHT_ID}`);
        assert.strictEqual(
            result.body.attachments[0].dataUrl,
            ATTACHMENT_DATA_URL,
            'a reference-shaped attachment round-trip must not wipe the stored payload'
        );
        assert.strictEqual(result.body.attachments[0].url, undefined, 'the derived url is not persisted');

        // 6. 客户端接线：渲染/下载用 url 兜底，跳转走 light
        const rendererSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-card-renderer.js'), 'utf8');
        assert(
            /getAttachmentPreviewUrl[\s\S]{0,220}previewUrl \|\| attachment\.url \|\| attachment\.dataUrl/.test(rendererSource),
            'card preview must fall back to the on-demand url'
        );
        assert(
            /getAttachmentDownloadUrl[\s\S]{0,220}downloadUrl \|\| attachment\.originalUrl \|\| attachment\.url \|\| attachment\.dataUrl/.test(rendererSource),
            'card download must fall back to the on-demand url'
        );
        const apiSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thought-api-client.js'), 'utf8');
        assert(/get\(id, \{ light = false \} = \{\}\)/.test(apiSource), 'ThoughtApiClient.get must accept the light option');
        const thoughtsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
        assert(
            /apiClient\.get\(id, \{ light: true \}\)/.test(thoughtsSource),
            'the jump must fetch the light Thought'
        );
        assert(
            /_scheduleRestOfFirstPage\(renderSeq\)/.test(thoughtsSource),
            'render must paint the first cards immediately and fill the rest asynchronously'
        );

        console.log('Thought attachment payload checks passed');
    } catch (error) {
        if (logs.length) console.error(logs.join(''));
        throw error;
    } finally {
        child.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
