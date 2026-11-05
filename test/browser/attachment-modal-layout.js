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
          const CONTENT = '# 真实附件内容\\n\\n正文来自读接口';
          window.fetch = async () => ({ ok: true, status: 200, text: async () => CONTENT });
          window.toaster = { show() {}, hide() {} };
          installAttachmentViewerModal();
          window.__openModal = async () => {
            await window.openAttachmentViewer({
              id: 'asset-1', name: 'context-compaction.md', type: 'text/markdown', size: 30100,
              originalUrl: '/api/assets/asset-1/original', downloadUrl: '/api/assets/asset-1/download'
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
            assert.ok(/KB · UTF-8/.test(await page.locator('.modal-header-a .file-sub-meta').innerText()),
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
