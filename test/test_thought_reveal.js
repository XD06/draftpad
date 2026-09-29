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

    const { ThoughtsManager } = await import('../public/managers/thoughts.js');

    // Object.create skips the constructor: the harness wires only the state
    // the reveal path touches, everything else stays the real class code.
    function createHarness({ thoughts = [], serverThoughts = {}, initialRendered = 0 } = {}) {
        const manager = Object.create(ThoughtsManager.prototype);
        manager.isActive = false;
        manager.thoughts = thoughts;
        manager.activeTag = '';
        manager.searchInput = { value: '' };
        manager.dateFilter = { value: '' };
        manager.statusFilter = { dataset: { value: 'all' }, querySelector: () => null };
        manager.timeline = document.createElement('div');
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
                return serverThoughts[id] || null;
            }
        };
        // Minimal render with the real semantics that matter here: reset the
        // timeline, then render the first batch of the filtered list.
        manager.render = function () {
            this.timeline.innerHTML = '';
            this._renderedCount = 0;
            this._renderBatch(this.getFilteredThoughts(), this.searchInput.value.toLowerCase());
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
            // 服务端过滤后的结果回填：这里用注入的 thoughts 模拟"清除筛选后"的新列表。
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

    console.log('Thought reveal checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
