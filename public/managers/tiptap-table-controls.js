/**
 * Tiptap 表格整体操控与行列快捷增删（仿 Typora / 飞书浮条 + 桌面端 Notion 边缘 `+`）：
 * 通过 ProseMirror Plugin + Cell Decoration + body 级悬浮层实现，不篡改 PM 管辖的 DOM，
 * 与 `DumbPadTableStack` 窄屏折卡/首列冻结横滑完全兼容，仅编辑态按需出现、阅读态零打扰。
 */
import { Extension, PM } from './tiptap-runtime.js';

const { Plugin, PluginKey, TextSelection } = PM.state;
const { Decoration, DecorationSet } = PM.view;

export const tableControlsPluginKey = new PluginKey('dumbpadTableControls');

const ICON_SELECT_TABLE = '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="10" y1="4" x2="10" y2="20"/></svg>';
const ICON_ADD_ROW = '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M12 16v5"/><path d="M9.5 18.5h5"/></svg>';
const ICON_ADD_COL = '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16"/><path d="M12 4v16"/><path d="M16 12h5"/><path d="M18.5 9.5v5"/></svg>';
const ICON_DEL_ROW = '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M9.5 18.5h5"/></svg>';
const ICON_DEL_COL = '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16"/><path d="M12 4v16"/><path d="M16 12h5"/></svg>';
const ICON_COPY_TABLE = '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_DELETE_TABLE = '<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_PLUS = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

function notify(message, type = 'success', timeoutMs = 1500) {
    window.toaster?.show?.(message, type, false, timeoutMs);
}

/** 根据文档或指针所在表格起始 pos，解析表格行列数、单元格坐标与当前活跃格。 */
export function findTableContextAt(state, targetTablePos = null) {
    const { doc, selection } = state;
    let tablePos = null;
    let tableNode = null;
    let caretInTable = false;

    const $from = selection.$from;
    for (let d = $from.depth; d >= 0; d -= 1) {
        const node = $from.node(d);
        if (node.type.name === 'table') {
            const pos = $from.before(d);
            if (targetTablePos === null || targetTablePos === pos) {
                tablePos = pos;
                tableNode = node;
                caretInTable = true;
            }
            break;
        }
    }

    if (!tableNode && targetTablePos !== null && targetTablePos >= 0 && targetTablePos < doc.content.size) {
        const candidate = doc.nodeAt(targetTablePos);
        if (candidate?.type?.name === 'table') {
            tablePos = targetTablePos;
            tableNode = candidate;
        }
    }

    if (!tableNode || tablePos === null) return null;

    const cellPositions = [];
    const lastRowFirstCellPosRef = { pos: null };
    let firstRowLastCellPos = null;
    let maxColCount = 0;

    let rowIdx = 0;
    tableNode.forEach((row, rowOffset) => {
        const rowPos = tablePos + 1 + rowOffset;
        let colsInRow = 0;
        let colIdx = 0;
        row.forEach((cell, cellOffset) => {
            const cellPos = rowPos + 1 + cellOffset;
            cellPositions.push(cellPos);
            if (colIdx === 0) lastRowFirstCellPosRef.pos = cellPos;
            if (rowIdx === 0) firstRowLastCellPos = cellPos;
            colsInRow += Math.max(1, Number(cell.attrs?.colspan) || 1);
            colIdx += 1;
        });
        maxColCount = Math.max(maxColCount, colsInRow);
        rowIdx += 1;
    });

    if (cellPositions.length === 0) return null;

    return {
        pos: tablePos,
        node: tableNode,
        rowCount: tableNode.childCount,
        colCount: maxColCount,
        cellPositions,
        firstCellPos: cellPositions[0],
        lastCellPos: cellPositions[cellPositions.length - 1],
        lastRowFirstCellPos: lastRowFirstCellPosRef.pos ?? cellPositions[cellPositions.length - 1],
        firstRowLastCellPos: firstRowLastCellPos ?? cellPositions[0],
        caretInTable,
    };
}

