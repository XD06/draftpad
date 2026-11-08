/**
 * Mermaid 图表全屏预览回归。
 *
 * 三条线都真实踩过，全部钉在这里：
 *
 * 1) **点全屏按钮会切成源码态**。按钮挂在 NodeView 自管的 DOM 里，而
 *    `.dumbpad-mermaid-render` 的 mousedown 会把光标塞进代码块（= 当场切源码、
 *    图消失）。按钮必须在 pointerdown / mousedown 上都 stopPropagation，
 *    渲染容器的 mousedown 也要对按钮早退。
 * 2) **灯箱只认 `<img>`**。图表要复用同一条预览路径，且必须挂 svg 节点本身：
 *    mermaid 用 `<foreignObject>` 画节点文字，转成 data:URL 塞进 `<img>`
 *    会让文字整片消失。
 * 3) **尺寸两处坑**：mermaid 的 svg 只有 viewBox、没有固有尺寸，直接铺满舞台
 *    会把小图吹成卡通尺寸；而舞台用 grid 时 `max-height:100%` 解析不出来，
 *    宽度被钳、高度不钳，宽高比直接崩掉。所以固有尺寸按 viewBox × 2.2 写回，
 *    舞台必须是 flex。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) console.log(`PASS ${name}`);
    else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
};

/** 1. 源码契约：按钮的接线与「不许把光标塞回代码块」的守卫。 */
function checkSourceContracts() {
    const view = read('public/managers/tiptap-code-block-view.js');

    check('the fullscreen button is created in the mermaid NodeView',
        /classList\.add\('dumbpad-mermaid-fullscreen'\)|className\s*=\s*'dumbpad-mermaid-fullscreen'/.test(view),
        'no .dumbpad-mermaid-fullscreen button');
    check('the button stops pointerdown from reaching the render container',
        /addEventListener\('pointerdown'[\s\S]{0,120}stopPropagation/.test(view),
        'pointerdown must not bubble');
    check('the button stops mousedown and cancels its default',
        /addEventListener\('mousedown'[\s\S]{0,160}preventDefault[\s\S]{0,80}stopPropagation/.test(view),
        'mousedown must be cancelled + stopped');
    check('the render container ignores clicks on the button',
        /closest\?\.\('\.dumbpad-mermaid-fullscreen'\)\)\s*return;/.test(view),
        'the mermaid render mousedown handler must bail out for the button');
    check('the button is re-attached after the svg is written',
        /innerHTML\s*=\s*svg;[\s\S]{0,200}appendChild\(ensureFullscreenButton\(\)\)/.test(view),
        'innerHTML = svg wipes children, the button must be appended after it');
    check('the button opens the shared article lightbox',
        /openArticleLightbox\(\{[\s\S]{0,200}svg/.test(view),
        'the button must hand the svg to openArticleLightbox');

    const css = read('public/Assets/styles.css');
    check('the button is hidden until hover',
        /\.dumbpad-mermaid-fullscreen\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s.test(css),
        'a transparent but clickable button is a trap');
    check('the button stays visible on touch devices',
        /@media\s*\(hover:\s*none\)\s*\{[^}]*\.dumbpad-mermaid-fullscreen\s*\{[^}]*opacity:\s*0?\.\d+/s.test(css),
        'no @media (hover: none) fallback');
    check('the lightbox stage is flex, not grid',
        /\.article-image-lightbox-svg\s*\{[^}]*display:\s*flex/s.test(css),
        'grid makes max-height:100% resolve to none on the item');
    check('the diagram gets a paper background inside the dark overlay',
        /\.article-image-lightbox-svg svg\s*\{[^}]*background:\s*var\(--textarea-bg\)/s.test(css),
        'mermaid svgs are transparent — dark text on the 0.86 black overlay');
}

/** 2. 纯函数：viewBox 解析。 */
async function checkViewBoxParsing(openArticleLightbox, mod) {
    const svg = (viewBox) => {
        const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
        const el = dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        if (viewBox !== null) el.setAttribute('viewBox', viewBox);
        return el;
    };
    check('viewBox: a normal box parses',
        JSON.stringify(mod.readViewBoxSize(svg('0 0 107.6875 174'))) === '{"width":107.6875,"height":174}',
        mod.readViewBoxSize(svg('0 0 107.6875 174')));
    check('viewBox: commas are accepted', mod.readViewBoxSize(svg('-50,-10,905,679'))?.width === 905);
    check('viewBox: a missing attribute is null', mod.readViewBoxSize(svg(null)) === null);
    check('viewBox: a zero-sized box is rejected', mod.readViewBoxSize(svg('0 0 0 100')) === null);
    check('viewBox: garbage is rejected', mod.readViewBoxSize(svg('nonsense')) === null);
    return openArticleLightbox;
}

/** 3. 灯箱行为：svg 与图片共用同一个灯箱，互不串台。 */
async function checkLightboxBehaviour(mod, wrapper) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 50');
    svg.setAttribute('width', '100%');
    svg.setAttribute('style', 'max-width: 100px;');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', '100');
    rect.setAttribute('height', '50');
    svg.appendChild(rect);

    const opened = mod.openArticleLightbox({ name: 'Mermaid 图表', svg, downloadName: 'mermaid.svg' });
    check('lightbox: an open request reaches the registered view', opened === true, opened);

    const lightbox = document.querySelector('.article-image-lightbox');
    const svgHost = lightbox.querySelector('.article-image-lightbox-svg');
    const image = lightbox.querySelector('.article-image-lightbox-image');
    const mounted = svgHost.querySelector('svg');

    check('lightbox: the diagram is mounted as a live svg node, not an <img>', Boolean(mounted));
    check('lightbox: the image slot is hidden for diagrams', image.hidden === true);
    check('lightbox: the svg gets an intrinsic size from its viewBox (x2.2)',
        mounted?.getAttribute('width') === '220' && mounted?.getAttribute('height') === '110',
        { width: mounted?.getAttribute('width'), height: mounted?.getAttribute('height') });
    check('lightbox: mermaid inline max-width is stripped',
        !mounted?.getAttribute('style'), mounted?.getAttribute('style'));
    check('lightbox: the clone is not the original node', mounted !== svg);
    check('lightbox: the source svg is untouched', svg.getAttribute('width') === '100%');
    check('lightbox: the title bar names the diagram',
        lightbox.querySelector('.article-image-lightbox-name').textContent === 'Mermaid 图表');
    check('lightbox: the download is named .svg',
        lightbox.querySelector('.article-image-lightbox-download').getAttribute('download') === 'mermaid.svg');
    check('lightbox: the open state is on <body>',
        document.body.classList.contains('article-image-lightbox-open'));

    // 同一灯箱切回图片：svg 必须让位，不能两张图叠着
    mod.openArticleLightbox({ name: '截图.png', src: '/api/assets/aaaaaaaaaaaaaaaaaaaaaaaa/preview' });
    check('lightbox: switching to an image clears the svg slot',
        svgHost.querySelector('svg') === null && svgHost.hidden === true);
    check('lightbox: the image slot is restored', image.hidden === false && image.src.endsWith('/preview'));

    lightbox.querySelector('.article-image-lightbox-close').click();
    check('lightbox: close resets everything',
        lightbox.hidden === true
        && !document.body.classList.contains('article-image-lightbox-open')
        && svgHost.querySelector('svg') === null);
    check('lightbox: the editor survived the round trip', Boolean(wrapper.editor?.state));
}

/** 先把 jsdom + 内核 bundle 装好，再导入任何 managers 模块（tiptap-runtime 要求）。 */
async function bootEditor() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.Node = dom.window.Node;
    global.NodeFilter = dom.window.NodeFilter;
    global.Element = dom.window.Element;
    global.HTMLElement = dom.window.HTMLElement;
    global.Range = dom.window.Range;
    global.KeyboardEvent = dom.window.KeyboardEvent;
    global.XMLSerializer = dom.window.XMLSerializer;
    global.Blob = dom.window.Blob;
    global.getSelection = dom.window.getSelection.bind(dom.window);
    Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
    if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    global.requestAnimationFrame = dom.window.requestAnimationFrame;
    if (!dom.window.Element.prototype.scrollIntoView) {
        dom.window.Element.prototype.scrollIntoView = () => {};
    }
    vm.runInThisContext(read('public/vendor/tiptap/tiptap.bundle.js'));

    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const container = document.createElement('div');
    container.className = 'typora-editor-shell';
    document.body.appendChild(container);
    const wrapper = new HybridMarkdownEditor(container, {});
    await wrapper.whenReady();
    return wrapper;
}

async function main() {
    checkSourceContracts();
    const wrapper = await bootEditor();
    const mod = await import(pathToFileURL(
        path.join(ROOT, 'public/managers/tiptap-image-interactions.js')).href);
    checkViewBoxParsing(null, mod);
    await checkLightboxBehaviour(mod, wrapper);

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log('\nMermaid fullscreen checks passed');
}

main().catch((error) => {
    console.error('FAILED', error);
    process.exitCode = 1;
});
