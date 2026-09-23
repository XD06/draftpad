/**
 * 批注 / 划线的下划线回归（真实浏览器）：只有 Chrome 的 CSSOM 会把 text-decoration-thickness
 * 与颜色折回简写值（`underline 2.5px wavy rgb(231, 76, 60)`），而这正是 Tiptap 上游
 * `value.includes('underline')` 判定误伤的入口。jsdom 的判定值形态不同，所以「刷新后不再多出
 * `<u>`」「老数据里的 `<u>` 自愈」「真下划线仍然渲染成下划线」这三件事必须在真浏览器里各测一遍。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ANNOTATION_STYLE = 'text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;';
const DRAW_STYLE = 'text-decoration:underline blue;text-decoration-thickness:2px;';

module.exports = async function testAnnotationUnderline(browser) {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head>
        <style>body{margin:0}#editor{height:600px}</style>
        </head><body><div id="editor"></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
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
        });

        // 0. 先确认这个浏览器确实会给出那个「含 underline 的简写值」，否则下面的断言毫无意义
        const serialized = await page.evaluate((style) => {
            const el = document.createElement('span');
            el.setAttribute('style', style);
            return el.style.getPropertyValue('text-decoration');
        }, ANNOTATION_STYLE);
        assert.ok(/underline/.test(serialized),
            `expected the browser to fold the shorthand into a value containing "underline", got "${serialized}"`);

        const reload = async (source) => page.evaluate(async (value) => {
            editor.setValue(value, false);
            await new Promise(resolve => setTimeout(resolve, 600));
            const root = editor.container.querySelector('.tiptap');
            const marks = [];
            editor.editor.state.doc.descendants(node => {
                if (node.isText) marks.push(node.marks.map(m => m.type.name).sort().join('+'));
            });
            const underlined = [...root.querySelectorAll('u')]
                .map(el => el.textContent.replace(/\u200B/g, ''));
            return {
                marks: [...new Set(marks)],
                uCount: root.querySelectorAll('u').length,
                underlined,
                html: root.innerHTML,
                value: editor.getValue(),
            };
        }, source);

        // 1. 干净的批注：刷新后不该出现 <u>，再保存也不该写回 <u>
        {
            const after = await reload(`前<span data-note="备注" style="${ANNOTATION_STYLE}">批注</span>后`);
            assert.ok(after.marks.includes('annotation'), `the annotation mark must survive: ${JSON.stringify(after.marks)}`);
            assert.equal(after.uCount, 0, `no <u> may appear after a reload, got ${after.html}`);
            assert.ok(!after.marks.some(m => m.includes('underline')),
                `the annotation must not pick up the underline mark, got ${JSON.stringify(after.marks)}`);
            assert.ok(!after.value.includes('<u>'), `re-saving must not write <u> back, got ${after.value}`);
            assert.ok(after.value.includes(`<span data-note="备注" style="${ANNOTATION_STYLE}">批注</span>`),
                `the stored form must stay byte-identical, got ${after.value}`);
        }

        // 2. 老数据里已被污染的 <u>：解析后消失，下次保存自然清掉
        {
            const after = await reload(`<u><span data-note="备注" style="${ANNOTATION_STYLE}">批注</span></u>`);
            assert.equal(after.uCount, 0, `the leftover <u> must not be parsed, got ${after.html}`);
            assert.ok(!after.marks.some(m => m.includes('underline')),
                `no underline mark may survive the polluted form, got ${JSON.stringify(after.marks)}`);
            assert.ok(!after.value.includes('<u'), `the next save must drop the residue, got ${after.value}`);
            assert.ok(after.value.includes('批注') && after.marks.includes('annotation'),
                `the annotation itself must be intact, got ${JSON.stringify(after)}`);
        }

        // 3. 划线（data-draw）同病同治
        {
            const clean = await reload(`前<span data-draw style="${DRAW_STYLE}">划线</span>后`);
            assert.equal(clean.uCount, 0, `draw must not gain a <u>, got ${clean.html}`);
            assert.ok(!clean.value.includes('<u>'), `draw must not write <u> back, got ${clean.value}`);
            const polluted = await reload(`<u><span data-draw style="${DRAW_STYLE}">划线</span></u>`);
            assert.ok(polluted.uCount === 0 && !polluted.value.includes('<u'),
                `the polluted draw must self-heal, got ${JSON.stringify(polluted)}`);
        }

        // 4. 反向保护：真的下划线还得是真的下划线（computed style 层面）
        {
            const after = await reload('普通<u>真下划线</u>后');
            assert.ok(after.marks.includes('underline'),
                `a real <u> must still parse as underline, got ${JSON.stringify(after.marks)}`);
            assert.deepEqual(after.underlined, ['真下划线'], `the <u> must render, got ${JSON.stringify(after.underlined)}`);
            const line = await page.evaluate(() => {
                const el = editor.container.querySelector('.tiptap u');
                return el ? getComputedStyle(el).textDecorationLine : null;
            });
            assert.equal(line, 'underline', `the rendered text-decoration-line must be underline, got ${line}`);
            assert.ok(after.value.includes('<u>真下划线</u>'), `round-trip must keep it, got ${after.value}`);
        }

        // 5. <u> 里混着批注时，正文的下划线不能被当成残留丢掉
        {
            const after = await reload(`<u>正文<span data-note="备注" style="${ANNOTATION_STYLE}">批注</span>结尾</u>`);
            assert.ok(after.marks.includes('underline') && after.marks.includes('annotation+underline'),
                `a <u> with its own text keeps its underline, got ${JSON.stringify(after.marks)}`);
            assert.ok(after.value.includes('<u>') && after.value.includes('正文'),
                `the mixed <u> must be written back, got ${after.value}`);
            // PM 按「标记相同的连续文本」切 run，所以一段 <u> 里混了批注会渲染成多个 <u>；
            // 要校验的是下划线没有从任何一段上掉下来，而不是 <u> 的个数。
            assert.equal(after.underlined.join(''), '正文批注结尾',
                `every run inside the <u> must stay underlined, got ${JSON.stringify(after.underlined)}`);
        }

        // 6. 用户路径：在编辑器里选中文字加批注，刷新后不该多出 <u>
        {
            const created = await page.evaluate(async () => {
                editor.setValue('这是一个测试', false);
                await new Promise(resolve => setTimeout(resolve, 400));
                const { PM } = globalThis.DumbPadTiptap;
                const tiptap = editor.editor;
                const doc = tiptap.state.doc;
                tiptap.view.dispatch(tiptap.state.tr.setSelection(
                    PM.state.TextSelection.create(doc, 1, doc.content.size - 1),
                ));
                const annotation = tiptap.schema.marks.annotation;
                tiptap.view.dispatch(tiptap.state.tr.addMark(1, doc.content.size - 1,
                    annotation.create({ note: '备注' })));
                await new Promise(resolve => setTimeout(resolve, 400));
                const stored = editor.getValue();
                const reloaded = await (async () => {
                    editor.setValue(stored, false);
                    await new Promise(resolve => setTimeout(resolve, 600));
                    const root = editor.container.querySelector('.tiptap');
                    return { uCount: root.querySelectorAll('u').length, value: editor.getValue() };
                })();
                return { stored, reloaded };
            });
            assert.ok(!created.stored.includes('<u'),
                `applying an annotation must not produce <u>, got ${created.stored}`);
            assert.equal(created.reloaded.uCount, 0,
                `the annotation the user just made must survive a reload without <u>, got ${JSON.stringify(created.reloaded)}`);
            assert.ok(!created.reloaded.value.includes('<u'),
                `and it must not be written back either, got ${created.reloaded.value}`);
        }

        assert.deepEqual(errors, []);
        console.log('Annotation underline browser regression passed');
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
