/**
 * 分隔线的实时转换（DividerInputShortcut）：软换行后的「视觉行首」打 `---` 必须当场拆块
 * 并插成分隔线，与刷新后的结果一致。
 *
 * 修前的事实：Enter 造的是段内 `<br>`（MdSoftBreak）不是新块，而官方 HorizontalRule 唯一的
 * 输入规则 `/^(?:---|—-|___\s|\*\*\*\s)$/` 是 `^` 锚 PM 块首的，所以 `甲` + Enter + `---`
 * 在屏幕上永远是字面文本，序列化成 `甲\n---`，**重新解析被 setext 当成标题下划线**——`甲`
 * 变二级标题、`---` 被吃掉。那是「打字时 ≠ 刷新后」里最重的一档（静默改内容）。
 *
 * 这里同时固化几个刻意决定：
 * ① 按「分隔线」解释而不是当场把上一块变 H2——拆块后的落盘形态 `甲\n\n---` 两个方向都稳定；
 *    粘贴 `甲\n---` 仍按标准 Markdown 解析成 H2，那是另一条入口，自身往返稳定；
 * ② 空格门槛不放宽（`___` / `***` 仍要求尾随空格）：那是上游留给强调标记的护身符，
 *    放宽会把 `***重点***` 当场变成分隔线（见第 5 节）；
 * ③ 只在第 3 个连字符上命中，所以 `----` 的实测结果是分隔线 + 后面段落里一个游离 `-`
 *    （两个方向一致），本文件把它钉住，而不是再加一条抢不到的 `^` 分支；
 * ④ 作用域只有 `doc > paragraph`：代码块内不接管（第 8 节），引用块 / 列表项内的软换行也
 *    不接管（第 10 节，那一档的 setext 漂移是既有缺口，另行报告，不在本次改动里顺手扩）。
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

    const shapeOf = (view) => {
        const out = [];
        view.state.doc.forEach(node => out.push({
            type: node.type.name,
            language: node.attrs?.language ?? null,
            text: node.textContent.replace(/[\u200B\uFEFF]/g, '')
        }));
        return out;
    };

    /**
     * 载入用的镜像编辑器：全文件共用一个实例，只靠 setValue 换正文
     * （适配器没有 destroy，逐个 new 会在同一进程里堆出几十个 EditorView）。
     */
    const mirrorContainer = document.createElement('div');
    document.body.appendChild(mirrorContainer);
    const mirror = new HybridMarkdownEditor(mirrorContainer, {});
    await mirror.whenReady();
    const reload = async (md) => {
        mirror.setValue(md, false);
        await new Promise(resolve => setTimeout(resolve, 300));
        return { structure: shapeOf(mirror.editor.view), resaved: mirror.getValue() };
    };

    /** 每个用例一个独立编辑器实例：撤销历史与文档互不串线。 */
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
        const breakCount = () => {
            let total = 0;
            view.state.doc.descendants(node => {
                if (node.type.name === 'hardBreak') total += 1;
                return true;
            });
            return total;
        };
        const caretAtEnd = () => {
            view.dispatch(view.state.tr.setSelection(
                TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
            ));
        };
        /** 「打字 → 序列化 → 重新解析」三方面一致：结构、镜像结构、再序列化。 */
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
        return { wrapper, view, type, pressEnter, blocks, breakCount, caretAtEnd, expectStable };
    };

    const DIVIDER = [
        { type: 'paragraph', language: null, text: '甲' },
        { type: 'horizontalRule', language: null, text: '' },
        { type: 'paragraph', language: null, text: '' },
    ];

    /* 1. 主路径：视觉行首的 `---` 当场拆块成分隔线（修前是字面文本 + 刷新变 H2） */
    {
        const { type, pressEnter, blocks, breakCount, expectStable } = await makeEditor();
        type('甲');
        pressEnter();
        const fired = type('--');
        check('main: the first two dashes trigger nothing', fired.length === 0, fired);
        check('main: still one paragraph with a soft break', blocks().length === 1
            && breakCount() === 1, blocks());
        const firedThird = type('-');
        check('main: the third dash triggers an input rule', firedThird.join('') === '-', firedThird);
        check('main: no soft break is left behind', breakCount() === 0, breakCount());
        const { md } = await expectStable('main', DIVIDER);
        check('main: markdown is a paragraph plus a thematic break', md === '甲\n\n---', md);
    }

    /* 2. 第 4 个连字符落在分隔线之后的段落里（转换发生在第 3 个，两个方向仍一致） */
    {
        const { type, pressEnter, expectStable } = await makeEditor();
        type('甲');
        pressEnter();
        type('----');
        const { md } = await expectStable('fourth dash', [
            { type: 'paragraph', language: null, text: '甲' },
            { type: 'horizontalRule', language: null, text: '' },
            { type: 'paragraph', language: null, text: '-' },
        ]);
        check('fourth dash: the stray dash is escaped so it stays literal',
            md === '甲\n\n---\n\n\\-', md);
    }

    /* 3. `___` / `***` 带尾随空格：视觉行首也当场成线（空格属于标记的一部分，被吃掉） */
    {
        for (const marker of ['___ ', '*** ']) {
            const { type, pressEnter, expectStable } = await makeEditor();
            type('甲');
            pressEnter();
            type(marker);
            const { md } = await expectStable(`soft break + ${JSON.stringify(marker)}`, DIVIDER);
            check(`${marker}: serializes as the canonical --- form`, md === '甲\n\n---', md);
        }
    }

    /* 4. 刻意不放宽空格门槛：`___` / `***` 不带空格时不接管（强调标记的护身符）。
     *    这一档在 PM 块首同样是「打字不转、刷新才转」的既有形态（官方规则的形状），
     *    这里固化的是「视觉行首与块首一致地不接管」，不是稳定往返。 */
    {
        for (const marker of ['___', '***']) {
            const { type, pressEnter, blocks } = await makeEditor();
            type('甲');
            pressEnter();
            const fired = type(marker);
            check(`${JSON.stringify(marker)} without a space: the rule does not fire`,
                fired.length === 0, fired);
            check(`${JSON.stringify(marker)} without a space: stays literal text`,
                blocks().length === 1 && blocks()[0].type === 'paragraph'
                && blocks()[0].text === `甲\n${marker}`, blocks());
        }
    }

    /* 5. 强调标记不被误伤 */
    {
        const { wrapper, type, pressEnter, blocks, expectStable } = await makeEditor();
        type('甲');
        pressEnter();
        type('***重点***');
        check('emphasis: no divider is created', blocks().length === 1
            && blocks()[0].type === 'paragraph' && blocks()[0].text === '甲\n***重点***', blocks());
        await expectStable('emphasis', [
            { type: 'paragraph', language: null, text: '甲\n***重点***' },
        ]);
        check('emphasis: the markers survive into the source escaped',
            wrapper.getValue().includes('\\*\\*\\*'), wrapper.getValue());
    }

    /* 6. 同一行内（不是行首）的 `---` 永远只是文字，两个方向一致 */
    {
        const { type, blocks, expectStable } = await makeEditor();
        type('甲---');
        check('mid-line: no conversion', blocks().length === 1
            && blocks()[0].type === 'paragraph' && blocks()[0].text === '甲---', blocks());
        const { md } = await expectStable('mid-line', [
            { type: 'paragraph', language: null, text: '甲---' },
        ]);
        check('mid-line: markdown keeps it literal', md === '甲---', md);
    }

    /* 7. 光标在标记右侧（空选区、行中没有收尾）：仍然成线，后面的文字留在新段落 */
    {
        const { wrapper, view, type, blocks, caretAtEnd } = await makeEditor();
        view.dispatch(view.state.tr.insertText('甲'));
        wrapper.editor.commands.setHardBreak();
        view.dispatch(view.state.tr.insertText('---yz'));
        // 把光标放回 `---` 与 `yz` 之间：这是「行首标记已经打完、后面还有内容」的打字中间态
        let target = null;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === '---yz') target = pos + 3;
            return true;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
        const fired = type('-');
        check('caret mid-paragraph: the dash triggered an input rule', fired.join('') === '-', fired);
        check('caret mid-paragraph: the divider lands at the line start',
            JSON.stringify(blocks()) === JSON.stringify([
                { type: 'paragraph', language: null, text: '甲' },
                { type: 'horizontalRule', language: null, text: '' },
                { type: 'paragraph', language: null, text: 'yz' },
            ]), blocks());
        check('caret mid-paragraph: trailing text survives in the new paragraph',
            wrapper.getValue() === '甲\n\n---\n\nyz', wrapper.getValue());
        void caretAtEnd;
    }

    /* 8. 非空选区不接管：选中的文字不能因为一次按键被换成结构 */
    {
        const { view, wrapper, type, blocks } = await makeEditor();
        view.dispatch(view.state.tr.insertText('甲'));
        wrapper.editor.commands.setHardBreak();
        view.dispatch(view.state.tr.insertText('---yz'));
        let start = null;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === '---yz') start = pos + 3;
            return true;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + 2)));
        const fired = type('-');
        check('selection: the rule does not fire over a non-empty selection',
            fired.length === 0, fired);
        check('selection: the paragraph is not split into a divider',
            blocks().length === 1 && blocks()[0].type === 'paragraph'
            && !blocks().some(block => block.type === 'horizontalRule'), blocks());
        check('selection: the dash is inserted like any other character',
            blocks()[0].text === '甲\n----', blocks());
    }

    /* 9. 代码块内不接管（块内打 --- 是内容，不是语法） */
    {
        const { wrapper, view, type, pressEnter, blocks } = await makeEditor();
        type('甲');
        pressEnter();
        type('```js');
        pressEnter();
        check('code block: the fence opened', blocks()[1]?.type === 'codeBlock', blocks());
        const fired = type('---');
        check('code block: no input rule fires inside the block', fired.length === 0, fired);
        check('code block: --- inside the block stays literal content',
            view.state.selection.$from.parent.type.name === 'codeBlock'
            && blocks()[1].text === '---', blocks());
        check('code block: no horizontalRule node anywhere',
            !blocks().some(block => block.type === 'horizontalRule'), blocks());
        check('code block: markdown keeps the dashes inside the fence',
            wrapper.getValue() === '甲\n\n```js\n---\n```', wrapper.getValue());
    }

    /* 10. 官方 PM 块首路径不回归，且分隔线后可以再来一条 */
    {
        const { wrapper, type, blocks, expectStable } = await makeEditor();
        type('甲');
        // 真块首：用框架的 splitBlock 造一个新段落（Enter 在本文的基线里是软换行）
        wrapper.editor.commands.splitBlock();
        check('block start: splitBlock really made a second paragraph',
            blocks().length === 2 && blocks()[1].text === '', blocks());
        type('---');
        check('block start: the official rule still produces a divider',
            blocks()[1]?.type === 'horizontalRule', blocks());
        type('---');
        await expectStable('two dividers', [
            { type: 'paragraph', language: null, text: '甲' },
            { type: 'horizontalRule', language: null, text: '' },
            { type: 'horizontalRule', language: null, text: '' },
            { type: 'paragraph', language: null, text: '' },
        ]);
    }

    /* 11. 引用块内的软换行不接管：作用域只有 doc > paragraph。
     *    实测的「打字不转、刷新成 setext 标题」是既有缺口（本次刻意不扩，已在报告里列出），
     *    所以这里只钉住「规则不碰嵌套块」，不假装它稳定。 */
    {
        const { wrapper, view, type, blocks } = await makeEditor();
        wrapper.setValue('> 甲', false);
        let target = null;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === '甲') target = pos + 1;
            return true;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
        wrapper.editor.commands.setHardBreak();
        const fired = type('---');
        check('blockquote: the rule does not reach nested paragraphs', fired.length === 0, fired);
        check('blockquote: no divider node is created inside the quote',
            blocks()[0].type === 'blockquote'
            && !blocks().some(block => block.type === 'horizontalRule'), blocks());
        check('blockquote: the dashes stay literal in the source',
            wrapper.getValue() === '> 甲\n> ---', wrapper.getValue());
    }

    /* 12. 转换是一个事务：撤销回到字面文本，重做再成线。
     *    中间那次 sleep 不是凑时间——PM 历史会把 newGroupDelay（500ms）内的连续按键并成
     *    一组撤销，不打断就会「一次 Ctrl+Z 把整段打字全撤掉」，那样测不到转换本身是否可逆。 */
    {
        const { wrapper, view, type, pressEnter, expectStable } = await makeEditor();
        type('甲');
        pressEnter();
        type('--');
        const before = wrapper.getValue();
        await new Promise(resolve => setTimeout(resolve, 600));
        type('-');
        const converted = wrapper.getValue();
        check('undo: conversion happened', converted === '甲\n\n---', converted);
        wrapper.editor.commands.undo();
        check('undo: back to the literal dashes', wrapper.getValue() === before, wrapper.getValue());
        check('undo: the soft break is restored', (() => {
            let total = 0;
            view.state.doc.descendants(node => {
                if (node.type.name === 'hardBreak') total += 1;
                return true;
            });
            return total === 1;
        })(), wrapper.getValue());
        wrapper.editor.commands.redo();
        check('redo: identical to the first conversion', wrapper.getValue() === converted, wrapper.getValue());
        await expectStable('after redo', DIVIDER);
    }

    /* 13. 视觉行首的缩进与连续软换行：与 SoftBreakBlockRules 同一套吞法 */
    for (const marker of ['  ---', '\t---']) {
        const { type, pressEnter, breakCount, expectStable } = await makeEditor();
        type('甲');
        pressEnter();
        pressEnter();
        const fired = type(marker);
        check(`${JSON.stringify(marker)}: the third dash triggers an input rule`,
            fired.join('') === '-', fired);
        check(`${JSON.stringify(marker)}: no stray break is left behind`, breakCount() === 0, breakCount());
        const { md } = await expectStable(`indent ${JSON.stringify(marker)}`, DIVIDER);
        check(`${JSON.stringify(marker)}: the indentation does not leak back into the source`,
            md === '甲\n\n---', md);
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap divider input checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
