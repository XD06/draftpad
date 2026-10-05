/**
 * 文章目录跳转的落点闪光必须以 PM Decoration（JumpTargetHighlight）渲染，而不是
 * 旧实现的 DOM 类名（is-jump-target）：编辑模式下直接写进 PM 管辖 DOM 的类名会被
 * DOMObserver 在重绘时抹掉（真机实测从未露面），Decoration 在编辑/阅读两种模式
 * 下都能存活。同时钉住目录跳转链路的边界：编辑模式点目录只做定位 + 闪光，不再
 * 把标题文字当关键词送进 jumpToKeyword 搜索命中管线（那会把搜索式黄色高亮落在
 * 该词在全文第一次出现的位置，常常不是被点击的标题）；flash 默认关闭（搜索跳转
 * 的 landHit 路径不受影响）；docChanged 后装饰经 mapping 跟随；2.2s 后摘除。
 * 目录侧的折叠上限、表格加粗降噪、移动端页面滚动监听与远端写入后重建目录是
 * 源码断言（collectTocSectionEntries/updateToC 是 app.js 闭包私有，jsdom 不可达）。
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
global.CustomEvent = dom.window.CustomEvent;
global.getSelection = dom.window.getSelection.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = () => {};
}
// scrollRenderedElementIntoView 在无布局的 jsdom 里手算偏移后调 scrollTo。
if (!dom.window.Element.prototype.scrollTo) {
    dom.window.Element.prototype.scrollTo = () => {};
}
if (!dom.window.Element.prototype.createShadowRoot) {
    // noop guard for future bundle changes
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

const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const { PM } = globalThis.DumbPadTiptap;
    const TextSelection = PM.state.TextSelection;

    const makeEditor = async (markdown) => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const wrapper = new HybridMarkdownEditor(container, {});
        await wrapper.whenReady();
        if (markdown !== undefined) wrapper.setValue(markdown, false);
        const view = wrapper.editor.view;
        return { wrapper, view, container };
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /* 1. flash: true → 目标标题以 Decoration 拿到 article-jump-target 类（编辑模式存活） */
    {
        const { wrapper, view } = await makeEditor('# 标题甲\n\n段落文字乙');
        const heading = view.dom.querySelector('h1');
        wrapper.scrollRenderedElementIntoView(heading, { flash: true });
        check('jump flash: heading gets article-jump-target decoration',
            heading.classList.contains('article-jump-target'), heading.className);
    }

    /* 2. flash 默认关闭：搜索跳转的 landHit → scrollRenderedElementIntoView 路径不再叠加闪光 */
    {
        const { wrapper, view } = await makeEditor('# 标题甲\n\n段落文字乙');
        const paragraph = view.dom.querySelector('p');
        wrapper.scrollRenderedElementIntoView(paragraph);
        check('jump flash: default is off (search path unchanged)',
            !paragraph.classList.contains('article-jump-target'), paragraph.className);
    }

    /* 3. 闪光 2.2s 后摘除（clear meta） */
    {
        const { wrapper, view } = await makeEditor('# 标题甲\n\n段落文字乙');
        const heading = view.dom.querySelector('h1');
        wrapper.scrollRenderedElementIntoView(heading, { flash: true });
        check('jump flash: visible right after the jump',
            heading.classList.contains('article-jump-target'));
        await sleep(2500);
        check('jump flash: cleared after ~2.2s',
            !heading.classList.contains('article-jump-target'), heading.className);
    }

    /* 4. docChanged：闪光范围内的内容被编辑后装饰经 mapping 跟随，不丢 */
    {
        const { wrapper, view } = await makeEditor('# 标题甲\n\n段落文字乙');
        const paragraph = view.dom.querySelector('p');
        wrapper.scrollRenderedElementIntoView(paragraph, { flash: true });
        check('jump flash: paragraph decorated before edit',
            paragraph.classList.contains('article-jump-target'));
        const { state } = view;
        view.dispatch(state.tr.insertText('插入', state.selection.from));
        check('jump flash: decoration survives a docChanged transaction',
            paragraph.classList.contains('article-jump-target'), paragraph.className);
    }

    /* 5. 片段目标（加粗 span）闪光落在所在块（段落） */
    {
        const { wrapper, view } = await makeEditor('# 标题甲\n\n带 **加粗文字** 的段落');
        const strong = view.dom.querySelector('strong');
        wrapper.scrollRenderedElementIntoView(strong, { flash: true });
        const host = strong.closest('p');
        check('jump flash: inline fragment flashes its containing paragraph',
            Boolean(host) && host.classList.contains('article-jump-target'),
            { strong: Boolean(strong), hostClass: host ? host.className : null });
    }

    /* 6. 列表项里的片段闪光整个条目（与搜索块级高亮同一粒度） */
    {
        const { wrapper, view } = await makeEditor('# 标题甲\n\n- 项目 **加粗文字** 文本');
        const strong = view.dom.querySelector('strong');
        wrapper.scrollRenderedElementIntoView(strong, { flash: true });
        const li = strong.closest('li');
        check('jump flash: fragment inside a list item flashes the whole item',
            Boolean(li) && li.classList.contains('article-jump-target'),
            { li: Boolean(li), liClass: li ? li.className : null });
    }

    /* 7. 闪光期间继续跳转：旧定时器被清掉，只有最后一次闪光存活（无幽灵残留路径） */
    {
        const { wrapper, view } = await makeEditor('# 标题甲\n\n段落文字乙');
        const heading = view.dom.querySelector('h1');
        const paragraph = view.dom.querySelector('p');
        wrapper.scrollRenderedElementIntoView(heading, { flash: true });
        wrapper.scrollRenderedElementIntoView(paragraph, { flash: true });
        check('jump flash: re-jump moves the decoration to the new target',
            !heading.classList.contains('article-jump-target')
            && paragraph.classList.contains('article-jump-target'),
            { h1: heading.className, p: paragraph.className });
    }

    /* 8. 源码契约：编辑模式目录跳转不再进搜索命中管线 */
    {
        const app = readSource('public/app.js');
        const editor = readSource('public/tiptap-editor.js');
        const extensions = readSource('public/managers/tiptap-extensions.js');
        check('toc jump: focusEditorHeading no longer feeds heading text into scrollToLine/jumpToKeyword',
            !app.includes('scrollToLine(lineIndex, heading?.textContent')
            && !app.includes("editorInstance.scrollToLine(lineIndex, heading"),
            null);
        check('toc jump: edit-mode click goes through scrollToHeadingId with flash',
            app.includes('editorInstance.scrollToHeadingId(headingId || \'\', { flash: true })'),
            null);
        check('toc jump: reading-mode click also flashes the landing block',
            app.includes('editorInstance.scrollToHeadingId(headingId, { flash: true })'),
            null);
        check('toc jump: adapter no longer writes is-jump-target into PM-managed DOM',
            !editor.includes("target.classList.add('is-jump-target')"),
            null);
        check('toc jump: JumpTargetHighlight extension is registered in the adapter',
            editor.includes('JumpTargetHighlight') && extensions.includes('export const JumpTargetHighlight'),
            null);
    }

    /* 9. 源码契约：目录降噪与跟随修复 */
    {
        const app = readSource('public/app.js');
        check('toc noise: per-section mark cap with collapse/expand entries',
            app.includes('TOC_MARKS_PER_SECTION')
            && app.includes('data-mark-group')
            && app.includes('data-mark-collapse'),
            null);
        check('toc lists: top-level list entries ride the same sub-entry pipeline with their own cap',
            app.includes('TOC_LISTS_PER_SECTION')
            && app.includes('collectTocSectionEntries(toc)')
            && app.includes('list-entry')
            && readSource('public/managers/heading-index.js').includes("kind: 'list'"),
            null);
        check('toc noise: bold fragments never enter the TOC (mark selector excludes strong)',
            readSource('public/managers/heading-index.js').includes("const TOC_MARK_SELECTOR = 'mark, .md-mark, u, [data-draw], .has-annotation, [data-note]'")
            && !app.includes("type: 'bold'"),
            null);
        check('toc follow: collapse entries do not take part in scroll tracking',
            app.includes("item.dataset.markGroup !== undefined || item.dataset.markCollapse !== undefined"),
            null);
        check('toc follow: window scroll listener covers page-scroll layout (mobile)',
            app.includes("window.addEventListener('scroll', schedule"),
            null);
        check('toc follow: remote content write rebuilds the TOC (fragment race)',
            /replaySearchJumpAfterContentWrite\(\);\s*\n\s*\/\/[\s\S]*?\*\/\s*\n\s*debouncedUpdateToC\(\);/.test(app)
            || (app.includes('replaySearchJumpAfterContentWrite();') && app.includes('debouncedUpdateToC();')),
            null);
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll TOC jump highlight checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
