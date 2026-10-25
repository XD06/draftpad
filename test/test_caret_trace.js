/**
 * 真机取证记录器回归（jsdom）。它不参与修 bug 本身，但「下一个同类问题能不能
 * 在真机上取证」全押在它身上，所以钉住三件事：
 * 1) 关闭态零开销（不起帧循环、不挂监听）；
 * 2) 记录器的几何换算与带状归位**同一套约定**（整页滚动时 rect 已含 −scrollTop，
 *    视口坐标 = 文档位 − scrollTop）——取证数据如果说谎，结论就跟着错；
 * 3) export 脱离接收者也能调用（按钮/回调常把它当函数取走）。
 * 另加 app.js 与 service worker 的接线断言（本仓 public 模块的既有惯例）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
    }
}

async function main() {
const {
    createCaretTrace,
    installCaretTrace,
    isCaretTraceEnabled,
} = await import('../public/managers/caret-trace.js');

/* ---------------- 1) 开关 ---------------- */

check('默认关闭（不带参数、无 localStorage）',
    isCaretTraceEnabled('') === false, isCaretTraceEnabled(''));
check('?debugCaret=1 开启',
    isCaretTraceEnabled('?debugCaret=1') === true);
check('?debugCaret=0 不开启',
    isCaretTraceEnabled('?debugCaret=0') === false);
check('与 debugPerformance 互不干扰',
    isCaretTraceEnabled('?debugPerformance=1') === false);

/* ---------------- 2) 记录器本体 ---------------- */

let clock = 0;
const trace = createCaretTrace({ now: () => clock, maxSamples: 5 });
trace.mark('toggle.click', { mode: 'render' });
clock = 16;
trace.sample({ scrollTop: 1000, caretY: 300, viewportHeight: 844, clientHeight: 844, scrollHeight: 20000, mode: 'source', focus: 'textarea' });
clock = 32;
const jumped = trace.sample({ scrollTop: 4000, caretY: -2700, viewportHeight: 844, clientHeight: 844, scrollHeight: 20000 });
clock = 48;
const nudged = trace.sample({ scrollTop: 4020, caretY: -2720, viewportHeight: 844, clientHeight: 844, scrollHeight: 20000 });
check('相邻帧位移 >40px 记为跳变（真机那一下不用人肉翻）',
    jumped.jump === 3000, jumped);
check('小位移不记跳变（帧间抖动不刷屏）',
    nudged.jump === undefined, nudged);
check('t 用相对毫秒（可读时序）', jumped.t === 32, jumped.t);
const timeline = trace.timeline();
check('timeline 只带跳变样本 + 全部事件',
    timeline.jumps.length === 1 && timeline.events.length === 1, timeline);

// 环形缓冲：超上限丢最旧。上限有 50 的下限保护（`Math.max(50, …)`，再小就
// 装不下一次键盘动效的 2 秒），所以这里用 80 才测得到截断本身。
const boundedTrace = createCaretTrace({ now: () => clock, maxSamples: 80 });
for (let i = 0; i < 200; i += 1) boundedTrace.sample({ scrollTop: i, clientHeight: 844, scrollHeight: 20000 });
const bounded = JSON.parse(boundedTrace.export());
check('样本数受 maxSamples 上限（环形丢弃最旧）',
    bounded.samples.length === 80 && bounded.count.samples === 80 && bounded.samples[0].scrollTop === 120,
    bounded.count);

// export 脱离接收者：`const dump = trace.export` 后调用不能抛（本轮修掉的 this 绑定）。
const detached = boundedTrace.export;
let detachedError = null;
let detachedText = null;
try {
    detachedText = detached();
} catch (error) {
    detachedError = error.message;
}
check('export 可脱离接收者调用（当回调传给按钮不抛错）',
    detachedError === null && typeof detachedText === 'string' && JSON.parse(detachedText).count.samples === 80,
    detachedError);

trace.reset();
check('reset 清空样本与事件',
    JSON.parse(trace.export()).count.samples === 0 && JSON.parse(trace.export()).count.events === 0);

/* ---------------- 3) 装表：未触发零开销 + 几何约定 ---------------- */

const dom = new JSDOM('<!doctype html><html><body><div class="typora-editor-shell"><div class="vditor-wysiwyg"></div></div></body></html>', { url: 'http://localhost/' });
const doc = dom.window.document;
const page = { scrollTop: 17166, scrollHeight: 21723, clientHeight: 844, getBoundingClientRect: () => ({ top: -page.scrollTop }) };
// 移动端形态：内层不能滚（max 0），滚动容器 = 整页。
const inner = doc.querySelector('.typora-editor-shell .vditor-wysiwyg');
inner.getBoundingClientRect = () => ({ top: -page.scrollTop - 64 });
Object.defineProperty(doc, 'scrollingElement', { value: page, configurable: true });

