/**
 * 精简 GFM Callout（A4 雾底左浮标风：NOTE / TIP / WARNING）与往返回归测试：
 * - 覆盖单换行、同行空格、空段落隔开三种 [!NOTE|TIP|WARNING] 写法；
 * - 普通引用、未开启的类型（如 [!CAUTION]）、未加分隔空格的字面量不得误识别；
 * - 序列化与再次 setValue 往返完全一致；DOM 修饰仅走 ProseMirror Decoration，不改文档节点。
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
global.CustomEvent = dom.window.CustomEvent;
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
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});

    try {
        await editor.whenReady();

        const md = [
            '> [!NOTE]',
            '> 第一条备注正文',
            '',
            '> [!TIP] 同行技巧提示',
            '',
            '> [!WARNING]',
            '>',
            '> 多段警告正文',
            '',
            '> 这是普通引用块，不该变成 Callout',
            '',
            '> [!CAUTION]',
            '> 未开启的扩展类型保持普通引用',
            '',
            '> [!NOTE]无空格不误触发',
        ].join('\n');

        editor.setValue(md, false);

        const quotes = Array.from(container.querySelectorAll('.vditor-reset blockquote'));
        check('全部 6 个 blockquote 正常渲染', quotes.length === 6, quotes.length);

        const [noteQ, tipQ, warnQ, plainQ, cautionQ, noSpaceQ] = quotes;
        check('NOTE 识别为 A4 callout 且带正确属性与标题',
            noteQ.classList.contains('dumbpad-callout')
            && noteQ.classList.contains('is-callout-note')
            && noteQ.getAttribute('data-callout') === 'note'
            && noteQ.querySelector('.dumbpad-callout-header .dumbpad-callout-title')?.textContent === '备注'
            && Boolean(noteQ.querySelector('.dumbpad-callout-icon svg'))
            && Boolean(noteQ.querySelector('.dumbpad-callout-tag'))
            && Boolean(noteQ.querySelector('br.dumbpad-callout-tag-break')));

        check('TIP 同行格式识别并标记 [!TIP] 徽标',
            tipQ.getAttribute('data-callout') === 'tip'
            && tipQ.querySelector('.dumbpad-callout-title')?.textContent === '提示'
            && tipQ.querySelector('.dumbpad-callout-tag')?.textContent === '[!TIP] ');

        check('WARNING 多段空行格式标记首段 tag-line',
            warnQ.getAttribute('data-callout') === 'warning'
            && warnQ.querySelector('.dumbpad-callout-title')?.textContent === '注意'
            && warnQ.querySelector('p')?.classList.contains('dumbpad-callout-tag-line') === true);

        check('普通引用、CAUTION 与无空格字面量均保持纯净 blockquote',
            !plainQ.classList.contains('dumbpad-callout')
            && !cautionQ.classList.contains('dumbpad-callout')
            && !noSpaceQ.classList.contains('dumbpad-callout'));

        const serialized = editor.getValue();
        check('Markdown 序列化不包含任何 Decoration widget 文案（如 备注/提示/注意）',
            !serialized.includes('\n备注') && serialized.includes('> [!NOTE]') && serialized.includes('> [!TIP]') && serialized.includes('> [!WARNING]'),
            { serialized });

        editor.setValue(serialized, false);
        check('Markdown 再次 setValue 往返幂等', editor.getValue() === serialized);

        // Live-Preview 选区联动与行首 Backspace 行为校验
        const { TextSelection } = globalThis.DumbPadTiptap.PM.state;
        const view = editor.editor.view;
        editor.setValue('# 标题\n\n> [!NOTE]\n> 正文首字\n\n尾部段落', false);
        // 1) 光标在标题或提示块正文时，不显露 [!NOTE] 源码标签
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
        const liveNote = container.querySelector('blockquote.dumbpad-callout[data-callout="note"]');
        check('光标不在提示块标签上时不加 is-callout-editing-tag',
            Boolean(liveNote && !liveNote.classList.contains('is-callout-editing-tag')));

        // 找到 body 首字位置与 tag 位置
        let tagMidPos = -1;
        let bodyStartPos = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.type.name === 'blockquote') {
                const p = node.firstChild;
                const bqContent = pos + 2;
                tagMidPos = bqContent + 2;
                for (let i = 0; i < p.childCount; i += 1) {
                    const ch = p.child(i);
                    if (ch.type.name === 'hardBreak') {
                        bodyStartPos = bqContent + 8; // [!NOTE](7) + br(1)
                        break;
                    }
                }
            }
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, bodyStartPos + 1)));
        check('光标在提示块正文内依然隐去 [!NOTE] 标签保持纯净双行',
            !container.querySelector('blockquote.dumbpad-callout')?.classList.contains('is-callout-editing-tag'));

        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, tagMidPos)));
        check('光标移入 [!NOTE] 标签区间时才亮出微源码标记',
            Boolean(container.querySelector('blockquote.dumbpad-callout')?.classList.contains('is-callout-editing-tag')));

        // 2) 在“正文首字”最前按 Backspace：摘掉 [!NOTE]+<br>，变成普通引用而非把 [!NOTE] 和正文粘一起
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, bodyStartPos)));
        const bsEv = new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
        view.dom.dispatchEvent(bsEv);
        const afterBsVal = editor.getValue();
        check('正文行首 Backspace 剥离 [!NOTE] 退为普通引用且不拼接 [!NOTE]正文',
            afterBsVal.includes('> 正文首字') && !afterBsVal.includes('[!NOTE]'),
            { afterBsVal });

        // 3) 用 /tip 插入空提示块后直接按 Backspace：解除外框回退成普通段落
        editor.setValue('', false);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
        view.dispatch(view.state.tr.insertText('/tip'));
        view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        check('通过 /tip 刚插入空提示块时就存在 callout 外框',
            Boolean(container.querySelector('blockquote.dumbpad-callout[data-callout="tip"]')));
        view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
        check('空提示块正文处按 Backspace 直接解封为普通空段',
            !container.querySelector('blockquote') && editor.getValue().trim() === '',
            { val: editor.getValue() });
    } finally {
        editor.destroy?.();
        container.remove();
        dom.window.close();
    }

    if (failures > 0) {
        console.error(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll callout tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
