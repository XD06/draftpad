/**
 * Mermaid 实时预览回归（真实浏览器）。老实现的死因很具体：代码块 NodeView 渲染出的
 * `<code>` 只有 `hljs` 类，语言只存在 `node.attrs.language` 里，所以旧
 * `renderMermaidDiagrams()` 的 `.tiptap pre code.language-mermaid` 选择器永远命中 0 个
 * 节点——图从来没画出来过，还不报错。现在渲染由 NodeView 自己管：光标在块内看源码，
 * 离开块看图，语法错误保留源码 + 一行提示，主题切换重画，存储里永远只有源码。
 *
 * 这些都是异步渲染 + 真 CSS 可见性，jsdom 证不了，必须在 Chrome 里跑。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const GOOD = '```mermaid\ngraph TD;\nA[开始]-->B[结束];\n```';
const BROKEN = '```mermaid\ngraph TD;\nA[开始]- ->>B[结束];\n```';
const PLAIN = '```js\nconst answer = 42;\n```';

module.exports = async function testMermaidPreview(browser) {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head><meta charset="utf-8">
        <link rel="stylesheet" href="/Assets/styles.css">
        <link rel="stylesheet" href="/Assets/ios-theme.css">
        <style>body{margin:0}#editor{height:700px}</style>
        </head><body><div class="typora-editor-shell"><div id="editor"></div></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
    app.use(express.static(path.join(root, 'public')));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    const deadRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        // 资源 404 由 response 监听单独记账，别和真正的脚本错误混在一起。
        if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
            errors.push(`console: ${message.text()}`);
        }
    });
    page.on('response', (response) => {
        if (response.status() >= 400 && !/favicon\.ico$/.test(response.url())) {
            deadRequests.push(`${response.status()} ${response.url()}`);
        }
    });

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(async () => {
            const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
            window.editor = new HybridMarkdownEditor(document.querySelector('#editor'));
            await editor.whenReady();
        });

        const run = await page.evaluate(async ([good, broken, plain]) => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const waitFor = async (fn, timeout = 30000) => {
                const started = Date.now();
                for (;;) {
                    const value = fn();
                    if (value) return value;
                    if (Date.now() - started > timeout) return null;
                    await sleep(120);
                }
            };
            const wrapper = () => document.querySelector('.tiptap .vditor-wysiwyg__block[data-type="code-block"]');
            const svg = () => wrapper()?.querySelector('.dumbpad-mermaid-render svg') || null;
            const visible = (el) => Boolean(el) && el.getClientRects().length > 0
                && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
            const paint = () => ({
                classes: wrapper()?.className || '',
                preview: Boolean(wrapper()?.classList.contains('is-mermaid-preview')),
                editing: Boolean(wrapper()?.classList.contains('is-mermaid-editing')),
                error: Boolean(wrapper()?.classList.contains('dumbpad-mermaid-error')),
                hint: wrapper()?.querySelector('.mermaid-error-hint')?.textContent || '',
                hintVisible: visible(wrapper()?.querySelector('.mermaid-error-hint')),
                preVisible: visible(wrapper()?.querySelector('pre')),
                renderVisible: visible(wrapper()?.querySelector('.dumbpad-mermaid-render')),
                svgText: svg()?.textContent || '',
                rectFill: svg()?.querySelector('rect')
                    ? getComputedStyle(svg().querySelector('rect')).fill : '',
            });
            const mermaidBlockStart = () => {
                let position = null;
                editor.editor.state.doc.descendants((node, pos) => {
                    if (position === null && node.type.name === 'codeBlock'
                        && String(node.attrs.language || '').toLowerCase() === 'mermaid') {
                        position = pos;
                    }
                    return true;
                });
                if (position === null) throw new Error('no mermaid code block in doc');
                return position;
            };
            const caret = async (inside) => {
                const start = mermaidBlockStart();
                editor.editor.commands.setTextSelection(inside
                    ? start + 1
                    : editor.editor.state.doc.content.size);
                editor.editor.commands.focus();
                await sleep(320);
            };
            const stored = [];
            const load = async (value) => {
                editor.setValue(value, false);
                await sleep(420);
                stored.push(editor.getValue());
            };
            const out = {};

            // 1. 空闲态：图已经画出来，源码被藏起来
            await load(good);
            out.rendered = await waitFor(() => (svg() ? paint() : null));

            // 2. 光标进块：回到源码
            await caret(true);
            out.focused = paint();

            // 3. 在块里改源码，离开块：图跟着变
            const end = mermaidBlockStart()
                + editor.editor.state.doc.nodeAt(mermaidBlockStart()).nodeSize - 1;
            // 走 PM 的纯文本插入（= 真打字的落点）。注意别用 commands.insertContent：
            // 它按 HTML 解析字符串，会把 `>` 变成 `&gt;`，那是测试脚手架的假故障。
            editor.editor.view.dispatch(editor.editor.state.tr.insertText('\nB-->C[分支];', end, end));
            await sleep(400);
            out.editingSource = String(editor.editor.state.doc.nodeAt(mermaidBlockStart())?.textContent || '')
                .includes('分支');
            out.stillSourceWhileEditing = paint();
            await caret(false);
            out.reRendered = await waitFor(() => (svg()?.textContent.includes('分支') ? paint() : null));
            stored.push(editor.getValue());

            // 4. 主题切换：同一份源码重画成暗色
            out.beforeTheme = paint();
            document.documentElement.setAttribute('data-theme', 'dark');
            await sleep(160);
            out.afterTheme = await waitFor(() => {
                const state = paint();
                return state.rectFill && state.rectFill !== out.beforeTheme.rectFill ? state : null;
            });
            document.documentElement.removeAttribute('data-theme');
            await sleep(260);

            // 5. 语法错误：保留源码 + 一行提示，不画错误图
            await load(broken);
            out.broken = await waitFor(() => (wrapper().classList.contains('dumbpad-mermaid-error') ? paint() : null));
            out.brokenValue = editor.getValue();

            // 6. 阅读模式：不可编辑，但图必须在
            await load(good);
            await waitFor(() => (svg() ? true : null));
            editor.setReadingMode(true);
            await sleep(420);
            out.reading = paint();
            editor.setReadingMode(false);
            await sleep(220);

            // 7. 普通代码块：一个 mermaid 类都不许出现
            await load(plain);
            out.plain = paint();
            out.storedNeverHoldsSvg = stored.every(value => !value.includes('<svg'));
            return out;
        }, [GOOD, BROKEN, PLAIN]);

        // 1. 预览态
        assert.ok(run.rendered, 'the diagram must render without any user interaction');
        assert.equal(run.rendered.preview, true, `preview class expected: ${JSON.stringify(run.rendered)}`);
        assert.equal(run.rendered.editing, false, 'the block is not focused, so source must stay hidden');
        assert.equal(run.rendered.preVisible, false, `source must be hidden in preview: ${JSON.stringify(run.rendered)}`);
        assert.equal(run.rendered.renderVisible, true, 'the rendered svg must be visible');
        assert.ok(run.rendered.svgText.includes('开始') && run.rendered.svgText.includes('结束'),
            `the diagram must carry the labels from the source: ${run.rendered.svgText}`);
        assert.ok(/rgb\(/.test(run.rendered.rectFill), `a themed rect expected, got ${run.rendered.rectFill}`);

        // 2. 光标进块 = 回到源码（Typora 式实时编辑）
        assert.equal(run.focused.editing, true, `editing class expected: ${JSON.stringify(run.focused)}`);
        assert.equal(run.focused.preview, false, 'the source and the picture never show at once');
        assert.equal(run.focused.preVisible, true, `the source must be editable: ${JSON.stringify(run.focused)}`);

        // 3. 改完源码离开块 = 图重画
        assert.equal(run.editingSource, true, 'the typed source must land in the document');
        assert.equal(run.stillSourceWhileEditing.preVisible, true,
            'the source stays on screen while the caret is inside the block');
        assert.ok(run.reRendered, 'leaving the block must re-render the edited diagram');
        assert.ok(run.reRendered.svgText.includes('分支'),
            `the new label must show up in the picture: ${run.reRendered.svgText}`);
        assert.equal(run.reRendered.preVisible, false, 'and the source hides again');

        // 4. 主题切换
        assert.ok(run.afterTheme, `a re-render on theme change expected, before=${run.beforeTheme.rectFill}`);
        assert.notEqual(run.afterTheme.rectFill, run.beforeTheme.rectFill,
            `dark theme must reach the picture: ${run.beforeTheme.rectFill} -> ${run.afterTheme.rectFill}`);

        // 5. 坏语法不吞内容
        assert.ok(run.broken, 'a syntax error must be reported');
        assert.equal(run.broken.error, true);
        assert.equal(run.broken.svgText, '', 'no picture may be painted from broken source');
        assert.ok(run.broken.hint.trim().length > 0 && run.broken.hintVisible,
            `a visible hint is required: ${JSON.stringify(run.broken)}`);
        assert.ok(run.brokenValue.includes('- ->>') && run.brokenValue.includes('```mermaid'),
            `the source must survive a failed render: ${run.brokenValue}`);

        // 6. 阅读模式看图
        assert.equal(run.reading.preview, true, `reading mode must show the picture: ${JSON.stringify(run.reading)}`);
        assert.equal(run.reading.editing, false, 'reading mode can never be "editing"');
        assert.equal(run.reading.renderVisible, true);
        assert.equal(run.reading.preVisible, false);

        // 7. 别的代码块零参与
        assert.equal(/mermaid/.test(run.plain.classes), false,
            `a js code block must stay untouched: ${run.plain.classes}`);
        assert.equal(run.plain.renderVisible, false);
        assert.equal(run.plain.preVisible, true, 'normal code blocks keep showing their source');
        // 只钉脚本与样式：脚手架页面没有 app 的全部资源，字体/图标 404 与本用例无关。
        assert.deepEqual(deadRequests.filter(entry => /\.(js|css)(\?|$)/.test(entry)), [],
            `no script or stylesheet may 404: ${deadRequests.join(' | ')}`);

        // 存储里永远只有源码：任何一次落盘形态都不许混进 svg
        assert.equal(run.storedNeverHoldsSvg, true);
        assert.ok(!run.brokenValue.includes('<svg'), 'a failed render must not write markup either');

        assert.deepEqual(errors, []);
        console.log('Mermaid live preview browser regression passed');
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
