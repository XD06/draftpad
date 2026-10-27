/**
 * 待办三态（`- [ ] 未完成` / `- [~] 进行中` / `- [x] 已完成`）回归（jsdom）：
 * 1) `- [~] 甲` 解析成 taskItem（checked=false, doing=true），不是普通列表 + 字面
 *    "[~] 甲"（后者保存会把标记转义成 `- \[~\~\] 甲`，一次刷新改坏一次文档）；
 * 2) 往返逐字节稳定：`- [~] 甲` 解析 → 序列化仍是 `- [~] 甲`；
 * 3) 三态混排、嵌套条目、行内标记（粗体/行内代码）都保住；
 * 4) `[~]甲`（粘连）与 `[ ]` 口径一致，仍是字面文本；
 * 5) 点击复选框：进行中被勾上 = 已完成（doing 归零），取消勾选 = 未完成；
 * 6) 键入 `- [~] ` 当场得到进行中任务项；
 * 7) `doing` 不写进 DOM 渲染属性、也不污染 markdown（只有 checked 进源码）。
 * 真机浏览器回归另由 test/browser/* 覆盖真实鼠标与 computed style。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

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

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const makeEditor = async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const wrapper = new HybridMarkdownEditor(container, {});
        await wrapper.whenReady();
        return wrapper;
    };
    /** 顶层与嵌套全部 taskItem 的状态清单（文档顺序）。 */
    const states = (wrapper) => {
        const out = [];
        wrapper.editor.state.doc.descendants((node) => {
            if (node.type.name === 'taskItem') {
                out.push({
                    text: node.textContent,
                    checked: Boolean(node.attrs.checked),
                    doing: node.attrs.doing === true,
                });
            }
            return true;
        });
        return out;
    };

    /* 1. 进行中解析成任务项（而不是普通列表 + 字面 "[~] "） */
    {
        const wrapper = await makeEditor();
        wrapper.setValue('- [~] 甲', false);
        check('doing: parses as a taskItem', JSON.stringify(states(wrapper))
            === JSON.stringify([{ text: '甲', checked: false, doing: true }]), states(wrapper));
        check('doing: serialize is byte-identical', wrapper.getValue() === '- [~] 甲', wrapper.getValue());
    }

    /* 2. 三态混排 + 往返稳定 */
    {
        const wrapper = await makeEditor();
        const source = '- [ ] 未完成\n- [~] 进行中\n- [x] 已完成';
        wrapper.setValue(source, false);
        check('three states: parsed in order', JSON.stringify(states(wrapper)) === JSON.stringify([
            { text: '未完成', checked: false, doing: false },
            { text: '进行中', checked: false, doing: true },
            { text: '已完成', checked: true, doing: false },
        ]), states(wrapper));
        check('three states: round-trip byte-identical', wrapper.getValue() === source, wrapper.getValue());
        wrapper.setValue(wrapper.getValue(), false);
        check('three states: second round is stable', wrapper.getValue() === source, wrapper.getValue());
    }

    /* 3. 行内标记与嵌套条目 */
    {
        const wrapper = await makeEditor();
        const marked = '- [~] **粗体** 与 `代码`';
        wrapper.setValue(marked, false);
        const marks = [];
        wrapper.editor.state.doc.descendants((node) => {
            if (node.isText && node.marks.length) marks.push(node.marks.map(mark => mark.type.name).join('+'));
            return true;
        });
        check('inline marks survive the doing rewrite', marks.includes('bold') && marks.includes('code'), marks);
        check('inline marks: round-trip byte-identical', wrapper.getValue() === marked, wrapper.getValue());

        const nested = '- [~] 父\n  - [~] 子\n  - [x] 子完成';
        wrapper.setValue(nested, false);
        check('nested doing items keep their own state', JSON.stringify(states(wrapper)) === JSON.stringify([
            { text: '父子子完成', checked: false, doing: true },
            { text: '子', checked: false, doing: true },
            { text: '子完成', checked: true, doing: false },
        ]), states(wrapper));
        check('nested: round-trip byte-identical', wrapper.getValue() === nested, wrapper.getValue());
    }

    /* 4. 粘连写法与 `[ ]` 口径一致：仍是字面文本（不静默改内容） */
    {
        const wrapper = await makeEditor();
        wrapper.setValue('- [~]甲', false);
        check('glued mark stays a plain list item', states(wrapper).length === 0, states(wrapper));
    }

    /* 5. 点击复选框：进行中 → 已完成 → 未完成 */
    {
        const wrapper = await makeEditor();
        wrapper.setValue('- [~] 甲', false);
        const firstBox = () => wrapper.editor.view.dom.querySelector('ul[data-type="taskList"] > li > label input');
        const firstItem = () => wrapper.editor.view.dom.querySelector('ul[data-type="taskList"] > li');
        check('checkbox renders as indeterminate while doing', firstBox().indeterminate === true
            && firstBox().checked === false);
        firstBox().checked = true;
        firstBox().dispatchEvent(new dom.window.Event('change'));
        check('checking a doing item marks it done', wrapper.getValue() === '- [x] 甲', wrapper.getValue());
        const boxAfter = firstItem().querySelector('input');
        check('done item is no longer indeterminate', boxAfter.indeterminate === false && boxAfter.checked === true);
        boxAfter.checked = false;
        boxAfter.dispatchEvent(new dom.window.Event('change'));
        check('unchecking a done item returns to plain todo', wrapper.getValue() === '- [ ] 甲', wrapper.getValue());
    }

    /* 6. 键入 `- [~] ` 当场得到进行中（与 `- [ ] ` 同一条输入规则） */
    {
        const wrapper = await makeEditor();
        const view = wrapper.editor.view;
        const type = (text) => {
            const { from, to } = view.state.selection;
            let handled = false;
            view.someProp('handleTextInput', (f) => {
                handled = f(view, from, to, text, () => view.state.tr.insertText(text)) || handled;
            });
            if (!handled) view.dispatch(view.state.tr.insertText(text));
        };
        wrapper.setValue('', false);
        type('-');
        type(' ');
        type('[');
        type('~');
        type(']');
        type(' ');
        check('typing "- [~] " creates a doing task item',
            JSON.stringify(states(wrapper)) === JSON.stringify([{ text: '', checked: false, doing: true }]),
            states(wrapper));
        type('甲');
        check('typing "- [~] 甲" round-trips', wrapper.getValue() === '- [~] 甲', wrapper.getValue());
    }

    /* 7. 复选框与文字的光学对齐只能靠 `top` 平移（真机 Chrome 量：1.71px → 0.01px）。
     *    钉住两件事：① 这条规则存在；② 它**不许**改成 padding/margin 之类的布局属性
     *    ——那会把 li 高度从 33.65 顶到 36.81，破坏退格阶梯依赖的行距不变式。 */
    {
        const css = fs.readFileSync(path.join(ROOT, 'public/Assets/styles.css'), 'utf8');
        const rule = css.match(/\.typora-editor-shell \.vditor-reset ul\[data-type="taskList"\] li > label input \{([\s\S]*?)\}/);
        check('checkbox rule exists', Boolean(rule));
        const body = rule ? rule[1] : '';
        check('checkbox is optically centered with a paint-only offset',
            /top:\s*-1\.7px/.test(body) && /position:\s*relative/.test(body), body.trim());
        check('checkbox alignment does not touch layout (no vertical padding / margin shift)',
            !/(^|[;{\s])padding(-top|-bottom)?\s*:/.test(body)
            && !/margin(-top|-bottom)?\s*:\s*[^;]*\d/.test(body.replace(/margin:\s*2px 0\.3em 0\.15em 0/, '')),
            body.trim());
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll three-state task list checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
