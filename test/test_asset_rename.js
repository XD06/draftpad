/**
 * 附件重命名全链路与引用插入回归测试：
 * - normalizeRenamedFilename 扩展名安全校验与兼容文本类型同步
 * - PATCH /api/assets/:id（400/404/409、syncReferences、download no-store 缓存、Notepad Markdown 与 Thought 同步、WS/索引副作用）
 * - Tiptap insertArticleAssetReference 对 image/video/audio/file 在富文本与源码模式下的插入
 * - 共享重命名弹窗 openAttachmentRenameDialog 交互与媒体 NodeView 重命名入口
 */
'use strict';

const assert = require('assert');
const express = require('express');
const fsSync = require('fs');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

async function runBackendTests(dataDir) {
    process.env.DATA_DIR = dataDir;
    const storage = require('../scripts/storage');
    const { normalizeRenamedFilename } = require('../scripts/asset-rename-service');
    const { registerAssetRoutes } = require('../routes/asset-routes');

    // 1. normalizeRenamedFilename 规则矩阵
    assert.strictEqual(normalizeRenamedFilename({ requestedName: '   ', currentName: 'a.png', kind: 'image', mimeType: 'image/png' }).status, 400);
    assert.strictEqual(
        normalizeRenamedFilename({ requestedName: '封面', currentName: 'photo.png', kind: 'image', mimeType: 'image/png' }).name,
        '封面.png',
        'omitted extension must preserve current image extension'
    );
    assert.strictEqual(
        normalizeRenamedFilename({ requestedName: 'hero.jpeg', currentName: 'hero.jpg', kind: 'image', mimeType: 'image/jpeg' }).name,
        'hero.jpeg',
        'jpeg <-> jpg alias swap is allowed'
    );
    assert.strictEqual(
        normalizeRenamedFilename({ requestedName: 'hero.jpg', currentName: 'hero.png', kind: 'image', mimeType: 'image/png' }).status,
        400,
        'cross-format image extension swap must be rejected'
    );
    assert.strictEqual(
        normalizeRenamedFilename({ requestedName: 'evil.exe', currentName: 'readme.txt', kind: 'file', mimeType: 'text/plain' }).status,
        400,
        'non-whitelisted file extension must be rejected'
    );
    assert.strictEqual(
        normalizeRenamedFilename({ requestedName: 'doc.txt', currentName: 'spec.pdf', kind: 'file', mimeType: 'application/pdf' }).status,
        400,
        'incompatible binary -> text extension swap must be rejected'
    );
    const mdSwap = normalizeRenamedFilename({
        requestedName: 'guide.md',
        currentName: 'readme.txt',
        kind: 'file',
        mimeType: 'text/plain'
    });
    assert.strictEqual(mdSwap.ok, true);
    assert.strictEqual(mdSwap.name, 'guide.md');
    assert.strictEqual(mdSwap.type, 'text/markdown', 'compatible text swap must update MIME type');

    const slashCleaned = normalizeRenamedFilename({
        requestedName: 'a/b:c',
        currentName: 'note.txt',
        kind: 'file',
        mimeType: 'text/plain'
    });
    assert.strictEqual(slashCleaned.name, 'a_b_c.txt', 'unsafe filename chars should be sanitized');

    // 2. 启动带真实 storage + mock broadcasts 的 Express 服务
    const broadcasts = [];
    const wsMessages = [];
    let indexCalls = 0;

    const app = express();
    registerAssetRoutes(app, {
        storage,
        originValidationMiddleware: (_req, _res, next) => next(),
        broadcastUpdate: (noteId, content, sender, version, meta) => broadcasts.push({ noteId, content, sender, version, meta }),
        broadcastWebSocketMessage: (msg) => wsMessages.push(msg),
        scheduleIndexNotepads: () => { indexCalls += 1; }
    });

    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
        const { port } = server.address();
        const baseUrl = `http://127.0.0.1:${port}`;

        const pngBuf = await sharp({
            create: { width: 16, height: 16, channels: 3, background: '#e5a100' }
        }).png().toBuffer();

        const imgRes = await fetch(`${baseUrl}/api/assets/images`, {
            method: 'POST',
            headers: { 'content-type': 'image/png', 'x-asset-name': encodeURIComponent('avatar.png') },
            body: pngBuf
        });
        assert.strictEqual(imgRes.status, 201);
        const imgAsset = await imgRes.json();

        const txtRes = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-type': 'text/plain',
                'x-asset-name': encodeURIComponent('readme.txt')
            },
            body: Buffer.from('hello world', 'utf8')
        });
        assert.strictEqual(txtRes.status, 201);
        const txtAsset = await txtRes.json();

        const otherRes = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-type': 'text/plain',
                'x-asset-name': encodeURIComponent('other.txt')
            },
            body: Buffer.from('other content', 'utf8')
        });
        assert.strictEqual(otherRes.status, 201);
        const otherAsset = await otherRes.json();

        const mp4Buf = Buffer.concat([
            Buffer.from([0x00, 0x00, 0x00, 0x18]),
            Buffer.from('ftypmp42'),
            Buffer.from([0x00, 0x00, 0x00, 0x00]),
            Buffer.from('mp42isom')
        ]);
        const mp4Res = await fetch(`${baseUrl}/api/assets/files`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-asset-type': 'video/mp4',
                'x-asset-name': encodeURIComponent('clip.mp4')
            },
            body: mp4Buf
        });
        assert.strictEqual(mp4Res.status, 201);
        const mp4Asset = await mp4Res.json();

        const noteMeta = {
            id: 'note-rename-1',
            name: '资产引用测试',
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await storage.saveNotepadsMeta({ notepads: [noteMeta] });
        await storage.writeNoteContent(noteMeta, [
            `![avatar.png](${imgAsset.previewUrl}?w=120 "dumbpad-width=320")`,
            `[readme.txt · 11 B](${txtAsset.downloadUrl} "dumbpad-file=1;size=11;type=text%2Fplain;name=readme.txt")`,
            `[readme.txt · 11 B](${txtAsset.downloadUrl})`,
            `![clip.mp4 · ${mp4Buf.length} B](${mp4Asset.originalUrl} "dumbpad-video=1;size=${mp4Buf.length};type=video%2Fmp4;name=clip.mp4")`,
            `[other.txt · 13 B](${otherAsset.downloadUrl} "dumbpad-file=1;size=13;type=text%2Fplain;name=other.txt")`
        ].join('\n\n'));

        await storage.writeThought({
            id: 'thought-rename-1',
            text: '关联测试想法',
            attachments: [
                {
                    assetId: txtAsset.id,
                    name: 'readme.txt',
                    type: 'text/plain',
                    size: 11,
                    downloadUrl: txtAsset.downloadUrl
                },
                {
                    assetId: otherAsset.id,
                    name: 'other.txt',
                    type: 'text/plain',
                    size: 13,
                    downloadUrl: otherAsset.downloadUrl
                }
            ],
            createdAt: Date.now(),
            updatedAt: Date.now()
        });

        // 同类型文本改名并同步跨文档引用
        const renameTxt = await fetch(`${baseUrl}/api/assets/${txtAsset.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'guide.md', userId: 'tester-1' })
        });
        assert.strictEqual(renameTxt.status, 200);
        const renameTxtPayload = await renameTxt.json();
        assert.strictEqual(renameTxtPayload.success, true);
        assert.strictEqual(renameTxtPayload.unchanged, false);
        assert.strictEqual(renameTxtPayload.asset.name, 'guide.md');
        assert.strictEqual(renameTxtPayload.asset.type, 'text/markdown');
        assert.deepStrictEqual(renameTxtPayload.updatedNotes, [{ id: 'note-rename-1', version: 2 }]);
        assert.deepStrictEqual(renameTxtPayload.updatedNoteIds, ['note-rename-1']);
        assert.deepStrictEqual(renameTxtPayload.updatedThoughtIds, ['thought-rename-1']);

        const dlAfterRename = await fetch(`${baseUrl}${txtAsset.downloadUrl}`);
        assert.strictEqual(dlAfterRename.headers.get('cache-control'), 'no-store, private',
            '/download must disable immutable caching so renamed filenames take effect immediately');
        assert.match(dlAfterRename.headers.get('content-disposition') || '', /guide\.md/);

        const updatedNoteMd = await storage.readNoteContent(noteMeta);
        assert.ok(updatedNoteMd.includes(`[guide.md · 11 B](${txtAsset.downloadUrl} "dumbpad-file=1;size=11;type=text%2Fmarkdown;name=guide.md")`),
            'file chip must update display label, MIME, and encoded name');
        assert.ok(updatedNoteMd.includes(`[guide.md · 11 B](${txtAsset.downloadUrl})\n`),
            'bare /download link must update display text');
        assert.ok(updatedNoteMd.includes('other.txt'), 'unrelated asset reference must stay intact');

        const thoughtOnDisk = (await storage.readThoughts()).find(t => t.id === 'thought-rename-1');
        assert.strictEqual(thoughtOnDisk.attachments[0].name, 'guide.md');
        assert.strictEqual(thoughtOnDisk.attachments[0].type, 'text/markdown');
        assert.strictEqual(thoughtOnDisk.attachments[1].name, 'other.txt');

        assert.ok(broadcasts.some(b => b.noteId === 'note-rename-1' && b.version === 2 && b.meta?.source === 'asset_rename'));
        assert.ok(wsMessages.some(m => m.type === 'thoughts_update' && m.action === 'update' && m.payload?.id === 'thought-rename-1'));
        assert.ok(indexCalls >= 1, 'rename sync must schedule search re-index');

        // 省略扩展名重命名图片 + 保留宽度 title + /original immutable vs /download no-store
        const renameImg = await fetch(`${baseUrl}/api/assets/${imgAsset.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'cover' })
        });
        assert.strictEqual(renameImg.status, 200);
        const renameImgPayload = await renameImg.json();
        assert.strictEqual(renameImgPayload.asset.name, 'cover.png');
        const noteAfterImg = await storage.readNoteContent(noteMeta);
        assert.ok(noteAfterImg.includes(`![cover.png](${imgAsset.previewUrl}?w=120 "dumbpad-width=320")`),
            'image rename must update alt text while keeping query & width title');

        const origImgRes = await fetch(`${baseUrl}${imgAsset.originalUrl}`);
        assert.match(origImgRes.headers.get('cache-control') || '', /immutable/);
        const dlImgRes = await fetch(`${baseUrl}${imgAsset.downloadUrl}`);
        assert.strictEqual(dlImgRes.headers.get('cache-control'), 'no-store, private');
        assert.match(dlImgRes.headers.get('content-disposition') || '', /cover\.png/);

        // 图片改名更换格式 -> 400
        const badImgSwap = await fetch(`${baseUrl}/api/assets/${imgAsset.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'cover.jpg' })
        });
        assert.strictEqual(badImgSwap.status, 400);

        // 同类重名冲突 -> 409
        const duplicateName = await fetch(`${baseUrl}/api/assets/${txtAsset.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'other.txt' })
        });
        assert.strictEqual(duplicateName.status, 409);
        assert.strictEqual((await duplicateName.json()).code, 'DUPLICATE_ASSET_NAME');

        // 同名 no-op
        const noopRename = await fetch(`${baseUrl}/api/assets/${txtAsset.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'guide.md' })
        });
        assert.strictEqual(noopRename.status, 200);
        const noopPayload = await noopRename.json();
        assert.strictEqual(noopPayload.unchanged, true);
        assert.deepStrictEqual(noopPayload.updatedNotes, []);

        // syncReferences: false 仅改元数据，不碰正文
        const unsyncedRename = await fetch(`${baseUrl}/api/assets/${mp4Asset.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'demo-reel', syncReferences: false })
        });
        assert.strictEqual(unsyncedRename.status, 200);
        const unsyncedPayload = await unsyncedRename.json();
        assert.strictEqual(unsyncedPayload.asset.name, 'demo-reel.mp4');
        assert.deepStrictEqual(unsyncedPayload.updatedNotes, []);
        const noteAfterUnsynced = await storage.readNoteContent(noteMeta);
        assert.ok(noteAfterUnsynced.includes('clip.mp4'), 'syncReferences=false must not rewrite article references');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
    console.log('PASS backend asset rename & cross-doc sync checks');
}

