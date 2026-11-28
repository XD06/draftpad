/**
 * 编辑器内「非文本元素」的点按夺焦与移动端软键盘守卫（Tiptap）。
 *
 * 1) 桌面鼠标：图片、附件胶囊、嵌入媒体卡片、代码块工具条、mermaid 预览、
 *    时间标记、批注徽标等非输入节点在 mousedown 拦截默认夺焦与滚动回旧光标；
 *    原生媒体与表单控件保留默认行为。
 * 2) 移动触屏（Scheme B）：非输入状态及点按/长按划词默认维护 `inputmode="none"`
 *    压制无端弹软键盘，功能动作完成后主动释放焦点；仅对普通正文的单指快击放行键盘。
 */
import { Extension, PM } from './tiptap-runtime.js';

const { Plugin, PluginKey } = PM.state;

export const pointerFocusGuardKey = new PluginKey('dumbpadPointerFocusGuard');

// 桌面端装饰性元素：点它们不进入文字编辑，也不该把光标滚进视野。
const CHROME_SELECTOR = [
    'img',
    'a.dumbpad-article-file',
    '.dumbpad-article-media',
    '.dumbpad-code-header',
    '.dumbpad-code-copy',
    '.dumbpad-mermaid-render',
    '.dumbpad-mermaid-fullscreen',
    '.article-upload-card',
    '.md-time-marker',
    '.annotation-badge',
].join(',');

// 必须保留浏览器默认行为的元素：原生媒体控件与表单控件。
const NATIVE_CONTROL_SELECTOR = 'video, audio, input, textarea, select, button';

// 移动端触屏：点击这些控件或装饰性元素时绝对不能移除 inputmode="none" 或拉起键盘。
const TOUCH_NO_KEYBOARD_SELECTOR = [
    CHROME_SELECTOR,
    'ul[data-type="taskList"] li > label',
    'ul[data-type="taskList"] li > label input',
    '.dumbpad-code-fold-btn',
    '.dumbpad-code-fold-footer',
    '.dumbpad-code-copy',
    '.dumbpad-article-media-meta',
].join(',');

const MARKED_TEXT_SELECTOR = '.has-annotation, [data-draw], mark.md-mark';
const TOUCH_ACTIVITY_WINDOW_MS = 1000;
const MOUSE_ACTIVITY_WINDOW_MS = 10000;
const PLAIN_TAP_MAX_DURATION_MS = 320;
const PLAIN_TAP_MAX_MOVE_PX = 10;

let lastTouchPointerAt = 0;
let lastMousePointerAt = 0;

/** 记录最近一次触屏指针活动时间戳。 */
export function markTouchPointerActivity() {
    lastTouchPointerAt = Date.now();
    lastMousePointerAt = 0;
}

/** 鼠标指针到达时清除触屏活动时间戳（兼容触屏+鼠标二合一设备）。 */
export function clearTouchPointerActivity() {
    lastTouchPointerAt = 0;
    lastMousePointerAt = Date.now();
}

/** 仅用于测试重置模块级触屏状态。 */
export function _resetPointerFocusStateForTests() {
    lastTouchPointerAt = 0;
    lastMousePointerAt = 0;
}

/** 当前是否处于移动端/触控主输入视口（排除全 true 的测试 matchMedia stub）。 */
export function isTouchOrMobileViewport() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    const coarse = Boolean(window.matchMedia('(pointer: coarse)')?.matches);
    const fine = Boolean(window.matchMedia('(pointer: fine)')?.matches);
    if (coarse && !fine) return true;
    const touchPoints = Number(globalThis.navigator?.maxTouchPoints || 0);
    const hoverNone = Boolean(window.matchMedia('(hover: none)')?.matches);
    const hoverHover = Boolean(window.matchMedia('(hover: hover)')?.matches);
    const width = Number(window.innerWidth || document?.documentElement?.clientWidth || 1024);
    return touchPoints > 0 && width <= 980 && hoverNone && !hoverHover;
}

/** 判定当前交互是否属于触屏或移动端触控流。 */
export function isTouchInteraction(_view, event = null) {
    if (event && typeof event.pointerType === 'string' && event.pointerType) {
        return event.pointerType !== 'mouse';
    }
    if (Date.now() - lastTouchPointerAt < TOUCH_ACTIVITY_WINDOW_MS) return true;
    if (Date.now() - lastMousePointerAt < MOUSE_ACTIVITY_WINDOW_MS) return false;
    return isTouchOrMobileViewport();
}

/** 该事件目标是否属于「点它不该夺焦」的装饰性元素。 */
export function isChromePointerTarget(target) {
    if (!target?.closest) return false;
    if (target.closest(NATIVE_CONTROL_SELECTOR)) return false;
    return Boolean(target.closest(CHROME_SELECTOR));
}

/** 移动端触屏下禁止放开软键盘的元素或未授权直接编辑的已标记文本。 */
export function isTouchNoKeyboardTarget(target) {
    if (!target?.closest) return false;
    if (target.closest(TOUCH_NO_KEYBOARD_SELECTOR)) return true;
    const marked = target.closest(MARKED_TEXT_SELECTOR);
    if (marked && !marked.hasAttribute('data-allow-edit-tap')) return true;
    return false;
}

