const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

async function run() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.NodeFilter = dom.window.NodeFilter;
    if (!dom.window.CSS?.escape) {
        globalThis.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`) };
    } else {
        globalThis.CSS = dom.window.CSS;
    }
    dom.window.Element.prototype.scrollIntoView = function () {};
    // scheduleRender 用 rAF 合帧；jsdom 默认没有（只有 pretendToBeVisual 才有）。
    // 这里给一个 no-op：本文件断言的是跳转路径，不需要真的跑帧。
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};

    const { ThoughtsManager } = await import('../public/managers/thoughts.js');

    // Object.create skips the constructor: the harness wires only the state
    // the reveal path touches, everything else stays the real class code.
    function createHarness({ thoughts = [], serverThoughts = {}, serverPage = null, initialRendered = 0 } = {}) {
        const manager = Object.create(ThoughtsManager.prototype);
        manager.isActive = false;
        manager.thoughts = thoughts;
        manager.revealedThoughts = new Map();
        manager._revealFocus = null;
        manager.openRelationsPanelIds = new Set();
        manager.openAIStatusPanelIds = new Set();
        manager.activeTag = '';
        manager.searchInput = { value: '' };
        manager.dateFilter = { value: '' };
        manager.statusFilter = { dataset: { value: 'all' }, querySelector: () => null };
        manager.timeline = document.createElement('div');
        document.body.appendChild(manager.timeline);
        manager._renderedCount = 0;
        manager._renderBatchSize = 2;
        manager._hasMoreThoughts = true;
        manager.fetchCalls = [];
        manager.app = {
            navigateWorkspace: async workspace => {
                assert.strictEqual(workspace, 'thoughts', 'reveal should navigate to the thoughts workspace');
                manager.isActive = true;
            }
        };
        manager.apiClient = {
            get: async id => {
                manager.fetchCalls.push(id);
                if (typeof manager.getImpl === 'function') return manager.getImpl(id);
                return serverThoughts[id] || null;
            }
        };
        // Minimal render with the real semantics that matter here: reset the
        // timeline, then render the first batch of the filtered list. The
        // landing re-assert hook mirrors the real render() wiring.
        manager.render = function () {
            this.timeline.innerHTML = '';
            this._renderedCount = 0;
            this._renderBatch(this.getFilteredThoughts(), this.searchInput.value.toLowerCase());
            this.reassertRevealFocus();
        };
        manager._renderBatch = function (filtered, query) {
            const start = this._renderedCount;
            const end = Math.min(start + this._renderBatchSize, filtered.length);
            for (let index = start; index < end; index += 1) {
                const card = document.createElement('div');
                card.className = 'thought-card';
                card.dataset.id = filtered[index].id;
                const body = document.createElement('div');
                body.className = 'thought-text';
                body.textContent = filtered[index].text;
                card.appendChild(body);
                this.timeline.appendChild(card);
            }
            this._renderedCount = end;
        };
        manager.fetchThoughts = async function () {
            this.fetchCalls.push('fetchThoughts');
            // 服务端过滤后的结果回填：`serverPage` 模拟刷新后服务端返回的首页，
            // 未提供时沿用注入的 thoughts（即“清除筛选后”的新列表）。
            if (Array.isArray(serverPage)) {
                this.thoughts = this.mergeRevealedThoughts(serverPage);
            }
            this.render();
        };
        if (initialRendered > 0) {
            manager._renderBatch(manager.getFilteredThoughts(), '');
        }
        return manager;
    }

    const thought = (id, text, createdAt = 1000) => ({ id, text, subItems: [], tags: [], createdAt, updatedAt: createdAt });

    // 1. 目标已在 DOM：原地定位 + 临时关键词高亮
    {
        const manager = createHarness({ thoughts: [thought('a', '第一条想法'), thought('b', '第二条部署相关想法')] });
        manager.isActive = true;
        manager._renderBatch(manager.getFilteredThoughts(), '');
        const ok = await manager.revealThoughtById('b', { keyword: '部署' });
        assert.ok(ok, 'in-DOM reveal returns true');
        const card = manager.timeline.querySelector('[data-id="b"]');
        assert.ok(card, 'target card stays in place');
        assert.ok(card.classList.contains('relation-focus'), 'card gets the focus flash class');
        const mark = card.querySelector('mark.thought-highlight-transient');
        assert.ok(mark, 'keyword gets a transient highlight mark');
        assert.strictEqual(mark.textContent, '部署');
        manager.removeTransientKeywordHighlight(mark);
        assert.ok(!card.querySelector('mark'), 'transient highlight unwraps cleanly');
        assert.strictEqual(card.querySelector('.thought-text').textContent, '第二条部署相关想法');
    }

    // 1b. 多关键词：所有关键词的全部命中处都被临时高亮，滚动锚点是文档顺序第一个
    {
        const manager = createHarness({
            thoughts: [thought('c', '部署相关的想法，部署要快')]
        });
        manager.isActive = true;
        manager._renderBatch(manager.getFilteredThoughts(), '');
        const ok = await manager.revealThoughtById('c', { keywords: ['部署', '想法'] });
        assert.ok(ok, 'multi-keyword reveal returns true');
        const card = manager.timeline.querySelector('[data-id="c"]');
        const marks = [...card.querySelectorAll('mark.thought-highlight-transient')];
        assert.strictEqual(marks.length, 3, 'every keyword hit gets a mark (部署×2 + 想法×1)');
        assert.deepStrictEqual(marks.map(m => m.textContent), ['部署', '想法', '部署'], 'marks stay in document order');
        assert.ok(marks[0].textContent === '部署', 'first mark is the scroll anchor');
        marks.forEach(mark => manager.removeTransientKeywordHighlight(mark));
        assert.strictEqual(card.querySelector('.thought-text').textContent, '部署相关的想法，部署要快', 'all marks unwrap cleanly');
    }

    // 2. 目标在内存但未渲染（第 2 批之后）：循环渲染批次直到可见
    {
        // createdAt 递减让 timeline 排序与书写顺序一致（新→旧）。
        const many = Array.from({ length: 7 }, (_, i) => thought(`t${i}`, `想法 ${i}`, 1000 - i));
        const manager = createHarness({ thoughts: many });
        manager.isActive = true;
        manager._renderBatch(manager.getFilteredThoughts(), '');
        assert.strictEqual(manager.timeline.querySelectorAll('.thought-card').length, 2, 'only the first batch renders initially');
        const ok = await manager.revealThoughtById('t5');
        assert.ok(ok, 'unrendered in-memory reveal returns true');
        assert.ok(manager.timeline.querySelector('[data-id="t5"]'), 'target batch got rendered');
        assert.strictEqual(manager._renderedCount, 6, 'rendering stops right after the target');
    }

    // 3. 目标在未拉取的分页上：按 id 拉取并插入头部渲染
    {
        const manager = createHarness({
            thoughts: [thought('a', '本地想法')],
            serverThoughts: { remote: thought('remote', '远端分页里的部署想法') }
        });
        manager.isActive = true;
        const ok = await manager.revealThoughtById('remote');
        assert.ok(ok, 'fetch-by-id reveal returns true');
        assert.deepStrictEqual(manager.fetchCalls, ['remote']);
        assert.strictEqual(manager.thoughts[0].id, 'remote', 'fetched thought is kept locally at the top');
        assert.ok(manager.timeline.querySelector('[data-id="remote"]'), 'fetched thought is rendered');
    }

    // 3b. 按 id 也拉不到：响亮失败
    {
        const manager = createHarness({ thoughts: [thought('a', '本地想法')], serverThoughts: {} });
        manager.isActive = true;
        await assert.rejects(
            () => manager.revealThoughtById('ghost'),
            /已不存在/,
            'a thought that is gone anywhere must fail loudly'
        );
    }

    // 4. 目标被当前筛选隐藏：先清筛选再定位
    {
        const manager = createHarness({ thoughts: [thought('a', '部署想法')] });
        manager.isActive = true;
        manager.searchInput.value = '一个把目标滤掉的词';
        manager.statusFilter.dataset.value = 'all';
        const fetchSpy = manager.fetchThoughts;
        const ok = await manager.revealThoughtById('a', { keyword: '部署' });
        assert.ok(ok, 'filtered reveal returns true');
        assert.deepStrictEqual(manager.fetchCalls, ['fetchThoughts'], 'filters cleared trigger one refetch');
        assert.strictEqual(manager.searchInput.value, '', 'text filter cleared');
        assert.strictEqual(manager.activeTag, '', 'tag filter cleared');
        assert.strictEqual(manager.statusFilter.dataset.value, 'all', 'status filter reset');
    }

    // 5. 视图未激活：先导航到 thoughts 工作区
    {
        const manager = createHarness({ thoughts: [thought('a', '部署想法')] });
        let navigated = false;
        manager.app.navigateWorkspace = async () => {
            navigated = true;
            manager.isActive = true;
        };
        await manager.revealThoughtById('a');
        assert.ok(navigated, 'inactive view triggers workspace navigation first');
    }

    // 6. focusThoughtCard 无关键词时只闪烁不高亮
    {
        const manager = createHarness({ thoughts: [thought('a', '普通想法')] });
        manager.isActive = true;
        manager._renderBatch(manager.getFilteredThoughts(), '');
        const card = manager.timeline.querySelector('[data-id="a"]');
        manager.focusThoughtCard(card, '');
        assert.ok(card.classList.contains('relation-focus'));
        assert.ok(!card.querySelector('mark'), 'no keyword means no highlight mark');
    }

    // 7. 跳转目标必须在后台刷新后仍然存在
    //    回归：旧实现把按 id 取回的 Thought 一次性塞进 this.thoughts，任何
    //    一次列表刷新（socket 推送 / ws_connected / 翻页重取）都会整体替换
    //    数组，卡片在跳转后一两秒内凭空消失——用户看到的就是“跳到了界面但
    //    没跳到条目”。
    {
        const manager = createHarness({
            thoughts: [thought('a', '本地想法')],
            serverThoughts: { remote: thought('remote', '远端分页里的部署想法') },
            serverPage: [thought('a', '本地想法')]
        });
        manager.isActive = true;
        const ok = await manager.revealThoughtById('remote');
        assert.ok(ok, 'fetch-by-id reveal returns true');
        assert.ok(manager.timeline.querySelector('[data-id="remote"]'), 'fetched thought is rendered');

        await manager.fetchThoughts(); // 模拟 socket 推送触发的列表刷新
        assert.ok(
            manager.getFilteredThoughts().some(item => item.id === 'remote'),
            'a background refresh must keep the jumped-to thought in the list'
        );
        assert.ok(
            manager.timeline.querySelector('[data-id="remote"]'),
            'a background refresh must keep the jumped-to card rendered'
        );
        assert.ok(manager.revealedThoughts.has('remote'), 'the target stays pinned for the session');
    }

    // 8. 后台重渲染后落点必须回到 DOM 并重新高亮
    //    重渲染只画第一批（_renderBatchSize 条），目标常常在后面的批次里：
    //    只保留在内存里不够，必须把目标批次补渲染出来再挂高亮。
    {
        const manager = createHarness({
            thoughts: [thought('a', '本地想法', 1000)],
            serverThoughts: { remote: thought('remote', '远端分页里的部署想法', 500) },
            serverPage: [
                thought('a', '本地想法', 1000),
                thought('b', '想法 B', 900),
                thought('c', '想法 C', 800),
                thought('d', '想法 D', 700),
                thought('e', '想法 E', 600)
            ]
        });
        manager.isActive = true;
        await manager.revealThoughtById('remote', { keywords: ['部署'] });
        const firstCard = manager.timeline.querySelector('[data-id="remote"]');
        assert.ok(firstCard.classList.contains('relation-focus'), 'landing flashes on arrival');

        manager.render(); // 后台推送触发的整表重建：只画第一批
        assert.strictEqual(manager.timeline.querySelectorAll('.thought-card').length, 2, 'only the first batch is painted');
        const rebuilt = manager.timeline.querySelector('[data-id="remote"]');
        assert.ok(rebuilt, 'the target batch is pulled back into the DOM');
        assert.notStrictEqual(rebuilt, firstCard, 'render rebuilt the card element');
        assert.ok(rebuilt.classList.contains('relation-focus'), 'the rebuilt card re-flashes');
        assert.ok(rebuilt.querySelector('mark.thought-highlight-transient'), 'keyword highlight is re-applied');
    }

    // 9. 单次请求失败（WAN 抖动 / 502）重试一次，不能误报“已不存在”
    {
        const manager = createHarness({ thoughts: [thought('a', '本地想法')] });
        manager.isActive = true;
        let attempts = 0;
        manager.getImpl = async () => {
            attempts += 1;
            if (attempts === 1) throw Object.assign(new Error('HTTP 502'), { status: 502 });
            return thought('remote', '重试后拿到的想法');
        };
        const ok = await manager.revealThoughtById('remote');
        assert.ok(ok, 'a transient failure is retried instead of reported as missing');
        assert.strictEqual(attempts, 2, 'exactly one retry');
        assert.ok(manager.timeline.querySelector('[data-id="remote"]'));
    }

    // 9b. 404 是权威结论：不重试，直接“已不存在”
    {
        const manager = createHarness({ thoughts: [thought('a', '本地想法')] });
        manager.isActive = true;
        let attempts = 0;
        manager.getImpl = async () => {
            attempts += 1;
            throw Object.assign(new Error('HTTP 404'), { status: 404 });
        };
        await assert.rejects(() => manager.revealThoughtById('ghost'), /已不存在/);
        assert.strictEqual(attempts, 1, '404 is authoritative, no retry');
    }

    // 9c. 连续两次失败 → 明确报“加载失败”，而不是“不存在”
    {
        const manager = createHarness({ thoughts: [thought('a', '本地想法')] });
        manager.isActive = true;
        manager.getImpl = async () => {
            throw new Error('network down');
        };
        await assert.rejects(() => manager.revealThoughtById('remote'), /加载失败/);
    }

    // 10. 搜索框只有空白时不能把整表过滤空（getFilteredThoughts 与
    //     hasActiveListFilters 的归一化必须一致，否则目标会被判成“不在列表里”）
    {
        const manager = createHarness({ thoughts: [thought('a', '部署想法')] });
        manager.isActive = true;
        manager.searchInput.value = '   ';
        assert.strictEqual(manager.hasActiveListFilters(), false, 'whitespace is not an active filter');
        assert.deepStrictEqual(
            manager.getFilteredThoughts().map(item => item.id),
            ['a'],
            'whitespace must not filter the timeline empty'
        );
        const ok = await manager.revealThoughtById('a');
        assert.ok(ok, 'whitespace-only query still lands on the target');
    }

    // 11. 目标被删除后不能靠“钉住”复活
    {
        const manager = createHarness({
            thoughts: [thought('a', '本地想法')],
            serverThoughts: { remote: thought('remote', '远端想法') },
            serverPage: [thought('a', '本地想法')]
        });
        manager.isActive = true;
        await manager.revealThoughtById('remote');
        assert.ok(manager.revealedThoughts.has('remote'));
        manager.handleSocketUpdate('delete', { id: 'remote' });
        assert.strictEqual(manager.revealedThoughts.has('remote'), false, 'delete forgets the pin');
        await manager.fetchThoughts();
        assert.ok(
            !manager.timeline.querySelector('[data-id="remote"]'),
            'a deleted thought must not be re-injected by the next refresh'
        );
    }

    // 12. 接线断言：刷新路径必须重新合并钉住的目标，render 必须重挂落点
    {
        const fs = require('fs');
        const source = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
        assert.ok(
            /this\.thoughts = this\.mergeRevealedThoughts\(this\.mergeOutboxThoughts\(this\.mergeThoughtDetails\(items\)\)\)/.test(source),
            'fetchThoughts must re-merge revealed thoughts'
        );
        assert.ok(
            /this\.thoughts = this\.mergeRevealedThoughts\(this\.mergeOutboxThoughts\(\[/.test(source),
            'loadNextThoughtPage must re-merge revealed thoughts'
        );
        assert.ok(
            /this\.restoreOpenPanelsAfterRender\(\);\s*\n\s*this\.reassertRevealFocus\(\);/.test(source),
            'render must re-assert the landing focus'
        );
    }

    // 13. 命中在子任务 / 标签里也要高亮（搜索索引覆盖这三处，跳转不能只在正文标）
    //     并且落在「折叠后隐藏的额外子任务」里的命中要把卡片展开，否则用户只看到
    //     卡片闪一下、看不到命中文字。
    {
        const manager = createHarness({ thoughts: [thought('a', '本地想法')] });
        manager.isActive = true;
        manager.expandedThoughtIds = new Set();
        const card = document.createElement('div');
        card.className = 'thought-card can-expand';
        card.dataset.id = 'a';
        card.innerHTML = `
            <div class="thought-text">正文没有这个词</div>
            <div class="subtask-list">
                <div class="subtask"><span class="subtask-text">第一条</span></div>
                <div class="subtask"><span class="subtask-text">第二条</span></div>
                <div class="subtask subtask-extra"><span class="subtask-text">子任务里的部署细节</span></div>
            </div>
            <div class="thought-tags"><button class="thought-tag">#部署</button></div>`;
        manager.timeline.appendChild(card);
        manager.focusThoughtCard(card, ['部署']);
        const marks = [...card.querySelectorAll('mark.thought-highlight-transient')];
        assert.deepStrictEqual(marks.map(mark => mark.textContent), ['部署', '部署'], 'subtask and tag hits are both marked');
        assert.ok(card.classList.contains('expanded'), 'a hit inside a hidden extra subtask expands the card');
        assert.ok(card.classList.contains('relation-focus'), 'the card still flashes');
        assert.ok(manager.expandedThoughtIds.has('a'), 'the expanded state is tracked for the next render');
    }

    // 14. 关键词互相嵌套（一个词是另一个词的子串）时高亮不能抛异常
    //     回归：旧实现用 Range.surroundContents 逐个包，包完第一段后节点被
    //     切短，下一个区间的 setEnd 越界抛出，整个 focusThoughtCard 被打断
    //     ——卡片不滚动、不闪，异常冒到搜索的 catch 里弹「未能定位该 Thought」。
    {
        const manager = createHarness({ thoughts: [thought('a', '置顶条目 2 置顶词2')] });
        manager.isActive = true;
        manager._renderBatch(manager.getFilteredThoughts(), '');
        const card = manager.timeline.querySelector('[data-id="a"]');
        manager.focusThoughtCard(card, ['置顶条目', '2', '置顶词2']);
        const marks = [...card.querySelectorAll('mark.thought-highlight-transient')];
        assert.deepStrictEqual(
            marks.map(mark => mark.textContent),
            ['置顶条目', '2', '置顶词2'],
            'nested keywords merge into non-overlapping marks'
        );
        assert.strictEqual(card.querySelector('.thought-text').textContent, '置顶条目 2 置顶词2', 'text is unchanged');
        assert.ok(card.classList.contains('relation-focus'), 'the landing flash still applies');
    }

    // 15. 渐进首屏调度器：不足一页时不得空转，分片不得越过首页
    //     回归：旧实现只以 `_renderedCount >= 30` 终止，列表只有 2 条时每帧都会
    //     重新排一次 rAF（`_renderBatch` 无进展），等于常驻一个每帧重建 load-more
    //     与重挂落点的循环。
    {
        const manager = createHarness({ thoughts: [thought('a', '一'), thought('b', '二')] });
        manager._renderBatchSize = 30;
        manager._renderSeq = 1;
        manager._renderedCount = 2;
        manager._lastFilteredIds = ['a', 'b'];
        const originalRaf = globalThis.requestAnimationFrame;
        let frames = 0;
        globalThis.requestAnimationFrame = callback => { frames += 1; callback(); return frames; };
        try {
            manager._scheduleRestOfFirstPage(1, false);
        } finally {
            globalThis.requestAnimationFrame = originalRaf;
        }
        assert.strictEqual(frames, 0, 'a list shorter than one page must not schedule fill frames');
    }
    {
        const many = Array.from({ length: 45 }, (_, index) => thought(`m${index}`, `想法 ${index}`, 1000 - index));
        const manager = createHarness({ thoughts: many });
        manager._renderBatchSize = 30;
        manager._renderSeq = 1;
        manager._renderedCount = 8;
        manager._lastFilteredIds = many.map(item => item.id);
        const chunks = [];
        manager._renderBatch = function (filtered, query, batchSize = this._renderBatchSize) {
            chunks.push(batchSize);
            this._renderedCount = Math.min(this._renderedCount + batchSize, filtered.length);
        };
        const originalRaf = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = callback => { callback(); return 1; };
        try {
            manager._scheduleRestOfFirstPage(1, false);
        } finally {
            globalThis.requestAnimationFrame = originalRaf;
        }
        assert.deepStrictEqual(chunks, [10, 10, 2], 'fill chunks stop exactly at the first page');
        assert.strictEqual(manager._renderedCount, 30, 'the fill never renders past the first page');
    }

    // 16. 视图未激活时，按 id 拉取与工作区激活并发（不再串行等首页）
    {
        const manager = createHarness({ thoughts: [], serverThoughts: {} });
        const order = [];
        manager.app.navigateWorkspace = async () => {
            order.push('navigate:start');
            await new Promise(resolve => setTimeout(resolve, 15));
            manager.isActive = true;
            order.push('navigate:end');
        };
        manager.getImpl = async id => {
            order.push('get:start');
            await new Promise(resolve => setTimeout(resolve, 15));
            order.push('get:end');
            return thought(id, '并发拉取的想法');
        };
        const ok = await manager.revealThoughtById('remote');
        assert.ok(ok, 'concurrent prefetch still lands on the target');
        assert.ok(
            order.indexOf('get:start') < order.indexOf('navigate:end'),
            'the by-id fetch must start before activation finishes'
        );
        assert.ok(manager.timeline.querySelector('[data-id="remote"]'), 'the prefetched card is rendered');
    }

    console.log('Thought reveal checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
