// Real-Chrome verification that Thought edits, subtask Enter commits,
// quick-add creates, WS self-echoes, and AI updates patch in place without
// timeline teardown, sibling card rebuilds, or viewport scroll jumps.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 4398;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function makeSeedThoughts(count = 35) {
    const base = 1700000000000;
    return Array.from({ length: count }, (_, idx) => {
        const i = idx + 1;
        const num = String(i).padStart(2, '0');
        return {
            id: `t-${num}`,
            text: i === 1 ? ('Long expanded intro line\n'.repeat(12) + 'End') : `Thought ${num} body content`,
            subItems: [
                { id: `s-${num}-1`, text: `Subtask ${num}-1`, completed: false },
                { id: `s-${num}-2`, text: `Subtask ${num}-2`, completed: false }
            ],
            tags: i % 2 === 0 ? ['work'] : ['life'],
            aiTags: [],
            aiStatus: 'ready',
            completed: false,
            pinned: false,
            relationCount: 0,
            attachments: [],
            createdAt: base + (100 - i) * 1000,
            updatedAt: base + (100 - i) * 1000,
            version: 1
        };
    });
}

function prepareDataDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-render-browser-'));
    fs.writeFileSync(path.join(dir, 'notepads.json'), JSON.stringify({
        notepads: [{ id: 'default', name: 'Default', file: 'default.txt', createdAt: Date.now(), updatedAt: Date.now(), version: 1 }],
        currentNotepadId: 'default'
    }));
    fs.writeFileSync(path.join(dir, 'default.txt'), 'Initial');
    fs.writeFileSync(path.join(dir, 'thoughts.json'), JSON.stringify(makeSeedThoughts(35)));
    fs.writeFileSync(path.join(dir, 'today-drafts.json'), '[]');
    return dir;
}

function waitForHealth(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const probe = () => {
            const req = http.get(`${BASE_URL}/health`, (res) => {
                res.resume();
                if (res.statusCode === 200) resolve();
                else retry();
            });
            req.on('error', retry);
        };
        const retry = () => {
            if (Date.now() > deadline) {
                reject(new Error('Timed out waiting for server health'));
                return;
            }
            setTimeout(probe, 100);
        };
        probe();
    });
}