/** 在不将旧光标拖进视野的前提下聚焦编辑器（同时移除 inputmode="none"）。 */
export function focusEditorWithoutScroll(view) {
    const dom = view?.dom;
    if (!dom) return;
    if (dom.getAttribute?.('inputmode') === 'none') {
        dom.removeAttribute('inputmode');
    }
    try {
        if (typeof dom.focus === 'function') {
            dom.focus({ preventScroll: true });
            return;
        }
    } catch (_error) {
        // Fallback when FocusOptions is unsupported
    }
    dom.focus?.();
}

/** 释放编辑器焦点（并在触屏/移动态写回 inputmode="none" 阻止软键盘弹出）。 */
export function releaseEditorFocus(view, { clearDomSelection = false } = {}) {
    const dom = view?.dom;
    if (clearDomSelection && typeof window !== 'undefined' && typeof window.getSelection === 'function') {
        try {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && dom) {
                const anchor = sel.anchorNode;
                const focus = sel.focusNode;
                if ((anchor && dom.contains(anchor)) || (focus && dom.contains(focus))) {
                    sel.removeAllRanges();
                }
            }
        } catch (_error) {
            // Ignore selection cleanup failures in detached environments
        }
    }
    if (typeof document !== 'undefined') {
        const active = document.activeElement;
        if (active && active !== document.body && dom && (active === dom || dom.contains(active))) {
            active.blur?.();
        }
    }
    if (dom && (view?.hasFocus?.() || (typeof document !== 'undefined' && document.activeElement === dom))) {
        dom.blur?.();
    }
    if (dom && view?.editable && shouldLockMobileInputMode()) {
        dom.setAttribute('inputmode', 'none');
    }
}

function shouldLockMobileInputMode() {
    if (Date.now() - lastTouchPointerAt < TOUCH_ACTIVITY_WINDOW_MS) return true;
    if (Date.now() - lastMousePointerAt < MOUSE_ACTIVITY_WINDOW_MS) return false;
    return isTouchOrMobileViewport();
}

/**
 * 功能操作结束后的统一焦点裁决：
 * - 触屏/移动端：释放焦点 + 锁定 inputmode="none"，不留旧光标、不弹键盘；
 * - 桌面端：按需无滚动恢复焦点。
 */
export function settleEditorFocusAfterAction(
    view,
    { hadFocus = null, keepFocusOnDesktop = true, clearDomSelection = false, event = null } = {},
) {
    if (isTouchInteraction(view, event)) {
        releaseEditorFocus(view, { clearDomSelection });
        return;
    }
    const shouldFocus = keepFocusOnDesktop && (hadFocus === null ? true : Boolean(hadFocus));
    if (shouldFocus) {
        focusEditorWithoutScroll(view);
    }
}

/** 包裹事务或 DOM 操作执行，防止浏览器在重同步选区时把视口偷滚回旧光标。 */
export function preserveViewportScroll(view, fn) {
    const win = typeof window !== 'undefined' ? window : null;
    const scroller = view?.dom?.closest?.('.vditor-wysiwyg') || null;
    const winX = win ? (win.scrollX || document?.documentElement?.scrollLeft || 0) : 0;
    const winY = win ? (win.scrollY || document?.documentElement?.scrollTop || 0) : 0;
    const scrollerTop = scroller ? scroller.scrollTop : null;
    const scrollerLeft = scroller ? scroller.scrollLeft : null;
    const restore = () => {
        if (scroller && scrollerTop !== null) {
            if (Math.abs(scroller.scrollTop - scrollerTop) > 1) scroller.scrollTop = scrollerTop;
            if (Math.abs(scroller.scrollLeft - scrollerLeft) > 1) scroller.scrollLeft = scrollerLeft;
        }
        if (win && typeof win.scrollTo === 'function') {
            const curY = win.scrollY || document?.documentElement?.scrollTop || 0;
            const curX = win.scrollX || document?.documentElement?.scrollLeft || 0;
            if (Math.abs(curY - winY) > 1 || Math.abs(curX - winX) > 1) {
                try {
                    win.scrollTo(winX, winY);
                } catch (_error) {
                    // jsdom may throw on scrollTo
                }
            }
        }
    };
    try {
        return fn?.();
    } finally {
        restore();
        if (typeof requestAnimationFrame === 'function' && !view?.hasFocus?.()) {
            requestAnimationFrame(restore);
        }
    }
}

