/**
 * Tiptap 编辑器浮动菜单：选区菜单（画线/高亮/批注/加粗/复制/剪切）、标记取消
 * popover 与时间标记更新/删除菜单。作为 Extension 的 ProseMirror 插件
 * 挂载，插件 view 负责菜单 DOM 的创建与销毁，动作全部走框架命令
 * （mark 命令 / toggleMark / setNodeMarkup / delete），事务进撤销历史并自然
 * 触发保存；不回写 Markdown 源码、不 setValue 全量重刷（旧 Vditor 时期的
 * 字符串手术路线是被重构掉的那套 hack）。选区菜单只在鼠标释放后显示，
 * 已标记/时间标记文字点击弹对应菜单。选区定位用 PM coordsAtPos。
 * 视觉是 iOS 风格图标条：图标数据在 selection-menu-icons.js，样式在
 * styles.css 的「iOS 风格选区菜单」一节。
 */
import { Extension, getMarkRange, PM } from './tiptap-runtime.js';
import { buildUpdatedTimeMarker, parseTimeMarkerText } from './time-command.js';
import { ANNOTATION_BADGE_SVG } from './tiptap-extensions.js';
import { createSelectionMenuIcon, ensureSelectionMenuSprite } from './selection-menu-icons.js';
import {
    clearTouchPointerActivity,
    isTouchInteraction,
    markTouchPointerActivity,
    preserveViewportScroll,
    releaseEditorFocus,
    settleEditorFocusAfterAction,
} from './tiptap-pointer-focus.js';

const { Plugin, PluginKey, TextSelection } = PM.state;

// 选区内出现这些节点时不显示菜单：代码块/内联代码/时间标记是
// mark 的禁区（schema 对 code block 禁 mark，时间标记是原子节点，
// 叠加 mark 会在 roundtrip 序列化里产生歧义）；图片是原子块，点它会
// 产生非空 NodeSelection（旧 Vditor 点图后文字选区是折叠的），
// 文字菜单必须让位给图片自己的尺寸/大图菜单。
const PROTECTED_NODE_TYPES = ['codeBlock', 'timeMarker', 'image'];

// 已落标记的渲染元素：点击弹出「取消」popover（与旧
// showAnnotationPopover / removeInlineMark 行为对齐）。
const MARKED_ELEMENT_SELECTOR = '.has-annotation, [data-draw], mark.md-mark';
const TOUCH_TAP_MOVE_THRESHOLD_PX = 10;
const TOUCH_CLICK_GUARD_MS = 450;

export const selectionMenuPluginKey = new PluginKey('dumbpadSelectionMenu');

/**
 * 动作反馈：轻提示（window.toaster 由 app.js 挂上，插件层只做可选调用）。
 * 菜单按钮点完菜单就收起，没有反馈用户不知道到底落没落上标记——尤其
 * 画线/高亮的视觉差异很小。文案统一「已…」句式，类型用 success/info。
 */
function notify(message, type = 'success', timeoutMs = 1400) {
    window.toaster?.show?.(message, type, false, timeoutMs);
}

function selectionHasProtectedNode(state) {
    const { from, to, empty } = state.selection;
    if (empty) return true;
    let protectedHit = false;
    state.doc.nodesBetween(from, to, (node) => {
        if (protectedHit) return false;
        if (PROTECTED_NODE_TYPES.includes(node.type.name)) {
            protectedHit = true;
            return false;
        }
        return true;
    });
    return protectedHit;
}

export const TiptapSelectionMenu = Extension.create({
    name: 'tiptapSelectionMenu',

    addProseMirrorPlugins() {
        const options = this.options;
        // 菜单 view 经闭包共享给 props 处理器（本插件无 state，
        // pluginKey.getState() 返回 undefined，不能用它取 view）。
        let menuView = null;
        return [
            new Plugin({
                key: selectionMenuPluginKey,
                props: {
                    // 桌面鼠标按下进入拖拽态：拖拽选字过程中不显示菜单，
                    // 释放鼠标（mouseup）后才允许出现；触屏走系统选区手柄，不拦 update()。
                    handleDOMEvents: {
                        mousedown: (view, event) => {
                            if (isTouchInteraction(view, event)) return false;
                            if (menuView && !menuView.root.contains(event.target)) {
                                menuView.dragging = true;
                            }
                            return false;
                        },
                        mouseup: (view) => {
                            if (!menuView) return false;
                            menuView.dragging = false;
                            // 拖拽期间 update() 被拖拽态拦住，mouseup 后不再有
                            // 选区事务——这里主动补一次显示判断（等价旧实现的
                            // mouseup → setTimeout(handleSelectionChange, 20)；
                            // 延迟到宏任务，等浏览器把选区最终化）。
                            setTimeout(() => {
                                const selection = view.state.selection;
                                if (menuView.annotationInputOpen) return;
                                if (selection.empty || !menuView.menuAllowed(view)) {
                                    // 只能是「收起」：选区落到受保护节点（图片点按产生
                                    // NodeSelection）或空选区时，早退会把上一次文字选区
                                    // 的菜单留在图片上，看起来就是点了图片弹出文字菜单。
                                    menuView.hide();
                                    return;
                                }
                                menuView.show(selection);
                            }, 0);
                            return false;
                        },
                    },
                },
                view(editorView) {
                    menuView = new SelectionMenuView(editorView, options);
                    return menuView;
                },
            }),
        ];
    },
});

