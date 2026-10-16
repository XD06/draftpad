// Article switching regression: quota recovery, inactive WS invalidations and
// dirty-content protection run through the production frontend in real Chrome.
// Only fixture data is used; API body latency is injected to expose cache misses.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { createWebSocketHub } = require('../../server/websocket');

async function main() {
    const root = path.resolve(__dirname, '../..');
    const ids = ['a', 'b', 'c', 'd'];
    const article = id => `# Article ${id}\n\n` + Array.from({ length: 110 }, (_, i) =>
        `## Section ${id} ${i}\n\nParagraph ${i} with **bold** and ==highlight==.\n\n- first\n- second\n\n`
    ).join('');
    let pads;
    let bodies;
    const requests = [];
    const app = express();
    app.get('/api/config', (_req, res) => res.json({ hiddenFloatingActions: [], assetMaxFileBytes: 10485760, siteTitle: 'DumbPad' }));
    app.get('/api/notepads', (_req, res) => res.json({ notepads_list: pads, note_history: 'a' }));
    app.get('/api/notepads/:id', (req, res) => {
        requests.push(`meta:${req.params.id}`);
        res.json(pads.find(pad => pad.id === req.params.id));
    });
    app.get('/api/notes/:id', (req, res) => {
        requests.push(`body:${req.params.id}`);
        const body = { content: bodies[req.params.id], version: pads.find(pad => pad.id === req.params.id).version };
        setTimeout(() => res.json(body), 180);
    });
    app.use(express.static(path.join(root, 'public')));
    app.use('/vendor/vditor', express.static(path.join(root, 'node_modules/vditor/dist')));
    app.use('/js/@highlightjs/highlight.min.js', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')));
    app.use('/css/@highlightjs', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets/styles')));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const hub = createWebSocketHub({ server, validateOrigin: () => true });
    let browser;

    async function scenario({ quota = false, seedAll = true, dirty = false } = {}) {
        pads = ids.map(id => ({ id, name: `Article ${id}`, version: 1, createdAt: 1, updatedAt: 1 }));
        bodies = Object.fromEntries(ids.map(id => [id, article(id)]));
        const notes = Object.fromEntries((seedAll ? ids : ['a']).map(id => [id, { content: bodies[id], version: 1, dirty: false }]));
        if (dirty) notes.a = { content: 'local-only a', baseContent: bodies.a, version: 1, dirty: true };
        const selectedId = dirty ? 'b' : 'a';
        const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
        try {
            await context.addInitScript(({ pads, notes, selectedId, quotaLimit }) => {
                localStorage.setItem('dumbpad_startup_cache_v1', JSON.stringify({ version: 2, currentNotepadId: selectedId, notepads: pads, notes }));
                window.articleQuotaFailures = 0;
                window.articleStorageWrites = 0;
                const setItem = Storage.prototype.setItem;
                Storage.prototype.setItem = function(key, value) {
                    if (key === 'dumbpad_startup_cache_v1') window.articleStorageWrites += 1;
                    if (quotaLimit && key === 'dumbpad_startup_cache_v1' && value.length > quotaLimit) {
                        window.articleQuotaFailures += 1;
                        throw new DOMException('Fixture storage quota', 'QuotaExceededError');
                    }
                    return setItem.call(this, key, value);
                };
                window.articleUpdates = [];
                window.addEventListener('notes_update', event => window.articleUpdates.push(event.detail.version));
                window.articleWsConnected = false;
                window.addEventListener('ws_connected', () => { window.articleWsConnected = true; });
            }, { pads, notes, selectedId, quotaLimit: quota ? bodies.a.length * 3 : 0 });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}/?id=${selectedId}&debugPerformance=1`);
            await page.waitForSelector('.tiptap');
            await page.waitForFunction(() => window.__dumbpadEditorPerformance.summary().samples > 0);
            await page.waitForFunction(() => window.articleWsConnected);
            await page.waitForSelector('#startup-sync-status[data-state="synced"]', { state: 'attached' });
            await page.evaluate(async () => {
                const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
                const setValue = HybridMarkdownEditor.prototype.setValue;
                window.articleMarkdownParses = 0;
                const instrumented = new WeakSet();
                HybridMarkdownEditor.prototype.setValue = function(...args) {
                    const parser = this.editor.storage.markdown.parser;
                    if (!instrumented.has(parser)) {
                        instrumented.add(parser);
                        const parse = parser.parse;
                        parser.parse = function(content, ...options) {
                            if (typeof content === 'string') window.articleMarkdownParses += 1;
                            return parse.call(this, content, ...options);
                        };
                    }
                    return setValue.apply(this, args);
                };
            });
            await page.evaluate(() => window.__dumbpadEditorPerformance.reset());
            requests.length = 0;

            async function select(id, heading = `Article ${id}`, { assertNoImmediateCacheWrite = false } = {}) {
                if (assertNoImmediateCacheWrite) await page.evaluate(() => { window.articleStorageWrites = 0; });
                await page.evaluate(id => document.querySelector(`.dir-item[data-id="${id}"]`).click(), id);
                if (assertNoImmediateCacheWrite) {
                    assert.equal(await page.evaluate(() => window.articleStorageWrites), 0,
                        'article selection must not synchronously write the full startup cache');
                }
                if (heading) await page.waitForFunction(heading => document.querySelector('.tiptap h1')?.textContent === heading, heading);
            }
            async function broadcast(version) {
                pads[0].version = version;
                bodies.a = `# Article a v${version}\n\nRemote change while another article is open.`;
                hub.broadcastUpdate('a', bodies.a, 'remote-fixture-device', version);
                await page.waitForFunction(version => window.articleUpdates.includes(version), version);
            }

            if (dirty) {
                await broadcast(2);
                assert.equal(await page.locator('.tiptap h1').textContent(), 'Article b');
                await select('a', null);
                await page.waitForFunction(() => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1'))?.notes?.a?.conflict === true);
                assert.equal(await page.locator('.tiptap').textContent(), 'local-only a');
                const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1')).notes.a);
                assert.equal(cached.version, 1);
                assert.equal(cached.remoteVersion, 2);
                assert.equal(cached.baseContent, article('a'));
            } else {
                for (const [index, id] of ['b', 'a', 'b', 'c', 'd', 'a', 'b', 'a'].entries()) {
                    const samples = await page.evaluate(() => window.__dumbpadEditorPerformance.summary().samples);
                    await select(id, `Article ${id}`, { assertNoImmediateCacheWrite: index === 0 && !quota });
                    await page.waitForFunction(samples => window.__dumbpadEditorPerformance.summary().samples > samples, samples);
                }
                const switching = await page.evaluate(() => window.__dumbpadEditorPerformance.summary());
                assert.equal(switching.samples, 8, 'each switch must finish its diagnostic sample');
                assert.equal(await page.evaluate(() => window.articleMarkdownParses), 3,
                    'only the first visits to B/C/D should parse Markdown; returning must reuse parsed documents');
                console.log(`Article switch ${quota ? 'quota' : 'normal'} ${seedAll ? 'warm' : 'cold-to-warm'} (8 text-fixture samples, diagnostic first-content ms):`,
                    JSON.stringify(switching.metrics.first_content_ms));
                const bodyReads = requests.filter(request => request.startsWith('body:'));
                assert.deepEqual(bodyReads, seedAll ? [] : ['body:b', 'body:c', 'body:d'],
                    'returning to loaded articles must not download their bodies again, even under disk quota pressure');
                if (quota) assert(await page.evaluate(() => window.articleQuotaFailures > 0), 'quota recovery must really be exercised');
                await select('b');
                const beforeUpdate = requests.length;
                await broadcast(2);
                assert.equal(await page.locator('.tiptap h1').textContent(), 'Article b', 'inactive updates must not replace the active article');
                await select('a', 'Article a v2');
                assert.equal(await page.evaluate(() => window.articleMarkdownParses), 4,
                    'new remote content must parse once instead of reusing the old document');
                assert.equal(requests.slice(beforeUpdate).filter(request => request === 'body:a').length, 1,
                    'returning within ten seconds must fetch the invalidated body exactly once');
                await select('b');
                const beforeOldEvent = requests.length;
                hub.broadcastUpdate('a', article('a'), 'remote-fixture-device', 1);
                await page.waitForFunction(() => window.articleUpdates.includes(1));
                await select('a', 'Article a v2');
                assert.equal(await page.evaluate(() => window.articleMarkdownParses), 4,
                    'returning to the updated article must reuse the new parsed document');
                assert(!requests.slice(beforeOldEvent).includes('body:a'), 'old notifications must not invalidate a newer body');
            }
            assert.deepEqual(errors, [], errors.join('\n'));
            console.log(`PASS article switching quota=${quota} seedAll=${seedAll} dirty=${dirty}`);
        } finally {
            await context.close();
        }
    }

    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        await scenario();
        await scenario({ quota: true });
        await scenario({ quota: true, seedAll: false });
        await scenario({ dirty: true });
    } finally {
        if (browser) await browser.close();
        for (const client of hub.wss.clients) client.terminate();
        await new Promise(resolve => hub.wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
