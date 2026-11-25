/**
 * 移动端 PWA 代码块输入、粘贴与 DOM 拆分自愈回归测试（DumbPadCodeBlockInputGuard +
 * tiptap-code-block-view DOM 工具）。覆盖：
 * 1) Android / 软键盘 beforeinput（insertParagraph / insertLineBreak / insertFromPaste /
 *    含换行 insertText）转入 ProseMirror 事务，含三连回车退出代码块；
 * 2) 组合态下 paste（iOS Safari 会跳过 editHandlers.paste）与仅含 text/html 剪贴板；
 * 3) Chrome/IME 拆出同级 <code> / <div> / <br> 时，input 与 compositionend 自动把
 *    游离 DOM 折叠回唯一 contentDOM，同步正文、行号栏与精确光标位置。
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
global.Event = dom.window.Event;
global.InputEvent = dom.window.InputEvent;
global.ClipboardEvent = dom.window.ClipboardEvent;
global.DataTransfer = dom.window.DataTransfer;
global.getSelection = dom.window.getSelection.bind(dom.window);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
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

function makeBeforeInputEvent(inputType, { data = null, dataTransfer = null, isComposing = false } = {}) {
    const event = new dom.window.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType,
        data,
        isComposing,
    });
    if (dataTransfer) {
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
    }
    return event;
}

function makeFakeClipboardEvent({ plain = '', html = '' } = {}) {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    const dataMap = new Map();
    if (plain) dataMap.set('text/plain', plain);
    if (html) dataMap.set('text/html', html);
    Object.defineProperty(event, 'clipboardData', {
        value: {
            files: [],
            getData: (type) => dataMap.get(type) || '',
        },
        configurable: true,
    });
    return event;
}

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const {
        extractCodeBlockTextAndCaret,
        extractClipboardHtmlText,
        isCodeBlockDOMCorrupted,
        reconcileCodeBlockDOM,
    } = await import(pathToFileURL(path.join(ROOT, 'public/managers/tiptap-code-block-view.js')).href);
    const { PM } = globalThis.DumbPadTiptap;
    const { TextSelection } = PM.state;

    const editors = [];
    const makeEditor = async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const wrapper = new HybridMarkdownEditor(container, {});
        editors.push(wrapper);
        await wrapper.whenReady();
        const view = wrapper.editor.view;
        const setCaret = (pos) => {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        };
        return { container, wrapper, view, setCaret };
    };

    /* 1. 纯 DOM 提取、空块 <br> 占位、游离 sibling 与光标偏移映射 */
    {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const pre = document.createElement('pre');
        const header = document.createElement('span');
        header.className = 'dumbpad-code-header';
        header.textContent = 'markdown复制';
        const code1 = document.createElement('code');
        code1.innerHTML = '<span class="hljs-section"># markdown块渲染</span>';
        const code2 = document.createElement('code');
        code2.innerHTML = '<span class="hljs-section">## 存在问题</span>';
        const code3 = document.createElement('code');
        code3.textContent = '与源码不一致';
        pre.append(header, code1, code2, code3);
        host.appendChild(pre);

        check('detects sibling <code> corruption inside <pre>', isCodeBlockDOMCorrupted(pre, code1) === true);

        const sel = dom.window.getSelection();
        const range = dom.window.document.createRange();
        range.setStart(code3.firstChild, 4);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);

        const extracted = extractCodeBlockTextAndCaret(pre, code1, sel);
        check('extracts multi-line code across split <code> siblings ignoring header',
            extracted.text === '# markdown块渲染\n## 存在问题\n与源码不一致',
            extracted);
        check('maps caret inside split <code> sibling accurately',
            extracted.text.slice(0, extracted.anchorOffset) === '# markdown块渲染\n## 存在问题\n与源码不',
            extracted);

        // Chrome 拆出的空占位行：<code1>a</code1><code2><span class="hljs-section"><br></span></code2>
        const preEmpty = document.createElement('pre');
        const c1 = document.createElement('code');
        c1.textContent = '# h1';
        const c2 = document.createElement('code');
        c2.innerHTML = '<span class="hljs-section"><br></span>';
        preEmpty.append(c1, c2);
        host.appendChild(preEmpty);
        const r2 = dom.window.document.createRange();
        r2.setStart(c2.firstChild, 0);
        r2.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r2);
        const ext2 = extractCodeBlockTextAndCaret(preEmpty, c1, sel);
        check('maps split empty line with cloned span><br> to trailing newline + caret after \\n',
            ext2.text === '# h1\n' && ext2.anchorOffset === 5,
            ext2);
        host.remove();

        // HTML-only 剪贴板提取（忽略 <style>/<script> 并保留行边界）
        const htmlText = extractClipboardHtmlText('<style>.x{color:red}</style><div>first line</div><div><br></div><div>third line</div>');
        check('extractClipboardHtmlText keeps block lines and strips style',
            htmlText === 'first line\n\nthird line',
            { htmlText });
    }

    /* 2. beforeinput(insertParagraph / insertLineBreak) 与三连回车退出 */
    {
        const { wrapper, view, setCaret } = await makeEditor();
        wrapper.setValue('```markdown\n# markdown块渲染\n```', false);
        setCaret(1 + '# markdown块渲染'.length);

        const ev1 = makeBeforeInputEvent('insertParagraph');
        view.dom.dispatchEvent(ev1);
        check('beforeinput insertParagraph is prevented inside codeBlock', ev1.defaultPrevented === true);
        view.dispatch(view.state.tr.insertText('## 存在问题', view.state.selection.from, view.state.selection.to));

        const ev2 = makeBeforeInputEvent('insertLineBreak');
        view.dom.dispatchEvent(ev2);
        check('beforeinput insertLineBreak is prevented inside codeBlock', ev2.defaultPrevented === true);
        view.dispatch(view.state.tr.insertText('与源码不一致', view.state.selection.from, view.state.selection.to));

        check('beforeinput newlines stay inside single codeBlock and serialize to multi-line markdown',
            wrapper.getValue() === '```markdown\n# markdown块渲染\n## 存在问题\n与源码不一致\n```',
            { value: wrapper.getValue() });

        const pre = wrapper.container.querySelector('.vditor-wysiwyg__block pre');
        check('line numbers update for every inserted line', pre?.dataset.lineNumbers === '1\n2\n3', { lineNumbers: pre?.dataset.lineNumbers });
        check('pre keeps exactly one <code> element', pre?.querySelectorAll('code').length === 1);

        // 三连回车退出代码块
        view.dom.dispatchEvent(makeBeforeInputEvent('insertParagraph'));
        view.dom.dispatchEvent(makeBeforeInputEvent('insertParagraph'));
        view.dom.dispatchEvent(makeBeforeInputEvent('insertParagraph'));
        check('triple beforeinput insertParagraph exits codeBlock cleanly',
            view.state.selection.$from.parent.type.name === 'paragraph'
                && wrapper.getValue() === '```markdown\n# markdown块渲染\n## 存在问题\n与源码不一致\n```',
            { parent: view.state.selection.$from.parent.type.name, value: wrapper.getValue() });
    }

    /* 3. beforeinput(insertFromPaste / multiline insertText) 与组合态/HTML 粘贴 */
    {
        const { wrapper, view, setCaret } = await makeEditor();
        wrapper.setValue('```js\na\n```', false);
        setCaret(2);

        const biPaste = makeBeforeInputEvent('insertFromPaste', {
            dataTransfer: { getData: (type) => (type === 'text/plain' ? '\nb\nc' : '') },
        });
        view.dom.dispatchEvent(biPaste);
        check('beforeinput insertFromPaste preserves newlines inside codeBlock',
            biPaste.defaultPrevented === true && wrapper.getValue() === '```js\na\nb\nc\n```',
            { prevented: biPaste.defaultPrevented, value: wrapper.getValue() });

        const biText = makeBeforeInputEvent('insertText', { data: '\nd\r\ne' });
        view.dom.dispatchEvent(biText);
        check('beforeinput insertText with newlines normalizes CRLF and stays inside codeBlock',
            biText.defaultPrevented === true && wrapper.getValue() === '```js\na\nb\nc\nd\ne\n```',
            { prevented: biText.defaultPrevented, value: wrapper.getValue() });

        // 组合态 paste（iOS Safari 路径）
        view.input.composing = true;
        const pasteComposing = makeFakeClipboardEvent({ plain: '\nf' });
        view.dom.dispatchEvent(pasteComposing);
        view.input.composing = false;
        check('paste during composition stays inside codeBlock with newline',
            pasteComposing.defaultPrevented === true && wrapper.getValue() === '```js\na\nb\nc\nd\ne\nf\n```',
            { prevented: pasteComposing.defaultPrevented, value: wrapper.getValue() });

        // 仅有 HTML 的 paste
        const pasteHtmlOnly = makeFakeClipboardEvent({ html: '<div>g</div><div>h</div>' });
        view.dom.dispatchEvent(pasteHtmlOnly);
        check('HTML-only paste inside codeBlock extracts newlines safely',
            pasteHtmlOnly.defaultPrevented === true && wrapper.getValue() === '```js\na\nb\nc\nd\ne\nfg\nh\n```',
            { prevented: pasteHtmlOnly.defaultPrevented, value: wrapper.getValue() });
    }

    /* 4. 不可取消的 DOM 拆分自愈（input 与 compositionend 路径 + renderChrome 兜底清理） */
    {
        const { wrapper, view, setCaret } = await makeEditor();
        wrapper.setValue('```markdown\n# 第一行\n```', false);
        setCaret(1 + '# 第一行'.length);

        const pre = wrapper.container.querySelector('.vditor-wysiwyg__block pre');
        const splitCode = document.createElement('code');
        splitCode.className = 'hljs';
        splitCode.textContent = '## 第二行';
        pre.appendChild(splitCode);

        const sel = dom.window.getSelection();
        const range = dom.window.document.createRange();
        range.setStart(splitCode.firstChild, 4);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);

        // 4a: compositionend 后微任务自愈
        view.input.composing = true;
        view.dom.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 10));

        check('compositionend reconciles split <code> back into single contentDOM & markdown',
            pre.querySelectorAll('code').length === 1
                && pre.dataset.lineNumbers === '1\n2'
                && wrapper.getValue() === '```markdown\n# 第一行\n## 第二行\n```',
            { codes: pre.querySelectorAll('code').length, lineNumbers: pre.dataset.lineNumbers, value: wrapper.getValue() });
        check('compositionend preserves caret position inside reconciled line 2',
            view.state.selection.from === 1 + '# 第一行\n## 第'.length,
            { from: view.state.selection.from });

        // 4b: input 直接自愈内嵌 <div>
        const code = pre.querySelector('code');
        const divLine = document.createElement('div');
        divLine.textContent = '第三行';
        code.appendChild(divLine);
        view.dom.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        check('input reconciles nested <div> inside <code> into single newline text',
            pre.querySelectorAll('div').length === 0
                && pre.dataset.lineNumbers === '1\n2\n3'
                && wrapper.getValue() === '```markdown\n# 第一行\n## 第二行\n第三行\n```',
            { html: pre.innerHTML, lineNumbers: pre.dataset.lineNumbers, value: wrapper.getValue() });

        // 4c: 直接调用 reconcileCodeBlockDOM 对干净块返回 false（无额外事务）
        const beforeDoc = view.state.doc;
        check('clean codeBlock returns false in reconcileCodeBlockDOM',
            reconcileCodeBlockDOM(view, pre) === false && view.state.doc === beforeDoc);
    }

    editors.forEach((item) => item.editor?.destroy?.());

    if (failures > 0) {
        process.exitCode = 1;
    } else {
        console.log('Tiptap code block mobile input checks passed');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
