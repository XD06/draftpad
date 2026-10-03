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

    const storage = new Map();
    const fakeStore = {
        load: () => ({ day: localDayKey(), items: JSON.parse(storage.get('items') || '[]') }),
        save: ({ items }) => storage.set('items', JSON.stringify(items))
    };
    const fakeOutbox = {
        load: () => [],
        enqueueUpsert: () => {},
        enqueueDelete: () => {},
        retry: async () => ({ saved: [], failed: [] }),
        hasPending: () => false
    };
    const fakeApi = {
        list: async () => ({ day: localDayKey(), items: [] })
    };

    const initialItems = [
        { id: 'draft-1', text: '草稿一行内容', completed: false, day: localDayKey(), createdAt: Date.now() - 1000 },
        { id: 'draft-2', text: '第二页草稿，长文本内容'.repeat(10), completed: false, day: localDayKey(), createdAt: Date.now() }
    ];
    fakeStore.save({ items: initialItems });

    const manager = new TodayDraftsManager({
        store: fakeStore,
        outbox: fakeOutbox,
        apiClient: fakeApi,
        base: dom.window.document.getElementById('today-drafts-base'),
        list: dom.window.document.getElementById('today-drafts-list'),
        form: dom.window.document.getElementById('today-drafts-form'),
        input: dom.window.document.getElementById('today-drafts-input'),
        writingArea: dom.window.document.getElementById('today-drafts-writing-area'),
        eyebrow: dom.window.document.getElementById('today-drafts-eyebrow'),
        toggleButton: dom.window.document.getElementById('today-drafts-toggle')
    });

    // 1. Initial render should show items in display mode
    const row2 = manager.list.querySelector('[data-today-draft-id="draft-2"]');
    assert(row2, 'draft-2 should be rendered in the list');
    const display2 = row2.querySelector('[data-today-draft-text-display]');
    assert(display2, 'draft-2 should render with text display span');

    // 2. Begin editing draft-2
    display2.click();
    const textarea = row2.querySelector('[data-today-draft-text]');
    assert(textarea, 'clicking display should create textarea editor');
    assert.strictEqual(dom.window.document.activeElement, textarea, 'textarea should be focused');
    assert.strictEqual(manager.hasActiveDraftInput(), true, 'hasActiveDraftInput should be true when textarea has focus');

    // 3. User types into textarea -> update queued, pending sync
    textarea.value += ' 新增文字';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // 4. Background render() while editing must NOT destroy textarea or lose focus
    manager.render();
    assert.strictEqual(manager.pendingRender, true, 'background render while editing should be deferred to pendingRender');
    const currentTextarea = row2.querySelector('[data-today-draft-text]');
    assert(currentTextarea, 'textarea must still be present in the DOM');
    assert.strictEqual(dom.window.document.activeElement, currentTextarea, 'focus must remain on the textarea');

    // 5. Compositionend must NOT call render() or destroy textarea
    textarea.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    assert.strictEqual(manager.isComposingDraft, true, 'isComposingDraft should be true');
    textarea.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    assert.strictEqual(manager.isComposingDraft, false, 'isComposingDraft should be false');
    assert(row2.querySelector('[data-today-draft-text]'), 'compositionend must not wipe textarea');

    // 6. Real blur (focusout) must NOT rebuild the list inside the event itself:
    // focusout is triggered by mousedown, the pointer sequence is still in flight,
    // and a synchronous teardown swaps the element under mouseup — the click is
    // lost (checkbox toggles stopped working this way). Cleanup is deferred to
    // its own task.
    textarea.blur();
    textarea.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }));
    assert(row2.querySelector('[data-today-draft-text]'), 'focusout must not tear down the textarea synchronously');
    await new Promise(resolve => setTimeout(resolve, 0));
    const rowAfter = manager.list.querySelector('[data-today-draft-id="draft-2"]');
    assert(rowAfter, 'draft-2 row should exist after deferred render');
    const afterBlurTextarea = rowAfter.querySelector('[data-today-draft-text]');
    assert(!afterBlurTextarea, 'blur should tear down the inline textarea');
    const afterBlurDisplay = rowAfter.querySelector('[data-today-draft-text-display]');
    assert(afterBlurDisplay, 'blur should restore the display span');
    assert(afterBlurDisplay.textContent.includes('新增文字'), 'display span should contain edited text');
    assert.strictEqual(manager.pendingRender, false, 'pendingRender should be flushed on blur');

    console.log('Today drafts editing lifecycle and focus preservation checks passed');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
