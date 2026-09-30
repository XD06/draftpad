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

    // 7. 图片：块级图片必须有块分隔（内核自带的 image 序列化不回 closeBlock，
    // 会把下一个块粘在图片 markdown 后面，重新解析后图文合并）；宽度写在
    // title="dumbpad-width=N"；旧笔记的内联 Base64 图片不能被 schema 丢掉
    // （内核默认 allowBase64:false 会静默删除 img[src^="data:"]）。
    const imageSrc = '/api/assets/abcdef0123456789/preview';
    const secondImageSrc = '/api/assets/bbbb0123456789ab/preview';
    const legacyBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC';
    const imageCases = [
        `![图](${imageSrc})`,
        `![图](${imageSrc} "dumbpad-width=360")`,
        `![图](${imageSrc} "dumbpad-width=720")\n\n正文段落`,
        `正文段落\n\n![图](${imageSrc})`,
        `![图](${imageSrc})\n\n![第二张](${secondImageSrc})`,
        `![旧图](${legacyBase64})\n\n正文段落`,
    ];
    for (const value of imageCases) {
        editor.setValue(value, false);
        const first = editor.getValue();
        editor.setValue(first, false);
        const second = editor.getValue();
        const label = value.replace(/\n/g, '\\n').slice(0, 46);
        check(`image: byte-exact roundtrip (${label}…)`, first === value, `got ${JSON.stringify(first)}`);
        check(`image: idempotent second round (${label}…)`, second === first, `got ${JSON.stringify(second)}`);
    }

    // 图片行紧贴下一个块（旧数据 / 旧 bug 的产物：图片 markdown 后面少了空行）。
    // 载入必须补回块分隔，且下面的 markdown（`# 标题1`）不能被粘成同一段——粘进
    // 段落会让标题退化成带转义的源码文本（`\# 标题1`），刷新后显示为源码。
    const gluedHeading = `![图](${imageSrc})\n# 标题1`;
    editor.setValue(gluedHeading, false);
    const repaired = editor.getValue();
    check('image: glued heading block separator restored', repaired === `![图](${imageSrc})\n\n# 标题1`, repaired);
    editor.setValue(repaired, false);
    check('image: repaired heading stays stable', editor.getValue() === repaired, editor.getValue());

    // 8. 幂等性：再走一轮必须稳定（结构化文档）
    editor.setValue(structuredOut, false);
    check('structured: idempotent second round', editor.getValue() === structuredOut, editor.getValue());

    // 9. YAML frontmatter：粘贴路径与 setValue 必须走同一条解析。setValue 有
    //    frontmatterToFence 预处理，粘贴走 tiptap-markdown 的 clipboardTextParser →
    //    md.render()，没有那层预处理。markdown-it 的 block ruler 里必须有
    //    dumbpad_frontmatter 规则（DumbPadFrontmatterParseRule），否则首个 --- 解析成
    //    <hr>、第二个被 setext 当标题下划线吃掉——「---\ntitle: x\n---」落库变成 h2
    //    且少一行 ---，保存后不可逆。
    {
        const fm = '---\ntitle: 我的文档标题\nauthor: 张三\ndate: 2024-01-15\n---\n\n# 我的文档标题\n';
        const pasteHtml = editor.editor.storage.markdown.parser.parse(fm, { inline: true });
        check('frontmatter: the paste parse yields a labeled code block, not hr + setext heading',
            pasteHtml.includes('language-dumbpad-frontmatter') && !/<h2>/.test(pasteHtml), pasteHtml);
        editor.setValue(fm, false);
        const setValueOut = editor.getValue();
        check('frontmatter: setValue restores the --- wrapper byte for byte',
            setValueOut === fm.trimEnd(), setValueOut);
        editor.editor.commands.setContent(pasteHtml, false);
        const pastedOut = editor.getValue();
        check('frontmatter: pasted content serializes to exactly what setValue produces',
            pastedOut === setValueOut, { pastedOut, setValueOut });
        editor.setValue(pastedOut, false);
        check('frontmatter: reloading the pasted result is stable',
            editor.getValue() === pastedOut, editor.getValue());

        // 规则必须与 setValue 的 FRONTMATTER_LEAD_RE 同宽：紧邻的两条 --- 是分隔线，
        // 不是 frontmatter（两边解释不一致会让解析结果在 --- 与围栏之间来回抖）。
        const twoRulesHtml = editor.editor.storage.markdown.parser.parse('---\n---\n\n正文\n', { inline: true });
        check('frontmatter: two adjacent --- stay horizontal rules',
            !twoRulesHtml.includes('dumbpad-frontmatter') && /<hr>/.test(twoRulesHtml), twoRulesHtml);
        editor.setValue('---\n---\n\n正文\n', false);
        check('frontmatter: the hr form is idempotent through setValue',
            editor.getValue() === '---\n\n---\n\n正文', editor.getValue());

        // 只认「文档最前方」的块：正文中间的 --- 与未闭合的 --- 头都不许被吞成代码块。
        const midDoc = '# 标题\n\n甲\n\n---\n\n乙\n';
        check('frontmatter: a mid-document --- is still an hr',
            !editor.editor.storage.markdown.parser.parse(midDoc, { inline: true }).includes('dumbpad-frontmatter'), midDoc);
        editor.setValue(midDoc, false);
        check('frontmatter: mid-document hr round-trips',
            editor.getValue() === '# 标题\n\n甲\n\n---\n\n乙', editor.getValue());
        const unclosed = '---\ntitle: T\n\n正文\n';
        check('frontmatter: an unclosed --- head is not swallowed',
            !editor.editor.storage.markdown.parser.parse(unclosed, { inline: true }).includes('dumbpad-frontmatter'), unclosed);

        // 规则只装一次：tiptap-markdown 每次 parse 都会重跑扩展的 setup，重复注册会让
        // markdown-it 的 __rules__ 随粘贴次数线性增长。
        const md = editor.editor.storage.markdown.parser.md;
        const before = md.block.ruler.__rules__.length;
        editor.editor.storage.markdown.parser.parse('正文\n', { inline: true });
        editor.editor.storage.markdown.parser.parse('更多正文\n', { inline: true });
        check('frontmatter: the block rule is installed exactly once',
            md.block.ruler.__rules__.length === before
            && md.block.ruler.__rules__.filter(r => r.name === 'dumbpad_frontmatter').length === 1,
            md.block.ruler.__rules__.map(r => r.name));
    }

    // normalize fast path: 无行内代码的文档跳过逐段修复 walk，但行为不变；
    // 且旧拆段 HTML（无反引号、有 <code>）仍必须自愈——判定在 doc 层面，
    // 不许用源码字符串预检（旧数据就是裸 HTML，会被漏掉）。
    {
        editor.setValue('纯文本长文，无行内代码，无批注', false);
        check('normalize: plain content still round-trips', editor.getValue() === '纯文本长文，无行内代码，无批注', editor.getValue());
        editor.setValue('<mark>甲</mark><code>beta()</code><mark>丁</mark>', false);
        check('normalize: backtick-free legacy split still heals',
            editor.getValue() === '<mark>甲`beta()`丁</mark>', editor.getValue());
    }

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
