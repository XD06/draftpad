export function isEditorPerformanceEnabled(search = globalThis.location?.search || '') {
    try {
        return new URLSearchParams(String(search || '')).get('debugPerformance') === '1';
    } catch {
        return false;
    }
}

export function percentile(values = [], quantile = 0.5) {
    const sorted = values
        .filter(value => value !== null && value !== undefined)
        .map(Number)
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
    if (!sorted.length) return null;
    const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, Number(quantile) || 0)) * sorted.length));
    return sorted[Math.min(sorted.length - 1, rank - 1)];
}

function metricSummary(values) {
    const clean = values
        .filter(value => value !== null && value !== undefined)
        .map(Number)
        .filter(Number.isFinite);
    if (!clean.length) return null;
    return {
        p50: percentile(clean, 0.5),
        p95: percentile(clean, 0.95),
        min: Math.min(...clean),
        max: Math.max(...clean),
        avg: clean.reduce((sum, value) => sum + value, 0) / clean.length
    };
}

export function createEditorPerformanceMonitor({
    enabled = false,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    maxSamples = 50,
    PerformanceObserverClass = globalThis.PerformanceObserver,
    setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
    onSummaryChange = null
} = {}) {
    const activeEnabled = enabled === true;
    const sampleLimit = Math.max(1, Math.min(200, Number(maxSamples) || 50));
    const traces = [];
    const pendingLongTasks = [];
    let active = null;
    let cancelledSwitches = 0;
    let observer = null;
    let finishTimer = null;
    let sequence = 0;

    const clearScheduledFinish = () => {
        if (finishTimer === null) return;
        clearTimeoutFn?.(finishTimer);
        finishTimer = null;
    };

    const activeToken = () => active?.token ?? null;
    const isActiveToken = token => activeEnabled && token !== null && token !== undefined && token === active?.token;

    const beginSwitch = () => {
        if (!activeEnabled) return null;
        clearScheduledFinish();
        if (active) cancelledSwitches += 1;
        active = {
            token: ++sequence,
            startedAt: now(),
            firstContentMs: null,
            durations: {},
            counts: {},
            longTasks: { count: 0, durationMs: 0 }
        };
        return active.token;
    };

    const measure = (name, callback, token = activeToken()) => {
        if (!isActiveToken(token)) return callback();
        const trace = active;
        const startedAt = now();
        try {
            return callback();
        } finally {
            const duration = Math.max(0, now() - startedAt);
            if (active === trace && trace.token === token) {
                trace.durations[name] = (trace.durations[name] || 0) + duration;
            }
        }
    };

    const count = (name, amount = 1, token = activeToken()) => {
        if (!isActiveToken(token)) return;
        const increment = Number(amount);
        if (!Number.isFinite(increment)) return;
        active.counts[name] = (active.counts[name] || 0) + increment;
    };

    const markFirstContent = (token = activeToken()) => {
        if (!isActiveToken(token) || active.firstContentMs !== null) return;
        active.firstContentMs = Math.max(0, now() - active.startedAt);
    };

    const assignPendingLongTasks = () => {
        if (!pendingLongTasks.length) return;
        const candidates = [
            ...traces,
            ...(active ? [active] : [])
        ];
        const remaining = [];
        pendingLongTasks.forEach(entry => {
            const matches = candidates
                .filter(trace => (
                    Number.isFinite(trace.startedAt) &&
                    entry.startTime >= trace.startedAt &&
                    (trace.finishedAt === null || entry.startTime <= trace.finishedAt)
                ))
                .sort((left, right) => right.startedAt - left.startedAt);
            const target = matches[0];
            if (!target) {
                remaining.push(entry);
                return;
            }
            target.longTasks.count += 1;
            target.longTasks.durationMs += entry.duration;
        });
        pendingLongTasks.splice(0, pendingLongTasks.length, ...remaining.slice(-100));
    };

    const recordLongTask = (duration, { token = activeToken(), startTime = now() } = {}) => {
        if (token !== null && token !== undefined && !isActiveToken(token)) return;
        const value = Number(duration);
        const startedAt = Number(startTime);
        if (!Number.isFinite(value) || value < 0 || !Number.isFinite(startedAt)) return;
        pendingLongTasks.push({ duration: value, startTime: startedAt });
        assignPendingLongTasks();
    };

    const recordLongTaskEntries = entries => {
        Array.from(entries || []).forEach(entry => {
            recordLongTask(entry?.duration, { token: null, startTime: entry?.startTime });
        });
    };

    const takePendingLongTasks = () => {
        if (!observer?.takeRecords) return;
        try {
            recordLongTaskEntries(observer.takeRecords());
        } catch {
            // PerformanceObserver implementations may not support takeRecords.
        }
    };

    const summary = () => {
        const metrics = {};
        const stable = metricSummary(traces.map(trace => trace.stableAfterRetryMs));
        if (stable) metrics.switch_stable_after_retry_ms = stable;
        const firstContent = metricSummary(traces.map(trace => trace.firstContentMs));
        if (firstContent) metrics.first_content_ms = firstContent;

        const durationNames = new Set(traces.flatMap(trace => Object.keys(trace.durations)));
        durationNames.forEach(name => {
            const values = traces.map(trace => Number.isFinite(trace.durations[name]) ? trace.durations[name] : 0);
            const metric = metricSummary(values);
            if (metric) metrics[name] = metric;
        });

        const counts = {};
        const countMetrics = {};
        const countNames = new Set(traces.flatMap(trace => Object.keys(trace.counts)));
        countNames.forEach(name => {
            const values = traces.map(trace => Number.isFinite(trace.counts[name]) ? trace.counts[name] : 0);
            counts[name] = values.reduce((sum, value) => sum + value, 0);
            countMetrics[name] = metricSummary(values);
        });

        const longTaskCountValues = traces.map(trace => trace.longTasks.count);
        const longTaskDurationValues = traces.map(trace => trace.longTasks.durationMs);
        const longTasks = {
            count: longTaskCountValues.reduce((sum, value) => sum + value, 0),
            durationMs: longTaskDurationValues.reduce((sum, value) => sum + value, 0),
            countPerSwitch: metricSummary(longTaskCountValues),
            durationPerSwitchMs: metricSummary(longTaskDurationValues)
        };

        return {
            enabled: activeEnabled,
            samples: traces.length,
            cancelledSwitches,
            metrics,
            counts,
            countMetrics,
            longTasks
        };
    };

    const publishSummary = () => {
        if (typeof onSummaryChange !== 'function') return;
        try {
            onSummaryChange(summary());
        } catch {
            // Diagnostics must never affect editor behavior.
        }
    };

    const finishSwitch = (token = activeToken()) => {
        if (!isActiveToken(token)) return null;
        clearScheduledFinish();
        takePendingLongTasks();
        if (!isActiveToken(token)) return null;
        const finishedAt = now();
        active.finishedAt = finishedAt;
        traces.push(active);
        assignPendingLongTasks();
        const finished = {
            stableAfterRetryMs: active.stableAfterRetryMs,
            firstContentMs: active.firstContentMs,
            durations: { ...active.durations },
            counts: { ...active.counts },
            longTasks: { ...active.longTasks }
        };
        if (traces.length > sampleLimit) traces.splice(0, traces.length - sampleLimit);
        active = null;
        publishSummary();
        return finished;
    };

    const scheduleFinish = (token, delay = 260) => {
        if (!isActiveToken(token) || typeof setTimeoutFn !== 'function') return false;
        clearScheduledFinish();
        const safeDelay = Math.max(0, Number(delay) || 0);
        finishTimer = setTimeoutFn(() => {
            finishTimer = null;
            finishSwitch(token);
        }, safeDelay);
        return true;
    };

    const reset = () => {
        clearScheduledFinish();
        try {
            observer?.takeRecords?.();
        } catch {
            // Discard queued entries from the reset trace.
        }
        traces.length = 0;
        pendingLongTasks.length = 0;
        active = null;
        cancelledSwitches = 0;
        publishSummary();
    };

    if (activeEnabled && typeof PerformanceObserverClass === 'function') {
        try {
            observer = new PerformanceObserverClass(list => {
                recordLongTaskEntries(list.getEntries());
            });
            observer.observe({ type: 'longtask', buffered: false });
        } catch {
            observer = null;
        }
    }

    return {
        enabled: activeEnabled,
        activeToken,
        beginSwitch,
        count,
        dispose() {
            clearScheduledFinish();
            observer?.disconnect?.();
            observer = null;
            active = null;
        },
        finishSwitch,
        isActiveToken,
        markFirstContent,
        measure,
        recordLongTask,
        reset,
        scheduleFinish,
        summary
    };
}
