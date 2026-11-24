/**
 * 移动端 PWA 综合体验真机回归（Playwright Chrome 390×844 触控视口）：
 * 1) 虚拟键盘视口（resizes-visual + keyboard-open）：不压缩页面、隐藏底部 FAB 避免碰撞、
 *    Toast 自动避让到顶栏下方安全区且去重限频；
 * 2) 无感同步：远端修改前段正文时保持焦点与精准光标位置（无光标偏移、无自动保存/合并弹窗打扰），
 *    关闭设置弹窗不再强夺焦点弹软键盘；
 * 3) 移动端嵌套列表：Enter → Android 229 + beforeinput(deleteContentBackward) 留在父项缩进空行 →
 *    输入法键入 `- ` 稳定生成嵌套列表（ol > li > ul > li）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { registerNoteRoutes } = require('../../routes/note-routes');
const { registerNotepadRoutes } = require('../../routes/notepad-routes');
const { createWebSocketHub } = require('../../server/websocket');

async function main() {
    const root = path.resolve(__dirname, '../..');
    const note = { id: 'note', name: 'Mobile UX', version: 1, createdAt: Date.now(), updatedAt: Date.now() };
    let metadata = { notepads: [note] };
    let content = '第一段原始内容\n\n第二段用户正在输入\n\n' + Array.from({ length: 18 }, (_, i) => `占位段落 ${i + 1}`).join('\n\n');
    let lock = Promise.resolve();
    const storage = {
        init: async () => {},
        readNotepadsMeta: async () => structuredClone(metadata),
        saveNotepadsMeta: async next => { metadata = structuredClone(next); },
        readNoteContent: async () => content,
        writeNoteContent: async (_notepad, next) => { content = next; },
        withNotepadWriteLock(operation) {
            const result = lock.then(operation);
            lock = result.catch(() => {});
            return result;
        }
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.cookies = {}; next(); });
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    const hub = createWebSocketHub({ server: listener, validateOrigin: () => true });
    const routeContext = {
        storage,
        baseUrl: 'http://localhost',
        nodeEnv: 'test',
        pageHistoryCookie: 'history',
        pageHistoryCookieAge: 10000,
        loadNotepadsList: async () => structuredClone(metadata.notepads),
        findNotepadById: async id => {
            const data = await storage.readNotepadsMeta();
            return { data, notepad: data.notepads.find(item => item.id === id) };
        },
        broadcastUpdate: hub.broadcastUpdate,
        scheduleIndexNotepads: () => {}
    };
    registerNoteRoutes(app, routeContext);
    registerNotepadRoutes(app, routeContext);
    app.get('/api/config', (_req, res) => res.json({
        hiddenFloatingActions: [],
        assetMaxFileBytes: 10485760,
        siteTitle: 'DumbPad'
    }));
    app.get('/api/thoughts', (_req, res) => res.json({ thoughts: [], hasMore: false, total: 0 }));
    app.get('/api/instant-drafts', (_req, res) => res.json({ items: [], version: 0 }));
    app.get('/api/today-drafts', (_req, res) => res.json({ items: [], version: 0 }));
    app.use(express.static(path.join(root, 'public')));
    app.use('/vendor/vditor', express.static(path.join(root, 'node_modules/vditor/dist')));
    app.use('/js/@highlightjs/highlight.min.js', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')));
    app.use('/css/@highlightjs', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/styles')));

    let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));

        await page.goto(`http://127.0.0.1:${listener.address().port}/?id=note`);
        await page.waitForSelector('.tiptap[contenteditable="true"]', { timeout: 10000 });
        await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('第二段用户正在输入'), null, { timeout: 10000 });

        // 1. Viewport meta & virtual keyboard non-compression + toast/FAB non-collision
        const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
        assert(viewportMeta.includes('interactive-widget=resizes-visual'),
            `expected resizes-visual in viewport meta, got: ${viewportMeta}`);

        const kbState = await page.evaluate(() => {
            const tiptap = document.querySelector('.tiptap');
            tiptap.focus();
            const vv = window.visualViewport;
            const origHeightDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height');
            let mockedHeight = 420;
            Object.defineProperty(vv, 'height', { configurable: true, get: () => mockedHeight });
            vv.dispatchEvent(new Event('resize'));

            window.toaster.clear();
            window.toaster.show('键盘打开提示', 'info', false, 5000);
            window.toaster.show('键盘打开提示', 'info', false, 5000); // duplicate should dedupe

            const html = document.documentElement;
            const fab = document.querySelector('.floating-actions');
            const fabStyle = getComputedStyle(fab);
            const toastContainer = document.getElementById('toast-container');
            const toastStyle = getComputedStyle(toastContainer);
            const layout = document.querySelector('.three-column-layout');
            const openSnapshot = {
                keyboardOpen: html.classList.contains('keyboard-open'),
                kbHeight: html.style.getPropertyValue('--dumbpad-keyboard-height'),
                fabOpacity: fabStyle.opacity,
                fabPointerEvents: fabStyle.pointerEvents,
                toastTop: parseFloat(toastStyle.top),
                toastCount: toastContainer.querySelectorAll('.toast').length,
                layoutHeight: layout.getBoundingClientRect().height,
                tiptapHeight: tiptap.getBoundingClientRect().height,
            };

            mockedHeight = 844;
            vv.dispatchEvent(new Event('resize'));
            if (origHeightDesc) Object.defineProperty(vv, 'height', origHeightDesc);
            else delete vv.height;
            const closedSnapshot = {
                keyboardOpen: html.classList.contains('keyboard-open'),
                toastBottom: parseFloat(getComputedStyle(toastContainer).bottom),
            };
            window.toaster.clear();
            return { openSnapshot, closedSnapshot };
        });

        assert.equal(kbState.openSnapshot.keyboardOpen, true, 'keyboard-open must toggle on visualViewport shrink');
        assert.equal(kbState.openSnapshot.fabPointerEvents, 'none', 'floating actions must disable pointer events while keyboard is open');
        assert(kbState.openSnapshot.toastTop >= 48 && kbState.openSnapshot.toastTop <= 120,
            `toast container must relocate below header when keyboard is open (top=${kbState.openSnapshot.toastTop})`);
        assert.equal(kbState.openSnapshot.toastCount, 1, 'identical active toasts must deduplicate');
        assert(kbState.openSnapshot.layoutHeight >= kbState.openSnapshot.tiptapHeight - 4,
            `layout must not clip/compress article content (${kbState.openSnapshot.layoutHeight} vs ${kbState.openSnapshot.tiptapHeight})`);
        assert.equal(kbState.closedSnapshot.keyboardOpen, false, 'keyboard-open must clear when keyboard closes');
        assert(kbState.closedSnapshot.toastBottom >= 70, 'toast container must return above collapsed FAB rail');
        console.log('PASS mobile keyboard viewport, FAB hiding, and toast relocation/dedup');

        // 2. Seamless remote sync preserves focus & exact caret across edits BEFORE cursor
        await page.locator('.tiptap p', { hasText: '第二段用户正在输入' }).click();
        await page.evaluate(() => {
            const tiptap = document.querySelector('.tiptap');
            tiptap.focus();
            const p = [...document.querySelectorAll('.tiptap p')].find(el => el.textContent.includes('第二段用户正在输入'));
            const textNode = p.firstChild;
            const range = document.createRange();
            range.setStart(textNode, 3); // right after '第二段'
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
        });
        await page.waitForTimeout(80);

        metadata.notepads[0].version = 2;
        metadata.notepads[0].updatedAt = Date.now();
        content = content.replace('第一段原始内容', '第一段远端已同步修改\n\n远端新插一段');
        hub.broadcastUpdate('note', content, 'other-device', 2, {
            updatedAt: metadata.notepads[0].updatedAt,
            saveId: 'remote-save-1'
        });

        await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('第一段远端已同步修改'), null, { timeout: 10000 });
        await page.keyboard.insertText('XYZ');
        const syncResult = await page.evaluate(() => ({
            text: document.querySelector('.tiptap')?.textContent || '',
            focused: document.activeElement === document.querySelector('.tiptap'),
            toasts: document.querySelectorAll('#toast-container .toast').length,
        }));
        assert(syncResult.text.includes('第二段XYZ用户正在输入'), `caret drifted after remote sync: ${syncResult.text.slice(0, 120)}`);
        assert.equal(syncResult.focused, true, 'editor focus must survive background remote sync');
        assert.equal(syncResult.toasts, 0, 'background sync must not pop intrusive toasts');
        console.log('PASS seamless background sync preserves focus, exact caret, and zero toast noise');

        // Closing a modal on mobile must NOT force-focus editor and pop the virtual keyboard
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.locator('#settings-button').click();
        await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
        await page.locator('#settings-cancel').click();
        const focusedAfterModal = await page.evaluate(() => document.activeElement === document.querySelector('.tiptap'));
        assert.equal(focusedAfterModal, false, 'closing modal on mobile must not force-focus editor');
        console.log('PASS mobile hideModal does not steal focus / pop virtual keyboard');

        // 3. Mobile nested list creation: Enter -> Android 229 + beforeinput(deleteContentBackward) -> IME "- "
        await page.locator('.tiptap').click();
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('1. 手机主项');
        await page.waitForSelector('.tiptap ol > li', { timeout: 5000 });
        await page.keyboard.press('Enter');
        const afterMobileBackspace = await page.evaluate(() => {
            const root = document.querySelector('.tiptap');
            root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
            const ev = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
            root.dispatchEvent(ev);
            const sel = window.getSelection();
            const anchorEl = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
            return {
                prevented: ev.defaultPrevented,
                insideOlLi: Boolean(anchorEl?.closest('ol > li')),
                liCount: root.querySelectorAll('ol > li').length,
            };
        });
        assert.equal(afterMobileBackspace.prevented, true, 'Android deleteContentBackward must be intercepted before native unwrap');
        assert.equal(afterMobileBackspace.insideOlLi, true, 'caret must stay indented inside parent ordered item (not column 0)');
        assert.equal(afterMobileBackspace.liCount, 1, 'empty sibling li should fold into parent trailing blank line');

        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.imeSetComposition', { text: '- ', selectionStart: 2, selectionEnd: 2 });
        await cdp.send('Input.insertText', { text: '- ' });
        await page.waitForTimeout(100);
        await page.keyboard.insertText('嵌套子项');
        await page.waitForTimeout(100);

        const nestedResult = await page.evaluate(() => {
            const nestedLi = document.querySelector('.tiptap ol > li > ul > li');
            return {
                hasNestedLi: Boolean(nestedLi),
                nestedText: nestedLi?.textContent?.trim() || '',
                html: document.querySelector('.tiptap')?.innerHTML || '',
            };
        });
        assert.equal(nestedResult.hasNestedLi, true, `expected nested ol > li > ul > li, got: ${nestedResult.html}`);
        assert(nestedResult.nestedText.includes('嵌套子项'), `expected nested text, got: ${nestedResult.nestedText}`);
        console.log('PASS mobile Android 229/beforeinput + IME "- " creates nested list');

        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('\nMobile editor experience browser checks passed');
    } finally {
        if (browser) await browser.close();
        for (const client of hub.wss.clients) client.terminate();
        await new Promise(resolve => hub.wss.close(resolve));
        await new Promise(resolve => listener.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
