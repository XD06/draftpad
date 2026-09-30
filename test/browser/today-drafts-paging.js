/**
 * 今日草稿分页的真机回归：jsdom 量不到换行与纸高，所以「一天超过一张纸」只能在
 * 真实布局里证明。钉住三件事：
 * 1) 纸面上不吞内容——每一页都完整落在书写区内，不需要滚动（旧的 overflow:hidden
 *    把超出纸面的行剪掉，用户完全看不见，这是本次改动要修的用户可见缺陷）；
 * 2) 翻页序列完整且有序：把当天所有页依次翻完，行 id 拼起来正好等于当天的草稿
 *    顺序，不重、不漏、不乱；跨日边界仍接得上；
 * 3) 单条草稿比一张纸还高时，那一页允许纵向滚动兜住尾巴；
 * 4) 手势归属：行中间起笔的短滑归行（删除 / 转 Thought），行两端 32px 内起笔或
 *    横扫过纸宽 45% 的长扫归翻页，页眉「N/M」按钮点一下翻向更新的一页
 *    （末页回到第 1 页，单日一页时禁用）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function localDayKey(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() - offsetDays);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

const LONG_TAIL = '这一条要写得足够长，好让它自己就超出整张纸，真机回归才能验证纵向滚动兜底。'.repeat(24);
const NEW_TEXT = '刚敲下来的新草稿，内容特意长一些，看看新增之后视图会不会跟到它所在的那一页。';

function buildItems() {
    const items = [{ id: 'y1', text: '昨天的草稿', completed: false, day: localDayKey(1), createdAt: Date.now() - 86400000 }];
    for (let index = 1; index <= 18; index += 1) {
        items.push({
            id: `t${index}`,
            text: index % 4 === 0 ? `第 ${index} 条草稿，内容长一些以便多占几条纸纹，换行之后继续写在同一张纸上。` : `第 ${index} 条草稿`,
            completed: false,
            day: localDayKey(0),
            createdAt: Date.now() - (20 - index) * 60000
        });
    }
    return items;
}

function startServer(items) {
    const app = express();
    const echo = (req, res) => res.json({ draft: { id: req.params.id, ...(req.body || {}) }, version: 1 });
    app.get('/api/config', (_req, res) => res.json({ hiddenFloatingActions: [] }));
    app.get('/api/today-drafts', (_req, res) => res.json({ day: localDayKey(0), items }));
    app.put('/api/today-drafts/:id', express.json(), echo);
    app.delete('/api/today-drafts/:id', express.json(), echo);
    app.use(express.static(path.resolve(__dirname, '../..', 'public')));
    return new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve({ listener, port: listener.address().port }));
    });
}

function readSheet(page) {
    return page.evaluate(() => {
        const eyebrow = document.getElementById('today-drafts-eyebrow');
        const area = document.getElementById('today-drafts-writing-area');
        const rows = [...document.querySelectorAll('#today-drafts-base [data-today-draft-id]')];
        const label = (eyebrow?.textContent || '').trim();
        const parts = label.split('·').map(part => part.trim());
        // 「N/M」只在多页的那天才会追加：单日一页时末段是日期（9/30），别当分数读。
        const fraction = parts.length === 3 ? /^(\d+)\/(\d+)$/.exec(parts[2]) : null;
        const areaBox = area.getBoundingClientRect();
        const last = rows[rows.length - 1];
        return {
            day: parts[0],
            pageIndex: fraction ? Number(fraction[1]) : 1,
            pageCount: fraction ? Number(fraction[2]) : 1,
            eyebrowDisabled: eyebrow?.disabled === true,
            rowIds: rows.map(row => row.dataset.todayDraftId),
            lastRowText: last ? last.textContent : '',
            lastRowOnPaper: !last || last.getBoundingClientRect().bottom <= areaBox.bottom + 1,
            overflowing: area.classList.contains('is-overflowing'),
            scrollRoom: area.scrollHeight - area.clientHeight
        };
    });
}

function firstRowBox(page) {
    return page.evaluate(() => {
        const row = document.querySelector('#today-drafts-base [data-today-draft-id]');
        const rect = row?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    });
}

function eyebrowBox(page) {
    return page.evaluate(() => {
        const rect = document.getElementById('today-drafts-eyebrow')?.getBoundingClientRect();
        return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
    });
}

async function swipe(page, box, direction) {
    // 抓纸页眉那一横条：正文行已经铺满整张纸，而行的横向滑动仍归「删除 / 转 Thought」。
    const startY = box.y + 34;
    // 页眉的「N/M」是点按入口，不参与拖拽（手势会 setPointerCapture，随后的 click 被
    // 改派到捕获元素上），所以起笔点钉在它两侧外侧：左滑从右来、右滑从左来。
    const chip = await eyebrowBox(page);
    const startX = direction === 'newer' ? chip.right + 20 : chip.left - 20;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + (direction === 'newer' ? -300 : 300), startY, { steps: 12 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(650);
}

// 真手指的拖拽：playwright 的 mouse 走的是 pointerType=mouse，而行对鼠标拖拽是
// 让位给「选中文字」的，所以「中间归行 / 长横扫交棒」只能用合成 touch 事件证明。
async function touchDragOnRow(page, x, y, deltaX) {
    return page.evaluate(([startX, startY, dx]) => {
        const target = document.elementFromPoint(startX, startY);
        if (!target) return { found: false };
        const row = target.closest('[data-today-draft-id]');
        const fire = (type, clientX, node) => (node || target).dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 4242,
            pointerType: 'touch',
            isPrimary: true,
            clientX,
            clientY: startY
        }));
        fire('pointerdown', startX);
        fire('pointermove', startX + dx * 0.4);
        fire('pointermove', startX + dx);
        const state = {
            found: true,
            rowId: row?.dataset.todayDraftId || null,
            swiping: Boolean(row?.classList.contains('is-swiping')),
            swipeX: Number.parseFloat(row?.style.getPropertyValue('--today-draft-swipe-x') || '0') || 0,
            // 交棒之后翻页图层应该已经亮起（手指还没松开，折痕已经跟着走了）
            flipStarted: document.getElementById('today-drafts-flip-static')?.hidden === false
        };
        // 松手点按指尖现在的位置重新取元素：older 方向交棒时会重铺底页，原来那个行
        // 节点已经离开文档。真手指在 view.setPointerCapture 之后即使划到控件外面，
        // pointerup 也由浏览器改派到 view；合成的 touch 事件没有捕获，只能照同一条
        // 规则自己选目标。
        const view = document.getElementById('today-drafts-view');
        const underFinger = document.elementFromPoint(startX + dx, startY);
        fire('pointerup', startX + dx, underFinger && view?.contains(underFinger) ? underFinger : view);
        return state;
    }, [x, y, deltaX]);
}

async function dragFrom(page, x, y, deltaX) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + deltaX, y, { steps: 12 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(650);
}

// 点页码走的也是手势那套补间，落页在动画收尾的 render() 里才记账。
async function tapCounter(page) {
    await page.click('#today-drafts-eyebrow');
    await page.waitForTimeout(650);
}

async function openToday(browser, port) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.goto(`http://127.0.0.1:${port}/#today`);
    await page.waitForTimeout(600);
    return page;
}

module.exports = async function testTodayDraftsPaging(browser) {
    const { listener, port } = await startServer(buildItems());
    const errors = [];
    const page = await openToday(browser, port);
    page.on('pageerror', error => errors.push(error.message));

    try {
        const first = await readSheet(page);
        const todayIds = buildItems().filter(item => item.day === localDayKey(0)).map(item => item.id);
        assert.equal(first.day, 'today', 'the pager opens on today');
        assert.ok(first.pageCount >= 2, `18 drafts must span more than one sheet (got ${first.pageCount})`);
        assert.equal(first.pageIndex, 1, 'today starts on its first sheet');
        assert.ok(first.rowIds.length < todayIds.length, 'a sheet must not hold the whole day');
        assert.equal(first.overflowing, false, 'the first sheet fits the paper');

        const box = await (await page.$('#today-drafts-pager')).boundingBox();
        const seen = [...first.rowIds];
        for (let pageNumber = 2; pageNumber <= first.pageCount; pageNumber += 1) {
            await swipe(page, box, 'newer');
            const sheet = await readSheet(page);
            assert.equal(sheet.pageIndex, pageNumber, `left swipe walks to sheet ${pageNumber}`);
            assert.equal(sheet.day, 'today', 'page turns inside today stay on today');
            assert.equal(sheet.overflowing, false, `sheet ${pageNumber} must not need scrolling`);
            assert.ok(sheet.lastRowOnPaper, `every row of sheet ${pageNumber} is painted on the paper`);
            seen.push(...sheet.rowIds);
        }
        assert.deepEqual(seen, todayIds, 'every sheet of today, in order, covers each draft exactly once');

        // 今天最后一页再左滑就越界：边界橡皮筋，松手弹回原页
        const tail = await readSheet(page);
        await swipe(page, box, 'newer');
        assert.equal((await readSheet(page)).pageIndex, tail.pageIndex, 'the newest sheet refuses to flip past itself');

        // 逐页回到今天第一页，右滑的尽头仍是昨天
        for (let pageNumber = tail.pageIndex - 1; pageNumber >= 1; pageNumber -= 1) {
            await swipe(page, box, 'older');
            assert.equal((await readSheet(page)).pageIndex, pageNumber, `right swipe walks back to sheet ${pageNumber}`);
        }
        await swipe(page, box, 'older');
        const history = await readSheet(page);
        assert.equal(history.day, 'yest', 'the first sheet of today still hands over to the previous day');
        await swipe(page, box, 'newer');
        const returned = await readSheet(page);
        assert.equal(returned.day, 'today', 'flipping forward from history returns to today');
        assert.equal(returned.pageIndex, first.pageIndex, 'flipping forward from yesterday lands back on the sheet it came from');

        // 新增后自动跳到新条目所在页
        await page.click('#today-drafts-input');
        await page.keyboard.type(NEW_TEXT);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        const afterAdd = await readSheet(page);
        assert.equal(afterAdd.pageIndex, afterAdd.pageCount, 'the view follows the draft that was just added');
        assert.ok(afterAdd.lastRowText.includes(NEW_TEXT), `the last row of the opened sheet is the new draft: ${afterAdd.lastRowText}`);
        assert.ok(afterAdd.lastRowOnPaper, 'the sheet that received the new draft keeps it on the paper');

        // 正文行上的横向拖拽归行自己（触摸是删除 / 转 Thought，鼠标落在正文上退化成选中
        // 文字），翻页只认非行区域（页眉、纸边）的拖拽。放在最后检查：松手会顺带点开该行。
        const rowBox = await firstRowBox(page);
        const rowY = rowBox.y + rowBox.height / 2;
        const middleX = rowBox.x + rowBox.width * 0.5;
        await page.mouse.move(rowBox.x + rowBox.width * 0.7, rowY);
        await page.mouse.down();
        await page.mouse.move(rowBox.x + rowBox.width * 0.7 - 200, rowY, { steps: 10 });
        await page.waitForTimeout(120);
        const duringRowDrag = await readSheet(page);
        await page.mouse.up();
        assert.equal(duringRowDrag.pageIndex, afterAdd.pageIndex, 'dragging across the text of a row does not turn the sheet');

        // 手势归属的另一半：行内两端各 32px 起笔翻整页，中间留给行操作。
        // 草稿铺满整页时纸面几乎没有空白，没有这条带子就没有能翻页的落点。
        const middleDrag = await touchDragOnRow(page, middleX, rowY, -60);
        assert.ok(middleDrag.found && middleDrag.rowId, 'the middle of a row is still a draft row');
        assert.ok(middleDrag.swiping && middleDrag.swipeX < 0,
            `a touch drag from the middle of a row belongs to that row (swipeX=${middleDrag.swipeX})`);
        assert.equal((await readSheet(page)).pageIndex, afterAdd.pageIndex, 'the row-owned middle drag never turns the sheet');

        // 末页点页码 = 回到第 1 页，正好把视图送回可以试纸边拖拽的位置。
        await tapCounter(page);
        assert.equal((await readSheet(page)).pageIndex, 1, 'tapping the counter on the newest sheet returns to the first');

        const edgePoint = async () => {
            const box = await firstRowBox(page);
            return { x: box.x + box.width - 12, y: box.y + box.height / 2 };
        };
        const forward = await edgePoint();
        await dragFrom(page, forward.x, forward.y, -300);
        assert.equal((await readSheet(page)).pageIndex, 2, 'a drag that starts inside the right paper edge turns the sheet forward');
        const back = await edgePoint();
        await dragFrom(page, back.x, back.y, 300);
        assert.equal((await readSheet(page)).pageIndex, 1, 'the same edge band turns the sheet back as well');

        // 页眉「N/M」是看得见点得中的翻页入口，方向与左滑一致。
        await tapCounter(page);
        assert.equal((await readSheet(page)).pageIndex, 2, 'tapping the page counter turns to the next sheet');
        for (let guard = 0; guard < 12; guard += 1) {
            const sheet = await readSheet(page);
            if (sheet.pageIndex === sheet.pageCount) break;
            await tapCounter(page);
        }
        const newest = await readSheet(page);
        assert.equal(newest.pageIndex, newest.pageCount, 'the counter walks to the newest sheet');

        // 回到当天第一页，右滑才是跨日：日界仍然接在同一条页序列上。
        await tapCounter(page);
        assert.equal((await readSheet(page)).pageIndex, 1, 'the counter wraps back to the first sheet from the newest one');
        await swipe(page, box, 'older');
        const historySheet = await readSheet(page);
        assert.equal(historySheet.day, 'yest', 'the first sheet of a day still hands over to the previous day');
        assert.equal(historySheet.pageCount, 1, 'one draft is one sheet');
        assert.ok(historySheet.eyebrowDisabled, 'a sheet with nothing to turn does not offer the counter as a button');
        await swipe(page, box, 'newer');
        const backToToday = await readSheet(page);
        assert.equal(backToToday.day, 'today', 'history returns to today');
        assert.equal(backToToday.pageIndex, 1, 'history lands on the first sheet it left');

        // 区域划分：从行两端（边缘翻页热区）起笔翻整页，行中间起笔归行自身操作。
        // 起手定归属，动效绝不交棒串台。
        const sheet1 = await readSheet(page);
        const sweepRow = await firstRowBox(page);
        // 从行右端起笔向左扫：整页翻向下一页
        const edgeX = sweepRow.x + sweepRow.width - 20;
        const edgeY = sweepRow.y + sweepRow.height / 2;
        const forwardSweep = await touchDragOnRow(page, edgeX, edgeY, -(sweepRow.width * 0.5));
        assert.ok(forwardSweep.flipStarted, 'a sweep from the edge of a row turns the page directly');
        assert.ok(!forwardSweep.swiping, 'the row action strip is never triggered by an edge swipe');
        await page.waitForTimeout(700);
        assert.equal((await readSheet(page)).pageIndex, sheet1.pageIndex + 1, 'the edge sweep turned to the next sheet');

        // 从行左端起笔向右扫：整页翻回前一页
        const leftEdgeX = sweepRow.x + 20;
        const backSweep = await touchDragOnRow(page, leftEdgeX, edgeY, sweepRow.width * 0.5);
        assert.ok(backSweep.flipStarted, 'a sweep from the left edge turns the sheet back toward the older one');
        await page.waitForTimeout(700);
        const afterSweeps = await readSheet(page);
        assert.deepEqual(afterSweeps.rowIds, sheet1.rowIds,
            'edge page turns moved nothing but the sheet: no draft was deleted or turned into a Thought');

        // 行中间起笔：归行自身操作，绝不会在中途中断变成翻页
        const middleRow = await firstRowBox(page);
        const middleSwipe = await touchDragOnRow(page,
            middleRow.x + middleRow.width * 0.5, middleRow.y + middleRow.height / 2, middleRow.width * 0.36);
        assert.ok(middleSwipe.swiping && middleSwipe.rowId, 'a swipe from the middle is strictly owned by that row');
        assert.ok(!middleSwipe.flipStarted, 'a middle swipe never leaks into page flip');
        const confirmBtn = await page.waitForSelector('#confirmation-confirm', { timeout: 1500 }).catch(() => null);
        if (confirmBtn) await confirmBtn.click();
        await page.waitForTimeout(400);
        const afterDelete = await readSheet(page);
        assert.ok(!afterDelete.rowIds.includes(middleSwipe.rowId), 'the middle swipe still deletes exactly that draft');
        assert.equal(afterDelete.pageIndex, sheet1.pageIndex, 'the middle swipe never turned the sheet');

        assert.deepEqual(errors, []);
        console.log('Today drafts paging browser regression passed');
    } finally {
        await page.close();
        await new Promise(resolve => listener.close(resolve));
    }
};

async function runOverflowScenario(browser) {
    const { listener, port } = await startServer([
        { id: 'giant', text: LONG_TAIL, completed: false, day: localDayKey(0), createdAt: Date.now() }
    ]);
    const page = await openToday(browser, port);
    try {
        const sheet = await readSheet(page);
        assert.equal(sheet.pageCount, 1, 'a single draft owns one sheet however tall it is');
        assert.ok(sheet.overflowing, 'a draft taller than the paper marks the sheet as overflowing');
        assert.ok(sheet.scrollRoom > 0, `the overflowing sheet scrolls (${sheet.scrollRoom}px of room)`);
        const scrolled = await page.evaluate(() => {
            const area = document.getElementById('today-drafts-writing-area');
            area.scrollTop = area.scrollHeight;
            const rows = [...area.querySelectorAll('[data-today-draft-id]')];
            const last = rows[rows.length - 1];
            return {
                atBottom: area.scrollTop + area.clientHeight >= area.scrollHeight - 2,
                tailInViewport: Boolean(last) && last.getBoundingClientRect().bottom <= area.getBoundingClientRect().bottom + 1
            };
        });
        assert.ok(scrolled.atBottom, 'the tail of the draft is reachable by scrolling');
        assert.ok(scrolled.tailInViewport, 'the bottom of the overlong row really comes into view');
        console.log('Today drafts overflow fallback passed');
    } finally {
        await page.close();
        await new Promise(resolve => listener.close(resolve));
    }
}

if (require.main === module) {
    (async () => {
        const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
            await module.exports(browser);
            await runOverflowScenario(browser);
        } finally {
            await browser.close();
        }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
