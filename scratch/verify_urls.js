const { chromium } = require('C:/Users/dsk/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');
const path = require('path');
const fs = require('fs');

async function run() {
    const scratchDir = 'C:/Users/dsk/.gemini/antigravity/brain/4aa519b2-12d9-42e0-9a0f-abbf6af5ed43/scratch';
    if (!fs.existsSync(scratchDir)) {
        fs.mkdirSync(scratchDir, { recursive: true });
    }

    const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    let executablePath = null;
    for (const p of chromePaths) {
        if (fs.existsSync(p)) {
            executablePath = p;
            break;
        }
    }
    console.log('Using browser executable:', executablePath);

    const browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({
        viewport: { width: 1000, height: 1000 }
    });
    const page = await context.newPage();

    console.log('Navigating to http://localhost:10003/#thoughts ...');
    await page.goto('http://localhost:10003/#thoughts');
    await page.waitForTimeout(1000);

    const url = page.url();
    if (url.includes('/login')) {
        console.log('Logging in with PIN 666666...');
        const inputs = await page.$$('.pin-digit');
        if (inputs.length > 0) {
            for (let i = 0; i < inputs.length; i++) {
                await inputs[i].fill('6');
                await page.waitForTimeout(50);
            }
        } else {
            await page.fill('input', '666666');
        }
        await page.waitForTimeout(2000);
    }

    await page.goto('http://localhost:10003/#thoughts');
    await page.waitForTimeout(2000);

    // 1. Add a thought with URLs in main task and subtasks
    console.log('Opening quick add...');
    await page.click('#fab-add-thought');
    await page.waitForSelector('#quick-add-input', { state: 'visible' });

    console.log('Entering text with links...');
    const textContent = `Test main task link http://example.com/main and www.example.com/main2.
- [ ] Subtask 1 http://example.com/sub1
- [ ] Subtask 2 www.example.com/sub2`;
    
    await page.fill('#quick-add-input', textContent);
    await page.waitForTimeout(500);

    console.log('Submitting...');
    await page.click('#quick-add-submit');
    await page.waitForTimeout(1500);

    // 2. Locate the newly created card
    const firstCard = page.locator('.thought-card').first();
    await page.screenshot({ path: path.join(scratchDir, '1_thought_added.png') });
    console.log('Screenshot of added thought saved to 1_thought_added.png');

    // 3. Verify links exist in the main task text
    const mainLinks = firstCard.locator('.thought-text a.thought-link');
    const mainLinksCount = await mainLinks.count();
    console.log(`Found ${mainLinksCount} links in main task text`);
    for (let i = 0; i < mainLinksCount; i++) {
        const link = mainLinks.nth(i);
        const href = await link.getAttribute('href');
        const target = await link.getAttribute('target');
        const text = await link.innerText();
        console.log(`  Main link ${i}: href="${href}" target="${target}" text="${text}"`);
    }

    // 4. Verify links exist in the subtask labels
    const subLinks = firstCard.locator('.subtask-text a.thought-link');
    const subLinksCount = await subLinks.count();
    console.log(`Found ${subLinksCount} links in subtask text`);
    for (let i = 0; i < subLinksCount; i++) {
        const link = subLinks.nth(i);
        const href = await link.getAttribute('href');
        const target = await link.getAttribute('target');
        const text = await link.innerText();
        console.log(`  Subtask link ${i}: href="${href}" target="${target}" text="${text}"`);
    }

    // 5. Verify clicking a link does not trigger card expansion
    const isExpandedBefore = await firstCard.evaluate(el => el.classList.contains('expanded'));
    console.log('Card expanded before link click:', isExpandedBefore);

    // Click the first link in main text
    console.log('Clicking the link in main text...');
    await mainLinks.first().click();
    await page.waitForTimeout(500);

    const isExpandedAfter = await firstCard.evaluate(el => el.classList.contains('expanded'));
    console.log('Card expanded after link click:', isExpandedAfter);

    if (isExpandedBefore === isExpandedAfter) {
        console.log('SUCCESS: Click on link did not expand/collapse the card!');
    } else {
        console.error('FAILURE: Click on link changed card expansion state!');
    }

    // 6. Test search highlight functionality
    console.log('Typing "example" into search to test highlights...');
    await page.fill('#thoughts-search-input', 'example');
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(scratchDir, '2_search_highlighted.png') });
    console.log('Screenshot of highlighted links saved to 2_search_highlighted.png');

    // Verify marks exist inside the link
    const linkMarks = firstCard.locator('.thought-text a.thought-link mark.thought-highlight');
    const marksCount = await linkMarks.count();
    console.log(`Found ${marksCount} highlight marks inside the main link`);

    const linkHref = await mainLinks.first().getAttribute('href');
    console.log(`First link href after search/highlight is: "${linkHref}"`);
    if (linkHref === 'http://example.com/main') {
        console.log('SUCCESS: Search highlighting did not corrupt the href attribute!');
    } else {
        console.error(`FAILURE: Search highlighting corrupted href! Current href: ${linkHref}`);
    }

    await browser.close();
}

run().catch(console.error);
