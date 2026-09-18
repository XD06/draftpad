/**
 * Tiptap 文章图片/附件交互回归：点图片不再弹文字选区菜单、尺寸菜单四档宽度
 * 写入 title="dumbpad-width=N" 并序列化回 markdown、删除图片、下载原图与
 * 查看大图（纯 DOM 链接）、阅读模式点图开 lightbox、附件链接菜单。
 * （旧 Vditor 图片交互层的黑盒重写；jsdom 无布局环境，位置计算只做不 throw 校验）
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
global.HTMLAnchorElement = dom.window.HTMLAnchorElement;
global.getComputedStyle = dom.window.getComputedStyle;
if (!dom.window.requestAnimationFrame) {
    dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
}
// jsdom 无布局环境：Range/Element 的矩形与 elementFromPoint 不可用（拖拽落点、
// 菜单定位在真实浏览器才有效，这里只保证不 throw、不误改文档）。
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
const IMAGE_DOWNLOAD = `/api/assets/${ASSET_ID}/download`;
const IMAGE_ORIGINAL = `/api/assets/${ASSET_ID}/original`;
const IMAGE_ONLY = `![示意图](${IMAGE_SRC})`;
const IMAGE_WITH_TEXT = `${IMAGE_ONLY}\n\n正文段落`;
const IMAGE_A_SRC = '/api/assets/aaaa0123456789ab/preview';
const IMAGE_B_SRC = '/api/assets/bbbb0123456789ab/preview';
const TWO_IMAGES = `![图A](${IMAGE_A_SRC})\n\n![图B](${IMAGE_B_SRC})`;
const LEGACY_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC';
const FILE_LABEL = '报告.pdf · 1.2 MB';
const FILE_TITLE = 'dumbpad-file=1;size=1258291;type=application%2Fpdf';
const FILE_ONLY = `[${FILE_LABEL}](${IMAGE_DOWNLOAD} "${FILE_TITLE}")`;
const LEGACY_FILE_ONLY = `[📎 ${FILE_LABEL}](${IMAGE_DOWNLOAD} "${FILE_TITLE}")`;

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
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    // jsdom 不计算布局：clientWidth 恒为 0，宽度上限会退化成视口宽度。
    // 这里固定内容区宽度，让四档宽度的断言确定。
    Object.defineProperty(container.querySelector('.tiptap'), 'clientWidth', {
        value: 1200,
        configurable: true,
    });

    const contentRoot = () => container.querySelector('.tiptap');
    const imageEl = () => container.querySelector('.tiptap img');
    const selectionMenu = () => document.body.querySelector('.tiptap-selection-menu');
    const sizeMenu = () => document.body.querySelector('.article-image-size-menu');
    const fileMenu = () => document.body.querySelector('.article-file-menu');
    const lightbox = () => document.body.querySelector('.article-image-lightbox');

    const click = (element, props = {}) => {
        element.dispatchEvent(new dom.window.MouseEvent('click', {
            bubbles: true, cancelable: true, view: dom.window, ...props,
        }));
    };
    // jsdom 不实现 PointerEvent：用 MouseEvent 承载并补上 pointer 字段。
    const pointerEvent = (type, props = {}) => {
        const event = new dom.window.MouseEvent(type, {
            bubbles: true, cancelable: true, view: dom.window, ...props,
        });
        Object.defineProperty(event, 'pointerId', { value: props.pointerId ?? 1 });
        Object.defineProperty(event, 'pointerType', { value: props.pointerType ?? 'touch' });
        return event;
    };
    const imageNode = () => {
        let found = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && !found) {
                found = { node, pos };
                return false;
            }
            return true;
        });
        return found;
    };
    const imageTitle = () => imageNode()?.node.attrs.title ?? null;
    const docChildTypes = () => {
        const names = [];
        editor.editor.state.doc.forEach((node) => names.push(node.type.name));
        return names.join(',');
    };
    const firstImageSrc = () => {
        let src = null;
        editor.editor.state.doc.descendants((node) => {
            if (node.type.name === 'image' && src === null) {
                src = node.attrs.src;
                return false;
            }
            return true;
        });
        return src;
    };
    const sizeButton = (width) => sizeMenu().querySelector(`[data-image-width="${width}"]`);

    /* ---- 1. 点图片不弹文字选区菜单（NodeSelection 不再是 mark 菜单的合法选区） ---- */
    editor.setValue(IMAGE_ONLY, false);
    check('image rendered as block node', Boolean(imageEl()) && imageNode()?.node.type.name === 'image');
    check('asset image gets decoration class', contentRoot().querySelector('img')?.classList.contains('dumbpad-article-image') === true);
    // schema 层关闭 PM 节点拖拽（<img> 自身的原生拖拽由下方 dragstart 拦截）
    check('image node is not draggable in schema', editor.editor.schema.nodes.image.spec.draggable === false,
        String(editor.editor.schema.nodes.image.spec.draggable));
    {
        const dragStart = new dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true, view: dom.window });
        imageEl().dispatchEvent(dragStart);
        check('native image dragstart is prevented', dragStart.defaultPrevented);
    }

    // 点击图片会（由 PM 鼠标管线）产生非空 NodeSelection，这里直接构造该状态。
    {
        const { NodeSelection } = global.DumbPadTiptap.PM.state;
        const pos = imageNode().pos;
        editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
            NodeSelection.create(editor.editor.state.doc, pos)
        ));
        await wait(30);
        check('image node selection does not show text menu', selectionMenu().style.display === 'none', selectionMenu().style.display);
    }
    click(imageEl());
    await wait(30);
    check('click on image still no text menu', selectionMenu().style.display === 'none', selectionMenu().style.display);
    check('click on image opens size menu', sizeMenu().hidden === false);

    // 回归：文字选区的菜单已经显示时再点图片，旧菜单必须收起（不是「不新开」）。
    // 文档里同时有段落与图片、中间不做任何 setValue（setValue 会派发事务，
    // 插件 update() 自己就会把菜单收掉，那样这段断言就变成恒真）。
    // 走真实 DOM 事件顺序：mousedown（进入拖拽态，拦住 update() 的隐藏分支）
    // → 选区事务（图片 NodeSelection）→ mouseup（宏任务补判）→ click。
    {
        const mouseOpts = { bubbles: true, cancelable: true, view: dom.window };
        editor.setValue(`文字选区段落\n\n${IMAGE_ONLY}`, false);
        editor.editor.view.dom.dispatchEvent(new dom.window.MouseEvent('mousedown', mouseOpts));
        {
            const { TextSelection } = global.DumbPadTiptap.PM.state;
            editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
                TextSelection.create(editor.editor.state.doc, 1, 5)
            ));
        }
        editor.editor.view.dom.dispatchEvent(new dom.window.MouseEvent('mouseup', mouseOpts));
        await wait(30);
        check('text selection showed menu before image click', selectionMenu().style.display === 'flex', selectionMenu().style.display);
        check('image present in the stale menu scenario', Boolean(imageEl()) && imageNode()?.pos > 0, String(imageNode()?.pos));

        imageEl().dispatchEvent(new dom.window.MouseEvent('mousedown', mouseOpts));
        {
            const { NodeSelection } = global.DumbPadTiptap.PM.state;
            editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
                NodeSelection.create(editor.editor.state.doc, imageNode().pos)
            ));
        }
        imageEl().dispatchEvent(new dom.window.MouseEvent('mouseup', mouseOpts));
        click(imageEl());
        await wait(30);
        check('stale text menu hidden after clicking image', selectionMenu().style.display === 'none', selectionMenu().style.display);
        check('image size menu opened in the same click', sizeMenu().hidden === false);
    }
    editor.setValue(IMAGE_ONLY, false); // 复位：后续宽度断言按「只有一张图」的文档算字节
    await wait(10);

    /* ---- 2. 尺寸菜单四档宽度 ---- */
    const widthButtons = [...sizeMenu().querySelectorAll('[data-image-width]')];
    check(
        'size menu exposes four width presets',
        widthButtons.map((button) => button.dataset.imageWidth).join(',') === '360,720,1080,0',
        widthButtons.map((button) => button.dataset.imageWidth).join(',')
    );
    check('size menu has download/fullscreen/delete actions',
        Boolean(sizeMenu().querySelector('[data-image-download]'))
        && Boolean(sizeMenu().querySelector('[data-image-fullscreen]'))
        && Boolean(sizeMenu().querySelector('[data-image-delete]')));

    const assertWidth = async (width, expectedBytes) => {
        click(imageEl());
        await wait(10);
        click(sizeButton(width));
        await wait(30);
        const value = editor.getValue();
        check(`width ${width || 'auto'} written to image attr`, imageTitle() === expectedBytes, String(imageTitle()));
        check(
            `width ${width || 'auto'} serialized into markdown`,
            expectedBytes ? value.includes(expectedBytes) : !value.includes('dumbpad-width'),
            value
        );
        check(`width ${width || 'auto'} hides size menu after applying`, sizeMenu().hidden === true);
        return value;
    };

    // 窄/中/宽写 title；自适应清空 title。
    await assertWidth(360, 'dumbpad-width=360');
    check('narrow width applied to rendered image', imageEl()?.style.width === '360px', imageEl()?.getAttribute('style'));
    await assertWidth(720, 'dumbpad-width=720');
    check('medium width roundtrips byte-exact', editor.getValue() === `![示意图](${IMAGE_SRC} "dumbpad-width=720")`, editor.getValue());
    await assertWidth(1080, 'dumbpad-width=1080');
    check('wide width applied to rendered image', imageEl()?.style.width === '1080px', imageEl()?.getAttribute('style'));
    await assertWidth(0, null);
    check('auto width removes title from markdown', !editor.getValue().includes('dumbpad-width'));

    /* ---- 3. 宽度在带正文的文档里也写回 title（序列化含 dumbpad-width） ---- */
    editor.setValue(IMAGE_WITH_TEXT, false);
    click(imageEl());
    await wait(10);
    click(sizeButton(720));
    await wait(30);
    check('width persists with surrounding paragraph', imageTitle() === 'dumbpad-width=720', String(imageTitle()));
    check('paragraph image markdown keeps dumbpad-width', editor.getValue().includes('![示意图](') && editor.getValue().includes('"dumbpad-width=720"'), editor.getValue());
    check('paragraph text preserved', editor.getValue().includes('正文段落'), editor.getValue());

    /* ---- 4. 下载原图 / 查看大图是纯 DOM 链接与按钮 ---- */
    editor.setValue(IMAGE_ONLY, false);
    click(imageEl());
    await wait(10);
    const downloadLink = sizeMenu().querySelector('[data-image-download]');
    check('download original is an anchor with asset download href', downloadLink.tagName === 'A' && downloadLink.href.endsWith(IMAGE_DOWNLOAD), downloadLink.outerHTML);
    check('download original carries download filename', downloadLink.download === '示意图', downloadLink.getAttribute('download'));

    click(sizeMenu().querySelector('[data-image-fullscreen]'));
    await wait(30);
    check('fullscreen closes size menu', sizeMenu().hidden === true);
    check('lightbox opens on fullscreen', lightbox().hidden === false);
    check('lightbox shows original asset url', lightbox().querySelector('.article-image-lightbox-image').getAttribute('src') === IMAGE_ORIGINAL,
        lightbox().querySelector('.article-image-lightbox-image').getAttribute('src'));
    check('lightbox download link points to asset download', lightbox().querySelector('.article-image-lightbox-download').getAttribute('href') === IMAGE_DOWNLOAD);
    check('lightbox shows image name', lightbox().querySelector('.article-image-lightbox-name').textContent === '示意图');
    check('lightbox locks body scroll class', document.body.classList.contains('article-image-lightbox-open'));

    click(lightbox().querySelector('.article-image-lightbox-close'));
    await wait(10);
    check('lightbox closes', lightbox().hidden === true && !document.body.classList.contains('article-image-lightbox-open'));

    /* ---- 5. 阅读模式点图直接开 lightbox（不弹尺寸菜单） ---- */
    editor.setReadingMode(true);
    click(imageEl());
    await wait(30);
    check('reading mode click opens lightbox', lightbox().hidden === false);
    check('reading mode click does not open size menu', sizeMenu().hidden === true);
    click(lightbox().querySelector('.article-image-lightbox-close'));
    editor.setReadingMode(false);

    /* ---- 6. 删除图片走框架事务并可撤销 ---- */
    editor.setValue(IMAGE_ONLY, false);
    await wait(600); // 断开 history 分组，保证 undo 只撤销删除本身
    click(imageEl());
    await wait(10);
    click(sizeMenu().querySelector('[data-image-delete]'));
    await wait(30);
    check('delete removes image node', imageNode() === null, editor.getValue());
    check('delete removes image markdown', !editor.getValue().includes('![示意图]'), editor.getValue());
    check('delete closes size menu', sizeMenu().hidden === true);
    editor.editor.commands.undo();
    check('delete is undoable', imageNode() !== null && editor.getValue().includes('![示意图]'), editor.getValue());

    /* ---- 7. 非资产图片不参与装饰与菜单（与旧 decorateArticleImages 一致） ---- */
    editor.setValue('![外链](https://example.com/a.png)', false);
    check('external image gets no article image class', contentRoot().querySelector('img')?.classList.contains('dumbpad-article-image') === false);
    click(imageEl());
    await wait(30);
    check('external image opens no size menu', sizeMenu().hidden === true);

    /* ---- 7.5 遗留 Base64 内联图片：不再被 schema 丢弃，且参与装饰与菜单 ---- */
    editor.setValue(`![旧图](${LEGACY_BASE64})`, false);
    check('legacy base64 image survives parsing',
        Boolean(imageEl()) && String(imageNode()?.node.attrs.src || '').startsWith('data:image/'),
        editor.getValue());
    check('legacy base64 image gets article image class',
        contentRoot().querySelector('img')?.classList.contains('dumbpad-article-image') === true);
    check('legacy base64 markdown roundtrips byte-exact',
        editor.getValue() === `![旧图](${LEGACY_BASE64})`, editor.getValue());
    click(imageEl());
    await wait(30);
    check('legacy base64 image opens size menu',
        sizeMenu().hidden === false
        && sizeMenu().querySelector('[data-image-download]').getAttribute('href') === LEGACY_BASE64,
        sizeMenu().querySelector('[data-image-download]').getAttribute('href'));

    /* ---- 8. 附件链接：类名渲染 + 下载/删除菜单 ---- */
    editor.setValue(FILE_ONLY, false);
    const fileLink = container.querySelector('a');
    check('attachment link renders dumbpad-article-file class', fileLink?.classList.contains('dumbpad-article-file') === true, fileLink?.outerHTML);
    check('attachment link serialization unchanged', editor.getValue() === FILE_ONLY, editor.getValue());

    // 旧 label 的「📎 」前缀在解析期去掉（图标改由 CSS 提供），不再出现双图标。
    editor.setValue(LEGACY_FILE_ONLY, false);
    check('legacy emoji label normalized away', editor.getValue() === FILE_ONLY, editor.getValue());

    click(container.querySelector('a'));
    await wait(30);
    check('attachment click opens file menu', fileMenu().hidden === false);
    const fileDownload = fileMenu().querySelector('[data-file-download]');
    check('file menu download uses link href', fileDownload.getAttribute('href') === IMAGE_DOWNLOAD, fileDownload.outerHTML);
    check('file menu download filename derived from label', fileDownload.download === '报告.pdf', fileDownload.getAttribute('download'));

    // 根因回归：Tiptap 的 Link 扩展默认 openOnClick=true，它的 PM handleClick（挂在
    // view.dom 冒泡阶段、且注册早于插件 view）会对链接调 window.open(href, target="_blank")
    // ——对 /api/assets/<id>/download 就是直接下载。附件点击必须在 PM 看到之前
    // （捕获阶段）被拦下，判据是「事件连 <a> 本身都没到达」：只有捕获阶段拦截 + 
    // stopPropagation 才能做到，冒泡阶段拦截时目标元素早已收到事件。
    {
        const link = container.querySelector('a');
        let targetReached = false;
        let bubbleReached = false;
        const onTargetClick = () => { targetReached = true; };
        const onBubbleClick = () => { bubbleReached = true; };
        link.addEventListener('click', onTargetClick);
        editor.editor.view.dom.addEventListener('click', onBubbleClick);
        click(link);
        await wait(30);
        check('attachment click stopped before reaching the link itself', targetReached === false);
        check('attachment click never reaches bubble-phase handlers', bubbleReached === false);
        check('attachment click opened the menu instead', fileMenu().hidden === false);
        // 对照组：普通文本点击不该被拦，目标与冒泡探针都要收到
        const paragraph = container.querySelector('.tiptap p');
        paragraph.addEventListener('click', onTargetClick);
        click(paragraph);
        await wait(10);
        check('control: plain text click reaches target and bubble handlers', targetReached === true && bubbleReached === true);
        link.removeEventListener('click', onTargetClick);
        paragraph.removeEventListener('click', onTargetClick);
        editor.editor.view.dom.removeEventListener('click', onBubbleClick);
    }

    // title 丢失、只有资产下载 URL 的旧附件链接同样走菜单（而不是被 Link 扩展下载）
    {
        editor.setValue(`[报告.pdf](${IMAGE_DOWNLOAD})`, false);
        const bareLink = container.querySelector('a');
        check('title-less asset link still gets the attachment chip', bareLink?.classList.contains('dumbpad-article-file') === true, bareLink?.outerHTML);
        click(bareLink);
        await wait(30);
        check('title-less asset link opens the file menu', fileMenu().hidden === false);
        check('title-less asset link download uses its href', fileMenu().querySelector('[data-file-download]').getAttribute('href') === IMAGE_DOWNLOAD);
    }

    await wait(600);
    click(fileMenu().querySelector('[data-file-delete]'));
    await wait(30);
    check('file delete removes attachment link', !editor.getValue().includes('报告.pdf'), editor.getValue());
    check('file delete closes file menu', fileMenu().hidden === true);
    editor.editor.commands.undo();
    check('file delete is undoable', editor.getValue().includes('报告.pdf'), editor.getValue());

    /* ---- 8.5 宽度上限钳制（旧 max(240, floor(clientWidth || innerWidth-48))） ---- */
    Object.defineProperty(contentRoot(), 'clientWidth', { value: 300, configurable: true });
    editor.setValue(IMAGE_ONLY, false);
    click(imageEl());
    await wait(10);
    click(sizeButton(360));
    await wait(30);
    check('width clamps to content width', imageTitle() === 'dumbpad-width=300', String(imageTitle()));
    Object.defineProperty(contentRoot(), 'clientWidth', { value: 1200, configurable: true });

    /* ---- 8.6 只有一个字符且位于文末的附件链接也能删除（mark 反查的边界） ---- */
    editor.setValue(`[a](${IMAGE_DOWNLOAD} "dumbpad-file=1;size=1;type=text%2Fplain")`, false);
    click(container.querySelector('a'));
    await wait(30);
    click(fileMenu().querySelector('[data-file-delete]'));
    await wait(30);
    check('single-char attachment at doc end deletes', editor.getValue().trim() === '', JSON.stringify(editor.getValue()));

    /* ---- 9. 指针拖拽换位：jsdom 无布局，块矩形与 elementFromPoint 显式打桩 ---- */
    const stubBlockRects = () => {
        const blocks = Array.from(contentRoot().children);
        blocks.forEach((block, index) => {
            const top = index * 100;
            block.getBoundingClientRect = () => ({ left: 0, top, right: 400, bottom: top + 80, width: 400, height: 80 });
        });
        return blocks;
    };
    const setElementFromPoint = (element) => {
        dom.window.document.elementFromPoint = () => element;
        global.document.elementFromPoint = dom.window.document.elementFromPoint;
    };
    const dragImageTo = async (clientY, { startY = 30 } = {}) => {
        imageEl().dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: startY, pointerType: 'touch' }));
        imageEl().dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY, pointerType: 'touch' }));
        imageEl().dispatchEvent(pointerEvent('pointerup', { clientX: 200, clientY, pointerType: 'touch' }));
        await wait(30);
    };

    // 9a) 指针落在所有块下方（文末空白）：兜底判定为「末块之后」，图片真的移动到文末
    editor.setValue(IMAGE_WITH_TEXT, false);
    await wait(600); // 断开 history 分组，undo 只撤销移动
    check('drag start: image is the first block', docChildTypes().startsWith('image'), docChildTypes());
    stubBlockRects();
    await dragImageTo(2000);
    // StarterKit 的 trailingNode 会在文末非段落节点后补一个空段落，
    // 所以「移动到文末」的稳定形态是 paragraph,image,paragraph。
    check('drag to end of document moves image after the paragraph',
        docChildTypes().split(',').indexOf('image') === 1, docChildTypes());
    check('drag keeps image markdown', editor.getValue().includes('![示意图]'), editor.getValue());
    check('drag clears drop affordances', !contentRoot().classList.contains('is-article-image-drop-target'));
    editor.editor.commands.undo();
    check('drag move is undoable', docChildTypes() === 'image,paragraph', docChildTypes());

    // 9b) 指针落在图片块上半区：解析为原位 → no-op，不产生事务
    editor.setValue(IMAGE_WITH_TEXT, false);
    stubBlockRects();
    const beforeNoopDrag = editor.getValue();
    await dragImageTo(10);
    check('drag onto own position is a no-op', editor.getValue() === beforeNoopDrag, editor.getValue());

    // 9c) elementFromPoint 命中第二个图片块的下半区 → 两张图顺序对调
    editor.setValue(TWO_IMAGES, false);
    const twoImageBlocks = stubBlockRects();
    check('two images rendered as two blocks', twoImageBlocks.length >= 2 && firstImageSrc() === IMAGE_A_SRC, docChildTypes());
    setElementFromPoint(twoImageBlocks[1]);
    await dragImageTo(150); // 第二块 top=100 bottom=180，中心 140 → 下半区
    check('drag onto another image block swaps order', firstImageSrc() === IMAGE_B_SRC, String(firstImageSrc()));
    setElementFromPoint(null);

    /* ---- 10. 触屏点按（无 click 事件）也能开尺寸菜单 ---- */
    click(sizeMenu().querySelector('[data-image-width="0"]')); // 先关掉上一次的菜单状态
    await wait(20);
    imageEl().dispatchEvent(pointerEvent('pointerdown', { clientX: 5, clientY: 5, pointerType: 'touch' }));
    imageEl().dispatchEvent(pointerEvent('pointerup', { clientX: 5, clientY: 5, pointerType: 'touch' }));
    await wait(30);
    check('touch tap opens size menu', sizeMenu().hidden === false);

    // 9d) 目标块是空段落（文末图片 → trailingNode 补的空段落）：落点必须是块边界，
    // 解析成 null 会让拖拽静默失效（posAtDOM 对非叶子块返回的是「块内容起点」）。
    const IMAGE_AFTER_PARAGRAPH = `段落\n\n${IMAGE_ONLY}`;
    editor.setValue(IMAGE_AFTER_PARAGRAPH, false);
    stubBlockRects();
    check('drag start: image sits before the trailing empty paragraph',
        docChildTypes() === 'paragraph,image,paragraph', docChildTypes());
    await dragImageTo(2000);
    check('drag onto trailing empty paragraph moves image to the end',
        docChildTypes().split(',').indexOf('image') === 2, docChildTypes());

    // 9e) 指针在首块之上：兜底判定为「首块之前」
    editor.setValue(IMAGE_AFTER_PARAGRAPH, false);
    stubBlockRects();
    await dragImageTo(-50);
    check('drag above the first block moves image first',
        docChildTypes().split(',').indexOf('image') === 0, docChildTypes());

    /* ---- 11. 浮层收起：点编辑器外 / 目标元素被换掉 / 切源码模式 ---- */
    document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: dom.window }));
    await wait(10);
    check('outside mousedown closes size menu', sizeMenu().hidden === true);

    editor.setValue(IMAGE_ONLY, false);
    await wait(500); // 让上一段触屏点按的 click 抑制窗口（450ms）过期
    click(imageEl());
    await wait(10);
    check('size menu reopened before switching note', sizeMenu().hidden === false);
    editor.setValue('切走后的段落', false); // 图片元素被移除
    await wait(30);
    check('menu closes when its target element is replaced', sizeMenu().hidden === true, String(sizeMenu().hidden));


    await wait(500); // 同上：避免上一段点按的抑制窗口吞掉这次 click
    editor.setValue(IMAGE_ONLY, false);
    click(imageEl());
    await wait(10);
    editor.setSourceMode(true);
    editor.editor.view.dispatch(editor.editor.state.tr.setMeta('imageMenuProbe', 1));
    await wait(30);
    check('source mode closes size menu on next update', sizeMenu().hidden === true, String(sizeMenu().hidden));
    editor.setSourceMode(false);

    /* ---- 12. destroy：菜单/lightbox/竖线从 body 移除，body 类清理 ---- */
    editor.setValue(IMAGE_ONLY, false);
    click(imageEl());
    await wait(10);
    click(sizeMenu().querySelector('[data-image-fullscreen]'));
    await wait(30);
    check('lightbox open right before destroy', lightbox().hidden === false);
    editor.editor.destroy();
    await wait(10);
    check('destroy removes size menu', document.body.querySelector('.article-image-size-menu') === null);
    check('destroy removes lightbox', document.body.querySelector('.article-image-lightbox') === null);
    check('destroy removes file menu', document.body.querySelector('.article-file-menu') === null);
    check('destroy clears lightbox body class', document.body.classList.contains('article-image-lightbox-open') === false);

    console.log('');
    if (failures > 0) {
        console.error(`${failures} tiptap image menu checks failed`);
        process.exit(1);
    }
    console.log('tiptap image menu checks passed');
}

main().catch((error) => {
    console.error('FAIL: unhandled error', error);
    process.exit(1);
});
