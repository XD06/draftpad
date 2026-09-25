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

async function main() {
    checkCssBalance();
    checkBlockquoteRules();
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
