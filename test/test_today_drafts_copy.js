// 今日草稿行尾复制按钮 + 失焦让路（click 保命）的 jsdom 回归：
// 1) 渲染器在可编辑行与历史只读行的展示态正文末尾都带复制按钮；
// 2) 点复制按钮 = 写剪贴板 + toast + 行高亮，且不得顺势进入行编辑；
//    clipboard API 不可用/被拒时降级 execCommand，失败要响亮报错；
// 3) 触摸按住行亮出复制按钮（is-copy-reveal），抬手后短暂保留再收；
// 4) 失焦清场必须让出当前任务：focusout 同步阶段不许重建列表（否则进行中的
//    click 目标被换掉——复选框点不上、空草稿失焦清除失效的真机根因）；
// 5) 翻页手势不认领复选框/复制按钮起笔（.today-draft-check / button 排除名单），
//    空白纸面起笔仍建手势（真机只在这里验证捕获时机，见 browser 回归）。
const assert = require('assert');
const { JSDOM } = require('jsdom');

function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function pointerEvent(dom, type, props = {}) {
    // jsdom 没有 PointerEvent：用普通 Event 挂属性，manager 只读这些字段。
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    return Object.assign(event, {
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse',
        button: 0,
        clientX: 0,
        clientY: 0
    }, props);
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
    // Node 21+ 的 globalThis.navigator 是 getter-only，普通赋值会静默失败，
    // manager 读到的仍是 Node 内置 navigator（没有 clipboard）——必须 defineProperty。
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Event = dom.window.Event;
    globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
    globalThis.cancelAnimationFrame = id => clearTimeout(id);
    globalThis.performance = dom.window.performance;
    if (!dom.window.CSS?.escape) {
        globalThis.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`) };
    } else {
        globalThis.CSS = dom.window.CSS;
    }

    const { TodayDraftsManager } = await import('../public/managers/today-drafts/today-drafts-manager.js');
    const { renderTodayDraftItem } = await import('../public/managers/today-drafts/today-drafts-renderer.js');

    // ---- 1. 渲染器：可编辑与只读行都有复制按钮，且长在展示态正文末尾 ----
    const editableHtml = renderTodayDraftItem({ id: 'row-1', text: '正文内容', completed: false, createdAt: Date.now() });
    const readonlyHtml = renderTodayDraftItem({ id: 'row-2', text: '历史内容', completed: true, createdAt: Date.now() }, { readonly: true });
    for (const [label, html] of [['editable', editableHtml], ['readonly', readonlyHtml]]) {
        const holder = document.createElement('div');
        holder.innerHTML = html;
        const row = holder.firstElementChild;
        const button = row.querySelector('[data-today-draft-copy]');
        assert(button, `${label} row must render a copy button`);
        assert.strictEqual(button.tagName, 'BUTTON', `${label} copy affordance must be a real button`);
        // 只读行的展示态只有 class 没有 data-today-draft-text-display 属性（可编辑行专属），按 class 断言。
        assert(button.closest('.today-draft-text-display'), `${label} copy button must sit inside the text tail`);
    }

    const clipboardWrites = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { clipboardWrites.push(value); } }
    });

    const toastCalls = [];
    const toaster = { show: (message, type) => toastCalls.push([message, type]) };

    const storage = new Map();
    const initialItems = [
        { id: 'draft-1', text: '第一条要复制的内容', completed: false, day: localDayKey(), createdAt: Date.now() - 1000 },
        { id: 'draft-2', text: '第二条', completed: false, day: localDayKey(), createdAt: Date.now() }
    ];
    storage.set('items', JSON.stringify(initialItems));
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
    const fakeApi = { list: async () => ({ day: localDayKey(), items: [] }) };

    const manager = new TodayDraftsManager({
        store: fakeStore,
        outbox: fakeOutbox,
        apiClient: fakeApi,
        toaster
    });

    // ---- 2. 点复制按钮：写剪贴板 + toast，不进编辑态 ----
    const row1 = manager.list.querySelector('[data-today-draft-id="draft-1"]');
    assert(row1, 'draft-1 must be rendered');
    const copyButton = row1.querySelector('[data-today-draft-copy]');
    assert(copyButton, 'rendered row must carry the copy button');
    copyButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(clipboardWrites, ['第一条要复制的内容'], 'copy button must write the draft text to the clipboard');
    assert(toastCalls.some(([message]) => message === '已复制到剪贴板'), 'copy must surface a success toast');
    assert(!row1.querySelector('[data-today-draft-text]'), 'copy must NOT open the inline editor');
    assert(row1.classList.contains('is-copied'), 'copy must flash the row');
    assert(copyButton.classList.contains('is-copy-success'), 'copy success must swap the icon to the checkmark');
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert(!copyButton.classList.contains('is-copy-success'), 'checkmark must revert after the feedback window');

    // ---- 2b. clipboard API 拒绝 → execCommand 降级成功 ----
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new dom.window.DOMException('denied'); } }
    });
    const execCalls = [];
    dom.window.document.execCommand = command => {
        execCalls.push(command);
        return true;
    };
    const row2 = manager.list.querySelector('[data-today-draft-id="draft-2"]');
    row2.querySelector('[data-today-draft-copy]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(execCalls, ['copy'], 'clipboard failure must fall back to execCommand("copy")');
    assert(row2.classList.contains('is-copied'), 'fallback success must still flash the row');

    // ---- 2c. 两条路都失败 → 响亮报错，不假成功 ----
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new dom.window.DOMException('denied'); } }
    });
    dom.window.document.execCommand = () => false;
    const toastCountBefore = toastCalls.length;
    row2.querySelector('[data-today-draft-copy]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(toastCalls.length > toastCountBefore, 'total copy failure must surface a toast');
    assert(toastCalls.at(-1)[1] === 'error', 'total copy failure must be reported as an error');

    // ---- 3. 触摸按住行亮出复制按钮，抬手后收起 ----
    const touchRow = manager.list.querySelector('[data-today-draft-id="draft-1"]');
    touchRow.dispatchEvent(pointerEvent(dom, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 20 }));
    assert(touchRow.classList.contains('is-copy-reveal'), 'touch pointerdown must reveal the copy button');
    touchRow.dispatchEvent(pointerEvent(dom, 'pointerup', { pointerType: 'touch', clientX: 200, clientY: 20 }));
    assert(touchRow.classList.contains('is-copy-reveal'), 'reveal lingers briefly after pointerup');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert(!touchRow.classList.contains('is-copy-reveal'), 'reveal must clear after the linger window');

    // ---- 4. 失焦清场让路：focusout 同步阶段不重建列表 ----
    const display = manager.list.querySelector('[data-today-draft-id="draft-1"] [data-today-draft-text-display]');
    display.click();
    const editor = manager.list.querySelector('[data-today-draft-id="draft-1"] [data-today-draft-text]');
    assert(editor, 'display click must open the inline editor');
    editor.value = '失焦前还在编辑';
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const editorBeforeBlur = manager.list.querySelector('[data-today-draft-id="draft-1"] [data-today-draft-text]');
    // 真实浏览器里 focusout 之前焦点已经移走；jsdom 的合成事件不转焦点，手动 blur。
    editorBeforeBlur.blur();
    editorBeforeBlur.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }));
    assert(
        manager.list.querySelector('[data-today-draft-id="draft-1"] [data-today-draft-text]') === editorBeforeBlur,
        'focusout must leave the editor node untouched in the same task'
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(!manager.list.querySelector('[data-today-draft-id="draft-1"] [data-today-draft-text]'), 'deferred cleanup must restore display mode');

    // ---- 4b. 空草稿失焦：同步阶段保留（click 保命），任务结束后删除 ----
    manager.addAfter('draft-2');
    // addAfter 走 rAF 才把空行切成编辑态（测试环境 rAF = setTimeout 0）。
    await new Promise(resolve => setTimeout(resolve, 0));
    const emptyRow = manager.list.querySelector('[data-today-draft-id]:last-child');
    assert(emptyRow, 'addAfter must append an empty draft row');
    const emptyEditor = emptyRow.querySelector('[data-today-draft-text]');
    assert(emptyEditor, 'empty draft must be in editing mode');
    const emptyId = emptyRow.dataset.todayDraftId;
    emptyEditor.blur();
    emptyEditor.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }));
    assert(manager.items.some(item => item.id === emptyId), 'empty draft must survive the synchronous phase of focusout');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(!manager.items.some(item => item.id === emptyId), 'empty draft must be removed once the task settles');
    assert(!manager.list.querySelector(`[data-today-draft-id="${emptyId}"]`), 'empty draft row must be gone after cleanup');

    // ---- 5. 翻页手势不认领复选框/复制按钮起笔；空白纸面仍建手势 ----
    const targetRow = manager.list.querySelector('[data-today-draft-id="draft-1"]');
    // jsdom 的 getBoundingClientRect 全零，桩成有宽度才能走到纸边热区判定。
    targetRow.getBoundingClientRect = () => ({ left: 100, right: 900, top: 0, bottom: 44, width: 800, height: 44 });
    const checkSpan = targetRow.querySelector('.today-draft-check span');
    checkSpan.dispatchEvent(pointerEvent(dom, 'pointerdown', { clientX: 110, clientY: 20 }));
    assert.strictEqual(manager.pagerInteraction, null, 'checkbox start must not be claimed by the pager gesture');
    document.getElementById('today-drafts-view').dispatchEvent(pointerEvent(dom, 'pointerup', { clientX: 110, clientY: 20 }));

    const copyTarget = targetRow.querySelector('[data-today-draft-copy]');
    copyTarget.dispatchEvent(pointerEvent(dom, 'pointerdown', { clientX: 700, clientY: 20 }));
    assert.strictEqual(manager.pagerInteraction, null, 'copy button start must not be claimed by the pager gesture');
    document.getElementById('today-drafts-view').dispatchEvent(pointerEvent(dom, 'pointerup', { clientX: 700, clientY: 20 }));

    document.getElementById('today-drafts-writing-area').dispatchEvent(pointerEvent(dom, 'pointerdown', { clientX: 500, clientY: 300 }));
    assert(manager.pagerInteraction, 'blank paper start must still arm the pager gesture');
    document.getElementById('today-drafts-view').dispatchEvent(pointerEvent(dom, 'pointerup', { clientX: 500, clientY: 300 }));

    console.log('Today drafts copy button and deferred blur checks passed');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
