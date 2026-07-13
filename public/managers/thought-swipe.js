export function getThoughtSwipeState(distance, threshold, maxSwipe) {
    const safeThreshold = Math.max(1, Number(threshold) || 1);
    const safeMaxSwipe = Math.max(safeThreshold, Number(maxSwipe) || safeThreshold);
    const swipeX = Math.min(safeMaxSwipe, Math.max(0, Number(distance) || 0));
    const progress = Math.min(1, swipeX / safeThreshold);

    return {
        swipeX,
        progress,
        ready: swipeX >= safeThreshold,
        actionOpacity: Math.min(1, Math.max(0, (progress - 0.12) / 0.6))
    };
}
