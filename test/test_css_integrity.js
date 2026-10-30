/**
 * 样式完整性守卫。两次真实事故都在这条线上：
 * 1) 一次行编辑把 editorProps 的 `attributes: { class: 'tiptap ProseMirror vditor-reset' }`
 *    删掉了——内容区 100+ 条规则全挂在 `.vditor-reset` 上，类没了就是整片裸渲染；
 * 2) 一次行编辑把 styles.css 某条规则的收尾 `}` 吃掉了——CSS 解析器会把未闭合规则一路
 *    吞到下一个 `}`，于是它之后的所有规则同时失效。
 * 两种崩坏在 console 里都没有任何 JS 报错，看日志查不出来，所以这里用两条便宜的断言钉住：
 * 每个样式文件的 `{`/`}` 必须配平，编辑器内容根必须真的带上那三个类。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'Assets');

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) console.log(`PASS ${name}`);
    else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
};

/** 先剥掉注释与字符串再数括号：写在 content 或 url() 里的花括号不该算进结构。 */
const stripCssNoise = (css) => css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(["'])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');

function checkCssBalance() {
    const files = fs.readdirSync(ASSETS).filter(name => name.endsWith('.css')).sort();
    check('every stylesheet is found', files.length >= 6, files);
    for (const name of files) {
        const css = stripCssNoise(fs.readFileSync(path.join(ASSETS, name), 'utf8'));
        const open = (css.match(/\{/g) || []).length;
        const close = (css.match(/\}/g) || []).length;
        check(`${name}: braces balanced (${open}/${close})`, open === close, { open, close });
    }
}

function checkBlockquoteRules() {
    const styles = fs.readFileSync(path.join(ASSETS, 'styles.css'), 'utf8');
    const ios = fs.readFileSync(path.join(ASSETS, 'ios-theme.css'), 'utf8');
    const shell = /\.typora-editor-shell \.vditor-reset blockquote \{([^}]*)\}/;
    const block = shell.exec(styles);
    check('the editor blockquote rule exists in styles.css', Boolean(block), block && block[1]);
    if (block) {
        check('blockquote drops the italic fallback', /font-style:\s*normal/.test(block[1]), block[1]);
        check('blockquote drops the border (the bar is a ::before)', /border-left:\s*0/.test(block[1]), block[1]);
        check('blockquote leaves room for the bar', /padding-left:\s*\d+px/.test(block[1]), block[1]);
    }
    check('the quote bar is painted by ::before',
        /\.typora-editor-shell \.vditor-reset blockquote::before\s*\{[^}]*width:\s*3px[^}]*border-radius/s.test(styles),
        'missing a rounded 3px ::before bar');
    const lastChild = /\.typora-editor-shell \.vditor-reset blockquote > :last-child\s*\{([^}]*)\}/;
    check('no trailing paragraph margin inside a quote', lastChild.test(styles), styles.slice(
        Math.max(0, styles.search(lastChild) - 40), styles.search(lastChild) + 120));
    check('the desktop override keeps that margin at zero',
        /blockquote > :last-child\s*\{\s*margin-bottom:\s*0/.test(ios), 'ios-theme.css lost the :last-child rule');
}

function checkInstantDraftsWritingAreaRules() {
    const instantDraftsCss = fs.readFileSync(path.join(ASSETS, 'today-drafts.css'), 'utf8');
    check('today drafts writing area has background-attachment: local on overflowing state for synchronous scrolling',
        /\.today-drafts-writing-area\.is-overflowing\s*\{[^}]*background-attachment:\s*local/s.test(instantDraftsCss),
        'missing background-attachment: local on .today-drafts-writing-area.is-overflowing');
    check('today drafts flip layers explicitly force background-attachment: scroll to protect GPU rasterizer',
        /\.today-drafts-flip-layer\s+\.today-drafts-writing-area\s*\{[^}]*background-attachment:\s*scroll\s*!important/s.test(instantDraftsCss),
        'missing background-attachment: scroll !important on .today-drafts-flip-layer .today-drafts-writing-area');
    check('today drafts flip keeps the writing-area paper texture',
        !/\.today-drafts-pager\.is-flipping\s+\.today-drafts-flip-layer\s+\.today-drafts-writing-area\s*\{[^}]*background-image:\s*none/s.test(instantDraftsCss),
        'flip layers must retain the writing-area paper texture');
    check('today drafts lightweight flap retains ruled paper texture',
        /\.today-drafts-flip-layer\.is-lite\s*\{[^}]*background-image:[^}]*repeating-linear-gradient/s.test(instantDraftsCss),
        'missing ruled paper texture on lightweight flip flap');
    check('today drafts flip layer does not declare will-change on clip-path to prevent compositor memory spikes',
        !/\.today-drafts-flip-layer[^}]*will-change:[^}]*clip-path/s.test(instantDraftsCss),
        'found prohibited will-change: clip-path on flip layer');
    check('today drafts flip layer hides properly when hidden attribute is present',
        /\.today-drafts-flip-layer\[hidden\]\s*\{[^}]*display:\s*none/s.test(instantDraftsCss),
        'missing display: none on .today-drafts-flip-layer[hidden]');
}

