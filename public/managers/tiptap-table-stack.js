/**
 * 窄屏表格折卡（Tiptap 扩展）。
 *
 * 4 列表格塞进手机 321px 的内容宽时，每列只剩 ~80px，一格 10–30 字会折成
 * 3–5 行、整行 85px 高——读起来是一根竖条。这里在**放不下时**把表格折成
 * 「每行一张卡」：表头行藏起来，首格当行标题，其余格前面挂字段名。
 *
 * 三条硬约束：
 * 1) **不许直接改 PM 管的 DOM**。`is-stacked` 与 `data-label` 全部走
 *    Decoration（DOMObserver 会在重绘时抹掉外来属性），这也是它能在
 *    撤销/远端更新/切阅读模式之后仍然成立的原因。
 * 2) **不许为了量宽去动真表格**。要判断「放不下」必须知道表格的自然宽，
 *    而临时改真表格的 width 会被 PM 的 DOMObserver 记成一次属性变更。
 *    这里改成把表格克隆到 `.typora-editor-shell` 里（PM 视野之外）量
 *    max-content，量完立刻移除。
 * 3) **只对窄容器生效**。容器宽超过 STACK_MAX_CONTAINER_PX 一律不折，
 *    桌面 800px 卡片零改动。
 *
 * 表头从哪来：Tiptap 的表格**不产 `<thead>`**，表头就是 `<tbody>` 的第一行
 * `<tr><th>`。所以列标签取第一行的单元格文字，按 colspan 展开对齐。
 */
import { Extension, PM } from './tiptap-runtime.js';

const { Plugin, PluginKey } = PM.state;
const { Decoration, DecorationSet } = PM.view;

export const tableStackKey = new PluginKey('dumbpadTableStack');

// 容器宽超过它就不折卡（手机上内容宽 321，桌面卡片 720+）。
const STACK_MAX_CONTAINER_PX = 480;
// 自然宽比容器宽出这么多才算「放不下」，避免 1px 的亚像素抖动反复翻面。
const STACK_OVERFLOW_SLOP_PX = 2;
// 数据行超过这个数就不折卡。
// 折卡把「一行」变成「一张卡（N 个字段）」，纵向长度大约翻 N 倍：16 行 5 列的
// 对比表折完是 8000px 高，而原表只有 900px。长表要的是「扫」，不是「读」，
// 所以只有 3 行以内的短表才折卡，长表保留真表格 + 首列冻结横滑（见 styles.css）。
const STACK_MAX_BODY_ROWS = 3;

/** 单元格的列跨度。 */
function colspanOf(cell) {
    return Math.max(1, Number(cell.attrs?.colspan) || 1);
}

/** 表头行 → 每列的标签文字（按 colspan 展开）。 */
function readColumnLabels(headerRow) {
    const labels = [];
    headerRow.forEach((cell) => {
        const text = String(cell.textContent || '').trim();
        for (let i = 0; i < colspanOf(cell); i += 1) labels.push(text);
    });
    return labels;
}

/**
 * 按当前的「哪些表要折」集合生成 Decoration。
 *
 * 标记为什么挂在**单元格**上而不是表格节点上：Tiptap 的表格是 NodeView
 * （`.tableWrapper > table`），PM 的 node decoration 不会落到带自定义
 * NodeView 的节点的 DOM 上——实测给表格节点挂 class 完全没效果，而单元格是
 * 普通节点、decoration 正常生效。所以数据格带 `dumbpad-stacked-cell`，
 * 表格用 `:has()` 反查。
 */
export function buildTableStackDecorations(state) {
    const stacked = tableStackKey.getState(state);
    if (!stacked || !stacked.size) return DecorationSet.empty;
    const decorations = [];

    state.doc.descendants((node, pos) => {
        if (node.type.name !== 'table') return true;
        if (!stacked.has(pos)) return false;

        let headerRow = null;
        let rowIndex = 0;
        node.forEach((row, rowOffset) => {
            if (rowIndex === 0) {
                headerRow = row;
                rowIndex += 1;
                return;
            }
            const rowPos = pos + 1 + rowOffset;
            const labels = headerRow ? readColumnLabels(headerRow) : [];
            let column = 0;
            row.forEach((cell, cellOffset) => {
                const label = labels[column];
                const cellPos = rowPos + 1 + cellOffset;
                decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, {
                    class: 'dumbpad-stacked-cell',
                    ...(label ? { 'data-label': label } : {}),
                }));
                column += colspanOf(cell);
            });
            rowIndex += 1;
        });
        // 表格内部已经手工走完，别再让 descendants 往里钻。
        return false;
    });

    return DecorationSet.create(state.doc, decorations);
}

/**
 * 量表格的「自然宽」：克隆到编辑器的壳里（PM 的 contentDOM 之外）按
 * max-content 布局。克隆体带着 `.vditor-reset.tiptap` 类，所以
 * `.typora-editor-shell .tiptap table …` 那套字号/内边距规则照常生效，
 * 量出来的宽度和真表格同一把尺子。
 *
 * **必须先把克隆体上的折卡标记清掉**：标记在的时候 `table:has(td.dumbpad-stacked-cell)`
 * 会让克隆体也变成 `display:block` 的卡片流，量出来的「自然宽」等于容器宽，
 * 于是「放得下」→ 取消折卡 → 下一拍又量到 972 → 再折上，整页开始抖动。
 */
