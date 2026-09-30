// 触摸区域按起笔划分：
// 草稿中间位置（约占中央 56% 宽度的正文区）起笔触发草稿行操作（左滑转 Thought / 右滑删除）；
// 纸张两侧边缘（两端各占约 22% 宽度，或至少 72px 宽的舒适大拇指翻页区）起笔触发整页翻页。
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

    // 保证中间至少保留 30% 宽度给草稿行操作
    const maxBand = rowWidth * 0.35;
    const band = Math.min(maxBand, Math.max(0, targetEdge));
    return x - left <= band || right - x <= band;
}

export function getTodayDraftSwipeState(distance, threshold, maxSwipe) {
    const safeThreshold = Math.max(1, Number(threshold) || 1);
    const safeMaxSwipe = Math.max(safeThreshold, Number(maxSwipe) || safeThreshold);
    const rawDistance = Number(distance) || 0;
    const swipeX = Math.min(safeMaxSwipe, Math.max(-safeMaxSwipe, rawDistance));
    const progress = Math.min(1, Math.abs(swipeX) / safeThreshold);

    return {
        swipeX,
        progress,
        ready: progress >= 1,
        direction: swipeX < 0 ? 'thought' : swipeX > 0 ? 'delete' : null,
        actionOpacity: Math.min(1, Math.max(0, (progress - 0.12) / 0.6))
    };
}
