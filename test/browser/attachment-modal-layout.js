/**
 * 方案 A 附件浮层布局回归（真实浏览器）：桌面 / 移动端切换「预览 ↔ 编辑」时，
 * 分段器 x 坐标必须不变。demo 基线 662.33 / 568.5 是在 demo 的 1080 / 395px
 * 舞台里量到的绝对值；接入 DumbPad 真实视口后绝对值不同，不变的是「切换前后
 * 不位移」这条几何不变式（三列网格 + .is-hidden 占位 / 移动端固定宽度操作组）。
 * 浏览器测试不在 npm test 内，按 AGENTS.md 手动真机回归。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.resolve(__dirname, '../..');

module.exports = async function testAttachmentModalLayout(browser) {
    const index = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const start = index.indexOf('<div class="modal-overlay" id="modal-overlay"');
    const end = index.indexOf('<div id="toast-container"', start);
    assert.ok(start > 0 && end > start, 'index.html 必须挂载方案 A 浮层');
    const modalHtml = index.slice(start, end);

    const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="/Assets/styles.css">
        <link rel="stylesheet" href="/Assets/attachment-viewer-modal.css">
        <style>html,body{margin:0;height:100%;overflow:hidden}</style>
        </head><body><button id="entry" type="button">入口</button>${modalHtml}
        <div id="toast-container" class="toast-container"></div>
        <script type="module">
          import { installAttachmentViewerModal } from '/managers/attachment-viewer-modal.js';
          const ASSET_ID = '0123456789abcdef0123456789abcdef';
          const CONTENT = '# 真实附件内容\\n\\n正文来自读接口';
          window.__serverContent = CONTENT;
          window.__serverVersion = 0;
          window.__putCalls = [];
          window.__toasts = [];
          window.fetch = async (url, options = {}) => {
            if (options.method === 'PUT') {
              const version = Number(options.headers['X-Asset-Base-Version']);
              window.__putCalls.push({ url, body: String(options.body), version });
              if (version !== window.__serverVersion) {
                return { ok: false, status: 409, json: async () => ({ currentVersion: window.__serverVersion }) };
              }
              window.__serverContent = String(options.body);
              window.__serverVersion += 1;
              return { ok: true, status: 200, json: async () => ({
                success: true, contentVersion: window.__serverVersion, size: options.body.length
              }) };
            }
            return {
              ok: true, status: 200,
              text: async () => window.__serverContent,
              json: async () => ({
                id: ASSET_ID, name: 'context-compaction.md', type: 'text/markdown',
                size: window.__serverContent.length,
                contentVersion: window.__serverVersion, content: window.__serverContent
              })
            };
          };
          window.toaster = {
            show(message, type) { window.__toasts.push({ message, type }); return { parentNode: null }; },
            hide() {}
          };
          installAttachmentViewerModal();
          window.__openModal = async () => {
            await window.openAttachmentViewer({
              id: ASSET_ID, name: 'context-compaction.md', type: 'text/markdown', size: 30100,
              originalUrl: '/api/assets/' + ASSET_ID + '/original',
              downloadUrl: '/api/assets/' + ASSET_ID + '/download'
            }, document.getElementById('entry'));
          };
          window.__ready = true;
        </script></body></html>`;

    const app = express();
    app.get('/', (_req, res) => res.type('html').send(fixture));
    app.use('/Assets', express.static(path.join(ROOT, 'public', 'Assets')));
    app.use('/managers', express.static(path.join(ROOT, 'public', 'managers')));
    app.get('/js/marked/marked.esm.js', (_req, res) =>
        res.type('application/javascript').send('export const marked = { parse: (s) => String(s || "") };'));
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const url = `http://127.0.0.1:${server.address().port}/`;

    const cases = [
        { label: 'desktop', width: 1280, height: 900, segment: '.desktop-segmented-control', edit: '#btn-desk-edit-a', preview: '#btn-desk-prev-a' },
        { label: 'mobile', width: 395, height: 840, segment: '.mobile-bottom-bar .segmented-control', edit: '#btn-mob-edit-a', preview: '#btn-mob-prev-a' },
    ];

    try {
        for (const item of cases) {
            const context = await browser.newContext({
                viewport: { width: item.width, height: item.height },
                hasTouch: item.label === 'mobile',
                isMobile: item.label === 'mobile',
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (error) => pageErrors.push(error.message));
            await page.goto(url, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__ready === true);
            await page.evaluate(() => window.__openModal());
            await page.waitForTimeout(350);
            assert.equal(await page.locator('#textarea-a').inputValue(), '# 真实附件内容\n\n正文来自读接口',
                `${item.label} 真实读接口必须替换 SAMPLE_MARKDOWN`);
            assert.ok(/· UTF-8/.test(await page.locator('.modal-header-a .file-sub-meta').innerText()),
                `${item.label} 体积 / 编码必须来自真实元数据`);
            assert.ok(await page.locator('#modal-overlay').evaluate((el) => el.classList.contains('open')),
                `${item.label} 入口必须打开同一个浮层`);

            const xOf = () => page.locator(item.segment).evaluate((el) => el.getBoundingClientRect().x);
            const xPreview = await xOf();
            await page.click(item.edit);
            await page.waitForTimeout(350);
            const xEdit = await xOf();
            await page.click(item.preview);
            await page.waitForTimeout(350);
            const xPreviewAgain = await xOf();

            console.log(`${item.label}: segment x = ${xPreview.toFixed(2)} (preview) / ${xEdit.toFixed(2)} (edit) / ${xPreviewAgain.toFixed(2)} (back)`);
            assert.ok(Math.abs(xPreview - xEdit) < 0.51,
                `${item.label} 预览→编辑 分段器位移 ${xPreview} -> ${xEdit}`);
            assert.ok(Math.abs(xPreview - xPreviewAgain) < 0.51,
                `${item.label} 编辑→预览 分段器位移 ${xPreview} -> ${xPreviewAgain}`);

            if (item.label === 'desktop') {
                // 真浏览器里的真实保存链路：PUT /content → 刷新后仍读到新字节，
                // 且不产生任何 localStorage 桥、不新建资产 id。
                await page.click(item.edit);
                await page.fill('#textarea-a', '浏览器端保存的内容');
                await page.click('#btn-save-a');
                await page.waitForFunction(() => window.__putCalls.length === 1);
                const saved = await page.evaluate(() => ({
                    calls: window.__putCalls,
                    serverContent: window.__serverContent,
                    serverVersion: window.__serverVersion,
                    toasts: window.__toasts,
                    bridge: window.localStorage.getItem('dumbpad_attachment_overlay_v1')
                }));
                assert.equal(saved.calls[0].version, 0, 'PUT 必须带读接口给回的 baseVersion');
                assert.equal(saved.calls[0].body, '浏览器端保存的内容');
                assert.ok(/^\/api\/assets\/[a-f0-9-]+\/content$/.test(saved.calls[0].url),
                    'PUT 必须打到原地保存端点');
                assert.equal(saved.serverContent, '浏览器端保存的内容', '服务端字节必须原地更新');
                assert.equal(saved.serverVersion, 1);
                assert.ok(saved.toasts.some((t) => t.type === 'success' && /成功保存/.test(t.message)),
                    '保存成功必须 success toast');
                assert.equal(saved.bridge, null, '不得再写 localStorage 桥');
                await page.evaluate(() => window.__openModal());
                await page.waitForTimeout(200);
                assert.equal(await page.locator('#textarea-a').inputValue(), '浏览器端保存的内容',
                    '刷新后内容还在（同一个资产 id）');
            }

            assert.deepEqual(pageErrors, [], `${item.label} 控制台零报错：${pageErrors.join(' | ')}`);
            await context.close();
        }
        console.log('Attachment modal layout browser regression passed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
};

if (require.main === module) {
    (async () => {
        const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try { await module.exports(browser); } finally { await browser.close(); }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
}
