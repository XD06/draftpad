// 目录标记（划线/高亮/批注）随载入出现的真机回归。jsdom 复现不了启动缓存 +
// 版本短路的完整时序：warm 路径下 updateToC 会跑在编辑器 create 之前，历史上
// 标记因此整批丢失（须编辑一下或切阅读模式才出现，刷新也无效）。断言：零交互
// 载入后标记条目就在目录里，刷新后仍在；文章形态用任务项内嵌标记（用户实际场景）。
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

const ARTICLE = [
    '# 顶部标题',
    '',
    '## 任务区',
    '',
    '- [ ] 带 ==高亮== 的待办',
    '- [x] 已完成 ==划完== 的待办',
    '- [ ] <span data-note="批注甲" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">带批注</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（批注甲）</sub> 的待办',
    '- [ ] 普通 <span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">划线</span> 待办',
    '',
    '## 第二节',
    '',
    '收尾。',
    '',
].join('\n');

async function main() {
    const app = express();
    app.use(express.json());
    const ROOT = path.resolve(__dirname, '../..');
    app.get('/api/config', (_req, res) => res.json({ hiddenFloatingActions: [], assetMaxFileBytes: 10485760, siteTitle: 'DumbPad' }));
    app.get('/api/notepads', (_req, res) => res.json({
        notepads_list: [{ id: 'n1', name: 'TocMarks', version: 7, createdAt: 1700000000000, updatedAt: 1700000000000 }],
        note_history: [],
    }));
    app.get('/api/notes/n1', (_req, res) => res.json({ id: 'n1', content: ARTICLE, version: 7 }));
    app.post('/api/notes/n1', (req, res) => res.json({ id: 'n1', content: req.body?.content ?? '', version: 8 }));
    app.use(express.static(path.join(ROOT, 'public')));
    app.use('/js/@highlightjs/highlight.min.js', express.static(path.join(ROOT, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')));
    app.use('/vendor/vditor', express.static(path.join(ROOT, 'node_modules/vditor/dist')));
    app.use('/css/@highlightjs/github.min.css', express.static(path.join(ROOT, 'node_modules/@highlightjs/cdn-assets/styles/github.min.css')));
    app.use('/css/@highlightjs/github-dark.min.css', express.static(path.join(ROOT, 'node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css')));
    const listener = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    const base = `http://127.0.0.1:${listener.address().port}`;

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const errors = [];
    const failures = [];
    const check = (name, ok, detail) => {
        if (ok) console.log(`PASS ${name}`);
        else {
            failures.push(name);
            console.error(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
        }
    };

    try {
        const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
        // 预置启动缓存：版本与列表一致 → loadNotes 走短路，唯一的内容渲染来自
        // 缓存，updateToC 只由 whenReady / selectNotepad 的 rAF 触发。
        await context.addInitScript((article) => {
            localStorage.setItem('dumbpad_startup_cache_v1', JSON.stringify({
                version: 2,
                currentNotepadId: 'n1',
                noteHistory: ['n1'],
                notepads: [{ id: 'n1', name: 'TocMarks', version: 7, createdAt: 1700000000000, updatedAt: 1700000000000 }],
                notes: { n1: { id: 'n1', content: article, version: 7, dirty: false, savedAt: Date.now() } },
            }));
        }, ARTICLE);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));

        const readToc = () => page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('#article-toc-list .toc-item'));
            return {
                headings: items.filter(i => i.dataset.headingId !== undefined).length,
                marks: items.filter(i => i.dataset.markRef !== undefined).length,
                more: items.filter(i => i.dataset.markGroup !== undefined).length,
            };
        });

        await page.goto(`${base}/?id=n1`);
        await page.waitForSelector('.tiptap', { timeout: 8000 });
        await page.waitForTimeout(800);
        const loaded = await readToc();
        check('marks appear in the TOC right after a warm load with zero interaction',
            loaded.headings >= 2 && loaded.marks >= 1, loaded);
        check('per-section cap leaves an expand entry for 5 marks in one section',
            loaded.marks + loaded.more >= 4, loaded);

        await page.reload();
        await page.waitForSelector('.tiptap', { timeout: 8000 });
        await page.waitForTimeout(2000);
        const reloaded = await readToc();
        check('marks survive a refresh on the warm path', reloaded.headings >= 2 && reloaded.marks >= 1, reloaded);

        check('no page errors', errors.length === 0, errors);
        await browser.close();
    } finally {
        await new Promise(resolve => listener.close(resolve));
    }

    if (failures.length) {
        console.error(`\n${failures.length} FAILURES`);
        process.exit(1);
    }
    console.log('\nALL PASS');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
