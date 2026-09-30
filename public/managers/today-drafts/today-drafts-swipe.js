// 纸边翻页热区：行内两端各这么多像素起笔算「翻整页」，中间留给行操作
// （右滑删除 / 左滑转 Thought）。这是「起手就翻页」的快速通道；从行中间起笔的
// 长横扫另有中途交棒，见下面的 TODAY_DRAFT_FLIP_HANDOFF_RATIO。
export const TODAY_DRAFT_PAGER_EDGE = 32;

export function isTodayDraftPagerEdge({ clientX, rect, edgeWidth = TODAY_DRAFT_PAGER_EDGE } = {}) {
    const width = Math.max(0, Number(edgeWidth) || 0);
    const left = Number(rect?.left);
    const right = Number(rect?.right);
    const x = Number(clientX);
    if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(x)) return false;
    if (right <= left) return false;
    if (x < left || x > right) return false;
    // 比行本身还宽的热区没有意义：整行都会变成翻页区，行操作就没有落点了。
    const band = Math.min(width, (right - left) / 2);
    return x - left <= band || right - x <= band;
}

// 行短滑与整页翻的判落行程本来就是重叠的（行在 28% 行宽判落、翻页在 25% 纸宽判落），
// 光靠起笔点分不开。交接线画在行的动作行程之外：横扫过这个比例的纸宽就是「想翻整页」，
// 整条手势交给翻页、行的动作条当场撤销——想翻页的人甩得远，误删因此不会发生。
export const TODAY_DRAFT_FLIP_HANDOFF_RATIO = 0.45;

export function isTodayDraftFlipHandoff({ deltaX, width, ratio = TODAY_DRAFT_FLIP_HANDOFF_RATIO } = {}) {
    const safeWidth = Number(width) || 0;
    const safeRatio = Math.min(1, Math.max(0, Number(ratio) || 0));
    if (safeWidth <= 0 || safeRatio <= 0) return false;
    return Math.abs(Number(deltaX) || 0) >= safeWidth * safeRatio;
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