async function runFrontendTests() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.Node = dom.window.Node;
    global.NodeFilter = dom.window.NodeFilter;
    global.Element = dom.window.Element;
    global.HTMLElement = dom.window.HTMLElement;
    global.Range = dom.window.Range;
    global.KeyboardEvent = dom.window.KeyboardEvent;
    global.MouseEvent = dom.window.MouseEvent;
    global.CustomEvent = dom.window.CustomEvent;
    global.getSelection = dom.window.getSelection.bind(dom.window);
    Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
    dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    global.requestAnimationFrame = dom.window.requestAnimationFrame;
    dom.window.Element.prototype.scrollIntoView = dom.window.Element.prototype.scrollIntoView || (() => {});
    dom.window.Range.prototype.getClientRects = dom.window.Range.prototype.getClientRects
        || (() => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }));
    dom.window.Range.prototype.getBoundingClientRect = dom.window.Range.prototype.getBoundingClientRect
        || (() => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }));
    dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    vm.runInThisContext(fsSync.readFileSync(path.join(ROOT, 'public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const { openAttachmentRenamePopover } = await import('../public/managers/attachment-rename-dialog.js');

    // 1. Tiptap insertArticleAssetReference 支持 previewUrl/originalUrl/downloadUrl 全类型
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();

    editor.setValue('', false);
    assert.strictEqual(editor.insertArticleAssetReference({
        id: 'img1',
        kind: 'image',
        name: 'hero.png',
        type: 'image/png',
        previewUrl: '/api/assets/img1/preview'
    }), true);
    assert.ok(editor.getValue().includes('![hero.png](/api/assets/img1/preview "dumbpad-width='), 'image embed should use previewUrl');

    editor.setValue('', false);
    assert.strictEqual(editor.insertArticleAssetReference({
        id: 'vid1',
        kind: 'file',
        name: 'demo.mp4',
        type: 'video/mp4',
        originalUrl: '/api/assets/vid1/original',
        size: 2048
    }), true);
    assert.ok(editor.getValue().includes('dumbpad-video=1'), 'video file should insert articleMedia markdown');
    assert.ok(Boolean(container.querySelector('.dumbpad-article-media-rename')), 'article media card should render rename button');

    editor.setValue('', false);
    assert.strictEqual(editor.insertArticleAssetReference({
        id: 'aud1',
        kind: 'file',
        name: 'voice.mp3',
        type: 'audio/mpeg',
        originalUrl: '/api/assets/aud1/original',
        size: 512
    }), true);
    assert.ok(editor.getValue().includes('dumbpad-audio=1'), 'audio file should insert articleMedia markdown');

    editor.setValue('', false);
    assert.strictEqual(editor.insertArticleAssetReference({
        id: 'doc1',
        kind: 'file',
        name: 'spec.pdf',
        type: 'application/pdf',
        downloadUrl: '/api/assets/doc1/download',
        size: 4096
    }), true);
    assert.ok(editor.getValue().includes('[spec.pdf · 4.0 KB](/api/assets/doc1/download "dumbpad-file=1;'),
        'ordinary file should insert dumbpad-file chip');

    // 源码模式插入
    editor.setValue('起始行\n', false);
    editor.setSourceMode(true);
    const textarea = editor.getSourceTextarea();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    assert.strictEqual(editor.insertArticleAssetReference({
        id: 'img2',
        kind: 'image',
        name: 'snap.png',
        type: 'image/png',
        previewUrl: '/api/assets/img2/preview'
    }), true);
    assert.ok(textarea.value.includes('![snap.png](/api/assets/img2/preview "dumbpad-width='), 'source mode insert must emit markdown');
    editor.setSourceMode(false);
    editor.editor?.destroy?.();

    // 2. openAttachmentRenamePopover 全场景无遮罩锚点微气泡（零布局位移）
    const anchorHost = document.createElement('div');
    anchorHost.className = 'settings-asset-name-row';
    anchorHost.innerHTML = '<span class="settings-asset-name">report.txt</span>';
    const penBtn = document.createElement('button');
    penBtn.type = 'button';
    penBtn.className = 'settings-asset-rename-btn';
    anchorHost.appendChild(penBtn);
    document.body.appendChild(anchorHost);

    let submitCount = 0;
    const popPromise = openAttachmentRenamePopover({
        anchorEl: penBtn,
        currentName: 'report.txt',
        kind: 'file',
        mimeType: 'text/plain',
        showSyncOption: true,
        defaultSync: true,
        trigger: penBtn,
        onConfirm: async ({ name, syncReferences }) => {
            submitCount += 1;
            if (name === 'boom.txt') throw new Error('已存在同名附件');
            return { name, syncReferences };
        }
    });

    assert.strictEqual(document.getElementById('attachment-rename-modal'), null, 'heavy rename modal must not exist');
    assert.strictEqual(anchorHost.querySelector('.dumbpad-inline-rename-input'), null, 'rename UI must never mutate host card DOM');
    const popEl = document.getElementById('attachment-rename-popover');
    assert.ok(popEl && !popEl.hidden && popEl.getAttribute('aria-modal') === 'false', 'non-blocking popover opens');

    const popInput = popEl.querySelector('.dumbpad-inline-rename-input');
    const extChip = popEl.querySelector('.dumbpad-inline-ext-chip');
    const syncChip = popEl.querySelector('.dumbpad-inline-sync-chip');
    const saveBtn = popEl.querySelector('.dumbpad-rename-popover-btn.is-primary');
    const msgEl = popEl.querySelector('.dumbpad-inline-rename-msg');
    assert.strictEqual(popInput.value, 'report', 'popover input edits filename stem');
    assert.ok(extChip && extChip.textContent.includes('.txt'), 'extension chip displays current extension');

    // 空名称行内拦截
    popInput.value = '   ';
    saveBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(submitCount, 0, 'empty name fails inline without calling onConfirm');
    assert.strictEqual(msgEl.hidden, false);

    // 服务端 409 错误保留在微气泡内
    popInput.value = 'boom';
    saveBtn.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(submitCount, 1);
    assert.strictEqual(msgEl.textContent, '已存在同名附件');
    assert.strictEqual(popEl.hidden, false, 'failed confirm keeps popover open');

    // 点击兼容扩展名芯片从 .txt 切换到 .md + 切换同步开关 + 回车提交
    extChip.click();
    assert.ok(extChip.textContent.includes('.md'), 'compatible text ext chip cycles to .md');
    syncChip.click();
    popInput.value = 'final-notes';
    popInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const popResolved = await popPromise;
    assert.deepStrictEqual(popResolved, { name: 'final-notes.md', syncReferences: false });
    assert.strictEqual(popEl.hidden, true, 'popover closes cleanly after submit');

    // 捕获阶段 Escape 隔离：不能触发下层 window / overlay 的 Escape 监听
    let parentEscaped = false;
    window.addEventListener('keydown', () => { parentEscaped = true; });
    const cancelPromise = openAttachmentRenamePopover({ anchorEl: penBtn, currentName: 'pic.png', kind: 'image', mimeType: 'image/png' });
    popEl.querySelector('.dumbpad-inline-rename-input')
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.strictEqual(await cancelPromise, null);
    assert.strictEqual(parentEscaped, false, 'Escape inside rename popover must stop propagation before overlay listeners');
    assert.strictEqual(popEl.hidden, true);

    // 点外部 mousedown 自动取消
    const outsidePromise = openAttachmentRenamePopover({ anchorEl: penBtn, currentName: 'doc.pdf', kind: 'file', mimeType: 'application/pdf', showSyncOption: false });
    assert.strictEqual(popEl.querySelector('.dumbpad-inline-sync-chip'), null, 'sync pill hidden when showSyncOption=false');
    document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    assert.strictEqual(await outsidePromise, null);
    assert.strictEqual(popEl.hidden, true);

    // 3. Plan 1 琥珀微胶囊 /time 样式与前端无位移入口检查
    const mainCss = fsSync.readFileSync(path.join(ROOT, 'public/Assets/styles.css'), 'utf8');
    const thoughtsCss = fsSync.readFileSync(path.join(ROOT, 'public/Assets/thoughts.css'), 'utf8');
    const indexHtml = fsSync.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const appJsSrc = fsSync.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const modalViewerJs = fsSync.readFileSync(path.join(ROOT, 'public/managers/attachment-viewer-modal.js'), 'utf8');
    const mediaJs = fsSync.readFileSync(path.join(ROOT, 'public/managers/tiptap-media.js'), 'utf8');
    const thoughtsJsSrc = fsSync.readFileSync(path.join(ROOT, 'public/managers/thoughts.js'), 'utf8');
    assert.ok(mainCss.includes('--time-marker-accent: var(--primary-color)') && mainCss.includes('font-variant-numeric: tabular-nums'),
        'styles.css must contain Plan 1 /time rules');
    assert.ok(
        mainCss.includes('.md-time-marker.is-update.is-level-4')
        && mainCss.includes('[data-theme="dark"] .md-time-marker.is-update.is-level-4')
        && thoughtsCss.includes('.thought-time-marker.is-update.is-level-4'),
        'update level 1-4 gradients and dark overrides must be wired in both article and thought stylesheets'
    );
    // 验证与标题左对齐（align = 'start'）
    anchorHost.getBoundingClientRect = () => ({ left: 48, top: 120, right: 200, bottom: 138, width: 152, height: 18 });
    const alignPromise = openAttachmentRenamePopover({ anchorEl: anchorHost, currentName: 'doc.pdf', kind: 'file', mimeType: 'application/pdf', showSyncOption: false });
    assert.strictEqual(popEl.style.left, '48px', 'popover left edge must align with start of title');
    popEl.querySelector('.dumbpad-rename-popover-btn').click();
    await alignPromise;

    assert.ok(indexHtml.includes('id="file-title-a"') && !indexHtml.includes('id="btn-rename-a"'),
        'Scheme A modal keeps clean header and triggers rename directly on title');
    assert.ok(appJsSrc.includes('data-asset-action="rename"') && !appJsSrc.includes('settings-asset-rename-btn') && !appJsSrc.includes('class="settings-asset-rename"'),
        'settings list restores clean compact style without pencil icon or fourth button; title triggers rename');
    assert.ok(
        [appJsSrc, modalViewerJs, mediaJs, thoughtsJsSrc].every(src => src.includes('openAttachmentRenamePopover')),
        'all preview/settings/media/Thought rename triggers use floating popover without shifting card layout'
    );

    // 验证文章内图片/文件菜单的 rename 控件存在
    const imageMenuJs = fsSync.readFileSync(path.join(ROOT, 'public/managers/tiptap-image-interactions.js'), 'utf8');
    assert.ok(imageMenuJs.includes('data-image-rename') && imageMenuJs.includes('data-file-rename'),
        'image and file bubble menus must include rename actions');

    console.log('PASS frontend asset reference insert, rename dialog & /time style checks');
}

let completedAllTests = false;
process.on('beforeExit', () => {
    if (!completedAllTests) {
        console.error('FAIL test_asset_rename exited with unsettled promise before completion');
        process.exit(1);
    }
});

async function main() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dumbpad-asset-rename-'));
    try {
        await runBackendTests(dataDir);
        await runFrontendTests();
        completedAllTests = true;
        console.log('\nALL PASS');
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
