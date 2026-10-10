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

module.exports = async function testTodayDraftsFlip(browser) {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    let fixtureItems = [
        { id: 'd-older', text: '前天的草稿记录', completed: true, day: localDayKey(2), createdAt: Date.now() - 172800000 },
        { id: 'd-yest', text: '昨天的草稿记录，包含重点备忘', completed: false, day: localDayKey(1), createdAt: Date.now() - 86400000 },
        { id: 'd-today', text: '今天的草稿任务', completed: false, day: localDayKey(0), createdAt: Date.now() }
    ];

    // Serve public
    app.get('/api/config', (_req, res) => res.json({ hiddenFloatingActions: [] }));
    app.get('/api/today-drafts', (_req, res) => res.json({ day: localDayKey(0), items: fixtureItems }));
    app.use(express.static(path.join(root, 'public')));

    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/#today`);
        await page.waitForTimeout(500);

        const pager = await page.$('#today-drafts-pager');
        assert.ok(pager, 'today drafts pager must exist');

        const box = await pager.boundingBox();
        assert.ok(box && box.width > 200, 'pager bounding box must have width');

        // 右滑（deltaX > 0）：掀页看更早历史（阅读类方向语义）
        const startX = box.x + box.width * 0.3;
        const startY = box.y + box.height * 0.55;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 280, startY, { steps: 12 });
        await page.waitForTimeout(120);

        // Measure curl state during drag
        const midFlip = await page.evaluate(() => {
            const staticLayer = document.getElementById('today-drafts-flip-static');
            const flap = document.getElementById('today-drafts-flip-flap');
            const crease = document.getElementById('today-drafts-flip-crease');
            const curl = document.getElementById('today-drafts-flip-curl');
            const shadow = document.getElementById('today-drafts-flip-shadow');
            return {
                staticHidden: staticLayer ? staticLayer.hidden : true,
                staticClip: staticLayer ? staticLayer.style.clipPath : '',
                staticHasCard: Boolean(staticLayer?.classList.contains('today-drafts-sheet')),
                headerTurns: Boolean(staticLayer?.querySelector('.today-drafts-header h2')),
                flapHidden: flap ? flap.hidden : true,
                flapTransform: flap ? flap.style.transform : '',
                flapClip: flap ? flap.style.clipPath : '',
                creaseOpacity: crease ? Number(crease.style.opacity || 0) : 0,
                shadowWidth: shadow ? parseFloat(shadow.style.width || '0') : 0,
                curlWidth: curl ? parseFloat(curl.style.width || '0') : 0
            };
        });

        assert.strictEqual(midFlip.staticHidden, false, 'static copy must be visible mid-flip');
        assert.strictEqual(midFlip.flapHidden, false, 'mirrored back face must be visible mid-flip');
        assert.ok(midFlip.staticClip.startsWith('inset('), 'static copy must be clipped by the moving crease');
        assert.ok(midFlip.flapTransform.includes('scaleX(-1)'), 'back face must mirror the sheet around the crease');
        assert.ok(midFlip.flapClip.startsWith('inset('), 'back face must show only the curl strip');
        assert.ok(midFlip.creaseOpacity > 0, 'fold crease line must be visible mid-flip');
        assert.ok(midFlip.curlWidth > 0, 'curl strip must have width mid-flip');
        assert.ok(midFlip.shadowWidth > 0, 'feathered drop shadow must be active mid-flip');
        assert.ok(midFlip.staticHasCard, 'the turning copy must look like the full paper card');
        assert.ok(midFlip.headerTurns, 'the title must turn together with the page');

        // Capture screenshot of the curl mid-flip
        const previewPath = path.join(root, 'test', 'browser', 'page_flip_curl_preview.png');
        await page.screenshot({ path: previewPath });

        // Release mouse to complete the flip
        await page.mouse.up();
        await page.waitForTimeout(600);

        // Verify page flip committed to previous day (yesterday)
        const viewDay = await page.evaluate(() => {
            const eyebrow = document.getElementById('today-drafts-eyebrow');
            return eyebrow ? eyebrow.textContent : '';
        });
        assert.ok(viewDay.includes('yest'), 'rightward flip must have committed to yesterday');

        // Now test flipping back to today: drag from right to left (deltaX < 0)
        const startXReturn = box.x + box.width * 0.7;
        const startYReturn = box.y + box.height * 0.55;

        await page.mouse.move(startXReturn, startYReturn);
        await page.mouse.down();
        await page.mouse.move(startXReturn - 280, startYReturn, { steps: 12 });
        await page.waitForTimeout(120);

        // Verify the returning sheet is visible and mirroring around the crease
        const returnState = await page.evaluate(() => {
            const flap = document.getElementById('today-drafts-flip-flap');
            const writingArea = flap?.querySelector('.today-drafts-writing-area');
            return {
                flapHidden: flap ? flap.hidden : true,
                flapTransform: flap ? flap.style.transform : '',
                paperTexture: writingArea ? getComputedStyle(writingArea).backgroundImage : ''
            };
        });
        assert.strictEqual(returnState.flapHidden, false, 'returning sheet must be visible during the return gesture');
        assert.ok(returnState.flapTransform.includes('scaleX(-1)'), 'returning sheet must mirror around the crease');
        assert.ok(returnState.paperTexture.includes('repeating-linear-gradient'), `the moving paper must retain its ruled texture, got ${returnState.paperTexture}`);

        await page.mouse.up();
        await page.waitForTimeout(600);

        const restoredDay = await page.evaluate(() => {
            const eyebrow = document.getElementById('today-drafts-eyebrow');
            return eyebrow ? eyebrow.textContent : '';
        });
        assert.ok(restoredDay.includes('today'), 'leftward flip must have restored view to today');

        fixtureItems = [
            { id: 'd-older', text: '前天的草稿记录', completed: true, day: localDayKey(2), createdAt: Date.now() - 172800000 },
            { id: 'd-yest', text: '昨天的草稿记录', completed: false, day: localDayKey(1), createdAt: Date.now() - 86400000 },
            { id: 'd-long', text: '很长的今日草稿内容。'.repeat(1200), completed: false, day: localDayKey(0), createdAt: Date.now() }
        ];
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.waitForTimeout(500);
        const longBox = await page.locator('#today-drafts-pager').boundingBox();
        const longStartX = longBox.x + longBox.width * 0.05;
        const longStartY = longBox.y + longBox.height * 0.55;
        await page.mouse.move(longStartX, longStartY);
        await page.mouse.down();
        await page.mouse.move(longStartX + 280, longStartY, { steps: 12 });
        await page.waitForTimeout(120);
        const liteFlap = await page.evaluate(() => {
            const flap = document.getElementById('today-drafts-flip-flap');
            return {
                lite: flap?.classList.contains('is-lite'),
                childCount: flap?.children.length,
                paperTexture: getComputedStyle(flap).backgroundImage
            };
        });
        assert.equal(liteFlap.lite, true, 'very long page uses the lightweight paper back');
        assert.equal(liteFlap.childCount, 0, 'lightweight paper back does not duplicate long draft content');
        assert.ok(liteFlap.paperTexture.includes('repeating-linear-gradient'), 'lightweight paper back retains ruled paper texture');
        await page.mouse.up();
        await page.waitForTimeout(500);

        assert.deepEqual(errors, []);
        console.log('Today drafts flip browser regression passed');
    } finally {
        await page.close();
        await new Promise(resolve => server.close(resolve));
    }
};

if (require.main === module) {
    (async () => {
        const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try { await module.exports(browser); } finally { await browser.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
