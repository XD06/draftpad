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
        <!-- 与 index.html 同序：全局浅色 hljs 主题在浮层样式之后加载，
             真机必须验证浮层内的 scoped 深色主题能压过它。 -->
        <link rel="stylesheet" href="/css/@highlightjs/github.min.css">
        <style>html,body{margin:0;overflow-x:hidden}#filler{height:3000px}</style>
        </head><body><button id="entry" type="button">入口</button>
        <div class="settings-asset-item" id="thumb-probe" data-preview-kind="pdf" data-asset-id="thumb-probe">
            <label class="settings-asset-select-wrap"><input type="checkbox" class="settings-asset-select"></label>
            <button type="button" class="settings-asset-preview" data-asset-action="view">
                <div class="settings-asset-thumb settings-asset-thumb-file" style="--file-theme:#e74c3c">
                    <svg class="settings-asset-icon-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>
                    <span class="settings-asset-thumb-badge">PDF</span>
                </div>
                <span class="settings-asset-preview-mask" aria-hidden="true">eye</span>
            </button>
            <div class="settings-asset-info"><div class="settings-asset-name">probe.pdf</div></div>
            <div class="settings-asset-actions"></div>
        </div>
        <div style="height:1200px" aria-hidden="true"></div>
        <a id="thought-file" class="thought-attachment thought-attachment-file"
           href="/api/assets/0123456789abcdef0123456789abcdef/original"
           download="context-compaction.md" title="context-compaction.md"
           data-att-id="0123456789abcdef0123456789abcdef" data-att-size="30100" data-att-type="text/markdown">点击预览</a>
        ${modalHtml}
        <div id="toast-container" class="toast-container"></div>
        <div id="filler" aria-hidden="true"></div>
        <script type="module">
          import { installAttachmentViewerModal } from '/managers/attachment-viewer-modal.js';
          import { installThoughtFileAttachmentDelegation } from '/managers/thoughts.js';
          installThoughtFileAttachmentDelegation();
          const ASSET_ID = '0123456789abcdef0123456789abcdef';
          const CONTENT = '# 真实附件内容\\n\\n正文来自读接口\\n\\n\`\`\`javascript\\nconst answer = 42;\\n\`\`\`';
          const LONG = Array.from({ length: 220 }, (_, i) =>
            '## 第 ' + (i + 1) + ' 节\\n\\n这是第 ' + (i + 1) + ' 段的正文内容，用于验证预览与编辑之间的视线保持。').join('\\n\\n');
          window.__serverContent = CONTENT;
          window.__initialContent = CONTENT;
          window.__serverVersion = 0;
          window.__putCalls = [];
          window.__toasts = [];
          window.__fetchDelay = 0;
          window.fetch = async (url, options = {}) => {
            if ((options.method || 'GET') === 'GET' && window.__fetchDelay) {
              await new Promise((r) => setTimeout(r, window.__fetchDelay));
            }
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
          window.__openModal = async (long) => {
            if (long) window.__serverContent = LONG;
            await window.openAttachmentViewer({
              id: ASSET_ID, name: 'context-compaction.md', type: 'text/markdown', size: 30100,
              originalUrl: '/api/assets/' + ASSET_ID + '/original',
              downloadUrl: '/api/assets/' + ASSET_ID + '/download'
            }, document.getElementById('entry'));
          };
          /* 可控延迟的读接口：把「打开 → GET 返回」这段窗口拉长，量连续点开
             两篇时屏幕上有没有闪过上一篇。返回 Promise，调用方可选择不 await。 */
          window.__openWith = (content, delay) => {
            window.__serverContent = content;
            window.__fetchDelay = delay || 0;
            return window.openAttachmentViewer({
              id: ASSET_ID, name: 'context-compaction.md', type: 'text/markdown', size: 30100,
              originalUrl: '/api/assets/' + ASSET_ID + '/original',
              downloadUrl: '/api/assets/' + ASSET_ID + '/download'
            }, document.getElementById('entry'));
          };
          window.__ready = true;
        </script></body></html>`;

    // 桩：只实现浮层用到的最小 marked API，代码块仍产出 <pre><code class="language-*">，
    // 这样 addCopyLangButtonsToCodeBlocks 的复制按钮能被真机验证。
    const markedStub = `
      const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      export class Marked {
        constructor(opts) { this.opts = opts || {}; }
        use() { return this; }
        parse(src) {
          const text = String(src || '');
          let out = '', last = 0, m;
          const re = /\`\`\`([\\w-]*)\\n([\\s\\S]*?)\`\`\`/g;
          const paras = (chunk) => esc(chunk).split(/\\n{2,}/)
            .filter((p) => p.length).map((p) => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
          while ((m = re.exec(text))) {
            out += paras(text.slice(last, m.index));
            out += '<pre><code class="language-' + (m[1] || 'text') + '">' + esc(m[2]) + '</code></pre>';
            last = m.index + m[0].length;
          }
          out += paras(text.slice(last));
          return out;
        }
      }
      export const marked = { parse: (s) => String(s || '') };
    `;

    const app = express();
    app.get('/', (_req, res) => res.type('html').send(fixture));
    app.use('/Assets', express.static(path.join(ROOT, 'public', 'Assets')));
    app.use('/managers', express.static(path.join(ROOT, 'public', 'managers')));
    // 与生产 server.js 一致：全局浅色 hljs 主题，用于验证浮层 scoped 深色主题
    // 在「后加载 + 低特异性」的劣势下仍能覆盖它。
    app.get('/css/@highlightjs/github.min.css', (_req, res) => res.type('text/css').send(
        fs.readFileSync(path.join(ROOT, 'node_modules/@highlightjs/cdn-assets/styles/github.min.css'), 'utf8')));
    app.get('/js/marked/marked.esm.js', (_req, res) => res.type('application/javascript').send(markedStub));
    app.get('/js/@highlightjs/highlight.min.js', (_req, res) => res.type('application/javascript').send(
        'export default { getLanguage: () => null, highlight: (c) => ({ value: c }), highlightAuto: (c) => ({ value: c }), registerLanguage() {} };'));
    app.get('/js/marked-highlight/index.js', (_req, res) => res.type('application/javascript').send(
        'export function markedHighlight() { return {}; }'));
    app.use('/js/@highlightjs/languages', (_req, res) => res.type('application/javascript').send('export default {};'));
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
                permissions: ['clipboard-read', 'clipboard-write'],
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (error) => pageErrors.push(error.message));
            await page.goto(url, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__ready === true);
            await page.evaluate(() => window.__openModal());
            await page.waitForTimeout(350);
            assert.ok((await page.locator('#textarea-a').inputValue()).startsWith('# 真实附件内容'),
                `${item.label} 真实读接口必须替换 SAMPLE_MARKDOWN`);
            assert.ok(/· UTF-8/.test(await page.locator('.modal-header-a .file-sub-meta').innerText()),
                `${item.label} 体积 / 编码必须来自真实元数据`);
            assert.ok(await page.locator('#modal-overlay').evaluate((el) => el.classList.contains('open')),
                `${item.label} 入口必须打开同一个浮层`);

            /* 问题 3：页面滚动后浮层必须仍贴在视口（absolute + 无定位祖先会顶到 y=-scrollY） */
            const fixedCheck = await page.evaluate(() => {
                window.scrollTo(0, 1000);
                const overlay = document.getElementById('modal-overlay');
                return {
                    position: getComputedStyle(overlay).position,
                    y: overlay.getBoundingClientRect().y,
                    scrollY: window.scrollY,
                };
            });
            assert.equal(fixedCheck.position, 'fixed', `${item.label} 浮层必须相对视口定位`);
            assert.ok(Math.abs(fixedCheck.y) < 1,
                `${item.label} 下滚 ${fixedCheck.scrollY}px 后浮层 y=${fixedCheck.y}，PC 端曾整块不可见`);
            await page.evaluate(() => window.scrollTo(0, 0));

            /* 问题 2：file-tag / file-sub-meta 同一行；图标来自 file-type-icons.js */
            const metaLayout = await page.evaluate(() => {
                const tag = document.getElementById('file-tag-a');
                const sub = document.getElementById('file-sub-meta-a');
                const title = document.getElementById('file-title-a');
                const badge = document.querySelector('.modal-header-a .file-icon-badge svg');
                return {
                    tagCenter: tag.getBoundingClientRect().top + tag.getBoundingClientRect().height / 2,
                    subCenter: sub.getBoundingClientRect().top + sub.getBoundingClientRect().height / 2,
                    titleTop: title.getBoundingClientRect().top,
                    tagText: tag.textContent,
                    viewBox: badge?.getAttribute('viewBox'),
                    strokeWidth: badge?.getAttribute('stroke-width'),
                };
            });
            assert.ok(Math.abs(metaLayout.tagCenter - metaLayout.subCenter) < 3,
                `${item.label} file-tag 与 file-sub-meta 必须同一行 (${metaLayout.tagCenter} / ${metaLayout.subCenter})`);
            assert.equal(metaLayout.tagText, 'MD');
            assert.ok(metaLayout.subCenter > metaLayout.titleTop + 4, `${item.label} 文件名应单独占上一行`);
            assert.equal(metaLayout.viewBox, '0 0 24 24', 'file-icon-badge 必须换成项目文件类型图标');
            assert.equal(metaLayout.strokeWidth, '1.8', '图标必须来自 file-type-icons.js');

            /* 问题 1：代码块右上角语言标签 + 一键复制 */
            const codeButton = page.locator('.preview-content pre .code-lang-copy-button');
            assert.equal(await codeButton.count(), 1, `${item.label} 代码块必须带语言/复制按钮`);
            assert.equal(await codeButton.locator('.lang-text').innerText(), 'javascript');
            await codeButton.click();
            await page.waitForTimeout(200);
            const copyToasts = await page.evaluate(() => window.__toasts.map((t) => t.message));
            assert.ok(copyToasts.includes('Copied to clipboard'),
                `${item.label} 复制按钮必须真的复制代码：${copyToasts.join(' | ')}`);

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
                /* 问题 1：预览 ↔ 编辑的视线 / 光标保持（长文档，真布局） */
                await page.evaluate(() => window.__openModal(true));
                await page.waitForTimeout(450);
                await page.evaluate(() => {
                    const pane = document.getElementById('pane-preview-a');
                    pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * 0.5;
                });
                const previewGeometry = await page.evaluate(() => {
                    const pane = document.getElementById('pane-preview-a');
                    return {
                        scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight,
                        display: getComputedStyle(pane).display,
                        htmlLen: document.getElementById('render-preview-a').innerHTML.length,
                        textLen: document.getElementById('textarea-a').value.length,
                    };
                });
                const previewTopBefore = await page.locator('#pane-preview-a').evaluate((el) => el.scrollTop);
                assert.ok(previewTopBefore > 0, `长文档预览必须可滚动 ${JSON.stringify(previewGeometry)}`);
                await page.click('#btn-desk-edit-a');
                await page.waitForTimeout(250);
                const editState = await page.evaluate(() => {
                    const ta = document.getElementById('textarea-a');
                    return {
                        top: ta.scrollTop,
                        max: ta.scrollHeight - ta.clientHeight,
                        caret: ta.selectionStart,
                        len: ta.value.length,
                    };
                });
                assert.ok(editState.max > 0, '长文档编辑态必须可滚动');
                assert.ok(editState.top > 0,
                    `预览→编辑 视线不应回到顶部 (scrollTop=${editState.top})`);
                assert.ok(editState.caret > 0 && editState.caret < editState.len,
                    `预览→编辑 光标不应跑到末尾 (caret=${editState.caret}/${editState.len})`);
                await page.click('#btn-desk-prev-a');
                await page.waitForTimeout(600);
                const previewTopAfter = await page.locator('#pane-preview-a').evaluate((el) => el.scrollTop);
                assert.ok(previewTopAfter > 0,
                    `编辑→预览 视线应恢复到原比例 (scrollTop=${previewTopAfter})`);

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

            /* 问题 3：Thought 文件附件的事件委托——PC 真实鼠标 / 移动真实触摸
               都必须打开浮层，且页面已滚动时浮层仍完整可见、不触发下载。 */
            await page.evaluate(() => {
                window.closeModal();
                window.__serverContent = window.__initialContent;
                window.__serverVersion = 0;
            });
            await page.waitForTimeout(360);
            const downloads = [];
            page.on('download', (d) => downloads.push(d.url()));
            const thoughtLink = page.locator('#thought-file');
            await thoughtLink.scrollIntoViewIfNeeded();
            if (item.label === 'mobile') {
                await thoughtLink.tap();
            } else {
                await thoughtLink.click();
            }
            await page.waitForTimeout(500);
            const delegated = await page.evaluate(() => {
                const overlay = document.getElementById('modal-overlay');
                const rect = overlay.getBoundingClientRect();
                const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
                return {
                    open: overlay.classList.contains('open'),
                    y: rect.y,
                    scrollY: window.scrollY,
                    hitInsideModal: !!hit?.closest('#modal-a'),
                    text: document.getElementById('textarea-a').value.slice(0, 40),
                };
            });
            assert.ok(delegated.open, `${item.label} 委托点击必须打开浮层`);
            assert.ok(Math.abs(delegated.y) < 1 && delegated.hitInsideModal,
                `${item.label} 下滚 ${delegated.scrollY}px 后浮层必须在视口内且可点 (y=${delegated.y})`);
            assert.ok(delegated.text.startsWith('# 真实附件内容'), `${item.label} 委托路径必须读到真实内容`);
            /* 附件管理缩略图：文件图标必须 flex 居中，不能被高特异性
               display:block 顶到左上角（用户实测 SVG 溢出容器顶部）。 */
            const thumbGeometry = await page.evaluate(() => {
                const thumb = document.querySelector('#thumb-probe .settings-asset-thumb-file');
                const svg = thumb.querySelector('svg');
                const t = thumb.getBoundingClientRect();
                const s = svg.getBoundingClientRect();
                return {
                    display: getComputedStyle(thumb).display,
                    dx: (s.x + s.width / 2) - (t.x + t.width / 2),
                    dy: (s.y + s.height / 2) - (t.y + t.height / 2),
                    inside: s.x >= t.x - 0.5 && s.y >= t.y - 0.5
                        && s.right <= t.right + 0.5 && s.bottom <= t.bottom + 0.5,
                };
            });
            assert.equal(thumbGeometry.display, 'flex', `${item.label} 文件图标容器必须保持 flex`);
            assert.ok(Math.abs(thumbGeometry.dx) < 1,
                `${item.label} 文件图标水平必须居中 (dx=${thumbGeometry.dx})`);
            assert.ok(Math.abs(thumbGeometry.dy) < 3,
                `${item.label} 文件图标垂直偏移异常 (dy=${thumbGeometry.dy})`);
            assert.ok(thumbGeometry.inside, `${item.label} 文件图标不得溢出缩略图容器`);

            assert.deepEqual(downloads, [], `${item.label} 点击预览不得触发原生下载`);

            /* 新增问题 1：PC 头部必须有下载按钮（demo 只给了移动端底部栏），
               且真的下载同一个资产；移动端顶部不重复、底部栏仍在。 */
            const downloadHeader = page.locator('.btn-download-header');
            if (item.label === 'desktop') {
                assert.equal(await downloadHeader.count(), 1, 'PC 头部必须有下载按钮');
                assert.ok(await downloadHeader.isVisible(), 'PC 下载按钮必须可见');
                const captured = await page.evaluate(() => {
                    const real = HTMLAnchorElement.prototype.click;
                    let result = null;
                    HTMLAnchorElement.prototype.click = function () {
                        result = { href: this.getAttribute('href'), name: this.getAttribute('download') };
                    };
                    try { window.downloadActiveAttachment(); } finally {
                        HTMLAnchorElement.prototype.click = real;
                    }
                    return result;
                });
                assert.ok(/^\/api\/assets\/[a-f0-9-]+\/download$/.test(captured?.href || ''),
                    `PC 下载必须走真实资产下载地址：${JSON.stringify(captured)}`);
                assert.equal(captured?.name, 'context-compaction.md', '下载文件名必须取附件名');
            } else {
                assert.ok(!(await downloadHeader.isVisible()), '移动端顶部不重复放下载按钮');
                assert.equal(await page.locator('#mobile-bar-a button[title="下载"]').count(), 1,
                    '移动端底部大拇指栏仍保留同款下载按钮');
            }

            /* 新增问题 3：代码块 token 必须是高对比深色主题。全局浅色
               github.min.css 在浮层样式之后加载，这里量 computed color 验证
               scoped Atom One Dark 真的压过了它，而不只是源码里写了规则。 */
            const highlight = await page.evaluate(() => {
                const pre = document.querySelector('.preview-content pre');
                if (!pre) return { error: '预览区没有代码块' };
                const code = pre.querySelector('code');
                const probe = document.createElement('span');
                probe.className = 'hljs-string';
                probe.textContent = '"probe"';
                code.appendChild(probe);
                const channel = (value) => {
                    const s = value / 255;
                    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                };
                const luminance = (css) => {
                    const [r, g, b] = (String(css).match(/[\d.]+/g) || []).slice(0, 3).map(Number).map(channel);
                    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
                };
                const fg = luminance(getComputedStyle(probe).color);
                const bg = luminance(getComputedStyle(pre).backgroundColor);
                return {
                    color: getComputedStyle(probe).color,
                    background: getComputedStyle(pre).backgroundColor,
                    contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
                };
            });
            assert.ok(!highlight.error, highlight.error);
            assert.equal(highlight.color, 'rgb(152, 195, 121)',
                `hljs-string 必须是 Atom One Dark #98c379；全局浅色主题是 rgb(3, 47, 98)：${highlight.color}`);
            assert.ok(highlight.contrast >= 4.5,
                `${item.label} 代码块 token 对比度必须 ≥ 4.5，实测 ${Number(highlight.contrast).toFixed(2)}`);

            /* 新增问题 2：连续点开两篇，读接口返回前绝不能显示上一篇。
               根因是 state.currentContent 残留，不是缓存（/content 是 no-store）。 */
            const flash = await page.evaluate(async () => {
                await window.__openWith('PREVIOUS-DOC 上一篇正文', 0);
                await new Promise((r) => setTimeout(r, 300));
                const before = document.getElementById('render-preview-a').textContent;
                window.__pending = window.__openWith('CURRENT-DOC 当前篇正文', 500);
                await new Promise((r) => setTimeout(r, 80));
                return {
                    before,
                    immediate: document.getElementById('render-preview-a').textContent,
                    textarea: document.getElementById('textarea-a').value,
                };
            });
            assert.ok(flash.before.includes('PREVIOUS-DOC'),
                `基线：第一篇必须真的渲染出来 (${flash.before.slice(0, 80)})`);
            assert.ok(!flash.immediate.includes('PREVIOUS-DOC'),
                `${item.label} 打开第二篇的瞬间不得残留上一篇 (${flash.immediate.slice(0, 80)})`);
            assert.ok(flash.immediate.includes('正在加载附件内容'),
                `${item.label} 打开瞬间必须显示加载占位 (${flash.immediate.slice(0, 80)})`);
            assert.equal(flash.textarea, '', `${item.label} 打开瞬间 textarea 必须清空`);
            await page.evaluate(() => window.__pending);
            await page.waitForTimeout(300);
            const settled = await page.evaluate(() => ({
                preview: document.getElementById('render-preview-a').textContent,
                textarea: document.getElementById('textarea-a').value,
            }));
            assert.ok(settled.preview.includes('CURRENT-DOC') && !settled.preview.includes('PREVIOUS-DOC'),
                `${item.label} 读接口返回后必须只剩当前篇 (${settled.preview.slice(0, 100)})`);
            assert.ok(settled.textarea.includes('CURRENT-DOC'), `${item.label} textarea 必须收到当前篇`);
            await page.evaluate(() => { window.__fetchDelay = 0; });

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