// 源码 textarea：文档顶 64，故视口 rect.top = 64 − scrollTop（整页滚动的真实关系）。
const textarea = doc.createElement('textarea');
doc.body.appendChild(textarea);
textarea.value = 'x'.repeat(500);
textarea.selectionStart = 250;
textarea.clientWidth = 370;
textarea.getBoundingClientRect = () => ({ top: 64 - page.scrollTop });
textarea.focus();   // 记录器要写 activeElement 作为焦点标记

let rafQueue = [];
const win = {
    innerHeight: 844,
    requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
    addEventListener: () => {},
    setTimeout: () => {},
    getSelection: () => ({ rangeCount: 0 }),
    getComputedStyle: el => dom.window.getComputedStyle(el),
    visualViewport: null,
};
const editor = {
    scroller: inner,
    sourceMode: true,
    getSourceTextarea: () => textarea,
    setSourceMode(enabled) { this.setSourceModeCalls += 1; return `ret:${enabled}`; },
    setSourceModeCalls: 0,
};

const installed = installCaretTrace({ editor, win, doc, trace: createCaretTrace({ now: () => clock }) });
check('装表时不起帧循环（未触发前零开销）',
    rafQueue.length === 0, rafQueue.length);
check('scroller 身份判定与 getScrollContainer 一致（移动端为整页）',
    installed.readGeometry().scroller === 'page', installed.readGeometry());

// 光标的文档位与视口坐标：取证数据必须与**修复后的归位公式**同一套约定——
// 整页滚动时 rect 已含 −scrollTop，换算只加/减一次。当年归位函数多加了一次，
// 若记录器沿用同样的错误约定，日志就会替错误实现作证。
installed.refreshCaret();
check('文档位 = 视口 rect.top + scrollTop（一次加法）',
    installed.readGeometry().caretDocY === 64, installed.readGeometry());
clock = 100;
installed.takeSample();
const recorded = JSON.parse(installed.trace.export()).samples[0];
check('记录的光标视口坐标 = 文档位 − scrollTop',
    recorded.caretY === 64 - 17166, { got: recorded.caretY, want: 64 - 17166 });
check('记录带滚动与模式（能分辨源码/渲染、页滚/内滚）',
    recorded.scrollTop === 17166 && recorded.mode === 'source' && recorded.focus === 'textarea', recorded);

// 包装透传：打点不能吃掉适配器方法的返回值或参数。
const returned = editor.setSourceMode(true);
check('打点包装后仍透传参数与返回值',
    returned === 'ret:true' && editor.setSourceModeCalls === 1, { returned, calls: editor.setSourceModeCalls });
check('打点包装也起一段 burst（否则抓不到切换后的跳变）',
    rafQueue.length === 1, rafQueue.length);

/* ---------------- 4) 接线（本仓 public 模块惯例：源码断言） ---------------- */

const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const swSource = fs.readFileSync(path.join(ROOT, 'public', 'service-worker.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

check('app.js 引入记录器模块',
    /from '\.\/managers\/caret-trace\.js'/.test(appSource));
check('记录器只在开关为真时装表（默认零开销）',
    /if \(caretTraceHandle \|\| !isCaretTraceEnabled\(window\.location\.search\)\) return null;/.test(appSource));
check('装表早于恢复切换（否则漏掉「刷新即源码」第一跳）',
    appSource.indexOf('installCaretTraceIfEnabled(editorInstance);')
    < appSource.indexOf('restoreSourceModeIfRequested();', appSource.indexOf('installCaretTraceIfEnabled(editorInstance);')),
    { install: appSource.indexOf('installCaretTraceIfEnabled(editorInstance);'), restore: appSource.indexOf('restoreSourceModeIfRequested();') });
check('新模块已登记进 service worker CORE_ASSETS（PWA 离线不 404）',
    swSource.includes('"/managers/caret-trace.js"'));
check('npm 有 test:caret-trace 脚本',
    packageJson.scripts['test:caret-trace'] === 'node test/test_caret_trace.js',
    packageJson.scripts['test:caret-trace']);

console.log('');
if (failures > 0) {
    console.error(`${failures} caret-trace check(s) failed`);
    process.exit(1);
}
console.log('caret-trace checks passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