async function checkEditorContentClasses() {
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

    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const container = document.createElement('div');
    container.className = 'typora-editor-shell';
    document.body.appendChild(container);
    const wrapper = new HybridMarkdownEditor(container, {});
    await wrapper.whenReady();
    wrapper.setValue('> 甲\n\n```mermaid\ngraph TD;\nA-->B;\n```', false);
    const classes = wrapper.editor.view.dom.className.split(/\s+/);
    check('the ProseMirror content root carries the theme classes',
        ['tiptap', 'ProseMirror', 'vditor-reset'].every(name => classes.includes(name)), classes);
    check('the content root really renders a blockquote',
        Boolean(container.querySelector('.vditor-reset blockquote')), container.innerHTML.slice(0, 400));
}

/**
 * 悬停底色的「圆角贴合」守卫。事故形态：按钮铺满圆角容器、自己却是 border-radius:0，
 * hover 时底色是直角矩形，被外框圆角切掉四个角（实测 .mark-popover 的按钮四周只差
 * 0.67px 的边框）。规则是：容器有圆角 => 铺满内沿的按钮必须自带圆角；并且 JS 不许
 * 给这些动作条写行内 padding/border（行内样式会压掉样式表里的内缩）。
 */
function checkHoverRadiusFit() {
    const styles = fs.readFileSync(path.join(ASSETS, 'styles.css'), 'utf8');
    const blocks = [];
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = rulePattern.exec(styles)) !== null) {
        blocks.push({ selectors: match[1].replace(/\s+/g, ' ').trim(), body: match[2] });
    }
    // 取「基础规则」：选择器恰好是该片段、且没有伪类/后代限定（否则会抓到后面的
    // :hover / ::before 变体——它们没有 border-radius，断言就永远为真）。
    // 允许一个 :not(...) 作用域限定：图标条用 :not(.time-marker-menu) 把时间标记菜单
    // 排除出去（两者共用 .selection-menu 基类），这种限定不影响本条断言的语义。
    const normalizeSelector = (selector) => selector
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/:not\([^)]*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // 按「顶层逗号」拆分选择器列表：:not(a, b) 里的逗号不是列表分隔符。
    const splitSelectors = (list) => {
        const parts = [];
        let depth = 0;
        let current = '';
        for (const char of list) {
            if (char === '(') depth += 1;
            if (char === ')') depth = Math.max(0, depth - 1);
            if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
            current += char;
        }
        parts.push(current);
        return parts;
    };
    const blockFor = (fragment) => blocks
        .filter(block => splitSelectors(block.selectors)
            .some(selector => normalizeSelector(selector) === fragment))
        .pop();
    const radiusOf = (block) => {
        const radius = /border-radius:\s*([^;]+);/.exec(block.body);
        return radius ? radius[1].trim() : '';
    };
    const pairs = [
        ['.mark-popover-actions', '.mark-popover-actions button'],
        ['.article-file-menu', '.article-file-menu .article-file-download'],
        ['.article-image-size-menu', '.article-image-size-menu button'],
        ['.time-marker-menu', '.time-marker-menu button'],
        ['.selection-menu.typora-selection-menu', '.selection-menu.typora-selection-menu button'],
    ];
    for (const [containerSel, buttonSel] of pairs) {
        const containerBlock = blockFor(containerSel);
        const buttonBlock = blockFor(buttonSel);
        check(`hover fit: ${containerSel} and its button both have a rule`,
            Boolean(containerBlock) && Boolean(buttonBlock), { containerSel, buttonSel });
        if (!containerBlock || !buttonBlock) continue;
        const containerRadius = radiusOf(containerBlock);
        const buttonRadius = radiusOf(buttonBlock);
        check(`hover fit: ${buttonSel} is not a square inside a rounded ${containerSel}`,
            !/^\d/.test(containerRadius) || !/^0(px)?$/.test(buttonRadius),
            { containerRadius, buttonRadius });
    }
    // JS 不许给动作条写行内内边距（上一版就是 'border:none;margin:0;padding:0;' 压掉了 CSS）
    const menuJs = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'tiptap-selection-menu.js'), 'utf8');
    check('hover fit: the selection menu does not inline-style its action bar',
        !/mark-popover-actions'[\s\S]{0,160}cssText/.test(menuJs), 'found a cssText assignment near mark-popover-actions');
}

async function main() {
    checkCssBalance();
    checkBlockquoteRules();
    checkInstantDraftsWritingAreaRules();
    checkHoverRadiusFit();
    await checkEditorContentClasses();
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log('\nAll CSS integrity checks passed.');
}

main().catch((error) => {
    console.error('FAILED', error);
    process.exitCode = 1;
});
