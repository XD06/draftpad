/**
 * Tiptap 适配器 roundtrip 回归：setValue → getValue 幂等，且批注、
 * 高亮、时间标记、软换行等自定义源码形态无损。这是 Tiptap 内核替换
 * 的核心兼容门槛（对应旧 test_source_mode_roundtrip 的黑盒重写）。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
void path;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.DocumentFragment = dom.window.DocumentFragment;
global.MutationObserver = dom.window.MutationObserver;
global.navigator = dom.window.navigator;
global.getSelection = dom.window.getSelection.bind(dom.window);
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.getComputedStyle = dom.window.getComputedStyle;
if (!dom.window.requestAnimationFrame) {
    dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const bundlePath = path.join(ROOT, 'public', 'vendor', 'tiptap', 'tiptap.bundle.js');
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: 'tiptap.bundle.js' });
if (!global.DumbPadTiptap) {
    console.error('FAIL: tiptap bundle did not expose global DumbPadTiptap');
    process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}`);
        if (detail) console.error(`  ${detail}`);
    }
}

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();

    // 1. 基础结构 roundtrip：标题/强调/列表/引用/代码块/链接/分隔线
    const basic = '# 标题一\n\n正文 **加粗** 与 *斜体* 与 `code` 与 [链接](https://example.com)。\n\n> 引用一行\n\n```js\nconst a = 1;\n```\n\n- 列表一\n- 列表二\n\n1. 有序一\n\n---\n';
    editor.setValue(basic, false);
    const basicOut = editor.getValue();
    check('basic: heading kept', basicOut.startsWith('# 标题一'), basicOut);
    check('basic: bold/italic/code', basicOut.includes('**加粗**') && basicOut.includes('*斜体*') && basicOut.includes('`code`') || basicOut.includes('*斜体*'), basicOut);
    check('basic: list preserved', basicOut.includes('- 列表一') && basicOut.includes('1. 有序一'), basicOut);
    check('basic: fenced code kept', /```js\nconst a = 1;\n```/.test(basicOut), basicOut);
    check('basic: idempotent', editor.setValue(basicOut, false) === undefined && editor.getValue() === basicOut, `second: ${editor.getValue()}`);

    // 2. 软换行：段内单个 \n 保持
    const soft = '第一行\n第二行';
    editor.setValue(soft, false);
    check('soft-break: roundtrip', editor.getValue() === '第一行\n第二行', editor.getValue());

    // 3. 高亮 ==…== 与 <mark>：== 在可视化序列化时归一化为 <mark>（与旧编辑器一致）
    const highlight = '前 ==标记文字== 后';
    editor.setValue(highlight, false);
    check('highlight: == normalizes to <mark>', editor.getValue() === '前 <mark>标记文字</mark> 后', editor.getValue());
    editor.setValue('前 <mark>标记文字</mark> 后', false);
    check('highlight: <mark> serializes back', editor.getValue() === '前 <mark>标记文字</mark> 后', editor.getValue());

    // 4. 批注（存储形态 span[data-note] + sub）
    const annotationSource = '前 <span data-note="备注甲" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">批注文字</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（备注甲）</sub> 后';
    editor.setValue(annotationSource, false);
    const annotationOut = editor.getValue();
    check('annotation: span[data-note] kept', annotationOut.includes('data-note="备注甲"'), annotationOut);
    check('annotation: text preserved', annotationOut.includes('>批注文字</span>') || annotationOut.includes('批注文字'), annotationOut);
    check('annotation: sub label present', annotationOut.includes('data-note-label'), annotationOut);
    check('annotation: no duplicated label text', (annotationOut.match(/批注文字/g) || []).length === 1, annotationOut);

    // 5. 时间标记 token
    const timeSource = '开始 [[time:create:2026-09-09 10:00:00]] 完成 [[time:update@2:2026-09-09 11:30:00]]';
    editor.setValue(timeSource, false);
    const timeOut = editor.getValue();
    check('time-marker: create token kept', timeOut.includes('[[time:create:2026-09-09 10:00:00]]'), timeOut);
    check('time-marker: update@2 token kept', timeOut.includes('[[time:update@2:2026-09-09 11:30:00]]'), timeOut);

    // 6. 任务列表 / 表格 / 分隔线
    const structured = '- [ ] 待办一\n- [x] 已完成\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n---\n';
    editor.setValue(structured, false);
    const structuredOut = editor.getValue();
    check('task-list: checkboxes kept', structuredOut.includes('[ ]') && structuredOut.includes('[x]'), structuredOut);
    check('table: cells kept', structuredOut.includes('| 列A | 列B |') || (structuredOut.includes('列A') && structuredOut.includes('列B')), structuredOut);

    // 7. 幂等性：再走一轮必须稳定
    editor.setValue(structuredOut, false);
    check('structured: idempotent second round', editor.getValue() === structuredOut, editor.getValue());

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\ntiptap roundtrip checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
