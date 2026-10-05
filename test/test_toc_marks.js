/**
 * 目录区段子条目收集（managers/heading-index.js 的 collectTocSectionEntries）单测：
 * 分组、preamble 合并、嵌套去重、加粗不进目录、顶层列表条目收录。核心回归点是
 * warm 启动路径的根因之一——扫描时标题还没有 data-heading-id（HeadingAnchor 的
 * Decoration 存在异步窗口），全部标记落进 __preamble__，合并目标组必须就地补建
 * 而不是静默丢弃。
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
    const { collectTocSectionEntries } = await import('../public/managers/heading-index.js');
    const TOC = [{ id: 'sec-one' }, { id: 'sec-two' }];

    const buildRoot = (withHeadingIds) => {
        const root = document.createElement('div');
        root.innerHTML = [
            `<p>前言<mark class="md-mark">高亮前言</mark></p>`,
            `<h2${withHeadingIds ? ' id="sec-one" data-heading-id="sec-one"' : ''}>第一节</h2>`,
            `<p><span data-note="批注" style="text-decoration:underline wavy #e74c3c;">被批注<b>加粗不进</b></span><span data-draw style="text-decoration:underline blue;">划线</span></p>`,
            `<h2${withHeadingIds ? ' id="sec-two" data-heading-id="sec-two"' : ''}>第二节</h2>`,
            `<p><mark class="md-mark">第二节高亮</mark></p>`,
        ].join('');
        return root;
    };

    // 1. 标题 id 就位时的常规分组
    {
        const groups = collectTocSectionEntries(TOC, buildRoot(true));
        check('groups follow heading ids', (groups.get('sec-one') || []).length === 3
            && (groups.get('sec-two') || []).length === 1,
            { one: groups.get('sec-one')?.length, two: groups.get('sec-two')?.length });
        check('preamble merged into the first heading',
            (groups.get('sec-one') || [])[0]?.type === 'highlight'
            && (groups.get('sec-one') || [])[0]?.snippet === '高亮前言');
        check('no preamble key leaks', !groups.has('__preamble__'));
        check('bold text creates no standalone entry (nested text inside an accepted span is fine)',
            (groups.get('sec-one') || []).length === 3
            && (groups.get('sec-one') || []).every(entry => entry.el.tagName !== 'B'),
            { entries: (groups.get('sec-one') || []).map(entry => `${entry.el.tagName}:${entry.snippet}`) });
    }

    // 2. 标题 id 缺失（Decoration 异步窗口）：全部标记必须并入第一个标题，不得丢弃
    {
        const groups = collectTocSectionEntries(TOC, buildRoot(false));
        const total = (groups.get('sec-one') || []).length + (groups.get('sec-two') || []).length;
        check('marks survive the missing-heading-id window (fix for warm-path TOC loss)', total === 4,
            { total, keys: Array.from(groups.keys()) });
        check('all marks land under the first heading when ids are missing',
            (groups.get('sec-one') || []).length === 4 && (groups.get('sec-two') || []).length === 0,
            { one: groups.get('sec-one')?.length, two: groups.get('sec-two')?.length });
    }

    // 3. 嵌套去重：已收录元素的嵌套后代不重复出现
    {
        const root = document.createElement('div');
        root.innerHTML = `<h2 id="sec-one" data-heading-id="sec-one">标题</h2>`
            + `<p><span data-note="外层"><mark class="md-mark">内层</mark></span></p>`;
        const groups = collectTocSectionEntries(TOC, root);
        check('nested descendants of an accepted element are skipped',
            (groups.get('sec-one') || []).length === 1,
            { count: groups.get('sec-one')?.length });
    }

    // 4. 边界：无根节点 / 无目录 → 空 Map（无标题的纯清单文章目录维持「暂无标题
    //    目录」空态是刻意现状：列表条目同样不收集，避免再造一套无锚点的目录形态）
    {
        check('empty toc yields an empty map', collectTocSectionEntries([], buildRoot(true)).size === 0);
        check('missing root yields an empty map', collectTocSectionEntries(TOC, null).size === 0);
    }

    // 5. 顶层列表条目：无序/有序/待办收录；嵌套 li、引用块内列表、空条目不收。
    //    片段取「自身文字」（剔除嵌套列表与 taskItem 的 label），标记与列表按
    //    文档序混排，li 内标记仍各自成条（不进列表的嵌套去重集）。
    {
        const root = document.createElement('div');
        root.innerHTML = `<h2 id="sec-one" data-heading-id="sec-one">标题</h2>`
            + `<ul><li>甲<ul><li>嵌套不收</li></ul></li><li> </li></ul>`
            + `<ol start="3"><li>第三步</li><li value="7">显式序号</li></ol>`
            + `<blockquote><ul><li>引用块不收</li></ul></blockquote>`
            + `<ul data-type="taskList">`
            + `<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked=""><span></span></label><div><p>已完成 任务</p><ul><li>子列表文字不进片段</li></ul></div></li>`
            + `<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>带 <mark class="md-mark">内嵌高亮</mark> 的待办</p></div></li>`
            + `</ul>`;
        const entries = collectTocSectionEntries(TOC, root).get('sec-one') || [];
        const lists = entries.filter(entry => entry.kind === 'list');
        check('top-level bullet/ordered/task items collected; nested li, blockquote list and empty li skipped',
            lists.length === 5, { count: lists.length, kinds: entries.map(e => `${e.kind}:${e.snippet}`) });
        check('badge and typeLabel per list type (task reflects checked state)',
            lists[0].listType === 'bullet' && lists[0].badge === '•' && lists[0].typeLabel === '无序项'
            && lists[3].listType === 'task' && lists[3].badge === '✓' && lists[3].typeLabel === '待办'
            && lists[4].listType === 'task' && lists[4].badge === '•',
            { badges: lists.map(l => `${l.listType}:${l.badge}:${l.typeLabel}`) });
        check('ordered badge follows ol start and li value',
            lists[1].listType === 'ordered' && lists[1].badge === '3'
            && lists[2].listType === 'ordered' && lists[2].badge === '7',
            { ordinals: lists.map(l => l.badge) });
        check("list snippet is the item's own text (nested list text and checkbox label excluded)",
            lists[0].snippet === '甲' && lists[3].snippet === '已完成 任务',
            { snippets: lists.map(l => l.snippet) });
        check('marks and lists interleave in document order; mark inside a collected li still forms its own entry',
            entries.length === 6 && entries[0].kind === 'list'
            && entries[5].kind === 'mark' && entries[5].snippet === '内嵌高亮',
            { stream: entries.map(e => `${e.kind}:${e.snippet}`) });
    }

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