class PointerFocusGuardView {
    constructor(editorView) {
        this.view = editorView;
        this.wasEditable = Boolean(editorView.editable);
        this.pendingPlainTextTap = null;
        this.lastLongPressAt = 0;

        if (isTouchOrMobileViewport() && editorView.editable && !editorView.hasFocus()) {
            editorView.dom.setAttribute('inputmode', 'none');
        }

        this.onPointerDown = (event) => {
            if (event.pointerType === 'mouse') {
                clearTouchPointerActivity();
                this.pendingPlainTextTap = null;
                if (editorView.dom.getAttribute('inputmode') === 'none') {
                    editorView.dom.removeAttribute('inputmode');
                }
                return;
            }
            markTouchPointerActivity();
            if (!editorView.editable) {
                this.pendingPlainTextTap = null;
                return;
            }
            if (isTouchNoKeyboardTarget(event.target)) {
                this.pendingPlainTextTap = null;
                editorView.dom.setAttribute('inputmode', 'none');
                return;
            }
            // 普通文字区域或二次轻点编辑已标记文字：按下时不移除 inputmode="none"，
            // 保证长按划词期间不弹软键盘，只有短促单指轻点抬起才放开键盘。
            this.pendingPlainTextTap = {
                pointerId: event.pointerId ?? 0,
                startX: Number(event.clientX || 0),
                startY: Number(event.clientY || 0),
                startTime: Date.now(),
                moved: false,
            };
        };

        this.onPointerMove = (event) => {
            const tap = this.pendingPlainTextTap;
            if (!tap || tap.pointerId !== (event.pointerId ?? 0)) return;
            const dx = Number(event.clientX || 0) - tap.startX;
            const dy = Number(event.clientY || 0) - tap.startY;
            if (Math.hypot(dx, dy) > PLAIN_TAP_MAX_MOVE_PX) {
                tap.moved = true;
            }
        };

        this.onPointerUp = (event) => {
            const tap = this.pendingPlainTextTap;
            if (!tap || tap.pointerId !== (event.pointerId ?? 0)) return;
            this.pendingPlainTextTap = null;
            if (!editorView.editable) return;
            const duration = Date.now() - tap.startTime;
            if (tap.moved || duration >= PLAIN_TAP_MAX_DURATION_MS) return;
            const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
            const hasRangeSelection = Boolean(sel && !sel.isCollapsed);
            if (!hasRangeSelection) {
                editorView.dom.removeAttribute('inputmode');
            }
        };

        this.onPointerCancel = () => {
            this.pendingPlainTextTap = null;
            this.lastLongPressAt = Date.now();
        };

        this.onContextMenu = (event) => {
            if (isTouchInteraction(editorView, event)) {
                this.lastLongPressAt = Date.now();
                this.pendingPlainTextTap = null;
            }
        };

        this.onClick = (event) => {
            if (!editorView.editable || !isTouchInteraction(editorView, event)) return;
            if (isTouchNoKeyboardTarget(event.target)) return;
            if (Date.now() - this.lastLongPressAt < 800) return;
            if (editorView.dom.getAttribute('inputmode') !== 'none') return;
            const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
            const hasRangeSelection = Boolean(sel && !sel.isCollapsed);
            if (!hasRangeSelection) {
                editorView.dom.removeAttribute('inputmode');
            }
        };

        this.onBlur = () => {
            this.pendingPlainTextTap = null;
            if (editorView.editable && shouldLockMobileInputMode()) {
                editorView.dom.setAttribute('inputmode', 'none');
            }
        };

        const dom = editorView.dom;
        dom.addEventListener('pointerdown', this.onPointerDown, true);
        dom.addEventListener('pointermove', this.onPointerMove, true);
        dom.addEventListener('pointerup', this.onPointerUp, true);
        dom.addEventListener('pointercancel', this.onPointerCancel, true);
        dom.addEventListener('contextmenu', this.onContextMenu, true);
        dom.addEventListener('click', this.onClick, true);
        dom.addEventListener('blur', this.onBlur, true);
    }

    update(view) {
        if (!view.editable) {
            this.wasEditable = false;
            view.dom.removeAttribute('inputmode');
            return;
        }
        if (!this.wasEditable) {
            this.wasEditable = true;
            if (isTouchOrMobileViewport() && !view.hasFocus()) {
                view.dom.setAttribute('inputmode', 'none');
            }
        }
    }

    destroy() {
        const dom = this.view.dom;
        dom.removeEventListener('pointerdown', this.onPointerDown, true);
        dom.removeEventListener('pointermove', this.onPointerMove, true);
        dom.removeEventListener('pointerup', this.onPointerUp, true);
        dom.removeEventListener('pointercancel', this.onPointerCancel, true);
        dom.removeEventListener('contextmenu', this.onContextMenu, true);
        dom.removeEventListener('click', this.onClick, true);
        dom.removeEventListener('blur', this.onBlur, true);
        dom.removeAttribute('inputmode');
    }
}

export const TiptapPointerFocusGuard = Extension.create({
    name: 'tiptapPointerFocusGuard',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: pointerFocusGuardKey,
                props: {
                    handleDOMEvents: {
                        mousedown: (view, event) => {
                            if (!view.editable) return false;
                            if (event.button !== 0) return false;
                            if (!isChromePointerTarget(event.target)) return false;
                            // 只拦默认行为（不夺焦/不滚光标），不阻断事件本身：
                            // 各元素的 click 菜单与 PM 自己的鼠标管线照旧。
                            event.preventDefault();
                            return false;
                        },
                    },
                },
                view: (editorView) => new PointerFocusGuardView(editorView),
            }),
        ];
    },
});
