/**
 * 文首手打 `---` 当场转正为 frontmatter 块（FrontmatterLeadInputShortcut）。
 *
 * frontmatter 的存储形态是 language=dumbpad-frontmatter 的代码块，本来已有两条入口：
 * ① 粘贴（DumbPadFrontmatterParseRule 的 markdown-it 块规则）；② setValue
 * （frontmatterToFence 的 `^---\n…\n---` 预处理）。缺的正是第三条——**打字**：
 * 用户报「想手打 frontmatter，结果只得到分隔线」。补上后三条入口必须产出同一个存储形态，
 * 否则同一篇文章在「粘贴 / 载入 / 手打」之间会漂。
 *
 * 关键约束（都在这个文件里钉住）：
 * ① 只认「文档第一个块 + `doc > paragraph` + 段落里只有这三个连字符 + 光标在段末 + 空选区」，
 *    文首以外的 `---` 仍然是分隔线——Typora 也是这个语义；
 * ② priority 110 必须压过官方 HorizontalRule（100）和 DividerInputShortcut，否则文首这条
 *    永远轮不到；
 * ③ 转正用单个事务 `replaceRangeWith`：文档只有一个空段落时「先删后插」会留下非法空 doc；
 * ④ 打字结果 == 载入结果：与 test_tiptap_roundtrip.js 第 9 节的粘贴 / setValue 形态对齐。
 * 真按键由 test/browser/editor-input.js 在真实 Chrome 里覆盖。
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

const INVISIBLE = new RegExp('[' + String.fromCharCode(0x200B) + String.fromCharCode(0xFEFF) + ']', 'g');

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
    const { PM } = globalThis.DumbPadTiptap;
    const TextSelection = PM.state.TextSelection;
    const wait = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

    const shapeOf = (view) => {
        const out = [];
        view.state.doc.forEach(node => out.push({
            type: node.type.name,
            language: node.attrs?.language ?? null,
            text: node.textContent.replace(INVISIBLE, ''),
        }));
        return out;
    };

    /** 载入用的镜像编辑器：全文件共用一个实例（适配器没有 destroy）。 */
    const mirrorContainer = document.createElement('div');
    document.body.appendChild(mirrorContainer);
    const mirror = new HybridMarkdownEditor(mirrorContainer, {});
    await mirror.whenReady();
    const reload = async (md) => {
        mirror.setValue(md, false);
        await wait(400);
        return { structure: shapeOf(mirror.editor.view), resaved: mirror.getValue() };
    };

    const makeEditor = async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const wrapper = new HybridMarkdownEditor(container, {});
        await wrapper.whenReady();
        const view = wrapper.editor.view;
        /** 走 PM 真正的打字入口 handleTextInput（与浏览器按键同一个回调点）。 */
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
        const pressEnter = () => {
            view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        };
        const blocks = () => shapeOf(view);
        /** 把光标放到「第一个满足条件的文本节点末尾」，用于构造中间态。 */
        const caretAfter = (predicate) => {
            let target = null;
            view.state.doc.descendants((node, pos) => {
                if (target === null && predicate(node)) target = pos + node.nodeSize;
                return true;
            });
            if (target === null) throw new Error('caretAfter: no matching node');
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
        };
        /** 「打字 → 序列化 → 重新解析」三方面一致。 */
        const expectStable = async (label, expectedStructure) => {
            const md = wrapper.getValue();
            const live = blocks();
            const { structure: reloaded, resaved } = await reload(md);
            check(`${label}: typed structure`, JSON.stringify(live) === JSON.stringify(expectedStructure),
                { live, expected: expectedStructure });
            check(`${label}: typing result == reload result`, JSON.stringify(reloaded) === JSON.stringify(live),
                { live, reloaded });
            check(`${label}: markdown round-trips`, resaved === md, { md, resaved });
            return { md, live, reloaded };
        };
        return { wrapper, view, type, pressEnter, blocks, caretAfter, expectStable };
    };

    // 文档末尾是非段落块时 StarterKit 的 TrailingNode 会补一个空段落（序列化里不可见），
    // frontmatter 块正好是非段落块，所以结构断言都要带上它。
    const FM = (text) => [
        { type: 'codeBlock', language: 'dumbpad-frontmatter', text },
        { type: 'paragraph', language: null, text: '' },
    ];

    /* 1. 空文档第一个块：`---` 当场转正为 frontmatter 块，光标落进块里直接打 YAML */
    {
        const { wrapper, view, type, pressEnter, blocks, expectStable } = await makeEditor();
        const fired = type('--');
        check('lead: nothing converts while typing the prefix', fired.length === 0 && blocks().length === 1
            && blocks()[0].type === 'paragraph', blocks());
        const firedThird = type('-');
        check('lead: the third dash triggers an input rule', firedThird.join('') === '-', firedThird);
        check('lead: the paragraph became a labeled code block',
            JSON.stringify(blocks()) === JSON.stringify(FM('')), blocks());
        check('lead: the cursor is inside the code block',
            view.state.selection.$from.parent.type.name === 'codeBlock');
        type('title: 我的文档标题');
        pressEnter();
        type('author: 张三');
        const md = wrapper.getValue();
        check('lead: YAML typed inside the block', md === '---\ntitle: 我的文档标题\nauthor: 张三\n---\n', md);
        await expectStable('lead', FM('title: 我的文档标题\nauthor: 张三'));
    }

    /* 2. 三条入口同一个存储形态：手打的结果 == 载入的结果 == 粘贴解析的结果 */
    {
        const { wrapper, type, pressEnter } = await makeEditor();
        type('---');
        type('title: 我的文档标题');
        pressEnter();
        type('author: 张三');
        pressEnter();
        type('date: 2024-01-15');
        const typed = wrapper.getValue();
        const source = '---\ntitle: 我的文档标题\nauthor: 张三\ndate: 2024-01-15\n---\n';
        wrapper.setValue(source, false);
        await wait(400);
        const loaded = wrapper.getValue();
        check('three entries agree: typed form == setValue form', typed === loaded, { typed, loaded });
        const pasteHtml = wrapper.editor.storage.markdown.parser.parse(source, { inline: true });
        check('three entries agree: the paste parse yields the same labeled block',
            pasteHtml.includes('language-dumbpad-frontmatter'), pasteHtml);
        wrapper.editor.commands.setContent(pasteHtml, false);
        const pasted = wrapper.getValue();
        check('three entries agree: typed form == pasted form', typed === pasted, { typed, pasted });
    }

    /* 3. 文首只打 --- 就接着写正文：空块的落盘形态不能漂出 frontmatter */
    {
        const { wrapper, type, blocks } = await makeEditor();
        type('---');
        const empty = wrapper.getValue();
        check('empty block: serializes as an empty frontmatter wrapper', empty === '---\n\n---\n', empty);
        wrapper.setValue(empty, false);
        await wait(400);
        check('empty block: reloading keeps exactly one frontmatter code block',
            JSON.stringify(blocks()) === JSON.stringify(FM('')), blocks());
        check('empty block: the wrapper survives a second save', wrapper.getValue() === empty, wrapper.getValue());
    }

    /* 4. 转正是一个事务：撤销回到字面的 --，重做再转正。
     *    中间那次 wait(600) 不是凑时间——PM 把 newGroupDelay（500ms）内的连续按键并进
     *    同一个撤销组，不打断就会「一次撤销把转正和前面两个连字符一起撤掉」。 */
    {
        const { wrapper, type, blocks } = await makeEditor();
        type('--');
        const before = wrapper.getValue();
        check('undo: the literal prefix is escaped in the source', before === '\\--', before);
        await wait(600);
        type('-');
        const converted = wrapper.getValue();
        check('undo: conversion happened', converted === '---\n\n---\n', converted);
        wrapper.editor.commands.undo();
        check('undo: back to a literal paragraph',
            blocks().length === 1 && blocks()[0].type === 'paragraph' && blocks()[0].text === '--',
            blocks());
        check('undo: the source is back to the pre-conversion text', wrapper.getValue() === before,
            { before, after: wrapper.getValue() });
        wrapper.editor.commands.redo();
        check('redo: identical to the first conversion', wrapper.getValue() === converted, wrapper.getValue());
    }

    /* 5. 第 4 个连字符落在已经成型的块里（转换发生在第 3 个，两个方向仍一致） */
    {
        const { type, blocks, expectStable } = await makeEditor();
        type('----');
        check('fourth dash: the block is already frontmatter',
            blocks()[0]?.type === 'codeBlock' && blocks()[0].language === 'dumbpad-frontmatter', blocks());
        const { md } = await expectStable('fourth dash', FM('-'));
        check('fourth dash: it becomes YAML body content, not a divider', md === '---\n-\n---\n', md);
    }

    /* 6. 已经有正文就不是 frontmatter：文首之后的软换行 `---` 归分隔线规则 */
    {
        const { wrapper, type, pressEnter, blocks, expectStable } = await makeEditor();
        type('甲');
        pressEnter();
        const fired = type('---');
        check('after text: the dash triggered an input rule', fired.join('') === '-', fired);
        const { md } = await expectStable('after text', [
            { type: 'paragraph', language: null, text: '甲' },
            { type: 'horizontalRule', language: null, text: '' },
            { type: 'paragraph', language: null, text: '' },
        ]);
        check('after text: it is a divider, not frontmatter',
            md === '甲\n\n---' && !blocks().some(b => b.language === 'dumbpad-frontmatter'), md);
    }

    /* 7. 块首（PM 真块首，第二个块）的 --- 仍走官方规则：分隔线，不是 frontmatter */
    {
        const { wrapper, type, blocks } = await makeEditor();
        type('甲');
        wrapper.editor.commands.splitBlock();
        type('---');
        check('second block: the official rule wins with a divider',
            blocks()[1]?.type === 'horizontalRule' && !blocks().some(b => b.language === 'dumbpad-frontmatter'),
            blocks());
        check('second block: markdown is a paragraph plus a thematic break',
            wrapper.getValue() === '甲\n\n---', wrapper.getValue());
    }

    /* 8. 光标不在段末（标记后面已有文字）：不接管 */
    {
        const { wrapper, view, type, blocks } = await makeEditor();
        view.dispatch(view.state.tr.insertText('---tail'));
        let start = null;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === '---tail') start = pos + 3;
            return true;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
        const fired = type('-');
        check('caret not at block end: the rule does not fire', fired.length === 0, fired);
        check('caret not at block end: still a literal paragraph',
            blocks().length === 1 && blocks()[0].type === 'paragraph'
            && blocks()[0].text === '----tail', blocks());
    }

    /* 9. 非空选区不接管 */
    {
        const { wrapper, view, type, blocks } = await makeEditor();
        view.dispatch(view.state.tr.insertText('---tail'));
        let start = null;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === '---tail') start = pos + 3;
            return true;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + 2)));
        const fired = type('-');
        check('selection: the rule does not fire over a selection', fired.length === 0, fired);
        check('selection: no code block was created',
            blocks().length === 1 && blocks()[0].type === 'paragraph', blocks());
    }

    /* 10. 第一个块不是段落（标题）时不接管：门槛要求 doc > paragraph */
    {
        const { wrapper, type, blocks } = await makeEditor();
        type('甲');
        wrapper.editor.commands.setHeading({ level: 1 });
        const fired = type('-');
        check('heading first block: the rule does not fire', fired.length === 0, fired);
        check('heading first block: no frontmatter takeover',
            !blocks().some(b => b.language === 'dumbpad-frontmatter'), blocks());
    }

    /* 11. 载入既有文章后，在第一个段落末尾补打 ---：段落里不是「只有三个连字符」，
     *     门槛直接挡掉，正文留在原地 */
    {
        const { wrapper, type, blocks, caretAfter } = await makeEditor();
        wrapper.setValue('第一段\n\n正文段落', false);
        await wait(400);
        caretAfter(node => node.isText && node.text === '第一段');
        const fired = type('---');
        check('loaded article: the rule does not fire on a paragraph with text', fired.length === 0, fired);
        check('loaded article: no frontmatter block appears',
            !blocks().some(b => b.language === 'dumbpad-frontmatter'), blocks());
        check('loaded article: the dashes joined the paragraph',
            blocks()[0].type === 'paragraph' && blocks()[0].text === '第一段---', blocks());
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap frontmatter lead input checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