function measureNaturalWidth(table, shell) {
    const clone = table.cloneNode(true);
    clone.querySelectorAll('.dumbpad-stacked-cell').forEach((cell) => {
        cell.classList.remove('dumbpad-stacked-cell');
    });
    clone.style.width = 'max-content';
    clone.style.minWidth = '0';

    const probe = document.createElement('div');
    probe.className = 'vditor-reset tiptap';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-10000px;top:0;width:max-content;max-width:none;'
        + 'min-height:0;padding:0;border:0;box-shadow:none;visibility:hidden;pointer-events:none;';
    probe.appendChild(clone);
    shell.appendChild(probe);
    const width = clone.getBoundingClientRect().width;
    probe.remove();
    return width;
}

function sameSet(a, b) {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
}

export const DumbPadTableStack = Extension.create({
    name: 'dumbpadTableStack',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: tableStackKey,

                state: {
                    init: () => new Set(),
                    apply(tr, previous) {
                        const next = tr.getMeta(tableStackKey);
                        return next instanceof Set ? next : previous;
                    },
                },

                props: {
                    decorations: (state) => buildTableStackDecorations(state),
                },

                view: (editorView) => {
                    let frame = 0;
                    let retries = 0;

                    const measure = () => {
                        frame = 0;
                        const shell = editorView.dom.closest('.typora-editor-shell');
                        if (!shell || !editorView.dom.isConnected) return;
                        const next = new Set();
                        let unmeasurable = false;
                        editorView.state.doc.descendants((node, pos) => {
                            if (node.type.name !== 'table') return true;
                            // 长表不折：折完纵向翻好几倍，反而更难用。
                            if (node.childCount - 1 > STACK_MAX_BODY_ROWS) return false;
                            const dom = editorView.nodeDOM(pos);
                            const table = dom?.tagName === 'TABLE' ? dom : dom?.querySelector?.('table');
                            const wrapper = table?.parentElement;
                            if (!table || !wrapper) return false;
                            const available = wrapper.clientWidth;
                            // 启动阶段文章区可能还没上屏：容器宽 0 / 克隆量到 0 都说明
                            // 「现在量不准」，标记一下等下一拍，别把它当成「放得下」。
                            if (!available) {
                                unmeasurable = true;
                                return false;
                            }
                            if (available > STACK_MAX_CONTAINER_PX) return false;
                            const natural = measureNaturalWidth(table, shell);
                            if (!natural) {
                                unmeasurable = true;
                                return false;
                            }
                            if (natural > available + STACK_OVERFLOW_SLOP_PX) next.add(pos);
                            return false;
                        });
                        if (sameSet(next, tableStackKey.getState(editorView.state))) {
                            if (unmeasurable && retries < 20) {
                                retries += 1;
                                setTimeout(schedule, 80);
                            }
                            return;
                        }
                        retries = 0;
                        editorView.dispatch(
                            editorView.state.tr
                                .setMeta(tableStackKey, next)
                                // 折卡是显示层的决定，不该占撤销历史
                                .setMeta('addToHistory', false),
                        );
                    };

                    const schedule = () => {
                        if (frame) return;
                        frame = requestAnimationFrame(measure);
                    };

                    const onResize = () => schedule();
                    window.addEventListener('resize', onResize);

                    // 首帧量不到：应用是「先建编辑器、再 setValue、最后把文章区显示出来」
                    // 的顺序，view 创建时容器宽度还是 0，`available` 判空直接跳过，
                    // 而之后没有事务就不会再量——表现就是「刷新后表格不折卡，
                    // 点一下编辑器才折」。ResizeObserver 盯宽度变化补上这一拍。
                    // 只比宽度：折卡会改内容高度，按高度触发会反复空跑。
                    let lastWidth = -1;
                    const observer = typeof ResizeObserver === 'function'
                        ? new ResizeObserver((entries) => {
                            const width = entries[0]?.contentRect?.width ?? 0;
                            if (Math.abs(width - lastWidth) < 1) return;
                            lastWidth = width;
                            schedule();
                        })
                        : null;
                    observer?.observe(editorView.dom);

                    // 字体加载会改变单元格的 min-content 宽度，量完再补一拍。
                    document.fonts?.ready?.then(() => schedule()).catch(() => {});

                    schedule();
                    // 应用是「先建编辑器、再 setValue、最后把文章区显示出来」的顺序，
                    // 头几拍容器宽可能还是 0。补几个延迟兜底，成本只有一次布局读取。
                    [120, 400, 1200].forEach((ms) => setTimeout(schedule, ms));

                    return {
                        update: () => schedule(),
                        destroy() {
                            window.removeEventListener('resize', onResize);
                            observer?.disconnect();
                            if (frame) cancelAnimationFrame(frame);
                        },
                    };
                },
            }),
        ];
    },
});
