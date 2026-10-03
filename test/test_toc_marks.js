/**
 * 目录标记条目收集（managers/heading-index.js 的 collectTocMarkEntries）单测：
 * 分组、preamble 合并、嵌套去重、加粗不进目录。核心回归点是 warm 启动路径的
 * 根因之一——扫描时标题还没有 data-heading-id（HeadingAnchor 的 Decoration 存在
 * 异步窗口），全部标记落进 __preamble__，合并目标组必须就地补建而不是静默丢弃。
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
    const { collectTocMarkEntries } = await import('../public/managers/heading-index.js');
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
        const groups = collectTocMarkEntries(TOC, buildRoot(true));
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
        const groups = collectTocMarkEntries(TOC, buildRoot(false));
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
        const groups = collectTocMarkEntries(TOC, root);
        check('nested descendants of an accepted element are skipped',
            (groups.get('sec-one') || []).length === 1,
            { count: groups.get('sec-one')?.length });
    }

    // 4. 边界：无根节点 / 无目录 → 空 Map
    {
        check('empty toc yields an empty map', collectTocMarkEntries([], buildRoot(true)).size === 0);
        check('missing root yields an empty map', collectTocMarkEntries(TOC, null).size === 0);
    }

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
