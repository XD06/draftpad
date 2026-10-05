// 目录子条目（划线/高亮/批注 + 顶层列表条目）随载入出现的真机回归。jsdom 复现不了
// 启动缓存 + 版本短路的完整时序：warm 路径下 updateToC 会跑在编辑器 create 之前，
// 历史上标记因此整批丢失（须编辑一下或切阅读模式才出现，刷新也无效）。断言：零交互
// 载入后标记条目就在目录里，刷新后仍在；文章形态用任务项内嵌标记（用户实际场景）。
// 「列表区」另覆盖列表条目能力：≤5 条小列表内联（任务区 4 条待办）、超预算列表整组
// 折成「N 条列表项」摘要行、点击整组展开/收起、点列表条目跳转后目标 li 挂上
// article-jump-target（PM Decoration 在编辑模式存活）。
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

// 压力小节：把目录撑到超过视口高度（回归「长文章行被 flex 压扁成细缝」——
// .toc-item-text 的 overflow:hidden 使行 min-size 归 0，靠 flex-shrink:0 拒绝收缩），
// 同时长标题验证折行两行（裸 .toc-item 的继承 nowrap 已在文章内目录作用域翻回 normal）。
const PRESSURE_SECTIONS = Array.from({ length: 12 }, (_, i) => [
    `## 压力小节 ${i + 1}：一个足够长的标题用来验证目录条目折行到两行且行高不被压缩`,
    '',
    `- 压力 ${i + 1} 之一`,
    `- 压力 ${i + 1} 之二`,
    `- 压力 ${i + 1} 之三`,
    `- 压力 ${i + 1} 之四`,
    `- 压力 ${i + 1} 之五`,
    `- 压力 ${i + 1} 之六`,
    `- 压力 ${i + 1} 之七`,
    `- 压力 ${i + 1} 之八`,
    '',
].join('\n')).join('\n');

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
    '## 列表区',
    '',
    '- 步骤一',
    '- 步骤二',
    '- 步骤三',
    '- 步骤四',
    '- 步骤五',
    '- 步骤六',
    '- 步骤七',
    '',
    '## 标记区',
    '',
    '文本 ==高亮一== 与 ==高亮二==，<span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">划线一</span> 与 <span data-draw style="text-decoration:underline blue;text-decoration-thickness:2px;">划线二</span> 四处标记、无列表。',
    '',
    PRESSURE_SECTIONS,
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
                lists: items.filter(i => i.dataset.markRef !== undefined && i.classList.contains('list-entry')).length,
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
        const geometry = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#article-toc-list .toc-item'));
            const hs = rows.map(r => r.getBoundingClientRect().height);
            return { rows: hs.length, squashed: hs.filter(h => h < 20).length, twoLine: hs.filter(h => h > 34).length };
        });
        check('long TOC does not squash rows (flex-shrink:0) and long titles wrap to two lines',
            geometry.rows >= 40 && geometry.squashed === 0 && geometry.twoLine >= 12, geometry);
        check('small list stays inline (4 tasks), over-budget lists collapse to summary rows',
            loaded.lists === 4, loaded);
        check('fifteen fold rows: 任务区 +2, 列表区 summary, 标记区 +1, 12 pressure summaries',
            loaded.more === 15, loaded);
        const loadLabels = await page.evaluate(() => Array.from(
            document.querySelectorAll('#article-toc-list [data-mark-group] .toc-item-text')
        ).map(el => el.textContent));
        check('over-budget list shows a "N 条列表项" summary; mark folds keep 标记/条目 wording',
            loadLabels.includes('7 条列表项') && loadLabels.includes('展开全部标记'), loadLabels);

        await page.evaluate(() => {
            // 展开「列表区」的摘要行 → 7 条全部内联
            document.querySelector('#article-toc-list [data-mark-group="列表区"]').click();
        });
        const expanded = await readToc();
        check('summary row expands the whole list (0 → 7 inline) and leaves a 收起 row',
            expanded.lists === 11 && expanded.more === 14, expanded);
        const expandedLabels = await page.evaluate(() => {
            const collapseRow = document.querySelector('#article-toc-list [data-mark-collapse] .toc-item-text');
            return collapseRow?.textContent || '';
        });
        check('expanded list section collapse row says 收起条目', expandedLabels === '收起条目', expandedLabels);

        await page.evaluate(() => {
            // 展开态点最后一条列表条目（步骤七）→ 跳转 + 落点闪光
            const rows = Array.from(document.querySelectorAll('#article-toc-list .list-entry[data-mark-ref]'));
            rows[rows.length - 1].click();
        });
        const landed = await page.evaluate(() => {
            const flashed = Array.from(document.querySelectorAll('.tiptap li'))
                .filter(l => l.classList.contains('article-jump-target'));
            return { count: flashed.length, text: flashed[0]?.textContent || '' };
        });
        check('clicking a list TOC entry jumps and flashes the target list item (PM decoration)',
            landed.count === 1 && landed.text.includes('步骤七'), landed);

        await page.evaluate(() => document.querySelector('#article-toc-list [data-mark-collapse]').click());
        const collapsed = await readToc();
        check('collapse row restores the summary form', collapsed.lists === 4 && collapsed.more === 15, collapsed);

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
