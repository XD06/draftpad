const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function freePort() {
    return new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function waitForServer(child, port) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const attempt = async () => {
            if (child.exitCode !== null) {
                reject(new Error('server exited early'));
                return;
            }
            try {
                const res = await fetch(`http://127.0.0.1:${port}/health`);
                if (res.ok) { resolve(); return; }
            } catch { /* not ready yet */ }
            if (Date.now() > deadline) { reject(new Error('server did not become healthy')); return; }
            setTimeout(attempt, 300);
        };
        attempt();
    });
}

const pageErrors = [];

const step = message => console.log(`[step] ${new Date().toISOString()} ${message}`);

async function openPage(browser, port, label) {
    step(`openPage ${label} begin`);
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(`[${label}] ${error.message}`));
    page.on('console', msg => {
        if (msg.type() === 'error') pageErrors.push(`[${label} console] ${msg.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/#thoughts`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
        window.__wsEvents = [];
        window.addEventListener('thoughts_update', e => {
            window.__wsEvents.push(JSON.stringify(e.detail || {}).slice(0, 300));
        });
        try {
            const { ThoughtsManager } = await import('/managers/thoughts.js');
            const proto = ThoughtsManager.prototype;
            const orig = proto.handleSocketUpdate;
            proto.handleSocketUpdate = function (action, payload) {
                const idx = this.thoughts.findIndex(t => t.id === payload?.id);
                const target = idx >= 0 ? this.thoughts[idx] : null;
                window.__wsEvents.push(`[handler] action=${action} idx=${idx} localPending=${target?.localPending} syncConflict=${target?.syncConflict} v=${target?.version}->${payload?.version} subs=${JSON.stringify(target?.subItems?.length)}/${JSON.stringify(payload?.subItems?.length)}`);
                return orig.call(this, action, payload);
            };
        } catch (err) {
            window.__wsEvents.push(`[patch failed] ${err.message}`);
        }
    });
    await page.waitForFunction(() => {
        const view = document.getElementById('thoughts-view');
        return view && view.style.display !== 'none' && view.style.display !== '';
    }, null, { timeout: 15000 });
    await page.waitForFunction(() => Boolean(document.getElementById('fab-add-thought')), null, { timeout: 15000 });
    step(`openPage ${label} ready`);
    return page;
}

function cardLocator(page, text) {
    return page.locator(`.thought-card:has-text("${text}")`).first();
}

async function addSubtaskViaUi(page, thoughtText, subText) {
    const card = cardLocator(page, thoughtText);
    await card.locator('.subtask-add-inline').first().click();
    const input = card.locator('input[placeholder="新增子任务..."]').last();
    await input.fill(subText);
    await input.press('Enter');
}

async function outboxCount(page) {
    return page.evaluate(() => JSON.parse(localStorage.getItem('dumbpad_thoughts_outbox_v1') || '[]').length);
}

async function serverThought(page, text) {
    return page.evaluate(async (probe) => {
        const res = await fetch('/api/thoughts?format=page&sort=timeline&light=1&limit=50');
        const body = await res.json();
        return (body.items || []).find(item => item.text.includes(probe)) || null;
    }, text);
}

async function waitFor(page, fn, desc, timeout = 6000) {
    try {
        await page.waitForFunction(fn, null, { timeout, polling: 200 });
    } catch (err) {
        const state = await page.evaluate(() => ({
            wsEvents: window.__wsEvents || [],
            outbox: JSON.parse(localStorage.getItem('dumbpad_thoughts_outbox_v1') || '[]').map(i => ({
                kind: i.kind, thoughtId: i.thoughtId, state: i.state, baseVersion: i.body?.baseVersion
            })),
            cache: JSON.parse(localStorage.getItem('dumbpad_thoughts_cache_v1') || 'null')?.thoughts?.map(t => ({
                text: t.text, sub: t.subItems?.map(s => s.text), v: t.version, pending: !!t.localPending
            }))
        }));
        throw new Error(`timeout waiting for ${desc}\npage state: ${JSON.stringify(state, null, 2)}`);
    }
}

