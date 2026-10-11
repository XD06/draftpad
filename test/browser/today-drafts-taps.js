// 即时草稿点按类行为的真机回归（jsdom 证不了指针捕获与真实 click 链路）：
// 1) 复选框可点：无编辑器时直接点、行编辑器开着时点，都必须完成勾选（真机根因：
//    翻页手势 down 就捕获指针 + 失焦同步重绘，把进行中的 click 吃掉了）；
// 2) 空草稿不残留：行内 Enter 产生的空草稿，点空白纸面失焦后被删除（真机根因：
//    手势捕获把 click 改派到 view，编辑器失焦从不发生）；
// 3) 认领点按可以捕获指针但不产生翻页副作用，真正的翻页拖拽照常落页；
// 4) 行尾复制按钮：桌面 hover 亮出、点击写剪贴板 + toast；
// 5) 长按行唤出操作菜单（复制 / 转为 Thought / 转为文章 / 删除）：按住不动才开、
//    抬手不关、点动作才关；按住后横向移动即取消（横拖只归翻页）。
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

function localDayKey(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() - offsetDays);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

async function main() {
    const app = express();
    const puts = [];
    const deletes = [];
    const draft = id => ({ id, text: `草稿 ${id}`, completed: false, day: localDayKey(0), version: 1, createdAt: Date.now(), updatedAt: Date.now() });
    app.get('/api/config', (_req, res) => res.json({ hiddenFloatingActions: [] }));
    app.get('/api/today-drafts', (_req, res) => res.json({
        day: localDayKey(0),
        items: [
            { id: 't1', text: '测试一下', completed: false, day: localDayKey(0), createdAt: Date.now() - 120000 },
            { id: 't2', text: 'WiFi和我', completed: false, day: localDayKey(0), createdAt: Date.now() - 60000 }
        ]
    }));
    app.put('/api/today-drafts/:id', express.json(), (req, res) => {
        puts.push({ id: req.params.id, body: req.body });
        res.json({ success: true, created: false, draft: { ...draft(req.params.id), text: req.body.text, completed: req.body.completed === true, version: 2 } });
    });
    app.delete('/api/today-drafts/:id', express.json(), (req, res) => {
        deletes.push({ id: req.params.id, body: req.body });
        res.json({ success: true, deleted: true, draft: draft(req.params.id) });
    });
    app.use(express.static(path.resolve(__dirname, '../..', 'public')));

    const listener = await new Promise(resolve => {
        const l = app.listen(0, '127.0.0.1', () => resolve(l));
    });

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        permissions: ['clipboard-read', 'clipboard-write']
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${listener.address().port}/#today`);
    await page.waitForTimeout(600);

    const rowCount = () => page.$$eval('#today-drafts-base [data-today-draft-id]', els => els.length);
    const rowState = id => page.$eval(`#today-drafts-base [data-today-draft-id="${id}"]`, row => ({
        checked: row.querySelector('[data-today-draft-complete]')?.checked ?? null,
        completedClass: row.classList.contains('is-completed'),
        hasEditor: Boolean(row.querySelector('[data-today-draft-text]'))
    }));

    // ---- 1a. 无编辑器：点复选框直接勾选 ----
    const check1 = await page.locator('#today-drafts-base [data-today-draft-id="t1"] .today-draft-check').boundingBox();
    await page.mouse.click(check1.x + check1.width / 2, check1.y + check1.height / 2);
    await page.waitForTimeout(350);
    assert.deepEqual(await rowState('t1'), { checked: true, completedClass: true, hasEditor: false }, 'plain checkbox click must complete the draft');
    assert.equal(puts.at(-1)?.id, 't1', 'checkbox toggle must reach the API');

    // ---- 1b. 行编辑器开着：点另一行复选框仍要勾选（修复前被捕获+重绘吃掉）----
    await page.click('#today-drafts-base [data-today-draft-id="t2"] [data-today-draft-text-display]');
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#today-drafts-base [data-today-draft-id="t2"] [data-today-draft-text]'))), true, 'row editor must be open');
    const check2 = await page.locator('#today-drafts-base [data-today-draft-id="t1"] .today-draft-check').boundingBox();
    await page.mouse.click(check2.x + check2.width / 2, check2.y + check2.height / 2);
    await page.waitForTimeout(450);
    const stateAfter = await rowState('t1');
    assert.equal(stateAfter.checked, false, 'second click must untoggle the checkbox (click must not be swallowed)');
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#today-drafts-base [data-today-draft-id="t2"] [data-today-draft-text-display]'))), true, 'blurred editor must fall back to display mode');
    // 重新勾回，保持后续步骤干净
    await page.mouse.click(check2.x + check2.width / 2, check2.y + check2.height / 2);
    await page.waitForTimeout(350);
    assert.equal((await rowState('t1')).checked, true, 'checkbox stays interactive');

    // ---- 2. 空草稿失焦清除：行内 Enter 造空行，点空白纸面后必须删除 ----
    await page.click('#today-drafts-base [data-today-draft-id="t2"] [data-today-draft-text-display]');
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
    const rowsWithEmpty = await rowCount();
    assert.equal(rowsWithEmpty, 3, 'Enter in the row editor must append an empty draft');
    const emptyId = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#today-drafts-base [data-today-draft-id]')];
        return rows.map(row => row.dataset.todayDraftId).find(id => !['t1', 't2'].includes(id));
    });
    assert.ok(emptyId, 'empty draft id must be discoverable');
    const area = await page.locator('#today-drafts-writing-area').boundingBox();
    await page.mouse.click(area.x + area.width / 2, area.y + area.height - 12);
    await page.waitForTimeout(450);
    assert.equal(await rowCount(), 2, 'tapping blank paper must dismiss the empty draft');
    assert.deepEqual(deletes.map(entry => entry.id), [emptyId], 'empty draft must be deleted through the API');
    const storedItems = await page.evaluate(() => JSON.parse(localStorage.getItem('dumbpad_today_drafts_v1') || '{"items":[]}').items);
    assert.ok(storedItems.every(item => String(item.text || '').trim()), 'local cache must not keep the empty draft');

    // ---- 3. 认领点按的捕获不产生翻页副作用；真正的翻页拖拽照常落页 ----
    await page.evaluate(() => {
        window.__captureCount = 0;
        document.getElementById('today-drafts-view').addEventListener('gotpointercapture', () => {
            window.__captureCount += 1;
        });
    });
    const eyebrowBeforeTap = await page.$eval('#today-drafts-eyebrow', el => el.textContent.trim());
    await page.mouse.click(area.x + area.width / 2, area.y + area.height - 12);
    await page.waitForTimeout(250);
    assert.equal(
        await page.$eval('#today-drafts-eyebrow', el => el.textContent.trim()),
        eyebrowBeforeTap,
        'plain tap must not turn a page'
    );

    const pager = await page.locator('#today-drafts-pager').boundingBox();
    const startX = pager.x + pager.width * 0.35;
    const startY = pager.y + pager.height * 0.75;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 300, startY, { steps: 12 });
    await page.waitForTimeout(120);
    assert.ok(await page.evaluate(() => window.__captureCount) >= 1, 'flip drag must capture the pointer once dragging starts');
    await page.mouse.up();
    await page.waitForTimeout(600);
    const eyebrow = await page.$eval('#today-drafts-eyebrow', el => el.textContent.trim());
    assert.ok(eyebrow.includes('yest'), `right swipe must flip to the older day, got: ${eyebrow}`);

    // ---- 4a. 复制按钮：hover 亮出，点击写剪贴板 + toast ----
    await page.evaluate(() => {
        // 翻回今天页，避免只读行的文案差异
        const manager = window.todayDraftsManagerRef;
        if (manager) manager.viewDay = manager.items[0]?.day || manager.viewDay;
    }).catch(() => {});
    // 直接回到今天：左滑一次翻回（newer）
    const backX = pager.x + pager.width * 0.65;
    await page.mouse.move(backX, startY);
    await page.mouse.down();
    await page.mouse.move(backX - 300, startY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const rowBox = await page.locator('#today-drafts-base [data-today-draft-id="t1"]').boundingBox();
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
    await page.waitForTimeout(250);
    const hoverOpacity = await page.$eval('#today-drafts-base [data-today-draft-id="t1"] [data-today-draft-copy]', el => getComputedStyle(el).opacity);
    assert.equal(Number(hoverOpacity), 1, 'copy button must be revealed on row hover');
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    const idleOpacity = await page.$eval('#today-drafts-base [data-today-draft-id="t1"] [data-today-draft-copy]', el => getComputedStyle(el).opacity);
    assert.equal(Number(idleOpacity), 0, 'copy button must stay hidden when not hovering');

    await page.hover('#today-drafts-base [data-today-draft-id="t1"] [data-today-draft-text-display]');
    await page.click('#today-drafts-base [data-today-draft-id="t1"] [data-today-draft-copy]');
    await page.waitForTimeout(300);
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clipboardText, '测试一下', 'copy button must write the draft text to the clipboard');
    const toastText = await page.$eval('.toast.success', el => el.textContent);
    assert.ok(toastText.includes('已复制'), `copy must surface a success toast, got: ${toastText}`);
    const successShown = await page.$eval('#today-drafts-base [data-today-draft-id="t1"] [data-today-draft-copy]', el => el.classList.contains('is-copy-success'));
    assert.equal(successShown, true, 'copy success must swap the icon to the checkmark');

    // ---- 4b. 触摸长按行：唤出操作菜单（真实指针管线 + 真实捕获时序） ----
    const longPress = await page.evaluate(async () => {
        const row = document.querySelector('#today-drafts-base [data-today-draft-id="t2"]');
        const rect = row.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const options = { bubbles: true, cancelable: true, composed: true, pointerId: 7, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y };
        row.dispatchEvent(new PointerEvent('pointerdown', options));
        await new Promise(resolve => setTimeout(resolve, 560));
        const menu = document.querySelector('.tdam');
        const open = Boolean(menu && !menu.hidden);
        const actions = [...document.querySelectorAll('.tdam__btn')].map(button => button.dataset.tdamAction);
        const highlighted = row.classList.contains('is-menu-target');
        // 松手不关菜单：菜单要留在原地等用户选动作
        row.dispatchEvent(new PointerEvent('pointerup', options));
        await new Promise(resolve => setTimeout(resolve, 80));
        const stillOpen = Boolean(document.querySelector('.tdam') && !document.querySelector('.tdam').hidden);
        return { open, actions, highlighted, stillOpen };
    });
    assert.equal(longPress.open, true, 'holding still on a row must open the action menu');
    assert.equal(longPress.highlighted, true, 'the row under the menu must highlight');
    assert.deepEqual(longPress.actions, ['copy', 'thought', 'article', 'plan', 'delete'],
        'the today menu offers copy, Thought, article, the plan placeholder and delete');
    assert.equal(longPress.stillOpen, true, 'lifting the finger must not close the menu');

    await page.click('.tdam__btn[data-tdam-action="copy"]');
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'WiFi和我',
        'the menu copy action must write that draft into the clipboard');
    assert.equal(await page.evaluate(() => {
        const menu = document.querySelector('.tdam');
        return !menu || menu.hidden;
    }), true, 'choosing an action must close the menu');
    assert.equal(await page.$eval('#today-drafts-base [data-today-draft-id="t2"]', row => row.classList.contains('is-menu-target')), false,
        'closing the menu must clear the row highlight');

    // ---- 4c. 长按后横向拖动即取消：横拖只翻页，不会弹出菜单 ----
    const dragCancel = await page.evaluate(async () => {
        const row = document.querySelector('#today-drafts-base [data-today-draft-id="t2"]');
        const rect = row.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const options = { bubbles: true, cancelable: true, composed: true, pointerId: 9, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y };
        row.dispatchEvent(new PointerEvent('pointerdown', options));
        row.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: x + 26 }));
        await new Promise(resolve => setTimeout(resolve, 560));
        const menu = document.querySelector('.tdam');
        const opened = Boolean(menu && !menu.hidden);
        row.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: x + 26 }));
        return opened;
    });
    assert.equal(dragCancel, false, 'moving past the tolerance must cancel the long-press instead of opening the menu');

    assert.deepEqual(errors, [], 'no page errors expected');
    await browser.close();
    listener.close();
    console.log('Today drafts taps browser regression passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
