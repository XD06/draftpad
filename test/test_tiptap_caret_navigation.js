/**
 * Tiptap 适配器光标与导航黑盒测试：setValuePreservingCaret 不乱跳（issue #5）、
 * 持久化光标快照契约（mode/offset/visibleOffset/scrollTop）、目录 id 同步、
 * 关键词跳转与源码模式往返。
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
global.getSelection = dom.window.getSelection.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = () => {};
}
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

let failures = 0;

function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
    // jsdom 无布局 API，prosemirror 的 focus/scrollIntoView 会抛错；用纯事务选区。
    const placeCaret = (pos) => {
        const doc = editor.editor.state.doc;
        const clamped = Math.max(0, Math.min(pos, doc.content.size));
        editor.editor.view.dispatch(
            editor.editor.state.tr.setSelection(TextSelection.create(doc, clamped))
        );
    };

    // 1. 快照契约：doc 尾部光标 → { mode, offset, visibleOffset, scrollTop }
    editor.setValue('# 标题\n\n第一段内容', false);
    placeCaret(editor.editor.state.doc.content.size);
    const snapshot = editor.getPersistentCaretSnapshot();
    check(
        'snapshot: wysiwyg shape',
        Boolean(snapshot)
            && snapshot.mode === 'wysiwyg'
            && snapshot.visibleOffset === snapshot.offset
            && Number.isFinite(snapshot.offset),
        snapshot
    );

    // 2. 远端更新保光标：光标在文档尾部，更新后仍应在尾部（而非回到 0）
    editor.setValuePreservingCaret('# 标题\n\n第一段内容\n\n远端新增段落', false);
    await sleep(30);
    const snapshotAfter = editor.getPersistentCaretSnapshot();
    check(
        'setValuePreservingCaret: caret stays at tail',
        snapshotAfter && snapshotAfter.visibleOffset >= (snapshot ? snapshot.visibleOffset : 0),
        { before: snapshot && snapshot.visibleOffset, after: snapshotAfter && snapshotAfter.visibleOffset }
    );

    // 3. 光标映射：光标在"第一段内容"中间，visibleOffset 对应可见文本偏移
    editor.setValue('第一段内容', false);
    placeCaret(3);
    const mid = editor.getPersistentCaretSnapshot();
    check('caret mapping: mid offset', mid.visibleOffset > 0 && mid.visibleOffset <= '第一段内容'.length, mid);

    // 4. 源码模式往返与快照
    editor.setValue('# 标题\n\n正文', false);
    editor.setSourceMode(true);
    check('source mode: textarea exposed', Boolean(editor.getSourceTextarea()), null);
    check('source mode: value passthrough', editor.getValue() === '# 标题\n\n正文', editor.getValue());
    check('source snapshot: mode=source', editor.getPersistentCaretSnapshot()?.mode === 'source', editor.getPersistentCaretSnapshot());
    editor.setSourceMode(false);
    check('source mode: roundtrip on exit', editor.getValue() === '# 标题\n\n正文', editor.getValue());

    // 5. 源码模式的视线存档 / 恢复必须落在真正承载滚动的容器上
    //    （getScrollContainer()：桌面 .vditor-wysiwyg，移动端整页 document.scrollingElement）。
    //    旧实现快照读 this.scroller、恢复写 textarea.scrollTop（textarea 不自滚，
    //    等于没恢复），切文 / 刷新后源码模式的阅读位置永远回到顶部。
    editor.setValue('# 标题\n\n正文', false);
    editor.setSourceMode(true);
    const sourceTextarea = editor.getSourceTextarea();
    const pageScroller = editor.getScrollContainer();
    sourceTextarea.setSelectionRange(4, 4);
    pageScroller.scrollTop = 4200;
    const sourceSnap = editor.getPersistentCaretSnapshot();
    check('source snapshot: scrollTop 取自真正滚动的容器',
        sourceSnap?.mode === 'source' && sourceSnap.scrollTop === 4200, sourceSnap);

    pageScroller.scrollTop = 0;   // 模拟切文 / 载入把视线清掉
    editor.restorePersistentCaret({ mode: 'source', offset: 4, scrollTop: 2600 });
    await sleep(30);
    check('source restore: 视线写回真正滚动的容器',
        pageScroller.scrollTop === 2600, pageScroller.scrollTop);
    check('source restore: 光标偏移恢复',
        sourceTextarea.selectionStart === 4, sourceTextarea.selectionStart);
    check('source restore: 不再写 textarea 自身的 scrollTop',
        sourceTextarea.scrollTop === 0, sourceTextarea.scrollTop);

    // 6. 远端更新 / 409 合并走 setValuePreservingCaret：源码模式没有 PM 光标快照，
    //    但视线必须留在原处。jsdom 无布局，用「读 scrollHeight 即钳制」模拟浏览器
    //    在 autosize 归零帧把外层滚动位置清零。
    Object.defineProperty(sourceTextarea, 'scrollHeight', {
        configurable: true,
        get() { pageScroller.scrollTop = 0; return 5000; },
    });
    try {
        pageScroller.scrollTop = 3100;
        editor.setValuePreservingCaret('# 标题\n\n正文\n\n远端追加', false);
        check('setValuePreservingCaret: 源码模式视线不被拉到顶部',
            pageScroller.scrollTop === 3100, pageScroller.scrollTop);
    } finally {
        delete sourceTextarea.scrollHeight;
    }
    editor.setSourceMode(false);

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap caret/navigation checks passed');
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
