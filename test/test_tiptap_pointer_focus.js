/**
 * 非文本元素点按夺焦守卫回归：点图片 / 附件胶囊 / 嵌入媒体 / 代码块工具条 /
 * mermaid 预览这些装饰性节点时，mousedown 的默认行为必须被拦掉——否则浏览器
 * 会把焦点交给 contenteditable 并**把上一次的光标滚进视野**（光标在文首、
 * 滚到底部点一张图，视线被拽回文首），移动端还会顺带弹软键盘。
 * 原生媒体控件与表单控件必须保留默认行为，否则控件点不动。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.DocumentFragment = dom.window.DocumentFragment;
global.MutationObserver = dom.window.MutationObserver;
global.navigator = dom.window.navigator;
global.getSelection = dom.window.getSelection.bind(dom.window);
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.getComputedStyle = dom.window.getComputedStyle;
global.HTMLAnchorElement = dom.window.HTMLAnchorElement;
if (!dom.window.requestAnimationFrame) {
    dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
}
dom.window.document.elementFromPoint = function elementFromPoint() { return null; };
global.document.elementFromPoint = dom.window.document.elementFromPoint;
dom.window.Element.prototype.getClientRects = function getClientRects() { return []; };
dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
dom.window.Range.prototype.getBoundingClientRect = function getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
dom.window.Range.prototype.getClientRects = function getClientRects() { return []; };

const bundlePath = path.join(ROOT, 'public', 'vendor', 'tiptap', 'tiptap.bundle.js');
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: 'tiptap.bundle.js' });
if (!global.DumbPadTiptap) {
    console.error('FAIL: tiptap bundle did not expose global DumbPadTiptap');
    process.exit(1);
}

const ASSET_ID = 'abcdef0123456789';
const IMAGE_SRC = `/api/assets/${ASSET_ID}/preview`;
const FILE_TITLE = 'dumbpad-file=1;size=1258291;type=application%2Fpdf';
const MEDIA_TITLE = 'dumbpad-video=1;size=1000;type=video%2Fmp4;name=clip';

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}`);
        if (detail) console.error(`  ${detail}`);
    }
}

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const {
        _resetPointerFocusStateForTests,
        focusEditorWithoutScroll,
        isChromePointerTarget,
        isTouchNoKeyboardTarget,
        isTouchOrMobileViewport,
        releaseEditorFocus,
        settleEditorFocusAfterAction,
    } = await import('../public/managers/tiptap-pointer-focus.js');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const view = editor.editor.view;
    const root = container.querySelector('.tiptap');

    const mousedownOn = (element) => {
        const event = new dom.window.MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0, view: dom.window,
        });
        element.dispatchEvent(event);
        return event;
    };

    /* ---- 1. 图片：mousedown 默认行为被拦（不夺焦、不滚光标） ---- */
    editor.setValue(`![示意图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    const img = root.querySelector('img');
    check('image is rendered', Boolean(img));
    check('image mousedown is default-prevented', mousedownOn(img).defaultPrevented);

    /* ---- 2. 附件胶囊 ---- */
    editor.setValue(`[报告.pdf · 1.2 MB](/api/assets/${ASSET_ID}/download "${FILE_TITLE}")`, false);
    const fileLink = root.querySelector('a.dumbpad-article-file');
    check('attachment capsule is rendered', Boolean(fileLink));
    check('attachment mousedown is default-prevented', mousedownOn(fileLink).defaultPrevented);

    /* ---- 3. 嵌入媒体卡片：卡片本体拦，原生播放器放行 ---- */
    editor.setValue(`![clip · 1 KB](/api/assets/${ASSET_ID}/original "${MEDIA_TITLE}")`, false);
    const media = root.querySelector('.dumbpad-article-media');
    const video = media?.querySelector('video');
    check('media card is rendered', Boolean(media) && Boolean(video));
    if (media && video) {
        check('media card mousedown is default-prevented', mousedownOn(media).defaultPrevented);
        check('native video mousedown is NOT prevented', mousedownOn(video).defaultPrevented === false);
    }

    /* ---- 4. 代码块工具条 / 复制按钮：拦；但按钮本体属于表单控件，放行 ---- */
    editor.setValue('```js\nconst a = 1;\n```', false);
    const codeHeader = root.querySelector('.dumbpad-code-header');
    const copyButton = root.querySelector('.dumbpad-code-copy');
    check('code header is rendered', Boolean(codeHeader));
    check('code header mousedown is default-prevented', mousedownOn(codeHeader).defaultPrevented);
    // 复制按钮有自己的 mousedown 处理（它本来就要 preventDefault 以保住选区），
    // 所以这里断言的是「守卫不认领它」——否则两套逻辑会互相干扰。
    check('code copy button is not a chrome target', isChromePointerTarget(copyButton) === false);

    /* ---- 5. 正文文字与表格单元格不受影响（必须照常放光标） ---- */
    editor.setValue('普通段落', false);
    const paragraph = root.querySelector('p');
    check('plain paragraph mousedown is NOT prevented', mousedownOn(paragraph).defaultPrevented === false);

    /* ---- 6. 判定函数本身：装饰性命中、原生控件与正文不命中 ---- */
    editor.setValue(`![图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    const freshImg = root.querySelector('img');
    check('isChromePointerTarget hits image', isChromePointerTarget(freshImg) === true);
    check('isChromePointerTarget misses plain text', isChromePointerTarget(root.querySelector('p')) === false);
    const fakeInput = document.createElement('input');
    check('isChromePointerTarget misses form controls', isChromePointerTarget(fakeInput) === false);
    check('isChromePointerTarget tolerates null', isChromePointerTarget(null) === false);

    /* ---- 7. 阅读模式：不拦（此时点图要开 lightbox，原生行为无害） ---- */
    editor.setValue(`![示意图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    editor.setReadingMode(true);
    const readImg = root.querySelector('img');
    check('reading mode does not guard mousedown', mousedownOn(readImg).defaultPrevented === false);
    editor.setReadingMode(false);

    /* ---- 8. 右键不拦（上下文菜单是另一条路径） ---- */
    editor.setValue(`![示意图](${IMAGE_SRC} "dumbpad-width=360")`, false);
    const rightImg = root.querySelector('img');
    const rightEvent = new dom.window.MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 2, view: dom.window,
    });
    rightImg.dispatchEvent(rightEvent);
    check('right button mousedown is not guarded', rightEvent.defaultPrevented === false);

    /* ---- 9. 时间标记与批注徽标同样被桌面 mousedown 守卫拦截（不夺焦/不滚旧光标） ---- */
    editor.setValue('[[time:create:2026-01-01 00:00:00]] 正文 <span data-note="笔记" style="text-decoration:underline wavy #e74c3c;">批注段落</span>', false);
    const timeMarker = root.querySelector('.md-time-marker');
    const badge = root.querySelector('.annotation-badge');
    check('time marker is a chrome pointer target', Boolean(timeMarker) && isChromePointerTarget(timeMarker) === true);
    check('time marker mousedown is default-prevented', Boolean(timeMarker) && mousedownOn(timeMarker).defaultPrevented === true);
    check('annotation badge is a chrome pointer target', Boolean(badge) && isChromePointerTarget(badge) === true);
    check('annotation badge mousedown is default-prevented', Boolean(badge) && mousedownOn(badge).defaultPrevented === true);
    // 桌面下编辑器绝不写入 inputmode="none" 或 virtualkeyboardpolicy
    check('desktop editor never sets inputmode=none', root.getAttribute('inputmode') === null, root.getAttribute('inputmode'));
    check('desktop editor never sets virtualkeyboardpolicy',
        root.getAttribute('virtualkeyboardpolicy') === null, root.getAttribute('virtualkeyboardpolicy'));

    /* ---- 10. 移动端 Scheme B（inputmode="none" 状态机与触屏焦点释放） ---- */
    const pointerEvent = (type, props = {}) => {
        const event = new dom.window.MouseEvent(type, {
            bubbles: true, cancelable: true, view: dom.window, ...props,
        });
        Object.defineProperty(event, 'pointerId', { value: props.pointerId ?? 1 });
        Object.defineProperty(event, 'pointerType', { value: props.pointerType ?? 'touch' });
        return event;
    };
    const origMatchMedia = dom.window.matchMedia;
    const origMaxTouchPointsDescriptor = Object.getOwnPropertyDescriptor(dom.window.navigator, 'maxTouchPoints');
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
        _resetPointerFocusStateForTests();
        dom.window.matchMedia = (query) => ({
            matches: query === '(pointer: coarse)' || query === '(hover: none)',
            media: query,
            addListener() {},
            removeListener() {},
        });
        Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { value: 5, configurable: true });
        check('isTouchOrMobileViewport detects coarse touch environment', isTouchOrMobileViewport() === true);

        const mobileContainer = document.createElement('div');
        document.body.appendChild(mobileContainer);
        const mobileEditor = new HybridMarkdownEditor(mobileContainer, {});
        await mobileEditor.whenReady();
        const mobileView = mobileEditor.editor.view;
        const mobileRoot = mobileContainer.querySelector('.tiptap');

        check('mobile editor initializes unfocused with inputmode=none and virtualkeyboardpolicy=manual',
            mobileRoot.getAttribute('inputmode') === 'none'
            && mobileRoot.getAttribute('virtualkeyboardpolicy') === 'manual',
            `${mobileRoot.getAttribute('inputmode')} / ${mobileRoot.getAttribute('virtualkeyboardpolicy')}`);

        mobileEditor.setValue('第一段普通正文\n\n- [ ] 待办任务条目\n\n[[time:create:2026-01-01 00:00:00]]\n\n<mark>高亮句子</mark>', false);
        const plainPara = mobileRoot.querySelector('p');
        const taskLabel = mobileRoot.querySelector('ul[data-type="taskList"] li > label');
        const markEl = mobileRoot.querySelector('mark.md-mark');

        check('marked text is flagged as no-keyboard target by default', isTouchNoKeyboardTarget(markEl) === true);
        check('checkbox label is flagged as no-keyboard target', isTouchNoKeyboardTarget(taskLabel) === true);

        // 10a) 单指快速轻点普通正文：pointerdown 阶段保持 none，pointerup 短按无拖选才放开 inputmode
        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        check('plain text pointerdown keeps inputmode=none until quick tap release',
            mobileRoot.getAttribute('inputmode') === 'none');
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 21, clientY: 20, pointerType: 'touch' }));
        check('quick tap on plain text removes inputmode=none and virtualkeyboardpolicy',
            mobileRoot.getAttribute('inputmode') === null && mobileRoot.getAttribute('virtualkeyboardpolicy') === null,
            `${mobileRoot.getAttribute('inputmode')} / ${mobileRoot.getAttribute('virtualkeyboardpolicy')}`);

        // blur 后立即锁回 inputmode="none" + virtualkeyboardpolicy="manual"
        mobileRoot.focus();
        mobileRoot.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: true }));
        check('blur restores inputmode=none and virtualkeyboardpolicy=manual on mobile',
            mobileRoot.getAttribute('inputmode') === 'none' && mobileRoot.getAttribute('virtualkeyboardpolicy') === 'manual',
            `${mobileRoot.getAttribute('inputmode')} / ${mobileRoot.getAttribute('virtualkeyboardpolicy')}`);

        // 10b) 滑动或长按保持 inputmode="none"
        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        plainPara.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 55, pointerType: 'touch' }));
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 55, pointerType: 'touch' }));
        check('touch drag / scroll keeps inputmode=none', mobileRoot.getAttribute('inputmode') === 'none');

        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        await wait(340);
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        check('long press (>= 320ms) keeps inputmode=none', mobileRoot.getAttribute('inputmode') === 'none');

        // 10c) 点待办复选框标签 & releaseEditorFocus：即使先聚焦也立即失焦并保持锁定
        mobileRoot.focus();
        check('mobile editor focused before checkbox tap', document.activeElement === mobileRoot);
        taskLabel.dispatchEvent(pointerEvent('pointerdown', { clientX: 8, clientY: 8, pointerType: 'touch' }));
        check('checkbox touch pointerdown releases editor focus and locks inputmode=none',
            document.activeElement !== mobileRoot && mobileRoot.getAttribute('inputmode') === 'none');

        // 10d) focusEditorWithoutScroll 移除锁定；settleEditorFocusAfterAction 在移动端释放而在鼠标交互保持焦点
        focusEditorWithoutScroll(mobileView);
        check('focusEditorWithoutScroll clears locks and focuses editor',
            mobileRoot.getAttribute('inputmode') === null
            && mobileRoot.getAttribute('virtualkeyboardpolicy') === null
            && document.activeElement === mobileRoot);
        settleEditorFocusAfterAction(mobileView, { keepFocusOnDesktop: true });
        check('settleEditorFocusAfterAction blurs and locks inputmode=none on mobile',
            document.activeElement !== mobileRoot
            && mobileRoot.getAttribute('inputmode') === 'none'
            && mobileRoot.getAttribute('virtualkeyboardpolicy') === 'manual');

        // 10e) 存在 DOM/PM 非折叠划词选区时：滑动拖拽保留选区，轻点空白折叠 PM/DOM 选区并释放焦点
        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 21, clientY: 20, pointerType: 'touch' }));
        check('10e unlocked before active selection dismiss test', mobileRoot.getAttribute('inputmode') === null);
        mobileRoot.focus();
        const sel = dom.window.getSelection();
        const { TextSelection } = global.DumbPadTiptap.PM.state;
        const setActiveRange = () => {
            mobileView.dispatch(mobileView.state.tr.setSelection(TextSelection.create(mobileView.state.doc, 1, 4)));
            const range = document.createRange();
            range.setStart(plainPara.firstChild, 0);
            range.setEnd(plainPara.firstChild, 3);
            sel.removeAllRanges();
            sel.addRange(range);
        };
        setActiveRange();
        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 22, clientY: 20, pointerType: 'touch' }));
        plainPara.dispatchEvent(pointerEvent('pointermove', { clientX: 22, clientY: 55, pointerType: 'touch' }));
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 22, clientY: 55, pointerType: 'touch' }));
        check('scrolling/dragging while selected does not collapse PM selection',
            mobileView.state.selection.empty === false);

        setActiveRange();
        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 22, clientY: 20, pointerType: 'touch' }));
        sel.removeAllRanges();
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 22, clientY: 20, pointerType: 'touch' }));
        check('tapping plain text collapses PM & DOM selection, keeps lock, and blurs on pointerup',
            mobileView.state.selection.empty === true
            && sel.isCollapsed === true
            && mobileRoot.getAttribute('inputmode') === 'none'
            && mobileRoot.getAttribute('virtualkeyboardpolicy') === 'manual'
            && document.activeElement !== mobileRoot);
        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 22, clientY: 20, pointerType: 'touch' }));
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 22, clientY: 20, pointerType: 'touch' }));
        check('next quick tap after dismissing selection unlocks inputmode and virtualkeyboardpolicy',
            mobileRoot.getAttribute('inputmode') === null
            && mobileRoot.getAttribute('virtualkeyboardpolicy') === null);

        // 10f) selectionchange 自动重锁与 navigator.virtualKeyboard.hide()（IME composing 期间不干预）
        let vkHideCalls = 0;
        const origVirtualKeyboardDescriptor = Object.getOwnPropertyDescriptor(dom.window.navigator, 'virtualKeyboard');
        Object.defineProperty(dom.window.navigator, 'virtualKeyboard', {
            value: { hide() { vkHideCalls += 1; } },
            configurable: true,
        });
        try {
            plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
            plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 21, clientY: 20, pointerType: 'touch' }));
            check('10f unlocked before selectionchange', mobileRoot.getAttribute('inputmode') === null);

            const r1 = document.createRange();
            r1.setStart(plainPara.firstChild, 0);
            r1.setEnd(plainPara.firstChild, 4);
            sel.removeAllRanges();
            sel.addRange(r1);
            document.dispatchEvent(new dom.window.Event('selectionchange'));
            check('selectionchange re-locks inputmode=none and virtualkeyboardpolicy=manual',
                mobileRoot.getAttribute('inputmode') === 'none'
                && mobileRoot.getAttribute('virtualkeyboardpolicy') === 'manual');
            check('selectionchange invokes navigator.virtualKeyboard.hide()', vkHideCalls >= 1, `vkHideCalls=${vkHideCalls}`);

            sel.removeAllRanges();
            plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
            plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 21, clientY: 20, pointerType: 'touch' }));
            check('10f unlocked before composing check', mobileRoot.getAttribute('inputmode') === null);

            const origComposingDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mobileView), 'composing')
                || Object.getOwnPropertyDescriptor(mobileView, 'composing');
            Object.defineProperty(mobileView, 'composing', { value: true, configurable: true });
            const vkHideBeforeComposing = vkHideCalls;
            const r2 = document.createRange();
            r2.setStart(plainPara.firstChild, 0);
            r2.setEnd(plainPara.firstChild, 2);
            sel.removeAllRanges();
            sel.addRange(r2);
            document.dispatchEvent(new dom.window.Event('selectionchange'));
            check('selectionchange does not lock or hide keyboard while IME composing',
                mobileRoot.getAttribute('inputmode') === null && vkHideCalls === vkHideBeforeComposing);
            if (origComposingDesc) Object.defineProperty(mobileView, 'composing', origComposingDesc);
            else delete mobileView.composing;
            sel.removeAllRanges();
        } finally {
            if (origVirtualKeyboardDescriptor) {
                Object.defineProperty(dom.window.navigator, 'virtualKeyboard', origVirtualKeyboardDescriptor);
            } else {
                delete dom.window.navigator.virtualKeyboard;
            }
        }

        // 10g) 长按 (>= 320ms) 后系统补发 click 仍保持上锁
        plainPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        await wait(340);
        plainPara.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        plainPara.dispatchEvent(pointerEvent('click', { clientX: 20, clientY: 20, pointerType: 'touch' }));
        check('long press followed by trailing click keeps inputmode=none and virtualkeyboardpolicy=manual',
            mobileRoot.getAttribute('inputmode') === 'none'
            && mobileRoot.getAttribute('virtualkeyboardpolicy') === 'manual');

        // 10h) visualViewport 键盘弹起期间允许重放光标；系统收起键盘且未触发 blur 时自动回锁
        const origVisualViewportDesc = Object.getOwnPropertyDescriptor(dom.window, 'visualViewport');
        const vvListeners = new Map();
        const mockVv = {
            width: 390,
            height: 844,
            addEventListener(type, fn) {
                if (!vvListeners.has(type)) vvListeners.set(type, new Set());
                vvListeners.get(type).add(fn);
            },
            removeEventListener(type, fn) {
                vvListeners.get(type)?.delete(fn);
            },
            dispatchResize() {
                for (const fn of (vvListeners.get('resize') || [])) fn({ target: mockVv });
            },
        };
        Object.defineProperty(dom.window, 'visualViewport', { value: mockVv, configurable: true });
        const vvContainer = document.createElement('div');
        document.body.appendChild(vvContainer);
        const vvEditor = new HybridMarkdownEditor(vvContainer, {});
        await vvEditor.whenReady();
        const vvRoot = vvContainer.querySelector('.tiptap');
        vvEditor.setValue('视口监听测试段落', false);
        const vvPara = vvRoot.querySelector('p');
        try {
            vvPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 16, clientY: 16, pointerType: 'touch' }));
            vvPara.dispatchEvent(pointerEvent('pointerup', { clientX: 16, clientY: 16, pointerType: 'touch' }));
            vvRoot.focus();
            check('10h quick tap unlocks before keyboard opens',
                vvRoot.getAttribute('inputmode') === null && document.activeElement === vvRoot);

            mockVv.height = 500;
            mockVv.dispatchResize();
            vvPara.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 16, pointerType: 'touch' }));
            vvPara.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 16, pointerType: 'touch' }));
            check('while soft keyboard is open, pointerdown does not re-lock inputmode',
                vvRoot.getAttribute('inputmode') === null);

            mockVv.height = 844;
            mockVv.dispatchResize();
            check('closing keyboard via visualViewport without blur re-locks inputmode and virtualkeyboardpolicy',
                vvRoot.getAttribute('inputmode') === 'none'
                && vvRoot.getAttribute('virtualkeyboardpolicy') === 'manual');
        } finally {
            vvEditor.editor.destroy();
            vvContainer.remove();
            if (origVisualViewportDesc) {
                Object.defineProperty(dom.window, 'visualViewport', origVisualViewportDesc);
            } else {
                delete dom.window.visualViewport;
            }
        }

        // 切换回到真实鼠标：不再误判为触屏（即便在 1280px 触控屏设备/Playwright hasTouch 下也不影响）
        mobileRoot.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse' }));
        settleEditorFocusAfterAction(mobileView, { keepFocusOnDesktop: true });
        check('recent mouse pointerdown overrides coarse-viewport fallback even without event arg',
            document.activeElement === mobileRoot && mobileRoot.getAttribute('inputmode') === null);
        dom.window.matchMedia = () => ({ matches: false, media: '', addListener() {}, removeListener() {} });
        Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
        settleEditorFocusAfterAction(mobileView, {
            keepFocusOnDesktop: true,
            event: pointerEvent('click', { pointerType: 'mouse' }),
        });
        check('desktop mouse settle keeps focus without inputmode=none',
            document.activeElement === mobileRoot && mobileRoot.getAttribute('inputmode') === null);

        mobileEditor.editor.destroy();
        mobileContainer.remove();
    } finally {
        _resetPointerFocusStateForTests();
        dom.window.matchMedia = origMatchMedia;
        if (origMaxTouchPointsDescriptor) {
            Object.defineProperty(dom.window.navigator, 'maxTouchPoints', origMaxTouchPointsDescriptor);
        }
    }

    console.log('');
    if (failures > 0) {
        console.error(`${failures} pointer focus guard checks failed`);
        process.exit(1);
    }
    console.log('Pointer focus guard checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