class SelectionMenuView {
    constructor(view, options = {}) {
        this.view = view;
        this.options = options;
        this.visible = false;
        this.annotationInputOpen = false;
        this.dragging = false;
        this.touchTap = null;
        this.lastTouchTapAt = 0;
        this.lastDownMeta = null;
        this.allowEditMarkedElement = null;
        this.popoverCloseCleanup = null;
        this.timeMarkerMenuCloseCleanup = null;

        this.root = document.createElement('div');
        this.root.className = 'selection-menu typora-selection-menu tiptap-selection-menu';
        this.root.style.display = 'none';

        // iOS 风格图标条：按钮只有图标，文字标签作为可访问名称保留（视觉隐藏）。
        // 分组之间插分隔线（标记 / 文字样式 / 复制与剪切）。
        ensureSelectionMenuSprite(document);
        this.btnGroup = document.createElement('div');
        this.btnGroup.className = 'menu-btn-group';
        this.btnGroup.setAttribute('role', 'toolbar');
        this.btnGroup.setAttribute('aria-label', '文本操作');
        this.btnGroup.setAttribute('aria-orientation', 'horizontal');

        this.btnGroup.append(
            this.makeButton('画线', () => this.applyMark('draw'), 'sm-draw'),
            this.makeButton('高亮', () => this.applyMark('mdHighlight'), 'sm-highlight'),
            this.makeButton('批注', () => this.openAnnotationInput(), 'sm-annotate'),
            this.makeDivider(),
            this.makeButton('加粗', () => this.toggleBold(), 'sm-bold'),
            this.makeDivider(),
            this.makeButton('复制', () => this.copySelection(), 'sm-copy'),
            this.makeButton('剪切', () => this.cutSelection(), 'sm-cut'),
        );

        this.inputGroup = document.createElement('div');
        this.inputGroup.className = 'menu-input-group';
        this.inputGroup.style.display = 'none';

        this.annoInput = document.createElement('textarea');
        this.annoInput.placeholder = '输入批注内容';
        this.annoInput.rows = 1;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'save-anno-btn';
        saveBtn.textContent = '✓';
        saveBtn.addEventListener('click', () => this.saveAnnotation());

        this.annoInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.saveAnnotation();
            }
            if (event.key === 'Escape') {
                this.annoInput.blur?.();
                this.closeAnnotationInput();
                this.hide();
                if (isTouchInteraction(this.view, event)) {
                    releaseEditorFocus(this.view, { clearDomSelection: true });
                }
            }
        });
        // 批注输入框点击不能冒泡回编辑器：ProseMirror 会因焦点离开
        // 而把选区折叠（blur → selection 重置），批注对象随之丢失。
        this.annoInput.addEventListener('mousedown', (event) => event.stopPropagation());
        this.annoInput.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse') clearTouchPointerActivity();
            else if (event.pointerType) markTouchPointerActivity();
            event.stopPropagation();
        });

        this.inputGroup.append(this.annoInput, saveBtn);
        this.root.append(this.btnGroup, this.inputGroup);
        document.body.appendChild(this.root);

        // 取消标记 popover（对应旧 mark-popover：取消画线/取消高亮）。
        this.popover = document.createElement('div');
        this.popover.className = 'mark-popover';
        this.popover.style.display = 'none';
        document.body.appendChild(this.popover);

        this.handleBlur = this.handleBlur.bind(this);
        this.handleWindowPointerUp = () => {
            this.dragging = false;
        };

        // 触屏点按捕获：时间标记与批注徽标不夺焦不弹键盘；已标记正文首次点按不夺焦、
        // 同元素展开动作气泡时二次轻点标记 data-allow-edit-tap 允许落光标编辑。
        this.handleEditorPointerDown = (event) => {
            this.lastDownMeta = {
                x: Number(event.clientX || 0),
                y: Number(event.clientY || 0),
                time: Date.now(),
            };
            if (event.pointerType === 'mouse') {
                clearTouchPointerActivity();
                this.clearAllowedEditMarked();
                return;
            }
            if (!event.pointerType) return;
            markTouchPointerActivity();

            const marker = event.target?.closest?.('.md-time-marker');
            if (marker && this.view.dom.contains(marker)) {
                this.clearAllowedEditMarked();
                event.preventDefault();
                releaseEditorFocus(this.view);
                this.touchTap = {
                    kind: 'timeMarker',
                    element: marker,
                    pointerId: event.pointerId ?? 0,
                    startX: Number(event.clientX || 0),
                    startY: Number(event.clientY || 0),
                };
                return;
            }

            const marked = event.target?.closest?.(MARKED_ELEMENT_SELECTOR);
            const badge = event.target?.closest?.('.annotation-badge');
            if (badge && marked && this.view.dom.contains(marked)) {
                this.clearAllowedEditMarked();
                event.preventDefault();
                releaseEditorFocus(this.view);
                this.touchTap = {
                    kind: 'badge',
                    element: marked,
                    pointerId: event.pointerId ?? 0,
                    startX: Number(event.clientX || 0),
                    startY: Number(event.clientY || 0),
                };
                return;
            }

            if (marked && this.view.dom.contains(marked)) {
                if (this.popover.style.display !== 'none'
                    && !this.popoverReadonly
                    && this.popoverAnchor === marked) {
                    this.clearAllowedEditMarked(marked);
                    marked.setAttribute('data-allow-edit-tap', 'true');
                    this.allowEditMarkedElement = marked;
                    this.hideMarkPopover();
                    return;
                }
                this.clearAllowedEditMarked();
                return;
            }

            this.clearAllowedEditMarked();
        };

        this.handleEditorPointerUp = (event) => {
            const tap = this.touchTap;
            if (!tap || tap.pointerId !== (event.pointerId ?? 0)) return;
            this.touchTap = null;
            if (event.type === 'pointercancel') return;
            const moved = Math.hypot(
                Number(event.clientX || 0) - tap.startX,
                Number(event.clientY || 0) - tap.startY,
            ) > TOUCH_TAP_MOVE_THRESHOLD_PX;
            if (moved) return;
            event.preventDefault();
            event.stopPropagation();
            this.lastTouchTapAt = Date.now();
            releaseEditorFocus(this.view);
            if (tap.kind === 'timeMarker') {
                this.showTimeMarkerMenu(tap.element);
            } else if (tap.kind === 'badge') {
                this.showAnnotationContent(tap.element);
            }
        };

        // 点击已标记/时间标记文字弹对应菜单：直接在编辑器 DOM 上挂
        // click 监听（与旧 bindAnnotationPopover / bindTimeMarkerPopover
        // 同机制）。不走 PM 的 handleClick——它依赖 PM 鼠标管线
        // （posAtCoords / view.mouseDown 状态机），无布局环境不可靠，
        // 且这是纯 DOM 关注点、不涉事务。
        this.handleEditorClick = (event) => {
            const down = this.lastDownMeta;
            this.lastDownMeta = null;
            const recentlyTouchHandled = Date.now() - this.lastTouchTapAt < TOUCH_CLICK_GUARD_MS;
            const marker = event.target?.closest?.('.md-time-marker');
            if (marker && view.dom.contains(marker)) {
                if (recentlyTouchHandled) return;
                if (isTouchInteraction(this.view, event)) {
                    releaseEditorFocus(this.view);
                }
                this.showTimeMarkerMenu(marker);
                return;
            }
            const marked = event.target?.closest?.(MARKED_ELEMENT_SELECTOR);
            if (!marked || !view.dom.contains(marked)) return;
            // 点徽标 = 只看看批注写了什么（旧 showAnnotationPopover 的 clickedBadge
            // 分支）；点正文 = 编辑/取消动作。徽标没有自己的可点区域可区分（它是
            // 渲染层节点），靠 closest 判定即可。
            if (event.target?.closest?.('.annotation-badge')) {
                if (recentlyTouchHandled) return;
                event.preventDefault();
                event.stopPropagation();
                if (isTouchInteraction(this.view, event)) {
                    releaseEditorFocus(this.view);
                }
                this.showAnnotationContent(marked);
                return;
            }
            if (marked === this.allowEditMarkedElement) {
                this.clearAllowedEditMarked();
                return;
            }
            const domSel = window.getSelection?.();
            if (down) {
                const moved = Math.hypot(
                    Number(event.clientX || 0) - down.x,
                    Number(event.clientY || 0) - down.y,
                ) > 6;
                const heldLongWithSelection = (Date.now() - down.time >= 320)
                    && domSel && !domSel.isCollapsed && view.dom.contains(domSel.anchorNode);
                if (moved || heldLongWithSelection) {
                    return;
                }
            }
            if (isTouchInteraction(this.view, event)) {
                releaseEditorFocus(this.view, { clearDomSelection: true });
            }
            this.showMarkPopover(marked);
        };

        view.dom.addEventListener('pointerdown', this.handleEditorPointerDown, true);
        view.dom.addEventListener('pointerup', this.handleEditorPointerUp, true);
        view.dom.addEventListener('pointercancel', this.handleEditorPointerUp, true);
        view.dom.addEventListener('click', this.handleEditorClick);
        window.addEventListener('pointerup', this.handleWindowPointerUp, true);
        window.addEventListener('pointercancel', this.handleWindowPointerUp, true);
        // 浮层是 position:absolute + 页面坐标，窗口尺寸变化后原坐标就偏了；
        // 编辑器滚动（桌面在 .vditor-wysiwyg 内滚、移动端整页滚）同理。
        // 两处都必须重算，否则菜单会停在旧位置、与选区/标记脱开。
        this.handleResize = () => this.reposition();
        this.handleScroll = () => this.reposition();
        window.addEventListener('resize', this.handleResize);
        window.addEventListener('scroll', this.handleScroll, { capture: true, passive: true });
        this.root.addEventListener('mousedown', (event) => event.stopPropagation());
        this.root.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse') clearTouchPointerActivity();
            else if (event.pointerType) markTouchPointerActivity();
            event.stopPropagation();
        });
        this.popover.addEventListener('mousedown', (event) => event.stopPropagation());
        this.popover.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse') clearTouchPointerActivity();
            else if (event.pointerType) markTouchPointerActivity();
            event.stopPropagation();
        });
        // 点编辑器外（其他面板/正文）收起菜单：PM 的 blur 捕获即可，
        // 不需要 document 级 mousedown 监听。
        view.dom.addEventListener('blur', this.handleBlur, true);
    }

    clearAllowedEditMarked(exceptEl = null) {
        if (this.allowEditMarkedElement && this.allowEditMarkedElement !== exceptEl) {
            this.allowEditMarkedElement.removeAttribute('data-allow-edit-tap');
            this.allowEditMarkedElement = null;
        }
    }

    /** 跟随窗口尺寸/滚动重算所有可见浮层的位置（不可见的一律跳过）。 */
    reposition() {
        if (this.visible) this.position();
        if (this.popover.style.display !== 'none' && this.popoverAnchor?.isConnected) {
            this.positionPopover(this.popoverAnchor);
        }
        if (this.timeMarkerMenu?.style.display !== 'none' && this.activeTimeMarkerElement?.isConnected) {
            this.positionTimeMarkerMenu(this.activeTimeMarkerElement);
        }
    }

    makeButton(label, action, iconId = '') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        if (iconId) {
            btn.dataset.action = iconId.replace(/^sm-/, '');
            btn.append(createSelectionMenuIcon(iconId, document));
        }
        // 文字标签保留在 DOM 里、视觉隐藏：按钮的可访问名称与既有回归
        // （按 textContent 定位按钮）都不变，界面上只看到图标。
        const text = document.createElement('span');
        text.className = 'sm-label';
        text.textContent = label;
        btn.append(text);
        // 阻止 pointerdown/mousedown 默认行为：防止点击按钮把编辑器焦点/选区
        // 抢走，导致选区提前折叠、动作落空或弹出软键盘。
        const keepSelectionOnButtonDown = (event) => {
            if (event.type === 'pointerdown') {
                if (event.pointerType === 'mouse') clearTouchPointerActivity();
                else if (event.pointerType) markTouchPointerActivity();
            }
            event.preventDefault();
            event.stopPropagation();
        };
        btn.addEventListener('pointerdown', keepSelectionOnButtonDown);
        btn.addEventListener('mousedown', keepSelectionOnButtonDown);
        btn.addEventListener('click', (event) => {
            if (event.pointerType === 'mouse') clearTouchPointerActivity();
            else if (event.pointerType) markTouchPointerActivity();
            action(event);
        });
        return btn;
    }

    /** 图标条里的分组竖线（纯装饰，不进可访问树）。 */
    makeDivider() {
        const divider = document.createElement('span');
        divider.className = 'sm-split';
        divider.setAttribute('aria-hidden', 'true');
        return divider;
    }

    update(view, prevState) {
        const prevSelection = prevState.selection;
        const nextSelection = view.state.selection;
        const selectionUnchanged =
            prevSelection.from === nextSelection.from &&
            prevSelection.to === nextSelection.to &&
            prevSelection.empty === nextSelection.empty;
        if (selectionUnchanged && this.visible) {
            // 文档变化（打字/删除）时选区可能悬空，重新定位即可。
            if (!view.state.doc.eq(prevState.doc)) this.position();
            return;
        }
        if (this.annotationInputOpen) return;
        if (nextSelection.empty) {
            this.hide();
            return;
        }
        if (this.dragging) {
            // 拖拽选字中：不显示，等 mouseup。
            return;
        }
        if (!this.menuAllowed(view)) {
            this.hide();
            return;
        }
        this.show(nextSelection);
    }

    menuAllowed(view) {
        // 源码模式下编辑器 DOM 被隐藏，菜单没有意义。
        const root = view.dom.closest('.typora-editor-shell');
        if (root?.classList.contains('is-source-mode')) return false;
        // 表格跨格 / 整表选区由表格工具条接管，避免选区文字菜单叠压冲突。
        if ('$anchorCell' in view.state.selection) return false;
        return !selectionHasProtectedNode(view.state);
    }

    show(selection) {
        this.pendingSelection = { from: selection.from, to: selection.to };
        this.closeAnnotationInput();
        this.btnGroup.style.display = 'flex';
        this.root.style.display = 'flex';
        this.visible = true;
        this.position();
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.pendingSelection = null;
        this.closeAnnotationInput();
        this.root.style.display = 'none';
    }

    position() {
        if (!this.visible || !this.pendingSelection) return;
        requestAnimationFrame(() => {
            if (!this.visible) return;
            const { from, to } = this.pendingSelection;
            let start;
            let end;
            try {
                start = this.view.coordsAtPos(from);
                end = this.view.coordsAtPos(to);
            } catch (_error) {
                // jsdom 等无布局环境 coordsAtPos 会 throw：只跳过定位，
                // 不能把刚显示的菜单藏掉（真实浏览器不会 throw）。
                return;
            }
            this.placeAt(start, end);
        });
    }

    /** 按选区两端坐标定位菜单（移动端在下方，桌面在上方）。 */
    placeAt(start, end) {
        // 覆盖行选区时 end 可能在 start 左侧（换行），取包围盒。
        const left = Math.min(start.left, end.left);
        const right = Math.max(start.right, end.right);
        const top = Math.min(start.top, end.top);
        const bottom = Math.max(start.bottom, end.bottom);
        const rect = {
            left,
            right,
            top,
            bottom,
            width: right - left,
            height: bottom - top,
        };
        const menuRect = this.root.getBoundingClientRect();
        const isMobile = window.matchMedia?.('(max-width: 720px)').matches;
        const scrollX = window.scrollX || 0;
        const scrollY = window.scrollY || 0;
        const vv = window.visualViewport;
        const viewWidth = Number(vv?.width || window.innerWidth || 0);
        const viewHeight = Number(vv?.height || window.innerHeight || 0);
        const vvTop = Number(vv?.offsetTop || 0);
        const vvLeft = Number(vv?.offsetLeft || 0);

        let menuLeft = rect.left + scrollX + rect.width / 2 - menuRect.width / 2;
        let menuTop = isMobile
            ? rect.bottom + scrollY + 10
            : rect.top + scrollY - menuRect.height - 10;
        const minTop = scrollY + vvTop + 10;
        const maxBottom = scrollY + vvTop + viewHeight - 12;
        if (isMobile && menuTop + menuRect.height > maxBottom) {
            menuTop = rect.top + scrollY - menuRect.height - 10;
        }
        if (!isMobile && menuTop < minTop) menuTop = rect.bottom + scrollY + 10;
        menuTop = Math.max(minTop, Math.min(menuTop, Math.max(minTop, maxBottom - menuRect.height)));
        const minLeft = scrollX + vvLeft + 10;
        const maxLeft = Math.max(minLeft, scrollX + vvLeft + viewWidth - menuRect.width - 10);
        menuLeft = Math.min(Math.max(menuLeft, minLeft), maxLeft);
        this.root.style.left = `${menuLeft}px`;
        this.root.style.top = `${menuTop}px`;
        // 菜单在选区下方时（移动端默认、桌面顶到视口上缘翻转）：尖角移到顶边，
        // 动画方向跟着反过来，否则弹出感是错的。
        const isBelow = menuTop > rect.bottom + scrollY;
        this.root.classList.toggle('sm-below', isBelow);
        // 尖角必须继续指向选区中心：菜单被视口夹住后不能再用写死的 50%。
        const tailX = rect.left + scrollX + rect.width / 2 - menuLeft - 6;
        const clampedTail = Math.max(10, Math.min(tailX, menuRect.width - 16));
        this.root.style.setProperty('--sm-tail-x', `${clampedTail}px`);
    }

    /* ------- 已标记文字的「取消」popover（旧 mark-popover 行为） ------- */

    showMarkPopover(element) {
        const isMark = element.matches('mark.md-mark');
        const isDraw = element.matches('[data-draw]');
        const isAnnotation = element.matches('.has-annotation, [data-note]');
        const comment = element.getAttribute('data-note') || element.getAttribute('data-comment') || '';
        const type = comment || isAnnotation ? 'annotation' : (isMark ? 'highlight' : (isDraw ? 'draw' : null));
        if (!type) return;

        this.hideTimeMarkerMenu();
        this.popover.className = 'mark-popover';
        this.popoverReadonly = false;
        this.popover.innerHTML = '';
        const actions = document.createElement('div');
        actions.className = 'mark-popover-actions';
        // 不要在这里写行内 padding/border：内边距归 styles.css 的
        // .mark-popover-actions 统一控制（行内样式优先级更高，会把样式表里
        // 的内缩压成 0，hover 底色就变成紧贴外框的直角块）。

        if (type === 'annotation') {
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'edit-btn';
            editBtn.textContent = '编辑';
            editBtn.addEventListener('click', () => this.editAnnotationComment(element, comment));
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'delete-btn';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', () => this.removeMarked(element, 'annotation'));
            actions.append(editBtn, cancelBtn);
        } else {
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'delete-btn';
            cancelBtn.textContent = type === 'highlight' ? '取消高亮' : '取消画线';
            cancelBtn.addEventListener('click', () => this.removeMarked(element, type));
            actions.append(cancelBtn);
        }

        this.popover.append(actions);
        this.popover.style.display = 'flex';
        // 记下锚点元素：窗口尺寸/滚动变化时按它重算位置（元素被重绘掉就放弃）。
        this.popoverAnchor = element;
        this.positionPopover(element);
        this.installPopoverCloseHandler();
    }

    /**
     * 点徽标看批注内容（旧 showAnnotationPopover 的 comment-only 形态）：气泡图标 +
     * 批注正文，只读、没有动作按钮。复用既有 .comment-only-popover /
     * .mark-popover-inline-content 样式，不新增视觉语言。
     */
    showAnnotationContent(element) {
        const comment = element.getAttribute('data-note') || element.getAttribute('data-comment') || '';
        if (!comment) return;
        this.hide();
        this.hideTimeMarkerMenu();
        this.popover.innerHTML = '';
        this.popover.className = 'mark-popover comment-only-popover';
        // 只读展示卡要在编辑器 blur 后仍然存活（徽标在 contenteditable 内部），
        // 收起只交给下面的 document mousedown/pointerdown，与旧实现一致。
        this.popoverReadonly = true;

        const content = document.createElement('div');
        content.className = 'mark-popover-inline-content';
        const iconBox = document.createElement('div');
        iconBox.className = 'mark-popover-icon-box';
        iconBox.innerHTML = ANNOTATION_BADGE_SVG.replace('width="12" height="12"', 'width="15" height="15"');
        const text = document.createElement('div');
        text.className = 'mark-popover-text';
        text.textContent = comment;
        content.append(iconBox, text);

        this.popover.append(content);
        this.popover.style.display = 'block';
        this.popoverAnchor = element;
        this.positionPopover(element);
        this.installPopoverCloseHandler();
    }

    clearPopoverCloseHandler() {
        clearTimeout(this.popoverCloseTimer);
        this.popoverCloseCleanup?.();
        this.popoverCloseCleanup = null;
    }

    /** 点其他位置收起 popover（延迟挂载避免吞掉当前点击）。 */
    installPopoverCloseHandler() {
        this.clearPopoverCloseHandler();
        this.popoverCloseTimer = setTimeout(() => {
            const close = (event) => {
                if (event.type === 'pointerdown' && event.pointerType === 'mouse') return;
                if (!this.popover.contains(event.target)) {
                    this.hideMarkPopover();
                }
            };
            document.addEventListener('mousedown', close);
            document.addEventListener('pointerdown', close);
            this.popoverCloseCleanup = () => {
                document.removeEventListener('mousedown', close);
                document.removeEventListener('pointerdown', close);
            };
        }, 0);
    }

    positionPopover(element) {
        requestAnimationFrame(() => {
            if (this.popover.style.display === 'none') return;
            let rect;
            try {
                rect = element.getBoundingClientRect();
            } catch (_error) {
                return;
            }
            const popRect = this.popover.getBoundingClientRect();
            const scrollY = window.scrollY || 0;
            const vv = window.visualViewport;
            const viewWidth = Number(vv?.width || window.innerWidth || 0);
            const vvLeft = Number(vv?.offsetLeft || 0);
            let left = rect.left + rect.width / 2 - popRect.width / 2;
            let top = rect.top + scrollY - popRect.height - 12;
            if (top < scrollY + (vv?.offsetTop || 0) + 10) top = rect.bottom + scrollY + 12;
            const minLeft = vvLeft + 10;
            const maxLeft = Math.max(minLeft, vvLeft + viewWidth - popRect.width - 10);
            left = Math.min(Math.max(left, minLeft), maxLeft);
            this.popover.style.left = `${left}px`;
            this.popover.style.top = `${top}px`;
        });
    }

    hideMarkPopover() {
        this.clearPopoverCloseHandler();
        this.popover.style.display = 'none';
        this.popoverReadonly = false;
        this.popoverAnchor = null;
    }

    /** 定位渲染元素对应的文档范围（PM posFromDOM 反查，不猜文本）。 */
    posRangeForElement(element) {
        try {
            const pos = this.view.posAtDOM(element, 0);
            const $pos = this.view.state.doc.resolve(Math.min(pos + 1, this.view.state.doc.content.size));
            if (element.matches('mark.md-mark')) {
                const range = getMarkRange($pos, this.view.state.schema.marks.mdHighlight);
                if (range) return range;
            }
            if (element.matches('[data-draw]')) {
                const range = getMarkRange($pos, this.view.state.schema.marks.draw);
                if (range) return range;
            }
            if (element.matches('.has-annotation, [data-note]')) {
                const range = getMarkRange($pos, this.view.state.schema.marks.annotation);
                if (range) return range;
            }
            // 反查失败时用元素自身的文本范围。
            const end = this.view.posAtDOM(element, element.childNodes.length);
            return { from: pos, to: end };
        } catch (_error) {
            return null;
        }
    }

    /** 取消标记：框架 removeMark 命令（可撤销），与旧 removeInlineMark 对齐。 */
    removeMarked(element, type) {
        const range = this.posRangeForElement(element);
        this.hideMarkPopover();
        if (!range) return;
        const schema = this.view.state.schema;
        const markType = type === 'highlight'
            ? schema.marks.mdHighlight
            : (type === 'draw' ? schema.marks.draw : schema.marks.annotation);
        if (!markType) return;
        preserveViewportScroll(this.view, () => {
            this.view.dispatch(this.view.state.tr.removeMark(range.from, range.to, markType));
        });
        settleEditorFocusAfterAction(this.view, { keepFocusOnDesktop: true, clearDomSelection: true });
        notify(type === 'highlight' ? '已取消高亮' : (type === 'draw' ? '已取消画线' : '已取消批注'), 'info');
    }

    /** 编辑批注：原地展开编辑卡片，框架更新 mark attrs（可撤销），与旧 updateAnnotationComment 对齐。 */
    editAnnotationComment(element, comment) {
        const range = this.posRangeForElement(element);
        if (!range) {
            this.hideMarkPopover();
            return;
        }

        this.popover.innerHTML = '';
        this.popover.className = 'mark-popover mark-popover-editing';

        const content = document.createElement('div');
        content.className = 'mark-popover-inline-content';
        const input = document.createElement('textarea');
        input.className = 'mark-popover-edit-input';
        input.rows = 2;
        input.value = comment || '';
        content.appendChild(input);

        const actions = document.createElement('div');
        actions.className = 'mark-popover-actions';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'save-btn';
        saveBtn.textContent = '保存';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'cancel-edit-btn';
        cancelBtn.textContent = '取消';
        actions.append(saveBtn, cancelBtn);

        this.popover.append(content, actions);
        this.popover.style.display = 'flex';
        this.positionPopover(element);

        // 避免点击输入框触发编辑器失焦折叠选区
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') clearTouchPointerActivity();
            else if (e.pointerType) markTouchPointerActivity();
            e.stopPropagation();
        });

        const handleSave = () => {
            const next = input.value.trim();
            if (!next) return;
            input.blur?.();
            const annotationType = this.view.state.schema.marks.annotation;
            if (annotationType && next !== comment) {
                preserveViewportScroll(this.view, () => {
                    const tr = this.view.state.tr;
                    tr.removeMark(range.from, range.to, annotationType);
                    tr.addMark(range.from, range.to, annotationType.create({ note: next }));
                    this.view.dispatch(tr);
                });
            }
            this.hideMarkPopover();
            settleEditorFocusAfterAction(this.view, { keepFocusOnDesktop: true, clearDomSelection: true });
        };

        const handleCancel = () => {
            input.blur?.();
            this.hideMarkPopover();
            settleEditorFocusAfterAction(this.view, { keepFocusOnDesktop: true, clearDomSelection: true });
        };

        saveBtn.addEventListener('click', handleSave);
        cancelBtn.addEventListener('click', handleCancel);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSave();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                handleCancel();
            }
        });

        requestAnimationFrame(() => {
            input.focus({ preventScroll: true });
            input.setSelectionRange(input.value.length, input.value.length);
        });
    }


    /* ------- 时间标记菜单（更新/删除，对应旧 showTimeMarkerMenu） ------- */

    clearTimeMarkerCloseHandler() {
        clearTimeout(this.timeMarkerMenuCloseTimer);
        this.timeMarkerMenuCloseCleanup?.();
        this.timeMarkerMenuCloseCleanup = null;
    }

    showTimeMarkerMenu(element) {
        const source = element.getAttribute('data-time-source') || '';
        if (!source) return;
        this.hide();
        this.hideMarkPopover();
        this.activeTimeMarkerElement = element;
        const menu = this.ensureTimeMarkerMenuDom();
        menu.style.display = 'flex';
        this.positionTimeMarkerMenu(element);
        // 点其他位置收起（延迟挂载避免吞掉当前点击）。
        this.clearTimeMarkerCloseHandler();
        this.timeMarkerMenuCloseTimer = setTimeout(() => {
            const close = (event) => {
                if (event.type === 'pointerdown' && event.pointerType === 'mouse') return;
                if (!menu.contains(event.target) && !event.target.closest?.('.md-time-marker')) {
                    this.hideTimeMarkerMenu();
                }
            };
            document.addEventListener('mousedown', close);
            document.addEventListener('pointerdown', close);
            this.timeMarkerMenuCloseCleanup = () => {
                document.removeEventListener('mousedown', close);
                document.removeEventListener('pointerdown', close);
            };
        }, 0);
    }

    ensureTimeMarkerMenuDom() {
        if (this.timeMarkerMenu) return this.timeMarkerMenu;
        const menu = document.createElement('div');
        menu.className = 'selection-menu typora-selection-menu time-marker-menu';
        menu.style.display = 'none';
        menu.innerHTML = `
            <div class="menu-btn-group">
                <button type="button" data-time-action="update" title="更新为当前时间" aria-label="更新为当前时间">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v5l3 2"></path></svg>
                    <span>更新</span>
                </button>
                <button type="button" data-time-action="delete" title="删除时间" aria-label="删除时间">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 16H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>
                    <span>删除</span>
                </button>
            </div>
        `;
        const stopMenuDown = (event) => {
            if (event.type === 'pointerdown') {
                if (event.pointerType === 'mouse') clearTouchPointerActivity();
                else if (event.pointerType) markTouchPointerActivity();
            }
            event.preventDefault();
            event.stopPropagation();
        };
        menu.addEventListener('pointerdown', stopMenuDown);
        menu.addEventListener('mousedown', stopMenuDown);
        menu.addEventListener('click', (event) => {
            const button = event.target.closest('[data-time-action]');
            if (!button) return;
            if (event.pointerType === 'mouse') clearTouchPointerActivity();
            else if (event.pointerType) markTouchPointerActivity();
            event.preventDefault();
            event.stopPropagation();
            this.applyTimeMarkerAction(button.dataset.timeAction);
        });
        document.body.appendChild(menu);
        this.timeMarkerMenu = menu;
        return menu;
    }

    positionTimeMarkerMenu(element) {
        requestAnimationFrame(() => {
            if (!this.timeMarkerMenu || this.timeMarkerMenu.style.display === 'none') return;
            let rect;
            try {
                rect = element.getBoundingClientRect();
            } catch (_error) {
                return;
            }
            const menuRect = this.timeMarkerMenu.getBoundingClientRect();
            const scrollY = window.scrollY || 0;
            const vv = window.visualViewport;
            const viewWidth = Number(vv?.width || window.innerWidth || 0);
            const vvLeft = Number(vv?.offsetLeft || 0);
            let left = rect.left + rect.width / 2 - menuRect.width / 2;
            let top = rect.top + scrollY - menuRect.height - 10;
            if (top < scrollY + (vv?.offsetTop || 0) + 10) top = rect.bottom + scrollY + 10;
            const minLeft = vvLeft + 10;
            const maxLeft = Math.max(minLeft, vvLeft + viewWidth - menuRect.width - 10);
            left = Math.min(Math.max(left, minLeft), maxLeft);
            this.timeMarkerMenu.style.left = `${left}px`;
            this.timeMarkerMenu.style.top = `${top}px`;
        });
    }

    hideTimeMarkerMenu() {
        this.clearTimeMarkerCloseHandler();
        if (this.timeMarkerMenu) this.timeMarkerMenu.style.display = 'none';
        this.activeTimeMarkerElement = null;
    }

    /** 定位时间标记节点：posAtDOM 后按 nodeAfter/nodeBefore 兜底解析。 */
    timeMarkerRangeForElement(element) {
        try {
            const pos = this.view.posAtDOM(element, 0);
            const doc = this.view.state.doc;
            const clamped = Math.max(0, Math.min(pos, doc.content.size));
            const $pos = doc.resolve(clamped);
            if ($pos.nodeAfter?.type.name === 'timeMarker') {
                return { pos: clamped, node: $pos.nodeAfter };
            }
            if ($pos.nodeBefore?.type.name === 'timeMarker') {
                return { pos: clamped - $pos.nodeBefore.nodeSize, node: $pos.nodeBefore };
            }
            const node = doc.nodeAt(clamped);
            if (node?.type.name === 'timeMarker') return { pos: clamped, node };
        } catch (_error) {
            // 无布局环境 posAtDOM 可能 throw：返回 null，动作放弃。
        }
        return null;
    }

    applyTimeMarkerAction(action) {
        const element = this.activeTimeMarkerElement;
        const source = element?.getAttribute('data-time-source') || '';
        this.hideTimeMarkerMenu();
        if (!element || !source) return;
        const range = this.timeMarkerRangeForElement(element);
        if (!range) return;
        const tr = this.view.state.tr;
        if (action === 'delete') {
            tr.delete(range.pos, range.pos + range.node.nodeSize);
        } else {
            // 更新为当前时间：沿用旧 buildUpdatedTimeMarker 的 kind/level
            // 递进规则（create → update@1，update@N → update@N+1）。
            const nextSource = buildUpdatedTimeMarker(source, new Date());
            const parsed = parseTimeMarkerText(nextSource);
            if (!parsed) return;
            tr.setNodeMarkup(range.pos, undefined, {
                source: nextSource,
                kind: parsed.kind,
                level: parsed.level,
                stamp: parsed.stamp,
                label: parsed.label,
            });
        }
        preserveViewportScroll(this.view, () => {
            this.view.dispatch(tr);
        });
        settleEditorFocusAfterAction(this.view, { keepFocusOnDesktop: true, clearDomSelection: true });
        notify(action === 'delete' ? '已删除时间标记' : '已更新为当前时间', action === 'delete' ? 'info' : 'success');
    }

    openAnnotationInput() {
        this.annotationInputOpen = true;
        this.btnGroup.style.display = 'none';
        this.inputGroup.style.display = 'flex';
        this.annoInput.value = '';
        this.annoInput.focus({ preventScroll: true });
        this.position();
    }

    closeAnnotationInput() {
        this.annotationInputOpen = false;
        this.btnGroup.style.display = 'flex';
        this.inputGroup.style.display = 'none';
    }

    saveAnnotation() {
        const comment = this.annoInput.value.trim();
        this.annoInput.blur?.();
        this.closeAnnotationInput();
        if (comment) {
            this.applyMark('annotation', { note: comment });
        } else {
            this.hide();
            if (isTouchInteraction(this.view)) {
                releaseEditorFocus(this.view, { clearDomSelection: true });
            }
        }
    }

    applyMark(markName, attrs = {}) {
        const { from, to } = this.pendingSelection || this.view.state.selection;
        // 选区尾端可能是段首/块边界，落 mark 前收缩到实际文本范围内，
        // 避免 mark 泄到相邻块（与旧 occurrence 校验等价的框架级防线）。
        preserveViewportScroll(this.view, () => {
            const tr = this.view.state.tr.addMark(from, to, this.view.state.schema.marks[markName].create(attrs));
            this.view.dispatch(tr);
        });
        this.hide();
        // 落标记后退出选中状态：桌面将光标折叠到标记起点，移动端取消光标压住键盘。
        this.collapseTo(from);
        notify(markName === 'draw' ? '已画线' : (markName === 'mdHighlight' ? '已高亮' : '已添加批注'));
    }

    /**
     * 加粗：走框架 toggleMark（与 Mod+b 落到同一个 mark），选区已加粗时取消。
     *
     * 为什么直接用 PM 的 toggleMark 而不是 `view.commands.toggleBold()`：本类是
     * ProseMirror 插件 view，`this.view` 是 EditorView，**没有** `.commands`
     * （那是 Tiptap Editor 实例上的链式 API）。拿 Editor 实例要穿过编辑器适配层，
     * 只会给插件加一条反向依赖；toggleMark(markType) 就是 toggleBold 内部的那一步。
     *
     * 不加 priority 是刻意的——加粗没有「点已加粗文字取消」的入口（那条只对
     * 画线/高亮/批注），跨链接/高亮/画线被拆成多个 <strong> 只在渲染层，
     * 序列化仍是**一整段** `**…**`（实测往返稳定），因此不需要抬 rank 去
     * 追求「单元素」；抬了反而改变 mark 的嵌套顺序。跨行内代码必然断开
     * （`**前** \`code\` **后**`），这是 Markdown 的正确语义。
     */
    toggleBold() {
        const { from, to } = this.pendingSelection || this.view.state.selection;
        const boldType = this.view.state.schema.marks.bold;
        if (!boldType) return;
        // toggleMark 的返回值不告诉我们是加还是取消，落之前先问一次文档：
        // 整段已加粗 → 这次是取消，否则是加粗。提示文案要跟着变，否则
        // 「已加粗」出现在取消动作上就是错的。
        const wasBold = this.view.state.doc.rangeHasMark(from, to, boldType);
        preserveViewportScroll(this.view, () => {
            this.view.dispatch(this.view.state.tr);
            PM.commands.toggleMark(boldType)(this.view.state, this.view.dispatch, this.view);
        });
        this.hide();
        this.collapseTo(from);
        notify(wasBold ? '已取消加粗' : '已加粗', wasBold ? 'info' : 'success');
    }

    /** 动作完成后退出选中状态：桌面光标折叠到标记起点；触屏释放焦点并清选区。 */
    collapseTo(pos) {
        const clamped = Math.max(0, Math.min(pos, this.view.state.doc.content.size));
        const $from = this.view.state.doc.resolve(clamped);
        const collapsed = TextSelection.near($from, -1);
        preserveViewportScroll(this.view, () => {
            this.view.dispatch(this.view.state.tr.setSelection(collapsed));
        });
        settleEditorFocusAfterAction(this.view, { keepFocusOnDesktop: true, clearDomSelection: true });
    }

    async writeClipboardText(text) {
        if (!text) return false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_error) {
            // Fall through to execCommand fallback for non-secure contexts
        }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.focus({ preventScroll: true });
            ta.select();
            const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
            ta.remove();
            return Boolean(ok);
        } catch (_error) {
            return false;
        }
    }

    async copySelection() {
        const { from, to } = this.pendingSelection || this.view.state.selection;
        const text = this.view.state.doc.textBetween(from, to, '\n');
        const copied = text ? await this.writeClipboardText(text) : false;
        this.hide();
        // 复制后同样退出选中状态。
        this.collapseTo(from);
        if (!text) return;
        notify(copied ? '已复制' : '复制失败：剪贴板不可用', copied ? 'success' : 'error', copied ? 1400 : 2600);
    }

    async cutSelection() {
        if (!this.view.editable) {
            this.hide();
            return;
        }
        const { from, to } = this.pendingSelection || this.view.state.selection;
        if (!(to > from)) {
            this.hide();
            return;
        }
        const text = this.view.state.doc.textBetween(from, to, '\n');
        const copied = text ? await this.writeClipboardText(text) : false;
        if (!copied) {
            this.hide();
            this.collapseTo(from);
            if (!text) return;
            notify('剪切失败：剪贴板不可用（内容未删除）', 'error', 2600);
            return;
        }
        const maxPos = this.view.state.doc.content.size;
        const clampedFrom = Math.max(0, Math.min(from, maxPos));
        const clampedTo = Math.max(clampedFrom, Math.min(to, maxPos));
        if (clampedTo > clampedFrom) {
            preserveViewportScroll(this.view, () => {
                this.view.dispatch(this.view.state.tr.delete(clampedFrom, clampedTo));
            });
        }
        this.hide();
        this.collapseTo(clampedFrom);
        notify('已剪切', 'success');
    }

    handleBlur() {
        if (this.annotationInputOpen) return;
        // 批注内容卡是纯只读展示（旧 Vditor 也只有 document mousedown 才关），
        // 编辑器 blur 不能把它收掉：徽标是 contenteditable 的子节点，点它必然
        // 伴随 blur，否则「点徽标看批注」会闪一下就没了。动作 popover 照旧收起。
        if (this.popoverReadonly) return;
        this.hide();
    }

    destroy() {
        this.clearPopoverCloseHandler();
        this.clearTimeMarkerCloseHandler();
        this.clearAllowedEditMarked();
        window.removeEventListener('resize', this.handleResize);
        window.removeEventListener('scroll', this.handleScroll, { capture: true });
        window.removeEventListener('pointerup', this.handleWindowPointerUp, true);
        window.removeEventListener('pointercancel', this.handleWindowPointerUp, true);
        this.view.dom.removeEventListener('blur', this.handleBlur, true);
        this.view.dom.removeEventListener('pointerdown', this.handleEditorPointerDown, true);
        this.view.dom.removeEventListener('pointerup', this.handleEditorPointerUp, true);
        this.view.dom.removeEventListener('pointercancel', this.handleEditorPointerUp, true);
        this.view.dom.removeEventListener('click', this.handleEditorClick);
        this.root.remove();
        this.popover.remove();
        this.timeMarkerMenu?.remove();
    }
}
