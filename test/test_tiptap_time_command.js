/**
 * Tiptap 适配器 /time 命令黑盒测试：普通段落内 "/time" + Enter 替换为
 * 时间标记节点，序列化回到 [[time:create:*]] token；非命令段落 Enter 不受影响。
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
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
    const placeCaret = (pos) => {
        const doc = editor.editor.state.doc;
        editor.editor.view.dispatch(
            editor.editor.state.tr.setSelection(TextSelection.create(doc, Math.max(0, Math.min(pos, doc.content.size))))
        );
    };
    const pressEnter = () => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        editor.editor.view.dom.dispatchEvent(event);
        return event.defaultPrevented;
    };

    // 1. /time + Enter → 时间标记 token
    editor.setValue('记录 /time', false);
    placeCaret(editor.editor.state.doc.content.size - 1);
    const handled = pressEnter();
    check('time command: Enter consumed', handled, handled);
    check('time command: token inserted', /\[\[time:create:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\]/.test(editor.getValue()), editor.getValue());
    check('time command: command text removed', !editor.getValue().includes('/time'), editor.getValue());

    // 2. 非 /time 段落 Enter 走默认分段行为：段落被拆分，不产生时间 token
    editor.setValue('普通段落', false);
    placeCaret(editor.editor.state.doc.content.size - 1);
    pressEnter();
    const valueAfter = editor.getValue();
    check('normal enter: no time token', !valueAfter.includes('[[time:'), valueAfter);

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap time-command checks passed');
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
