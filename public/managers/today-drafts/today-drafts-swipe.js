// 触摸区域按起笔划分：
// 纸张两侧边缘（两端各占约 22% 宽度，或至少 72px 宽的舒适大拇指翻页区）起笔，
// 翻页手势才认领指针（认领会让 click 改派到 view，纸边起笔不需要原生点击）；
// 草稿行中间约 56% 的正文区起笔不认领，保住「点正文进编辑」的原生 click。
// 行操作已改为长按唤出图标菜单（见 today-drafts-manager.js 的 startDraftLongPress），
// 与翻页不再争抢横向手势，这里只剩「该不该认领翻页」这一条判据。
// 起手定归属，手势中途绝不交棒变异，保证动效不串台、操作可预期。
export const TODAY_DRAFT_PAGER_EDGE_RATIO = 0.22;
export const TODAY_DRAFT_PAGER_MIN_EDGE = 72;
export const TODAY_DRAFT_PAGER_EDGE = TODAY_DRAFT_PAGER_MIN_EDGE;

export function isTodayDraftPagerEdge({
    clientX,
    rect,
    edgeWidth,
    edgeRatio = TODAY_DRAFT_PAGER_EDGE_RATIO,
    minEdge = TODAY_DRAFT_PAGER_MIN_EDGE
} = {}) {
    const left = Number(rect?.left);
    const right = Number(rect?.right);
    const x = Number(clientX);
    if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(x)) return false;
    if (right <= left) return false;
    if (x < left || x > right) return false;

    const rowWidth = right - left;
    const targetEdge = Number.isFinite(edgeWidth) && edgeWidth > 0
        ? Number(edgeWidth)
        : Math.max(Number(minEdge) || 0, rowWidth * (Number(edgeRatio) || 0));

    // 比两倍热区还窄的极端小宽度行无法容纳中间操作区，整行归翻页
    if (rowWidth <= targetEdge * 2) {
        return true;
    }

    // 保证中间至少保留 30% 宽度给「点正文进编辑」
    const maxBand = rowWidth * 0.35;
    const band = Math.min(maxBand, Math.max(0, targetEdge));
    return x - left <= band || right - x <= band;
}
