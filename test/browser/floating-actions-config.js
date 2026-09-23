/**
 * 悬浮功能按钮配置回归（真实浏览器）：DUMBPAD_HIDDEN_FLOATING_ACTIONS 经 /api/config 下发后，
 * 前端必须真的把列出的按钮从工具条上摘掉（computed display: none），同时保留 DOM 节点与点击能力——
 * 显式值覆盖默认名单、外壳按钮受保护并回报原因、置空则全部显示；另验证移动端「更多」展开时隐藏项
 * 不会被放回来。jsdom 算不了 display 与 getBBox，图标渲染与媒体查询只能靠真浏览器。
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const CONFIGURABLE_IDS = [
    'toggle-article-toc',
    'copy-all',
    'toggle-today-drafts',
    'clipboard-import-trigger',
    'toggle-reflections',
    'toggle-thoughts'
];
const PROTECTED_IDS = ['fab-toggle-group', 'scroll-helper'];
const ALL_IDS = [...PROTECTED_IDS.slice(0, 1), ...CONFIGURABLE_IDS, ...PROTECTED_IDS.slice(1)];

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
            setTimeout(attempt, 250);
        };
        attempt();
    });
}

async function bootServer(hiddenFloatingActions) {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-floating-actions-'));
    const env = {
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
    };
    if (hiddenFloatingActions !== undefined) {
        env.DUMBPAD_HIDDEN_FLOATING_ACTIONS = hiddenFloatingActions;
    }
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = [];
    child.stdout.on('data', chunk => logs.push(String(chunk)));
    child.stderr.on('data', chunk => logs.push(String(chunk)));
    try {
        await waitForServer(child, port);
    } catch (error) {
        child.kill();
        throw new Error(`${error.message}\nserver logs:\n${logs.join('')}`);
    }
    return { child, port, logs };
}

function readState() {
    const ids = [
        'fab-toggle-group', 'toggle-article-toc', 'copy-all', 'toggle-today-drafts',
        'clipboard-import-trigger', 'toggle-reflections', 'toggle-thoughts', 'scroll-helper'
    ];
    return Object.fromEntries(ids.map(id => {
        const el = document.getElementById(id);
        if (!el) return [id, null];
        const svg = el.querySelector('svg');
        const box = svg && svg.getBoundingClientRect();
        let ink = null;
        if (svg && typeof svg.getBBox === 'function') {
            const b = svg.getBBox();
            ink = Math.round(b.width) + 'x' + Math.round(b.height);
        }
        return [id, {
            hiddenAttr: el.hasAttribute('hidden'),
            display: getComputedStyle(el).display,
            size: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height),
            svgSize: box ? Math.round(box.width) + 'x' + Math.round(box.height) : null,
            viewBox: svg && svg.getAttribute('viewBox'),
            fill: svg && getComputedStyle(svg).fill,
            paths: el.querySelectorAll('svg path').length,
            ink
        }];
    }));
}

async function openEditorPage(browser, port, expectedHidden, warnings) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text());
    });
    page.on('pageerror', error => warnings.push(`[pageerror] ${error.message}`));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const toolbar = document.querySelector('.floating-actions');
        return toolbar && getComputedStyle(toolbar).display !== 'none';
    }, null, { timeout: 10000 });
    // The toolbar ships the markup defaults and only converges once GET /api/config
    // has been applied; wait for that instead of sleeping, otherwise a slow boot would
    // read the pre-config state and the assertions below would be meaningless.
    try {
        await page.waitForFunction(hidden => {
            const wanted = new Set(hidden);
            return ['toggle-article-toc', 'copy-all', 'toggle-today-drafts',
                'clipboard-import-trigger', 'toggle-reflections', 'toggle-thoughts'].every(id => {
                const el = document.getElementById(id);
                return el && el.hidden === wanted.has(id);
            });
        }, expectedHidden, { timeout: 10000, polling: 150 });
    } catch (error) {
        const observed = await page.evaluate(readState);
        throw new Error(`config never reached the toolbar (expected hidden ${JSON.stringify(expectedHidden)})\n`
            + `observed: ${JSON.stringify(observed, null, 2)}`);
    }
    return page;
}

const state = page => page.evaluate(readState);
const visibleInToolbar = id => id !== 'fab-toggle-group' && id !== 'toggle-article-toc';

module.exports = async function testFloatingActionsConfig() {
    const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    let started = null;
    const boot = async value => {
        if (started) started.child.kill();
        started = await bootServer(value);
        return started;
    };
    const close = async (page) => {
        await page.close().catch(() => {});
        started.child.kill();
    };
    try {
        // 1) Default: the clipboard quick-record entry is collapsed and the reflections
        //    button shows; Thoughts keeps the filled feather icon and renders at the same
        //    box as its neighbours.
        let { port } = await boot(undefined);
        let warnings = [];
        let page = await openEditorPage(browser, port, ['clipboard-import-trigger'], warnings);
        let config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
        assert.deepEqual(config.hiddenFloatingActions, ['clipboard-import-trigger'],
            'an unset DUMBPAD_HIDDEN_FLOATING_ACTIONS should ship the documented default list');
        let s1 = await state(page);
        assert.equal(s1['clipboard-import-trigger'].display, 'none',
            'the collapsed entry must be gone from the toolbar by default');
        assert.equal(s1['clipboard-import-trigger'].hiddenAttr, true,
            'hiding happens through the hidden attribute, the node stays in the DOM');
        assert.equal(s1['clipboard-import-trigger'].paths, 3,
            'the hidden button keeps its whole markup so the config stays reversible');
        assert.equal(s1['toggle-reflections'].display, 'flex',
            'the reflections button is part of the toolbar by default');
        assert.equal(s1['toggle-thoughts'].display, 'flex', 'thoughts must stay visible by default');
        assert.equal(s1['toggle-thoughts'].size, '34x34', 'thoughts keeps the shared button box');
        assert.equal(s1['toggle-thoughts'].viewBox, '0 0 1024 1024', 'thoughts should use the supplied filled icon');
        assert.equal(s1['toggle-thoughts'].paths, 2, 'the feather + sparkles icon needs both paths');
        assert.equal(s1['toggle-thoughts'].svgSize, '20x20', 'the new icon must render at the toolbar icon size');
        assert.equal(s1['toggle-thoughts'].ink.split('x')[0] > 100, true,
            'the icon must paint real geometry, got ' + s1['toggle-thoughts'].ink);
        assert.match(s1['toggle-thoughts'].fill, /^(color\(srgb|rgb)/, 'fill should resolve like currentColor');
        assert.equal(s1['copy-all'].fill, 'none', 'the untouched stroke icons must not have been restyled');
        assert.ok(Number(s1['toggle-thoughts'].ink.split('x')[0]) > 100,
            'the icon must paint real geometry, got ' + s1['toggle-thoughts'].ink);

        // The reflections button is part of the default toolbar now, and it is still a
        // stub: clicking it must only toast and never navigate.
        await page.click('#toggle-reflections');
        await page.waitForFunction(() => [...document.querySelectorAll('.toast.info')]
            .some(toast => toast.textContent.includes('反思功能开发中')), null, { timeout: 4000 });
        assert.equal(await page.evaluate(() => location.hash), '', 'the reflections stub must not navigate yet');
        assert.deepEqual(warnings.filter(w => /pageerror/.test(w)), [], 'no page errors on the default boot');
        await close(page);

        // 2) Explicit blacklist: ids match case-insensitively, shell buttons are protected
        //    and reported, and the collapsed clipboard entry returns because an explicit
        //    value replaces the default list instead of extending it.
        ({ port } = await boot('Toggle-Thoughts, scroll-helper, made-up-id'));
        warnings = [];
        page = await openEditorPage(browser, port, ['toggle-thoughts'], warnings);
        config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
        assert.deepEqual(config.hiddenFloatingActions, ['toggle-thoughts', 'scroll-helper', 'made-up-id'],
            'the server should normalize the raw value before sending it');
        let s2 = await state(page);
        assert.equal(s2['toggle-thoughts'].hiddenAttr, true, 'a blacklisted id hides its button whatever the casing');
        assert.equal(s2['toggle-thoughts'].display, 'none', 'the blacklisted button must leave the toolbar');
        assert.ok(s2['toggle-thoughts'] !== null, 'hiding must keep the DOM node, not remove it');
        assert.equal(s2['toggle-thoughts'].paths, 2, 'the hidden button keeps its markup so the config is reversible');
        assert.equal(s2['scroll-helper'].display, 'flex', 'scroll-helper is shell-critical and must stay visible');
        assert.equal(s2['clipboard-import-trigger'].display, 'flex',
            'an explicit value replaces the default, so the collapsed entry shows again');
        assert.equal(s2['toggle-reflections'].display, 'flex', 'the reflections button stays unless it is listed');
        assert.equal(s2['copy-all'].display, 'flex', 'unlisted buttons are untouched');
        assert.ok(warnings.some(w => /Ignoring hidden floating action: scroll-helper \(protected\)/.test(w)),
            'a protected id should be reported, got ' + JSON.stringify(warnings));
        assert.ok(warnings.some(w => /Ignoring hidden floating action: made-up-id \(unknown\)/.test(w)),
            'an unknown id should be reported, got ' + JSON.stringify(warnings));
        await close(page);

        // 3) Mobile: the collapse rules are media-scoped display toggles, so the
        //    [hidden] override has to win in both the collapsed and the expanded group.
        ({ port } = await boot('clipboard-import-trigger'));
        warnings = [];
        page = await openEditorPage(browser, port, ['clipboard-import-trigger'], warnings);
        await page.setViewportSize({ width: 420, height: 780 });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('fab-toggle-group')).display !== 'none',
            null, { timeout: 4000 });
        let mobileCollapsed = await state(page);
        assert.equal(mobileCollapsed['clipboard-import-trigger'].display, 'none', 'blacklisted button stays hidden while collapsed');
        assert.equal(mobileCollapsed['scroll-helper'].display, 'flex', 'scroll-helper stays in the collapsed mobile group');
        assert.equal(mobileCollapsed['copy-all'].display, 'none', 'the collapsed group still hides the other actions');
        await page.click('#fab-toggle-group');
        await page.waitForFunction(() => document.body.classList.contains('fab-expanded'), null, { timeout: 4000 });
        let mobileExpanded = await state(page);
        assert.equal(mobileExpanded['copy-all'].display, 'flex', 'expanding the group reveals the other actions');
        assert.equal(mobileExpanded['toggle-today-drafts'].display, 'flex', 'expanding the group reveals today drafts');
        assert.equal(mobileExpanded['clipboard-import-trigger'].display, 'none',
            'a blacklisted button must stay hidden even when the group is expanded');
        assert.deepEqual(warnings.filter(w => /pageerror/.test(w)), [], 'no page errors in the mobile layout');
        await close(page);

        // 4) Empty blacklist: everything shows again, including the placeholder, and a
        //    button that was hidden in an earlier boot is still fully wired.
        ({ port } = await boot(''));
        warnings = [];
        page = await openEditorPage(browser, port, [], warnings);
        config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
        assert.deepEqual(config.hiddenFloatingActions, [], 'an explicitly empty value should mean "hide nothing"');
        let s4 = await state(page);
        for (const id of ALL_IDS.filter(visibleInToolbar)) {
            assert.equal(s4[id].display, 'flex', `${id} should be visible with an empty blacklist`);
            assert.equal(s4[id].hiddenAttr, false, `${id} should not carry the hidden attribute`);
        }
        assert.equal(s4['toggle-thoughts'].viewBox, '0 0 1024 1024', 'the filled icon is the one that stays visible');
        assert.deepEqual(warnings.filter(w => /Ignoring hidden floating action/.test(w)), [], 'an empty list must not warn');
        await page.close().catch(() => {});

        // Same config, fresh page: the Thoughts entry must really open the panel, proving
        // that a button which the config had hidden earlier never lost its click handler.
        page = await openEditorPage(browser, port, [], warnings);
        await page.click('#toggle-thoughts');
        await page.waitForFunction(() => location.hash === '#thoughts', null, { timeout: 6000 });
        await page.waitForFunction(() => {
            const view = document.getElementById('thoughts-view');
            return view && view.style.display !== 'none' && view.style.display !== '';
        }, null, { timeout: 6000 });
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.floating-actions')).display),
            'none', 'the editor toolbar yields to the thoughts workspace, so the click really switched views');
        await close(page);

        console.log('floating actions config browser regression passed');
    } finally {
        if (started) started.child.kill();
        await browser.close();
    }
};

if (require.main === module) {
    module.exports().catch(error => { console.error(error); process.exitCode = 1; });
}
