/**
 * Tiptap 编辑器浮动菜单：选区菜单（画线/高亮/批注/复制）、标记取消
 * popover 与时间标记更新/删除菜单。作为 Extension 的 ProseMirror 插件
 * 挂载，插件 view 负责菜单 DOM 的创建与销毁，动作全部走框架命令
 * （mark 命令 / setNodeMarkup / delete），事务进撤销历史并自然触发保存；
 * 不回写 Markdown 源码、不 setValue 全量重刷（旧 Vditor 时期的字符串
 * 手术路线是被重构掉的那套 hack）。选区菜单只在鼠标释放后显示，
 * 已标记/时间标记文字点击弹对应菜单。选区定位用 PM coordsAtPos。
 */
import { Extension, getMarkRange, PM } from './tiptap-runtime.js';
import { buildUpdatedTimeMarker, parseTimeMarkerText } from './time-command.js';

const { Plugin, PluginKey, TextSelection } = PM.state;

// 选区内出现这些节点时不显示菜单：代码块/内联代码/时间标记是
// mark 的禁区（schema 对 code block 禁 mark，时间标记是原子节点，
// 叠加 mark 会在 roundtrip 序列化里产生歧义）。
const PROTECTED_NODE_TYPES = ['codeBlock', 'timeMarker'];

// 已落标记的渲染元素：点击弹出「取消」popover（与旧
// showAnnotationPopover / removeInlineMark 行为对齐）。
const MARKED_ELEMENT_SELECTOR = '.has-annotation, [data-draw], mark.md-mark';

