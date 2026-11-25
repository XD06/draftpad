/**
 * 分享页真实浏览器回归（Desktop 1440x900 + Mobile 390x844）：
 * 启动独立临时 DumbPad 实例，上传真实宽图资产并创建涵盖全部 DumbPad 语法的文章，
 * 通过 /api/share/:id 打开 /s/:id?t=... 验证：
 * - Desktop 左栏 sticky 导航 + iOS 圆角卡片布局、滚屏目录高亮跟随
 * - Mobile 折叠左栏 → meta pills + 浮层目录弹窗
 * - dumbpad-width=360 宽图不撑破卡片（scrollWidth === innerWidth）+ 灯箱放大
 * - 代码块横向自滚、批注气泡视口内夹取、三态待办、非斜体引用块
 * - Dark mode 全套变量切换与零控制台错误
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '../..');

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

function waitForServer(child, port) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const tick = async () => {
            if (child.exitCode !== null) {
                reject(new Error('server exited early'));
                return;
            }
            try {
                const r = await fetch(`http://127.0.0.1:${port}/health`);
                if (r.ok) { resolve(); return; }
            } catch { /* retrying */ }
            if (Date.now() > deadline) {
                reject(new Error('server did not become healthy in time'));
                return;
            }
            setTimeout(tick, 200);
        };
        tick();
    });
}

async function bootServer() {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-share-browser-'));
    const env = {
        ...process.env,
        PORT: String(port),
        BASE_URL: `http://127.0.0.1:${port}`,
        DATA_DIR: dataDir,
        STORAGE_BACKEND: 'local',
        STORAGE_LAYOUT: 'legacy',
        DUMBPAD_PIN: '',
        AI_API_KEY: '',
        AI_INSIGHT_API_KEY: '',
        AI_EMBEDDING_API_KEY: '',
        NODE_ENV: 'development'
    };
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = [];
    child.stdout.on('data', (c) => logs.push(String(c)));
    child.stderr.on('data', (c) => logs.push(String(c)));
    try {
        await waitForServer(child, port);
    } catch (err) {
        child.kill();
        throw new Error(`${err.message}\n${logs.join('')}`);
    }
    return { child, port, dataDir };
}

