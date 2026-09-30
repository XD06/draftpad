/**
 * 批注 / 划线的下划线回归（真实浏览器）：只有 Chrome 的 CSSOM 会把 text-decoration-thickness
 * 与颜色折回简写值（`underline 2.5px wavy rgb(231, 76, 60)`），而这正是 Tiptap 上游
 * `value.includes('underline')` 判定误伤的入口。jsdom 的判定值形态不同，所以「刷新后不再多出
 * `<u>`」「老数据里的 `<u>` 自愈」「真下划线仍然渲染成下划线」这三件事必须在真浏览器里各测一遍。
 * 后半段（§7/§8）是样式层的连续性：skip-ink 会不会剪断波浪、画线/高亮跨行内代码时能不能既
 * 保持单元素又留住代码自己的 monospace —— computed 值只有 Chrome 会给。
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
        <link rel="stylesheet" href="/Assets/styles.css">
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

        // 7. 波浪线的「连续性」还有一半在绘制层：Chrome 的 text-decoration-skip-ink
        //    默认 auto，会在空格与标点这类「无墨」处把波浪剪断（观感一节一节）。
        //    这条只能在真浏览器里用 computed 值证明——jsdom 不做样式层计算。
        //    顺带在 Chrome 里复核「一条批注跨行内代码 + 跨链接」渲染成单 span 单徽标
        //    （AnnotationMark 的 priority 抬到 Link 之上）。
        {
            const wave = await page.evaluate(async (value) => {
                editor.setValue(value, false);
                await new Promise(resolve => setTimeout(resolve, 600));
                const root = editor.container.querySelector('.tiptap');
                const outers = [...root.querySelectorAll('.has-annotation')];
                const inners = outers.map(outer => outer.querySelector(':scope > span') || outer);
                return {
                    annotationCount: outers.length,
                    badgeCount: root.querySelectorAll('.annotation-badge').length,
                    skipInk: inners.map(el => getComputedStyle(el).textDecorationSkipInk),
                    lineStyle: inners.map(el => getComputedStyle(el).textDecorationStyle),
                    thickness: inners.map(el => getComputedStyle(el).textDecorationThickness),
                    stored: editor.getValue(),
                };
            }, `<span data-note="连续" style="${ANNOTATION_STYLE}">Use the authenticated API, it preserves versions. 甲 <code>beta()</code> 丙 [链接](https://example.com) 丁</span>`);
            assert.equal(wave.annotationCount, 1,
                `one annotation across code and a link must be one span, got ${JSON.stringify(wave)}`);
            assert.equal(wave.badgeCount, 1,
                `and exactly one badge, got ${wave.badgeCount}`);
            assert.deepEqual(wave.skipInk, ['none'],
                `the wavy run must not be clipped at spaces (text-decoration-skip-ink), got ${JSON.stringify(wave.skipInk)}`);
            assert.deepEqual(wave.lineStyle, ['wavy'],
                `the decoration must stay wavy, got ${JSON.stringify(wave.lineStyle)}`);
            assert.deepEqual(wave.thickness, ['2.5px'],
                `the stored thickness must survive, got ${JSON.stringify(wave.thickness)}`);
            assert.ok(wave.stored.includes('甲 `beta()` 丙 [链接](https://example.com) 丁'),
                `the whole run must serialize as one span, got ${wave.stored}`);

            // 展示形态（分享页 / Thought 卡片）靠内联 style，同一批 CSS 规则要命中它
            const display = await page.evaluate((style) => {
                const host = document.createElement('div');
                host.innerHTML = `<span data-note="x" style="${style}">空格 逗号, 句号.</span>`;
                document.body.appendChild(host);
                const skip = getComputedStyle(host.firstElementChild).textDecorationSkipInk;
                host.remove();
                return skip;
            }, ANNOTATION_STYLE);
            assert.equal(display, 'none',
                `the display form (span[data-note]) must get skip-ink:none too, got ${display}`);
        }

        // 8. 画线/高亮跨行内代码：靠 code.excluded 豁免成为单元素（与批注同一机制），
        //    这里要同时证明两件事——「一次操作 = 一个整体」和「代码自己的样式没被吞掉」。
        //    后者只能看真实 DOM 与 computed 值：`<code>` 必须还在那一个 span/mark 里面。
        for (const piece of [
            { markName: 'draw', selector: '[data-draw]', label: '画线', expectDecoration: 'underline solid 2px' },
            { markName: 'mdHighlight', selector: 'mark.md-mark', label: '高亮', expectBackground: 'rgba(255, 214, 10, 0.35)' },
        ]) {
            const whole = await page.evaluate(async ({ markName, selector }) => {
                const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                const snapshot = () => {
                    const root = editor.container.querySelector('.tiptap');
                    const spans = [...root.querySelectorAll(selector)];
                    return {
                        count: spans.length,
                        codeInside: spans.map(el => el.querySelectorAll('code').length),
                        codeFont: spans.flatMap(el => [...el.querySelectorAll('code')]
                            .map(code => getComputedStyle(code).fontFamily)),
                        decoration: spans.map(el => {
                            const cs = getComputedStyle(el);
                            return `${cs.textDecorationLine} ${cs.textDecorationStyle} ${cs.textDecorationThickness}`;
                        }),
                        painted: spans.map(el => getComputedStyle(el).backgroundColor),
                    };
                };
                editor.setValue('甲 [链接](https://example.com) 乙 `code()` 丙\n', false);
                await wait(400);
                const tiptap = editor.editor;
                const { PM } = globalThis.DumbPadTiptap;
                const doc = tiptap.state.doc;
                tiptap.view.dispatch(tiptap.state.tr.setSelection(
                    PM.state.TextSelection.create(doc, 1, doc.content.size - 1),
                ));
                const markType = tiptap.schema.marks[markName];
                tiptap.view.dispatch(tiptap.state.tr.addMark(
                    1, doc.content.size - 1, markType.create({})));
                await wait(300);
                const typed = snapshot();
                const stored = editor.getValue();
                editor.setValue(stored, false);
                await wait(600);
                return { typed, reloaded: snapshot(), stored };
            }, piece);

            assert.equal(whole.typed.count, 1,
                `${piece.label} crossing code and a link must render one element while typing, got ${JSON.stringify(whole.typed)}`);
            assert.equal(whole.reloaded.count, 1,
                `${piece.label} must still be one element after a reload, got ${JSON.stringify(whole.reloaded)}`);
            assert.deepEqual(whole.typed.codeInside, [1],
                `${piece.label} must keep the inline code inside the single element, got ${JSON.stringify(whole.typed)}`);
            assert.ok(/mono/i.test(whole.typed.codeFont[0] || ''),
                `${piece.label} must not swallow the code's own monospace style, got ${JSON.stringify(whole.typed.codeFont)}`);
            assert.deepEqual(whole.reloaded.codeInside, [1],
                `${piece.label} keeps its code child across a reload, got ${JSON.stringify(whole.reloaded)}`);
            // 各自的「自己的样式」：画线靠 text-decoration，高亮靠 mark 背景（实测值钉住）。
            // 两条都必须打字时 == 刷新后，否则又是一次「取消要点两下」的分裂。
            if (piece.expectDecoration) {
                assert.equal(whole.typed.decoration[0], piece.expectDecoration,
                    `${piece.label} must paint its own decoration, got ${JSON.stringify(whole.typed)}`);
                assert.deepEqual(whole.reloaded.decoration, whole.typed.decoration,
                    `${piece.label} decoration must be identical between typing and reload, got ${JSON.stringify(whole)}`);
            }
            if (piece.expectBackground) {
                assert.equal(whole.typed.painted[0], piece.expectBackground,
                    `${piece.label} must keep its own highlight background, got ${JSON.stringify(whole.typed)}`);
                assert.deepEqual(whole.reloaded.painted, whole.typed.painted,
                    `${piece.label} background must be identical between typing and reload, got ${JSON.stringify(whole)}`);
            }
            assert.ok(whole.stored.includes('`code()`'),
                `${piece.label} must not lose the code text, got ${whole.stored}`);
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
