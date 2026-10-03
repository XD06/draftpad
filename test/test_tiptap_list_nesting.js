/**
 * 列表嵌套 × Typora 退格语义回归（jsdom）：
 * 1) Tab/Shift-Tab 构建与退出嵌套（含任务项）；
 * 2) 非空条目行首退格 = lift 一层（光标停留原地），再退 = 退出列表成段落，再退 = 并入上一行；
 * 3) 空项退格 = 清除继承的列表标记、并入上一条目成为尾部空行（光标原地、缩进保留），
 *    再退 = 逐级降一层，顶层末位再退 = 退出列表成顶层段落（「回到最开头」）；
 * 4) 无 Tab 嵌套流：Enter → Backspace → 直接键入 `- `/`[ ] ` 即得嵌套列表（手机路径）；
 * 5) 空任务项解析补丁（- [ ] 不再退化为字面 "[ ]" 文本）；
 * 6) 空列表标记行解析补丁（- 甲\n  - 不再被 setext 吞成二级标题）；
 * 7) getValue 的空标记归一化（围栏/数学块/frontmatter 不动、同层兄弟不动、幂等）。
 * 真实键盘链路（Tab 捕获、退格时机、复选框对齐）另由真机浏览器回归覆盖。
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
    const { HybridMarkdownEditor, normalizeAmbiguousEmptyListMarkers } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const view = editor.editor.view;
    const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;

    const shape = () => {
        const types = [];
        editor.editor.state.doc.descendants(node => { types.push(node.type.name); return true; });
        return types.join(' > ');
    };
    const caretAtLineStart = (needle) => {
        let targetPos = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (targetPos !== null) return false;
            if (node.type.name === 'paragraph' && node.textContent.includes(needle)) targetPos = pos;
            return true;
        });
        if (targetPos === null) throw new Error(`caret target missed: ${needle}`);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(editor.editor.state.doc, targetPos + 1)));
    };
    /** 单孩子且内容为空的列表项：光标放进它的空段落内容起点。 */
    const caretInEmptyItem = () => {
        let targetPos = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (targetPos !== null) return false;
            if (['listItem', 'taskItem'].includes(node.type.name) && node.childCount === 1) {
                const last = node.lastChild;
                if (last && last.type.name === 'paragraph' && !last.textContent) targetPos = pos + 2;
            }
            return true;
        });
        if (targetPos === null) throw new Error('no empty item found');
        view.dispatch(view.state.tr.setSelection(TextSelection.create(editor.editor.state.doc, targetPos)));
    };
    const press = (key, options = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        view.dom.dispatchEvent(event);
        return event.defaultPrevented;
    };
    /** 光标到 needle 所在段落的内容起点（用于断言「光标停留原地」）。 */
    const caretOffset = (needle) => {
        const { doc, selection } = editor.editor.state;
        const textBefore = doc.textBetween(1, selection.from, '\n');
        const idx = textBefore.lastIndexOf(needle);
        return idx;
    };
    /** 光标到 needle 文本末尾。 */
    const caretEndOfText = (needle) => {
        let target = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (target !== null) return false;
            if (node.isText && node.text === needle) target = pos + node.text.length;
            return true;
        });
        if (target === null) throw new Error(`caret target missed: ${needle}`);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(editor.editor.state.doc, target)));
    };
    /** 光标祖先链（自内向外），用于区分「空行落在哪一层」。 */
    const caretAncestry = () => {
        const { $from } = editor.editor.state.selection;
        const names = [];
        for (let d = $from.depth; d >= 1; d--) names.push($from.node(d).type.name);
        return names.join(' < ');
    };
    /**
     * 逐字符走真实输入管线（handleTextInput props），输入规则照常触发。
     * jsdom 没有按键合成文本的通路，这里直接调 PM 的 prop 与真机同管线；
     * 真实按键链路由浏览器回归覆盖。
     */
    const type = (text) => {
        const { from, to } = view.state.selection;
        let handled = false;
        view.someProp('handleTextInput', (f) => {
            handled = f(view, from, to, text, () => view.state.tr.insertText(text)) || handled;
        });
        if (!handled) view.dispatch(view.state.tr.insertText(text));
    };

    /* ---- 1. Tab / Shift-Tab 构建与退出嵌套 ---- */
    editor.setValue('- 甲\n- 乙', false);
    caretAtLineStart('乙');
    press('Tab');
    check('Tab sinks the item into a nested list', editor.getValue() === '- 甲\n  - 乙',
        { value: editor.getValue() });
    check('sink keeps a bulletList under the parent item',
        /listItem( > paragraph( > text)?)? > bulletList > listItem/.test(shape()),
        { shape: shape() });
    press('Tab', { shiftKey: true });
    check('Shift-Tab lifts the item back out', editor.getValue() === '- 甲\n- 乙',
        { value: editor.getValue() });

    editor.setValue('- [ ] 甲\n- [ ] 乙', false);
    caretAtLineStart('乙');
    press('Tab');
    check('Tab nests task items too', editor.getValue() === '- [ ] 甲\n  - [ ] 乙',
        { value: editor.getValue() });
    caretAtLineStart('乙');
    press('Tab', { shiftKey: true });
    check('Shift-Tab lifts task items back out', editor.getValue() === '- [ ] 甲\n- [ ] 乙',
        { value: editor.getValue() });

    editor.setValue('- 甲', false);
    caretAtLineStart('甲');
    // 光标先到行尾：行首回车会把空项拆到甲的上面
    view.dispatch(view.state.tr.setSelection(TextSelection.create(
        editor.editor.state.doc, editor.editor.state.selection.$to.end())));
    press('Enter');
    caretInEmptyItem();
    press('Tab');
    check('Tab on an empty second item nests it', editor.getValue() === '- 甲\n\n  - ',
        { value: editor.getValue() });

    /* ---- 2. Typora 退格语义 ---- */
    // 嵌套项行首退格 = lift 一层，光标停留原地
    editor.setValue('- 甲\n  - 乙\n- 丙', false);
    caretAtLineStart('乙');
    const offsetBefore = caretOffset('乙');
    press('Backspace');
    check('backspace at a nested item start lifts one level', editor.getValue() === '- 甲\n- 乙\n- 丙',
        { value: editor.getValue() });
    check('the caret stays on the lifted item', caretOffset('乙') === offsetBefore,
        { before: offsetBefore, after: caretOffset('乙') });
    // 再退 = 退出列表成段落
    press('Backspace');
    check('a second backspace leaves the list as a paragraph', editor.getValue() === '- 甲\n\n乙\n\n- 丙',
        { value: editor.getValue() });
    check('the caret still sits before the text after leaving the list',
        editor.editor.state.selection.$from.parent.textContent === '乙');

    // 顶层任务项行首退格 = 变段落
    editor.setValue('- [ ] 甲\n- [ ] 乙', false);
    caretAtLineStart('乙');
    press('Backspace');
    check('backspace at a top task item start turns it into a paragraph', editor.getValue() === '- [ ] 甲\n\n乙',
        { value: editor.getValue() });

    // 嵌套任务项行首退格 = lift
    editor.setValue('- [ ] 甲\n  - [ ] 乙', false);
    caretAtLineStart('乙');
    press('Backspace');
    check('backspace at a nested task item start lifts it', editor.getValue() === '- [ ] 甲\n- [ ] 乙',
        { value: editor.getValue() });

    // 空项退格 = 清除继承的标记，并入上一条目成为尾部空行（光标原地、缩进保留）。
    // 裸空行是 Markdown 表达不了的中间态，序列化时被丢弃（旧行为同样丢弃），
    // 所以这里断言内存文档结构与光标位置，不断言 getValue。
    editor.setValue('- 甲\n- ', false);
    caretInEmptyItem();
    press('Backspace');
    check('backspace on an empty item clears the marker, leaving a blank line inside the previous item',
        /listItem > paragraph( > text)? > paragraph( > paragraph)?$/.test(shape()),
        { shape: shape() });
    check('the caret stays in that blank line (not at line start, not at the previous item)',
        editor.editor.state.selection.$from.parent.type.name === 'paragraph'
        && editor.editor.state.selection.$from.parent.content.size === 0,
        null);
    // 再退 = 退出列表成顶层空段落（「回到最开头」，列 0）
    press('Backspace');
    check('a second backspace leaves the list as a top-level blank paragraph',
        /bulletList > listItem > paragraph( > text)? > paragraph > paragraph$/.test(shape()),
        { shape: shape() });
    check('the caret now sits in a top-level paragraph (column 0)',
        editor.editor.state.selection.$from.depth === 1
        && editor.editor.state.selection.$from.parent.type.name === 'paragraph',
        null);
    // 嵌套空条目（无前兄弟）退格 = 空行挪进父条目（降一级）
    editor.setValue('- 甲\n\n  - ', false);
    caretInEmptyItem();
    press('Backspace');
    check('backspace on a nested empty item moves the blank line into the parent item',
        /listItem > paragraph( > text)? > paragraph > paragraph$/.test(shape()),
        { shape: shape() });
    // 顶层首个空条目（无前兄弟）不接管：Tiptap lift = 退出列表
    editor.setValue('- ', false);
    caretInEmptyItem();
    press('Backspace');
    check('backspace on a lone top-level empty item still exits the list (default lift)',
        !shape().includes('bulletList'),
        { shape: shape() });
    editor.setValue('- 甲\n- ', false);
    caretInEmptyItem();
    press('Enter');
    check('enter on an empty item exits the list (trailing empty paragraph stays in the doc)',
        editor.getValue() === '- 甲' && /paragraph > paragraph$/.test(shape()),
        { value: editor.getValue(), shape: shape() });

    // 嵌套任务项行尾回车 = 同级新项（嵌套得以延续）
    editor.setValue('- [ ] 甲\n  - [ ] 乙', false);
    caretAtLineStart('乙');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(
        editor.editor.state.doc, editor.editor.state.selection.$to.end())));
    press('Enter');
    check('enter at a nested item end appends a nested sibling',
        editor.getValue() === '- [ ] 甲\n  - [ ] 乙\n  - [ ] ',
        { value: editor.getValue() });

    /* ---- 2.5 无 Tab 嵌套流（用户路径）：Enter → Backspace → 直接键入标记 ----
     * 手机上没有 Tab，嵌套全靠「退格清掉继承标记 → 尾部空行上键入 `- `/`[ ] `」。
     * 键入半边由官方输入规则在尾部空行（li 的 block* 段）上完成——首段落位置
     * findWrapping 永远失败（schema 要求 li 首孩子是段落），这正是修复前
     * 「列表项里键入 - 不转换」的根因。 */
    editor.setValue('1. 这是一个测试', false);
    caretEndOfText('这是一个测试');
    press('Enter');
    press('Backspace');
    check('no-tab flow: backspace clears the inherited ordered marker',
        caretAncestry() === 'paragraph < listItem < orderedList',
        { ancestry: caretAncestry() });
    type('-');
    type(' ');
    type('这是第二个测试');
    check('no-tab flow: typing "- " on the blank line nests a bullet item',
        editor.getValue() === '1. 这是一个测试\n   - 这是第二个测试',
        { value: editor.getValue() });
    caretEndOfText('这是第二个测试');
    press('Enter');
    press('Backspace');
    type('[');
    type(']');
    type(' ');
    type('这是待办');
    check('no-tab flow: typing "[ ] " nests a task item two levels deep',
        editor.getValue() === '1. 这是一个测试\n   - 这是第二个测试\n     - [ ] 这是待办',
        { value: editor.getValue() });
    const noTabSaved = editor.getValue();
    editor.setValue(noTabSaved, false);
    check('no-tab flow: the built document roundtrips byte-identical',
        editor.getValue() === noTabSaved
        && /bulletList > listItem > paragraph( > text)? > taskList > taskItem/.test(shape()),
        { value: editor.getValue(), shape: shape() });

    /* ---- 2.6 退格阶梯：从最内层逐级降一层，顶层末位退出列表（「回到最开头」） ---- */
    editor.setValue('1. 这是一个测试\n   - 这是第二个测试\n     - [ ] 这是待办', false);
    caretEndOfText('这是待办');
    press('Enter');
    press('Backspace');
    check('ladder 1: blank line sits inside the task item, caret stays in it',
        caretAncestry() === 'paragraph < taskItem < taskList < listItem < bulletList < listItem < orderedList',
        { ancestry: caretAncestry() });
    press('Backspace');
    check('ladder 2: backspace moves the blank line one level out (into the bullet item)',
        caretAncestry() === 'paragraph < listItem < bulletList < listItem < orderedList',
        { ancestry: caretAncestry() });
    press('Backspace');
    check('ladder 3: backspace moves it into the ordered item',
        caretAncestry() === 'paragraph < listItem < orderedList',
        { ancestry: caretAncestry() });
    press('Backspace');
    check('ladder 4: backspace exits the list to a top-level paragraph (column 0)',
        caretAncestry() === 'paragraph'
        && /^orderedList > listItem > paragraph( > text)? > bulletList/.test(shape()),
        { ancestry: caretAncestry(), shape: shape() });

    /* ---- 2.7 列表项首段落上的 `[ ] ` 就地转待办（防内核「逃逸到根」） ----
     * 逐键输入 `- [ ] ` 时，`- ` 先把空行转成子弹列表，随后的 `[ ] ` 落在新
     * 列表项的**第一个段落**上。内核 TaskItem 输入规则此时对首段落 wrap 因
     * schema（li 首孩子必须是段落）失败，回退到抬升重组，把项一路提到文档
     * 根——嵌套待办「渲染到最前面」、整条子弹列表被吞。DumbPadTaskItemInPlaceShortcut
     * 以 priority 101 先于内核规则接管「单条目列表」的就地转换。 */
    editor.setValue('1. 这是一个测试', false);
    caretEndOfText('这是一个测试');
    press('Enter');
    press('Backspace');
    type('-');
    type(' ');
    type('[');
    type(']');
    type(' ');
    check('in-place task conversion: nested taskList stays inside the ordered item (no escape to root)',
        /orderedList > listItem > paragraph( > text)? > taskList > taskItem > paragraph( > paragraph)?$/.test(shape()),
        { shape: shape() });
    check('in-place task conversion: caret sits inside the new task item',
        caretAncestry() === 'paragraph < taskItem < taskList < listItem < orderedList',
        { ancestry: caretAncestry() });
    type('这是待办');
    check('in-place task conversion: following text lands in the task item',
        editor.getValue() === '1. 这是一个测试\n   - [ ] 这是待办',
        { value: editor.getValue() });
    editor.setValue('1. 这是一个测试\n   - [ ] 这是待办', false);
    check('in-place task conversion: roundtrip byte-identical', editor.getValue() === '1. 这是一个测试\n   - [ ] 这是待办',
        { value: editor.getValue() });

    // 尾部空行路径（列表项的**非首**段落）仍由内核规则接管，正常嵌套
    editor.setValue('- [ ] 甲', false);
    caretEndOfText('甲');
    press('Enter');
    press('Backspace');
    type('[');
    type(']');
    type(' ');
    type('子任务');
    check('trailing-blank path still nests via the kernel rule',
        editor.getValue() === '- [ ] 甲\n  - [ ] 子任务',
        { value: editor.getValue() });

    // 多条目列表与顶层段落仍走内核语义（拆分 / 正常包裹），不被本规则劫持
    editor.setValue('- 甲\n- 乙', false);
    caretAtLineStart('乙');
    type('[');
    type(']');
    type(' ');
    check('multi-item list keeps the kernel split semantics',
        editor.getValue() === '- 甲\n\n- [ ] 乙',
        { value: editor.getValue() });
    editor.setValue('乙', false);
    caretAtLineStart('乙');
    type('[');
    type(']');
    type(' ');
    check('top-level paragraph path unchanged',
        editor.getValue() === '- [ ] 乙',
        { value: editor.getValue() });

    /* ---- 3. 空任务项解析补丁 ---- */
    const parseShape = (value) => {
        editor.setValue(value, false);
        return { shape: shape(), value: editor.getValue() };
    };
    let parsed = parseShape('- [ ] 甲\n- [ ] ');
    check('empty task item parses as a taskItem (not literal "[ ]" text)',
        /taskItem > paragraph/.test(parsed.shape) && !parsed.shape.includes('bulletList'),
        parsed);
    check('empty task item roundtrips byte-identical', parsed.value === '- [ ] 甲\n- [ ] ',
        { value: parsed.value });
    parsed = parseShape('- [x] 甲\n- [x] ');
    check('empty checked task item parses and roundtrips', parsed.value === '- [x] 甲\n- [x] '
        && /taskItem > paragraph/.test(parsed.shape), parsed);
    parsed = parseShape('- [ ] 甲\n  - [ ] ');
    check('nested empty task item parses as a nested taskList',
        /taskItem > paragraph( > text)? > taskList > taskItem/.test(parsed.shape) && parsed.value === '- [ ] 甲\n  - [ ] ',
        parsed);
    parsed = parseShape('- [ ]甲');
    check('"[ ]" glued to content stays a plain list item (spec requires the space)',
        /bulletList > listItem > paragraph( > text)? > paragraph/.test(parsed.shape) && !parsed.shape.includes('taskItem')
            && parsed.value === '- \\[ \\]甲',
        parsed);

    /* ---- 4. 空列表标记行解析补丁（旧存档形态恢复） ---- */
    parsed = parseShape('- 甲\n  - ');
    check('nested empty-only item parses as a nested list, not a setext heading',
        /listItem > paragraph( > text)? > bulletList > listItem/.test(parsed.shape)
        && !parsed.shape.includes('heading'),
        parsed);
    check('its roundtrip lands on the normalized form', parsed.value === '- 甲\n\n  - ',
        { value: parsed.value });
    parsed = parseShape('1. 甲\n    - ');
    check('ordered variant recovers too', /orderedList > listItem > paragraph( > text)? > bulletList > listItem/.test(parsed.shape),
        parsed);
    parsed = parseShape('甲\n- ');
    check('a paragraph followed by an empty list marker no longer becomes a setext heading',
        /^paragraph( > text)? > bulletList > listItem/.test(parsed.shape) && !parsed.shape.includes('heading'),
        parsed);
    parsed = parseShape('甲\n---');
    check('real setext underlines (--, ---) keep their heading', /heading/.test(parsed.shape),
        { shape: parsed.shape });
    parsed = parseShape('甲\n***');
    check('thematic breaks after a paragraph stay thematic breaks', /horizontalRule/.test(parsed.shape),
        { shape: parsed.shape });

    /* ---- 5. 打字流端到端：回车 + Tab 造出的空嵌套项，落盘再载入不丢 ---- */
    editor.setValue('- 甲', false);
    caretAtLineStart('甲');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(
        editor.editor.state.doc, editor.editor.state.selection.$to.end())));
    press('Enter');
    press('Tab');
    const saved = editor.getValue();
    check('typing flow serializes the nested empty item with a blank line', saved === '- 甲\n\n  - ',
        { value: saved });
    editor.setValue(saved, false);
    check('the saved form reloads to the same document', editor.getValue() === saved
        && /listItem > paragraph( > text)? > bulletList > listItem/.test(shape()),
        { value: editor.getValue(), shape: shape() });

    /* ---- 6. normalizeAmbiguousEmptyListMarkers 纯函数 ---- */
    check('no-op when the previous line is blank', normalizeAmbiguousEmptyListMarkers('- 甲\n\n  - ') === '- 甲\n\n  - ');
    check('no-op for same-indent siblings', normalizeAmbiguousEmptyListMarkers('- 甲\n  - 乙\n  - ') === '- 甲\n  - 乙\n  - ');
    check('no-op without a deeper indent', normalizeAmbiguousEmptyListMarkers('- 甲\n- ') === '- 甲\n- ');
    check('inserts before a deeper empty marker',
        normalizeAmbiguousEmptyListMarkers('- 甲\n  - ') === '- 甲\n\n  - ');
    check('idempotent', normalizeAmbiguousEmptyListMarkers('- 甲\n\n  - ') === normalizeAmbiguousEmptyListMarkers(
        normalizeAmbiguousEmptyListMarkers('- 甲\n\n  - ')));
    check('skips fenced code', normalizeAmbiguousEmptyListMarkers('```\n- 甲\n  - \n```') === '```\n- 甲\n  - \n```');
    check('skips frontmatter', normalizeAmbiguousEmptyListMarkers('---\ntags:\n  - \n---\n正文') === '---\ntags:\n  - \n---\n正文');
    check('skips math blocks', normalizeAmbiguousEmptyListMarkers('$$\n- 甲\n  - \n$$') === '$$\n- 甲\n  - \n$$');
    check('continues after a fence closes', normalizeAmbiguousEmptyListMarkers('```\n```\n- 甲\n  - ') === '```\n```\n- 甲\n\n  - ');

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
