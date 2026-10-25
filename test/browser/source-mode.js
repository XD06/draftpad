/**
 * 源码模式悬浮按钮真机回归（Chrome + playwright）：图标尺寸与按钮几何、
 * 与相邻按钮一致、编辑器未就绪时点击必须有反馈（不能静默）、就绪后进出源码视图。
 * 需要本机 Chrome 与可导入的 playwright；不在 npm test 里。
 */
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE);
const ROOT = path.join(__dirname, '..', '..'); const PORT = Number(process.env.DUMBPAD_TEST_PORT || 10081);
const wait = (port, t = 25000) => new Promise((res, rej) => {
  const s = Date.now();
  const tick = () => http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
    .on('error', () => Date.now() - s > t ? rej(new Error('timeout')) : setTimeout(tick, 250));
  tick();
});
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-fix-'));
  // 限速，制造"编辑器还没加载完用户就点了"的窗口
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), WS_PORT: String(PORT+1), DATA_DIR: dataDir, DUMBPAD_PIN: '', NODE_ENV: 'test' }, stdio: 'ignore' });
  let browser;
  const results = [];
  const check = (n, ok, d) => { results.push({n, ok, d}); };
  let failed = 0;
  // 中途抛错也要把已跑完的检查打出来：否则一次超时把全部结果吞掉，
  // 只能看到一行 ERR，分不清是回归失败还是夹具问题。
  const report = () => {
    for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.n}${!r.ok && r.d !== undefined ? ` :: ${JSON.stringify(r.d)}` : ''}`); if (!r.ok) failed++; }
    console.log(failed ? `\n${failed} source-mode browser check(s) failed` : '\nsource-mode browser checks passed');
  };
  try {
    await wait(PORT);
    browser = await chromium.launch({ channel: 'chrome', headless: true });

    // ===== A. 图标渲染检查 =====
    const p1 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await p1.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await p1.waitForTimeout(2500);
    const fill = await p1.locator('#toggle-source-mode svg').getAttribute('fill');
    check('图标为填充式（与参考一致）', fill === 'currentColor', fill);
    const btnBox = await p1.locator('#toggle-source-mode').boundingBox();
    const otherBox = await p1.locator('#copy-all').boundingBox();
    check('按钮尺寸与其他按钮一致', btnBox && otherBox && Math.round(btnBox.width) === Math.round(otherBox.width) && Math.round(btnBox.height) === Math.round(otherBox.height), {btn: btnBox, other: otherBox});
    check('按钮间距与相邻按钮一致(实测 2px)', btnBox && otherBox && Math.abs((btnBox.y + btnBox.height + 2) - otherBox.y) <= 2, {btnBottom: btnBox?.y + btnBox?.height, otherTop: otherBox?.y});

    // 图标「墨迹」尺寸必须与邻居一致：图形在 viewBox 里的占比各不相同，
    // 统一写 20×20 会有一圈视觉差。这里量的是 getBBox × 渲染缩放 = 实际可见
    // 图形宽度，与 <svg width> 属性无关（</> 图形只占 viewBox 的 80%，
    // 按 20 渲染只有 16px，明显比邻居小，所以按钮用 22×22）。
    const ink = await p1.evaluate(() => {
      const measure = (id) => {
        const svg = document.querySelector(`#${id} svg`);
        if (!svg) return null;
        const rect = svg.getBoundingClientRect();
        const box = svg.getBBox();
        const scale = rect.width / (svg.viewBox.baseVal.width || 1);
        return box.width * scale;
      };
      const source = measure('toggle-source-mode');
      const neighbours = ['copy-all', 'toggle-today-drafts', 'toggle-reflections', 'toggle-plan']
        .map(measure).filter(v => typeof v === 'number');
      const average = neighbours.reduce((sum, v) => sum + v, 0) / neighbours.length;
      return { source, average, deviation: Math.abs(source - average) / average };
    });
    check(
        '图标可见尺寸与其他按钮一致（偏差 <5%）',
        ink.source && ink.average && ink.deviation < 0.05,
        {源: +ink.source?.toFixed(2), 邻均: +ink.average?.toFixed(2), 偏差: `${(ink.deviation * 100).toFixed(1)}%`},
    );

    // 开启态必须看得出区别：工具条上阅读模式/即时草稿都有 `#id.active` 规则，
    // 这个按钮曾经没有——实测开关前后 color/background 与邻居完全相同，
    // 用户看不出自己停在源码模式。这里量 computed 值，不量类名（类名对了
    // 但样式没写，用户看到的还是没反应）。
    const activeStyle = await p1.evaluate(async () => {
      const btn = document.getElementById('toggle-source-mode');
      const neighbour = document.getElementById('copy-all');
      const read = () => { const s = getComputedStyle(btn); return { color: s.color, bg: s.backgroundColor }; };
      const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 260))));
      btn.blur();
      if (btn.classList.contains('active')) { btn.classList.remove('active'); await settle(); }
      const off = read();
      btn.classList.add('active');
      await settle();
      const on = read();
      btn.classList.remove('active');
      const n = getComputedStyle(neighbour);
      return { off, on, neighbour: { color: n.color, bg: n.backgroundColor } };
    });
    check('源码模式开启态与关闭态可分辨（computed 样式）',
        activeStyle.on.bg !== activeStyle.off.bg || activeStyle.on.color !== activeStyle.off.color,
        activeStyle);
    check('关闭态与普通按钮一致（没有残留高亮）',
        activeStyle.off.bg === activeStyle.neighbour.bg, activeStyle);

    await p1.close();

    // ===== B. 编辑器未就绪时点击（你遇到的"没反应"） =====
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p2 = await ctx.newPage();
    // 阻断编辑器 bundle，模拟"编辑器永远没加载完"
    await p2.route('**/vendor/tiptap/tiptap.bundle.js', route => route.abort());
    await p2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(2500);
    const clicked = await p2.evaluate(async () => {
      const btn = document.getElementById('toggle-source-mode');
      btn.click();
      await new Promise(r => setTimeout(r, 1200));
      const texts = [...document.querySelectorAll('.toast')].map(e => e.textContent?.trim());
      return { toast: texts.find(t => t && t.includes('源码')) || null, hasErrorToast: texts.some(t => t && t.includes('源码模式不可用')), texts, pressed: btn.getAttribute('aria-pressed') };
    });
    check('编辑器未就绪时点击给出反馈（toaster 去重后仍保留错误提示）', clicked.hasErrorToast || clicked.toast !== null, clicked);
    await p2.close();

    // ===== C. 编辑器就绪后点击正常 =====
    const p3 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await p3.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await p3.waitForTimeout(2500);
    // 建两篇文章（走 API），再刷新让应用列表拿到它们——不刷新则侧栏里没有这两条，
    // selectNotepad 会直接早退，量到的就是空正文（第一版夹具就踩了这个）。
    await p3.evaluate(async () => {
      const make = async (name, content) => {
        const r = await fetch('/api/notepads', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, content }),
        });
        return (await r.json()).id;
      };
      await make('SrcProbe A', '# A 标题\n\nA 正文');
      await make('SrcProbe B', '# B 标题\n\nB 正文');
    });
    await p3.reload({ waitUntil: 'networkidle' });
    await p3.waitForTimeout(2000);
    const state = () => p3.evaluate(() => {
      const ta = document.querySelector('.tiptap-source-textarea');
      const scroller = document.querySelector('.typora-editor-shell .vditor-wysiwyg');
      const card = document.querySelector('.typora-editor-shell .tiptap');
      const rect = ta ? ta.getBoundingClientRect() : null;
      return {
        taDisplay: ta ? getComputedStyle(ta).display : 'absent',
        scrollerDisplay: scroller ? getComputedStyle(scroller).display : 'absent',
        cardDisplay: card ? getComputedStyle(card).display : 'absent',
        taInView: rect ? (rect.top < window.innerHeight && rect.bottom > 0 && rect.height > 100) : false,
        renderedHeading: document.querySelector('.tiptap h1')?.textContent?.trim() || null,
        taFirstLine: ta ? ta.value.split('\n')[0] : null,
      };
    });
    // 「点了没反应」的真实形态：渲染卡片没藏住（行内 display 被 !important 压过），
    // textarea 被顶到卡片下方一屏之外。藏的是卡片 .tiptap、滚动层保持可见
    // （源码 textarea 挂在滚动层里，两者共用同一个滚动容器）。
    await p3.locator('#toggle-source-mode').click();
    await p3.waitForTimeout(500);
    const inSource = await state();
    check('进源码后渲染卡片真的隐藏（computed display）', inSource.cardDisplay === 'none', inSource);
    check('进源码后滚动层保持可见（源码与渲染共用滚动容器）', inSource.scrollerDisplay !== 'none', inSource);
    check('进源码后 textarea 可见且在视口内', inSource.taDisplay === 'block' && inSource.taInView, inSource);
    await p3.locator('#toggle-source-mode').click();
    await p3.waitForTimeout(500);
    const backToRender = await state();
    check('再点切回渲染（卡片恢复、源码隐藏）',
        backToRender.cardDisplay !== 'none' && backToRender.taDisplay !== 'block', backToRender);

    // 源码模式里切文章 → 退出：正文必须是当前文章，不能是上一篇。
    // 走侧栏点击（真实用户手势），不用深链——深链的正文到达时机不稳定。
    const pickSidebar = async (label) => {
      // 限定在目录树里：.sidebar-item-wrapper 在「最近编辑」面板里也有一份，
      // 那个面板默认隐藏，.first() 会选中它然后卡在「element is not visible」。
      await p3.locator(`#directory-tree .sidebar-item-wrapper:has-text("${label}")`).first().click();
      await p3.waitForTimeout(1500);
    };
    await pickSidebar('SrcProbe A');
    await p3.locator('#toggle-source-mode').click();
    await p3.waitForTimeout(400);
    const aSource = await state();
    check('A 文源码模式显示 A 的原文', aSource.taFirstLine === '# A 标题', aSource);
    await pickSidebar('SrcProbe B');
    const afterSwitch = await state();
    check('源码模式中切文章会刷新 textarea 为新文章', afterSwitch.taFirstLine === '# B 标题', afterSwitch);
    await p3.locator('#toggle-source-mode').click();
    await p3.waitForTimeout(700);
    const afterExit = await state();
    check('退出源码后渲染的是 B 而非上一篇 A', afterExit.renderedHeading === 'B 标题', afterExit);

    // 源码模式的持久化：刷新后仍在源码模式，且内容是当前文章（不是空、不是上一篇）。
    await p3.locator('#toggle-source-mode').click();
    await p3.waitForTimeout(400);
    await p3.reload({ waitUntil: 'networkidle' });
    await p3.waitForTimeout(2500);
    const afterReload = await state();
    check('刷新后恢复源码模式且正文为当前文章',
        afterReload.taDisplay === 'block' && afterReload.scrollerDisplay !== 'none'
        && afterReload.taFirstLine === '# B 标题', afterReload);

    // ===== D. 长文章：视线保持 + 源码区随内容撑高 =====
    const p4 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await p4.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await p4.waitForTimeout(1500);
    await p4.evaluate(async () => {
      const blocks = [];
      for (let i = 1; i <= 120; i += 1) {
        blocks.push(`## 小节 ${i}\n\n这是第 ${i} 段正文，用来把文章撑到足够长以测滚动。\n\n- 条目 A${i}\n- 条目 B${i}`);
      }
      const r = await fetch('/api/notepads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Long Scroll', content: `# 长文章测试\n\n${blocks.join('\n\n')}` }),
      });
      await r.json();
    });
    await p4.reload({ waitUntil: 'networkidle' });
    await p4.waitForTimeout(2500);
    await p4.locator(`#directory-tree .sidebar-item-wrapper:has-text("Long Scroll")`).first().click();
    await p4.waitForTimeout(2000);
    const scrollProbe = () => p4.evaluate(() => {
      const scroller = document.querySelector('.typora-editor-shell .vditor-wysiwyg');
      const ta = document.querySelector('.tiptap-source-textarea');
      const max = scroller.scrollHeight - scroller.clientHeight;
      return {
        frac: max > 0 ? scroller.scrollTop / max : 0,
        max,
        taOwnsScrollbar: ta ? (ta.scrollHeight - ta.clientHeight > 2) : null,
        taGrewWithContent: ta ? ta.getBoundingClientRect().height > 1500 : null,
      };
    });
    for (const target of [0.5, 1]) {
      await p4.evaluate(f => {
        const s = document.querySelector('.typora-editor-shell .vditor-wysiwyg');
        s.scrollTop = f * (s.scrollHeight - s.clientHeight);
      }, target);
      await p4.waitForTimeout(600);
      const before = await scrollProbe();
      await p4.locator('#toggle-source-mode').click();
      await p4.waitForTimeout(1500);
      const inSource = await scrollProbe();
      await p4.locator('#toggle-source-mode').click();
      await p4.waitForTimeout(1500);
      const back = await scrollProbe();
      check(`长文章：视线 ${target} 进源码后保持`, Math.abs(before.frac - inSource.frac) < 0.05, { before: before.frac, inSource: inSource.frac });
      check(`长文章：视线 ${target} 切回渲染后保持`, Math.abs(before.frac - back.frac) < 0.05, { before: before.frac, back: back.frac });
      if (target === 1) {
        check('长文章源码区随内容撑高、不自带滚动条（与渲染几何一致）',
            inSource.taOwnsScrollbar === false && inSource.taGrewWithContent === true, inSource);
      }
    }
    // 切换后用户自己滚动：恢复循环必须让位，不能把人拽回去。
    await p4.locator('#toggle-source-mode').click();
    await p4.waitForTimeout(80);
    await p4.evaluate(() => {
      const s = document.querySelector('.typora-editor-shell .vditor-wysiwyg');
      s.scrollTop = s.scrollHeight;
    });
    await p4.waitForTimeout(1200);
    const userScroll = await scrollProbe();
    check('切换后用户自己滚动不被恢复逻辑拽回', userScroll.frac > 0.95, userScroll);
    // ===== F. 光标跟随（用户诉求：光标在文末，切源码也该在文末） =====
    // 用真实鼠标点击放置光标（合成 Range 不会走 PM 的 selectionUpdate，测不到
    // 「用户放过光标」这条链路），再量两侧编辑面的落点。
    const caretProbe = () => p4.evaluate(() => {
      const ta = document.querySelector('.tiptap-source-textarea');
      const inSource = Boolean(ta && getComputedStyle(ta).display !== 'none');
      if (inSource) {
        const value = ta.value;
        const offset = ta.selectionStart;
        return {
          mode: 'source',
          around: value.slice(Math.max(0, offset - 10), offset + 10),
        };
      }
      const sel = window.getSelection();
      const node = sel.anchorNode;
      const element = node && node.nodeType === 3 ? node.parentElement : node;
      const block = element && element.closest ? element.closest('h1,h2,h3,p,li') : null;
      const text = block ? block.textContent.slice(0, 24) : null;
      return {
        mode: 'render',
        blockText: text,
        blockSection: text ? (text.match(/(\d+)/) || [])[1] || null : null,
      };
    });
    const sectionParagraph = (num) => p4.locator(`.tiptap p:has-text("这是第 ${num} 段正文")`).first();
    // 上一段用例结束时停在源码模式，这里先回到渲染模式再测。
    await p4.evaluate(() => {
      const ta = document.querySelector('.tiptap-source-textarea');
      if (ta && getComputedStyle(ta).display !== 'none') {
        document.getElementById('toggle-source-mode').click();
      }
    });
    await p4.waitForTimeout(1200);
    await sectionParagraph(30).scrollIntoViewIfNeeded();
    await p4.waitForTimeout(400);
    await sectionParagraph(30).click({ position: { x: 30, y: 8 } });
    await p4.waitForTimeout(400);
    const placed = await caretProbe();
    check('真实点击能在渲染模式放下光标', placed.mode === 'render' && placed.blockSection === '30', placed);
    await p4.locator('#toggle-source-mode').click();
    await p4.waitForTimeout(1600);
    const entered = await caretProbe();
    const enteredLine = entered.around.includes('30');
    check('进源码后光标跟到同一段（第 30 段附近）', entered.mode === 'source' && enteredLine, entered);
    await p4.locator('#toggle-source-mode').click();
    await p4.waitForTimeout(1600);
    const returned = await caretProbe();
    check('切回渲染后光标回到第 30 段', returned.mode === 'render' && returned.blockSection === '30', returned);

    // 源码里移动光标 → 切回渲染，光标应跟到渲染侧对应的位置
    await p4.locator('#toggle-source-mode').click();
    await p4.waitForTimeout(1200);
    await p4.evaluate(() => {
      const ta = document.querySelector('.tiptap-source-textarea');
      const offset = ta.value.indexOf('这是第 90 段正文') + 6;
      ta.focus();
      ta.setSelectionRange(offset, offset);
      ta.dispatchEvent(new Event('keyup'));
    });
    await p4.waitForTimeout(300);
    await p4.locator('#toggle-source-mode').click();
    await p4.waitForTimeout(1600);
    const moved = await caretProbe();
    check('源码里移动光标后切回渲染会跟到第 90 段', moved.mode === 'render' && moved.blockSection === '90', moved);
    await p4.close();

    // ===== E. 移动端：整页滚动（ios-theme），滚动容器不是 .vditor-wysiwyg =====
    // 桌面量的是内滚容器；移动端 .vditor-wysiwyg 的 scrollHeight == clientHeight
    // （max 0），视线在 document.scrollingElement 上。只盯 scroller 会让移动端
    // 每次切换都回到顶部（真机实测 page.scrollTop 23863 → 0），所以必须走
    // getScrollContainer()。这条只有真浏览器（带移动端媒体查询）能证。
    const p5 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await p5.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await p5.waitForTimeout(2500);
    // 移动端侧栏是离屏抽屉（默认不可见），真实点击点不到；本段要量的是滚动行为，
    // 所以直接派发 click 选中文章，手势本身由桌面段（C/D）覆盖。
    await p5.evaluate(() => {
      const item = [...document.querySelectorAll('#directory-tree .dir-item')]
        .find(el => el.textContent.includes('Long Scroll'));
      item.click();
    });
    await p5.waitForTimeout(2000);
    const pageFrac = () => p5.evaluate(() => {
        const page = document.scrollingElement;
        const max = page.scrollHeight - page.clientHeight;
        const inner = document.querySelector('.typora-editor-shell .vditor-wysiwyg');
        return {
            pageFrac: max > 0 ? page.scrollTop / max : 0,
            innerIsScroller: (inner.scrollHeight - inner.clientHeight) > 1,
        };
    });
    await p5.evaluate(() => { const p = document.scrollingElement; p.scrollTop = p.scrollHeight; });
    await p5.waitForTimeout(700);
    const mBefore = await pageFrac();
    check('移动端确实是整页滚动（内层不是滚动容器）', mBefore.innerIsScroller === false && mBefore.pageFrac > 0.95, mBefore);
    // 移动端工具条默认收在 FAB 后面（body:not(.fab-expanded) 隐藏这些按钮），
    // 真实点击点不到；本段量的是滚动，手势由桌面段覆盖。
    const mToggle = () => p5.evaluate(() => document.getElementById('toggle-source-mode').click());
    await mToggle();
    await p5.waitForTimeout(1500);
    const mSource = await pageFrac();
    check('移动端进源码后视线保持（不是回到顶部）', Math.abs(mBefore.pageFrac - mSource.pageFrac) < 0.05, { before: mBefore.pageFrac, inSource: mSource.pageFrac });
    await mToggle();
    await p5.waitForTimeout(1500);
    const mBack = await pageFrac();
    check('移动端切回渲染后视线保持', Math.abs(mBefore.pageFrac - mBack.pageFrac) < 0.05, { before: mBefore.pageFrac, back: mBack.pageFrac });
    await p5.close();

    // ===== F. 移动端：关键盘后带着光标切换（真机报告「光标还在、视线被重置到顶」） =====
    // 与 E 段的差别：E 段无焦点无光标（纯比例路径）；真机的形态是「用户刚在
    // 编辑（有可信光标）、关键盘、再点切换」。两股会重置视线的滚动只在移动
    // 形态暴露：textarea.focus 的默认滚动对准元素盒（内容等高，一次拽到底）、
    // 编辑器聚焦时 PM scrollIntoView 把光标怼到视口顶缘（实测 y≈5）。桌面点
    // 按钮会先失焦，正好绕开这两条路——所以必须用聚焦 + 光标 + 假键盘几何
    // （--dumbpad-vvh 与 keyboard-open，等价 app.js 的 vv handler 落到的几何）
    // 在移动视口里复现。断言：光标落在可见带内（不贴顶不贴底、不被甩出屏）。
    const p6 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await p6.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await p6.waitForTimeout(2500);
    await p6.evaluate(() => {
      const item = [...document.querySelectorAll('#directory-tree .dir-item')]
        .find(el => el.textContent.includes('Long Scroll'));
      item.click();
    });
    await p6.waitForTimeout(2000);
    // 光标放到小节 100（约 83% 处）并聚焦编辑器，模拟「正在编辑」
    await p6.evaluate(() => {
      const heads = [...document.querySelectorAll('.tiptap h2')];
      const target = heads.find(h => h.textContent.includes('100'));
      target.scrollIntoView({ block: 'center' });
      const ed = document.querySelector('.tiptap');
      ed.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await p6.waitForTimeout(400);
    // 假键盘开→关（不动真实 vv：量的是切换链路对几何变化的鲁棒性）
    await p6.evaluate(() => {
      document.documentElement.style.setProperty('--dumbpad-vvh', '420px');
      document.documentElement.classList.add('keyboard-open');
    });
    await p6.waitForTimeout(300);
    await p6.evaluate(() => {
      document.documentElement.style.removeProperty('--dumbpad-vvh');
      document.documentElement.classList.remove('keyboard-open');
    });
    await p6.waitForTimeout(300);
    const caretProbe6 = () => p6.evaluate(() => {
      const page = document.scrollingElement;
      const max = page.scrollHeight - page.clientHeight;
      const ta = document.querySelector('.tiptap-source-textarea');
      let caretY = null;
      if (ta && getComputedStyle(ta).display !== 'none') {
        // textarea 自身不滚（高度由内容撑开）：用镜像法量光标行的视口纵坐标
        const before = ta.value.slice(0, ta.selectionStart || 0);
        const cs = getComputedStyle(ta);
        const mirror = document.createElement('div');
        Object.assign(mirror.style, {
          position: 'absolute', left: '-99999px', visibility: 'hidden',
          width: ta.clientWidth + 'px', font: cs.font, lineHeight: cs.lineHeight,
          whiteSpace: 'pre-wrap', wordBreak: cs.wordBreak, padding: '0', boxSizing: 'content-box',
        });
        mirror.textContent = before;
        const marker = document.createElement('span');
        marker.textContent = '\u200b';
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        caretY = Math.round(ta.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0) + marker.offsetTop);
        mirror.remove();
      } else {
        const sel = window.getSelection();
        caretY = sel && sel.rangeCount ? Math.round(sel.getRangeAt(0).getBoundingClientRect().top) : null;
      }
      return { caretY, frac: max > 0 ? +(page.scrollTop / max).toFixed(3) : 0 };
    });
    const mToggle6 = () => p6.evaluate(() => document.getElementById('toggle-source-mode').click());
    await mToggle6();
    await p6.waitForTimeout(1600);
    const fSource = await caretProbe6();
    check('移动端带光标进源码：光标落在可见带内（不被甩出屏）',
        fSource.caretY !== null && fSource.caretY > 84 && fSource.caretY < 760, fSource);
    check('移动端带光标进源码：视线不在顶部（比例保持）', fSource.frac > 0.2, fSource);
    await mToggle6();
    await p6.waitForTimeout(1600);
    const fBack = await caretProbe6();
    check('移动端带光标切回渲染：光标在可见带内（不被怼到顶缘）',
        fBack.caretY !== null && fBack.caretY > 84 && fBack.caretY < 760, fBack);
    check('移动端带光标切回渲染：视线不在顶部（比例保持）', fBack.frac > 0.2, fBack);
    await p6.close();

    // ===== G. 移动端：源码模式下键盘开/关的视线归位（真机报告：关键盘后视线飞到最上面） =====
    // 机制：源码 textarea 是「内容等高」元素，浏览器的键盘滚动对准的是元素盒
    // ——元素顶就是文档顶，于是「光标留原地、视线到顶部」。渲染模式没这个问题
    // （contenteditable 的键盘滚动对准选区），切换链路已由 F 段覆盖。无头环境
    // 没有真键盘：手动复现「浏览器把视线滚到文档顶」，再派发 visualViewport
    // 的 resize（键盘开/收都伴随它），断言落定后按光标带状归位、光标与视线
    // 重新统一。
    const p7 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await p7.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await p7.waitForTimeout(2500);
    await p7.evaluate(() => {
      const item = [...document.querySelectorAll('#directory-tree .dir-item')]
        .find(el => el.textContent.includes('Long Scroll'));
      item.click();
    });
    await p7.waitForTimeout(2000);
    await p7.evaluate(() => document.getElementById('toggle-source-mode').click());
    await p7.waitForTimeout(800);
    // 「正在源码里编辑」：光标放在 80% 处并聚焦，视线也在光标附近
    await p7.evaluate(() => {
      const ta = document.querySelector('.tiptap-source-textarea');
      ta.focus();
      const offset = Math.floor(ta.value.length * 0.8);
      ta.setSelectionRange(offset, offset);
      const p = document.scrollingElement;
      p.scrollTop = (p.scrollHeight - p.clientHeight) * 0.8;
    });
    await p7.waitForTimeout(200);
    // 复现真机形态：键盘滚动把视线甩到文档顶；键盘收起伴随 vv resize
    await p7.evaluate(() => {
      document.scrollingElement.scrollTop = 0;
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await p7.waitForTimeout(700);
    const gState = await p7.evaluate(() => {
      const p = document.scrollingElement;
      const max = p.scrollHeight - p.clientHeight;
      const ta = document.querySelector('.tiptap-source-textarea');
      const before = ta.value.slice(0, ta.selectionStart || 0);
      const cs = getComputedStyle(ta);
      const mirror = document.createElement('div');
      Object.assign(mirror.style, {
        position: 'absolute', left: '-99999px', visibility: 'hidden',
        width: ta.clientWidth + 'px', font: cs.font, lineHeight: cs.lineHeight,
        whiteSpace: 'pre-wrap', wordBreak: cs.wordBreak, padding: '0', boxSizing: 'content-box',
      });
      mirror.textContent = before;
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      mirror.appendChild(marker);
      document.body.appendChild(mirror);
      const caretY = Math.round(ta.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0) + marker.offsetTop);
      mirror.remove();
      return { frac: max > 0 ? +(p.scrollTop / max).toFixed(3) : 0, caretY, focused: document.activeElement === ta };
    });
    check('源码模式关键盘后视线按光标归位（不再停在顶部）', gState.frac > 0.2, gState);
    check('源码模式关键盘后光标在可见带内', gState.caretY > 84 && gState.caretY < 760, gState);
    await p7.close();

    report();
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.log('ERR', e.message);
    report();
    process.exitCode = 1;
  }
  finally { if (browser) await browser.close().catch(()=>{}); server.kill(); fs.rmSync(dataDir,{recursive:true,force:true}); }
})();
