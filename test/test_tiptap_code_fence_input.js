/**
 * 段落里手打的 ``` 围栏必须当场转正为代码块（CodeFenceInputShortcut），与刷新后的解析
 * 结果一致：开栏行（``` + 语言）回车即开块（旧 Vditor 的触发时机，也是主路径——块开后
 * 直接在块内写代码，不必也不应再敲收尾围栏），完整围栏在收尾反引号落下时补转（兜底：
 * 光标不在段末等开栏没接管的场景）。磁盘格式本来就能表达围栏（未转义源码 setValue 直接
 * 解析成 codeBlock），缺的只是打字那一刻的转换；不转换的后果是反引号被序列化转义成 \`，
 * 源码被永久污染且围栏永远变不成代码块。
 *
 * 这里断言的是输入规则本身：段中/整段开栏、块内多行代码、空语言/空体、语言标记打完前
 * 不抢跑、不该接管的场景（收尾后有文字 / 行中开栏 / 内联代码 span）、块内退出（官方
 * 三连回车）、撤销与往返稳定、官方 ```` ``` ```` + 空格路径不回归。真按键由
 * test/browser/editor-input.js 在真实 Chrome 里覆盖。
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
    const { PM } = globalThis.DumbPadTiptap;
    const TextSelection = PM.state.TextSelection;

    /** 每个用例一个独立编辑器实例：撤销历史互不串线。 */
    const makeEditor = async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const wrapper = new HybridMarkdownEditor(container, {});
        await wrapper.whenReady();
        const view = wrapper.editor.view;
        /**
         * 走 PM 真正的打字入口 handleTextInput（与浏览器按键同一个回调点）：规则命中时
         * 由规则自己派发事务、字符不再单独插入；没命中时按普通插入处理。
         */
        const type = (text) => {
            const fired = [];
            for (const ch of text) {
                const { from, to } = view.state.selection;
                const handled = view.someProp('handleTextInput', fn => fn(view, from, to, ch));
                if (handled) fired.push(ch);
                else view.dispatch(view.state.tr.insertText(ch, from, to));
            }
            return fired;
        };
        const pressEnter = () => {
            view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        };
        const blocks = () => {
            const out = [];
            view.state.doc.forEach(node => out.push({
                type: node.type.name,
                language: node.attrs?.language ?? null,
                text: node.textContent.replace(/[\u200B\uFEFF]/g, ''),
            }));
            return out;
        };
        const breakCount = () => {
            let total = 0;
            view.state.doc.descendants(node => {
                if (node.type.name === 'hardBreak') total += 1;
                return true;
            });
            return total;
        };
        const caretAtEnd = () => {
            view.dispatch(view.state.tr.setSelection(
                TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
            ));
        };
        return { wrapper, view, type, pressEnter, blocks, breakCount, caretAtEnd };
    };

    /* 1. 段中开栏 + 回车：当场得到代码块（主路径），块内继续写代码，不必敲收尾围栏 */
    {
        const { wrapper, view, type, pressEnter, blocks, breakCount } = await makeEditor();
        type('普通段落测试');
        pressEnter();
        type('```plaintext');
        check('opening: nothing converts while still typing', blocks().length === 1
            && blocks()[0].type === 'paragraph', blocks());
        pressEnter();
        check('opening: Enter converts the fence line into a code block', JSON.stringify(blocks())
            === JSON.stringify([
                { type: 'paragraph', language: null, text: '普通段落测试' },
                { type: 'codeBlock', language: 'plaintext', text: '' },
                { type: 'paragraph', language: null, text: '' },
            ]), blocks());
        check('opening: prefix kept its soft break for nothing (no stray br)', breakCount() === 0, breakCount());
        check('opening: cursor lands inside the code block',
            view.state.selection.$from.parent.type.name === 'codeBlock');
        type('代码块测试');
        const md = wrapper.getValue();
        check('opening: body typed inside the block', md === '普通段落测试\n\n```plaintext\n代码块测试\n```', md);
        wrapper.setValue(md, false);
        check('opening: typing result == reload result', JSON.stringify(blocks())
            === JSON.stringify([
                { type: 'paragraph', language: null, text: '普通段落测试' },
                { type: 'codeBlock', language: 'plaintext', text: '代码块测试' },
                { type: 'paragraph', language: null, text: '' },
            ]), blocks());
        check('opening: markdown round-trips', wrapper.getValue() === md, wrapper.getValue());
    }

    /* 2. 块内多行代码：开栏后回车是代码块内的换行，不产生新块 */
    {
        const { wrapper, type, pressEnter, blocks } = await makeEditor();
        type('前缀');
        pressEnter();
        type('```js');
        pressEnter();
        type('const a = 1;');
        pressEnter();
        type('const b = 2;');
        check('multiline: both lines live in one code block', JSON.stringify(blocks())
            === JSON.stringify([
                { type: 'paragraph', language: null, text: '前缀' },
                { type: 'codeBlock', language: 'js', text: 'const a = 1;\nconst b = 2;' },
                { type: 'paragraph', language: null, text: '' },
            ]), blocks());
        check('multiline: markdown fenced correctly',
            wrapper.getValue() === '前缀\n\n```js\nconst a = 1;\nconst b = 2;\n```', wrapper.getValue());
    }

    /* 3. 块内退出：官方三连回车（exitOnTripleEnter）在块尾退出到新段落 */
    {
        const { wrapper, view, type, pressEnter, blocks } = await makeEditor();
        type('甲');
        pressEnter();
        type('```c');
        pressEnter();
        type('const x = 1;');
        pressEnter();
        pressEnter();
        pressEnter();
        check('triple enter exits: cursor back in a paragraph',
            view.state.selection.$from.parent.type.name === 'paragraph'
            && blocks().some(b => b.type === 'codeBlock' && b.text === 'const x = 1;'), blocks());
        check('triple enter exits: markdown keeps the closed fence',
            wrapper.getValue() === '甲\n\n```c\nconst x = 1;\n```', wrapper.getValue());
    }

    /* 4. 整段围栏补转（打字路径进不来——空段落 ```` ```js ```` + 回车会被开栏规则当场
     * 转正，所以用 insertText 构造打字中间态，直接验证 wholeParagraph 分支） */
    {
        const { wrapper, view, type, blocks, caretAtEnd } = await makeEditor();
        view.dispatch(view.state.tr.insertText('```js\nconst a = 1;\n``'));
        caretAtEnd();
        const fired = type('`');
        check('whole paragraph: the closing backtick triggered an input rule', fired.join('') === '`', fired);
        check('whole paragraph: paragraph replaced by the code block', JSON.stringify(blocks())
            === JSON.stringify([
                { type: 'codeBlock', language: 'js', text: 'const a = 1;' },
                { type: 'paragraph', language: null, text: '' },
            ]), blocks());
        check('whole paragraph: markdown fenced', wrapper.getValue() === '```js\nconst a = 1;\n```', wrapper.getValue());
        check('whole paragraph: cursor lands inside the code block',
            view.state.selection.$from.parent.type.name === 'codeBlock');
        const md = wrapper.getValue();
        wrapper.setValue(md, false);
        check('whole paragraph: typing result == reload result', JSON.stringify(blocks())
            === JSON.stringify([
                { type: 'codeBlock', language: 'js', text: 'const a = 1;' },
                { type: 'paragraph', language: null, text: '' },
            ]), blocks());
        check('whole paragraph: markdown round-trips', wrapper.getValue() === md, wrapper.getValue());
    }

    /* 5. 收尾围栏后还有文字：CommonMark 里「```尾文」不是合法收尾，不接管、字符照常插入
     * （打字路径进不来——开栏回车已把后续输入关进块内，用 insertText 构造该状态） */
    {
        const { wrapper, view, type, blocks } = await makeEditor();
        view.dispatch(view.state.tr.insertText('甲\n```js\nconst a = 1;\n``乙'));
        let target = null;
        view.state.doc.descendants((node, pos) => {
            if (node.type.name === 'text' && node.text.endsWith('乙') && target === null) {
                target = pos + node.text.length - 1;
            }
            return true;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
        const fired = type('`');
        check('trailing text: the rule does not fire', fired.length === 0, fired);
        check('trailing text: everything stays literal in the paragraph',
            blocks().length === 1 && blocks()[0].type === 'paragraph'
            && blocks()[0].text === '甲\n```js\nconst a = 1;\n```乙', blocks());
        check('trailing text: backtick inserted verbatim',
            wrapper.getValue() === '甲\n\\`\\`\\`js\nconst a = 1;\n\\`\\`\\`乙', wrapper.getValue());
    }

    /* 6. 行中开栏不转换（围栏必须在视觉行首，与重新解析一致） */
    {
        const { wrapper, type, pressEnter, blocks } = await makeEditor();
        type('甲```js');
        pressEnter();
        check('mid-line opener: Enter after a mid-line fence does not convert',
            blocks().length === 1 && blocks()[0].type === 'paragraph'
            && blocks()[0].text.startsWith('甲```js'), blocks());
    }

    /* 7. 内联代码 span：收尾反引号属于 codeMark 规则，不被本规则劫持 */
    {
        const { wrapper, view, type, blocks } = await makeEditor();
        type('x `y');
        type('`');
        check('inline code: stays a paragraph with a code mark',
            blocks().length === 1 && blocks()[0].type === 'paragraph' && blocks()[0].text === 'x y', blocks());
        const codeTexts = [];
        view.state.doc.descendants(node => {
            if (node.marks.some(mark => mark.type.name === 'code')) codeTexts.push(node.text);
            return true;
        });
        check('inline code: code mark applied to y', JSON.stringify(codeTexts) === '["y"]', codeTexts);
        check('inline code: markdown keeps the span', wrapper.getValue() === 'x `y`', wrapper.getValue());
    }

    /* 8. 收尾规则补转（真实软换行构造）：撤销/重做，单事务可逆 */
    {
        const { wrapper, view, type, blocks } = await makeEditor();
        // 真实 hardBreak 节点构造打字中间态（insertText 会绕过输入规则，不会提前开块）
        type('普通段落测试');
        wrapper.editor.commands.setHardBreak();
        view.dispatch(view.state.tr.insertText('```plaintext'));
        wrapper.editor.commands.setHardBreak();
        view.dispatch(view.state.tr.insertText('代码块测试'));
        wrapper.editor.commands.setHardBreak();
        view.dispatch(view.state.tr.insertText('``'));
        const before = wrapper.getValue();
        check('closing retrofit: pre-state stays literal', before
            === '普通段落测试\n\\`\\`\\`plaintext\n代码块测试\n\\`\\`', before);
        const fired = type('`');
        check('closing retrofit: the closing backtick triggered an input rule', fired.join('') === '`', fired);
        const converted = wrapper.getValue();
        check('closing retrofit: markdown is a real fenced block',
            converted === '普通段落测试\n\n```plaintext\n代码块测试\n```', converted);
        wrapper.editor.commands.undo();
        check('closing retrofit undo: back to a literal-text paragraph',
            blocks().length === 1 && blocks()[0].type === 'paragraph', blocks());
        check('closing retrofit undo: fence text restored as literal',
            wrapper.getValue() === before, wrapper.getValue());
        wrapper.editor.commands.redo();
        check('closing retrofit redo: identical to the first conversion', wrapper.getValue() === converted, wrapper.getValue());
    }

    /* 9. 官方路径不回归：空段落 ``` + 空格仍由官方 CodeBlock 输入规则接管 */
    {
        const { wrapper, type, blocks } = await makeEditor();
        type('``` ');
        check('official path: ``` + space still creates a code block',
            blocks()[0]?.type === 'codeBlock', blocks());
    }

    /* 10. 空段落开栏 + 回车（此前由官方规则接管，现在先命中开栏规则，结果等价） */
    {
        const { wrapper, view, type, pressEnter, blocks } = await makeEditor();
        type('```c');
        pressEnter();
        check('empty paragraph opening: Enter creates the code block', JSON.stringify(blocks())
            === JSON.stringify([
                { type: 'codeBlock', language: 'c', text: '' },
                { type: 'paragraph', language: null, text: '' },
            ]), blocks());
        check('empty paragraph opening: cursor lands inside the code block',
            view.state.selection.$from.parent.type.name === 'codeBlock');
        check('empty paragraph opening: markdown fenced', wrapper.getValue() === '```c\n```', wrapper.getValue());
    }

    /* 11. 语言标记没打完不抢跑（`c` 之后想打的 `pp` 不能被关进块里） */
    {
        const { wrapper, type, pressEnter, blocks } = await makeEditor();
        type('甲');
        pressEnter();
        const fired = type('```cp');
        check('half-typed language: no rule fires while typing', fired.length === 0, fired);
        check('half-typed language: still one literal paragraph', blocks().length === 1
            && blocks()[0].type === 'paragraph' && blocks()[0].text === '甲\n```cp', blocks());
        pressEnter();
        check('half-typed language: Enter converts with the full token', JSON.stringify(blocks())
            === JSON.stringify([
                { type: 'paragraph', language: null, text: '甲' },
                { type: 'codeBlock', language: 'cp', text: '' },
                { type: 'paragraph', language: null, text: '' },
            ]), blocks());
    }

    /* 12. 带符号语言与空语言开栏 */
    {
        const { wrapper, type, pressEnter, blocks } = await makeEditor();
        type('```c++');
        pressEnter();
        check('signed language: c++ accepted', blocks()[0]?.type === 'codeBlock'
            && blocks()[0].language === 'c++', blocks());
    }
    {
        const { wrapper, type, pressEnter, blocks } = await makeEditor();
        type('```');
        pressEnter();
        check('empty language: bare ``` + Enter opens an empty code block',
            blocks()[0]?.type === 'codeBlock' && blocks()[0].language === null, blocks());
        check('empty language: markdown is a bare open fence', wrapper.getValue() === '```\n```', wrapper.getValue());
    }

    /* 13. 空格不是触发键（只有回车），段中 ```` ```c ```` + 空格保持字面 */
    {
        const { wrapper, type, pressEnter, blocks } = await makeEditor();
        type('甲');
        pressEnter();
        type('```c');
        type(' ');
        check('space is not a trigger: stays literal', blocks().length === 1
            && blocks()[0].type === 'paragraph' && blocks()[0].text === '甲\n```c ', blocks());
    }

    /* 14. 开栏转正的撤销/重做 */
    {
        const { wrapper, type, pressEnter, blocks } = await makeEditor();
        type('甲');
        pressEnter();
        type('```c');
        pressEnter();
        const converted = wrapper.getValue();
        check('opening undo: converted markdown', converted === '甲\n\n```c\n```', converted);
        wrapper.editor.commands.undo();
        check('opening undo: back to literal paragraph',
            blocks().length === 1 && blocks()[0].type === 'paragraph', blocks());
        check('opening undo: fence text restored as literal',
            wrapper.getValue() === '甲\n\\`\\`\\`c', wrapper.getValue());
        wrapper.editor.commands.redo();
        check('opening redo: identical to the first conversion', wrapper.getValue() === converted, wrapper.getValue());
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll code fence input checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
