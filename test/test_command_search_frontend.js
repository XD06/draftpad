const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
        <div id="command-palette-overlay" class="command-palette-overlay">
            <div class="command-palette">
                <input type="text" id="command-input" class="command-input">
                <div id="command-results" class="command-results"></div>
            </div>
        </div>
    </body></html>`);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    dom.window.Element.prototype.scrollIntoView = function () {};

    const { createCommandSearchManager } = await import('../public/managers/command-search/command-search-manager.js');
    const { registerResultType, getResultType } = await import('../public/managers/command-search/result-type-registry.js');

    const overlay = document.getElementById('command-palette-overlay');
    const input = document.getElementById('command-input');
    const results = document.getElementById('command-results');

    const jumps = { notepad: [], thought: [], todayDraft: [] };
    registerResultType('notepad', {
        label: '文章',
        badgeClass: 'badge-notepad',
        jump: (result, ctx) => jumps.notepad.push([result.id, ctx.query, ctx.hitIndex || 0])
    });
    registerResultType('thought', {
        label: 'Thought',
        badgeClass: 'badge-thought',
        jump: result => jumps.thought.push([result.id])
    });
    registerResultType('today_draft', {
        label: '今日草稿',
        badgeClass: 'badge-today-draft',
        jump: result => jumps.todayDraft.push([result.id])
    });
    assert.strictEqual(getResultType('mystery').label, '其他', 'unknown types degrade to the generic badge');
    assert.strictEqual(getResultType('mystery').jump, null, 'unknown types have no jump target');

    let nextResponse = { results: [], keywords: [] };
    const fetchCalls = [];
    const manager = createCommandSearchManager({
        fetchJson: async url => {
            fetchCalls.push(url);
            return { json: async () => nextResponse };
        },
        getCurrentNotepadId: () => 'note-1',
        isCurrentArticleVisible: () => true
    });
    manager.init();

    async function type(query) {
        input.value = query;
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        await sleep(320);
    }

    // Ctrl+F 与 Ctrl+K 都打开全局面板（用户决策：一键一搜索，不分视图）
    for (const [key, label] of [['f', 'Ctrl+F'], ['k', 'Ctrl+K']]) {
        const event = new dom.window.KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true });
        dom.window.dispatchEvent(event);
        assert(event.defaultPrevented, `${label} should preventDefault`);
        assert(overlay.classList.contains('active'), `${label} should open the palette`);
        manager.close();
    }

    manager.open();
    assert(document.activeElement === input, 'open should focus the input');

    nextResponse = {
        keywords: ['部署', '笔记'],
        results: [
            {
                id: 'note-1',
                type: 'notepad',
                title: '工作手册',
                snippet: '...',
                matchType: 'content',
                matches: [],
                matchCount: 3,
                coLineCount: 1,
                occurrencesTruncated: false,
                occurrences: [
                    { line: 0, lineText: '# 部署手册', context: null, matchCount: 1, distinctKeywords: 1, hitIndex: 0, section: '部署手册', block: { type: 'heading', level: 1 } },
                    { line: 1, lineText: '写部署笔记', context: null, matchCount: 1, distinctKeywords: 2, hitIndex: 1, section: '安装', block: { type: 'text' } },
                    { line: 4, lineText: '- [ ] 部署 笔记 汇总', context: null, matchCount: 2, distinctKeywords: 2, hitIndex: 2, section: '进阶', block: { type: 'todo' } }
                ],
                updatedAt: 3
            },
            {
                id: 'note-2',
                type: 'notepad',
                title: '旧笔记',
                snippet: '...部署记录...',
                matchType: 'content',
                matches: [],
                matchCount: 1,
                occurrences: [],
                updatedAt: 2
            },
            {
                id: 'th-1',
                type: 'thought',
                title: '部署想法',
                snippet: '...部署...',
                matchType: 'content',
                matches: [],
                matchCount: 2,
                occurrences: [],
                updatedAt: 1
            },
            {
                id: 'draft-1',
                type: 'today_draft',
                day: '2026-09-28',
                title: '买苹果',
                snippet: '',
                matchType: 'title',
                matches: [],
                matchCount: 1,
                occurrences: [],
                updatedAt: 1
            }
        ]
    };
    await type('部署 笔记');

    assert.strictEqual(fetchCalls.length, 1, 'debounced search should issue one fetch');
    assert(fetchCalls[0].includes(encodeURIComponent('部署 笔记')), 'query should be URL-encoded');

    const headers = [...results.querySelectorAll('.command-group-header')].map(el => el.textContent);
    assert.deepStrictEqual(headers, ['当前文章 · 3 处匹配', '文章', 'Thought', '今日草稿'], 'current article pins to the top, then domain groups in server order');

    const matchItems = [...results.querySelectorAll('.command-item-match')];
    assert.strictEqual(matchItems.length, 3, 'all current article occurrences expand into individual entries');
    assert(!matchItems[0].querySelector('.command-item-badge'), 'match rows carry no domain badge — the group header owns the identity');
    assert(!matchItems[0].querySelector('.command-item-section'), 'section prefix hidden when it duplicates the line (heading hit)');
    assert(!matchItems[0].querySelector('.command-item-line').textContent.includes('#'), 'markdown decoration is stripped from the line text');
    assert.strictEqual(matchItems[0].querySelector('.command-item-line').textContent, '部署手册');
    assert.strictEqual(matchItems[0].querySelector('.command-item-blockbadge')?.textContent, 'H1', 'heading hits carry a ToC-style level badge');
    assert.strictEqual(matchItems[1].querySelector('.command-item-section')?.textContent, '安装', 'section shows in the head row for body hits');
    assert(!matchItems[1].querySelector('.command-item-blockbadge'), 'plain text lines carry no block badge');
    assert.strictEqual(matchItems[2].querySelector('.command-item-blockbadge')?.textContent, '待办', 'todo marker yields the todo badge');
    assert(matchItems[0].querySelector('.command-item-line').innerHTML.includes('<mark class="command-search-highlight">部署</mark>'), 'keywords are highlighted');
    assert.strictEqual(matchItems[2].querySelectorAll('.command-search-highlight').length, 2, 'both keywords highlight on the same line');
    assert(!matchItems[2].querySelector('.command-item-line').textContent.includes('- '), 'todo markers are stripped');
    assert.strictEqual(matchItems[0].querySelector('.command-item-ordinal')?.textContent, '1/3');

    const docItems = [...results.querySelectorAll('.command-item')].filter(el => !el.classList.contains('command-item-match'));
    const thoughtItem = docItems.find(el => el.querySelector('.badge-thought'));
    assert(thoughtItem, 'thought entries carry the Thought badge');
    assert.strictEqual(thoughtItem.querySelector('.command-item-count')?.textContent, '2 处', 'multi-match documents show a count chip');
    const draftItem = docItems.find(el => el.querySelector('.badge-today-draft'));
    assert(draftItem, 'today draft entries carry the draft badge');
    assert(!draftItem.querySelector('.command-item-count'), 'single matches stay clean without a count chip');
    assert(!draftItem.querySelector('.command-item-snippet'), 'title-only matches do not render a snippet');

    // 点击当前文章条目：按全局命中序号精确跳转，并关闭面板（毛玻璃下跳转不可见）
    matchItems[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(jumps.notepad.at(-1), ['note-1', '部署 笔记', 1], 'match click jumps with keywords and the hit index');
    assert(!overlay.classList.contains('active'), 'palette closes after a match jump so the article is visible');

    // 点击其他文档条目：走注册表跳转并关闭面板
    manager.open();
    await type('部署 笔记');
    const thoughtItem2 = [...results.querySelectorAll('.command-item')].find(el => el.querySelector('.badge-thought'));
    thoughtItem2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(jumps.thought.at(-1), ['th-1'], 'thought doc click routes through the registry');
    assert(!overlay.classList.contains('active'), 'palette closes after jumping to another document');

    // 键盘：↓ 移动选择、Enter 激活
    manager.open();
    await type('部署 笔记');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.deepStrictEqual(jumps.thought.at(-1), ['th-1'], 'ArrowDown + Enter activates the focused entry');

    // occurrencesTruncated 时折叠为"进入文章查看"
    nextResponse = {
        keywords: ['词'],
        results: [{
            id: 'note-1',
            type: 'notepad',
            title: '大文章',
            snippet: 'x',
            matchType: 'content',
            matches: [],
            matchCount: 60,
            occurrencesTruncated: true,
            occurrences: Array.from({ length: 50 }, (_, i) => ({
                line: i, lineText: `词${i}行`, context: null, matchCount: 1, distinctKeywords: 1, hitIndex: i, section: null, block: { type: 'text' }
            })),
            updatedAt: 1
        }]
    };
    manager.open();
    await type('词');
    assert.strictEqual(results.querySelectorAll('.command-item-match').length, 50, 'all server occurrences render (no client cap)');
    const moreItem = results.querySelector('.command-item-more');
    assert(moreItem, 'server-side truncation collapses into a "more" entry');
    moreItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(jumps.notepad.at(-1), ['note-1', '词', 0], 'more entry opens the article at the first hit');

    // 跳转关闭面板后重开：恢复上次查询、结果与选中项（行走匹配的工作流）
    manager.open();
    assert.strictEqual(input.value, '词', 'reopen restores the last query');
    assert(results.textContent.includes('1/50'), 'reopen restores the cached results without a new fetch');
    assert.strictEqual(fetchCalls.length, 4, 'restore must not trigger a new search');

    // 未知类型：显示"其他"徽标，激活不抛错
    nextResponse = {
        keywords: ['x'],
        results: [{ id: 'future-1', type: 'reflection', title: '未来模块', snippet: '', matchType: 'title', matches: [], matchCount: 1, occurrences: [], updatedAt: 1 }]
    };
    manager.open();
    await type('x');
    const futureItem = [...results.querySelectorAll('.command-item')].find(el => el.querySelector('.badge-other'));
    assert(futureItem, 'unknown types render with the fallback badge');
    futureItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert(!overlay.classList.contains('active'), 'unknown-type activation still closes the palette gracefully');

    // 过期响应保护：慢的旧响应不得覆盖新结果
    let resolveSlow;
    const manager2 = createCommandSearchManager({
        fetchJson: url => new Promise(resolve => {
            if (url.includes('first')) resolveSlow = resolve;
            else resolve({ json: async () => ({ results: [{ id: 'fast', type: 'notepad', title: 'fast', matchType: 'title', matches: [], matchCount: 1, occurrences: [], updatedAt: 1 }], keywords: ['fast'] }) });
        }),
        getCurrentNotepadId: () => null,
        isCurrentArticleVisible: () => false
    });
    manager2.init();
    const input2 = document.getElementById('command-input');
    const results2 = document.getElementById('command-results');
    manager2.open();
    input2.value = 'first query';
    input2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(320); // 第一次请求已发出、挂起中
    input2.value = 'fast';
    input2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(320);
    assert(results2.textContent.includes('fast'), 'the fresh response should win');
    resolveSlow({ json: async () => ({ results: [{ id: 'slow', type: 'notepad', title: 'slow', matchType: 'title', matches: [], matchCount: 1, occurrences: [], updatedAt: 1 }], keywords: ['first'] }) });
    await sleep(20);
    assert(results2.textContent.includes('fast'), 'the fresh response should still win');
    assert(!results2.textContent.includes('slow'), 'the stale response should be dropped');

    console.log('Command search frontend checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
