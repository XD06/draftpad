const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { registerNoteRoutes } = require('../../routes/note-routes');
const { registerNotepadRoutes } = require('../../routes/notepad-routes');
const { createWebSocketHub } = require('../../server/websocket');

async function main() {
    const root = path.resolve(__dirname, '../..');
    const note = { id: 'note', name: 'Sync test', version: 42, createdAt: Date.now(), updatedAt: Date.now() };
    let metadata = { notepads: [note] };
    let content = 'remote 42';
    let metaGate = null;
    const counts = { list: 0, meta: 0, body: 0 };
    let lock = Promise.resolve();
    const storage = {
        init: async () => {},
        readNotepadsMeta: async () => structuredClone(metadata),
        saveNotepadsMeta: async next => { metadata = structuredClone(next); },
        readNoteContent: async () => content,
        writeNoteContent: async (_notepad, next) => { content = next; },
        withNotepadWriteLock(operation) {
            const result = lock.then(operation);
            lock = result.catch(() => {});
            return result;
        }
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.cookies = {}; next(); });
    app.use((req, _res, next) => {
        if (req.path === '/api/notepads') counts.list += 1;
        if (req.path === '/api/notepads/note') counts.meta += 1;
        if (req.path === '/api/notes/note') counts.body += 1;
        next();
    });
    app.use(async (req, _res, next) => {
        if (req.method === 'GET' && req.path === '/api/notepads/note' && metaGate) await metaGate;
        next();
    });
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    const hub = createWebSocketHub({ server: listener, validateOrigin: () => true });
    const routeContext = {
        storage,
        baseUrl: 'http://localhost',
        nodeEnv: 'test',
        pageHistoryCookie: 'history',
        pageHistoryCookieAge: 10000,
        loadNotepadsList: async () => {
            counts.list += 1;
            return structuredClone(metadata.notepads);
        },
        findNotepadById: async id => {
            const data = await storage.readNotepadsMeta();
            return { data, notepad: data.notepads.find(item => item.id === id) };
        },
        broadcastUpdate: hub.broadcastUpdate,
        scheduleIndexNotepads: () => {}
    };
    registerNoteRoutes(app, routeContext);
    registerNotepadRoutes(app, routeContext);
    app.get('/api/config', (_req, res) => res.json({
        hiddenFloatingActions: [],
        assetMaxFileBytes: 10485760,
        siteTitle: 'DumbPad'
    }));
    app.use(express.static(path.join(root, 'public')));
    app.use('/vendor/vditor', express.static(path.join(root, 'node_modules/vditor/dist')));
    app.use('/js/@highlightjs/highlight.min.js', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')));
    app.use('/css/@highlightjs', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/styles')));

    let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const context = await browser.newContext({ serviceWorkers: 'block' });
        await context.addInitScript(() => {
            localStorage.setItem('dumbpad_startup_cache_v1', JSON.stringify({
                version: 2,
                currentNotepadId: 'note',
                noteHistory: ['note'],
                notepads: [{ id: 'note', name: 'Sync test', version: 38, createdAt: 1, updatedAt: 1 }],
                notes: { note: { id: 'note', content: 'cached 38', version: 38, dirty: false, savedAt: Date.now() } }
            }));
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const base = `http://127.0.0.1:${listener.address().port}/?id=note`;

        await page.goto(base);
        await page.waitForSelector('.tiptap[contenteditable="true"]', { timeout: 10000 });
        await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('remote 42'), null, { timeout: 10000 });
        assert.equal(counts.body, 1, 'a stale cached body should be fetched once after the remote version check');

        await page.locator('#settings-button').click();
        await page.waitForFunction(() => document.querySelector('#settings-server-version')?.textContent === '42');
        await page.locator('#settings-cancel').click();

        metadata.notepads[0].version = 43;
        metadata.notepads[0].updatedAt = Date.now();
        content = 'remote 43';
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('remote 43'), null, { timeout: 10000 });

        await page.locator('.tiptap').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.insertText(' local edit');
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1'))?.notes?.note?.dirty === true);
        metadata.notepads[0].version = 44;
        metadata.notepads[0].updatedAt = Date.now();
        content = 'remote 44';
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1'))?.notes?.note?.conflict === true, null, { timeout: 10000 });
        assert((await page.locator('.tiptap').textContent()).includes('local edit'), 'remote refresh must preserve dirty editor content');

        let releaseMeta;
        metaGate = new Promise(resolve => { releaseMeta = resolve; });
        metadata.notepads[0].version = 45;
        metadata.notepads[0].updatedAt = Date.now();
        content = 'remote 45';
        const beforeMeta = counts.meta;
        await page.evaluate(() => {
            window.dispatchEvent(new Event('pageshow'));
            window.dispatchEvent(new CustomEvent('ws_connected'));
            window.dispatchEvent(new Event('pageshow'));
        });
        await page.waitForTimeout(250);
        assert.equal(counts.meta - beforeMeta, 1, 'simultaneous recovery events should share one metadata request');
        releaseMeta();
        metaGate = null;
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1'))?.notes?.note?.remoteVersion === 45, null, { timeout: 10000 });
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('Browser note sync: stale cache recovery, settings version, lifecycle refresh, dirty protection and recovery deduplication passed');
    } finally {
        if (browser) await browser.close();
        for (const client of hub.wss.clients) client.terminate();
        await new Promise(resolve => hub.wss.close(resolve));
        await new Promise(resolve => listener.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
