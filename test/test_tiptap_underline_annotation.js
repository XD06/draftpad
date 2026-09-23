/**
 * 批注 / 划线的 inline text-decoration 不能被解析成 underline：Tiptap 上游 Underline 的
 * style 规则用 `value.includes('underline')` 判定，而浏览器查 `text-decoration` 时会把长属性
 * （thickness / color / line 型）重新序列化回简写，于是批注的红色波浪线、划线的蓝色下划线都被
 * 额外套上 underline mark——刷新后多出一条直线下划线，并且 `<u>` 会被写回正文。
 *
 * 这里同时固化三件事：① 干净数据刷新后不再产生 underline；② 已经被污染成 `<u><span data-note>`
 * 的老文章刷新后自愈（不再解析出 underline，再保存时 `<u>` 消失）；③ 真正的下划线（`<u>` 标签、
 * `text-decoration:underline`、Mod+U）行为不变，包括「<u> 里混有批注」时正文的下划线不丢。
 * Chrome 的真实序列化由 test/browser/editor-input.js 的批注段覆盖。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Range = dom.window.Range;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.getSelection = dom.window.getSelection.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = () => {};
}
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) console.log(`PASS ${name}`);
    else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
};

const ANNOTATION_STYLE = 'text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;';
const DRAW_STYLE = 'text-decoration:underline blue;text-decoration-thickness:2px;';
// Chrome 会把长属性折进简写后返回（实测 getPropertyValue('text-decoration') 的结果）
const CHROME_ANNOTATION_VALUE = 'underline 2.5px wavy rgb(231, 76, 60)';
const CHROME_DRAW_VALUE = 'underline 2px blue';

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const wrapper = new HybridMarkdownEditor(container, {});
    await wrapper.whenReady();
    const editor = wrapper.editor;
    const view = editor.view;
    const wait = (ms = 450) => new Promise(resolve => setTimeout(resolve, ms));

    /** 文档里出现过的 mark 组合（去重），以及渲染 DOM / 再序列化结果。 */
    const inspect = () => {
        const combos = [];
        editor.state.doc.descendants(node => {
            if (node.isText) combos.push(node.marks.map(m => m.type.name).sort().join('+'));
        });
        return {
            combos: [...new Set(combos)],
            html: container.querySelector('.tiptap').innerHTML,
            value: wrapper.getValue(),
        };
    };

    const load = async (source) => {
        wrapper.setValue(source, false);
        await wait(600);
        return inspect();
    };

    check('the underline mark is still registered (DumbPadUnderline took over)',
        Boolean(editor.schema.marks.underline), Object.keys(editor.schema.marks));

    // 1. 干净的批注：刷新后只有 annotation，不出现 <u>，再保存也不引入 <u>
    {
        const source = `前<span data-note="备注" style="${ANNOTATION_STYLE}">批注</span>后`;
        const after = await load(source);
        check('annotation: reload keeps a single mark', after.combos.includes('annotation')
            && !after.combos.some(c => c.includes('underline')), after);
        check('annotation: no <u> in the rendered DOM', !/<u[ >]/.test(after.html), after.html);
        check('annotation: re-saving does not write <u> back', !after.value.includes('<u>'), after.value);
        check('annotation: the stored form is unchanged', after.value.includes(
            `<span data-note="备注" style="${ANNOTATION_STYLE}">批注</span>`), after.value);
    }

    // 2. 已被老 bug 污染的数据：<u> 自愈消失
    {
        const polluted = `<u><span data-note="备注" style="${ANNOTATION_STYLE}">批注</span></u>`;
        const after = await load(polluted);
        check('polluted annotation: the leftover <u> is not parsed as underline',
            !after.combos.some(c => c.includes('underline')), after);
        check('polluted annotation: no <u> left in the DOM', !/<u[ >]/.test(after.html), after.html);
        check('polluted annotation: the next save drops <u>', !after.value.includes('<u>'), after.value);
        check('polluted annotation: the annotation itself survives',
            after.combos.includes('annotation') && after.value.includes('批注'), after);
    }

    // 3. 划线（data-draw）同理，含污染形态
    {
        const clean = await load(`前<span data-draw style="${DRAW_STYLE}">划线</span>后`);
        check('draw: reload keeps a single mark and no <u>',
            clean.combos.includes('draw') && !clean.combos.some(c => c.includes('underline'))
            && !/<u[ >]/.test(clean.html) && !clean.value.includes('<u>'), clean);
        const polluted = await load(`<u><span data-draw style="${DRAW_STYLE}">划线</span></u>`);
        check('polluted draw: the leftover <u> disappears on the next save',
            polluted.combos.includes('draw')
            && !polluted.combos.some(c => c.includes('underline'))
            && !polluted.value.includes('<u>'), polluted);
    }

    // 4. Chrome 的真实序列化值必须被判定为非下划线
    {
        const annotationLike = await load(`甲<span style="text-decoration: ${CHROME_ANNOTATION_VALUE}">乙</span>`);
        const drawLike = await load(`甲<span style="text-decoration: ${CHROME_DRAW_VALUE}">乙</span>`);
        check('a Chrome-folded wavy/colored decoration is not an underline',
            !annotationLike.combos.some(c => c.includes('underline'))
            && !drawLike.combos.some(c => c.includes('underline')),
            { annotationLike: annotationLike.combos, drawLike: drawLike.combos });
    }

    // 5. 反向保护：真正的下划线三种来源都照旧
    {
        const tag = await load('普通<u>真下划线</u>后');
        check('a real <u> tag still parses as underline',
            tag.combos.includes('underline') && tag.value.includes('<u>真下划线</u>'), tag);
        const style = await load('甲<span style="text-decoration: underline">乙</span>');
        check('a plain text-decoration:underline still parses as underline',
            style.combos.includes('underline'), style);
        const solid = await load('甲<span style="text-decoration: underline solid">乙</span>');
        check('an explicit solid underline still parses as underline',
            solid.combos.includes('underline'), solid);
    }

    // 6. <u> 里混着批注时，正文的下划线不能被当成残留丢掉
    {
        const after = await load(`<u>正文<span data-note="备注" style="${ANNOTATION_STYLE}">批注</span>结尾</u>`);
        check('a <u> with its own text keeps the underline on that text',
            after.combos.includes('underline') && after.combos.includes('annotation+underline'), after);
        check('a <u> with its own text is still written back',
            after.value.includes('<u>') && after.value.includes('正文'), after.value);
    }

    // 7. 继承下来的命令与渲染没有因为 extend 而丢
    {
        wrapper.setValue('下划线测试', false);
        await wait();
        view.dispatch(view.state.tr.setSelection(
            globalThis.DumbPadTiptap.PM.state.TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1),
        ));
        const applied = editor.commands.toggleUnderline();
        await wait();
        const after = inspect();
        check('toggleUnderline still works and renders <u>',
            applied === true && after.html.includes('<u>下划线测试</u>'), { applied, after });
        check('the underline command round-trips through the stored value',
            after.value.includes('<u>下划线测试</u>'), after.value);
    }

    // 8. StarterKit 的原版必须真的被关掉：注册表里只能有一个 underline 扩展。
    //    重名注册不会抛错，只会让 schema 里后一个悄悄覆盖前一个——那样前面的行为断言
    //    可能测的是没被使用的那份，所以这里单独把「只有一份」钉住。
    const underlineExtensions = editor.extensionManager.extensions
        .filter(extension => extension.name === 'underline');
    check('only one underline extension is registered (the StarterKit copy is off)',
        underlineExtensions.length === 1, underlineExtensions.map(extension => extension.name));

    // 9. Mod+U 键位随 extend 继承（关掉 StarterKit 原版后最容易丢的就是这类间接能力）
    {
        wrapper.setValue('快捷键测试', false);
        await wait();
        const doc = view.state.doc;
        view.dispatch(view.state.tr.setSelection(
            globalThis.DumbPadTiptap.PM.state.TextSelection.create(doc, 1, doc.content.size - 1),
        ));
        view.focus();
        view.dom.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'u', code: 'KeyU', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await wait();
        const after = inspect();
        check('Mod+U still toggles the underline mark and serializes back',
            after.combos.includes('underline') && after.value.includes('<u>快捷键测试</u>'), after);
    }

    // 10. 残留识别是**保守**的：只认这个 bug 真正产出的扁平形态。嵌套或夹杂其它内容时
    //     宁可放过（继续保留 underline，用户可以选中按 Mod+U 取消），也绝不误删真下划线。
    {
        const nested = await load(`<u><em><span data-note="备注" style="${ANNOTATION_STYLE}">批注</span></em></u>`);
        check('a nested <u> is left alone rather than guessed at',
            nested.combos.some(c => c.includes('underline'))
            && nested.combos.some(c => c.includes('annotation'))
            && nested.value.includes('批注'), nested);
        const whitespace = await load(`<u>&nbsp;<span data-note="备注" style="${ANNOTATION_STYLE}">批注</span></u>`);
        check('whitespace inside <u> still counts as residue and no text is lost',
            !whitespace.combos.some(c => c.includes('underline'))
            && !/<u[ >]/.test(whitespace.html) && whitespace.value.includes('批注'), whitespace);
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log('\ntiptap annotation underline regression passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
