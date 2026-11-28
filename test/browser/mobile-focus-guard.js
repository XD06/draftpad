/**
 * 移动端 / PWA 编辑态焦点与视线防跳真机回归（Playwright Chrome 390×844 触控视口）：
 * 1) 初始未聚焦带 inputmode="none"；单指轻点正文立即放开输入、长按/拖拽/滑动不误弹；
 * 2) 长文章顶段持有旧焦点时，下滑到底部操作待办复选框、图片及四档尺寸、/time 标记
 *    及更新、批注徽标、高亮正文及取消高亮，均不会把视线拽回文首旧光标，且完成后
 *    自动释放编辑器焦点并保持 inputmode="none" 压制软键盘；
 * 3) 划词菜单渲染包含 6 个按钮与归一化 `sm-cut` 剪刀图标，剪切动作写剪贴板并删字
 *    后释放焦点不跳动；随后单指轻点正文恢复输入并可正常键入文字。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const LEGACY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ANNOTATION_STYLE = 'text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;';

const FILLERS = Array.from({ length: 42 }, (_, index) => (
    `第 ${index + 1} 段正文占位内容，用于将文章长度撑开超过一屏以便验证视口零回跳。`
)).join('\n\n');

const FIXTURE = [
    '# 顶部标题',
    '',
    '顶部起始编辑段落。',
    '',
    FILLERS,
    '',
    '末尾待点选的普通正文段落。',
    '',
    '这里包含一段用来测试剪切选区的新增文字。',
    '',
    '- [ ] 底部待办任务条目',
    '',
    `![底部图片](${LEGACY_PNG})`,
    '',
    '底部时间 [[time:create:2026-01-01 00:00:00]] 标记',
    '',
    `底部 <span data-note="底部批注详情" style="${ANNOTATION_STYLE}">批注正文</span> 与 <mark>高亮文本</mark> 结束。`,
].join('\n');

module.exports = async function testMobileFocusGuard(browser) {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="/Assets/styles.css">
        <link rel="stylesheet" href="/Assets/ios-theme.css">
        <style>
            html, body { overflow-y: auto !important; height: auto !important; margin: 0; }
            body { padding: 12px 12px 180px; font-size: 16px; line-height: 1.7; }
            #editor, #editor .vditor-wysiwyg { width: 100%; height: auto !important; max-height: none !important; overflow: visible !important; }
            #editor .tiptap { outline: none; margin-top: 0 !important; }
            #editor .tiptap p { margin: 12px 0; }
            #editor .tiptap img { display: block; width: 200px; height: 80px; background: #e5e7eb; }
            .md-time-marker { display: inline-block; padding: 2px 10px; background: #eef2ff; border-radius: 6px; }
            .annotation-badge { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; }
        </style>
        </head><body><div id="editor"></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
    app.use('/js/marked', express.static(path.join(root, 'node_modules/marked/lib')));
    app.use(express.static(path.join(root, 'public')));

    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    const readFocusState = () => page.evaluate(() => {
        const rootEl = editor.container.querySelector('.tiptap');
        return {
            scrollY: Math.round(window.scrollY),
            activeIsEditor: document.activeElement === rootEl || Boolean(rootEl?.contains(document.activeElement)),
            activeTag: document.activeElement?.tagName || null,
            inputmode: rootEl?.getAttribute('inputmode') ?? null,
            virtualKeyboardPolicy: rootEl?.getAttribute('virtualkeyboardpolicy') ?? null,
            value: editor.getValue(),
        };
    });

    const armTopCaretWhileScrolledTo = async (targetScrollY) => {
        await page.evaluate(() => {
            const rootEl = editor.container.querySelector('.tiptap');
            const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
            const firstP = rootEl.querySelector('p');
            const pos = editor.editor.view.posAtDOM(firstP, 0);
            editor.editor.view.dispatch(
                editor.editor.state.tr.setSelection(TextSelection.near(editor.editor.state.doc.resolve(pos)))
            );
            rootEl.focus({ preventScroll: true });
        });
        // 等待 Chromium focus 异步 reveal-selection 完成，再模拟用户带着顶部焦点向下滑动到底部。
        await page.waitForTimeout(60);
        const settled = await page.evaluate((y) => {
            window.scrollTo(0, y);
            const rootEl = editor.container.querySelector('.tiptap');
            return document.activeElement === rootEl && Math.abs(window.scrollY - y) <= 4;
        }, targetScrollY);
        return settled;
    };

    const tapElementCenter = async (selector) => {
        const coords = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) throw new Error(`Missing selector: ${sel}`);
            const rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }, selector);
        await page.touchscreen.tap(coords.x, coords.y);
        return coords;
    };

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(async (fixture) => {
            const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
            window.editor = new HybridMarkdownEditor(document.querySelector('#editor'));
            await editor.whenReady();
            editor.setValue(fixture, false);
            await new Promise(resolve => setTimeout(resolve, 300));
        }, FIXTURE);

        // 1) 初始未聚焦状态：inputmode="none" & virtualkeyboardpolicy="manual"，不拿焦点
        const initial = await readFocusState();
        assert.equal(initial.activeIsEditor, false, `initial state must not focus editor: ${JSON.stringify(initial)}`);
        assert.equal(initial.inputmode, 'none', `mobile editor must initialize with inputmode=none: ${JSON.stringify(initial)}`);
        assert.equal(initial.virtualKeyboardPolicy, 'manual', `mobile editor must initialize with virtualkeyboardpolicy=manual: ${JSON.stringify(initial)}`);

        // 2) 单指轻点顶部段落：放开 inputmode、拿焦点并可打字
        await tapElementCenter('#editor .tiptap p');
        await page.waitForTimeout(200);
        const afterTopTap = await readFocusState();
        assert.equal(afterTopTap.activeIsEditor, true, 'quick tap on plain text focuses editor');
        assert.equal(afterTopTap.inputmode, null, 'quick tap on plain text clears inputmode=none');
        assert.equal(afterTopTap.virtualKeyboardPolicy, null, 'quick tap on plain text clears virtualkeyboardpolicy');
        await page.keyboard.type('OK');
        await page.waitForTimeout(250);
        assert((await readFocusState()).value.includes('OK顶部起始编辑段落') || (await readFocusState()).value.includes('顶部起始编辑段落。OK'),
            'typing after quick tap edits top paragraph');

        // 3) 滚到底部（保持顶部旧光标），逐项操作非输入控件：不回跳、不留焦、保持 inputmode=none
        const scrolledY = await page.evaluate(() => {
            const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
            window.scrollTo(0, maxScroll);
            return Math.round(window.scrollY);
        });
        assert(scrolledY > 1200, `expected long scroll > 1200px, got ${scrolledY}`);

        // 3a) 待办复选框
        await tapElementCenter('ul[data-type="taskList"] input[type="checkbox"]');
        await page.waitForTimeout(260);
        const afterTodo = await readFocusState();
        assert(afterTodo.value.includes('- [x] 底部待办任务条目'), 'tapping task checkbox marks item done');
        assert.equal(afterTodo.activeIsEditor, false, 'task checkbox tap blurs editor');
        assert.equal(afterTodo.inputmode, 'none', 'task checkbox tap locks inputmode=none');
        assert.equal(afterTodo.virtualKeyboardPolicy, 'manual', 'task checkbox tap locks virtualkeyboardpolicy=manual');
        assert(Math.abs(afterTodo.scrollY - scrolledY) <= 4,
            `task checkbox must not jump viewport (${scrolledY} -> ${afterTodo.scrollY})`);

        // 3b) 图片尺寸菜单与改宽
        assert.equal(await armTopCaretWhileScrolledTo(scrolledY), true, 're-armed top caret without scroll');
        await tapElementCenter('#editor .tiptap img');
        await page.waitForTimeout(260);
        const afterImgTap = await readFocusState();
        const sizeMenuOpen = await page.evaluate(() => !document.querySelector('.article-image-size-menu')?.hidden);
        assert.equal(sizeMenuOpen, true, 'touch tap on image opens size menu');
        assert.equal(afterImgTap.activeIsEditor, false, 'touch tap on image releases editor focus');
        assert.equal(afterImgTap.inputmode, 'none', 'touch tap on image keeps inputmode=none');
        assert.equal(afterImgTap.virtualKeyboardPolicy, 'manual', 'touch tap on image keeps virtualkeyboardpolicy=manual');
        assert(Math.abs(afterImgTap.scrollY - scrolledY) <= 4,
            `image tap must not jump viewport (${scrolledY} -> ${afterImgTap.scrollY})`);

        await tapElementCenter('.article-image-size-menu [data-image-width="360"]');
        await page.waitForTimeout(260);
        const afterWidth = await readFocusState();
        assert(/dumbpad-width=\d{2,4}/.test(afterWidth.value),
            `size menu applies width preset (got ${afterWidth.value.slice(-120)})`);
        assert.equal(afterWidth.activeIsEditor, false, 'size menu action keeps editor unfocused');
        assert.equal(afterWidth.inputmode, 'none', 'size menu action locks inputmode=none');
        assert.equal(afterWidth.virtualKeyboardPolicy, 'manual', 'size menu action locks virtualkeyboardpolicy=manual');
        assert(Math.abs(afterWidth.scrollY - scrolledY) <= 4,
            `image resize must not jump viewport (${scrolledY} -> ${afterWidth.scrollY})`);

        // 3c) /time 时间标记与「更新」
        assert.equal(await armTopCaretWhileScrolledTo(scrolledY), true, 're-armed top caret before time marker tap');
        await tapElementCenter('#editor .tiptap .md-time-marker');
        await page.waitForTimeout(260);
        const afterTimeTap = await readFocusState();
        const timeMenuOpen = await page.evaluate(() => document.querySelector('.time-marker-menu')?.style.display === 'flex');
        assert.equal(timeMenuOpen, true, 'touch tap opens time marker menu');
        assert.equal(afterTimeTap.activeIsEditor, false, 'time marker tap releases editor focus');
        assert.equal(afterTimeTap.inputmode, 'none', 'time marker tap keeps inputmode=none');
        assert.equal(afterTimeTap.virtualKeyboardPolicy, 'manual', 'time marker tap keeps virtualkeyboardpolicy=manual');
        assert(Math.abs(afterTimeTap.scrollY - scrolledY) <= 4,
            `time marker tap must not jump viewport (${scrolledY} -> ${afterTimeTap.scrollY})`);

        await tapElementCenter('.time-marker-menu [data-time-action="update"]');
        await page.waitForTimeout(260);
        const afterTimeUpdate = await readFocusState();
        assert(/\[\[time:update:/.test(afterTimeUpdate.value), 'time marker updates to update stamp');
        assert.equal(afterTimeUpdate.activeIsEditor, false, 'time marker update keeps editor unfocused');
        assert.equal(afterTimeUpdate.inputmode, 'none', 'time marker update locks inputmode=none');
        assert.equal(afterTimeUpdate.virtualKeyboardPolicy, 'manual', 'time marker update locks virtualkeyboardpolicy=manual');
        assert(Math.abs(afterTimeUpdate.scrollY - scrolledY) <= 4,
            `time marker update must not jump viewport (${scrolledY} -> ${afterTimeUpdate.scrollY})`);

        // 3d) 批注徽标看详情
        assert.equal(await armTopCaretWhileScrolledTo(scrolledY), true, 're-armed top caret before badge tap');
        await tapElementCenter('#editor .tiptap .annotation-badge');
        await page.waitForTimeout(260);
        const afterBadgeTap = await readFocusState();
        const badgePopoverInfo = await page.evaluate(() => {
            const pop = document.querySelector('.mark-popover');
            return {
                display: pop?.style.display,
                readonly: pop?.classList.contains('comment-only-popover'),
                text: pop?.querySelector('.mark-popover-text')?.textContent,
            };
        });
        assert.equal(badgePopoverInfo.display, 'block', 'badge tap opens comment card');
        assert.equal(badgePopoverInfo.readonly, true, 'badge tap opens comment-only popover');
        assert.equal(badgePopoverInfo.text, '底部批注详情');
        assert.equal(afterBadgeTap.activeIsEditor, false, 'badge tap releases editor focus');
        assert.equal(afterBadgeTap.inputmode, 'none', 'badge tap locks inputmode=none');
        assert.equal(afterBadgeTap.virtualKeyboardPolicy, 'manual', 'badge tap locks virtualkeyboardpolicy=manual');
        assert(Math.abs(afterBadgeTap.scrollY - scrolledY) <= 4,
            `badge tap must not jump viewport (${scrolledY} -> ${afterBadgeTap.scrollY})`);

        // 3e) 高亮文字弹出「取消高亮」& 执行取消
        await page.touchscreen.tap(10, 10);
        await page.waitForTimeout(150);
        assert.equal(await armTopCaretWhileScrolledTo(scrolledY), true, 're-armed top caret before highlight tap');
        await tapElementCenter('#editor .tiptap mark.md-mark');
        await page.waitForTimeout(260);
        const afterHighlightTap = await readFocusState();
        const cancelBtnVisible = await page.evaluate(() => {
            const pop = document.querySelector('.mark-popover');
            return pop?.style.display === 'flex' && pop?.textContent?.includes('取消高亮');
        });
        assert.equal(cancelBtnVisible, true, 'tapping highlighted text opens cancel popover');
        assert.equal(afterHighlightTap.activeIsEditor, false, 'highlight tap releases editor focus');
        assert.equal(afterHighlightTap.inputmode, 'none', 'highlight tap keeps inputmode=none');
        assert.equal(afterHighlightTap.virtualKeyboardPolicy, 'manual', 'highlight tap keeps virtualkeyboardpolicy=manual');
        assert(Math.abs(afterHighlightTap.scrollY - scrolledY) <= 4,
            `highlight tap must not jump viewport (${scrolledY} -> ${afterHighlightTap.scrollY})`);

        await tapElementCenter('.mark-popover .delete-btn');
        await page.waitForTimeout(260);
        const afterCancelHighlight = await readFocusState();
        assert.equal(afterCancelHighlight.value.includes('<mark>'), false, 'cancel button removes highlight mark');
        assert.equal(afterCancelHighlight.activeIsEditor, false, 'cancel highlight keeps editor unfocused');
        assert.equal(afterCancelHighlight.inputmode, 'none', 'cancel highlight locks inputmode=none');
        assert.equal(afterCancelHighlight.virtualKeyboardPolicy, 'manual', 'cancel highlight locks virtualkeyboardpolicy=manual');
        assert(Math.abs(afterCancelHighlight.scrollY - scrolledY) <= 4,
            `cancel highlight must not jump viewport (${scrolledY} -> ${afterCancelHighlight.scrollY})`);

        // 4) 划词菜单：6 个按钮 + sm-cut 剪刀图标几何 + 剪切删字且保持无焦/无回跳
        const selectionCheck = await page.evaluate(() => {
            window.__copiedText = null;
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: async (text) => { window.__copiedText = text; } },
                configurable: true,
            });
            const rootEl = editor.container.querySelector('.tiptap');
            const paragraphs = [...rootEl.querySelectorAll('p')];
            const cutP = paragraphs.find(p => p.textContent.includes('剪切选区'));
            const text = '剪切选区';
            const idx = cutP.textContent.indexOf(text);
            const from = editor.editor.view.posAtDOM(cutP.firstChild, idx);
            const to = from + text.length;
            const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
            editor.editor.view.dispatch(
                editor.editor.state.tr.setSelection(TextSelection.create(editor.editor.state.doc, from, to))
            );
            const spriteSymbol = document.querySelector('#sm-cut');
            let bbox = null;
            if (spriteSymbol) {
                const probeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                probeSvg.setAttribute('viewBox', '0 0 1024 1024');
                probeSvg.style.cssText = 'position:fixed;width:100px;height:100px;visibility:hidden;';
                probeSvg.innerHTML = spriteSymbol.innerHTML;
                document.body.appendChild(probeSvg);
                const r = probeSvg.querySelector('g').getBBox();
                const ctm = probeSvg.querySelector('g').getCTM();
                bbox = {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                    hasTransform: Boolean(ctm),
                };
                probeSvg.remove();
            }
            return { inputmode: rootEl.getAttribute('inputmode'), bbox };
        });
        await page.waitForTimeout(200);
        const menuButtons = await page.evaluate(() => (
            [...document.querySelectorAll('.tiptap-selection-menu .menu-btn-group button')].map(btn => ({
                label: btn.getAttribute('aria-label'),
                action: btn.dataset.action,
                rect: (() => {
                    const r = btn.getBoundingClientRect();
                    return { width: Math.round(r.width), height: Math.round(r.height) };
                })(),
            }))
        ));
        assert.equal(selectionCheck.inputmode, 'none', 'selecting from browse mode keeps inputmode=none');
        assert(selectionCheck.bbox && selectionCheck.bbox.width > 10 && selectionCheck.bbox.height > 10,
            `sm-cut symbol must have non-zero bbox: ${JSON.stringify(selectionCheck.bbox)}`);
        assert.deepEqual(menuButtons.map(b => b.action), ['draw', 'highlight', 'annotate', 'bold', 'copy', 'cut']);
        assert(menuButtons.every(b => b.rect.width >= 40 && b.rect.height >= 40),
            `mobile selection menu touch targets must stay >= 40px: ${JSON.stringify(menuButtons)}`);

        await tapElementCenter('.tiptap-selection-menu button[data-action="cut"]');
        await page.waitForTimeout(260);
        const afterCut = await readFocusState();
        const expectedCutScrollY = await page.evaluate((prevY) => (
            Math.min(prevY, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
        ), scrolledY);
        assert.equal(await page.evaluate(() => window.__copiedText), '剪切选区', 'cut copied selected text');
        assert.equal(afterCut.value.includes('剪切选区'), false, 'cut deleted selected text from article');
        assert.equal(afterCut.activeIsEditor, false, 'touch cut releases editor focus');
        assert.equal(afterCut.inputmode, 'none', 'touch cut locks inputmode=none');
        assert.equal(afterCut.virtualKeyboardPolicy, 'manual', 'touch cut locks virtualkeyboardpolicy=manual');
        assert(Math.abs(afterCut.scrollY - expectedCutScrollY) <= 4,
            `cut action must not jump viewport (${expectedCutScrollY} -> ${afterCut.scrollY})`);

        // 4b) 处于划词选区时点按普通正文取消选中：不弹键盘、释放焦点且视口不跳动
        const dismissTapCoords = await page.evaluate(() => {
            const rootEl = editor.container.querySelector('.tiptap');
            const p = [...rootEl.querySelectorAll('p')]
                .find(el => el.textContent.includes('末尾待点选的普通正文段落'));
            const from = editor.editor.view.posAtDOM(p.firstChild, 0);
            const to = from + 4;
            const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
            editor.editor.view.dispatch(
                editor.editor.state.tr.setSelection(TextSelection.create(editor.editor.state.doc, from, to))
            );
            const domRange = document.createRange();
            domRange.setStart(p.firstChild, 0);
            domRange.setEnd(p.firstChild, 4);
            const domSel = window.getSelection();
            domSel.removeAllRanges();
            domSel.addRange(domRange);
            const r = p.getBoundingClientRect();
            return { x: r.left + r.width * 0.75, y: r.top + r.height / 2 };
        });
        await page.touchscreen.tap(dismissTapCoords.x, dismissTapCoords.y);
        await page.waitForTimeout(220);
        const afterDismissTap = await readFocusState();
        assert.equal(afterDismissTap.inputmode, 'none', 'tapping plain text to dismiss selection locks inputmode=none');
        assert.equal(afterDismissTap.virtualKeyboardPolicy, 'manual', 'tapping plain text to dismiss selection locks virtualkeyboardpolicy=manual');
        assert.equal(afterDismissTap.activeIsEditor, false, 'tapping plain text to dismiss selection releases focus');
        assert(Math.abs(afterDismissTap.scrollY - expectedCutScrollY) <= 8,
            `dismissing selection tap must not jump viewport (${expectedCutScrollY} -> ${afterDismissTap.scrollY})`);

        // 5) 最后验证：单指轻点底部普通正文，可立刻移除 inputmode="none" 与 virtualkeyboardpolicy="manual" 恢复聚焦与输入
        const plainTapCoords = await page.evaluate(() => {
            const p = [...editor.container.querySelectorAll('.tiptap p')]
                .find(el => el.textContent.includes('末尾待点选的普通正文段落'));
            const r = p.getBoundingClientRect();
            return { x: r.left + 24, y: r.top + r.height / 2 };
        });
        await page.touchscreen.tap(plainTapCoords.x, plainTapCoords.y);
        await page.waitForTimeout(220);
        const afterPlainTap = await readFocusState();
        assert.equal(afterPlainTap.inputmode, null, 'tapping plain text removes inputmode=none');
        assert.equal(afterPlainTap.virtualKeyboardPolicy, null, 'tapping plain text removes virtualkeyboardpolicy');
        assert.equal(afterPlainTap.activeIsEditor, true, 'tapping plain text focuses editor');
        assert(afterPlainTap.scrollY > 1000, `plain tap stays at scrolled bottom (${afterPlainTap.scrollY})`);
        await page.keyboard.type('TEST');
        await page.waitForTimeout(250);
        assert((await readFocusState()).value.includes('TEST'), 'typing works after plain text tap');

        assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join(' | ')}`);
        console.log('Mobile focus guard browser regression passed');
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
