/**
 * 引用块（`>`）的按键语义回归。旧实现在引用块里按回车会把段落拆开，磁盘上留下
 * `> 甲\n>\n> 乙` 这种「中间一行只有 >」的污染源，刷新后又渲染成一个幽灵空行；
 * 退格则会越过引用块边界，把整行「抬出」引用区，留下空引用块。
 *
 * 现在引用块内的回车与普通段落一致：段内软换行（`> 甲\n> 乙`，中间无空行）；
 * 空视觉行上回车 = 离开引用块（并吃掉刚插入的那个软换行，不留 `> ` 空行）；
 * 行首退格 = 并回上一行（同块内并段，或把上一行与引用行合成一块），而不是退出引用区。
 *
 * 这里断言状态转移与落盘文本；引用块的视觉样式由
 * test/browser/blockquote-quote-style.js 在真实 Chrome 里取 computed style 钉住。
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

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const wrapper = new HybridMarkdownEditor(container, {});
    await wrapper.whenReady();
    const editor = wrapper.editor;
    const view = editor.view;
    const { PM } = globalThis.DumbPadTiptap;
    const TextSelection = PM.state.TextSelection;

    const press = (key) => {
        view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
    };
    const clean = (text) => text.replace(/[\u200B\uFEFF]/g, '');
    /** 顶层块清单；引用块展开成 blockquote>p 的每一行，软换行单独计数。 */
    const blocks = () => {
        const out = [];
        view.state.doc.forEach((node) => {
            if (node.type.name === 'blockquote') {
                const lines = [];
                node.forEach((child) => {
                    let breaks = 0;
                    child.forEach((inline) => { if (inline.type.name === 'hardBreak') breaks += 1; });
                    lines.push({ text: clean(child.textContent), breaks });
                });
                out.push({ type: 'blockquote', lines });
                return;
            }
            let breaks = 0;
            node.forEach((inline) => { if (inline.type.name === 'hardBreak') breaks += 1; });
            out.push({ type: node.type.name, text: clean(node.textContent), breaks });
        });
        return out;
    };
    /** 把光标放到某个文本片段的前（offset=0）或后（offset=len）。 */
    const caretOn = (marker, fromEnd = false) => {
        let target = null;
        view.state.doc.descendants((node, pos) => {
            if (target === null && node.isText && node.text.includes(marker)) {
                target = pos + (fromEnd ? node.text.length : 0);
            }
            return true;
        });
        if (target === null) throw new Error(`marker not found in doc: ${marker}`);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
    };
    const shape = () => JSON.stringify(blocks());

    // 1. 引用块内回车 = 段内软换行，不拆段
    wrapper.setValue('> 甲', false);
    caretOn('甲', true);
    press('Enter');
    check('enter in quote keeps a single paragraph', shape() === JSON.stringify([
        { type: 'blockquote', lines: [{ text: '甲\n', breaks: 1 }] },
        { type: 'paragraph', text: '', breaks: 0 },
    ]), blocks());
    check('enter in quote stays inside the quote',
        view.state.selection.$from.depth === 2 && view.state.selection.$from.node(1).type.name === 'blockquote',
        { depth: view.state.selection.$from.depth });
    check('enter in quote stores no lone ">" line', wrapper.getValue() === '> 甲', wrapper.getValue());

    // 2. 空视觉行上再回车 = 离开引用块，且吃掉刚插入的软换行
    press('Enter');
    check('second enter on the blank visual line exits the quote', shape() === JSON.stringify([
        { type: 'blockquote', lines: [{ text: '甲', breaks: 0 }] },
        { type: 'paragraph', text: '', breaks: 0 },
    ]), blocks());
    check('exiting the quote leaves no phantom blank line in markdown',
        wrapper.getValue() === '> 甲', wrapper.getValue());
    check('caret after exit is outside the quote',
        view.state.selection.$from.depth === 1 && view.state.selection.$from.parent.type.name === 'paragraph',
        { depth: view.state.selection.$from.depth });

    // 3. 退出后继续打字：新的普通段落，不回到引用块
    press('Enter');
    view.dispatch(view.state.tr.insertText('乙', view.state.selection.from, view.state.selection.to));
    check('typing after exit produces a plain paragraph',
        view.state.doc.lastChild.type.name === 'paragraph'
        && clean(view.state.doc.lastChild.textContent) === '乙'
        && /^> 甲\n\n乙\n*$/.test(wrapper.getValue()), { value: wrapper.getValue(), doc: shape() });

    // 4. 老数据自愈：`> 甲\n>\n> 乙` 的第二段行首退格 = 并回上一行，仍在引用内
    wrapper.setValue('> 甲\n>\n> 乙', false);
    check('legacy quote parses into two paragraphs', blocks()[0].lines.length === 2, blocks());
    caretOn('乙');
    press('Backspace');
    check('backspace at the head of a legacy quote line joins it back', shape() === JSON.stringify([
        { type: 'blockquote', lines: [{ text: '甲乙', breaks: 0 }] },
        { type: 'paragraph', text: '', breaks: 0 },
    ]), blocks());
    check('joined quote line stores as a single ">" line', wrapper.getValue() === '> 甲乙', wrapper.getValue());

    // 5. 单段引用 + 上面是普通段落：行首退格 = 并回上一行，引用壳消失且不留空行
    wrapper.setValue('前言\n\n> 甲', false);
    caretOn('甲');
    press('Backspace');
    check('backspace merges the quote line into the previous block', shape() === JSON.stringify([
        { type: 'paragraph', text: '前言甲', breaks: 0 },
        { type: 'paragraph', text: '', breaks: 0 },
    ]), blocks());
    check('merging leaves no empty quote and no blank line',
        wrapper.getValue() === '前言甲', wrapper.getValue());
    check('caret after merge sits at the join point',
        clean(view.state.selection.$from.parent.textBetween(0, view.state.selection.$from.parentOffset)) === '前言',
        { text: clean(view.state.selection.$from.parent.textBetween(0, view.state.selection.$from.parentOffset)) });

    // 6. 文档以引用开头：行首退格 = 默认「离开引用」，但不能留下空引用块
    wrapper.setValue('> 甲', false);
    caretOn('甲');
    press('Backspace');
    check('backspace in a leading quote lifts the line out', view.state.doc.firstChild.type.name === 'paragraph'
        && clean(view.state.doc.firstChild.textContent) === '甲', blocks());
    check('lifting out removes the now-empty quote',
        !wrapper.getValue().includes('>'), wrapper.getValue());

    // 7. 引用块里的软换行往返稳定：存盘 → 重解析 → 行数与断点数不变
    wrapper.setValue('> 甲\n> 乙', false);
    check('single ">" line with two visible lines parses to one paragraph',
        blocks()[0].lines.length === 1 && blocks()[0].lines[0].text.replace(/\s/g, '') === '甲乙', blocks());
    const roundTripValue = wrapper.getValue();
    wrapper.setValue(roundTripValue, false);
    check('quote round-trip is stable', wrapper.getValue() === roundTripValue,
        { before: roundTripValue, after: wrapper.getValue() });

    // 8. 非引用块的按键语义不受影响：列表项回车仍是拆块
    wrapper.setValue('- 甲', false);
    caretOn('甲', true);
    press('Enter');
    check('list item still splits on enter (scope not over-broad)',
        view.state.doc.firstChild.type.name === 'bulletList'
        && view.state.doc.firstChild.childCount === 2, blocks());

    // 9. 标题里的回车仍然拆块（引用规则没有误伤其它父节点）
    wrapper.setValue('# 甲', false);
    caretOn('甲', true);
    press('Enter');
    check('heading still splits on enter', view.state.doc.childCount >= 2
        && view.state.doc.lastChild.type.name === 'paragraph', blocks());

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log('\nAll blockquote input checks passed.');
}

main().catch((error) => {
    console.error('FAILED', error);
    process.exitCode = 1;
});
