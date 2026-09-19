/**
 * Tiptap 软换行 × 链接黑盒测试：光标落在链接文本（附件 chip）内部或边界时，Enter /
 * Shift-Enter 插入的段内换行绝不能进 <a>——否则 inline-flex 的 chip 被撑高，且换行会
 * 被写进 markdown 的链接 label（`[甲\n乙](url)`），重新解析后链接语法就坏了。
 * 这里断言的是插件的键位与事务逻辑（handleKeyDown / setHardBreak 命令），jsdom 足以
 * 覆盖；chip 的**真实高度**由 test/browser/attachment-click.js 在浏览器里量。
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

const LABEL = '丁尚坤-桌面运维.pdf · 234 KB';
const HREF = '/api/assets/0123456789abcdef0123456789abcdef/download';
const TITLE = 'dumbpad-file=1;size=239616;type=application%2Fpdf';
const FILE_MD = `[${LABEL}](${HREF} "${TITLE}")`;

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const { PM } = globalThis.DumbPadTiptap;
    const TextSelection = PM.state.TextSelection;

    const linkStart = () => {
        let pos = null;
        editor.editor.state.doc.descendants((node, nodePos) => {
            if (pos !== null) return false;
            if (node.isText && node.marks.some(mark => mark.type.name === 'link')) pos = nodePos;
            return true;
        });
        return pos;
    };
    const caretInsideLink = () => {
        const doc = editor.editor.state.doc;
        const start = linkStart();
        editor.editor.view.dispatch(doc ? editor.editor.state.tr.setSelection(TextSelection.create(doc, start + 2)) : editor.editor.state.tr);
        return editor.editor.state.selection.from;
    };
    const pressEnter = (key = 'Enter') => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        editor.editor.view.dom.dispatchEvent(event);
        return event.defaultPrevented;
    };
    const anchors = () => Array.from(container.querySelectorAll('a'));
    const breaksInsideAnchors = () => anchors().reduce((sum, a) => sum + a.querySelectorAll('br').length, 0);
    const anchorCount = () => anchors().length;

    // 1. 光标在附件 chip 文本内部按 Enter：换行不得进 <a>，label 与链接数不变
    editor.setValue(`${FILE_MD}\n\n后一段。\n`, false);
    const before = editor.getValue();
    caretInsideLink();
    const consumed = pressEnter();
    check('enter inside chip: key handled by the soft-enter shortcut', consumed === true, consumed);
    check('enter inside chip: no <br> inside <a>', breaksInsideAnchors() === 0, container.querySelector('p')?.innerHTML);
    check('enter inside chip: link not split into two anchors', anchorCount() === 1, anchorCount());
    check('enter inside chip: attachment markdown untouched', editor.getValue() === before, editor.getValue());

    // 2. 连续回车（用户描述的「多次回车高度增加」）：仍然不进 <a>、markdown 不变
    pressEnter();
    pressEnter();
    check('repeated enter: still no <br> inside <a>', breaksInsideAnchors() === 0, container.querySelector('p')?.innerHTML);
    check('repeated enter: attachment markdown untouched', editor.getValue() === before, editor.getValue());

    // 3. chip 后同段还有文字：换行落在链接之后 → 合法的 `[chip]\n尾巴`，且往返稳定
    editor.setValue(`${FILE_MD}尾巴\n\n后一段。\n`, false);
    caretInsideLink();
    pressEnter();
    const mixed = editor.getValue();
    check('chip + trailing text: break lands after the link', mixed === `${FILE_MD}\n尾巴\n\n后一段。`, mixed);
    check('chip + trailing text: no <br> inside <a>', breaksInsideAnchors() === 0, container.querySelector('p')?.innerHTML);
    editor.setValue(mixed, false);
    check('chip + trailing text: reload keeps one attachment anchor', anchorCount() === 1 && editor.getValue() === mixed, { anchors: anchorCount(), value: editor.getValue() });

    // 4. 普通带文字链接同理（同一类损坏）
    editor.setValue('前[链接](https://example.com/a)后\n\n段二。\n', false);
    caretInsideLink();
    pressEnter();
    const plain = editor.getValue();
    check('plain link: label never contains a newline', !/\[[^\]\n]*\n[^\]]*\]/.test(plain), plain);
    check('plain link: no <br> inside <a>', breaksInsideAnchors() === 0, container.querySelectorAll('a')[0]?.innerHTML);

    // 5. Shift-Enter（setHardBreak 命令，MdSoftBreak 的键位走的就是它）同样不进 <a>
    editor.setValue(`${FILE_MD}\n\n后一段。\n`, false);
    caretInsideLink();
    const commandRan = editor.editor.commands.setHardBreak();
    check('setHardBreak ran', commandRan === true, commandRan);
    check('shift-enter inside chip: no <br> inside <a>', breaksInsideAnchors() === 0, container.querySelector('p')?.innerHTML);
    check('shift-enter inside chip: link not split', anchorCount() === 1, anchorCount());

    // 6. 与链接无关的普通段落：软换行语义不变（段内换行、可继续输入、往返稳定）
    editor.setValue('普通段落\n\n段二。\n', false);
    const doc = editor.editor.state.doc;
    editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
        TextSelection.create(doc, 1 + doc.child(0).content.size)
    ));
    pressEnter();
    editor.editor.commands.insertContent('X');
    const normal = editor.getValue();
    check('plain paragraph enter still soft-breaks (no new block)', /^普通段落\nX\n\n段二。$/.test(normal), normal);
    editor.setValue(normal, false);
    check('plain paragraph soft break round-trips', editor.getValue() === normal, editor.getValue());

    // 7. 空段落回车不被接管：仍走框架默认分段，不会变成段内软换行
    // markdown 表达不出空段落（空行会折叠），先用框架的 splitBlock 造一个真正的空段落
    editor.setValue('段一\n\n段二。\n', false);
    const seeded = editor.editor.state.doc;
    editor.editor.view.dispatch(editor.editor.state.tr.setSelection(TextSelection.create(seeded, seeded.content.size - 1)));
    editor.editor.commands.splitBlock();
    const emptyDoc = editor.editor.state.doc;
    const blocksBefore = emptyDoc.childCount;
    editor.editor.view.dispatch(editor.editor.state.tr.setSelection(TextSelection.create(emptyDoc, emptyDoc.content.size - 1)));
    check('fixture has a real empty paragraph', editor.editor.state.selection.$from.parent.textContent === '',
        editor.editor.state.selection.$from.parent.textContent);
    pressEnter();
    const realBreaks = Array.from(container.querySelectorAll('br'))
        .filter(node => !node.classList.contains('ProseMirror-trailingBreak')).length;
    check('empty paragraph enter adds no soft break', realBreaks === 0, container.innerHTML);
    check('empty paragraph enter still splits blocks', editor.editor.state.doc.childCount > blocksBefore,
        { blocksBefore, blocksAfter: editor.editor.state.doc.childCount });

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap soft-enter link checks passed');
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
