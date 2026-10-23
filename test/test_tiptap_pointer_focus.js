/**
 * 非文本元素点按夺焦守卫回归：点图片 / 附件胶囊 / 嵌入媒体 / 代码块工具条 /
 * mermaid 预览这些装饰性节点时，mousedown 的默认行为必须被拦掉——否则浏览器
 * 会把焦点交给 contenteditable 并**把上一次的光标滚进视野**（光标在文首、
 * 滚到底部点一张图，视线被拽回文首），移动端还会顺带弹软键盘。
 * 原生媒体控件与表单控件必须保留默认行为，否则控件点不动。
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

const ASSET_ID = 'abcdef0123456789';
const IMAGE_SRC = `/api/assets/${ASSET_ID}/preview`;
const FILE_TITLE = 'dumbpad-file=1;size=1258291;type=application%2Fpdf';
const MEDIA_TITLE = 'dumbpad-video=1;size=1000;type=video%2Fmp4;name=clip';

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
    const { isChromePointerTarget } = await import('../public/managers/tiptap-pointer-focus.js');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const view = editor.editor.view;
    const root = container.querySelector('.tiptap');

    const mousedownOn = (element) => {
        const event = new dom.window.MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0, view: dom.window,
        });
        element.dispatchEvent(event);
        return event;
    };

    /* ---- 1. 图片：mousedown 默认行为被拦（不夺焦、不滚光标） ---- */
    editor.setValue(`![示意图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    const img = root.querySelector('img');
    check('image is rendered', Boolean(img));
    check('image mousedown is default-prevented', mousedownOn(img).defaultPrevented);

    /* ---- 2. 附件胶囊 ---- */
    editor.setValue(`[报告.pdf · 1.2 MB](/api/assets/${ASSET_ID}/download "${FILE_TITLE}")`, false);
    const fileLink = root.querySelector('a.dumbpad-article-file');
    check('attachment capsule is rendered', Boolean(fileLink));
    check('attachment mousedown is default-prevented', mousedownOn(fileLink).defaultPrevented);

    /* ---- 3. 嵌入媒体卡片：卡片本体拦，原生播放器放行 ---- */
    editor.setValue(`![clip · 1 KB](/api/assets/${ASSET_ID}/original "${MEDIA_TITLE}")`, false);
    const media = root.querySelector('.dumbpad-article-media');
    const video = media?.querySelector('video');
    check('media card is rendered', Boolean(media) && Boolean(video));
    if (media && video) {
        check('media card mousedown is default-prevented', mousedownOn(media).defaultPrevented);
        check('native video mousedown is NOT prevented', mousedownOn(video).defaultPrevented === false);
    }

    /* ---- 4. 代码块工具条 / 复制按钮：拦；但按钮本体属于表单控件，放行 ---- */
    editor.setValue('```js\nconst a = 1;\n```', false);
    const codeHeader = root.querySelector('.dumbpad-code-header');
    const copyButton = root.querySelector('.dumbpad-code-copy');
    check('code header is rendered', Boolean(codeHeader));
    check('code header mousedown is default-prevented', mousedownOn(codeHeader).defaultPrevented);
    // 复制按钮有自己的 mousedown 处理（它本来就要 preventDefault 以保住选区），
    // 所以这里断言的是「守卫不认领它」——否则两套逻辑会互相干扰。
    check('code copy button is not a chrome target', isChromePointerTarget(copyButton) === false);

    /* ---- 5. 正文文字与表格单元格不受影响（必须照常放光标） ---- */
    editor.setValue('普通段落', false);
    const paragraph = root.querySelector('p');
    check('plain paragraph mousedown is NOT prevented', mousedownOn(paragraph).defaultPrevented === false);

    /* ---- 6. 判定函数本身：装饰性命中、原生控件与正文不命中 ---- */
    editor.setValue(`![图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    const freshImg = root.querySelector('img');
    check('isChromePointerTarget hits image', isChromePointerTarget(freshImg) === true);
    check('isChromePointerTarget misses plain text', isChromePointerTarget(root.querySelector('p')) === false);
    const fakeInput = document.createElement('input');
    check('isChromePointerTarget misses form controls', isChromePointerTarget(fakeInput) === false);
    check('isChromePointerTarget tolerates null', isChromePointerTarget(null) === false);

    /* ---- 7. 阅读模式：不拦（此时点图要开 lightbox，原生行为无害） ---- */
    editor.setValue(`![示意图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    editor.setReadingMode(true);
    const readImg = root.querySelector('img');
    check('reading mode does not guard mousedown', mousedownOn(readImg).defaultPrevented === false);
    editor.setReadingMode(false);

    /* ---- 8. 右键不拦（上下文菜单是另一条路径） ---- */
    editor.setValue(`![示意图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    const rightImg = root.querySelector('img');
    const rightEvent = new dom.window.MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 2, view: dom.window,
    });
    rightImg.dispatchEvent(rightEvent);
    check('right button mousedown is not guarded', rightEvent.defaultPrevented === false);

    console.log('');
    if (failures > 0) {
        console.error(`${failures} pointer focus guard checks failed`);
        process.exit(1);
    }
    console.log('Pointer focus guard checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
