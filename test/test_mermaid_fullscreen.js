/**
 * 移动端渲染层回归：窄屏表格折卡 + Mermaid 图表全屏（适应屏幕 / 手动缩放）。
 *
 * 钉住的行为：
 *
 * 表格
 * - 折卡是**显示层决定**：`is-stacked` 挂在表格节点上、`data-label` 挂在数据格
 *   上，全部走 PM Decoration——直接改 DOM 会被 DOMObserver 在重绘时抹掉。
 * - 列标签取「第一行表头」，因为 Tiptap 的表格**不产 `<thead>`**，表头就是
 *   `<tbody>` 的第一个 `<tr><th>`。
 * - 只有容器 ≤480px 且自然宽放不下时才折；桌面 800px 卡片永不命中。
 *
 * 图表灯箱
 * - 点全屏按钮不许把光标塞回代码块（否则当场切源码、图消失）。
 * - 打开默认「适应屏幕」= 整图可见，再靠工具条 −/＋/适应 手动缩放；
 *   缩放/平移只改画布 transform，svg 保持内联（`<foreignObject>` 画字，
 *   data URL + `<img>` 会丢字）。
 * - 图片灯箱不显示缩放工具条，两条路共用一个灯箱。
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

/** 1. 源码契约。 */
function checkSourceContracts() {
    const view = read('public/managers/tiptap-code-block-view.js');
    const stack = read('public/managers/tiptap-table-stack.js');
    const css = read('public/Assets/styles.css');

    check('the fullscreen button is created in the mermaid NodeView',
        /className\s*=\s*'dumbpad-mermaid-fullscreen'/.test(view), 'no .dumbpad-mermaid-fullscreen');
    check('the button stops pointerdown from reaching the render container',
        /addEventListener\('pointerdown'[\s\S]{0,120}stopPropagation/.test(view), 'pointerdown must not bubble');
    check('the button stops mousedown and cancels its default',
        /addEventListener\('mousedown'[\s\S]{0,160}preventDefault[\s\S]{0,80}stopPropagation/.test(view),
        'mousedown must be cancelled + stopped');
    check('the render container ignores clicks on the button',
        /closest\?\.\('\.dumbpad-mermaid-fullscreen'\)\)\s*return;/.test(view),
        'the mermaid render mousedown handler must bail out for the button');
    check('the button is re-attached after the svg is written',
        /innerHTML\s*=\s*svg;[\s\S]{0,200}appendChild\(ensureFullscreenButton\(\)\)/.test(view),
        'innerHTML = svg wipes children, the button must be appended after it');

    check('the button is hidden until hover',
        /\.dumbpad-mermaid-fullscreen\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s.test(css),
        'a transparent but clickable button is a trap');
    check('the button stays visible on touch devices',
        /@media\s*\(hover:\s*none\)\s*\{[^}]*\.dumbpad-mermaid-fullscreen\s*\{[^}]*opacity:\s*0?\.\d+/s.test(css),
        'no @media (hover: none) fallback');

    check('the diagram viewport clips and owns the gestures',
        /\.article-image-lightbox-svg\s*\{[^}]*overflow:\s*hidden[^}]*touch-action:\s*none/s.test(css),
        'the viewport must clip and take over touch gestures');
    check('the diagram canvas carries the paper background',
        /\.article-image-lightbox-canvas\s*\{[^}]*background:\s*var\(--textarea-bg\)/s.test(css),
        'mermaid svgs are transparent — dark text on the 0.86 black overlay');
    check('the zoom toolbar has its own styles',
        /\.article-image-lightbox-zoom\s*\{/s.test(css) && /\.article-image-lightbox-pct\s*\{/s.test(css),
        'missing zoom toolbar styles');

    check('table stacking is decoration-driven, never direct DOM writes',
        /Decoration\.node\(cellPos, cellPos \+ cell\.nodeSize/.test(stack)
        && /class: 'dumbpad-stacked-cell'/.test(stack),
        'the marker and data-label must go through decorations');
    check('table stacking measures the natural width on a clone, not on the live table',
        /table\.cloneNode\(true\)/.test(stack) && /max-content/.test(stack),
        'touching the live table would be recorded by DOMObserver');
    check('table stacking is bounded to narrow containers',
        /STACK_MAX_CONTAINER_PX\s*=\s*480/.test(stack));
    check('only short tables (<= 3 body rows) stack',
        /STACK_MAX_BODY_ROWS\s*=\s*3/.test(stack),
        'long tables keep the grid so the page does not grow several times over');
    check('the vditor first-column ::after spacer is neutralised',
        /\.typora-editor-shell \.vditor-reset table th:first-child::after,\s*\.typora-editor-shell \.vditor-reset table td:first-child::after \{\s*content:\s*none/.test(css),
        'a 24px inline-block spacer fills the first cell, so middle has no room to align');
    check('the table header is left aligned and vertically centred',
        /tr:first-child th\s*\{[^}]*text-align:\s*left[^}]*vertical-align:\s*middle/s.test(css),
        'header text stays left aligned; only vertical alignment is centred');
    check('the first column stays frozen while long tables scroll horizontally',
        /table th:first-child,[\s\S]{0,160}?table td:first-child\s*\{[^}]*position:\s*sticky/s.test(css),
        'freezing the first column keeps a reference while scrolling');
    check('the mobile header is not forced back to vertical-align: top',
        !/tr:first-child th\s*\{[^}]*vertical-align:\s*top/s.test(css),
        'top was a workaround for the 24px ::after spacer, not a fix');
    check('sticky cells keep their borders while the table scrolls',
        /\.tiptap table\s*\{[^}]*border-collapse:\s*separate[^}]*border-spacing:\s*0/s.test(css)
        && !/^\s*-webkit-overflow-scrolling\s*:/m.test((css.match(/\.tiptap \.tableWrapper\s*\{[^}]*\}/s) || [''])[0]),
        'collapse drops sticky cell borders on scroll; the legacy iOS flag fights sticky');
    check('the stacked layout is styled via :has() on the cell marker',
        /table:has\(td\.dumbpad-stacked-cell\)\s*\{[^}]*display:\s*block/s.test(css)
        && /td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/s.test(css),
        'missing the :has() stacked rules / data-label rules');
    check('the stacked layout hides the header row (Tiptap has no <thead>)',
        /table:has\(td\.dumbpad-stacked-cell\) tr:first-child\s*\{\s*display:\s*none/s.test(css),
        'the header row would render as a bogus card');
}

/** 2. 纯函数：viewBox 解析。 */
function checkViewBoxParsing(mod, makeSvg) {
    check('viewBox: a normal box parses',
        JSON.stringify(mod.readViewBoxSize(makeSvg('0 0 107.6875 174'))) === '{"width":107.6875,"height":174}');
    check('viewBox: commas are accepted', mod.readViewBoxSize(makeSvg('-50,-10,905,679'))?.width === 905);
    check('viewBox: a missing attribute is null', mod.readViewBoxSize(makeSvg(null)) === null);
    check('viewBox: a zero-sized box is rejected', mod.readViewBoxSize(makeSvg('0 0 0 100')) === null);
    check('viewBox: garbage is rejected', mod.readViewBoxSize(makeSvg('nonsense')) === null);
}

/** 3. 表格折卡：Decoration 真的落到 DOM 上。 */
function checkTableStack(wrapper, container, mod) {
    const editor = wrapper.editor;
    wrapper.setValue('| 字段 | 类型 | 备注 |\n| --- | --- | --- |\n| id | string | 主键 |\n| title | string | 标题 |', false);

    let tablePos = null;
    editor.state.doc.descendants((node, pos) => {
        if (tablePos === null && node.type.name === 'table') tablePos = pos;
        return true;
    });
    check('table stack: the fixture really has a table', tablePos !== null);

    const tableEl = container.querySelector('.tiptap table');
    check('table stack: a table renders as a real <table>', Boolean(tableEl));
    check('table stack: nothing is stacked before the plugin says so',
        !tableEl.querySelector('.dumbpad-stacked-cell'));

    editor.view.dispatch(editor.state.tr.setMeta(mod.tableStackKey, new Set([tablePos])));
    check('table stack: body cells carry the stacking marker',
        tableEl.rows[1].cells[0].classList.contains('dumbpad-stacked-cell'),
        tableEl.rows[1].cells[0].className);

    const headerRow = tableEl.rows[0];
    const bodyRow = tableEl.rows[1];
    check('table stack: the header row is left unlabelled',
        !headerRow.cells[0].getAttribute('data-label'));
    check('table stack: body cells carry the column label from the header row',
        bodyRow.cells[1].getAttribute('data-label') === '类型'
        && bodyRow.cells[2].getAttribute('data-label') === '备注',
        Array.from(bodyRow.cells).map((c) => c.getAttribute('data-label')));

    editor.view.dispatch(editor.state.tr.setMeta(mod.tableStackKey, new Set()));
    check('table stack: clearing the set removes the decoration',
        !bodyRow.cells[0].classList.contains('dumbpad-stacked-cell')
        && !bodyRow.cells[1].getAttribute('data-label'));
}

/** 4. 图表灯箱：画布尺寸 + 缩放工具条的显隐。 */
function checkLightbox(mod, container) {
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
    const viewport = lightbox.querySelector('.article-image-lightbox-svg');
    const canvas = lightbox.querySelector('.article-image-lightbox-canvas');
    const mounted = canvas.querySelector('svg');
    const zoomBar = lightbox.querySelector('.article-image-lightbox-zoom');

    check('lightbox: the diagram is mounted as a live svg node', Boolean(mounted));
    check('lightbox: the canvas is sized from the viewBox', canvas.style.width === '100px'
        && canvas.style.height === '50px', { w: canvas.style.width, h: canvas.style.height });
    check('lightbox: the svg keeps its viewBox size (transform does the scaling)',
        mounted?.getAttribute('width') === '100' && mounted?.getAttribute('height') === '50',
        { width: mounted?.getAttribute('width'), height: mounted?.getAttribute('height') });
    check('lightbox: mermaid inline max-width is stripped', !mounted?.getAttribute('style'));
    check('lightbox: the zoom toolbar is shown for diagrams', zoomBar.hidden === false);
    check('lightbox: the viewport is the clipped stage', viewport.hidden === false);
    check('lightbox: the source svg is untouched', svg.getAttribute('width') === '100%');
    check('lightbox: the download is named .svg',
        lightbox.querySelector('.article-image-lightbox-download').getAttribute('download') === 'mermaid.svg');

    mod.openArticleLightbox({ name: '截图.png', src: '/api/assets/aaaaaaaaaaaaaaaaaaaaaaaa/preview' });
    check('lightbox: switching to an image hides the zoom toolbar', zoomBar.hidden === true);
    check('lightbox: switching to an image clears the canvas', canvas.querySelector('svg') === null);
    check('lightbox: the image slot is restored',
        lightbox.querySelector('.article-image-lightbox-image').hidden === false);

    lightbox.querySelector('.article-image-lightbox-close').click();
    check('lightbox: close resets everything',
        lightbox.hidden === true
        && !document.body.classList.contains('article-image-lightbox-open')
        && canvas.querySelector('svg') === null);
    check('lightbox: the editor survived the round trip', Boolean(container.querySelector('.tiptap')));
}

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
    if (!dom.window.cancelAnimationFrame) dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
    global.requestAnimationFrame = dom.window.requestAnimationFrame;
    global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
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
    return { wrapper, container };
}

async function main() {
    checkSourceContracts();
    const { wrapper, container } = await bootEditor();
    const imageMod = await import(pathToFileURL(
        path.join(ROOT, 'public/managers/tiptap-image-interactions.js')).href);
    const stackMod = await import(pathToFileURL(
        path.join(ROOT, 'public/managers/tiptap-table-stack.js')).href);

    const makeSvg = (viewBox) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        if (viewBox !== null) el.setAttribute('viewBox', viewBox);
        return el;
    };

    checkViewBoxParsing(imageMod, makeSvg);
    checkTableStack(wrapper, container, stackMod);
    checkLightbox(imageMod, container);

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log('\nMobile rendering checks passed');
}

main().catch((error) => {
    console.error('FAILED', error);
    process.exitCode = 1;
});
