/**
 * 粘贴 / 拖入图片回归：图片文件必须走资产上传（不得把 Base64 写进正文），
 * 落文形态与 /file 一致（`![名](previewUrl "dumbpad-width=360")`，默认「窄」
 * 档），多图按顺序、非图片文件不接管、阅读模式不接管、上传失败不落文；
 * 上传期间挂 /file 同款进度卡片（进度回调驱动、成功撤卡、失败卡片留原位）。
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

const BASE64_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC';

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const { imagePastePluginKey } = await import('../public/managers/tiptap-image-paste.js');
    const { articleUploadProgressPluginKey } = await import('../public/managers/tiptap-file-command.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const view = editor.editor.view;
    const root = container.querySelector('.tiptap');

    const uploaded = [];
    let failNext = false;
    editor.assetApi = {
        async uploadImage(file) {
            uploaded.push(file.name);
            if (failNext) throw new Error('上传失败');
            return { name: file.name, previewUrl: `/api/assets/stub-${uploaded.length}/preview` };
        },
        async uploadFile() { throw new Error('should not upload as file'); },
    };

    // 剪贴板/拖拽的 DataTransfer 替身：只需 files。
    const transferWith = (files) => ({ files });

    const pasteWith = (files, html = '') => {
        const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', {
            value: { files, getData: (type) => (type === 'text/html' ? html : '') },
        });
        root.dispatchEvent(event);
        return event;
    };

    const dropWith = (files) => {
        // jsdom 没有布局：PM 的 drop 管线靠 posAtCoords 定位，坐标恒为 null 就
        // 到不了 handleDrop。这里直接调本扩展注册的 handleDrop prop——被测的是
        // 我们的接管逻辑，PM 的坐标管线属于框架行为。
        const plugin = view.state.plugins.find(item => item.spec?.key === imagePastePluginKey);
        if (!plugin) throw new Error('image paste plugin is not registered');
        const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files } });
        Object.defineProperty(event, 'clientX', { value: 10 });
        Object.defineProperty(event, 'clientY', { value: 10 });
        plugin.props.handleDrop(view, event, null, false);
        return event;
    };

    /* ---- 1. 粘贴图片文件：上传、落文带「窄」档宽度、正文无 Base64 ---- */
    const png = new dom.window.File(['png-bytes'], '截图.png', { type: 'image/png' });
    editor.setValue('前文', false);
    const pasteEvent = pasteWith([png], `<img src="${BASE64_PNG}">`);
    await wait(60);
    const afterPaste = editor.getValue();
    check('paste is taken over (default prevented)', pasteEvent.defaultPrevented);
    check('pasted image is uploaded, not inlined', uploaded.length === 1 && uploaded[0] === '截图.png', uploaded);
    check('pasted image renders as asset markdown', afterPaste.includes('![截图.png](/api/assets/stub-1/preview "dumbpad-width=360")'), afterPaste);
    check('no base64 survives in the document', !afterPaste.includes('data:image'), afterPaste.slice(0, 200));
    check('surrounding text is kept', afterPaste.includes('前文'), afterPaste);

    /* ---- 2. 拖入图片文件：同一套上传与落文 ---- */
    editor.setValue('', false);
    const jpg = new dom.window.File(['jpg-bytes'], '照片.jpg', { type: 'image/jpeg' });
    dropWith([jpg]);
    await wait(60);
    const afterDrop = editor.getValue();
    check('dropped image is uploaded', uploaded.length === 2 && uploaded[1] === '照片.jpg', uploaded);
    check('dropped image uses the narrow default width', afterDrop.includes('![照片.jpg](/api/assets/stub-2/preview "dumbpad-width=360")'), afterDrop);
    check('dropped image keeps no base64', !afterDrop.includes('data:image'), afterDrop);

    /* ---- 3. 多图粘贴：按选择顺序落文 ---- */
    editor.setValue('', false);
    const a = new dom.window.File(['a'], 'a.png', { type: 'image/png' });
    const b = new dom.window.File(['b'], 'b.png', { type: 'image/png' });
    pasteWith([a, b]);
    await wait(80);
    const afterMulti = editor.getValue();
    check('multiple pasted images all inserted', afterMulti.includes('a.png') && afterMulti.includes('b.png'), afterMulti);
    check('multiple pasted images keep order', afterMulti.indexOf('a.png') < afterMulti.indexOf('b.png'), afterMulti);

    /* ---- 4. 非图片文件不接管（仍交给浏览器/内核默认路径） ---- */
    editor.setValue('正文', false);
    const pdf = new dom.window.File(['pdf'], '报告.pdf', { type: 'application/pdf' });
    const beforeCount = uploaded.length;
    const pdfEvent = pasteWith([pdf]);
    await wait(40);
    check('non-image paste is not taken over', pdfEvent.defaultPrevented === false);
    check('non-image paste uploads nothing', uploaded.length === beforeCount, uploaded);
    check('non-image paste leaves the document alone', editor.getValue() === '正文', editor.getValue());

    /* ---- 5. 纯文本粘贴不受影响 ---- */
    const textEvent = pasteWith([]);
    check('text-only paste is not taken over', textEvent.defaultPrevented === false);

    /* ---- 6. 阅读模式不接管（只读，图片应可正常选择/浏览） ---- */
    editor.setReadingMode(true);
    const readEvent = pasteWith([new dom.window.File(['x'], 'read.png', { type: 'image/png' })]);
    await wait(40);
    check('reading mode does not take over paste', readEvent.defaultPrevented === false);
    editor.setReadingMode(false);

    /* ---- 7. 上传失败：不落文、不写 Base64、给出提示 ---- */
    editor.setValue('失败前', false);
    failNext = true;
    const toasts = [];
    const previousToaster = window.toaster;
    window.toaster = { show: (message) => toasts.push(message) };
    pasteWith([new dom.window.File(['bad'], 'bad.png', { type: 'image/png' })]);
    await wait(60);
    check('failed upload writes nothing', editor.getValue() === '失败前', editor.getValue());
    check('failed upload reports loudly', toasts.some(message => String(message).includes('上传失败')), toasts);
    const failedCards = articleUploadProgressPluginKey.getState(view.state)?.items || [];
    check('failed upload keeps its error card in place', failedCards.length === 1 && failedCards[0].phase === 'error', failedCards.map(item => ({ phase: item.phase, error: item.error })));
    // 与卡片「移除」按钮同一条清理通道，别把错误卡片漏给后续用例。
    view.dispatch(view.state.tr.setMeta(articleUploadProgressPluginKey, { type: 'CLEAR' }));
    check('error card is dismissable via the shared channel', (articleUploadProgressPluginKey.getState(view.state)?.items || []).length === 0);
    window.toaster = previousToaster;
    failNext = false;

    /* ---- 8. 存量 Base64 图片仍可读（allowBase64 不回退） ---- */
    editor.setValue(`![旧图](${BASE64_PNG} "dumbpad-width=360")`, false);
    check('legacy base64 images still parse', editor.getValue().includes('data:image/png'), editor.getValue().slice(0, 80));

    /* ---- 9. 粘贴期间挂进度卡片：注册、onProgress 驱动、成功撤卡 ---- */
    editor.setValue('', false);
    let capturedOnProgress = null;
    let resolveUpload = null;
    editor.assetApi = {
        uploadImage(file, { onProgress } = {}) {
            capturedOnProgress = onProgress || null;
            return new Promise((resolve) => { resolveUpload = () => resolve({ name: file.name, previewUrl: `/api/assets/stub-progress/preview` }); });
        },
    };
    pasteWith([new dom.window.File(['p'], '进度.png', { type: 'image/png' })]);
    await wait(30);
    const pendingCards = articleUploadProgressPluginKey.getState(view.state)?.items || [];
    check('paste registers an upload card at once', pendingCards.length === 1 && pendingCards[0].isImage === true && pendingCards[0].phase === 'uploading', pendingCards.map(item => ({ phase: item.phase, percent: item.percent })));
    check('upload progress callback is wired to uploadImage', typeof capturedOnProgress === 'function');
    capturedOnProgress?.({ phase: 'uploading', percent: 42, loaded: 42, total: 100 });
    check('progress callback drives the card item', pendingCards[0].percent === 42 && pendingCards[0].phase === 'uploading', { percent: pendingCards[0].percent, phase: pendingCards[0].phase });
    check('uploading card writes no document content', editor.getValue() === '', editor.getValue());
    resolveUpload?.();
    await wait(60);
    check('card is removed after success', (articleUploadProgressPluginKey.getState(view.state)?.items || []).length === 0);
    check('successful paste still lands narrow-width markdown', editor.getValue().includes('![进度.png](/api/assets/stub-progress/preview "dumbpad-width=360")'), editor.getValue());

    console.log('');
    if (failures > 0) {
        console.error(`${failures} image paste checks failed`);
        process.exit(1);
    }
    console.log('Image paste checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