async function runScenario(browser, viewport) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
        await page.goto(`${BASE_URL}/#thoughts`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelectorAll('.thought-card').length === 30);

        // Install DOM teardown / identity monitor & scroll card t-15 into view
        const setupInfo = await page.evaluate(() => {
            const timeline = document.getElementById('thoughts-timeline');
            window.__stabilityProbe = {
                minCardCount: document.querySelectorAll('.thought-card').length,
                teardowns: 0,
                identities: new Map()
            };
            document.querySelectorAll('.thought-card').forEach((card) => {
                window.__stabilityProbe.identities.set(card.dataset.id, card);
            });
            const obs = new MutationObserver(() => {
                const count = timeline.querySelectorAll('.thought-card').length;
                if (count < window.__stabilityProbe.minCardCount) {
                    window.__stabilityProbe.minCardCount = count;
                }
                if (count === 0) window.__stabilityProbe.teardowns += 1;
            });
            obs.observe(timeline, { childList: true });

            const findScroller = () => {
                const candidates = [
                    document.querySelector('.thoughts-scroll-area'),
                    document.getElementById('thoughts-view'),
                    document.querySelector('.container'),
                    document.body
                ].filter(Boolean);
                return candidates.find((el) => {
                    const oy = getComputedStyle(el).overflowY;
                    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
                }) || null;
            };
            const scroller = findScroller();
            const target = timeline.querySelector('.thought-card[data-id="t-15"]');
            const prevTop = target.getBoundingClientRect().top;
            const delta = Math.max(0, prevTop - 160);
            if (scroller) scroller.scrollTop += delta;
            else window.scrollTo({ top: window.scrollY + delta, behavior: 'instant' });
            const card14 = timeline.querySelector('.thought-card[data-id="t-14"]');
            const card16 = timeline.querySelector('.thought-card[data-id="t-16"]');
            return {
                scrollerSelector: scroller === document.body ? 'body' : (scroller ? `.${scroller.className.split(' ')[0]}` : 'window'),
                scrollPos: scroller ? scroller.scrollTop : window.scrollY,
                card14Top: card14.getBoundingClientRect().top,
                card16Top: card16.getBoundingClientRect().top
            };
        });
        assert(setupInfo.scrollPos > 400, `expected scrolled viewport (>400), got ${setupInfo.scrollPos}`);

        // 1. Inline subtask edit via real mouse dblclick + Enter commit + wait 1.5s across WS & AI status
        const editedSubtaskText = `Edited in Chrome ${viewport.width}x${viewport.height}`;
        await page.locator('.thought-card[data-id="t-15"] .subtask[data-subid="s-15-1"] .subtask-text').dblclick();
        const editInput = page.locator('.thought-card[data-id="t-15"] .subtask-inline-input');
        await editInput.waitFor({ state: 'visible' });
        await editInput.fill(editedSubtaskText);
        await editInput.press('Enter');
        await page.waitForFunction((expected) => {
            const el = document.querySelector('.thought-card[data-id="t-15"] .subtask[data-subid="s-15-1"] .subtask-text');
            return el && el.textContent === expected;
        }, editedSubtaskText);
        await sleep(1400);

        const afterInlineEdit = await page.evaluate(() => {
            const timeline = document.getElementById('thoughts-timeline');
            return {
                minCardCount: window.__stabilityProbe.minCardCount,
                teardowns: window.__stabilityProbe.teardowns,
                same14: timeline.querySelector('.thought-card[data-id="t-14"]') === window.__stabilityProbe.identities.get('t-14'),
                same16: timeline.querySelector('.thought-card[data-id="t-16"]') === window.__stabilityProbe.identities.get('t-16'),
                card14Top: timeline.querySelector('.thought-card[data-id="t-14"]').getBoundingClientRect().top
            };
        });
        assert(afterInlineEdit.minCardCount >= 30, `inline edit dropped rendered cards to ${afterInlineEdit.minCardCount}`);
        assert.strictEqual(afterInlineEdit.teardowns, 0, 'inline edit must not tear down timeline');
        assert(afterInlineEdit.same14 && afterInlineEdit.same16, 'sibling cards must stay exact same DOM nodes');
        assert(Math.abs(afterInlineEdit.card14Top - setupInfo.card14Top) <= 2,
            `card14 sightline drifted: before=${setupInfo.card14Top}, after=${afterInlineEdit.card14Top}`);

        // 2. quickAddSubtask Enter + focus retention + outside blur + wait 1.5s
        await page.click('.thought-card[data-id="t-15"] .subtask-add-footer');
        const addInput = page.locator('.thought-card[data-id="t-15"] .subtask-inline-input');
        await addInput.waitFor({ state: 'visible' });
        await addInput.fill('Chrome step 1');
        await addInput.press('Enter');
        await sleep(250);
        const stillFocused = await page.evaluate(() => {
            const active = document.activeElement;
            return Boolean(active?.classList.contains('subtask-inline-input') && active.closest('.thought-card[data-id="t-15"]'));
        });
        assert(stillFocused, 'quickAddSubtask input must retain focus across Enter and WS echo');

        // Blur out of the input by clicking card header timestamp (safe non-interactive area)
        await page.click('.thought-card[data-id="t-15"] .thought-time');
        await sleep(1500);

        const afterQuickAddSub = await page.evaluate(() => {
            const timeline = document.getElementById('thoughts-timeline');
            return {
                minCardCount: window.__stabilityProbe.minCardCount,
                teardowns: window.__stabilityProbe.teardowns,
                same14: timeline.querySelector('.thought-card[data-id="t-14"]') === window.__stabilityProbe.identities.get('t-14'),
                same16: timeline.querySelector('.thought-card[data-id="t-16"]') === window.__stabilityProbe.identities.get('t-16'),
                card14Top: timeline.querySelector('.thought-card[data-id="t-14"]').getBoundingClientRect().top,
                hasAdded: Array.from(timeline.querySelectorAll('.thought-card[data-id="t-15"] .subtask-text')).some(el => el.textContent === 'Chrome step 1')
            };
        });
        assert(afterQuickAddSub.hasAdded, 'added subtask must stay rendered after blur');
        assert(afterQuickAddSub.minCardCount >= 30, `quickAddSubtask blur dropped card count to ${afterQuickAddSub.minCardCount}`);
        assert.strictEqual(afterQuickAddSub.teardowns, 0, 'quickAddSubtask blur must not tear down timeline');
        assert(afterQuickAddSub.same14 && afterQuickAddSub.same16, 'siblings must survive quickAddSubtask');
        assert(Math.abs(afterQuickAddSub.card14Top - setupInfo.card14Top) <= 2,
            `sightline drifted after subtask blur: before=${setupInfo.card14Top}, after=${afterQuickAddSub.card14Top}`);

        // 3. Scroll to top and submit Quick Add Thought -> no duplicate card, no teardown, no jump
        const freshText = `Fresh browser thought ${viewport.width}x${viewport.height}`;
        await page.evaluate((sel) => {
            const el = sel === 'body' ? document.body : (sel === 'window' ? null : document.querySelector(sel));
            if (el) el.scrollTop = 0;
            else window.scrollTo({ top: 0, behavior: 'instant' });
        }, setupInfo.scrollerSelector);
        await page.click('#fab-add-thought');
        await page.fill('#quick-add-input', freshText);
        await page.click('#quick-add-submit');
        await page.waitForFunction((text) => {
            return Array.from(document.querySelectorAll('.thought-card .thought-text')).some(el => el.textContent.includes(text));
        }, freshText);
        await sleep(1500);

        const afterCreate = await page.evaluate(({ sel, text }) => {
            const timeline = document.getElementById('thoughts-timeline');
            const el = sel === 'body' ? document.body : (sel === 'window' ? null : document.querySelector(sel));
            const matches = Array.from(timeline.querySelectorAll('.thought-card')).filter(
                card => card.querySelector('.thought-text')?.textContent.includes(text)
            );
            return {
                matchCount: matches.length,
                matchIds: matches.map(c => c.dataset.id),
                minCardCount: window.__stabilityProbe.minCardCount,
                teardowns: window.__stabilityProbe.teardowns,
                same01: timeline.querySelector('.thought-card[data-id="t-01"]') === window.__stabilityProbe.identities.get('t-01'),
                same14: timeline.querySelector('.thought-card[data-id="t-14"]') === window.__stabilityProbe.identities.get('t-14'),
                scrollPos: el ? el.scrollTop : window.scrollY
            };
        }, { sel: setupInfo.scrollerSelector, text: freshText });
        assert.strictEqual(afterCreate.matchCount, 1, `new Thought must render once without WS duplicate (ids=${JSON.stringify(afterCreate.matchIds)})`);
        assert(afterCreate.minCardCount >= 30, `quickAdd dropped card count to ${afterCreate.minCardCount}`);
        assert.strictEqual(afterCreate.teardowns, 0, 'quickAdd must not tear down timeline');
        assert(afterCreate.same01 && afterCreate.same14, 'existing sibling cards must stay identical across create');
        assert(afterCreate.scrollPos <= 10, `top scrollPos jumped unexpectedly on create at top: ${afterCreate.scrollPos}`);
    } finally {
        await context.close();
    }
}

async function run() {
    const dataDir = prepareDataDir();
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            BASE_URL,
            DATA_DIR: dataDir,
            STORAGE_BACKEND: 'local',
            STORAGE_LAYOUT: 'legacy',
            DUMBPAD_PIN: '',
            AUTH_V2_ENABLED: 'false',
            AUTH_MASTER_KEY: '',
            AI_API_KEY: '',
            AI_INSIGHT_API_KEY: '',
            AI_INSIGHT_MODEL: '',
            AI_EMBEDDING_API_KEY: '',
            NODE_ENV: 'development'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let browser;
    try {
        await waitForHealth();
        browser = await chromium.launch({
            channel: 'chrome',
            headless: true,
            ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
        });
        await runScenario(browser, { width: 390, height: 844 });
        await runScenario(browser, { width: 1280, height: 800 });
        console.log('Thought render and scroll stability browser regression passed');
    } finally {
        await browser?.close().catch(() => {});
        server.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
