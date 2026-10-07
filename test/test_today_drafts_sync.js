const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function dayOffset(offset) {
    const shifted = new Date();
    shifted.setDate(shifted.getDate() + offset);
    return localDayKey(shifted);
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

    // 过期草稿不得经合并/重试复活：本地独有但已滑出窗口的不再上传，
    // 远端里已滑出本地窗口的不收，队列里过期 day 的 upsert 直接丢弃
    // （否则服务端把窗口外新建盖章成今天，旧文本就在昨天/今天复活）。
    const enqueued = [];
    const prunableQueue = [
        { id: 'q-expired', kind: 'upsert', draftId: 'expired-local', draft: { id: 'expired-local', text: '四天前的旧草稿', day: dayOffset(-5), version: 1, updatedAt: 1 }, attempts: 0 },
        { id: 'q-yesterday', kind: 'upsert', draftId: 'yesterday-local', draft: { id: 'yesterday-local', text: '昨天的草稿', day: dayOffset(-1), version: 0, updatedAt: 2 }, attempts: 0 }
    ];
    const mergeOutbox = {
        load: () => prunableQueue.slice(),
        save: next => {
            prunableQueue.length = 0;
            prunableQueue.push(...next);
        },
        enqueueUpsert: draft => enqueued.push(draft.id),
        enqueueDelete: () => {},
        hasPending: () => false,
        retry: async () => ({ saved: [], remaining: [] })
    };
    const mergeManager = new TodayDraftsManager({
        store: { load: () => ({ day: localDayKey(), items: [] }), save: () => {} },
        outbox: mergeOutbox,
        apiClient,
        syncRetryBaseMs: 20,
        syncRetryMaxMs: 40
    });
    mergeManager.items = [
        { id: 'expired-local', text: '四天前的旧草稿', completed: false, day: dayOffset(-5), version: 1, createdAt: 1, updatedAt: 1 },
        { id: 'yesterday-local', text: '昨天的草稿', completed: false, day: dayOffset(-1), version: 0, createdAt: 2, updatedAt: 2 }
    ];
    mergeManager.mergeRemoteItems([
        { id: 'ancient-remote', text: '别处的旧草稿', completed: false, day: dayOffset(-9), version: 1, createdAt: 0, updatedAt: 0 },
        { id: 'remote-today', text: '今天的远端草稿', completed: false, day: dayOffset(0), version: 1, createdAt: 3, updatedAt: 3 }
    ]);
    const mergedIds = mergeManager.items.map(item => item.id);
    assert(!mergedIds.includes('expired-local'), 'a local-only draft past the window must be dropped, never re-uploaded');
    assert(!mergedIds.includes('ancient-remote'), 'a remote draft past the local window must not be adopted');
    assert(mergedIds.includes('yesterday-local') && mergedIds.includes('remote-today'), 'in-window drafts still merge both ways');
    assert.deepStrictEqual(enqueued, ['yesterday-local'], 'only the in-window local-only draft may be queued for upload');
    assert.deepStrictEqual(prunableQueue.map(item => item.draftId), ['yesterday-local'], 'a queued upsert with a retired day must be discarded, not replayed');
    assert.strictEqual(mergeManager.isRetiredDraftDay(dayOffset(-3)), true, 'the day before the 3-day window is retired');
    assert.strictEqual(mergeManager.isRetiredDraftDay(dayOffset(-2)), false, 'the oldest day inside the window is kept');
    assert.strictEqual(mergeManager.isRetiredDraftDay(dayOffset(1)), false, 'an ahead-clock tomorrow is tolerated, not retired');
    assert.strictEqual(mergeManager.isRetiredDraftDay('not-a-day'), false, 'a missing or malformed day never counts as retired');

    console.log('Today drafts sync retry backoff checks passed');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
