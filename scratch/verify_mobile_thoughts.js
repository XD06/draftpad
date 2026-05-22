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
        viewport: { width: 375, height: 667 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
        hasTouch: true
    });
    const page = await context.newPage();

    console.log('Navigating to http://localhost:10003/#thoughts ...');
    await page.goto('http://localhost:10003/#thoughts');

    await page.waitForTimeout(1000);
    let url = page.url();
    console.log('Current URL:', url);

    if (url.includes('/login')) {
        console.log('Logging in with PIN 666666...');
        await page.waitForSelector('.pin-digit');
        const pinDigits = await page.locator('.pin-digit').all();
        console.log('Found PIN input digits:', pinDigits.length);
        const pin = '666666';
        for (let i = 0; i < pinDigits.length && i < pin.length; i++) {
            await pinDigits[i].fill(pin[i]);
            await page.waitForTimeout(100);
        }
        await page.waitForTimeout(2000);
        console.log('URL after login:', page.url());
    }

    await page.goto('http://localhost:10003/#thoughts');
    await page.waitForTimeout(1500);

    // Step 1: Initial state (collapsed search header, search-toggle-btn visible)
    await page.screenshot({ path: path.join(scratchDir, 'step1_initial.png') });
    console.log('Screenshot step1_initial.png saved.');

    const isSearchToggleVisible = await page.isVisible('#thoughts-search-toggle');
    console.log('Search toggle button visible:', isSearchToggleVisible);

    const headerBox = await page.locator('.thoughts-header-actions').boundingBox();
    console.log('Header actions box height (collapsed):', headerBox ? headerBox.height : 'null');

    // Step 2: Click search-toggle-btn
    console.log('Clicking search-toggle-btn...');
    await page.click('#thoughts-search-toggle');
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(scratchDir, 'step2_expanded.png') });
    console.log('Screenshot step2_expanded.png saved.');

    const toggleOpacity = await page.evaluate(() => {
        const btn = document.getElementById('thoughts-search-toggle');
        const style = window.getComputedStyle(btn);
        return {
            opacity: style.opacity,
            visibility: style.visibility,
            pointerEvents: style.pointerEvents
        };
    });
    console.log('Search toggle button computed style:', toggleOpacity);

    const headerBoxExpanded = await page.locator('.thoughts-header-actions').boundingBox();
    console.log('Header actions box height (expanded):', headerBoxExpanded ? headerBoxExpanded.height : 'null');

    // Step 3: Click inside thoughts-header-actions
    console.log('Clicking inside thoughts-header-actions...');
    await page.click('#thoughts-search-input');
    await page.waitForTimeout(300);
    const headerBoxAfterInsideClick = await page.locator('.thoughts-header-actions').boundingBox();
    console.log('Header actions box height after inside click:', headerBoxAfterInsideClick ? headerBoxAfterInsideClick.height : 'null');

    // Step 4: Click outside (click thoughts-timeline)
    console.log('Clicking outside thoughts-header-actions...');
    await page.click('#thoughts-timeline');
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(scratchDir, 'step4_collapsed.png') });
    console.log('Screenshot step4_collapsed.png saved.');

    const isSearchToggleVisibleAgain = await page.isVisible('#thoughts-search-toggle');
    console.log('Search toggle button visible again:', isSearchToggleVisibleAgain);

    const toggleOpacityAgain = await page.evaluate(() => {
        const btn = document.getElementById('thoughts-search-toggle');
        const style = window.getComputedStyle(btn);
        return style.opacity;
    });
    console.log('Search toggle button opacity again:', toggleOpacityAgain);

    await browser.close();
}

run().catch(console.error);
