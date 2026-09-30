/**
 * 撤销历史（Ctrl+Z）的语义：编辑器是 Tiptap/ProseMirror，撤销栈本来就在，但
 * 「载入文章」这一步曾被算进历史——编辑器以 `content: ''` 创建，正文靠 `setContent`
 * 灌进来，而它默认进历史，于是栈底那一步就是「空文档 → 整篇正文」。用户按 Ctrl+Z
 * 撤掉的是载入本身：整篇瞬间变空白（看起来就像「编辑器不支持撤销，只会清空」）。
 * 更糟的是撤销能跨文章：在 A 文里撤出 B 文的内容，autosave 随即把 A 文覆盖掉。
 *
 * 修复是 `setValue` 的载入事务带 `setMeta('addToHistory', false)`（boot textarea
 * 交接、WS 远端更新、源码模式切回都走这条路）。这里钉住两面：
 * ① 载入不是撤销步骤——刚打开就 Ctrl+Z，正文一字不动；换文章后连撤也不跨篇；
 * ② 撤销功能本身还在——打字能逐步回退、能重做，没被 meta 一并禁掉。
 *
 * 用例里那些 wait(600) 是必要的：ProseMirror 会把 newGroupDelay（默认 500ms）内的
 * 连续按键并进同一个撤销组，不打断就测不到「一步撤销」的粒度。真实打字有停顿，
 * 合成按键没有。真按键的浏览器侧覆盖在 test/browser/editor-input.js。
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

const ARTICLE = '# 我的文章\n\n这是正文内容。';
const INVISIBLE = new RegExp('[' + String.fromCharCode(0x200B) + String.fromCharCode(0xFEFF) + ']', 'g');

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const { PM } = globalThis.DumbPadTiptap;
    const TextSelection = PM.state.TextSelection;
    const wait = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

    const makeEditor = async (options = {}) => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const wrapper = new HybridMarkdownEditor(container, options);
        await wrapper.whenReady();
        const view = wrapper.editor.view;
        /** 真实按键入口：Ctrl+Z / Ctrl+Y 与浏览器走同一条键位管线。 */
        const press = (key, code, modifiers = {}) => {
            view.dom.dispatchEvent(new KeyboardEvent('keydown', {
                key, code, bubbles: true, cancelable: true, ...modifiers,
            }));
        };
        const ctrlZ = () => press('z', 'KeyZ', { ctrlKey: true });
        const ctrlY = () => press('y', 'KeyY', { ctrlKey: true });
        const type = (text) => {
            for (const ch of text) {
                const { from, to } = view.state.selection;
                const handled = view.someProp('handleTextInput', fn => fn(view, from, to, ch));
                if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
            }
        };
        const caretAtEnd = () => {
            view.dispatch(view.state.tr.setSelection(
                TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
            ));
        };
        const shape = () => {
            const out = [];
            view.state.doc.forEach(node => out.push(`${node.type.name}(${node.textContent.replace(INVISIBLE, '')})`));
            return out.join(' ');
        };
        return { wrapper, view, ctrlZ, ctrlY, type, caretAtEnd, shape };
    };

    /* 1. 载入不是撤销步骤：刚打开就 Ctrl+Z，正文一字不动 */
    {
        const { wrapper, ctrlZ, shape } = await makeEditor();
        wrapper.setValue(ARTICLE, false);
        await wait(400);
        check('load: nothing is undoable right after opening', wrapper.editor.can().undo() === false,
            wrapper.editor.can().undo());
        ctrlZ();
        await wait(150);
        check('load: Ctrl+Z keeps the article intact', wrapper.getValue() === ARTICLE, wrapper.getValue());
        check('load: the block structure is unchanged',
            shape() === 'heading(我的文章) paragraph(这是正文内容。)', shape());
    }

    /* 2. 载入后打字仍然能撤销（功能还在，没被 addToHistory meta 一起禁掉） */
    {
        const { wrapper, ctrlZ, caretAtEnd, type, shape } = await makeEditor();
        wrapper.setValue(ARTICLE, false);
        await wait(400);
        caretAtEnd();
        type('再写一句话');
        await wait(400);
        const typed = wrapper.getValue();
        check('typing: undo becomes available', wrapper.editor.can().undo() === true);
        check('typing: the new text is in the document', typed === `${ARTICLE}再写一句话`, typed);
        ctrlZ();
        await wait(200);
        check('typing: Ctrl+Z steps back only the typing', wrapper.getValue() === ARTICLE, wrapper.getValue());
        check('typing: the loaded body survives the undo',
            shape() === 'heading(我的文章) paragraph(这是正文内容。)', shape());
    }

    /* 3. 撤销有粒度：两组按键之间留出 >500ms，Ctrl+Z 只回退最后一组 */
    {
        const { wrapper, ctrlZ, caretAtEnd, type } = await makeEditor();
        wrapper.setValue('开头', false);
        await wait(400);
        caretAtEnd();
        type('甲段');
        await wait(600);
        type('乙段');
        await wait(600);
        check('granularity: both bursts are typed', wrapper.getValue() === '开头甲段乙段', wrapper.getValue());
        ctrlZ();
        await wait(200);
        check('granularity: one Ctrl+Z removes only the last burst',
            wrapper.getValue() === '开头甲段', wrapper.getValue());
        ctrlZ();
        await wait(200);
        check('granularity: a second Ctrl+Z removes the previous burst',
            wrapper.getValue() === '开头', wrapper.getValue());
        ctrlZ();
        await wait(200);
        check('granularity: a third Ctrl+Z does not blank the article',
            wrapper.getValue() === '开头', wrapper.getValue());
        check('granularity: the undo stack is now empty', wrapper.editor.can().undo() === false,
            wrapper.editor.can().undo());
    }

    /* 4. 重做对称 */
    {
        const { wrapper, ctrlZ, ctrlY, caretAtEnd, type } = await makeEditor();
        wrapper.setValue(ARTICLE, false);
        await wait(400);
        caretAtEnd();
        type('补一段');
        await wait(600);
        const typed = wrapper.getValue();
        ctrlZ();
        await wait(200);
        check('redo: undo took the typing back', wrapper.getValue() === ARTICLE, wrapper.getValue());
        ctrlY();
        await wait(200);
        check('redo: Ctrl+Y restores the typed text', wrapper.getValue() === typed, wrapper.getValue());
    }

    /* 5. 换文章不跨篇撤销：载入 B 之后连撤，既撤不出 A，也撤不成空文档 */
    {
        const { wrapper, ctrlZ, caretAtEnd, type } = await makeEditor();
        wrapper.setValue('A 文的内容', false);
        await wait(300);
        caretAtEnd();
        type('A 文里打的字');
        await wait(600);
        wrapper.setValue('B 文的内容', false);
        await wait(300);
        check('switch article: the new article is loaded', wrapper.getValue() === 'B 文的内容', wrapper.getValue());
        for (let i = 0; i < 4; i += 1) {
            ctrlZ();
            await wait(120);
        }
        const after = wrapper.getValue();
        check('switch article: undo never leaks A 文 into B 文', !after.includes('A 文'), after);
        check('switch article: undo never empties the article', after === 'B 文的内容', after);
    }

    /* 6. 远端更新（WS 走 emit=true 的 setValue）也不是撤销步骤 */
    {
        let notified = 0;
        const { wrapper, ctrlZ, caretAtEnd, type } = await makeEditor({ input: () => { notified += 1; } });
        wrapper.setValue('本地正文', false);
        await wait(300);
        caretAtEnd();
        type('本地新增');
        await wait(600);
        // 只数这一次：打字本身也会报 input，把基线清零才能验证「远端载入 = 恰好一次变更通知」
        notified = 0;
        wrapper.setValue('远端把整篇换了', true);
        await wait(300);
        check('remote update: the change is reported once', notified === 1, notified);
        check('remote update: the editor holds the remote article',
            wrapper.getValue() === '远端把整篇换了', wrapper.getValue());
        caretAtEnd();
        type('X');
        await wait(600);
        ctrlZ();
        await wait(200);
        check('remote update: Ctrl+Z removes only the local keystroke',
            wrapper.getValue() === '远端把整篇换了', wrapper.getValue());
        ctrlZ();
        await wait(200);
        check('remote update: the remote load itself is not an undo step',
            wrapper.getValue() === '远端把整篇换了', wrapper.getValue());
    }

    /* 7. 源码模式往返不往历史里塞步骤：切回所见即所得后 Ctrl+Z 不动正文 */
    {
        const { wrapper, ctrlZ } = await makeEditor();
        wrapper.setValue(ARTICLE, false);
        await wait(300);
        wrapper.setSourceMode(true);
        await wait(150);
        wrapper.setSourceMode(false);
        await wait(150);
        check('source mode: switching back restores the rendered article',
            wrapper.getValue() === ARTICLE, wrapper.getValue());
        ctrlZ();
        await wait(200);
        check('source mode: the round trip left nothing undoable',
            wrapper.getValue() === ARTICLE, wrapper.getValue());
        check('source mode: the undo stack is still empty', wrapper.editor.can().undo() === false,
            wrapper.editor.can().undo());
    }

    /* 8. 空文档上按 Ctrl+Z 不炸；第一篇文档的打字仍然可撤 */
    {
        const { wrapper, ctrlZ, type, caretAtEnd } = await makeEditor();
        ctrlZ();
        await wait(120);
        check('empty doc: Ctrl+Z on a fresh editor is a no-op', wrapper.getValue() === '', wrapper.getValue());
        caretAtEnd();
        type('新写的正文');
        await wait(600);
        check('empty doc: the typing landed', wrapper.getValue() === '新写的正文', wrapper.getValue());
        ctrlZ();
        await wait(200);
        check('empty doc: one Ctrl+Z goes back to the empty document',
            wrapper.getValue() === '', wrapper.getValue());
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap undo history checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
