/**
 * 单标题居中块级属性（DumbPadHeading / HeadingAlignControl / `/center` / 目录与标题剥离）
 * 与表格整体操控扩展（DumbPadTableControls：整表选中、复制 Markdown、行列增删、删表）的 jsdom 回归。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.DocumentFragment = dom.window.DocumentFragment;
global.MutationObserver = dom.window.MutationObserver;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Range = dom.window.Range;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.getComputedStyle = dom.window.getComputedStyle;
global.getSelection = dom.window.getSelection.bind(dom.window);
Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
});
Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async (text) => { global.__copiedText = text; } },
    configurable: true,
});
if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = () => {};
}
if (!dom.window.Range.prototype.getClientRects) {
    dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
}
if (!dom.window.Range.prototype.getBoundingClientRect) {
    dom.window.Range.prototype.getBoundingClientRect = () => ({
        top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    });
}
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: true, addListener() {}, removeListener() {} }));

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'tiptap', 'tiptap.bundle.js'), 'utf8'));

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
}

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const { buildMarkdownHeadingIndex } = await import('../public/managers/heading-index.js');
    const { deriveArticleTitle } = await import('../public/managers/article-title.js');
    const { selectionMenuPluginKey } = await import('../public/managers/tiptap-selection-menu.js');
    const { slashCommandRegistry } = await import('../public/managers/tiptap-slash-menu.js');
    const {
        findTableContextAt,
        serializeTableNodeToMarkdown,
        tableControlsPluginKey,
    } = await import('../public/managers/tiptap-table-controls.js');
    const { sanitizeHtml } = require('../routes/share-routes');
    const { marked } = require('marked');

    const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const view = editor.editor.view;

    const placeCaretInNode = (predicate) => {
        let targetPos = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (targetPos !== null) return false;
            if (predicate(node, pos)) {
                targetPos = pos + 1;
                return false;
            }
            return true;
        });
        if (targetPos === null) throw new Error('Target node not found');
        view.dispatch(editor.editor.state.tr.setSelection(TextSelection.near(editor.editor.state.doc.resolve(targetPos))));
    };

    // 1. 单标题居中：解析、独立节点控制、行内富文本往返、Undo、阅读态隐藏浮标
    const centeredMd = '# <center>**核心** ==重点== [文档](https://example.com)</center>\n\n## 普通章节\n';
    editor.setValue(centeredMd, false);
    const h1 = container.querySelector('.tiptap > h1');
    const h2 = container.querySelector('.tiptap > h2');
    check('centered heading parses to data-align="center" without inner <center> tag',
        h1?.getAttribute('data-align') === 'center' && !h1.querySelector('center'));
    check('uncentered sibling heading stays unaligned', h2?.getAttribute('data-align') === null);
    check('centered heading retains bold, highlight, and link marks',
        Boolean(h1?.querySelector('strong') && h1?.querySelector('mark.md-mark') && h1?.querySelector('a[href]')));

    const serialized = editor.getValue();
    check('centered heading roundtrips identically', serialized.startsWith('# <center>**核心** <mark>重点</mark> [文档](https://example.com)</center>'), { serialized });
    editor.setValue(serialized, false);
    check('centered heading second roundtrip preserves markdown', editor.getValue() === serialized);

    // 单独切第二个标题居中，不影响第一个；Ctrl+Z 撤销恢复左对齐
    placeCaretInNode((n) => n.type.name === 'heading' && n.attrs.level === 2);
    editor.editor.commands.toggleHeadingCenter();
    check('toggleHeadingCenter centers only target H2 as a whole block',
        container.querySelector('.tiptap > h2')?.getAttribute('data-align') === 'center'
        && editor.getValue().includes('## <center>普通章节</center>'));
    editor.editor.commands.undo();
    check('undo reverts heading centering cleanly',
        container.querySelector('.tiptap > h2')?.getAttribute('data-align') === null
        && editor.getValue().includes('## 普通章节'));

    // 标题上下文 `/` `/center` 命令可用，且不污染段落的 16 项命令集
    check('paragraph slashCommandRegistry remains 16 items cleanly', slashCommandRegistry.length === 16);
    placeCaretInNode((n) => n.type.name === 'heading' && n.attrs.level === 2);
    view.dispatch(editor.editor.state.tr.insertText('/center'));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    check('typing /center + Enter inside heading toggles whole-block centering',
        container.querySelector('.tiptap > h2')?.getAttribute('data-align') === 'center'
        && !container.querySelector('.tiptap > h2')?.textContent?.includes('/center')
        && !editor.getValue().includes('/center<'),
        { value: editor.getValue(), h2Html: container.querySelector('.tiptap > h2')?.outerHTML });

    // 聚焦标题浮标按钮：阅读态隐藏、编辑态焦点进入标题显示并可点击切换
    const alignBtn = document.body.querySelector('.dumbpad-heading-align-btn');
    check('heading align button exists in DOM', Boolean(alignBtn));
    editor.setReadingMode(true);
    placeCaretInNode((n) => n.type.name === 'heading' && n.attrs.level === 2);
    check('heading align button hides in reading mode', alignBtn?.hidden === true);
    editor.setReadingMode(false);
    const hasFocusOrig = view.hasFocus.bind(view);
    view.hasFocus = () => true;
    placeCaretInNode((n) => n.type.name === 'heading' && n.attrs.level === 2);
    check('heading align button appears when focused inside heading', alignBtn?.hidden === false && alignBtn.classList.contains('is-active'));
    alignBtn?.click();
    check('clicking heading align button uncenters H2 cleanly',
        container.querySelector('.tiptap > h2')?.getAttribute('data-align') === null
        && alignBtn?.classList.contains('is-active') === false);
    view.hasFocus = hasFocusOrig;

    // 目录与自动标题提取均干净剥离 <center> 标签，分享页 sanitizer 保留 <center>
    const tocIndex = buildMarkdownHeadingIndex('# <center>主标题</center>\n\n## <center>**副标**</center>');
    check('heading-index strips <center> wrapper from TOC labels',
        tocIndex.toc[0]?.text === '主标题' && tocIndex.toc[1]?.text === '副标',
        tocIndex.toc);
    check('article-title derives clean title without <center> tag',
        deriveArticleTitle('# <center>笔记本手记</center>\n正文') === '笔记本手记');
    const shareSafeHtml = sanitizeHtml(marked.parse('# <center>分享居中标题</center>'));
    check('share sanitizeHtml preserves <center> inside headings', /<h1[^>]*>\s*<center>分享居中标题<\/center>\s*<\/h1>/i.test(shareSafeHtml), shareSafeHtml);

    // 2. 表格整体操控：Toolbar、整表选择 + 退格删除、行列增删、复制 Markdown、阅读态隐藏
    const tableMd = '前置段落\n\n| 列A | 列B |\n| --- | --- |\n| R1A | R1B |\n| R2A | R2B |\n\n后置段落';
    editor.setValue(tableMd, false);
    placeCaretInNode((n) => n.type.name === 'tableCell' || n.type.name === 'tableHeader');

    const toolbar = document.body.querySelector('.dumbpad-table-toolbar');
    check('table toolbar appears when caret enters table', Boolean(toolbar && !toolbar.hidden));
    const tableCtx = findTableContextAt(editor.editor.state);
    check('findTableContextAt reports 3x2 table dimensions', tableCtx?.rowCount === 3 && tableCtx?.colCount === 2, tableCtx);

    // +行 与 +列
    toolbar.querySelector('[data-table-action="addRowAfter"]')?.click();
    check('+行 adds a row', findTableContextAt(editor.editor.state)?.rowCount === 4);
    toolbar.querySelector('[data-table-action="addColumnAfter"]')?.click();
    check('+列 adds a column', findTableContextAt(editor.editor.state)?.colCount === 3);

    // 复制 Markdown
    global.__copiedText = '';
    toolbar.querySelector('[data-table-action="copyTable"]')?.click();
    const copiedMd = serializeTableNodeToMarkdown(editor.editor, findTableContextAt(editor.editor.state).pos);
    check('serializeTableNodeToMarkdown exports clean GFM table', copiedMd.includes('| 列A |') && copiedMd.includes('| R2A |') && copiedMd.split('\n').length >= 5, copiedMd);

    // 选中整表：全格 CellSelection + dumbpad-table-selected-cell + SelectionMenu 退让 + Backspace 整表删除
    toolbar.querySelector('[data-table-action="selectTable"]')?.click();
    const wholeState = tableControlsPluginKey.getState(editor.editor.state);
    check('selectTable highlights entire table via CellSelection + wholeTablePos',
        wholeState?.wholeTablePos !== null
        && '$anchorCell' in editor.editor.state.selection
        && container.querySelectorAll('.dumbpad-table-selected-cell').length === 12,
        { wholeState, selectedCells: container.querySelectorAll('.dumbpad-table-selected-cell').length });
    check('SelectionMenu hides when whole-table CellSelection is active',
        !document.body.querySelector('.tiptap-selection-menu')
        || document.body.querySelector('.tiptap-selection-menu').style.display === 'none');

    // 按 Backspace 整体删除表格
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    check('Backspace while wholeTableSelected deletes entire table node',
        !editor.getValue().includes('| 列A') && editor.getValue().includes('前置段落') && editor.getValue().includes('后置段落'),
        { value: editor.getValue() });

    // 删除按钮直接删除表格 & 1x1 表禁用 -行/-列 & 阅读态隐藏
    editor.setValue('| 单格 |\n| --- |', false);
    placeCaretInNode((n) => n.type.name === 'tableHeader');
    const delRowBtn = toolbar.querySelector('[data-table-action="deleteRow"]');
    const delColBtn = toolbar.querySelector('[data-table-action="deleteColumn"]');
    check('single-row/col table disables -行 and -列 buttons', delRowBtn?.disabled === true && delColBtn?.disabled === true);

    editor.setReadingMode(true);
    check('table toolbar hides in reading mode', toolbar.hidden === true);
    editor.setReadingMode(false);
    placeCaretInNode((n) => n.type.name === 'tableHeader');
    toolbar.querySelector('[data-table-action="deleteTable"]')?.click();
    check('deleteTable removes entire remaining table and resets toolbar',
        editor.getValue().trim() === '' && toolbar.hidden === true,
        { value: editor.getValue() });

    await new Promise(resolve => setTimeout(resolve, 25));
    editor.editor?.destroy?.();
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
