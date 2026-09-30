const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

function localDayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function run() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    if (!dom.window.CSS?.escape) {
        globalThis.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`) };
    } else {
        globalThis.CSS = dom.window.CSS;
    }
    dom.window.Element.prototype.scrollIntoView = function () {};

    const { TodayDraftsManager } = await import('../public/managers/today-drafts/today-drafts-manager.js');

    const today = localDayKey(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = localDayKey(yesterdayDate);

    // Object.create skips the constructor: only the reveal path's state.
    function createHarness({ items = [], viewDay = today, pagesByDay = {} } = {}) {
        const manager = Object.create(TodayDraftsManager.prototype);
        manager.items = items;
        manager.viewDay = viewDay;
        manager.viewPageIndex = 0;
        manager.pagesByDay = pagesByDay;
        manager.pageList = [];
        manager.base = document.createElement('div');
        manager.renderCalls = 0;
        manager.refreshCalls = 0;
        manager.render = function () {
            this.renderCalls += 1;
            this.base.innerHTML = '';
            const dayItems = this.items.filter(item => (item.day || today) === this.viewDay);
            const page = (this.pagesByDay[this.viewDay] || [])[this.viewPageIndex];
            // 与真实 render 同轨：一屏只铺当前页的行，量不到页模型时才铺整天。
            const rows = page ? page.indexes.map(index => dayItems[index]) : dayItems;
            rows.filter(Boolean).forEach(item => {
                const row = document.createElement('div');
                row.className = 'today-draft-row';
                row.dataset.todayDraftId = item.id;
                row.textContent = item.text;
                this.base.appendChild(row);
            });
        };
        manager.refreshWindowDrafts = async function () {
            this.refreshCalls += 1;
            this.items = this.refreshSource || this.items;
            this.render();
        };
        manager.render();
        return manager;
    }

    // 1. 今天的草稿：原地闪烁定位
    {
        const manager = createHarness({ items: [{ id: 'd1', text: '买苹果', day: today }] });
        const ok = await manager.revealDraftById('d1');
        assert.ok(ok, 'today draft reveals in place');
        const row = manager.base.querySelector('[data-today-draft-id="d1"]');
        assert.ok(row, 'row stays in the DOM');
        assert.ok(row.classList.contains('reveal-focus'), 'row gets the flash class');
        assert.strictEqual(manager.renderCalls, 1, 'no re-render for the same day');
        assert.strictEqual(manager.refreshCalls, 0, 'no refetch when the item is local');
    }

    // 2. 历史日草稿：翻到对应日期再定位
    {
        const manager = createHarness({
            items: [
                { id: 'd1', text: '今天的事', day: today },
                { id: 'd2', text: '昨天的事', day: yesterday }
            ]
        });
        const ok = await manager.revealDraftById('d2');
        assert.ok(ok, 'history draft reveals');
        assert.strictEqual(manager.viewDay, yesterday, 'pager switched to the draft day');
        assert.strictEqual(manager.renderCalls, 2, 'day switch triggers one re-render');
        assert.ok(manager.base.querySelector('[data-today-draft-id="d2"]'), 'target row visible after the switch');
    }

    // 3. 仅远端存在的草稿：先刷新窗口再定位
    {
        const manager = createHarness({ items: [] });
        manager.refreshSource = [{ id: 'remote', text: '远端草稿', day: today }];
        const ok = await manager.revealDraftById('remote');
        assert.ok(ok, 'remote-only draft reveals after refresh');
        assert.strictEqual(manager.refreshCalls, 1);
        assert.ok(manager.base.querySelector('[data-today-draft-id="remote"]'));
    }

    // 4. 草稿已不存在：响亮失败
    {
        const manager = createHarness({ items: [{ id: 'd1', text: '买苹果', day: today }] });
        await assert.rejects(() => manager.revealDraftById('ghost'), /已不存在/, 'missing drafts fail loudly');
    }

    // 5. 同一天写满超过一张纸：先落到它所在的那一页，再原地闪光定位
    {
        const manager = createHarness({
            items: [{ id: 'a', text: '第一条', day: today }, { id: 'b', text: '溢出的一条', day: today }],
            pagesByDay: {
                [today]: [
                    { index: 0, pageCount: 2, indexes: [0] },
                    { index: 1, pageCount: 2, indexes: [1] }
                ]
            }
        });
        const ok = await manager.revealDraftById('b');
        assert.ok(ok, 'an overflow draft reveals');
        assert.strictEqual(manager.viewDay, today, 'same day, no day switch');
        assert.strictEqual(manager.viewPageIndex, 1, 'pager opened the sheet that holds the draft');
        assert.strictEqual(manager.renderCalls, 2, 'one render to open the other sheet');
        assert.ok(manager.base.querySelector('[data-today-draft-id="b"]'), 'target row rendered on the opened sheet');
    }

    // 6. 历史日 + 非首页：跨日与跨页两步都要落到位
    {
        const manager = createHarness({
            items: [
                { id: 't', text: '今天的事', day: today },
                { id: 'h1', text: '昨天的第一页', day: yesterday },
                { id: 'h2', text: '昨天的第二页', day: yesterday }
            ],
            pagesByDay: {
                [yesterday]: [
                    { index: 0, pageCount: 2, indexes: [0] },
                    { index: 1, pageCount: 2, indexes: [1] }
                ]
            }
        });
        const ok = await manager.revealDraftById('h2');
        assert.ok(ok);
        assert.strictEqual(manager.viewDay, yesterday, 'pager switched to the draft day');
        assert.strictEqual(manager.viewPageIndex, 1, 'and onto the sheet that holds it');
        assert.strictEqual(manager.renderCalls, 3, 'one render for the day switch, one for the page switch');
    }

    console.log('Today drafts reveal checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
