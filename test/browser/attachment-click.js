/**
 * 附件点击回归（真实浏览器）：编辑模式点附件 chip 只能弹菜单，不得触发任何下载
 * 或 window.open；下载只发生在菜单的「下载附件」里；阅读模式仍由浏览器直接下载。
 * 覆盖 Tiptap Link 的 PM handleClick 路径（jsdom 走不到鼠标管线，故必须真浏览器）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ASSET_ID = '0123456789abcdef0123456789abcdef';
const DOWNLOAD = `/api/assets/${ASSET_ID}/download`;
const FILE_MD = `[报告.pdf · 1.2 MB](${DOWNLOAD} "dumbpad-file=1;size=1258291;type=application%2Fpdf")`;
const BARE_URL = 'https://example.com/a';
const NORMAL_URL = 'https://example.com/b';
const FIXTURE = [
    FILE_MD,
    `[${BARE_URL}](${BARE_URL})`,
    `[普通链接](${NORMAL_URL})`,
    '正文一段文字。',
].join('\n\n') + '\n';

module.exports = async function testAttachmentClick(browser) {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head>
        <link rel="stylesheet" href="/Assets/styles.css">
        <style>body{margin:0}#editor{height:600px}</style>
        </head><body><div id="editor"></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    // 真实 Content-Disposition：下载是否发生以浏览器的 download 事件为准。
    app.get('/api/assets/:id/download', (_req, res) => {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
        res.send('%PDF-1.4\n% attachment click regression\n');
    });
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
    app.use('/js/marked', express.static(path.join(root, 'node_modules/marked/lib')));
    app.use(express.static(path.join(root, 'public')));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    const context = await browser.newContext({ acceptDownloads: true, hasTouch: true, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    let downloads = [];
    let popups = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('download', download => downloads.push(download.url()));
    context.on('page', popup => {
        popups.push(popup.url());
        popup.on('download', download => downloads.push(download.url()));
    });

    const reset = () => page.evaluate(() => { window.__open = []; });
    const read = () => page.evaluate(() => ({
        open: window.__open.slice(),
        menus: [...document.querySelectorAll('.article-file-menu, .article-image-size-menu')]
            .filter(menu => !menu.hidden).map(menu => menu.className),
        value: editor.getValue(),
    }));
    const centerOf = selector => page.evaluate((sel) => {
        const el = document.querySelector(sel) || editor.container.querySelector(sel);
        if (!el) throw new Error(`missing element: ${sel}`);
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, selector);

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(async (fixture) => {
            const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
            window.editor = new HybridMarkdownEditor(document.querySelector('#editor'));
            await editor.whenReady();
            editor.setValue(fixture, false);
            await new Promise(resolve => setTimeout(resolve, 400));
            // 记录 window.open：Tiptap Link 的 PM handleClick 就是这么把 /download 变成下载的。
            const nativeOpen = window.open;
            window.__open = [];
            window.open = function (...args) { window.__open.push(args); return undefined; };
            void nativeOpen;
        }, FIXTURE);

        assert(await page.evaluate(() => Boolean(editor.container.querySelector('a.dumbpad-article-file'))),
            'attachment renders as a chip anchor');

        // 1) 编辑模式点击附件：只弹菜单，不 window.open、不下载。
        await reset();
        downloads = []; popups = [];
        const chip = await centerOf('a.dumbpad-article-file');
        await page.mouse.click(chip.x, chip.y);
        await page.waitForTimeout(400);
        const afterChip = await read();
        assert.deepEqual(afterChip.open, [], 'clicking the attachment must not call window.open (Tiptap Link openOnClick must stay off)');
        assert.deepEqual(downloads, [], 'clicking the attachment must not download in edit mode');
        assert.deepEqual(popups, [], 'clicking the attachment must not open a popup tab');
        assert.deepEqual(afterChip.menus, ['article-file-menu'], 'exactly the attachment menu opens');
        assert.equal(afterChip.value.includes(FILE_MD), true, 'attachment markdown untouched by the click');

        // 2) 菜单里的「下载附件」才下载。
        await reset();
        downloads = []; popups = [];
        const menuDownload = await centerOf('.article-file-menu [data-file-download]');
        await page.mouse.click(menuDownload.x, menuDownload.y);
        await page.waitForTimeout(600);
        assert.equal(downloads.length, 1, `menu download must download exactly once (${downloads.length})`);
        assert.match(downloads[0], /\/api\/assets\/[a-f0-9]+\/download$/);
        assert.deepEqual((await read()).open, [], 'menu download must not go through window.open');

        // 3) 菜单里的「删除附件」删除，且可撤销。
        await reset();
        downloads = []; popups = [];
        await page.mouse.click(chip.x, chip.y);
        await page.waitForTimeout(250);
        const menuDelete = await centerOf('.article-file-menu [data-file-delete]');
        await page.mouse.click(menuDelete.x, menuDelete.y);
        await page.waitForTimeout(300);
        const afterDelete = await read();
        assert.equal(afterDelete.value.includes(FILE_MD), false, 'delete attachment removes the link');
        assert.deepEqual(afterDelete.menus, [], 'menu closes after the delete action');
        assert.deepEqual(downloads, [], 'deleting an attachment must not download');
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(400);
        assert.equal((await read()).value.includes(FILE_MD), true, 'delete attachment is undoable');

        // 4) 编辑模式点裸 URL（文本 == href）仍可打开，且只开一次。
        await reset();
        downloads = []; popups = [];
        const bare = await centerOf(`a[href="${BARE_URL}"]`);
        await page.mouse.click(bare.x, bare.y);
        await page.waitForTimeout(300);
        const afterBare = await read();
        assert.equal(afterBare.open.length, 1, 'bare URL click opens once');
        assert.equal(afterBare.open[0][0], BARE_URL, `bare URL opens its own href (${JSON.stringify(afterBare.open)})`);
        assert.deepEqual(afterBare.menus, [], 'bare URL click opens no attachment menu');
        assert.deepEqual(downloads, [], 'bare URL click must not download');

        // 5) 编辑模式点 [文本](url) 不打开（旧 Vditor 基线）。
        await reset();
        downloads = []; popups = [];
        const normal = await centerOf(`a[href="${NORMAL_URL}"]`);
        await page.mouse.click(normal.x, normal.y);
        await page.waitForTimeout(300);
        const afterNormal = await read();
        assert.deepEqual(afterNormal.open, [], 'a labelled link must not open on click in edit mode');
        assert.deepEqual(afterNormal.menus, [], 'a labelled link opens no menu');
        assert.deepEqual(downloads, [], 'a labelled link must not download');

        // 6) 触屏点按：同样只弹菜单。
        await reset();
        downloads = []; popups = [];
        await page.touchscreen.tap(chip.x, chip.y);
        await page.waitForTimeout(400);
        const afterTap = await read();
        assert.deepEqual(afterTap.open, [], 'touch tap on the attachment must not call window.open');
        assert.deepEqual(downloads, [], 'touch tap on the attachment must not download');
        assert.deepEqual(afterTap.menus, ['article-file-menu'], 'touch tap opens the attachment menu');

        // 7) 阅读模式：浏览器原生下载，不弹菜单。
        // 先点编辑器外的空白把上一步留下的菜单收掉（「触发元素本身例外」会让点同一个
        // chip 不会关闭它），否则第 7 步的断言分不清是残留还是新开的。
        await page.mouse.click(600, 700);
        await page.waitForTimeout(250);
        assert.deepEqual((await read()).menus, [], 'menu dismissed by clicking away');
        await reset();
        downloads = []; popups = [];
        await page.evaluate(() => { editor.setReadingMode(true); });
        await page.waitForTimeout(250);
        await page.mouse.click(chip.x, chip.y);
        await page.waitForTimeout(900);
        const afterReading = await read();
        assert.deepEqual(afterReading.menus, [], 'reading mode click opens no menu');
        assert.deepEqual(afterReading.open, [], 'reading mode click must not go through window.open either');
        assert.equal(downloads.length >= 1, true, `reading mode click still downloads (${JSON.stringify({ downloads, popups })})`);
        await page.evaluate(() => { editor.setReadingMode(false); });
        await page.waitForTimeout(250);

        assert.deepEqual(pageErrors, [], `no page errors (${pageErrors.join(' | ')})`);
        console.log('Attachment click browser regression passed');
    } finally {
        await context.close();
        await new Promise(resolve => server.close(resolve));
    }
};

if (require.main === module) {
    (async () => {
        const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try { await module.exports(browser); } finally { await browser.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
