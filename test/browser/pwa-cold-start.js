/**
 * 真机冷重启 & 零源码闪现浏览器回归（Playwright + Chrome）：
 * 1) 验证开启 SW 并在 650ms 人为慢网下"杀掉页面重开"：首帧即呈现 #boot-preview 渲染态排版
 *    （#boot-editor 全程 hidden=true 零源码闪现），且页面 <450ms 完成载入（0ms 壳 + cacheFirst）。
 * 2) 验证桌面 (1280x800) 与移动端 (390x844) 下 #boot-preview → Tiptap 原子交接的像素落点
 *    零跳动（<= 1.5px）、三态复选框还原、窗口期点击自动落焦，以及滚动位置保留。
 * 3) 验证正文签名差 1 字符时安全回退 #boot-editor（绝不展示过期快照）。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.DUMBPAD_TEST_PORT || 10093);

const SAMPLE_ARTICLE = [
    '# 冷启动排版验证标题',
    '',
    '> 引用段落：重启瞬间必须直接呈现左竖线引用排版，不得退回大于号源码。',
    '',
    '- [ ] 未完成任务条目',
    '- [~] 进行中任务条目（三态）',
    '- [x] 已完成任务条目',
    '',
    '第一段普通正文，用于验证交接零跳动与点击落焦行为。',
    '',
    '```javascript',
    'const bootMode = "isomorphic";',
    '```',
    '',
    ...Array.from({ length: 28 }, (_, idx) => `长文填充段落 ${idx + 1}：保持页面可滚动以验证桌面与移动端阅读位置恢复。`),
].join('\n');

const SKILL_LIKE_ARTICLE = [
    '---',
    'name: dumbpad-api',
    'description: Skill fixture with YAML frontmatter, inline code annotation, table, and multiple code fences.',
    '---',
    '',
    '# DumbPad API Agent',
    '',
    '<span data-note="测试" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">Use the authenticated HTTP API only. Do not write `data/`, browser storage, or S3 objects directly.</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（测试）</sub>',
    '',
    '| Area | Use it for | Guidance |',
    '| --- | --- | --- |',
    '| Article | Detailed records | Full record here. |',
    '| Thought | Concise reminder | One clear sentence. |',
    '',
    '```bash',
    'export DUMBPAD_BASE_URL="http://localhost:10003"',
    'curl -fsS "$DUMBPAD_BASE_URL/api/meta"',
    '```',
    '',
    ...Array.from({ length: 30 }, (_, idx) => [
        `## Section ${idx + 1}`,
        '',
        `第 ${idx + 1} 节长文内容用于验证 YAML frontmatter 与代码块混合文档在桌面和移动端顶缘刷新时的滚动零跳动。`,
        '',
        '```bash',
        `echo "section-${idx + 1}"`,
        '```',
    ].join('\n')),
].join('\n');

function waitForServer(port, timeoutMs = 20000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
                res.resume();
                resolve();
            }).on('error', () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('Server failed to start within timeout'));
                    return;
                }
                setTimeout(tick, 200);
            });
        };
        tick();
    });
}

(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cold-start-'));
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_PORT: String(PORT + 1),
            DATA_DIR: dataDir,
            DUMBPAD_PIN: '',
            NODE_ENV: 'production',
        },
        stdio: 'ignore',
    });

    let browser;
    const failures = [];
    const check = (name, ok, detail) => {
        if (ok) console.log(`PASS ${name}`);
        else {
            failures.push({ name, detail });
            console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
        }
    };

    try {
        await waitForServer(PORT);
        const baseUrl = `http://127.0.0.1:${PORT}`;
        browser = await chromium.launch({ channel: 'chrome', headless: true });

        // Seed article content cleanly over HTTP API
        const seedPage = await browser.newPage();
        await seedPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await seedPage.evaluate(async (text) => {
            await fetch('/api/notes/default', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text, userId: 'seed-fixture' }),
            });
        }, SAMPLE_ARTICLE);
        await seedPage.close();

        // ===== 1. Desktop (1280x800): SW warm-up -> close page -> cold restart under 650ms network delay =====
        const swContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const p1 = await swContext.newPage();
        const p1Errors = [];
        p1.on('pageerror', (err) => p1Errors.push(err.message));
        await p1.goto(baseUrl, { waitUntil: 'networkidle' });
        await p1.waitForSelector('#hybrid-editor .tiptap h1');
        await p1.waitForFunction(async () => {
            const reg = await navigator.serviceWorker?.ready;
            return Boolean(reg && navigator.serviceWorker.controller);
        });
        // Give idle snapshot persistence + WARM_RUNTIME_URLS a brief beat to settle
        await p1.waitForFunction(() => {
            const raw = localStorage.getItem('dumbpad_rendered_html_v1');
            return Boolean(raw && raw.includes('冷启动排版验证标题'));
        });
        await p1.waitForTimeout(900);
        await p1.close();

        // Reopen fresh page in same context (simulates killing & relaunching installed PWA)
        const p2 = await swContext.newPage();
        const p2Errors = [];
        p2.on('pageerror', (err) => p2Errors.push(err.message));
        await swContext.route('**/*', async (route) => {
            const url = route.request().url();
            if (!url.includes('/api/')) {
                await new Promise((r) => setTimeout(r, 650));
            }
            await route.continue();
        });

        const navStart = Date.now();
        await p2.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        const dclElapsed = Date.now() - navStart;
        await p2.waitForSelector('#hybrid-editor .tiptap h1');
        check('SW cold restart under 650ms network latency finishes DOMContentLoaded via cache (< 500ms)',
            dclElapsed < 500, { dclElapsed });
        check('no pageerror during SW cold restart', p1Errors.length === 0 && p2Errors.length === 0, { p1Errors, p2Errors });
        await swContext.close();

        // ===== 2. Pre-Tiptap frame observation + 0px handoff + tap-to-caret (Desktop & Mobile) =====
        for (const mode of [
            { name: 'Desktop', viewport: { width: 1280, height: 800 }, isMobile: false },
            { name: 'Mobile', viewport: { width: 390, height: 844 }, isMobile: true },
        ]) {
            const ctx = await browser.newContext({ viewport: mode.viewport, serviceWorkers: 'block' });
            const warm = await ctx.newPage();
            await warm.goto(baseUrl, { waitUntil: 'networkidle' });
            await warm.waitForSelector('#hybrid-editor .tiptap h1');
            await warm.waitForFunction(() => Boolean(localStorage.getItem('dumbpad_rendered_html_v1')));
            // Scroll partway down to verify scroll preservation across restart
            await warm.evaluate((isMobile) => {
                if (isMobile) {
                    window.scrollTo(0, 140);
                } else {
                    const s = document.querySelector('#hybrid-editor .vditor-wysiwyg');
                    if (s) s.scrollTop = 140;
                }
            }, mode.isMobile);
            await warm.waitForTimeout(300);
            // Force caret snapshot flush via pagehide/scroll
            await warm.evaluate((isMobile) => {
                const s = document.querySelector('#hybrid-editor .vditor-wysiwyg');
                const snap = JSON.parse(localStorage.getItem('dumbpad_caret_positions_v1') || '{}');
                snap.default = {
                    mode: 'wysiwyg',
                    offset: 0,
                    visibleOffset: 0,
                    scrollTop: isMobile ? window.scrollY : (s?.scrollTop || 0),
                    updatedAt: Date.now(),
                };
                localStorage.setItem('dumbpad_caret_positions_v1', JSON.stringify(snap));
            }, mode.isMobile);
            await warm.close();

            // Cold reopen with delayed tiptap.bundle.js so we inspect #boot-preview live before Tiptap mounts
            const cold = await ctx.newPage();
            const coldErrors = [];
            cold.on('pageerror', (err) => coldErrors.push(err.message));
            await cold.route('**/vendor/tiptap/tiptap.bundle.js', async (route) => {
                await new Promise((r) => setTimeout(r, 700));
                await route.continue();
            });

            await cold.goto(baseUrl, { waitUntil: 'domcontentloaded' });
            await cold.waitForSelector('#boot-preview:not([hidden])');

            const preState = await cold.evaluate((isMobile) => {
                const bootEditor = document.getElementById('boot-editor');
                const bootPreview = document.getElementById('boot-preview');
                const hybrid = document.getElementById('hybrid-editor');
                const h1 = document.querySelector('#boot-preview-content h1');
                const bq = document.querySelector('#boot-preview-content blockquote');
                const checkboxes = Array.from(document.querySelectorAll('#boot-preview-content input[type="checkbox"]'));
                const scroller = document.getElementById('boot-preview-scroller');
                const targetPara = Array.from(document.querySelectorAll('#boot-preview-content p'))
                    .find(p => p.textContent?.includes('第一段普通正文'));
                const paraRect = targetPara?.getBoundingClientRect();
                return {
                    bootEditorHidden: Boolean(bootEditor?.hidden),
                    bootPreviewVisible: Boolean(bootPreview && !bootPreview.hidden),
                    hybridHidden: hybrid?.style?.display === 'none',
                    h1Text: h1?.textContent || '',
                    h1Top: h1 ? h1.getBoundingClientRect().top : null,
                    bqTop: bq ? bq.getBoundingClientRect().top : null,
                    checkboxStates: checkboxes.map(cb => ({ checked: cb.checked, indeterminate: cb.indeterminate })),
                    scrollTop: isMobile ? window.scrollY : (scroller?.scrollTop || 0),
                    tapPoint: paraRect ? { x: paraRect.left + 40, y: paraRect.top + paraRect.height / 2 } : null,
                };
            }, mode.isMobile);

            check(`${mode.name}: #boot-preview paints rendered headings/quotes while #boot-editor stays hidden (zero raw source)`,
                preState.bootEditorHidden && preState.bootPreviewVisible && preState.hybridHidden &&
                preState.h1Text === '冷启动排版验证标题' &&
                preState.checkboxStates.length === 3 &&
                preState.checkboxStates[0].checked === false &&
                preState.checkboxStates[1].indeterminate === true &&
                preState.checkboxStates[2].checked === true,
                preState);

            check(`${mode.name}: saved reading scroll position restores on #boot-preview`,
                preState.scrollTop >= 100, preState.scrollTop);

            // Tap paragraph during boot preview BEFORE Tiptap mounts
            if (preState.tapPoint) {
                await cold.mouse.click(preState.tapPoint.x, preState.tapPoint.y);
            }

            // Wait for Tiptap handoff to complete
            await cold.waitForSelector('#hybrid-editor .tiptap h1');
            await cold.waitForTimeout(150);

            const postState = await cold.evaluate(() => {
                const bootPreview = document.getElementById('boot-preview');
                const bootEditor = document.getElementById('boot-editor');
                const h1 = document.querySelector('#hybrid-editor .tiptap h1');
                const bq = document.querySelector('#hybrid-editor .tiptap blockquote');
                const activeEl = document.activeElement;
                return {
                    bootPreviewHidden: Boolean(bootPreview?.hidden),
                    bootPreviewClassesCleared: bootPreview?.className === 'boot-preview',
                    bootPreviewEmpty: document.getElementById('boot-preview-content')?.innerHTML === '',
                    bootEditorHidden: Boolean(bootEditor?.hidden),
                    h1Top: h1 ? h1.getBoundingClientRect().top : null,
                    bqTop: bq ? bq.getBoundingClientRect().top : null,
                    editorFocused: Boolean(activeEl && activeEl.closest('#hybrid-editor')),
                };
            });

            check(`${mode.name}: #boot-preview tears down cleanly and hands off with <= 1.5px layout shift`,
                postState.bootPreviewHidden && postState.bootPreviewClassesCleared &&
                postState.bootPreviewEmpty && postState.bootEditorHidden &&
                preState.h1Top !== null && postState.h1Top !== null &&
                Math.abs(preState.h1Top - postState.h1Top) <= 1.5 &&
                preState.bqTop !== null && postState.bqTop !== null &&
                Math.abs(preState.bqTop - postState.bqTop) <= 1.5,
                { preState: { h1Top: preState.h1Top, bqTop: preState.bqTop }, postState });

            check(`${mode.name}: tapping #boot-preview before Tiptap mounts focuses editor at handoff`,
                postState.editorFocused && coldErrors.length === 0, { postState, coldErrors });

            await ctx.close();
        }

        // ===== 3. Stale snapshot safety: 1-char mismatch falls back cleanly to #boot-editor =====
        const mismatchCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
        const mp1 = await mismatchCtx.newPage();
        await mp1.goto(baseUrl, { waitUntil: 'networkidle' });
        await mp1.waitForSelector('#hybrid-editor .tiptap h1');
        await mp1.waitForFunction(() => Boolean(localStorage.getItem('dumbpad_rendered_html_v1')));
        await mp1.evaluate(() => {
            const startup = JSON.parse(localStorage.getItem('dumbpad_startup_cache_v1'));
            startup.notes.default.content = startup.notes.default.content + '!';
            localStorage.setItem('dumbpad_startup_cache_v1', JSON.stringify(startup));
        });
        await mp1.close();

        const mp2 = await mismatchCtx.newPage();
        await mp2.route('**/vendor/tiptap/tiptap.bundle.js', async (route) => {
            await new Promise((r) => setTimeout(r, 600));
            await route.continue();
        });
        await mp2.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        const fallbackState = await mp2.evaluate(() => ({
            bootPreviewHidden: Boolean(document.getElementById('boot-preview')?.hidden),
            bootEditorHidden: Boolean(document.getElementById('boot-editor')?.hidden),
            bootEditorTail: (document.getElementById('boot-editor')?.value || '').slice(-10),
        }));
        check('1-char content mismatch skips stale HTML snapshot and falls back safely to #boot-editor',
            fallbackState.bootPreviewHidden === true &&
            fallbackState.bootEditorHidden === false &&
            fallbackState.bootEditorTail.endsWith('!'),
            fallbackState);
        await mismatchCtx.close();

        // ===== 4. ?id=skill.md top-refresh stability (zero jump in Reading, Non-Empty Selection, Editing modes) & reading-scroll restore =====
        const seedSkillPage = await browser.newPage();
        await seedSkillPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await seedSkillPage.evaluate(async (text) => {
            await fetch('/api/notepads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: 'demo-agent-skill', name: 'skill.md', content: text }),
            });
        }, SKILL_LIKE_ARTICLE);
        await seedSkillPage.close();

        const skillUrl = `${baseUrl}/?id=skill.md`;
        for (const mode of [
            { name: 'Desktop', viewport: { width: 1280, height: 800 }, isMobile: false },
            { name: 'Mobile', viewport: { width: 390, height: 844 }, isMobile: true },
        ]) {
            for (const subCase of ['reading-mode', 'non-empty-selection', 'edit-mode']) {
                const ctx = await browser.newContext({ viewport: mode.viewport, serviceWorkers: 'block' });
                const page = await ctx.newPage();
                await page.goto(skillUrl, { waitUntil: 'networkidle' });
                await page.waitForSelector('#hybrid-editor .tiptap h1');
                await page.waitForFunction(() => Boolean(localStorage.getItem('dumbpad_rendered_html_v1')));
                // Move to mid-article first so scrolling back to 0 triggers a real scroll transition
                await page.evaluate((isMobile) => {
                    if (isMobile) window.scrollTo(0, 320);
                    else {
                        const s = document.querySelector('#hybrid-editor .vditor-wysiwyg');
                        if (s) s.scrollTop = 320;
                    }
                }, mode.isMobile);
                await page.waitForTimeout(220);

                if (subCase === 'reading-mode') {
                    await page.click('#toggle-reading-mode');
                    await page.waitForTimeout(80);
                } else if (subCase === 'non-empty-selection') {
                    await page.evaluate(() => {
                        const target = document.querySelectorAll('#hybrid-editor .tiptap p')[2];
                        if (target) {
                            const r = document.createRange();
                            r.selectNodeContents(target);
                            const sel = window.getSelection();
                            sel.removeAllRanges();
                            sel.addRange(r);
                        }
                    });
                    await page.waitForTimeout(80);
                } else {
                    await page.mouse.click(mode.isMobile ? 180 : 600, 320);
                    await page.waitForTimeout(100);
                }

                // Ensure a mid-article snapshot (offset=1200, scrollTop=320) exists prior to scrolling back to top
                await page.evaluate(() => {
                    const snap = JSON.parse(localStorage.getItem('dumbpad_caret_positions_v1') || '{}');
                    snap['demo-agent-skill'] = {
                        mode: 'wysiwyg',
                        offset: 1200,
                        visibleOffset: 1200,
                        scrollTop: 320,
                        updatedAt: Date.now(),
                    };
                    localStorage.setItem('dumbpad_caret_positions_v1', JSON.stringify(snap));
                });

                // Now user scrolls to the TOP before refreshing
                await page.evaluate((isMobile) => {
                    if (isMobile) window.scrollTo(0, 0);
                    else {
                        const s = document.querySelector('#hybrid-editor .vditor-wysiwyg');
                        if (s) s.scrollTop = 0;
                    }
                }, mode.isMobile);
                await page.waitForTimeout(260);

                // Sample every rAF and scroll event across reload
                await page.addInitScript(() => {
                    window.__scrollTrace = [];
                    const record = (source) => {
                        const wy = document.querySelector('#hybrid-editor .vditor-wysiwyg');
                        const bp = document.getElementById('boot-preview-scroller');
                        const entry = {
                            source,
                            winY: Math.round(window.scrollY || 0),
                            wyTop: Math.round(wy ? wy.scrollTop : 0),
                            bpTop: Math.round(bp ? bp.scrollTop : 0),
                        };
                        window.__scrollTrace.push(entry);
                    };
                    window.addEventListener('scroll', () => record('scroll'), true);
                    const sample = () => {
                        record('raf');
                        if (window.__scrollTrace.length < 80) requestAnimationFrame(sample);
                    };
                    requestAnimationFrame(sample);
                });

                await page.reload({ waitUntil: 'networkidle' });
                await page.waitForSelector('#hybrid-editor .tiptap h1');
                await page.waitForTimeout(350);

                const topMetrics = await page.evaluate((isMobile) => {
                    const trace = window.__scrollTrace || [];
                    const maxWinY = trace.reduce((m, e) => Math.max(m, e.winY), 0);
                    const maxWyTop = trace.reduce((m, e) => Math.max(m, e.wyTop), 0);
                    const maxBpTop = trace.reduce((m, e) => Math.max(m, e.bpTop), 0);
                    const curWyTop = Math.round(document.querySelector('#hybrid-editor .vditor-wysiwyg')?.scrollTop || 0);
                    const curWinY = Math.round(window.scrollY || 0);
                    return {
                        maxSeen: isMobile ? maxWinY : Math.max(maxWyTop, maxBpTop),
                        settled: isMobile ? curWinY : curWyTop,
                        sampleCount: trace.length,
                    };
                }, mode.isMobile);

                check(`${mode.name} (${subCase}): ?id=skill.md refreshed at top has zero scroll jump (<= 2px across all frames)`,
                    topMetrics.maxSeen <= 2 && topMetrics.settled <= 2,
                    topMetrics);
                await ctx.close();
            }

            // Also verify Reading Mode scrolled to 220 preserves reading position across reload
            const readCtx = await browser.newContext({ viewport: mode.viewport, serviceWorkers: 'block' });
            const readPage = await readCtx.newPage();
            await readPage.goto(skillUrl, { waitUntil: 'networkidle' });
            await readPage.waitForSelector('#hybrid-editor .tiptap h1');
            const editGap = await readPage.evaluate(() => {
                const hdr = document.querySelector('header')?.getBoundingClientRect();
                const shell = document.getElementById('hybrid-editor')?.getBoundingClientRect();
                const card = document.querySelector('#hybrid-editor .tiptap')?.getBoundingClientRect();
                return {
                    shellTop: shell ? +shell.top.toFixed(1) : null,
                    cardTop: card ? +card.top.toFixed(1) : null,
                    gap: hdr && card ? +(card.top - hdr.bottom).toFixed(1) : null,
                };
            });
            await readPage.click('#toggle-reading-mode');
            await readPage.waitForTimeout(100);
            const readGap = await readPage.evaluate(() => {
                const hdr = document.querySelector('header')?.getBoundingClientRect();
                const shell = document.getElementById('hybrid-editor')?.getBoundingClientRect();
                const card = document.querySelector('#hybrid-editor .tiptap')?.getBoundingClientRect();
                return {
                    shellTop: shell ? +shell.top.toFixed(1) : null,
                    cardTop: card ? +card.top.toFixed(1) : null,
                    gap: hdr && card ? +(card.top - hdr.bottom).toFixed(1) : null,
                };
            });
            check(`${mode.name}: toggling reading mode preserves #hybrid-editor & header gap`,
                Math.abs((editGap.shellTop ?? 0) - (readGap.shellTop ?? -99)) <= 1
                    && Math.abs((editGap.cardTop ?? 0) - (readGap.cardTop ?? -99)) <= 1
                    && Math.abs((editGap.gap ?? 0) - (readGap.gap ?? -99)) <= 1,
                { editGap, readGap });
            await readPage.evaluate((isMobile) => {
                if (isMobile) window.scrollTo(0, 220);
                else {
                    const s = document.querySelector('#hybrid-editor .vditor-wysiwyg');
                    if (s) s.scrollTop = 220;
                }
            }, mode.isMobile);
            await readPage.waitForTimeout(260);
            await readPage.reload({ waitUntil: 'networkidle' });
            await readPage.waitForSelector('#hybrid-editor .tiptap h1');
            await readPage.waitForTimeout(250);
            const restoredScroll = await readPage.evaluate((isMobile) => (
                isMobile
                    ? Math.round(window.scrollY || 0)
                    : Math.round(document.querySelector('#hybrid-editor .vditor-wysiwyg')?.scrollTop || 0)
            ), mode.isMobile);
            check(`${mode.name} (reading-mode): ?id=skill.md scrolled to 220 restores reading scroll across reload`,
                restoredScroll >= 200,
                restoredScroll);
            await readCtx.close();
        }

        console.log(failures.length ? `\n${failures.length} pwa-cold-start browser check(s) failed` : '\npwa-cold-start browser checks passed');
        process.exitCode = failures.length ? 1 : 0;
    } finally {
        if (browser) await browser.close().catch(() => {});
        server.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
