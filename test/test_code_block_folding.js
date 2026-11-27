/**
 * 主编辑器阅读模式长代码块折叠行为回归测试：
 * - countCodeBlockLines / LONG_CODE_LINE_THRESHOLD 阈值与边界；
 * - 编辑态永不折叠任何长度代码块；
 * - 切入阅读态仅 >= 18 行的普通代码（非 mermaid / frontmatter）自动收起，
 *   页眉与底部按钮可双向展开/收起，切回编辑态立即恢复全量展示。
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
global.Event = dom.window.Event;
global.CustomEvent = dom.window.CustomEvent;
global.InputEvent = dom.window.InputEvent;
global.getSelection = dom.window.getSelection.bind(dom.window);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = () => {};
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

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const {
        LONG_CODE_LINE_THRESHOLD,
        countCodeBlockLines,
    } = await import(pathToFileURL(path.join(ROOT, 'public/managers/tiptap-code-block-view.js')).href);

    /* 1. 阈值与行数统计边界 */
    check('阈值固定为 18 行', LONG_CODE_LINE_THRESHOLD === 18, LONG_CODE_LINE_THRESHOLD);
    check('空串计 0 行', countCodeBlockLines('') === 0);
    check('单行无尾换行计 1 行', countCodeBlockLines('const a = 1;') === 1);
    check('尾随单个换行不虚增行数', countCodeBlockLines('a\nb\n') === 2, countCodeBlockLines('a\nb\n'));
    check('CRLF 按逻辑换行计算', countCodeBlockLines('a\r\nb\r\nc\r\n') === 3, countCodeBlockLines('a\r\nb\r\nc\r\n'));

    const longLines = Array.from({ length: 22 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
    const exactThresholdLines = Array.from({ length: 18 }, (_, i) => `let k${i} = ${i};`).join('\n');
    const belowThresholdLines = Array.from({ length: 17 }, (_, i) => `let m${i} = ${i};`).join('\n');
    const shortLines = Array.from({ length: 6 }, (_, i) => `console.log(${i});`).join('\n');
    const longMermaid = ['flowchart TD', ...Array.from({ length: 20 }, (_, i) => `    A${i} --> B${i}`)].join('\n');
    const longFrontmatter = Array.from({ length: 20 }, (_, i) => `key_${i}: value_${i}`).join('\n');

    const md = [
        '# 长代码块阅读折叠测试',
        '',
        '```javascript',
        longLines,
        '```',
        '',
        '```javascript',
        exactThresholdLines,
        '```',
        '',
        '```javascript',
        belowThresholdLines,
        '```',
        '',
        '```javascript',
        shortLines,
        '```',
        '',
        '```mermaid',
        longMermaid,
        '```',
        '',
        '```frontmatter',
        longFrontmatter,
        '```',
    ].join('\n');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    try {
        await editor.whenReady();
        editor.setValue(md, false);

        const blocks = Array.from(container.querySelectorAll('.vditor-wysiwyg__block[data-type="code-block"]'));
        check('文档渲染全部 6 个代码块', blocks.length === 6, blocks.length);

        const [b22, b18, b17, b6, bMermaid, bFm] = blocks;

        /* 2. 编辑模式：任何代码块都不得折叠 */
        check(
            '编辑模式下所有代码块均无 is-code-collapsible / is-code-collapsed',
            blocks.every((el) => !el.classList.contains('is-code-collapsible') && !el.classList.contains('is-code-collapsed'))
        );
        check(
            '编辑模式下页眉折叠按钮与底部栏均隐藏',
            blocks.every((el) => {
                const foldBtn = el.querySelector('.dumbpad-code-fold-btn');
                const footer = el.querySelector('.dumbpad-code-fold-footer');
                return foldBtn?.hidden === true && footer?.hidden === true;
            })
        );

        /* 3. 切换至阅读模式：仅 >= 18 行普通代码块默认收起 */
        editor.setReadingMode(true);
        check('容器开启 is-reading-mode 类', container.classList.contains('is-reading-mode'));
        check(
            '22 行 JS 块在阅读模式下默认进入折叠状态',
            b22.classList.contains('is-code-collapsible') && b22.classList.contains('is-code-collapsed')
        );
        check(
            '恰好 18 行 JS 块在阅读模式下达到阈值并默认折叠',
            b18.classList.contains('is-code-collapsible') && b18.classList.contains('is-code-collapsed')
        );
        check(
            '17 行与 6 行 JS 块不折叠',
            !b17.classList.contains('is-code-collapsible')
                && !b17.classList.contains('is-code-collapsed')
                && !b6.classList.contains('is-code-collapsible')
                && !b6.classList.contains('is-code-collapsed')
        );
        check(
            '21 行 mermaid 与 20 行 frontmatter 不参与代码折叠',
            !bMermaid.classList.contains('is-code-collapsible') && !bFm.classList.contains('is-code-collapsible')
        );

        const foldBtn22 = b22.querySelector('.dumbpad-code-fold-btn');
        const footer22 = b22.querySelector('.dumbpad-code-fold-footer');
        check(
            '22 行代码块阅读态显示页眉图标与底部折叠胶囊，底部文案包含行数',
            foldBtn22?.hidden === false
                && Boolean(foldBtn22.querySelector('svg'))
                && foldBtn22.getAttribute('aria-expanded') === 'false'
                && (foldBtn22.getAttribute('aria-label') || '').includes('22')
                && footer22?.hidden === false
                && footer22.getAttribute('aria-expanded') === 'false'
                && footer22.textContent.includes('展开代码 · 22 行')
        );

        /* 4. 交互：点击底部栏展开，再点击页眉按钮收起 */
        footer22.click();
        check(
            '点击底部折叠栏后展开代码并切换底部与页眉无障碍状态为“收起”',
            !b22.classList.contains('is-code-collapsed')
                && foldBtn22.getAttribute('aria-expanded') === 'true'
                && foldBtn22.getAttribute('aria-label') === '收起代码'
                && footer22.hidden === false
                && footer22.getAttribute('aria-expanded') === 'true'
                && footer22.textContent.includes('收起代码')
        );

        foldBtn22.click();
        check(
            '再次点击页眉“收起”图标后重新折叠代码并恢复“展开代码 · 22 行”',
            b22.classList.contains('is-code-collapsed')
                && foldBtn22.getAttribute('aria-expanded') === 'false'
                && footer22.hidden === false
                && footer22.getAttribute('aria-expanded') === 'false'
                && footer22.textContent.includes('展开代码 · 22 行')
        );

        /* 5. 切回编辑模式：立刻全量解除折叠并隐藏折叠 UI */
        editor.setReadingMode(false);
        check('退出阅读模式后移除 is-reading-mode', !container.classList.contains('is-reading-mode'));
        check(
            '退出阅读模式后 22 行与 18 行块均立即解除折叠并隐藏按钮',
            !b22.classList.contains('is-code-collapsible')
                && !b22.classList.contains('is-code-collapsed')
                && !b18.classList.contains('is-code-collapsible')
                && foldBtn22.hidden === true
                && footer22.hidden === true
        );
    } finally {
        editor.destroy?.();
        container.remove();
        dom.window.close();
    }

    if (failures > 0) {
        console.error(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll code-block folding tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