/** 把目标位置的一张表格整体序列化为干净的 GFM Markdown。 */
export function serializeTableNodeToMarkdown(editor, tablePos) {
    const state = editor?.state;
    if (!state) return '';
    const tableNode = state.doc.nodeAt(tablePos);
    if (!tableNode || tableNode.type.name !== 'table') return '';
    const serializer = editor.storage?.markdown?.serializer;
    if (!serializer?.serialize) return '';
    const subDoc = state.schema.nodes.doc.create(null, tableNode);
    return String(serializer.serialize(subDoc) || '').trimEnd();
}

/** 整块删除位于 tablePos 的表格，并在必要时将光标安全落到相邻或空段落中。 */
export function deleteTableAtPos(editor, tablePos) {
    const view = editor?.view;
    if (!view || tablePos === null || tablePos === undefined) return false;
    const { state } = view;
    const node = state.doc.nodeAt(tablePos);
    if (!node || node.type.name !== 'table') return false;
    const tableEnd = tablePos + node.nodeSize;
    const tr = state.tr.delete(tablePos, tableEnd);
    const paraType = state.schema.nodes.paragraph;
    if (tr.doc.childCount === 0 && paraType) {
        tr.insert(0, paraType.create());
    }
    const targetPos = Math.max(1, Math.min(tablePos + 1, tr.doc.content.size));
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tablePos, tr.doc.content.size))));
    tr.setMeta(tableControlsPluginKey, { type: 'clear' });
    view.dispatch(tr.scrollIntoView());
    return Boolean(targetPos >= 0);
}

function decorateTableCells(doc, tablePos, className, decorations) {
    if (tablePos === null || tablePos === undefined || tablePos < 0 || tablePos >= doc.content.size) return;
    const tableNode = doc.nodeAt(tablePos);
    if (!tableNode || tableNode.type.name !== 'table') return;
    tableNode.forEach((row, rowOffset) => {
        const rowPos = tablePos + 1 + rowOffset;
        row.forEach((cell, cellOffset) => {
            const cellPos = rowPos + 1 + cellOffset;
            decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, { class: className }));
        });
    });
}

function buildTableControlDecorations(state, pluginState) {
    if (!pluginState) return DecorationSet.empty;
    const decorations = [];
    if (pluginState.wholeTablePos !== null) {
        decorateTableCells(state.doc, pluginState.wholeTablePos, 'dumbpad-table-selected-cell', decorations);
    }
    if (pluginState.dangerTablePos !== null) {
        decorateTableCells(state.doc, pluginState.dangerTablePos, 'dumbpad-table-danger-cell', decorations);
    }
    return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
}

