/**
 * 软换行后的「视觉行首」输入块标记（# - * + 1. >）必须在输入当场拆块并应用块类型，
 * 与刷新后的解析结果一致——磁盘格式本来就是对的（`甲\n# 乙` 重新解析就是 paragraph +
 * heading），缺的只是编辑器在打字那一刻把软换行当成了段内换行、不当行首。
 *
 * 这里断言的是输入规则本身：find 命中后的拆块结果、块属性、缩进与连续换行的处理、
 * 不该接管的场景（代码块 / 裸换行文本 / 非行首 / 官方块首规则）、撤销与往返稳定。
 * 真按键（含空格触发规则）由 test/browser/editor-input.js 第 8 段在真实 Chrome 里覆盖。
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
global.getSelection = dom.window.getSelection.bind(dom.window);
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

const HREF = '/api/assets/0123456789abcdef0123456789abcdef/download';
const FILE_MD = `[甲.pdf](${HREF} "dumbpad-file=1;size=1;type=application/pdf")`;

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const wrapper = new HybridMarkdownEditor(container, {});
    await wrapper.whenReady();
    const editor = wrapper.editor;
    const view = editor.view;
    const { PM } = globalThis.DumbPadTiptap;
    const TextSelection = PM.state.TextSelection;

    /** 顶层块清单：[{type, level, start, text}]，软换行在 text 里就是 '\n'。 */
    const blocks = () => {
        const out = [];
        view.state.doc.forEach(node => out.push({
            type: node.type.name,
            level: node.attrs?.level ?? null,
            start: node.attrs?.start ?? null,
            text: node.textContent.replace(/[\u200B\uFEFF]/g, ''),
        }));
        return out;
    };
    const breakCount = () => {
        let total = 0;
        view.state.doc.descendants(node => {
            if (node.type.name === 'hardBreak') total += 1;
            return true;
        });
        return total;
    };
    const pressEnter = () => {
        view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    /**
     * 走 PM 真正的打字入口 handleTextInput（与浏览器按键同一个回调点）：规则命中时
     * 由规则自己派发事务、字符不再单独插入；没命中时按普通插入处理。
     */
    const type = (text) => {
        const fired = [];
        for (const ch of text) {
            const { from, to } = view.state.selection;
            const handled = view.someProp('handleTextInput', fn => fn(view, from, to, ch));
            if (handled) fired.push(ch);
            else view.dispatch(view.state.tr.insertText(ch, from, to));
        }
        return fired;
    };
    const caretAtEnd = () => {
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
        ));
    };
    /** 光标放到最后一个软换行之后（= 该行行首）。 */
    const caretAfterLastBreak = () => {
        let target = null;
        view.state.doc.descendants((node, pos) => {
            if (node.type.name === 'hardBreak') target = pos + 1;
            return true;
        });
        if (target === null) throw new Error('no soft break in doc');
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
    };
    /** 单行 + Enter + 打字，返回规则实际命中的字符。 */
    const softLine = (marker, tail = '乙') => {
        wrapper.setValue('甲', false);
        caretAtEnd();
        pressEnter();
        return type(`${marker}${tail}`);
    };

    // 1. 标题：拆块 + level，源与刷新后同构
    let fired = softLine('# ');
    check('heading: the space triggered an input rule', fired.join('') === ' ', fired);
    check('heading: paragraph split, second line became h1', JSON.stringify(blocks())
        === JSON.stringify([
            { type: 'paragraph', level: null, start: null, text: '甲' },
            { type: 'heading', level: 1, start: null, text: '乙' },
            { type: 'paragraph', level: null, start: null, text: '' },
        ]), blocks());
    let md = wrapper.getValue();
    check('heading: markdown is a real heading block', md === '甲\n\n# 乙', md);
    check('heading: rendered as <h1>', !!container.querySelector('.tiptap h1')
        && container.querySelector('.tiptap h1').textContent === '乙');
    wrapper.setValue(md, false);
    check('heading: typing result == reload result', JSON.stringify(blocks())
        === JSON.stringify([
            { type: 'paragraph', level: null, start: null, text: '甲' },
            { type: 'heading', level: 1, start: null, text: '乙' },
            { type: 'paragraph', level: null, start: null, text: '' },
        ]), blocks());
    check('heading: markdown round-trips', wrapper.getValue() === md, wrapper.getValue());

    // 1b. 多级标题
    softLine('### ');
    check('heading level 3', blocks()[1]?.type === 'heading' && blocks()[1].level === 3, blocks());

    // 2. 无序列表：- * + 三种bullet
    for (const marker of ['-', '*', '+']) {
        softLine(`${marker} `);
        const list = blocks()[1];
        check(`bullet "${marker}": line becomes a bullet list item`,
            list?.type === 'bulletList' && list.text === '乙', blocks());
        md = wrapper.getValue();
        check(`bullet "${marker}": markdown has no leftover marker text`, md === '甲\n\n- 乙', md);
    }

    // 3. 有序列表：start 属性保留（3. 不是 1.）
    softLine('3. ');
    check('ordered: list created with start=3', blocks()[1]?.type === 'orderedList'
        && blocks()[1]?.start === 3 && blocks()[1].text === '乙', blocks());
    md = wrapper.getValue();
    check('ordered: markdown keeps the number', md === '甲\n\n3. 乙', md);
    wrapper.setValue(md, false);
    check('ordered: reload keeps start=3', blocks()[1]?.start === 3, blocks());

    // 4. 引用
    softLine('> ');
    check('blockquote: line wrapped into a quote', blocks()[1]?.type === 'blockquote'
        && blocks()[1].text === '乙', blocks());
    check('blockquote: markdown', wrapper.getValue() === '甲\n\n> 乙', wrapper.getValue());

    // 5. 缩进：换行与标记之间的空格/制表符一起吃掉，绝不能留进源里
    //    （`甲\n\n    - 乙` 重新解析会变成缩进代码块，那是数据损坏）
    for (const indent of ['  ', '    ', '\t']) {
        wrapper.setValue('甲', false);
        caretAtEnd();
        pressEnter();
        type(`${indent}- 乙`);
        md = wrapper.getValue();
        check(`indent ${JSON.stringify(indent)}: marker consumed, no leading blanks in source`,
            md === '甲\n\n- 乙', md);
        check(`indent ${JSON.stringify(indent)}: still a bullet list`, blocks()[1]?.type === 'bulletList', blocks());
    }

    // 6. 连续软换行：拆块点吸掉紧邻的换行，上一块不留游离 <br>
    wrapper.setValue('甲', false);
    caretAtEnd();
    pressEnter();
    pressEnter();
    check('two enters create two soft breaks', breakCount() === 2, breakCount());
    type('# 乙');
    check('consecutive breaks: previous paragraph has no stray break', breakCount() === 0, breakCount());
    check('consecutive breaks: same shape as a single break', JSON.stringify(blocks().slice(0, 2))
        === JSON.stringify([
            { type: 'paragraph', level: null, start: null, text: '甲' },
            { type: 'heading', level: 1, start: null, text: '乙' },
        ]), blocks());
    check('consecutive breaks: markdown', wrapper.getValue() === '甲\n\n# 乙', wrapper.getValue());

    // 7. 不该接管的场景
    fired = softLine('#', '');
    check('no space after # does not split', blocks()[0]?.text === '甲\n#' && blocks().length === 1, blocks());
    fired = softLine('####### ', '');
    check('seven hashes do not split (levels are 1-6)', blocks()[0]?.text === '甲\n####### '
        && blocks().length === 1, blocks());
    wrapper.setValue('甲', false);
    caretAtEnd();
    pressEnter();
    type('乙');
    fired = type('# ');
    check('marker in the middle of a visual line does not split', fired.length === 0
        && blocks()[0]?.text === '甲\n乙# ', blocks());
    wrapper.setValue('```js\nvar a\n# 乙\n```', false);
    check('code block content untouched', blocks()[0]?.type === 'codeBlock'
        && blocks()[0].text.includes('# 乙') && wrapper.getValue() === '```js\nvar a\n# 乙\n```', wrapper.getValue());
    // 文本节点里的裸换行（粘贴/异常数据）不算软换行：拆块点必须真是 hardBreak 节点
    wrapper.setValue('甲', false);
    caretAtEnd();
    type('\n# 乙');
    check('a raw newline inside a text node does not split', breakCount() === 0
        && blocks().length === 1 && blocks()[0]?.text === '甲\n# 乙', { blocks: blocks(), breaks: breakCount() });

    // 8. 官方块首规则不能被抢：真块首仍然只改本块（我们的 find 必须以 \n 开头，绝不参与）
    wrapper.setValue('甲\n\n乙', false);
    const secondBlockStart = 1 + view.state.doc.child(0).nodeSize;
    view.dispatch(view.state.tr.setSelection(
        TextSelection.create(view.state.doc, secondBlockStart),
    ));
    type('# ');
    type('丙');
    check('real block start uses the stock rule without splitting',
        blocks()[0]?.type === 'paragraph' && blocks()[0].text === '甲'
        && blocks()[1]?.type === 'heading' && blocks()[1].text === '丙乙'
        && breakCount() === 0, blocks());

    // 9. 附件 chip 后的软换行：拆块不碰链接
    wrapper.setValue(`${FILE_MD}\n乙`, false);
    caretAfterLastBreak();
    fired = type('# 丙');
    check('after an attachment chip: line start splits into h1', fired.join('') === ' '
        && blocks()[1]?.type === 'heading' && blocks()[1].text === '丙乙', blocks());
    check('after an attachment chip: markdown keeps the file link',
        wrapper.getValue() === `${FILE_MD}\n\n# 丙乙`, wrapper.getValue());
    check('after an attachment chip: still one anchor with no <br> inside',
        container.querySelectorAll('a').length === 1
        && container.querySelectorAll('a br').length === 0, container.querySelector('p')?.innerHTML);

    // 10. 规则是单个事务（撤销历史里就是一步，不会留下「删了标记但没拆块」的半截状态），
    //     且光标落进拆出来的新块里——用户接着打的字必须进标题。
    //     注：不测 Tiptap 的 undoInputRule——实测它对**官方**块规则也不生效（规则派发后紧跟
    //     的事务把插件状态清成了 null，stock 与 soft 两种都是 false），不是本规则的契约。
    wrapper.setValue('甲', false);
    caretAtEnd();
    pressEnter();
    let transactions = 0;
    const countTransaction = () => { transactions += 1; };
    editor.on('transaction', countTransaction);
    type('#');
    const afterHash = transactions;
    type(' ');
    editor.off('transaction', countTransaction);
    check('the rule dispatches exactly one transaction', transactions - afterHash === 1,
        transactions - afterHash);
    check('empty heading is the rule result, no stray break left', blocks()[1]?.type === 'heading'
        && blocks()[1].text === '' && breakCount() === 0, blocks());
    type('乙');
    check('typing continues inside the new heading', blocks()[1]?.text === '乙'
        && wrapper.getValue() === '甲\n\n# 乙', { blocks: blocks(), value: wrapper.getValue() });

    // 11. 与列表内 [ ] 规则接力：软换行 → - → [ ] 得到任务项
    wrapper.setValue('甲', false);
    caretAtEnd();
    pressEnter();
    type('- 乙');
    type(' [ ] ');
    check('soft break → bullet → [ ] composes into a task item',
        blocks()[1]?.type === 'taskList' && blocks()[1].text.startsWith('乙'), blocks());

    // 12. 存储契约：没被规则接管的软换行仍是段内单个换行（老文章不需要迁移）
    wrapper.setValue('前一段\n第二行\n尾行', false);
    check('untouched soft breaks still serialize as single newlines',
        wrapper.getValue() === '前一段\n第二行\n尾行' && breakCount() === 2,
        { value: wrapper.getValue(), breaks: breakCount() });

    // 13. 非段落的块里确实可能出现 <br>（Shift+Enter 走 setHardBreak，它没有 depth 守卫），
    //     这类块必须原样放过——删掉 softBreakRulePosition 的 depth/paragraph 判定就会拆坏它们。
    /** 把光标放到文档里第一段有文字的位置末尾（= 种子块内部，不是它后面那个空段落）。 */
    const caretInSeed = () => {
        let target = null;
        view.state.doc.descendants((node, pos) => {
            if (target === null && node.isText && node.nodeSize) target = pos + node.nodeSize;
            return target === null;
        });
        if (target === null) throw new Error('seed block has no text to anchor the caret');
        view.dispatch(view.state.tr.setSelection(
            TextSelection.create(view.state.doc, target),
        ));
    };
    for (const [label, seed, expectedShape] of [
        // 期望串里的 \n 就是那个没被吃掉的软换行（textContent 经 leafText 读成换行）。
        ['heading', '# 标题', 'heading:标题\n# 补'],
        ['bullet item', '- 甲', 'bulletList:甲\n# 补'],
        ['blockquote', '> 甲', 'blockquote:甲\n# 补'],
    ]) {
        wrapper.setValue(seed, false);
        caretInSeed();
        const madeBreak = editor.commands.setHardBreak();
        const blocksBefore = blocks().length;
        type('# 补');
        const shape = blocks().filter(b => b.text).map(b => `${b.type}:${b.text}`).join(' | ');
        // setHardBreak 没有 depth 守卫（Shift+Enter 就是这么把 <br> 放进标题/列表/引用的），
        // 而这里必须放过：删掉 softBreakRulePosition 的 depth/paragraph 判定，标题会被劈成两个。
        check(`${label}: a <br> inside it is not split by a block marker`,
            madeBreak === true && breakCount() === 1 && blocks().length === blocksBefore
            && shape === expectedShape, { madeBreak, blocksBefore, blocks: blocks(), shape });
    }

    // 14. 非空选区不接管：规则不该把自己范围之外的选区一起吞掉。
    //     runner 的 textBefore 只取到**选区起点**，所以够得着这条规则的形状是「选区在标记右侧」：
    //     `甲\n#` + 选中 `乙` 再打空格 → textBefore = '甲\n#' + ' ' 命中 `\n# $`，
    //     range = { 软换行, 选区末 }。去掉 handler 的 selection.empty 守卫，deleteRange 会连选区
    //     一起删掉、再拆出一个空标题。带守卫时走普通输入：空格替换选区（正常打字该如此），
    //     块型不变、不拆块。删掉守卫这条必红（§14 就是这个守卫的唯一覆盖）。
    wrapper.setValue('甲', false);
    caretAtEnd();
    pressEnter();
    const seeded = type('#乙');
    check('a bare marker before a selection triggers nothing', seeded.length === 0, seeded);
    {
        const end = view.state.selection.from;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end - 1, end)));
        const firedWithSelection = type(' ');
        check('a non-empty selection is left to the normal typing path',
            firedWithSelection.length === 0
            && JSON.stringify(blocks()) === JSON.stringify(
                [{ type: 'paragraph', level: null, start: null, text: '甲\n# ' }])
            && breakCount() === 1, blocks());
    }

    // 15. 段首正好就是软换行时（空段落 Shift+Enter 会得到 paragraph(<br>)），`- ` 同时命中
    //     官方 bullet 规则（`^\s*([-+*])\s$` 的 \s* 吃掉了 <br> 的 '\n'）。官方 handler 会把
    //     整块包进列表；扩展的 priority: 101 保证这里赢，与它在数组里的声明位置无关。
    wrapper.setValue('', false);
    caretAtEnd();
    editor.commands.setHardBreak();
    check('an empty paragraph + Shift-Enter leaves a leading break', breakCount() === 1
        && blocks()[0]?.text === '\n', blocks());
    type('- 乙');
    check('the soft-break rule owns that overlap (split, not wrap-whole-block)',
        blocks()[0]?.type === 'paragraph' && blocks()[0].text === ''
        && blocks()[1]?.type === 'bulletList' && blocks()[1].text === '乙', blocks());

    // 16. 标记打在行尾（拆出一个空块）：源与重载必须稳定，不能把上一行也吃掉
    wrapper.setValue('甲', false);
    caretAtEnd();
    pressEnter();
    type('# ');
    md = wrapper.getValue();
    check('an empty heading at the line end round-trips', md === '甲\n\n# '
        && blocks()[1]?.type === 'heading' && blocks()[0].text === '甲', { md, blocks: blocks() });
    wrapper.setValue(md, false);
    check('reloading that source reproduces the same blocks',
        wrapper.getValue() === md && blocks()[1]?.type === 'heading', wrapper.getValue());
}

main().then(() => {
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap soft-break block rules passed');
}).catch(err => {
    console.error(err);
    process.exit(1);
});
