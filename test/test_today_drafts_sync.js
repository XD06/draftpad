const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function run() {
    const dom = new JSDOM(`<!DOCTYPE html>
<html>
<body>
    <div id="today-drafts-view">
        <button id="today-drafts-toggle"></button>
        <span id="today-drafts-eyebrow"></span>
        <div id="today-drafts-writing-area">
            <div id="today-drafts-base">
                <ol id="today-drafts-list"></ol>
                <form id="today-drafts-form">
                    <textarea id="today-drafts-input"></textarea>
                </form>
            </div>
        </div>
    </div>
</body>
</html>`, { url: 'http://localhost/' });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.navigator = dom.window.navigator;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Event = dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.CompositionEvent = dom.window.CompositionEvent;
    globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
    globalThis.cancelAnimationFrame = id => clearTimeout(id);
    if (!dom.window.CSS?.escape) {
        globalThis.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`) };
    } else {
        globalThis.CSS = dom.window.CSS;
    }

    const { TodayDraftsManager } = await import('../public/managers/today-drafts/today-drafts-manager.js');

    const store = {
        load: () => ({ day: localDayKey(), items: [] }),
        save: () => {}
    };
    let outboxItems = [{
        id: 'outbox-1',
        kind: 'upsert',
        draftId: 'draft-1',
        draft: { id: 'draft-1', text: '离线草稿', completed: false, version: 0, updatedAt: 1 },
        attempts: 0
    }];
    let failing = true;
    const outbox = {
        load: () => outboxItems,
        enqueueUpsert: () => {},
        enqueueDelete: () => {},
        hasPending: () => false,
        retry: async () => {
            if (!failing) {
                outboxItems = [];
                return { saved: [], remaining: [] };
            }
            outboxItems = outboxItems.map(item => ({ ...item, attempts: Number(item.attempts || 0) + 1 }));
            return { saved: [], remaining: outboxItems };
        }
    };
    const apiClient = {
        list: async () => ({ day: localDayKey(), items: [] })
    };

    const manager = new TodayDraftsManager({
        store,
        outbox,
        apiClient,
        syncRetryBaseMs: 20,
        syncRetryMaxMs: 40
    });

    // 全败的一轮必须自己安排下一轮：outbox.retry 吞掉每一项的网络错误（失败进
    // remaining 而非抛出），旧实现里 manager 的失败分支对此不可达，队列要搁浅到
    // 下一次按键 / ws 重连 / 切页才有人管。修复后退避翻倍并封顶。
    await manager.retryOutbox();
    assert.strictEqual(outboxItems.length, 1, 'a fully failed round keeps the queued edit in the outbox');
    assert(manager.syncTimer, 'a fully failed sync round must schedule its own follow-up retry');
    assert.strictEqual(manager.syncBackoffMs, 40, 'backoff doubles after a fully failed round');
    await manager.retryOutbox();
    assert.strictEqual(manager.syncBackoffMs, 40, 'backoff is capped at syncRetryMaxMs');

    // 队列清空后退避复位；挂起的计时器随后触发一次空轮自然停链，进程可退出。
    failing = false;
    await manager.retryOutbox();
    assert.strictEqual(outboxItems.length, 0, 'a succeeding round clears the queue');
    assert.strictEqual(manager.syncBackoffMs, 20, 'backoff resets once the queue drains');
    await new Promise(resolve => setTimeout(resolve, 120));

    console.log('Today drafts sync retry backoff checks passed');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
