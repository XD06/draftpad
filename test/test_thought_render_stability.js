// Regression tests verifying Thought interactions patch cards in place,
// deduplicate WS create races, and preserve viewport scroll anchoring
// without triggering full timeline teardown/rebuilds (`render()`).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

function makeThought(index, overrides = {}) {
    const num = String(index).padStart(2, '0');
    return {
        id: `t-${num}`,
        text: `Thought ${num}`,
        subItems: [
            { id: `s-${num}-1`, text: `Subtask ${num}-1`, completed: false },
            { id: `s-${num}-2`, text: `Subtask ${num}-2`, completed: false }
        ],
        tags: index % 2 === 0 ? ['work'] : ['life'],
        aiTags: [],
        aiStatus: 'ready',
        completed: false,
        pinned: false,
        relationCount: 0,
        attachments: [],
        createdAt: 1700000000000 + (100 - index) * 1000,
        updatedAt: 1700000000000 + (100 - index) * 1000,
        version: 1,
        ...overrides
    };
}

function setupEnv(thoughts, { layoutHeights = null } = {}) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'http://localhost/' });

    const scrollState = { x: 0, y: 0, scrollIntoViewCalls: [] };
    Object.defineProperty(dom.window, 'scrollY', {
        configurable: true,
        get: () => scrollState.y
    });
    Object.defineProperty(dom.window, 'innerHeight', {
        configurable: true,
        value: 800
    });
    dom.window.scrollTo = (xOrOpts, y) => {
        if (typeof xOrOpts === 'object' && xOrOpts !== null) {
            scrollState.y = Math.max(0, Number(xOrOpts.top) || 0);
        } else {
            scrollState.x = Number(xOrOpts) || 0;
            scrollState.y = Math.max(0, Number(y) || 0);
        }
    };

    const globals = {
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement,
        Element: dom.window.Element,
        Node: dom.window.Node,
        CSS: { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`) },
        localStorage: {
            _map: new Map(),
            getItem(key) { return this._map.has(key) ? this._map.get(key) : null; },
            setItem(key, val) { this._map.set(key, String(val)); },
            removeItem(key) { this._map.delete(key); }
        },
        requestAnimationFrame: (cb) => {
            // Execute asynchronously once so initial cold paint renders synchronously first
            return setTimeout(() => cb(Date.now()), 0);
        },
        cancelAnimationFrame: (id) => clearTimeout(id)
    };

    Object.entries(globals).forEach(([key, val]) => {
        Object.defineProperty(globalThis, key, { value: val, configurable: true, writable: true });
    });

    if (layoutHeights) {
        const timeline = dom.window.document.getElementById('thoughts-timeline');
        const computeCardRect = (el) => {
            const cards = Array.from(timeline.querySelectorAll('.thought-card[data-id]'));
            let offsetTop = 80;
            for (const item of cards) {
                const height = layoutHeights.get(item.dataset.id)
                    ?? (item.classList.contains('expanded') ? 520 : 120);
                if (item === el) {
                    const top = offsetTop - scrollState.y;
                    return {
                        top,
                        bottom: top + height,
                        left: 0,
                        right: 400,
                        width: 400,
                        height
                    };
                }
                offsetTop += height + 12;
            }
            return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
        };

        const origProtoRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
        dom.window.HTMLElement.prototype.getBoundingClientRect = function patchedRect() {
            if (this.classList?.contains('thought-card')) {
                return computeCardRect(this);
            }
            return origProtoRect.call(this);
        };
    }

    dom.window.HTMLElement.prototype.scrollIntoView = function trackedScrollIntoView(opts) {
        scrollState.scrollIntoViewCalls.push({
            id: this.dataset?.id || null,
            opts
        });
    };

    return { dom, scrollState };
}

async function createManager(thoughts, apiOverrides = {}, envOptions = {}) {
    const env = setupEnv(thoughts, envOptions);
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'managers', 'thoughts.js')).href);
    const { ThoughtsManager } = mod;

    let seq = 100;
    const apiClient = {
        listPage: async () => ({ items: thoughts, nextCursor: null, hasMore: false }),
        create: async (payload) => ({
            id: `srv-${++seq}`,
            text: payload.text,
            tags: payload.tags || [],
            attachments: payload.attachments || [],
            subItems: [],
            completed: false,
            pinned: false,
            relationCount: 0,
            aiStatus: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: 1
        }),
        overwrite: async (id, body) => ({
            id,
            ...body,
            version: Number(body.version || 1) + 1,
            updatedAt: Date.now()
        }),
        addSubitem: async (id, text) => {
            const t = manager.thoughts.find(x => x.id === id);
            const nextSubItems = [...(t?.subItems || []), { id: `srv-sub-${++seq}`, text, completed: false }];
            return {
                ...t,
                subItems: nextSubItems,
                version: Number(t?.version || 1) + 1
            };
        },
        updateSubitem: async (id, subId, text) => {
            const t = manager.thoughts.find(x => x.id === id);
            const nextSubItems = (t?.subItems || []).map(s => (s.id === subId ? { ...s, text } : s));
            return {
                ...t,
                subItems: nextSubItems,
                version: Number(t?.version || 1) + 1
            };
        },
        deleteSubitem: async (id, subId) => {
            const t = manager.thoughts.find(x => x.id === id);
            const nextSubItems = (t?.subItems || []).filter(s => s.id !== subId);
            return {
                ...t,
                subItems: nextSubItems,
                version: Number(t?.version || 1) + 1
            };
        },
        delete: async () => ({ ok: true }),
        getAIStatus: async () => ({ status: 'ready', insight: '' }),
        ...apiOverrides
    };

    const app = {
        apiClient,
        toaster: { show: () => {} },
        confirmationManager: { show: async () => true }
    };

    const manager = new ThoughtsManager(app);
    manager.thoughts = thoughts.map(t => ({ ...t, subItems: (t.subItems || []).map(s => ({ ...s })) }));
    return { manager, ...env, ThoughtsManager };
}

function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForRenderedCount(manager, expected, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (manager._renderedCount < expected && Date.now() < deadline) {
        await waitMs(15);
    }
    assert.strictEqual(manager._renderedCount, expected, `expected renderedCount to reach ${expected}`);
}

async function testSubtaskInlineEditAndQuickAddStability() {
    const initial = Array.from({ length: 35 }, (_, i) => makeThought(i + 1));
    const { manager, dom } = await createManager(initial);

    // Wait for first-page async chunks to fill to 30 so timeline is buffered (30 of 35)
    manager.render();
    await waitForRenderedCount(manager, 30);
    assert.strictEqual(manager._lastFilteredIds.length, 35);

    const siblingBefore = dom.window.document.querySelector('.thought-card[data-id="t-01"]');
    const siblingAfter = dom.window.document.querySelector('.thought-card[data-id="t-03"]');
    assert(siblingBefore && siblingAfter, 'sibling cards should be rendered');

    let renderCalls = 0;
    let scheduleRenderCalls = 0;
    const origRender = manager.render.bind(manager);
    const origScheduleRender = manager.scheduleRender.bind(manager);
    manager.render = function trackedRender(...args) {
        renderCalls += 1;
        return origRender(...args);
    };
    manager.scheduleRender = function trackedScheduleRender(...args) {
        scheduleRenderCalls += 1;
        return origScheduleRender(...args);
    };

    // 1. Inline edit subtask -> IME composing Enter ignored -> Enter commits in-place
    const card2 = dom.window.document.querySelector('.thought-card[data-id="t-02"]');
    const textSpan = card2.querySelector('.subtask[data-subid="s-02-1"] .subtask-text');
    manager.inlineEditSubtask(card2, manager.thoughts[1], textSpan);
    const editInput = dom.window.document.querySelector('.thought-card[data-id="t-02"] .subtask-inline-input');
    assert(editInput, 'inline edit input should be mounted');

    editInput.value = 'Edited step';
    editInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    await waitMs(10);
    assert(dom.window.document.querySelector('.thought-card[data-id="t-02"] .subtask-inline-input'), 'IME composing Enter must not commit');

    editInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitMs(130); // covers blur timeout too

    assert.strictEqual(renderCalls, 0, 'inline subtask Enter commit must not call render()');
    assert.strictEqual(scheduleRenderCalls, 0, 'inline subtask Enter commit must not call scheduleRender()');
    assert.strictEqual(dom.window.document.querySelector('.thought-card[data-id="t-01"]'), siblingBefore, 'earlier sibling DOM node must remain identical');
    assert.strictEqual(dom.window.document.querySelector('.thought-card[data-id="t-03"]'), siblingAfter, 'later sibling DOM node must remain identical');
    assert.strictEqual(
        dom.window.document.querySelector('.thought-card[data-id="t-02"] .subtask[data-subid="s-02-1"] .subtask-text').textContent,
        'Edited step'
    );

    // 2. quickAddSubtask with Enter (while >30 buffered thoughts exist) + WS self-echo while input focused + blur
    const currentCard2 = dom.window.document.querySelector('.thought-card[data-id="t-02"]');
    manager.quickAddSubtask(currentCard2, manager.thoughts[1]);
    const addInput = dom.window.document.querySelector('.thought-card[data-id="t-02"] .subtask-inline-input');
    assert(addInput, 'quick-add subtask input should be focused');

    addInput.value = 'Added via Enter';
    addInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitMs(10);

    // Simulate WS self-echo arriving while inline add input is still focused in card t-02
    manager.handleSocketUpdate('update', {
        ...manager.thoughts[1],
        version: manager.thoughts[1].version,
        aiStatus: 'pending'
    });

    assert.strictEqual(renderCalls, 0, 'quickAddSubtask Enter + WS self-echo in buffered list must not call render()');
    assert.strictEqual(scheduleRenderCalls, 0, 'quickAddSubtask Enter + WS self-echo must not call scheduleRender()');
    assert.strictEqual(dom.window.document.activeElement, addInput, 'quick-add input must keep focus across Enter and WS echo');

    // Blur out of the input; wait past blur commit (100ms) + deferred card patch timer (120ms)
    addInput.dispatchEvent(new dom.window.FocusEvent('blur'));
    await waitMs(160);

    assert.strictEqual(renderCalls, 0, 'blurring quickAddSubtask must patch only card, never call render()');
    assert.strictEqual(scheduleRenderCalls, 0, 'blurring quickAddSubtask must not schedule full render()');
    assert.strictEqual(dom.window.document.querySelector('.thought-card[data-id="t-01"]'), siblingBefore, 'sibling t-01 must still be intact after subtask blur');
    assert.strictEqual(dom.window.document.querySelector('.thought-card[data-id="t-03"]'), siblingAfter, 'sibling t-03 must still be intact after subtask blur');
}

async function testQuickAddWSEchoDeduplicationAndAIUpdate() {
    const initial = [makeThought(1), makeThought(2)];
    let resolveCreate;
    const createPromise = new Promise(resolve => { resolveCreate = resolve; });

    const { manager, dom, scrollState } = await createManager(initial, {
        create: () => createPromise
    }, {
        layoutHeights: new Map([['t-01', 120], ['t-02', 120]])
    });

    manager.render();
    await waitMs(20);

    let renderCalls = 0;
    const origRender = manager.render.bind(manager);
    manager.render = function trackedRender(...args) {
        renderCalls += 1;
        return origRender(...args);
    };

    const existingCard1 = dom.window.document.querySelector('.thought-card[data-id="t-01"]');
    dom.window.document.getElementById('quick-add-input').value = 'WS race note';
    scrollState.y = 0; // top of page: new card already within visible viewport

    const submitTask = manager.submitQuickAdd();
    await waitMs(70); // allow 50ms conditional scroll timer

    assert.strictEqual(renderCalls, 0, 'submitQuickAdd optimistic insert must not call render()');
    assert.strictEqual(scrollState.scrollIntoViewCalls.length, 0, 'should not scrollIntoView when new card is already comfortably visible');
    assert.strictEqual(dom.window.document.querySelector('.thought-card[data-id="t-01"]'), existingCard1, 'existing card t-01 must stay intact on add');

    // WS create beats HTTP response
    const serverPayload = {
        id: 'srv-race-1',
        text: 'WS race note',
        tags: [],
        subItems: [],
        completed: false,
        pinned: false,
        relationCount: 0,
        aiStatus: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1
    };
    manager.handleSocketUpdate('create', { ...serverPayload });
    assert.strictEqual(
        dom.window.document.querySelectorAll('.thought-card[data-id^="local-"]').length,
        0,
        'optimistic temp card must be replaced when WS create claims in-flight add'
    );
    assert.strictEqual(
        dom.window.document.querySelectorAll('.thought-card[data-id="srv-race-1"]').length,
        1,
        'WS create arriving before HTTP must render exactly one card'
    );

    // HTTP create resolves afterwards
    resolveCreate({ ...serverPayload });
    await submitTask;

    assert.strictEqual(renderCalls, 0, 'completing submitQuickAdd must not call render()');
    assert.strictEqual(
        dom.window.document.querySelectorAll('.thought-card[data-id="srv-race-1"]').length,
        1,
        'HTTP resolve after WS claim must not create a duplicate card'
    );
    assert.strictEqual(manager.thoughts.filter(t => t.id === 'srv-race-1').length, 1);

    // Delayed AI status update (past 1200ms pending window) must update card UI without calling render() or disturbing siblings
    const srvThought = manager.thoughts.find(t => t.id === 'srv-race-1');
    srvThought.aiPendingSince = Date.now() - 1500;
    const cardCreated = dom.window.document.querySelector('.thought-card[data-id="srv-race-1"]');
    manager.handleAIStatusSocketUpdate({
        thoughtId: 'srv-race-1',
        status: 'ready',
        aiTags: ['insight'],
        relationsCount: 2
    });
    assert.strictEqual(renderCalls, 0, 'AI status update must not call render()');
    assert.strictEqual(dom.window.document.querySelector('.thought-card[data-id="t-01"]'), existingCard1, 'sibling t-01 must not rebuild on AI update');
    assert.strictEqual(dom.window.document.querySelector('.thought-card[data-id="srv-race-1"] .relations-count')?.textContent, '2');
    assert(cardCreated !== dom.window.document.querySelector('.thought-card[data-id="srv-race-1"]') || dom.window.document.querySelector('.thought-card[data-id="srv-race-1"] .thought-ai-tags'), 'new AI suggested tag should surface on card');
}

async function testEmptyTimelineQuickAddAndViewportScrollAnchoring() {
    // Part A: Empty timeline -> quick add first Thought via patchRenderedThought
    const emptyCtx = await createManager([]);
    emptyCtx.manager.render();
    assert(emptyCtx.dom.window.document.querySelector('.thoughts-empty'), 'empty state should render first');
    emptyCtx.dom.window.document.getElementById('quick-add-input').value = 'First thought';
    await emptyCtx.manager.submitQuickAdd();
    assert.strictEqual(emptyCtx.dom.window.document.querySelector('.thoughts-empty'), null, 'empty state must disappear on first Thought');
    assert.strictEqual(emptyCtx.dom.window.document.querySelectorAll('.thought-card').length, 1);

    // Part B: collapseOthers + remote create above viewport + render() preserving rendered count & anchor
    const heights = new Map();
    const list = Array.from({ length: 35 }, (_, i) => {
        const t = makeThought(i + 1, { text: 'Line '.repeat(i === 0 ? 40 : 1) });
        heights.set(t.id, i === 0 ? 520 : 120);
        return t;
    });
    const ctx = await createManager(list, {}, { layoutHeights: heights });
    ctx.manager.expandedThoughtIds.add('t-01');
    ctx.manager.render();
    await waitForRenderedCount(ctx.manager, 30);

    // Scroll so t-15 is near top of viewport (~120px)
    const card15Before = ctx.dom.window.document.querySelector('.thought-card[data-id="t-15"]');
    ctx.scrollState.y = card15Before.getBoundingClientRect().top - 120;
    const pinnedTopBefore = Math.round(card15Before.getBoundingClientRect().top);
    assert.strictEqual(pinnedTopBefore, 120);

    // Collapsing expanded card t-01 above viewport when expanding t-15 must compensate scrollY
    heights.set('t-15', 300);
    ctx.manager.setThoughtCardExpanded(card15Before, 't-15', true, { collapseOthers: true });
    assert.strictEqual(
        Math.round(ctx.dom.window.document.querySelector('.thought-card[data-id="t-15"]').getBoundingClientRect().top),
        pinnedTopBefore,
        'setThoughtCardExpanded collapseOthers must anchor target card position in viewport'
    );

    // Remote create arriving above viewport must keep scroll sightline anchored
    ctx.manager.handleSocketUpdate('create', makeThought(0, { id: 't-remote-0', createdAt: 1700000999000 }));
    assert.strictEqual(
        Math.round(ctx.dom.window.document.querySelector('.thought-card[data-id="t-15"]').getBoundingClientRect().top),
        pinnedTopBefore,
        'remote create above viewport must keep user sightline anchored'
    );

    // Explicit render() when 31 cards already rendered must NOT clamp down to 8 cards or jump scroll
    ctx.manager.render();
    assert.strictEqual(ctx.manager._renderedCount, 31, 're-render must preserve rendered card count synchronously');
    assert.strictEqual(
        Math.round(ctx.dom.window.document.querySelector('.thought-card[data-id="t-15"]').getBoundingClientRect().top),
        pinnedTopBefore,
        're-render must preserve viewport scroll anchor'
    );

    // Part C: enterEditMode save, tag accept/remove, delete must NOT call render()
    let renderCalls = 0;
    ctx.manager.render = () => { renderCalls += 1; };

    const card15 = ctx.dom.window.document.querySelector('.thought-card[data-id="t-15"]');
    ctx.manager.enterEditMode(card15, ctx.manager.thoughts.find(t => t.id === 't-15'));
    const textarea = ctx.dom.window.document.querySelector('.thought-card[data-id="t-15"] .edit-textarea');
    textarea.value = 'Updated body text';
    textarea.onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await waitMs(10);
    assert.strictEqual(renderCalls, 0, 'enterEditMode Ctrl+Enter save must not call render()');

    await ctx.manager.acceptAITag('t-15', 'newtag');
    assert.strictEqual(renderCalls, 0, 'acceptAITag must not call render()');

    await ctx.manager.removeThoughtTag('t-15', 'newtag');
    assert.strictEqual(renderCalls, 0, 'removeThoughtTag (when activeTag is empty) must not call render()');

    await ctx.manager.confirmAndDeleteThought('t-15', { skipConfirm: true });
    assert.strictEqual(renderCalls, 0, 'confirmAndDeleteThought must not call render()');
    assert.strictEqual(ctx.dom.window.document.querySelector('.thought-card[data-id="t-15"]'), null);
}

async function testSubtaskRowSwipePointerGuards() {
    const thoughts = Array.from({ length: 3 }, (_, idx) => makeThought(idx + 1));
    const ctx = await createManager(thoughts);
    ctx.manager.render();
    const row = ctx.dom.window.document.querySelector('.thought-card[data-id="t-01"] .subtask[data-subid="s-01-1"]');
    const textSpan = row.querySelector('.subtask-text');
    assert(row && textSpan, 'expected rendered subtask row and text span');

    const capturedIds = [];
    row.setPointerCapture = (id) => capturedIds.push(id);
    row.hasPointerCapture = (id) => capturedIds.includes(id);
    row.releasePointerCapture = () => {};

    const mouseDown = new ctx.dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperty(mouseDown, 'pointerType', { value: 'mouse' });
    Object.defineProperty(mouseDown, 'pointerId', { value: 1 });
    textSpan.dispatchEvent(mouseDown);
    const mouseMove = new ctx.dom.window.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 60, clientY: 10 });
    Object.defineProperty(mouseMove, 'pointerType', { value: 'mouse' });
    Object.defineProperty(mouseMove, 'pointerId', { value: 1 });
    row.dispatchEvent(mouseMove);
    assert.strictEqual(capturedIds.length, 0, 'mouse pointerdown/move must never capture pointer on subtask row');
    assert.strictEqual(row.classList.contains('swiping'), false, 'mouse move must not initiate row swipe');

    // Touch tap without horizontal drag must also avoid early pointer capture
    const touchDown = new ctx.dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperty(touchDown, 'pointerType', { value: 'touch' });
    Object.defineProperty(touchDown, 'pointerId', { value: 2 });
    textSpan.dispatchEvent(touchDown);
    assert.strictEqual(capturedIds.length, 0, 'touch pointerdown must not capture before horizontal swipe begins');

    // Once horizontal drag crosses threshold, row enters swiping and captures pointer
    const touchMove = new ctx.dom.window.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 32, clientY: 12 });
    Object.defineProperty(touchMove, 'pointerType', { value: 'touch' });
    Object.defineProperty(touchMove, 'pointerId', { value: 2 });
    row.dispatchEvent(touchMove);
    assert.strictEqual(row.classList.contains('swiping'), true, 'horizontal touch drag should enter swiping state');
    assert.deepStrictEqual(capturedIds, [2], 'horizontal touch drag should capture active pointer');

    const touchCancel = new ctx.dom.window.MouseEvent('pointercancel', { bubbles: true, cancelable: true });
    Object.defineProperty(touchCancel, 'pointerId', { value: 2 });
    row.dispatchEvent(touchCancel);
    assert.strictEqual(row.classList.contains('swiping'), false, 'pointercancel should reset swiping state');
}

async function run() {
    await testSubtaskInlineEditAndQuickAddStability();
    await testQuickAddWSEchoDeduplicationAndAIUpdate();
    await testEmptyTimelineQuickAddAndViewportScrollAnchoring();
    await testSubtaskRowSwipePointerGuards();
    console.log('Thought render and scroll stability checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
