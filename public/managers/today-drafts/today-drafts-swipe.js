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