class TableControlsView {
    constructor(view, editor) {
        this.view = view;
        this.editor = editor;
        this.hoveredTablePos = null;
        this.pendingHoverPos = null;
        this.hoverEnterTimer = null;
        this.leaveTimer = null;
        this.rafId = 0;
        this.currentTablePos = null;

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'dumbpad-table-toolbar';
        this.toolbar.hidden = true;
        this.toolbar.setAttribute('role', 'toolbar');
        this.toolbar.setAttribute('aria-label', '表格操作');

        this.btnSelectAll = this.makeBtn('selectTable', ICON_SELECT_TABLE, '整表', '选中整张表格 (退格可整体删除)');
        this.btnAddRow = this.makeBtn('addRowAfter', ICON_ADD_ROW, '+行', '在当前行下方插入一行');
        this.btnAddCol = this.makeBtn('addColumnAfter', ICON_ADD_COL, '+列', '在当前列右侧插入一列');
        this.btnDelRow = this.makeBtn('deleteRow', ICON_DEL_ROW, '-行', '删除当前行');
        this.btnDelCol = this.makeBtn('deleteColumn', ICON_DEL_COL, '-列', '删除当前列');
        this.btnCopy = this.makeBtn('copyTable', ICON_COPY_TABLE, '复制', '复制整张表格 Markdown');
        this.btnDelete = this.makeBtn('deleteTable', ICON_DELETE_TABLE, '删表', '删除整张表格', true);

        this.toolbar.append(
            this.btnSelectAll,
            this.makeSep(),
            this.btnAddRow,
            this.btnAddCol,
            this.btnDelRow,
            this.btnDelCol,
            this.makeSep(),
            this.btnCopy,
            this.btnDelete,
        );

        this.edgeAddRow = document.createElement('button');
        this.edgeAddRow.type = 'button';
        this.edgeAddRow.className = 'dumbpad-table-edge-btn is-bottom';
        this.edgeAddRow.hidden = true;
        this.edgeAddRow.setAttribute('aria-label', '在末尾添加一行');
        this.edgeAddRow.setAttribute('title', '在底部添加一行');
        this.edgeAddRow.innerHTML = `${ICON_PLUS}<span>添加行</span>`;

        this.edgeAddCol = document.createElement('button');
        this.edgeAddCol.type = 'button';
        this.edgeAddCol.className = 'dumbpad-table-edge-btn is-right';
        this.edgeAddCol.hidden = true;
        this.edgeAddCol.setAttribute('aria-label', '在右侧添加一列');
        this.edgeAddCol.setAttribute('title', '在右侧添加一列');
        this.edgeAddCol.innerHTML = ICON_PLUS;

        document.body.append(this.toolbar, this.edgeAddRow, this.edgeAddCol);

        const keepFocus = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        [this.toolbar, this.edgeAddRow, this.edgeAddCol].forEach((el) => {
            el.addEventListener('pointerdown', keepFocus);
            el.addEventListener('mousedown', keepFocus);
            el.addEventListener('pointerenter', () => this.cancelLeave());
            el.addEventListener('pointerleave', () => this.scheduleLeave());
        });

        this.toolbar.addEventListener('click', (event) => {
            const btn = event.target?.closest?.('[data-table-action]');
            if (!btn || btn.disabled) return;
            this.runAction(btn.dataset.tableAction);
        });

        this.btnDelete.addEventListener('pointerenter', () => this.setDangerPreview(this.currentTablePos));
        this.btnDelete.addEventListener('pointerleave', () => this.setDangerPreview(null));

        this.edgeAddRow.addEventListener('click', () => this.runAction('appendRowBottom'));
        this.edgeAddCol.addEventListener('click', () => this.runAction('appendColRight'));

        this.onDomPointerMove = (event) => this.handlePointerMove(event);
        this.onDomPointerLeave = () => this.scheduleLeave();
        this.onScroll = () => this.schedulePosition();
        this.onResize = () => this.schedulePosition();

        this.view.dom.addEventListener('pointermove', this.onDomPointerMove, { passive: true });
        this.view.dom.addEventListener('pointerleave', this.onDomPointerLeave, { passive: true });
        document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
        window.addEventListener('resize', this.onResize, { passive: true });
        this.sync();
    }

