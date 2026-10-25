/**
 * 附件点击回归（真实浏览器）：编辑模式点附件 chip 只能弹菜单，不得触发任何下载
 * 或 window.open；下载只发生在菜单的「下载附件」里；阅读模式仍由浏览器直接下载。
 * 覆盖 Tiptap Link 的 PM handleClick 路径（jsdom 走不到鼠标管线，故必须真浏览器）。
 * 图片触屏点按：不夺焦（真机=不弹键盘）、尺寸菜单照开且夹取在 visualViewport
 * 内（软键盘只缩 vv，iOS 的 innerHeight 不变，按 innerHeight 夹取会落到键盘后面）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ASSET_ID = '0123456789abcdef0123456789abcdef';
const DOWNLOAD = `/api/assets/${ASSET_ID}/download`;
const FILE_MD = `[报告.pdf · 1.2 MB](${DOWNLOAD} "dumbpad-file=1;size=1258291;type=application%2Fpdf")`;
const BARE_URL = 'https://example.com/a';
const NORMAL_URL = 'https://example.com/b';
const LEGACY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMAGE_MD = `![probe](${LEGACY_PNG})`;
const FIXTURE = [
    FILE_MD,
    `[${BARE_URL}](${BARE_URL})`,
    `[普通链接](${NORMAL_URL})`,
    '正文一段文字。',
    IMAGE_MD,
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

        // 6b) 光标落在 chip 文本里按回车：真实布局下胶囊不能被撑高，换行不能进 label。
        // 先收掉上一步触屏点按留下的菜单，否则「Enter 不弹菜单」分不清新旧
        await page.mouse.click(600, 700);
        await page.waitForTimeout(200);
        assert.deepEqual((await read()).menus, [], 'menu dismissed before the Enter step');
        const chipHeight = () => page.evaluate(() => Math.round(
            editor.container.querySelector('a.dumbpad-article-file').getBoundingClientRect().height));
        const heightBefore = await chipHeight();
        await page.evaluate(() => {
            const anchor = editor.container.querySelector('a.dumbpad-article-file');
            const view = editor.editor.view;
            const { PM } = globalThis.DumbPadTiptap;
            const pos = view.posAtDOM(anchor.firstChild, 3);
            view.dispatch(view.state.tr.setSelection(PM.state.TextSelection.near(view.state.doc.resolve(pos))));
            view.focus();
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(250);
        const heightAfter = await chipHeight();
        assert(Math.abs(heightAfter - heightBefore) <= 1,
            `Enter inside the chip must not grow it (${heightBefore}px → ${heightAfter}px)`);
        assert.equal(await page.evaluate(() => document.querySelector('a.dumbpad-article-file').querySelectorAll('br').length),
            0, 'the soft break must never land inside the <a>');
        await page.keyboard.type('X');
        await page.waitForTimeout(250);
        const afterEnter = await read();
        assert.equal(afterEnter.value.includes(`${FILE_MD}\nX`), true,
            `typing after Enter continues on the new line (${JSON.stringify(afterEnter.value.slice(0, 60))})`);
        assert.deepEqual(afterEnter.menus, [], 'Enter opens no menu');
        // 还原几何，后面的阅读模式步骤仍用同一组坐标
        await page.evaluate((fixture) => { editor.setValue(fixture, false); }, FIXTURE);
        await page.waitForTimeout(300);

        // 6c) 触屏点图片：不夺焦（真机=不弹键盘），尺寸菜单照开、夹取在
        //     visualViewport 内。真实点按必须落在真实图片上（先取中心再覆盖
        //     矩形）；菜单定位读的是覆盖后的锚点矩形 + 假 vv（420 高模拟键盘
        //     开启时的可见区），锚点下缘 760 → 未夹取会落到 768（键盘后面）。
        await reset();
        downloads = []; popups = [];
        const imgCenter = await centerOf('.tiptap img');
        await page.evaluate(() => {
            // 6b 刚在编辑器里打完字（焦点还在）：先清焦点，模拟「键盘收起后
            // 点图片」的真机起点——此时点图片绝不能再把焦点抢回来（=弹键盘）。
            if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
                document.activeElement.blur();
            }
            const realViewport = window.visualViewport;
            window.__restoreViewport = () => {
                if (realViewport) Object.defineProperty(window, 'visualViewport', { value: realViewport, configurable: true });
                else delete window.visualViewport;
            };
            Object.defineProperty(window, 'visualViewport', {
                value: { width: 1280, height: 420 },
                configurable: true,
            });
            const img = document.querySelector('.tiptap img');
            img.getBoundingClientRect = () => ({ left: 460, top: 740, right: 820, bottom: 760, width: 360, height: 20 });
        });
        await page.touchscreen.tap(imgCenter.x, imgCenter.y);
        await page.waitForTimeout(400);
        const afterImageTap = await read();
        assert.deepEqual(afterImageTap.menus, ['article-image-size-menu'], 'touch tap on an image opens the size menu');
        assert.equal(
            await page.evaluate(() => document.activeElement !== editor.container.querySelector('.tiptap')),
            true,
            'touch tap on an image must not focus the editor (real device: keyboard must stay closed)',
        );
        const sizeMenuRect = await page.evaluate(() => {
            const menu = document.querySelector('.article-image-size-menu');
            const r = menu.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
        });
        assert(sizeMenuRect.bottom <= 420 && sizeMenuRect.top >= 0,
            `size menu must clamp inside the visual viewport under the keyboard (${JSON.stringify(sizeMenuRect)})`);
        const narrow = await page.evaluate(() => {
            const button = document.querySelector('.article-image-size-menu [data-image-width="360"]');
            const r = button.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.touchscreen.tap(narrow.x, narrow.y);
        await page.waitForTimeout(300);
        assert.equal((await read()).value.includes('dumbpad-width=360'), true,
            'touch tap on a size button applies the width');
        await page.evaluate(() => { window.__restoreViewport?.(); });

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
