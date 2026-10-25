/**
 * 轻提示（toast）回归：三类语气各自带类型色圆形图标 + 纯文本文案，
 * textContent 仍等于消息本身（既有回归、复制、读屏都依赖这一点），
 * 图标对读屏隐藏；静态提示不吃 timeoutMs 守卫、可点击关闭；
 * 容器不吃指针（不能挡住下面的编辑器），卡片各自可点。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body><div id="toast-container" class="toast-container"></div></body></html>', {
    url: 'http://localhost/',
});
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.getComputedStyle = dom.window.getComputedStyle;

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}`);
        if (detail !== undefined) console.error(`  ${detail}`);
    }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const { ToastManager } = await import('../public/managers/toaster.js');
    const container = document.getElementById('toast-container');
    const toaster = new ToastManager(container);

    /* ---- 1. 三种语气的结构与文案 ---- */
    const success = toaster.show('已加粗', 'success', false, 5000);
    const error = toaster.show('复制失败：剪贴板不可用', 'error', false, 5000);
    const info = toaster.show('已更新为当前时间', 'info', false, 5000);
    await wait(40);

    check('three toasts are mounted', container.querySelectorAll('.toast').length === 3, container.children.length);

    check('success toast carries its class', success.classList.contains('success'), success.className);
    check('error toast carries its class', error.classList.contains('error'), error.className);
    check('info toast carries its class', info.classList.contains('info'), info.className);

    // 图标是纯装饰：必须 aria-hidden，且不带文字。
    for (const [label, toast] of [['success', success], ['error', error], ['info', info]]) {
        const icon = toast.querySelector('.toast-icon');
        check(`${label} toast has an icon`, Boolean(icon));
        check(`${label} icon is hidden from screen readers`, icon?.getAttribute('aria-hidden') === 'true');
        check(`${label} icon has no text of its own`, icon?.textContent === '', JSON.stringify(icon?.textContent));
        check(`${label} icon renders an svg`, Boolean(icon?.querySelector('svg')));
    }

    // 文案在 .toast-text 里，且 toast.textContent 仍是纯消息（既有回归依赖它）。
    check('message lives in .toast-text', success.querySelector('.toast-text')?.textContent === '已加粗');
    check('toast textContent stays the plain message', success.textContent === '已加粗', JSON.stringify(success.textContent));
    check('error message is preserved verbatim',
        error.textContent === '复制失败：剪贴板不可用', JSON.stringify(error.textContent));

    /* ---- 2. 未知类型按 info 处理（与旧行为一致，不抛错） ---- */
    const unknown = toaster.show('未知类型', 'warning', false, 5000);
    await wait(20);
    check('unknown type degrades to info', unknown.classList.contains('info'), unknown.className);

    /* ---- 3. show 之后才挂 .show（入场过渡靠它） ---- */
    check('toast is not shown synchronously', !toaster.show('延迟', 'success', false, 5000).classList.contains('show'));
    await wait(30);
    check('toast gains .show after the frame', container.querySelectorAll('.toast.show').length > 0);

    /* ---- 4. timeoutMs 守卫：非静态且 <=0 时不出场 ---- */
    const before = container.children.length;
    const suppressed = toaster.show('不该出现', 'success', false, 0);
    check('non-static toast with timeout 0 is skipped', suppressed === undefined && container.children.length === before,
        container.children.length);

    /* ---- 5. 静态提示绕过守卫，且点击会关闭 ---- */
    let clicked = false;
    const staticToast = toaster.show('有新版本，点此刷新', 'info', true, 0, () => { clicked = true; });
    await wait(30);
    check('static toast ignores the timeout guard', Boolean(staticToast?.isConnected), staticToast?.className);
    staticToast.click();
    await wait(30);
    check('static toast fires its click handler', clicked === true);

    /* ---- 6. 普通提示点击即关（不触发任何业务回调） ---- */
    const plain = toaster.show('点我关掉', 'success', false, 5000);
    await wait(30);
    plain.click();
    check('plain toast leaves the shown state on click', !plain.classList.contains('show'), plain.className);

    /* ---- 7. clear() 清空静态提示 ---- */
    toaster.show('静态一', 'info', true, 0);
    toaster.show('静态二', 'info', true, 0);
    toaster.clear();
    check('clear removes every toast', container.children.length === 0, container.children.length);

    /* ---- 8. 样式契约：容器不吃指针、卡片可点、图标走类型色 ---- */
    const styles = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'styles.css'), 'utf8');
    const containerBlock = styles.match(/\.toast-container\s*\{([^}]*)\}/);
    check('toast container does not swallow pointer events',
        /pointer-events:\s*none/.test(containerBlock?.[1] || ''), containerBlock?.[1]);
    const toastBlock = styles.match(/\n\.toast\s*\{([^}]*)\}/);
    check('toast card re-enables pointer events', /pointer-events:\s*auto/.test(toastBlock?.[1] || ''), toastBlock?.[1]);
    check('toast card uses the theme surface instead of a hardcoded fill',
        /var\(--header-bg\)/.test(toastBlock?.[1] || ''), toastBlock?.[1]);
    check('toast text colour follows the theme', /var\(--text-color\)/.test(toastBlock?.[1] || ''), toastBlock?.[1]);
    check('success icon uses a green base', /\.toast\.success\s+\.toast-icon\s*\{[^}]*background:\s*#16a34a/.test(styles));
    check('error icon follows the danger token', /\.toast\.error\s+\.toast-icon\s*\{[^}]*background:\s*var\(--danger-color\)/.test(styles));
    check('info icon follows the primary token', /\.toast\.info\s+\.toast-icon\s*\{[^}]*background:\s*var\(--primary-color\)/.test(styles));

    /* 旧实现用满色块做底（--success-status-bg / --danger-status-bg），
       图标会被整块颜色淹没；确认那套已彻底移除。 */
    check('the flat colour-block backgrounds are gone',
        !/\.toast\.(success|error|info)\s*\{[^}]*background-color:\s*var\(--(success|danger)-status-bg\)/.test(styles));

    /* 提示条要让开底部工具条：收起态单行胶囊约 67px、展开态 5+4 两行约
       109px。写死一个 82px 只够前者——真机实测展开后 toast 与第二行按钮
       重叠 27px。 */
    const iosTheme = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'ios-theme.css'), 'utf8');
    check('mobile toast container clears the collapsed rail',
        /\.toast-container\s*\{[^}]*bottom:\s*calc\(env\(safe-area-inset-bottom,\s*0px\)\s*\+\s*7[0-9]px\)/.test(iosTheme),
        iosTheme.match(/\.toast-container\s*\{[^}]*\}/)?.[0]);
    check('expanded rail pushes the toast container further up',
        /body\.fab-expanded\s+\.toast-container\s*\{[^}]*bottom:\s*calc\(env\(safe-area-inset-bottom,\s*0px\)\s*\+\s*1[12][0-9]px\)/.test(iosTheme),
        iosTheme.match(/body\.fab-expanded\s+\.toast-container\s*\{[^}]*\}/)?.[0]);
    check('ios theme no longer overrides the toast radius with a pill',
        !/\.toast\s*\{[^}]*border-radius:\s*100px/.test(iosTheme));

    console.log('');
    if (failures > 0) {
        console.error(`${failures} toast checks failed`);
        process.exit(1);
    }
    console.log('Toast checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
