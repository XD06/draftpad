/**
 * 斜杠命令菜单黑盒测试（jsdom）：`/` 触发、过滤、键盘与点击执行、Escape 抑制、
 * 代码块/URL 中段不触发、软换行后的视觉行首触发。断言的是插件状态机与命令
 * 执行（文档与 markdown 形态）；真实定位与触屏链路由 test/browser/slash-menu.js
 * 在浏览器里覆盖。
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
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Range = dom.window.Range;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.getSelection = dom.window.getSelection.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
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
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) console.log(`PASS ${name}`);
    else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
};

const TIME_TOKEN_RE = /\[\[time:create:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\]/;

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const {
        slashMenuPluginKey,
        slashCommandRegistry,
        filterSlashCommands,
    } = await import('../public/managers/tiptap-slash-menu.js');

    const expectedIds = 'code,doing,file,frontmatter,h1,h2,h3,hr,mermaid,quote,table,time,todo';
    check('registry auto-registers all 13 built-in commands without /date',
        slashCommandRegistry.length === 13
        && slashCommandRegistry.map(entry => entry.id).sort().join(',') === expectedIds
        && !slashCommandRegistry.some(entry => entry.id === 'date'));
    check('filter ranks prefix match /time first for t', filterSlashCommands('t')[0]?.id === 'time');
    check('filter by prefix tim narrows to time', filterSlashCommands('tim').map(entry => entry.id).join(',') === 'time');
    check('filter ranks /file first for f', filterSlashCommands('f')[0]?.id === 'file');
    check('filter by keyword', filterSlashCommands('附件').map(entry => entry.id).join(',') === 'file');
    check('empty query lists everything', filterSlashCommands('').length === 13);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const view = editor.editor.view;
    const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;

    const menuEl = () => document.body.querySelector('.slash-command-menu');
    const itemEls = () => Array.from(document.body.querySelectorAll('.slash-command-item'));
    const menuVisible = () => Boolean(menuEl() && menuEl().style.display !== 'none');
    const state = () => slashMenuPluginKey.getState(editor.editor.state);
    const caretEnd = () => {
        const { doc } = editor.editor.state;
        // 最后一个块的内容末位：doc.content.size 是文档闭合位，-1 才落在段内。
        editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
            TextSelection.create(doc, doc.content.size - 1)));
    };
    const type = (text) => {
        editor.editor.view.dispatch(editor.editor.state.tr.insertText(text));
    };
    const press = (key) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        view.dom.dispatchEvent(event);
        return event.defaultPrevented;
    };

    // 1. 空段落里输入 /：菜单打开，全部 13 条命令都在
    editor.setValue('', false);
    caretEnd();
    type('/');
    check('typing / opens the menu', menuVisible());
    check('typing / lists all 13 commands', itemEls().length === 13,
        { count: itemEls().length });
    check('first item is selected by default', itemEls()[0]?.classList.contains('is-selected'));

    // 2. 继续输入过滤（t 优先 /time，tim 唯一命中 /time）
    type('t');
    check('query t puts /time first', itemEls()[0]?.querySelector('.slash-command-hint')?.textContent === '/time',
        { first: itemEls()[0]?.textContent });
    type('im');
    check('query tim filters to /time only', itemEls().length === 1
        && itemEls()[0].textContent.includes('插入时间标记'),
        { items: itemEls().map(el => el.textContent) });
    check('hint shows the command id', itemEls()[0].querySelector('.slash-command-hint')?.textContent === '/time');

    // 3. Enter 执行 /time：命令文本被替换为时间标记节点，markdown 与手打一致
    press('Enter');
    check('enter on /time closes the menu', !menuVisible());
    const valueAfterTime = editor.getValue();
    check('enter on /time replaces the query with a marker', TIME_TOKEN_RE.test(valueAfterTime),
        { value: valueAfterTime });
    check('query text is gone', !valueAfterTime.includes('/tim'));

    // 4. Escape 抑制同一形状；换字符立刻回来
    editor.setValue('', false);
    caretEnd();
    type('/');
    check('menu reopens on fresh /', menuVisible());
    press('Escape');
    check('escape hides the menu', !menuVisible());
    type('t');
    check('typing after escape reopens the menu', menuVisible());
    press('Escape');

    // 5. 无匹配时菜单隐藏，Enter 不被菜单吞掉（落到原有软换行语义）
    editor.setValue('', false);
    caretEnd();
    type('/zz');
    check('no-match query keeps the menu hidden', !menuVisible());
    press('Enter');
    const noMatchValue = editor.getValue();
    check('enter with no match falls through to legacy keys', noMatchValue.startsWith('/zz')
        && !TIME_TOKEN_RE.test(noMatchValue) && !noMatchValue.includes('/zz\n/zz'),
        { value: noMatchValue });

    // 6. /file：点击执行，命令文本删除并打开选择器（容器里出现隐藏 file input）
    editor.setValue('', false);
    caretEnd();
    type('/f');
    check('/f puts /file first ahead of /frontmatter',
        itemEls()[0]?.querySelector('.slash-command-hint')?.textContent === '/file',
        { items: itemEls().map(el => el.textContent) });
    type('i');
    check('/fi filters to /file', itemEls().length === 1
        && itemEls()[0].textContent.includes('插入文件或图片'),
        { items: itemEls().map(el => el.textContent) });
    itemEls()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('clicking /file removes the query text', !editor.getValue().includes('/fi'));
    check('clicking /file opens the hidden file picker', Boolean(container.querySelector('.article-file-command-input')));

    // 7. 代码块内不触发
    editor.setValue('```\n/\n```', false);
    let hasCodeBlock = false;
    editor.editor.state.doc.descendants((node) => {
        if (node.type.name === 'codeBlock') hasCodeBlock = true;
        return true;
    });
    check('sanity: code block parsed', hasCodeBlock);
    // 首个子块内容区是 [1, 2)：光标 2 = 块内文本末尾；3 已是 doc 层。
    editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
        TextSelection.create(editor.editor.state.doc, 2)));
    check('no menu inside a code block', !menuVisible());

    // 8. 行内代码中不触发
    editor.setValue('`/` 后文', false);
    const codeMarkPos = (() => {
        let pos = null;
        editor.editor.state.doc.descendants((node, nodePos) => {
            if (pos !== null) return false;
            if (node.isText && node.marks.some(mark => mark.type.name === 'code')) pos = nodePos;
            return true;
        });
        return pos;
    })();
    if (codeMarkPos !== null) {
        editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
            TextSelection.create(editor.editor.state.doc, codeMarkPos + 2)));
        check('no menu inside inline code', !menuVisible());
    } else {
        check('no menu inside inline code', true);
    }

    // 9. URL 中段不触发（/ 前是普通字符）
    editor.setValue('see https://', false);
    caretEnd();
    type('x');
    check('no menu mid-word after url scheme', !menuVisible());

    // 10. 软换行后的视觉行首触发（<br> 被读作 \n）
    editor.setValue('甲', false);
    caretEnd();
    editor.editor.commands.setHardBreak();
    type('/f');
    check('menu opens at a visual line start after soft break', menuVisible());
    press('Escape');

    // 11. 阅读模式不触发
    editor.setValue('', false);
    editor.setReadingMode(true);
    caretEnd();
    type('/');
    check('no menu in reading mode', !menuVisible());
    editor.setReadingMode(false);

    // 12. 选区非空不触发
    editor.setValue('hello', false);
    editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
        TextSelection.create(editor.editor.state.doc, 1, 4)));
    check('no menu with a non-empty selection', !menuVisible());

    // 13. /time 执行后的往返幂等（存储形态不因菜单而变化）
    editor.setValue('前文', false);
    caretEnd();
    type('/time');
    press('Enter');
    const roundtripValue = editor.getValue();
    editor.setValue(roundtripValue, false);
    check('menu-inserted marker roundtrips byte-identical', editor.getValue() === roundtripValue,
        { before: roundtripValue, after: editor.getValue() });

    // 14. 软换行后的 /code 必须仅拆出末尾块，不吞并前面同一段里的文字
    editor.setValue('前文', false);
    caretEnd();
    editor.editor.commands.setHardBreak();
    type('/code');
    press('Enter');
    const softCodeVal = editor.getValue();
    check('/code after soft break keeps preceding prose out of codeBlock',
        softCodeVal.includes('前文') && softCodeVal.includes('```') && !/```[^\n]*\n[^\n]*前文/.test(softCodeVal),
        { value: softCodeVal });

    // 15. 点击代码块右上语言徽标按钮可打开语言选择浮层并改语言，阅读模式自动禁用
    const badgeBtn = container.querySelector('button.dumbpad-code-language-badge');
    check('code block renders an interactive language badge button', Boolean(badgeBtn));
    if (badgeBtn) {
        badgeBtn.click();
        const langPopover = document.body.querySelector('.dumbpad-code-language-popover');
        const langInput = document.body.querySelector('.dumbpad-code-language-input');
        check('clicking badge opens code language popover', Boolean(langPopover && !langPopover.hidden && langInput));
        if (langInput) {
            langInput.value = 'py';
            langInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
            const optionTexts = Array.from(document.body.querySelectorAll('.dumbpad-code-language-option'))
                .map(el => el.dataset.languageId);
            check('popover filters suggestions for py', optionTexts.includes('python'), { optionTexts });
            langInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            check('pressing Enter in language popover updates codeBlock language to python',
                editor.getValue().includes('```python'),
                { value: editor.getValue() });
        }
        editor.setReadingMode(true);
        check('reading mode marks language badge readonly', badgeBtn.disabled === true && badgeBtn.classList.contains('is-readonly'));
        editor.setReadingMode(false);
        check('exiting reading mode restores interactive language badge', badgeBtn.disabled === false && !badgeBtn.classList.contains('is-readonly'));
    }

    // 16. 其余新增快捷斜杠命令执行与往返检验
    const expectCommandResult = (cmd, assertFn, label) => {
        editor.setValue('', false);
        caretEnd();
        type(`/${cmd}`);
        press('Enter');
        const value = editor.getValue();
        check(`${label} executes /${cmd}`, assertFn(value), { value });
    };
    expectCommandResult('mermaid',
        val => /^```mermaid\nflowchart LR\n    A\[开始\] --> B\[完成\]\n```/.test(val.trim()),
        '/mermaid keeps entire template inside code block');
    expectCommandResult('todo', val => val.includes('- [ ] '), '/todo');
    expectCommandResult('doing', val => val.includes('- [~] '), '/doing');
    expectCommandResult('h1', val => val.startsWith('# '), '/h1');
    expectCommandResult('h2', val => val.startsWith('## '), '/h2');
    expectCommandResult('h3', val => val.startsWith('### '), '/h3');
    expectCommandResult('quote', val => val.startsWith('> '), '/quote');
    expectCommandResult('hr', val => val.includes('---'), '/hr');
    expectCommandResult('table', val => val.includes('|') && val.includes('---'), '/table');
    expectCommandResult('frontmatter', val => /^---\s*\n[\s\S]*---/.test(val), '/frontmatter');

    await new Promise(resolve => setTimeout(resolve, 25));
    editor.editor?.destroy?.();
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