    makeBtn(action, iconSvg, labelText, title, danger = false) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `dumbpad-table-btn${danger ? ' is-danger' : ''}`;
        btn.dataset.tableAction = action;
        btn.setAttribute('aria-label', title);
        btn.setAttribute('title', title);
        btn.innerHTML = `${iconSvg}<span>${labelText}</span>`;
        return btn;
    }

    makeSep() {
        const sep = document.createElement('span');
        sep.className = 'dumbpad-table-sep';
        sep.setAttribute('aria-hidden', 'true');
        return sep;
    }

    isEditableArticle() {
        if (!this.view.editable || !this.view.dom?.isConnected) return false;
        const shell = this.view.dom.closest('.typora-editor-shell');
        if (!shell || shell.classList.contains('is-reading-mode') || shell.classList.contains('is-source-mode')) {
            return false;
        }
        if (document.body.classList.contains('thoughts-mode') || document.body.classList.contains('today-drafts-mode')) {
            return false;
        }
        return true;
    }

    handlePointerMove(event) {
        if (!this.isEditableArticle()) return;
        const tableEl = event.target?.closest?.('.tableWrapper, table');
        if (!tableEl) {
            this.scheduleLeave();
            return;
        }
        this.cancelLeave();
        let pos = null;
        try {
            const insideDom = tableEl.querySelector('th, td') || tableEl;
            const resolved = this.view.posAtDOM(insideDom, 0);
            const $r = this.view.state.doc.resolve(resolved);
            for (let d = $r.depth; d >= 0; d -= 1) {
                if ($r.node(d).type.name === 'table') {
                    pos = $r.before(d);
                    break;
                }
            }
        } catch (_err) {
            pos = null;
        }
        if (pos !== this.hoveredTablePos) {
            if (pos === null) {
                this.cancelEnter();
                this.scheduleLeave();
                return;
            }
            if (this.pendingHoverPos === pos) return;
            this.cancelEnter();
            this.pendingHoverPos = pos;
            this.hoverEnterTimer = setTimeout(() => {
                this.hoverEnterTimer = null;
                this.pendingHoverPos = null;
                this.hoveredTablePos = pos;
                this.sync();
            }, 130);
        }
    }

    cancelEnter() {
        this.pendingHoverPos = null;
        if (this.hoverEnterTimer) {
            clearTimeout(this.hoverEnterTimer);
            this.hoverEnterTimer = null;
        }
    }

    cancelLeave() {
        if (this.leaveTimer) {
            clearTimeout(this.leaveTimer);
            this.leaveTimer = null;
        }
    }

    scheduleLeave() {
        this.cancelEnter();
        this.cancelLeave();
        this.leaveTimer = setTimeout(() => {
            this.leaveTimer = null;
            if (this.hoveredTablePos !== null) {
                this.hoveredTablePos = null;
                this.setDangerPreview(null);
                this.sync();
            }
        }, 210);
    }

    setDangerPreview(tablePos) {
        const current = tableControlsPluginKey.getState(this.view.state)?.dangerTablePos ?? null;
        if (current === tablePos) return;
        this.view.dispatch(
            this.view.state.tr
                .setMeta(tableControlsPluginKey, { type: 'setDangerTable', pos: tablePos })
                .setMeta('addToHistory', false),
        );
    }

    ensureSelectionInCell(cellPos) {
        const target = Math.min(cellPos + 1, this.editor.state.doc.content.size);
        this.editor.chain().focus().setTextSelection(target).run();
    }

    runAction(action) {
        const ctx = findTableContextAt(this.view.state, this.currentTablePos);
        if (!ctx) return;

        if (action === 'selectTable') {
            const pState = tableControlsPluginKey.getState(this.view.state);
            const isAlreadyWhole = pState?.wholeTablePos === ctx.pos && ('$anchorCell' in this.view.state.selection);
            if (isAlreadyWhole) {
                this.editor.chain().focus().setTextSelection(ctx.firstCellPos + 1).run();
                return;
            }
            this.editor.chain()
                .focus()
                .setCellSelection({ anchorCell: ctx.firstCellPos, headCell: ctx.lastCellPos })
                .command(({ tr }) => {
                    tr.setMeta(tableControlsPluginKey, { type: 'setWholeTable', pos: ctx.pos });
                    tr.setMeta('addToHistory', false);
                    return true;
                })
                .run();
            return;
        }

        if (action === 'copyTable') {
            const md = serializeTableNodeToMarkdown(this.editor, ctx.pos);
            if (!md) return;
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(md).then(() => notify('已复制整张表格 Markdown')).catch(() => {});
            } else {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = md;
                    ta.style.cssText = 'position:fixed;opacity:0;';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    notify('已复制整张表格 Markdown');
                } catch (_err) {}
            }
            return;
        }

        if (action === 'deleteTable') {
            this.hoveredTablePos = null;
            this.setDangerPreview(null);
            deleteTableAtPos(this.editor, ctx.pos);
            this.editor.view.focus();
            notify('已删除表格', 'info');
            return;
        }

        if (action === 'appendRowBottom') {
            this.ensureSelectionInCell(ctx.lastRowFirstCellPos);
            this.editor.chain().focus().addRowAfter().run();
            return;
        }

        if (action === 'appendColRight') {
            this.ensureSelectionInCell(ctx.firstRowLastCellPos);
            this.editor.chain().focus().addColumnAfter().run();
            return;
        }

        if (!ctx.caretInTable) {
            const fallbackCell = (action === 'addRowAfter' || action === 'deleteRow')
                ? ctx.lastRowFirstCellPos
                : ctx.firstRowLastCellPos;
            this.ensureSelectionInCell(fallbackCell);
        }

        if (action === 'addRowAfter') this.editor.chain().focus().addRowAfter().run();
        else if (action === 'addColumnAfter') this.editor.chain().focus().addColumnAfter().run();
        else if (action === 'deleteRow') this.editor.chain().focus().deleteRow().run();
        else if (action === 'deleteColumn') this.editor.chain().focus().deleteColumn().run();
    }

    sync() {
        if (!this.isEditableArticle()) {
            this.hide();
            return;
        }
        const ctx = findTableContextAt(this.view.state, this.hoveredTablePos);
        if (!ctx) {
            this.hide();
            return;
        }
        this.currentTablePos = ctx.pos;
        const pState = tableControlsPluginKey.getState(this.view.state);
        const isWhole = pState?.wholeTablePos === ctx.pos && ('$anchorCell' in this.view.state.selection);
        this.btnSelectAll.classList.toggle('is-active', isAlreadyBool(isWhole));
        this.btnSelectAll.setAttribute('aria-pressed', String(Boolean(isWhole)));
        this.btnDelRow.disabled = ctx.rowCount <= 1;
        this.btnDelCol.disabled = ctx.colCount <= 1;
        this.toolbar.hidden = false;
        this.position(ctx.pos);
    }

    schedulePosition() {
        if (this.toolbar.hidden || this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            if (this.currentTablePos === null || !this.isEditableArticle()) {
                this.hide();
                return;
            }
            this.position(this.currentTablePos);
        });
    }

    position(tablePos) {
        const dom = this.view.nodeDOM(tablePos);
        const wrapper = dom?.classList?.contains?.('tableWrapper') ? dom : dom?.querySelector?.('.tableWrapper') || dom;
        const table = wrapper?.querySelector?.('table') || wrapper;
        if (!wrapper?.isConnected) {
            this.hide();
            return;
        }
        const wRect = wrapper.getBoundingClientRect?.();
        const tRect = table?.getBoundingClientRect?.();
        // jsdom 等无布局环境下包围盒宽高全为 0：跳过定位但不隐藏按钮。
        if (!wRect || (wRect.width === 0 && wRect.height === 0)) return;

        const vvTop = window.visualViewport?.offsetTop || 0;
        const vvHeight = window.visualViewport?.height || window.innerHeight || 800;
        const vvWidth = window.visualViewport?.width || window.innerWidth || 1200;
        if (wRect.bottom < vvTop + 52 || wRect.top > vvTop + vvHeight - 24) {
            this.toolbar.hidden = true;
            this.edgeAddRow.hidden = true;
            this.edgeAddCol.hidden = true;
            return;
        }

        this.toolbar.hidden = false;
        const barRect = this.toolbar.getBoundingClientRect();
        const barW = barRect.width || 290;
        const barH = barRect.height || 30;
        // 骑跨表格上边框悬停：既留在 .tableWrapper 约 18px 上边距内、不遮挡上方标题/段落，也不盖住表头文字。
        const topOffset = Math.min(Math.round(barH * 0.5), 16);
        const top = Math.max(vvTop + 56, Math.min(wRect.top - topOffset, vvTop + vvHeight - barH - 8));
        // 靠表右上缘对齐：避免左对齐遮挡正上方紧邻的标题或首列文字。
        const preferredLeft = wRect.width >= barW ? (wRect.right - barW) : wRect.left;
        const left = Math.max(10, Math.min(preferredLeft, vvWidth - barW - 10));
        this.toolbar.style.left = `${Math.round(left)}px`;
        this.toolbar.style.top = `${Math.round(top)}px`;

        const isDesktopFine = window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
        const isStacked = Boolean(table?.querySelector?.('td.dumbpad-stacked-cell'));
        const showEdges = Boolean(isDesktopFine && !isStacked && wRect.width > 460 && this.hoveredTablePos === tablePos);
        if (showEdges && tRect) {
            const visibleW = Math.min(tRect.width, wRect.width);
            this.edgeAddRow.hidden = false;
            this.edgeAddRow.style.left = `${Math.round(wRect.left)}px`;
            this.edgeAddRow.style.top = `${Math.round(wRect.bottom + 3)}px`;
            this.edgeAddRow.style.width = `${Math.round(visibleW)}px`;

            const rightAnchor = Math.min(tRect.right, wRect.right) + 4;
            const fabRect = document.querySelector('#floating-actions:not([hidden]), .floating-actions-bar:not([hidden])')?.getBoundingClientRect?.();
            const hitsFabHoriz = Boolean(fabRect && rightAnchor + 18 > fabRect.left - 4 && rightAnchor < fabRect.right + 4);
            let colTop = tRect.top;
            let colHeight = Math.round(tRect.height);
            let canShowColEdge = rightAnchor + 18 < vvWidth;
            if (canShowColEdge && hitsFabHoriz) {
                const overlapsFab = tRect.bottom > fabRect.top - 4 && tRect.top < fabRect.bottom + 4;
                if (overlapsFab) {
                    const clearanceAbove = fabRect.top - 6 - tRect.top;
                    if (clearanceAbove >= 34) {
                        colHeight = Math.round(clearanceAbove);
                    } else {
                        canShowColEdge = false;
                    }
                }
            }
            if (canShowColEdge) {
                this.edgeAddCol.hidden = false;
                this.edgeAddCol.style.left = `${Math.round(rightAnchor)}px`;
                this.edgeAddCol.style.top = `${Math.round(colTop)}px`;
                this.edgeAddCol.style.height = `${Math.max(32, colHeight)}px`;
            } else {
                this.edgeAddCol.hidden = true;
            }
        } else {
            this.edgeAddRow.hidden = true;
            this.edgeAddCol.hidden = true;
        }
    }

    hide() {
        this.cancelEnter();
        this.cancelLeave();
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }
        this.currentTablePos = null;
        this.toolbar.hidden = true;
        this.edgeAddRow.hidden = true;
        this.edgeAddCol.hidden = true;
    }

    update() {
        this.sync();
    }

    destroy() {
        this.hide();
        this.view.dom.removeEventListener('pointermove', this.onDomPointerMove);
        this.view.dom.removeEventListener('pointerleave', this.onDomPointerLeave);
        document.removeEventListener('scroll', this.onScroll, { capture: true });
        window.removeEventListener('resize', this.onResize);
        this.toolbar.remove();
        this.edgeAddRow.remove();
        this.edgeAddCol.remove();
    }
}