export const selectionMenuPluginKey = new PluginKey('dumbpadSelectionMenu');

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
                    // 鼠标按下进入拖拽态：拖拽选字过程中不显示菜单，
                    // 释放鼠标（mouseup）后才允许出现（与旧编辑器一致）。
                    handleDOMEvents: {
                        mousedown: (view, event) => {
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
                                if (selection.empty || menuView.annotationInputOpen) return;
                                if (!menuView.menuAllowed(view)) return;
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

        this.root = document.createElement('div');
        this.root.className = 'selection-menu typora-selection-menu tiptap-selection-menu';
        this.root.style.display = 'none';

        this.btnGroup = document.createElement('div');
        this.btnGroup.className = 'menu-btn-group';

        this.btnGroup.append(
            this.makeButton('画线', () => this.applyMark('draw')),
            this.makeButton('高亮', () => this.applyMark('mdHighlight')),
            this.makeButton('批注', () => this.openAnnotationInput()),
            this.makeButton('复制', () => this.copySelection()),
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
                this.closeAnnotationInput();
                this.hide();
            }
        });
        // 批注输入框点击不能冒泡回编辑器：ProseMirror 会因焦点离开
        // 而把选区折叠（blur → selection 重置），批注对象随之丢失。
        this.annoInput.addEventListener('mousedown', (event) => event.stopPropagation());

        this.inputGroup.append(this.annoInput, saveBtn);
        this.root.append(this.btnGroup, this.inputGroup);
        document.body.appendChild(this.root);

        // 取消标记 popover（对应旧 mark-popover：取消画线/取消高亮）。
        this.popover = document.createElement('div');
        this.popover.className = 'mark-popover';
        this.popover.style.display = 'none';
        document.body.appendChild(this.popover);

        this.handleBlur = this.handleBlur.bind(this);
        // 点击已标记/时间标记文字弹对应菜单：直接在编辑器 DOM 上挂
        // click 监听（与旧 bindAnnotationPopover / bindTimeMarkerPopover
        // 同机制）。不走 PM 的 handleClick——它依赖 PM 鼠标管线
        // （posAtCoords / view.mouseDown 状态机），无布局环境不可靠，
        // 且这是纯 DOM 关注点、不涉事务。
        this.handleEditorClick = (event) => {
            const marker = event.target?.closest?.('.md-time-marker');
            if (marker && view.dom.contains(marker)) {
                this.showTimeMarkerMenu(marker);
                return;
            }
            const marked = event.target?.closest?.(MARKED_ELEMENT_SELECTOR);
            if (!marked || !view.dom.contains(marked)) return;
            this.showMarkPopover(marked);
        };
        view.dom.addEventListener('click', this.handleEditorClick);
        window.addEventListener('resize', this.handleResize);
        this.root.addEventListener('mousedown', (event) => event.stopPropagation());
        this.popover.addEventListener('mousedown', (event) => event.stopPropagation());
        // 点编辑器外（其他面板/正文）收起菜单：PM 的 blur 捕获即可，
        // 不需要 document 级 mousedown 监听。
        view.dom.addEventListener('blur', this.handleBlur, true);
    }

    makeButton(label, action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = label;
        btn.textContent = label;
        // 阻止 mousedown 默认行为：否则点击按钮会把编辑器焦点/选区
        // 抢走（浏览器把焦点移到按钮），PM 选区折叠、动作落空。
        btn.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        btn.addEventListener('click', () => action());
        return btn;
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
        let menuLeft = rect.left + rect.width / 2 - menuRect.width / 2;
        let menuTop = isMobile
            ? rect.bottom + scrollY + 10
            : rect.top + scrollY - menuRect.height - 10;
        if (isMobile && menuTop + menuRect.height > scrollY + window.innerHeight - 12) {
            menuTop = rect.top + scrollY - menuRect.height - 10;
        }
        if (!isMobile && menuTop < scrollY + 10) menuTop = rect.bottom + scrollY + 10;
        menuTop = Math.max(menuTop, scrollY + 10);
        menuLeft = Math.min(Math.max(menuLeft, 10), window.innerWidth - menuRect.width - 10);
        this.root.style.left = `${menuLeft}px`;
        this.root.style.top = `${menuTop}px`;
    }

    /* ------- 已标记文字的「取消」popover（旧 mark-popover 行为） ------- */

    showMarkPopover(element) {
        const isMark = element.matches('mark.md-mark');
        const isDraw = element.matches('[data-draw]');
        const isAnnotation = element.matches('.has-annotation, [data-note]');
        const comment = element.getAttribute('data-note') || element.getAttribute('data-comment') || '';
        const type = comment || isAnnotation ? 'annotation' : (isMark ? 'highlight' : (isDraw ? 'draw' : null));
        if (!type) return;

        this.popover.innerHTML = '';
        const actions = document.createElement('div');
        actions.className = 'mark-popover-actions';
        actions.style.cssText = 'border:none;margin:0;padding:0;';

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
        this.popover.style.display = 'block';
        this.positionPopover(element);
        // 点其他位置收起 popover（延迟挂载避免吞掉当前点击）。
        clearTimeout(this.popoverCloseTimer);
        this.popoverCloseTimer = setTimeout(() => {
            const close = (event) => {
                if (!this.popover.contains(event.target)) {
                    this.popover.style.display = 'none';
                    document.removeEventListener('mousedown', close);
                }
            };
            document.addEventListener('mousedown', close);
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
            let left = rect.left + rect.width / 2 - popRect.width / 2;
            let top = rect.top + scrollY - popRect.height - 12;
            if (top < scrollY + 10) top = rect.bottom + scrollY + 12;
            left = Math.min(Math.max(left, 10), window.innerWidth - popRect.width - 10);
            this.popover.style.left = `${left}px`;
            this.popover.style.top = `${top}px`;
        });
    }

    hideMarkPopover() {
        this.popover.style.display = 'none';
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
        this.popover.style.display = 'none';
        if (!range) return;
        const schema = this.view.state.schema;
        const markType = type === 'highlight'
            ? schema.marks.mdHighlight
            : (type === 'draw' ? schema.marks.draw : schema.marks.annotation);
        if (!markType) return;
        this.view.dispatch(this.view.state.tr.removeMark(range.from, range.to, markType));
        this.view.focus();
    }

    /** 编辑批注：框架更新 mark attrs（可撤销），与旧 updateAnnotationComment 对齐。 */
    editAnnotationComment(element, comment) {
        const range = this.posRangeForElement(element);
        this.popover.style.display = 'none';
        if (!range) return;
        const next = window.prompt('修改批注内容', comment || '');
        if (next === null) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        const annotationType = this.view.state.schema.marks.annotation;
        if (!annotationType) return;
        const tr = this.view.state.tr;
        tr.removeMark(range.from, range.to, annotationType);
        tr.addMark(range.from, range.to, annotationType.create({ note: trimmed }));
        this.view.dispatch(tr);
        this.view.focus();
    }


    /* ------- 时间标记菜单（更新/删除，对应旧 showTimeMarkerMenu） ------- */

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
        clearTimeout(this.timeMarkerMenuCloseTimer);
        this.timeMarkerMenuCloseTimer = setTimeout(() => {
            const close = (event) => {
                if (!menu.contains(event.target) && !event.target.closest?.('.md-time-marker')) {
                    this.hideTimeMarkerMenu();
                    document.removeEventListener('mousedown', close);
                }
            };
            document.addEventListener('mousedown', close);
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
        menu.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        menu.addEventListener('click', (event) => {
            const button = event.target.closest('[data-time-action]');
            if (!button) return;
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
            let left = rect.left + rect.width / 2 - menuRect.width / 2;
            let top = rect.top + scrollY - menuRect.height - 10;
            if (top < scrollY + 10) top = rect.bottom + scrollY + 10;
            left = Math.min(Math.max(left, 10), window.innerWidth - menuRect.width - 10);
            this.timeMarkerMenu.style.left = `${left}px`;
            this.timeMarkerMenu.style.top = `${top}px`;
        });
    }

    hideTimeMarkerMenu() {
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
        this.view.dispatch(tr);
        this.view.focus();
    }

    openAnnotationInput() {
        this.annotationInputOpen = true;
        this.btnGroup.style.display = 'none';
        this.inputGroup.style.display = 'flex';
        this.annoInput.value = '';
        this.annoInput.focus();
        this.position();
    }

    closeAnnotationInput() {
        this.annotationInputOpen = false;
        this.btnGroup.style.display = 'flex';
        this.inputGroup.style.display = 'none';
    }

    saveAnnotation() {
        const comment = this.annoInput.value.trim();
        this.closeAnnotationInput();
        if (comment) this.applyMark('annotation', { note: comment });
        else this.hide();
    }

    applyMark(markName, attrs = {}) {
        const { from, to } = this.pendingSelection || this.view.state.selection;
        // 选区尾端可能是段首/块边界，落 mark 前收缩到实际文本范围内，
        // 避免 mark 泄到相邻块（与旧 occurrence 校验等价的框架级防线）。
        const tr = this.view.state.tr.addMark(from, to, this.view.state.schema.marks[markName].create(attrs));
        this.view.dispatch(tr);
        this.hide();
        // 落标记后退出选中状态：光标折叠到标记起点（与旧编辑器一致，
        // 选区仍罩在高亮/划线上会显得"没有退出选中"）。
        const $from = this.view.state.doc.resolve(from);
        const collapsed = TextSelection.near($from, -1);
        this.view.dispatch(this.view.state.tr.setSelection(collapsed));
        this.view.focus();
    }

    async copySelection() {
        const { from, to } = this.pendingSelection || this.view.state.selection;
        const text = this.view.state.doc.textBetween(from, to, '\n');
        if (text) {
            try {
                await navigator.clipboard.writeText(text);
            } catch (_error) {
                // 无剪贴板权限时静默失败（与旧实现一致的尽力而为）。
            }
        }
        this.hide();
        // 复制后同样退出选中状态。
        const $from = this.view.state.doc.resolve(from);
        const collapsed = TextSelection.near($from, -1);
        this.view.dispatch(this.view.state.tr.setSelection(collapsed));
        this.view.focus();
    }

    handleBlur() {
        if (this.annotationInputOpen) return;
        this.hide();
    }

    destroy() {
        window.removeEventListener('resize', this.handleResize);
        this.view.dom.removeEventListener('blur', this.handleBlur, true);
        this.view.dom.removeEventListener('click', this.handleEditorClick);
        this.view.dom.removeEventListener('click', this.handleEditorClick);
        this.root.remove();
        this.popover.remove();
        this.timeMarkerMenu?.remove();
    }
}