(async () => {
    const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
    const { child, port, dataDir } = await bootServer();
    let browser = null;

    try {
        const base = `http://127.0.0.1:${port}`;
        const wideImg = await sharp({
            create: { width: 1400, height: 600, channels: 3, background: '#3b82f6' }
        }).png().toBuffer();

        const uploadRes = await fetch(`${base}/api/assets/images`, {
            method: 'POST',
            headers: {
                'content-type': 'image/png',
                'x-asset-name': encodeURIComponent('wide-sample.png')
            },
            body: wideImg
        });
        assert.equal(uploadRes.status, 201);
        const asset = await uploadRes.json();

        const title = 'B+C 分享设计实机验收';
        const longHeading = '超长章节标题验证在文章目录左侧窄栏中最多折叠显示两行避免无限换行破坏目录高度与视觉节奏';
        const filler = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段用于撑开页面高度，验证桌面左栏 sticky 目录跟随与移动端的阅读进度条行为。`).join('\n\n');
        const extraSections = Array.from({ length: 16 }, (_, i) => `### 子节 ${i + 1}\n\n子节内容占位用于撑高文章目录测试内滚动与底部跟随。`).join('\n\n');
        const content = [
            '---',
            'name: dumbpad-api',
            'description: Manage DumbPad through its authenticated HTTP API. Never edit storage directly.',
            'tags: [share, frontmatter]',
            '---',
            '',
            `# ${title}`,
            '',
            '> 中文引用块应当保持正体排版，不倾斜，且在暗色模式下具备清晰对比度。',
            '',
            '这里有一句带<span data-note="视口边界批注气泡验证：无论标注在行首还是行尾，弹窗都必须严丝合缝夹在屏幕安全边距以内。" style="text-decoration:underline wavy #e74c3c;">行内长批注文本点击可查看说明</span>的正文，还有 ==重点高亮==、<span data-draw="true" style="text-decoration:underline blue;">蓝色划线</span> 与 [[time:update@1:2026-11-14 10:00:00]]。',
            '',
            '## 任务与进度',
            '',
            '- [ ] 待办事项',
            '- [~] 进行中事项',
            '- [x] 已完成事项',
            '- 混排无序',
            '',
            '1. 有序列表对齐基准',
            '',
            '- 无序列表对齐基准',
            '',
            '第一行换行测试',
            '第二行换行测试',
            '',
            '## 宽图与代码约束',
            '',
            `![1400px 宽图](${asset.previewUrl} "dumbpad-width=360")`,
            '',
            '```javascript',
            'const superLongLineWithoutWrapping = "0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";',
            '```',
            '',
            '```mermaid',
            'flowchart TD',
            '    A[接收目标/任务] --> B[理解与规划<br/>下一步该做什么]',
            '    B --> C{需要用工具吗?}',
            '    C -- 是 --> D[调用工具<br/>查数据或搜网页]',
            '```',
            '',
            '```mermaid',
            'flowchart TD',
            '    BROKEN ====> [[[',
            '```',
            '',
            '| 列一 | 列二 | 列三 | 列四 |',
            '| --- | --- | --- | --- |',
            '| 超宽单元格内容示例 A | 超宽单元格内容示例 B | 超宽单元格内容示例 C | 超宽单元格内容示例 D |',
            '',
            '## 滚动章节',
            '',
            filler,
            '',
            `#### ${longHeading}`,
            '',
            extraSections
        ].join('\n');

        const createRes = await fetch(`${base}/api/notepads`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: title, content })
        });
        assert.equal(createRes.status, 200);
        const created = await createRes.json();
        const noteId = created.id;

        const shareRes = await fetch(`${base}/api/share/${noteId}`);
        assert.equal(shareRes.status, 200);
        const { shareUrl } = await shareRes.json();

        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const errors = [];

        // 1. Desktop 1440x900
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

        await page.goto(shareUrl, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => {
            const cards = document.querySelectorAll('.ios-mermaid-card');
            return cards.length === 2
                && Boolean(cards[0].querySelector('.ios-mermaid-stage svg'))
                && !cards[1].querySelector('.ios-mermaid-hint').hidden;
        }, null, { timeout: 10000 });

        const desktop = await page.evaluate(() => {
            const docEl = document.documentElement;
            const sheet = document.querySelector('.ios-sheet').getBoundingClientRect();
            const rail = document.querySelector('.doc-rail').getBoundingClientRect();
            const bq = document.querySelector('.markdown-body blockquote');
            const img = document.querySelector('.markdown-body img');
            const imgRect = img.getBoundingClientRect();
            const pre = document.querySelector('.markdown-body .ios-code-card pre');
            const codeKw = document.querySelector('.markdown-body .ios-code-card pre code.hljs .hljs-keyword');
            const codeStr = document.querySelector('.markdown-body .ios-code-card pre code.hljs .hljs-string');
            const h1Count = document.querySelectorAll('.markdown-body h1').length;
            const tocLinks = Array.from(document.querySelectorAll('#rail-nav a'));
            const tocItems = tocLinks.map((a) => a.textContent.trim());
            const tocBadges = tocLinks.map((a) => ({
                badge: a.querySelector('.toc-level-badge')?.getAttribute('data-badge') || '',
                badgePseudo: getComputedStyle(a.querySelector('.toc-level-badge'), '::before').content
            }));
            const listMetrics = (() => {
                const body = document.getElementById('article-body');
                const taskUl = body.querySelector('ul.task-list');
                const taskLi = taskUl.querySelector('li');
                const taskBox = taskLi.querySelector('.task-check').getBoundingClientRect();
                const ol = body.querySelector('ol');
                const ul = Array.from(body.querySelectorAll('ul')).find((u) => !u.classList.contains('task-list'));
                const firstCharLeft = (el) => {
                    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                    let n;
                    while ((n = w.nextNode())) { if (n.nodeValue.trim()) break; }
                    const idx = n.nodeValue.search(/\S/);
                    const r = document.createRange();
                    r.setStart(n, idx);
                    r.setEnd(n, idx + 1);
                    return Math.round(r.getBoundingClientRect().left * 10) / 10;
                };
                const mixedLis = Array.from(taskUl.querySelectorAll(':scope > li'));
                const mixedBulletLi = mixedLis[mixedLis.length - 1];
                const mixedBulletStyle = getComputedStyle(mixedBulletLi);
                const mixedBulletMarker = getComputedStyle(mixedBulletLi, '::marker');
                const olMarker = getComputedStyle(ol.querySelector('li'), '::marker');
                return {
                    taskPad: getComputedStyle(taskUl).paddingLeft,
                    olPad: getComputedStyle(ol).paddingLeft,
                    ulPad: getComputedStyle(ul).paddingLeft,
                    taskBoxLeftRel: Math.round((taskBox.left - body.getBoundingClientRect().left) * 10) / 10,
                    taskTextLeft: firstCharLeft(taskLi),
                    olTextLeft: firstCharLeft(ol.querySelector('li')),
                    ulTextLeft: firstCharLeft(ul.querySelector('li')),
                    mixedBulletIsTask: mixedBulletLi.classList.contains('task-item'),
                    mixedBulletListStyle: mixedBulletStyle.listStyleType,
                    mixedBulletMarker: mixedBulletMarker.content,
                    olMarkerTabular: olMarker.fontVariantNumeric,
                    olMarkerContent: olMarker.content,
                    olToUlGap: Math.round((ul.getBoundingClientRect().top - ol.getBoundingClientRect().bottom) * 10) / 10,
                    softBreakRendered: Array.from(body.querySelectorAll('p')).some((p) => /第一行换行测试<br\s*\/?>第二行换行测试/.test(p.innerHTML))
                };
            })();
            const longTocRect = tocLinks[3]?.getBoundingClientRect();
            const docRailEl = document.querySelector('.doc-rail');
            const railNavEl = document.querySelector('#rail-nav');
            const fmCardEl = document.querySelector('details.fm-card');
            const fmSummaryRect = fmCardEl?.querySelector('summary')?.getBoundingClientRect();
            const checks = Array.from(document.querySelectorAll('.task-check')).map((el) => el.getAttribute('data-task-state'));
            const mCards = document.querySelectorAll('.ios-mermaid-card');
            const mSvgRect = mCards[0].querySelector('.ios-mermaid-stage svg').getBoundingClientRect();
            return {
                overflow: docEl.scrollWidth - window.innerWidth,
                mobileBarDisplay: getComputedStyle(document.getElementById('mobile-nav')).display,
                railVisible: getComputedStyle(docRailEl).display !== 'none',
                railOverflowY: getComputedStyle(docRailEl).overflowY,
                railNavOverflowY: getComputedStyle(railNavEl).overflowY,
                railLeftOfSheet: rail.right < sheet.left,
                railToolsVisible: getComputedStyle(document.querySelector('.rail-tools')).display !== 'none',
                fmExists: Boolean(fmCardEl),
                fmOpenInitially: fmCardEl?.open ?? null,
                fmSummaryHeight: fmSummaryRect ? Math.round(fmSummaryRect.height) : 0,
                longTocHeight: longTocRect ? Math.round(longTocRect.height) : 0,
                bqFontStyle: getComputedStyle(bq).fontStyle,
                imgWidth: Math.round(imgRect.width),
                imgComplete: img.complete && img.naturalWidth > 0,
                preFitsSheet: pre.getBoundingClientRect().width <= sheet.width + 1,
                codeKwColor: codeKw ? getComputedStyle(codeKw).color : '',
                codeStrColor: codeStr ? getComputedStyle(codeStr).color : '',
                mermaidRendered: mSvgRect.width > 120 && mSvgRect.height > 60 && mSvgRect.width <= sheet.width,
                mermaidSourceHidden: mCards[0].querySelector('.ios-mermaid-source').hidden === true,
                brokenMermaidSourceShown: mCards[1].querySelector('.ios-mermaid-source').hidden === false,
                brokenMermaidHintShown: mCards[1].querySelector('.ios-mermaid-hint').hidden === false,
                h1Count,
                tocItems,
                tocBadges,
                listMetrics,
                checks
            };
        });

        assert.equal(desktop.overflow, 0, 'Desktop must have zero horizontal overflow');
        assert.equal(desktop.mobileBarDisplay, 'none', 'Desktop must hide mobile-only topbar');
        assert.equal(desktop.railVisible, true, 'Desktop left rail must be visible');
        assert.equal(desktop.railOverflowY, 'hidden', 'Outer .doc-rail should stay unscrollable so .rail-card stays pinned');
        assert.equal(desktop.railNavOverflowY, 'auto', 'Only inner #rail-nav should handle scrolling');
        assert.equal(desktop.railLeftOfSheet, true, 'Left rail must sit to the left of main sheet');
        assert.equal(desktop.railToolsVisible, true, 'Desktop left rail action strip must be visible');
        assert.equal(desktop.fmExists, true, 'Frontmatter must render as collapsible .fm-card');
        assert.equal(desktop.fmOpenInitially, false, 'Frontmatter card must default to collapsed');
        assert(desktop.fmSummaryHeight > 0 && desktop.fmSummaryHeight <= 44, `Expected compact single-row fm summary, got ${desktop.fmSummaryHeight}`);
        assert(desktop.longTocHeight > 0 && desktop.longTocHeight <= 50, `Long TOC title should clamp at 2 lines, got ${desktop.longTocHeight}px`);
        assert.equal(desktop.bqFontStyle, 'normal', 'Blockquotes must stay non-italic');
        assert(desktop.imgComplete, 'Uploaded image must load properly');
        assert(desktop.imgWidth >= 340 && desktop.imgWidth <= 365, `Expected ~360px width image, got ${desktop.imgWidth}`);
        assert.equal(desktop.preFitsSheet, true, 'Long code block must not push sheet wider');
        assert.equal(desktop.codeKwColor, 'rgb(215, 58, 73)', 'Light mode code keyword should use GitHub light red');
        assert.equal(desktop.codeStrColor, 'rgb(3, 47, 98)', 'Light mode code string should use GitHub light navy');
        assert.equal(desktop.mermaidRendered, true, 'Valid Mermaid diagram must render to bounded inline SVG');
        assert.equal(desktop.mermaidSourceHidden, true, 'Mermaid raw code must collapse when rendered');
        assert.equal(desktop.brokenMermaidSourceShown, true, 'Broken Mermaid diagram must keep source visible');
        assert.equal(desktop.brokenMermaidHintShown, true, 'Broken Mermaid diagram must display syntax hint');
        assert.equal(desktop.h1Count, 0, 'Duplicate H1 matching title should be deduplicated');
        assert.deepEqual(desktop.tocItems.slice(0, 4), ['任务与进度', '宽图与代码约束', '滚动章节', longHeading]);
        assert.deepEqual(
            desktop.tocBadges.slice(0, 4),
            [
                { badge: 'H2', badgePseudo: '"H2"' },
                { badge: 'H2', badgePseudo: '"H2"' },
                { badge: 'H2', badgePseudo: '"H2"' },
                { badge: 'H4', badgePseudo: '"H4"' }
            ],
            'Desktop TOC must visibly render H2/H4 level badges via CSS ::before'
        );
        assert.equal(desktop.listMetrics.taskPad, desktop.listMetrics.olPad, 'Share taskList and ol must share indentation');
        assert.equal(desktop.listMetrics.taskPad, desktop.listMetrics.ulPad, 'Share taskList and ul must share indentation');
        assert(desktop.listMetrics.taskBoxLeftRel > 0, 'Task checkbox must sit inside list gutter, not flush at 0');
        assert(
            Math.abs(desktop.listMetrics.taskTextLeft - desktop.listMetrics.olTextLeft) <= 1.5
            && Math.abs(desktop.listMetrics.taskTextLeft - desktop.listMetrics.ulTextLeft) <= 1.5,
            `Share list text left edges must align across task/ol/ul: ${JSON.stringify(desktop.listMetrics)}`
        );
        assert.equal(desktop.listMetrics.mixedBulletIsTask, false, 'Mixed bullet sibling must not get task-item class');
        assert.notEqual(desktop.listMetrics.mixedBulletListStyle, 'none', 'Mixed bullet sibling must retain bullet list-style');
        assert(desktop.listMetrics.mixedBulletMarker.includes('•'), `Mixed bullet marker must render bullet, got ${desktop.listMetrics.mixedBulletMarker}`);
        assert.equal(desktop.listMetrics.olMarkerTabular, 'tabular-nums', 'Share ol marker must use tabular-nums');
        assert(desktop.listMetrics.olMarkerContent.includes('counter(list-item)'), `Share ol marker unexpected: ${desktop.listMetrics.olMarkerContent}`);
        assert(desktop.listMetrics.olToUlGap > 0 && desktop.listMetrics.olToUlGap <= 8, `Adjacent list gap should stay compact (<=8px), got ${desktop.listMetrics.olToUlGap}`);
        assert.equal(desktop.listMetrics.softBreakRendered, true, 'Single newline inside share paragraph must render as <br>');
        assert(!desktop.tocItems.some((item) => item.includes('dumbpad-api')), 'Frontmatter must never leak into TOC');
        assert.deepEqual(desktop.checks, ['todo', 'doing', 'done']);

        // Toggle frontmatter details card open and verify key-value rows
        await page.click('.fm-card > summary');
        const fmExpanded = await page.evaluate(() => ({
            open: document.querySelector('details.fm-card').open,
            keys: Array.from(document.querySelectorAll('.fm-key')).map((k) => k.textContent.trim())
        }));
        assert.equal(fmExpanded.open, true);
        assert.deepEqual(fmExpanded.keys, ['name', 'description', 'tags']);

        // Scroll to page bottom and verify sticky rail stays pinned AND active TOC auto-scrolls into view
        await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
        await page.waitForTimeout(100);
        const atBottom = await page.evaluate(() => {
            const nav = document.getElementById('rail-nav');
            const active = nav.querySelector('a.active');
            const navRect = nav.getBoundingClientRect();
            const actRect = active.getBoundingClientRect();
            return {
                cardTop: Math.round(document.querySelector('.rail-card').getBoundingClientRect().top),
                activeText: active?.textContent.trim(),
                lastText: nav.querySelector('li:last-child a')?.textContent.trim(),
                visibleInNav: actRect.top >= navRect.top - 2 && actRect.bottom <= navRect.bottom + 2
            };
        });
        assert(atBottom.cardTop >= 18 && atBottom.cardTop <= 36, `Expected .rail-card pinned at top while TOC scrolls, got ${atBottom.cardTop}`);
        assert.equal(atBottom.activeText, atBottom.lastText, 'Scrolling to bottom should highlight the final TOC heading');
        assert.equal(atBottom.visibleInNav, true, 'Active TOC link must auto-scroll into view inside #rail-nav');

        // Toggle source view on Mermaid card and back to diagram
        await page.click('.ios-mermaid-card .ios-mermaid-tools button:first-child');
        assert.equal(await page.evaluate(() => document.querySelector('.ios-mermaid-card .ios-mermaid-source').hidden), false);
        await page.click('.ios-mermaid-card .ios-mermaid-tools button:first-child');
        assert.equal(await page.evaluate(() => document.querySelector('.ios-mermaid-card .ios-mermaid-source').hidden), true);

        // Open Mermaid diagram fullscreen lightbox
        await page.click('.ios-mermaid-card .ios-mermaid-stage');
        const svgLb = await page.evaluate(() => ({
            open: document.getElementById('lightbox').classList.contains('open'),
            svgWidth: document.querySelector('#lightbox-svg-paper svg')?.getBoundingClientRect().width || 0,
            paperHidden: document.getElementById('lightbox-svg-paper').hidden
        }));
        assert.equal(svgLb.open, true);
        assert.equal(svgLb.paperHidden, false);
        assert(svgLb.svgWidth > 180, 'Mermaid SVG lightbox should present enlarged vector diagram');
        await page.keyboard.press('Escape');

        // Scroll & verify sticky rail stays pinned near top (~24px) and active TOC advances
        await page.evaluate(() => window.scrollTo(0, 700));
        await page.waitForTimeout(150);
        const afterScroll = await page.evaluate(() => ({
            railTop: document.querySelector('.doc-rail').getBoundingClientRect().top,
            activeHref: document.querySelector('#rail-nav a.active')?.getAttribute('href') || ''
        }));
        assert(afterScroll.railTop >= 18 && afterScroll.railTop <= 42, `Expected sticky rail near top ~24px, got ${afterScroll.railTop}`);
        assert(afterScroll.activeHref.startsWith('#sec-'), 'Active TOC link should track scroll position');

        // Annotation popover clamped inside viewport
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.click('.has-annotation');
        const popRect = await page.evaluate(() => {
            const r = document.querySelector('.ios-popover').getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
        });
        assert(popRect.left >= 8 && popRect.right <= popRect.vw - 8, 'Annotation popover X must stay clamped');
        assert(popRect.top >= 8 && popRect.bottom <= popRect.vh - 8, 'Annotation popover Y must stay clamped');

        // Lightbox opens when clicking image
        await page.click('.markdown-body img');
        assert.equal(await page.evaluate(() => document.getElementById('lightbox').classList.contains('open')), true);
        await page.keyboard.press('Escape');

        // Dark theme switch (wait past 220ms background-color transition + verify Mermaid re-renders)
        const prevSvgId = await page.evaluate(() => document.querySelector('.ios-mermaid-stage svg').id);
        await page.click('#theme-btn');
        await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(28, 28, 30)', null, { timeout: 2000 });
        await page.waitForFunction((oldId) => {
            const cur = document.querySelector('.ios-mermaid-stage svg');
            return cur && cur.id !== oldId;
        }, prevSvgId, { timeout: 5000 });
        const darkState = await page.evaluate(() => ({
            attr: document.documentElement.getAttribute('data-theme'),
            bodyBg: getComputedStyle(document.body).backgroundColor,
            sheetBg: getComputedStyle(document.querySelector('.ios-sheet')).backgroundColor,
            codeKwColor: getComputedStyle(document.querySelector('.markdown-body .ios-code-card pre code.hljs .hljs-keyword')).color,
            codeStrColor: getComputedStyle(document.querySelector('.markdown-body .ios-code-card pre code.hljs .hljs-string')).color
        }));
        assert.equal(darkState.attr, 'dark');
        assert.equal(darkState.bodyBg, 'rgb(28, 28, 30)');
        assert.equal(darkState.sheetBg, 'rgb(44, 44, 46)');
        assert.equal(darkState.codeKwColor, 'rgb(255, 123, 114)', 'Dark mode code keyword should use GitHub dark coral');
        assert.equal(darkState.codeStrColor, 'rgb(165, 214, 255)', 'Dark mode code string should use GitHub dark sky blue');

        await page.close();

        // 2. Mobile 390x844 (with active Service Worker + >600ms slow share response)
        const mContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const mPage = await mContext.newPage();
        mPage.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
        mPage.on('console', (m) => { if (m.type() === 'error') errors.push(`mobile console.error: ${m.text()}`); });

        // First visit "/" to register SW and cache "/index.html" just like an installed mobile PWA user
        await mPage.goto(`${base}/`, { waitUntil: 'networkidle' });
        await mPage.evaluate(async () => {
            if (!('serviceWorker' in navigator)) return;
            await navigator.serviceWorker.ready;
        });

        // Delay /s/ response by 850ms (> 600ms NAVIGATION_NETWORK_TIMEOUT) to verify SW never falls back to /index.html
        await mPage.route('**/s/**', async (route) => {
            await new Promise((r) => setTimeout(r, 850));
            await route.continue();
        });

        await mPage.goto(shareUrl, { waitUntil: 'networkidle' });
        await mPage.unroute('**/s/**');
        await mPage.waitForFunction(() => Boolean(document.querySelector('.ios-mermaid-stage svg')), null, { timeout: 10000 });
        const mobile = await mPage.evaluate(() => ({
            isShareSheet: Boolean(document.querySelector('.ios-sheet')),
            isMainAppLeak: Boolean(document.getElementById('command-input')),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            navTop: document.getElementById('mobile-nav').getBoundingClientRect().top,
            navDisplay: getComputedStyle(document.getElementById('mobile-nav')).display,
            railDisplay: getComputedStyle(document.querySelector('.doc-rail')).display,
            pillsDisplay: getComputedStyle(document.querySelector('.meta-pills')).display,
            tocBtnDisplay: getComputedStyle(document.getElementById('toc-btn')).display,
            tocPopoverTitle: document.querySelector('.toc-popover-title')?.textContent.trim() || '',
            imgWidth: document.querySelector('.markdown-body img').getBoundingClientRect().width,
            mermaidWidth: document.querySelector('.ios-mermaid-stage svg').getBoundingClientRect().width
        }));
        assert.equal(mobile.isShareSheet, true, 'Mobile share link must render .ios-sheet even when SW is active and response > 600ms');
        assert.equal(mobile.isMainAppLeak, false, 'Mobile share link must never fall back to /index.html');
        assert.equal(mobile.overflow, 0, 'Mobile 390px must have zero horizontal overflow');
        assert.equal(mobile.navDisplay, 'flex', 'Mobile must show seamless top bar');
        assert.equal(Math.round(mobile.navTop), 0, 'Mobile top bar must sit flush at top edge (no floating gap)');
        assert.equal(mobile.railDisplay, 'none', 'Mobile should collapse left rail');
        assert.equal(mobile.pillsDisplay, 'flex', 'Mobile should reveal header meta pills');
        assert.notEqual(mobile.tocBtnDisplay, 'none', 'Mobile should show floating TOC popover toggle');
        assert.equal(mobile.tocPopoverTitle, '文章目录', 'Mobile TOC popover should display heading title');
        assert(mobile.imgWidth <= 354, `Mobile image must fit card inner width, got ${mobile.imgWidth}`);
        assert(mobile.mermaidWidth <= 354, `Mobile Mermaid SVG must stay bounded, got ${mobile.mermaidWidth}`);

        // Open mobile TOC popover, close via toggle/Escape, then click annotation
        await mPage.click('#toc-btn');
        assert.equal(await mPage.evaluate(() => document.getElementById('toc-popover').classList.contains('open')), true);
        await mPage.keyboard.press('Escape');
        assert.equal(await mPage.evaluate(() => document.getElementById('toc-popover').classList.contains('open')), false);
        await mPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await mPage.click('.has-annotation');
        const mPop = await mPage.evaluate(() => {
            const r = document.querySelector('.ios-popover').getBoundingClientRect();
            return { left: r.left, right: r.right, vw: window.innerWidth };
        });
        assert(mPop.left >= 8 && mPop.right <= mPop.vw - 8, 'Mobile annotation popover must stay inside viewport');
        await mContext.close();

        assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('; ')}`);
        console.log('browser share-page checks passed (Desktop 1440x900 & Mobile 390x844)');
    } finally {
        if (browser) await browser.close().catch(() => {});
        child.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