module.exports = async function testThoughtSync(browser) {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-sync-'));
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            DATA_DIR: dataDir,
            STORAGE_BACKEND: 'local',
            STORAGE_LAYOUT: 'legacy',
            DUMBPAD_PIN: '',
            AI_API_KEY: '',
            AI_INSIGHT_API_KEY: '',
            AI_EMBEDDING_API_KEY: '',
            NODE_ENV: 'development'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const logs = [];
    child.stdout.on('data', c => logs.push(String(c)));
    child.stderr.on('data', c => logs.push(String(c)));

    try {
        await waitForServer(child, port);
        step('server healthy');
        const pageA = await openPage(browser, port, 'A');
        const pageB = await openPage(browser, port, 'B');
        globalThis.__syncPages = { pageA, pageB };

        // 1. Create a thought on A; it must appear on B live (WebSocket push).
        await pageA.click('#fab-add-thought');
        await pageA.fill('#quick-add-input', 'sync-probe-thought');
        await pageA.click('#quick-add-submit');
        step('A created thought');
        await waitFor(pageA, () => document.body.textContent.includes('sync-probe-thought'), 'A shows created thought');
        await waitFor(pageB, () => document.body.textContent.includes('sync-probe-thought'), 'B receives create via WebSocket');
        step('create synced to B');

        // 2. A adds a subtask; B must receive it live. After Enter the inline
        // input keeps focus (keyboard continuity), so blur it to end the flow.
        await addSubtaskViaUi(pageA, 'sync-probe-thought', 'sub-from-A');
        assert(
            await pageA.evaluate(() => document.activeElement?.placeholder === '新增子任务...'),
            'the inline input must keep focus after an Enter commit (keyboard continuity)'
        );
        // The same input chains straight into the next entry without a rebuild.
        await pageA.keyboard.type('sub-from-A-chained');
        await pageA.keyboard.press('Enter');
        await pageA.evaluate(() => document.activeElement?.blur());
        step('A added subtasks (chained on one input)');
        await waitFor(pageB, () => document.body.textContent.includes('sub-from-A'), 'B receives subtask add from A live');
        step('subtask A synced to B live');

        // 3. Persistence: a fresh reload of B must show the same subtask.
        await pageB.reload();
        await waitFor(pageB, () => document.body.textContent.includes('sub-from-A'), 'B shows subtask after reload', 10000);
        step('subtask A visible on B after reload');

        // 4. B adds a subtask; A must receive it live.
        await addSubtaskViaUi(pageB, 'sync-probe-thought', 'sub-from-B');
        await pageB.evaluate(() => document.activeElement?.blur());
        step('B added subtask');
        await waitFor(pageA, () => document.body.textContent.includes('sub-from-B'), 'A receives subtask add from B live');
        step('subtask B synced to A live');

        // 5. Persistence: a fresh reload of A must show both subtasks.
        await pageA.reload();
        await waitFor(pageA, () => document.body.textContent.includes('sub-from-B'), 'A shows subtask from B after reload', 10000);
        step('subtask B visible on A after reload');

        // 6. Cross-card focus scenario: while A's inline input holds focus on
        // card one, a remote update to card two must still appear immediately
        // (only same-card updates defer to the blur flush).
        await pageB.click('#fab-add-thought');
        await pageB.fill('#quick-add-input', 'sync-probe-two');
        await pageB.click('#quick-add-submit');
        await waitFor(pageA, () => document.body.textContent.includes('sync-probe-two'), 'A receives second thought via WebSocket');
        step('second thought synced to A');

        await pageA.locator('.thought-card:has-text("sync-probe-thought") .subtask-add-inline').first().click();
        await pageA.waitForFunction(() => document.activeElement?.placeholder === '新增子任务...', null, { timeout: 3000 });
        await addSubtaskViaUi(pageB, 'sync-probe-two', 'sub-two-remote');
        await pageB.evaluate(() => document.activeElement?.blur());
        await waitFor(pageA, () => document.body.textContent.includes('sub-two-remote'), 'A shows remote update on another card while its own input is focused', 5000);
        await pageA.evaluate(() => document.activeElement?.blur());
        step('cross-card live update visible while input focused');

        // 6. Server truth: one thought, two subtasks, both devices' outboxes empty.
        const remote = await serverThought(pageA, 'sync-probe-thought');
        assert(remote, 'thought exists on the server');
        assert.deepEqual(
            (remote.subItems || []).map(item => item.text).sort(),
            ['sub-from-A', 'sub-from-A-chained', 'sub-from-B'],
            'server thought must contain both devices subtasks'
        );
        assert.equal(await outboxCount(pageA), 0, 'device A outbox must be empty');
        assert.equal(await outboxCount(pageB), 0, 'device B outbox must be empty');

        assert.deepEqual(pageErrors, [], 'no page errors on either device');
        console.log('Thought multi-device sync browser regression passed');
    } finally {
        if (globalThis.__syncPages) {
            await globalThis.__syncPages.pageA?.close().catch(() => {});
            await globalThis.__syncPages.pageB?.close().catch(() => {});
        }
        child.kill();
        if (process.env.DUMBPAD_SYNC_TEST_KEEP_LOGS) {
            console.log('--- server logs ---\n' + logs.join(''));
        }
    }
};

if (require.main === module) {
    (async () => {
        const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try { await module.exports(browser); } finally { await browser.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
