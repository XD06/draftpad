const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { registerNoteRoutes } = require('../../routes/note-routes');
const { registerNotepadRoutes } = require('../../routes/notepad-routes');
const { createWebSocketHub } = require('../../server/websocket');

async function main() {
    const root = path.resolve(__dirname, '../..');
    let metadata = { notepads: [{ id: 'note', name: 'Editing sessions', version: 1340, createdAt: Date.now(), updatedAt: Date.now() }] };
    let content = 'Initial article';
    let lock = Promise.resolve();
    const storage = {
        init: async () => {},
        readNotepadsMeta: async () => structuredClone(metadata),
        saveNotepadsMeta: async data => { metadata = structuredClone(data); },
        readNoteContent: async () => content,
        writeNoteContent: async (notepad, next) => { content = next; },
        withNotepadWriteLock(operation) {
            const result = lock.then(operation);
            lock = result.catch(() => {});
            return result;
        }
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.cookies = {}; next(); });
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    const hub = createWebSocketHub({ server: listener, validateOrigin: () => true });
    const routeContext = {
        storage, baseUrl: 'http://localhost', nodeEnv: 'test', pageHistoryCookie: 'history', pageHistoryCookieAge: 10000,
        loadNotepadsList: async () => structuredClone(metadata.notepads),
        findNotepadById: async id => {
            const data = await storage.readNotepadsMeta();
            return { data, notepad: data.notepads.find(note => note.id === id) };
        },
        broadcastUpdate: hub.broadcastUpdate,
        scheduleIndexNotepads: () => {}
    };
    registerNoteRoutes(app, routeContext);
    registerNotepadRoutes(app, routeContext);
    app.get('/api/config', (req, res) => res.json({ hiddenFloatingActions: [], assetMaxFileBytes: 10485760, siteTitle: 'DumbPad' }));
    app.use(express.static(path.join(root, 'public')));
    app.use('/vendor/vditor', express.static(path.join(root, 'node_modules/vditor/dist')));
    app.use('/js/@highlightjs/highlight.min.js', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')));
    app.use('/css/@highlightjs', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/styles')));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const editorContext = await browser.newContext({ serviceWorkers: 'block' });
        const readerContext = await browser.newContext({ serviceWorkers: 'block' });
        const page = await editorContext.newPage();
        const reader = await readerContext.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        reader.on('pageerror', error => errors.push(error.message));
        const base = `http://127.0.0.1:${listener.address().port}/?id=note`;
        await Promise.all([page.goto(base), reader.goto(base)]);
        await page.waitForSelector('.tiptap[contenteditable="true"]');
        await reader.waitForSelector('.tiptap[contenteditable="true"]');
        assert(!(await page.locator('.article-meta').textContent()).includes('1339'), 'legacy revisions are hidden');
        await page.evaluate(() => {
            const originalNow = Date.now;
            window.editClockOffset = 0;
            Date.now = () => originalNow() + window.editClockOffset;
        });
        const edit = async (text, offset = 0) => {
            await page.evaluate(value => { window.editClockOffset += value; }, offset);
            await page.locator('.tiptap').click();
            await page.keyboard.press('Control+End');
            await page.keyboard.insertText(text);
            await page.waitForFunction(value => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1'))?.notes?.note?.content?.includes(value), text);
        };
        const autoSave = () => page.waitForResponse(response => response.url().endsWith('/api/notes/note')
            && response.request().method() === 'POST' && response.ok());
        let saved = autoSave();
        await edit(' first');
        let result = await (await saved).json();
        assert.equal(result.editCount, 1);
        const firstSession = await page.evaluate(() => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1')).notes.note.editSessionId);
        saved = autoSave();
        for (let index = 1; index <= 4; index += 1) await edit(` continuing${index}`, 45000);
        result = await (await saved).json();
        assert.equal(result.editCount, 1, 'three minutes of ongoing input remains one edit');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1')).notes.note.editSessionId), firstSession);
        await reader.waitForFunction(() => document.querySelector('.article-meta')?.textContent.includes('修改1 次'));
        assert(result.version > 1341, 'each changed save still increments the synchronization version');
        saved = autoSave();
        await edit(' new session', 60000);
        result = await (await saved).json();
        assert.equal(result.editCount, 2, 'one minute without input starts the next edit');
        await reader.waitForFunction(() => document.querySelector('.article-meta')?.textContent.includes('修改2 次'));
        await page.reload();
        await page.waitForSelector('.tiptap[contenteditable="true"]');
        await page.waitForFunction(() => document.querySelector('.article-meta')?.textContent.includes('修改2 次'));
        assert.equal(metadata.notepads[0].editCount, 2, 'reload never increments statistics');
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('Browser note editing sessions: real typing, automatic saves, idle boundary, WebSocket footer and reload passed');
    } finally {
        if (browser) await browser.close();
        for (const client of hub.wss.clients) client.terminate();
        await new Promise(resolve => hub.wss.close(resolve));
        await new Promise(resolve => listener.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