function isAlreadyBool(val) {
    return Boolean(val);
}

export const DumbPadTableControls = Extension.create({
    name: 'dumbpadTableControls',

    addProseMirrorPlugins() {
        const editor = this.editor;
        return [
            new Plugin({
                key: tableControlsPluginKey,
                state: {
                    init: () => ({ wholeTablePos: null, dangerTablePos: null }),
                    apply(tr, value, _oldState, newState) {
                        const meta = tr.getMeta(tableControlsPluginKey);
                        let wholeTablePos = value.wholeTablePos;
                        let dangerTablePos = value.dangerTablePos;
                        if (meta?.type === 'clear') {
                            return { wholeTablePos: null, dangerTablePos: null };
                        }
                        if (meta?.type === 'setWholeTable') wholeTablePos = meta.pos ?? null;
                        if (meta?.type === 'setDangerTable') dangerTablePos = meta.pos ?? null;
                        if (!('$anchorCell' in newState.selection) && meta?.type !== 'setWholeTable') {
                            wholeTablePos = null;
                        }
                        if (wholeTablePos !== null && newState.doc.nodeAt(wholeTablePos)?.type?.name !== 'table') {
                            wholeTablePos = null;
                        }
                        if (dangerTablePos !== null && newState.doc.nodeAt(dangerTablePos)?.type?.name !== 'table') {
                            dangerTablePos = null;
                        }
                        if (wholeTablePos === value.wholeTablePos && dangerTablePos === value.dangerTablePos) {
                            return value;
                        }
                        return { wholeTablePos, dangerTablePos };
                    },
                },
                props: {
                    decorations: (state) => buildTableControlDecorations(state, tableControlsPluginKey.getState(state)),
                    handleKeyDown(view, event) {
                        if (!view?.editable || event?.isComposing) return false;
                        if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
                        const pState = tableControlsPluginKey.getState(view.state);
                        if (pState?.wholeTablePos === null || pState?.wholeTablePos === undefined) return false;
                        if (!('$anchorCell' in view.state.selection)) return false;
                        event.preventDefault();
                        return deleteTableAtPos(editor, pState.wholeTablePos);
                    },
                },
                view: (view) => new TableControlsView(view, editor),
            }),
        ];
    },
});
