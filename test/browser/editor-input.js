const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

module.exports = async function testEditorInput(browser) {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head>
        <style>body{margin:0}#editor{height:600px}.md-time-marker{font-size:0}
        .md-time-marker::after{content:'TIME';font-size:16px}</style>
        </head><body><div id="editor"></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
    app.use('/js/marked', express.static(path.join(root, 'node_modules/marked/lib')));
    app.use(express.static(path.join(root, 'public')));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(async () => {
            const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
            window.editor = new HybridMarkdownEditor(document.querySelector('#editor'));
            await editor.whenReady();
            window.loadFixture = async () => {
                editor.setValue('- [ ] same item [[time:update:2026-09-05 18:45:08]]\n- [x] same item [[time:update:2026-09-05 18:45:08]]\n\nAfter list\n\n==highlight text==\n', false);
                await new Promise(resolve => setTimeout(resolve, 450));
            };
            window.place = (selector, index = 0, atEnd = true) => {
                const block = editor.container.querySelectorAll(selector)[index];
                const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
                let node;
                let selected;
                while ((node = walker.nextNode())) {
                    if (!node.parentElement.closest('.md-time-marker') && node.textContent.trim()) {
                        selected = node;
                        break;
                    }
                }
                const view = editor.editor.view;
                const pos = view.posAtDOM(selected, atEnd ? selected.length : 0);
                const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
                view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
                view.focus();
            };
            window.readState = () => {
                const root = editor.container.querySelector('.tiptap');
                const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null;
                const parent = range?.startContainer.nodeType === 3 ? range.startContainer.parentElement : range?.startContainer;
                const li = parent?.closest('li');
                const clone = root.cloneNode(true);
                clone.querySelectorAll('.md-time-marker').forEach(node => node.remove());
                return { item: [...root.querySelectorAll('li')].indexOf(li),
                    raw: clone.textContent.includes('[[time:'),
                    markers: root.querySelectorAll('.md-time-marker').length,
                    checkboxes: root.querySelectorAll('input[type=checkbox]').length,
                    text: root.textContent };
            };
            await loadFixture();
            place('li', 1);
            window.frames = [];
            window.recordFrames = true;
            const sample = () => {
                if (!recordFrames) return;
                frames.push(readState());
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await page.keyboard.type('abc');
        await page.waitForTimeout(500);
        const normal = await page.evaluate(() => { recordFrames = false; return { state: readState(), frames }; });
        console.log('normal input:', JSON.stringify(normal.state));
        assert(normal.frames.every(frame => frame.item === 1 && !frame.raw && frame.markers === 2),
            'ordinary typing must keep both markers rendered and the caret in the second item on every frame');
        const cdp = await page.context().newCDPSession(page);
        await page.evaluate(() => {
            place('li', 1);
            frames = [];
            recordFrames = true;
            const sample = () => {
                if (!recordFrames) return;
                frames.push(readState());
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        await cdp.send('Input.imeSetComposition', { text: 'fen', selectionStart: 3, selectionEnd: 3 });
        await cdp.send('Input.imeSetComposition', { text: '\u5206', selectionStart: 1, selectionEnd: 1 });
        await cdp.send('Input.insertText', { text: '\u5206' });
        await page.waitForTimeout(500);
        const committed = await page.evaluate(() => readState());
        console.log('IME commit:', JSON.stringify(committed));
        assert.equal(committed.item, 1);
        assert.equal(committed.markers, 2);
        assert.equal(committed.checkboxes, 2);
        assert(committed.text.includes('\u5206'));
        assert(await page.evaluate(() => {
            recordFrames = false;
            return frames.every(frame => frame.item === 1 && !frame.raw && frame.markers === 2);
        }), 'IME composition and commit must retain markers and caret on every frame');
        await cdp.send('Input.imeSetComposition', { text: '\u4e2d', selectionStart: 1, selectionEnd: 1 });
        await cdp.send('Input.insertText', { text: '\u4e2d' });
        await page.evaluate(() => place('li', 0));
        await page.waitForTimeout(350);
        assert.equal(await page.evaluate(() => readState().item), 0, 'IME completion must not pull the caret back after the user moves it');
        await page.waitForTimeout(900);
        await page.evaluate(() => place('mark.md-mark'));
        await page.keyboard.type('xyz');
        await page.waitForTimeout(1200);
        assert(await page.evaluate(() => {
            const selection = getSelection();
            return selection.anchorNode.parentElement.closest('mark.md-mark')?.textContent === 'highlight textxyz';
        }), 'typing inside a highlight must retain its content and native caret anchor');
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(1200);
        assert(!(await page.evaluate(() => editor.getValue())).includes('xyz'), 'native undo must undo the edit');
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(1200);
        const markdown = await page.evaluate(() => editor.getValue());
        assert(markdown.includes('xyz'), 'native redo must restore the edit');
        assert(!markdown.includes('DUMBPADINLINETOKEN'), 'temporary render tokens must never enter saved Markdown');
        assert.equal((markdown.match(/\[\[time:/g) || []).length, 2);
        assert(markdown.includes('<mark>highlight textxyz</mark>') || markdown.includes('==highlight textxyz=='),
            'highlight serializes to its markdown source form');

        // 软回车之后的 markdown 输入规则：hardBreak 必须被当成换行参与匹配。
        // 回归点：Tiptap 的 input rule runner 用 node.textContent 取"光标前文本"，
        // 而 PM 默认把 inline leaf 塌缩成空串（runner 自己填 "%leaf%" 占位符），
        // 复核步骤又走 textBetween，两边对不上 → 所有"行首或空白"前提的内联规则
        // 在软回车后静默失效。修法是给 hardBreak 声明 leafText = '\n'（经
        // extendNodeSchema 透传，Tiptap 的顶层字段白名单会丢掉它）。
        const inlineRuleCases = [
            ['bold', '**粗体** ', 'strong', 'bold', '粗体'],
            ['italic', '_斜体_ ', 'em', 'italic', '斜体'],
            ['code', '`代码` ', 'code', 'code', '代码']
        ];
        for (const [label, typed, tag, markName, inner] of inlineRuleCases) {
            await page.evaluate(() => editor.setValue('', false));
            await page.waitForTimeout(150);
            await page.evaluate(() => editor.editor.commands.focus('start'));
            await page.keyboard.type('第一行');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(200);
            await page.keyboard.type(typed);
            await page.waitForTimeout(350);
            // 只看渲染 DOM 与 PM mark：getValue() 里 `**` 无论规则是否命中都会出现
            // （mark 会重新序列化回 `**`），所以源码串无法区分这两种情况。
            const observed = await page.evaluate(([t, m]) => {
                const names = [];
                editor.editor.state.doc.descendants(node => {
                    if (node.isText) node.marks.forEach(k => names.push(k.type.name));
                });
                const el = document.querySelector(`#editor ${t}`);
                return { marks: names, rendered: el ? el.textContent : null };
            }, [tag, markName]);
            assert(observed.marks.includes(markName),
                `${label} must still apply after a soft break, marks=${JSON.stringify(observed.marks)}`);
            assert.equal(observed.rendered, inner,
                `${label}: ${tag} must wrap only the marked text (no leftover markers), got ${JSON.stringify(observed.rendered)}`);
        }
        // 段落内换行在纯文本视图里必须可见（复制/搜索依赖 textContent）。
        await page.evaluate(() => editor.setValue('第一行\n第二行', false));
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => editor.editor.state.doc.textContent), '第一行\n第二行',
            'a soft break must read as a newline in the text view');
        assert.deepEqual(errors, []);
        console.log('Editor input browser regression passed');
    } finally {
        await page.close();
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
