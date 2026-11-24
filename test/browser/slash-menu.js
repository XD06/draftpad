// 斜杠命令菜单的真机回归（jsdom 证不了 coordsAtPos 定位、真实键盘链路与
// 原生 file chooser）：'/' 浮层出现、过滤、↑↓+Enter 执行 /time、Escape 关闭、
// 点击 /file 弹出原生选择器并删掉命令文本、移动端视口内可见。桌面与移动端
// 视口各跑一轮定位断言。
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

async function main() {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head>
        <link rel="stylesheet" href="/Assets/styles.css">
        <style>body{margin:0}#editor{height:600px}</style>
        </head><body><div id="editor"></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
    app.use(express.static(path.join(root, 'public')));
    // /file 完整上传管线的 mock：真实点击菜单 → file chooser → XHR 上传 →
    // 插入 markdown。曾漏测「选择器弹出后上传从未发生」（deletePendingCommand
    // 对已删命令文本的越界 textBetween 抛 TypeError 中断 handleFiles）。
    const uploadsReceived = [];
    app.post('/api/assets/files', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
        uploadsReceived.push(req.headers['x-asset-name'] || '');
        res.json({
            name: 'probe.txt',
            downloadUrl: '/api/assets/probe-id/download',
            size: req.body ? req.body.length : 0,
            type: 'text/plain',
        });
    });

    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const failures = [];
    const check = (name, ok, detail) => {
        if (ok) console.log(`PASS ${name}`);
        else {
            failures.push(name);
            console.error(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
        }
    };

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(async () => {
            const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
            window.editor = new HybridMarkdownEditor(document.querySelector('#editor'));
            await editor.whenReady();
        });
        // 真实 click 聚焦编辑器：headless 下导航后的第一次 keyboard.type 偶发
        // 丢失（页面尚未真正激活），click 是确定性的聚焦手段。
        await page.click('#editor .tiptap');
        await page.waitForTimeout(200);

        const menuBox = () => page.$eval('.slash-command-menu', el => ({
            visible: el.style.display !== 'none',
            rect: el.getBoundingClientRect().toJSON(),
        })).catch(() => null);
        const itemCount = () => page.$$eval('.slash-command-item', els => els.length);

        // ---- 1. 输入 / 菜单出现，13 条内置命令都在 ----
        await page.keyboard.type('/');
        await page.waitForTimeout(150);
        const opened = await menuBox();
        check('typing / shows the menu', opened?.visible === true, opened);
        check('menu lists all 13 built-in commands', await itemCount() === 13);

        // ---- 2. 过滤 + ↑↓ + Enter 执行 /time ----
        await page.keyboard.type('t');
        await page.waitForTimeout(120);
        const firstTId = await page.$eval('.slash-command-item .slash-command-hint', el => el.textContent).catch(() => '');
        check('t ranks /time first', firstTId === '/time', { firstTId });
        await page.keyboard.type('im');
        await page.waitForTimeout(120);
        check('query tim filters to /time', await itemCount() === 1);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
        const valueAfterTime = await page.evaluate(() => editor.getValue());
        check('enter executes /time into a marker',
            /\[\[time:create:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\]/.test(valueAfterTime)
            && !valueAfterTime.includes('/tim'),
            { value: valueAfterTime });
        check('menu closes after execution', (await menuBox())?.visible !== true);

        // ---- 3. Escape 关闭 ----
        await page.keyboard.press('Enter'); // 软换行到新视觉行
        await page.keyboard.type('/fi');
        await page.waitForTimeout(120);
        check('/fi shows the /file entry', await itemCount() === 1);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
        check('escape hides the menu', (await menuBox())?.visible !== true);

        // ---- 4. 点击 /file：命令文本删除 + 原生 file chooser 弹出 ----
        // Escape 后留下的 '/fi' 必须先删掉：'fi/f' 的斜杠在词中，按设计不触发
        // （与 URL 保护同一条规则）。
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('/f');
        await page.waitForSelector('.slash-command-item', { timeout: 2000 });
        await page.waitForTimeout(150);
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 3000 });
        await page.click('.slash-command-item');
        const chooser = await chooserPromise.catch(() => null);
        check('clicking /file opens the native file chooser', Boolean(chooser));
        const valueAfterFile = await page.evaluate(() => editor.getValue());
        check('clicking /file removes the query text', !valueAfterFile.includes('/f'),
            { value: valueAfterFile });
        // 选完文件必须真的走完上传管线：XHR 到达 mock 服务器 + markdown 插入。
        if (chooser) {
            await chooser.setFiles(path.resolve(__dirname, '../fixtures/upload-probe.txt'));
            await page.waitForTimeout(1200);
        }
        const valueAfterUpload = await page.evaluate(() => editor.getValue());
        check('menu /file upload reaches the server', uploadsReceived.length >= 1,
            { uploads: uploadsReceived, value: valueAfterUpload });
        check('menu /file upload inserts markdown', valueAfterUpload.includes('/api/assets/probe-id/download'),
            { value: valueAfterUpload });

        // ---- 5. 菜单落在视口内（桌面） ----
        await page.evaluate(() => {
            editor.setValue('', false);
        });
        await page.click('#editor .tiptap');
        await page.keyboard.type('/');
        await page.waitForTimeout(150);
        const desktopBox = await menuBox();
        check('desktop menu stays inside the viewport',
            desktopBox?.visible === true
            && desktopBox.rect.left >= 0
            && desktopBox.rect.right <= 1024
            && desktopBox.rect.bottom <= 768 + 1,
            desktopBox?.rect);

        // ---- 6. 移动端视口：可见、贴视口内、条目可点 ----
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(150);
        const mobileBox = await menuBox();
        check('mobile menu stays inside the viewport',
            mobileBox?.visible === true
            && mobileBox.rect.left >= 0
            && mobileBox.rect.right <= 390
            && mobileBox.rect.bottom <= 844 + 1,
            mobileBox?.rect);
        const mobileItemHeight = await page.$eval('.slash-command-item', el => el.getBoundingClientRect().height);
        check('mobile items keep a 44px touch target', mobileItemHeight >= 43, { mobileItemHeight });
        await page.click('.slash-command-item');
        await page.waitForTimeout(120);
        const valueAfterMobileTime = await page.evaluate(() => editor.getValue());
        check('tapping the selected item executes /time on mobile',
            /\[\[time:create:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\]/.test(valueAfterMobileTime),
            { value: valueAfterMobileTime });

        // ---- 7. /code + 点击语言徽标弹窗切换语言 + /table + /mermaid ----
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.evaluate(() => {
            editor.setValue('', false);
        });
        await page.click('#editor .tiptap');
        await page.keyboard.type('/code');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        const badgeCount = await page.$$eval('button.dumbpad-code-language-badge', els => els.length);
        check('/code renders a clickable language badge button', badgeCount === 1, { badgeCount });
        if (badgeCount === 1) {
            await page.click('button.dumbpad-code-language-badge');
            await page.waitForTimeout(120);
            const popoverVisible = await page.$eval('.dumbpad-code-language-popover', el => !el.hidden).catch(() => false);
            check('clicking language badge opens language picker popover', popoverVisible);
            await page.fill('.dumbpad-code-language-input', 'py');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(150);
            const codeMd = await page.evaluate(() => editor.getValue());
            const badgeLabel = await page.$eval('.dumbpad-code-language-token', el => el.dataset.languageLabel).catch(() => '');
            check('selecting python from language popover updates badge and markdown',
                badgeLabel === 'python' && codeMd.includes('```python'),
                { badgeLabel, codeMd });
        }

        await page.evaluate(() => {
            editor.setValue('', false);
        });
        await page.click('#editor .tiptap');
        await page.keyboard.type('/table');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        const tableCount = await page.$$eval('#editor table', els => els.length);
        const tableMd = await page.evaluate(() => editor.getValue());
        check('/table inserts a markdown table', tableCount === 1 && tableMd.includes('|'), { tableCount, tableMd });

        await page.evaluate(() => {
            editor.setValue('', false);
        });
        await page.click('#editor .tiptap');
        await page.keyboard.type('/mermaid');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        const mermaidMd = await page.evaluate(() => editor.getValue());
        const mermaidCodeText = await page.$eval('[data-type="code-block"] code', el => el.textContent || '').catch(() => '');
        const outsideText = await page.$$eval('#editor .tiptap > p', els => els.map(el => el.textContent || '').join('\n')).catch(() => '');
        check('/mermaid keeps entire template inside mermaid fenced block',
            /^```mermaid\nflowchart LR\n    A\[开始\] --> B\[完成\]\n```/.test(mermaidMd.trim())
            && mermaidCodeText.includes('A[开始] --> B[完成]')
            && !outsideText.includes('A[开始]'),
            { mermaidMd, mermaidCodeText, outsideText });

        check('no page errors', errors.length === 0, errors);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }

    if (failures.length) {
        console.error(`\n${failures.length} FAILURES`);
        process.exit(1);
    }
    console.log('\nALL PASS');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
