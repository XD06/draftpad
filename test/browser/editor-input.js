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
        // 软换行之后的「视觉行首」输入块标记必须当场拆块。回归点：官方块级输入规则全是
        // `^` 锚定，只认 PM 块首，而软换行不是块首——曾经 `# `/`- `/`1. `/`> ` 在软回车
        // 之后只留字面文本，要刷新（重新解析）才变成标题/列表/引用。这里用真实按键验证
        // 「打字时 == 刷新后」；规则的细节分支在 test/test_tiptap_soft_enter_block_rules.js。
        const blockRuleCases = [
            ['# ', 'heading', '第一行\n\n# 标题'],
            ['- ', 'bulletList', '第一行\n\n- 项目'],
            ['3. ', 'orderedList', '第一行\n\n3. 第三步'],
            ['> ', 'blockquote', '第一行\n\n> 引用'],
        ];
        for (const [marker, blockType, expectedMarkdown] of blockRuleCases) {
            const tail = expectedMarkdown.split('\n').pop().replace(/^[#>\d.\-\s]+/, '');
            await page.evaluate(() => editor.setValue('第一行', false));
            await page.waitForTimeout(150);
            await page.evaluate(() => editor.editor.commands.focus('end'));
            await page.keyboard.press('Enter');
            await page.waitForTimeout(200);
            await page.keyboard.type(`${marker}${tail}`);
            await page.waitForTimeout(350);
            const typed = await page.evaluate(() => {
                const blocks = [];
                editor.editor.state.doc.forEach(node => blocks.push({
                    type: node.type.name,
                    level: node.attrs?.level ?? null,
                    text: node.textContent,
                }));
                let breaks = 0;
                editor.editor.state.doc.descendants(node => {
                    if (node.type.name === 'hardBreak') breaks += 1;
                });
                return { blocks, breaks, value: editor.getValue() };
            });
            assert.deepEqual(typed.blocks.slice(0, 2), [
                { type: 'paragraph', level: null, text: '第一行' },
                { type: blockType, level: blockType === 'heading' ? 1 : null, text: tail },
            ], `${marker} after a soft break must split the line into a ${blockType}: ${JSON.stringify(typed.blocks)}`);
            assert.equal(typed.breaks, 0, `${marker}: the soft break is consumed by the split, none left behind`);
            assert.equal(typed.value, expectedMarkdown, `${marker}: saved markdown`);
            // 打字结果与刷新（重新解析）结果必须一致——这正是用户报的「要刷新才渲染」
            await page.evaluate(async (value) => {
                editor.setValue(value, false);
                await new Promise(resolve => setTimeout(resolve, 350));
            }, expectedMarkdown);
            const reloaded = await page.evaluate(() => {
                const blocks = [];
                editor.editor.state.doc.forEach(node => blocks.push({ type: node.type.name, text: node.textContent }));
                return blocks;
            });
            assert.deepEqual(reloaded.slice(0, 2), typed.blocks.slice(0, 2).map(b => ({ type: b.type, text: b.text })),
                `${marker}: typing must produce exactly what a reload produces`);
        }
        // 反向：标记打在视觉行中间（不是行首）不得拆块
        await page.evaluate(() => editor.setValue('第一行', false));
        await page.waitForTimeout(150);
        await page.evaluate(() => editor.editor.commands.focus('end'));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('正文# 不是标题');
        await page.waitForTimeout(350);
        const midLine = await page.evaluate(() => {
            const blocks = [];
            editor.editor.state.doc.forEach(node => blocks.push({ type: node.type.name, text: node.textContent }));
            return { blocks, value: editor.getValue() };
        });
        assert.equal(midLine.blocks.length, 1, `a marker mid-line must not split: ${JSON.stringify(midLine.blocks)}`);
        assert.equal(midLine.blocks[0].type, 'paragraph');
        assert.equal(midLine.blocks[0].text, '第一行\n正文# 不是标题');

        // 分隔线的实时转换（DividerInputShortcut）。回归点：官方 HorizontalRule 的 find 是
        // `^` 锚 PM 块首，而 Enter 造的是段内 <br>，所以 `第一行` + Enter + `---` 曾经只留
        // 字面文本，序列化成 `第一行\n---`，**重新解析被 setext 当成标题下划线**（第一行静默
        // 变二级标题）。规则细节见 test/test_tiptap_divider_input.js。
        await page.evaluate(() => editor.setValue('第一行', false));
        await page.waitForTimeout(150);
        await page.evaluate(() => editor.editor.commands.focus('end'));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('---');
        await page.waitForTimeout(350);
        const dividerTyped = await page.evaluate(() => {
            const blocks = [];
            editor.editor.state.doc.forEach(node => blocks.push({ type: node.type.name, text: node.textContent }));
            let breaks = 0;
            editor.editor.state.doc.descendants(node => {
                if (node.type.name === 'hardBreak') breaks += 1;
            });
            return { blocks, breaks, rendered: document.querySelectorAll('#editor .tiptap hr').length, value: editor.getValue() };
        });
        assert.equal(dividerTyped.value, '第一行\n\n---', `typing --- must land a thematic break: ${JSON.stringify(dividerTyped)}`);
        assert.equal(dividerTyped.blocks[1]?.type, 'horizontalRule', JSON.stringify(dividerTyped.blocks));
        assert.equal(dividerTyped.breaks, 0, 'the soft break must be consumed by the split');
        assert.equal(dividerTyped.rendered, 1, 'the divider must be a real <hr> in the rendered DOM');
        await page.evaluate(async () => {
            editor.setValue(editor.getValue(), false);
            await new Promise(resolve => setTimeout(resolve, 350));
        });
        const dividerReloaded = await page.evaluate(() => {
            const blocks = [];
            editor.editor.state.doc.forEach(node => blocks.push({ type: node.type.name, text: node.textContent }));
            return blocks;
        });
        assert.deepEqual(dividerReloaded, dividerTyped.blocks,
            `typing --- must equal a reload: ${JSON.stringify({ dividerTyped: dividerTyped.blocks, dividerReloaded })}`);
        // 反向：`***` / `___` 不带尾随空格不接管（护住 ***重点***）
        await page.evaluate(() => editor.setValue('第一行', false));
        await page.waitForTimeout(150);
        await page.evaluate(() => editor.editor.commands.focus('end'));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('***重点***');
        await page.waitForTimeout(350);
        const emphasisKept = await page.evaluate(() => ({
            hr: document.querySelectorAll('#editor .tiptap hr').length,
            value: editor.getValue(),
        }));
        assert.equal(emphasisKept.hr, 0, `*** must not become a divider: ${JSON.stringify(emphasisKept)}`);
        assert(!/^第一行\n\n#/.test(emphasisKept.value.replace(/\*+/g, '*')), JSON.stringify(emphasisKept));

        // 文首手打 --- 当场转正为 frontmatter 块（FrontmatterLeadInputShortcut）：
        // 与粘贴、setValue 同一存储形态，且退出/序列化都沿用代码块。
        await page.evaluate(() => editor.setValue('', false));
        await page.waitForTimeout(150);
        await page.evaluate(() => editor.editor.commands.focus('start'));
        await page.keyboard.type('---');
        await page.waitForTimeout(350);
        const fmTyped = await page.evaluate(() => {
            const blocks = [];
            editor.editor.state.doc.forEach(node => blocks.push({
                type: node.type.name,
                language: node.attrs?.language ?? null,
                text: node.textContent.replace(/[\u200B\uFEFF]/g, ''),
            }));
            return {
                blocks,
                caret: editor.editor.state.selection.$from.parent.type.name,
                // NodeView \u7684\u6E32\u67D3\u5F62\u6001\uFF1A\u4EE3\u7801\u5757\u5916\u58F3 + \u8BED\u8A00\u5FBD\u6807 token\uFF08`<code>` \u4E0A\u53EA\u6709 hljs\uFF0C
                // \u6CA1\u6709 language-* \u2014\u2014 \u522B\u6309 markdown \u89E3\u6790\u51FA\u7684 HTML \u53BB\u65AD\u8A00\uFF09
                shells: document.querySelectorAll('#editor .tiptap [data-type="code-block"]').length,
                badge: document.querySelectorAll('#editor .dumbpad-code-language-token[data-language-label="frontmatter"]').length,
            };
        });
        assert.deepEqual(fmTyped.blocks.slice(0, 1), [
            { type: 'codeBlock', language: 'dumbpad-frontmatter', text: '' },
        ], `--- at the very start must become the frontmatter block: ${JSON.stringify(fmTyped.blocks)}`);
        assert.equal(fmTyped.caret, 'codeBlock', 'the caret must land inside the new block');
        assert.equal(fmTyped.shells, 1, `the block must render one code-block shell: ${JSON.stringify(fmTyped)}`);
        assert.equal(fmTyped.badge, 1, `the language badge must read frontmatter: ${JSON.stringify(fmTyped)}`);
        await page.keyboard.type('title: 我的文档标题');
        await page.waitForTimeout(300);
        const fmSource = await page.evaluate(() => editor.getValue());
        assert.equal(fmSource, '---\ntitle: 我的文档标题\n---\n', JSON.stringify(fmSource));
        await page.evaluate(async (value) => {
            editor.setValue(value, false);
            await new Promise(resolve => setTimeout(resolve, 350));
        }, fmSource);
        const fmReloaded = await page.evaluate(() => {
            const blocks = [];
            editor.editor.state.doc.forEach(node => blocks.push({
                type: node.type.name,
                language: node.attrs?.language ?? null,
                text: node.textContent.replace(/[\u200B\uFEFF]/g, ''),
            }));
            return { blocks, value: editor.getValue() };
        });
        assert.equal(fmReloaded.blocks[0].type, 'codeBlock', JSON.stringify(fmReloaded.blocks));
        assert.equal(fmReloaded.blocks[0].language, 'dumbpad-frontmatter', JSON.stringify(fmReloaded.blocks));
        assert.equal(fmReloaded.value, fmSource, 'typed frontmatter must round-trip through a reload unchanged');

        // 撤销历史：载入文章不是撤销步骤（回归「Ctrl+Z 把整篇清空」）。
        // 编辑器以 content:'' 创建、正文靠 setContent 灌进来，那一步曾经进历史，
        // 于是打开文章后按一次 Ctrl+Z 就撤掉载入本身。这里必须用**干净的第二个实例**：
        // 上面那些用例都在同一个 editor 里打字，撤销栈早就非空，断言 can().undo() 会假失败。
        await page.evaluate(async () => {
            const holder = document.createElement('div');
            holder.id = 'undo-editor';
            holder.style.height = '400px';
            document.body.appendChild(holder);
            const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
            window.undoEditor = new HybridMarkdownEditor(holder);
            await undoEditor.whenReady();
            undoEditor.setValue('# 我的文章\n\n这是正文内容。', false);
            await new Promise(resolve => setTimeout(resolve, 350));
        });
        const undoPre = await page.evaluate(() => ({
            value: undoEditor.getValue(),
            canUndo: undoEditor.editor.can().undo(),
        }));
        assert.equal(undoPre.canUndo, false, `loading an article must not be undoable: ${JSON.stringify(undoPre)}`);
        await page.evaluate(() => undoEditor.editor.commands.focus('end'));
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => undoEditor.getValue()), '# 我的文章\n\n这是正文内容。',
            'Ctrl+Z right after opening must not blank the article');
        await page.evaluate(() => undoEditor.editor.commands.focus('end'));
        await page.keyboard.type('再写一句话');
        await page.waitForTimeout(600);
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(400);
        const undoTyped = await page.evaluate(() => undoEditor.getValue());
        assert.equal(undoTyped, '# 我的文章\n\n这是正文内容。',
            `a real Ctrl+Z must step back only the typing: ${JSON.stringify(undoTyped)}`);
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(400);
        assert((await page.evaluate(() => undoEditor.getValue())).includes('再写一句话'),
            'a real Ctrl+Y must redo the typing again');

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
