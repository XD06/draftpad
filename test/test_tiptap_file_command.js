/**
 * Tiptap /file 命令回归：Enter 拦截（不拆段、不软换行）、/files 等词尾
 * 不触发、代码块内不触发、文件选择后上传并把 /file 替换为资产引用
 * Markdown（图片带 dumbpad-width 默认宽、文件用旧 buildArticleFileMarkdown
 * 形态）、上传期间编辑后插入位置随事务映射。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.DocumentFragment = dom.window.DocumentFragment;
global.MutationObserver = dom.window.MutationObserver;
global.navigator = dom.window.navigator;
global.getSelection = dom.window.getSelection.bind(dom.window);
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.getComputedStyle = dom.window.getComputedStyle;
global.HTMLAnchorElement = dom.window.HTMLAnchorElement;
if (!dom.window.requestAnimationFrame) {
    dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
}
// jsdom 无布局环境：Element.getClientRects 自带但行为不可靠，Range 没有
// getClientRects；Tiptap 内核的 scrollToSelection / posAtCoords 两者都会调。
dom.window.document.elementFromPoint = function elementFromPoint() { return null; };
global.document.elementFromPoint = dom.window.document.elementFromPoint;
dom.window.Element.prototype.getClientRects = function getClientRects() { return []; };
dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
dom.window.Range.prototype.getBoundingClientRect = function getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
dom.window.Range.prototype.getClientRects = function getClientRects() { return []; };

const bundlePath = path.join(ROOT, 'public', 'vendor', 'tiptap', 'tiptap.bundle.js');
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: 'tiptap.bundle.js' });
if (!global.DumbPadTiptap) {
    console.error('FAIL: tiptap bundle did not expose global DumbPadTiptap');
    process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}`);
        if (detail) console.error(`  ${detail}`);
    }
}

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();

    const fileInputs = () => container.querySelectorAll('.article-file-command-input');
    const setValueAndSelect = async (value, from, to) => {
        editor.setValue(value, false);
        const { TextSelection } = global.DumbPadTiptap.PM.state;
        editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
            TextSelection.create(editor.editor.state.doc, from, to)));
        await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const pressEnter = () => {
        editor.editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
    };

    // 1. /files（词尾带字母）不触发
    await setValueAndSelect('正文 /files', 10, 10);
    pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('word-suffix /files does not open picker', fileInputs().length === 0);

    // 2. 代码块内不触发
    const codeValue = '```\n/file\n```\n\n正文';
    editor.setValue(codeValue, false);
    let codePos = null;
    editor.editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === '/file' && codePos === null) { codePos = pos; return false; }
        return true;
    });
    if (codePos !== null) {
        await setValueAndSelect(codeValue, codePos + 5, codePos + 5);
        pressEnter();
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('code block /file does not open picker', fileInputs().length === 0);
    } else {
        check('code block /file does not open picker', false, 'code text not found');
    }

    // 3. 正文 /file + Enter：拦截 Enter（不软换行、不拆段），打开选择器
    await setValueAndSelect('附件：/file', 9, 9);
    pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('/file + Enter opens picker', fileInputs().length === 1);
    check('Enter is intercepted (no soft break)', editor.getValue() === '附件：/file', editor.getValue());

    // 4. 上传期间继续编辑：插入位置随事务映射
    editor.editor.commands.insertContentAt(3, '更多文字 ');
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('user can keep editing during upload', editor.getValue().includes('附件更多文字 ：/file'), editor.getValue());

    // 5. 文件选择 → 上传 → /file 替换为文件引用 Markdown
    const pdfFile = new dom.window.File(['pdf-bytes'], '报告.pdf', { type: 'application/pdf' });
    const pngFile = new dom.window.File(['png-bytes'], '截图.png', { type: 'image/png' });
    editor.assetApi = {
        async uploadFile(file) {
            return { name: file.name, size: 2048, type: file.type, downloadUrl: `/api/df/stub-report` };
        },
        async uploadImage(file) {
            return { name: file.name, previewUrl: `/api/df/stub-image` };
        },
    };
    const input = fileInputs()[0];
    Object.defineProperty(input, 'files', { value: [pdfFile, pngFile], configurable: true });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const finalValue = editor.getValue();
    check('/file replaced after upload', !finalValue.includes('：/file'), finalValue);
    // label 不带 📎（图标由 CSS 提供）；图片默认宽度是「窄」档 360。
    check('file reference markdown inserted', finalValue.includes('[报告.pdf') && finalValue.includes('dumbpad-file=1'), finalValue);
    check('image markdown uses the small default width', finalValue.includes('![截图.png](/api/df/stub-image "dumbpad-width=360")'), finalValue);
    // 顺序：按选择顺序：pdf 在前、图片在后
    check('selection order preserved', finalValue.indexOf('报告.pdf') < finalValue.indexOf('![截图.png]'), finalValue);
    // 插入位置在上传期间编辑的文字之后（位置随事务映射）
    check('insert position follows edits', finalValue.indexOf('报告.pdf') > finalValue.indexOf('更多文字'), finalValue);

    // 6. 上传失败：响亮提示且不静默成功
    await setValueAndSelect('失败：/file', 9, 9);
    pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 30));
    editor.assetApi = {
        async uploadFile() { throw new Error('网络错误'); },
        async uploadImage() { throw new Error('网络错误'); },
    };
    const input2 = fileInputs()[0];
    Object.defineProperty(input2, 'files', { value: [pdfFile], configurable: true });
    input2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const failedValue = editor.getValue();
    check('failed upload leaves doc without reference', !failedValue.includes('报告.pdf'), failedValue);

    console.log('');
    if (failures > 0) {
        console.error(`${failures} file command checks failed`);
        process.exit(1);
    }
    console.log('tiptap file command checks passed');
}

main().catch((error) => {
    console.error('FAIL: unhandled error', error);
    process.exit(1);
});
