const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function loadModule() {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'editor-performance.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { createEditorPerformanceMonitor, isEditorPerformanceEnabled, percentile };\n';
    const context = { module: { exports: {} }, exports: {}, URLSearchParams };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

(() => {
    const { createEditorPerformanceMonitor, isEditorPerformanceEnabled, percentile } = loadModule();

    assert(isEditorPerformanceEnabled('?debugPerformance=1') === true, 'the explicit query flag should enable editor measurements');
    assert(isEditorPerformanceEnabled('?debugPerformance=0') === false, 'normal navigation should leave editor measurements disabled');
    assert(percentile([100, 50], 0.5) === 50 && percentile([100, 50], 0.95) === 100, 'summary percentiles should be deterministic');
    assert(percentile([null, undefined]) === null, 'missing first-content samples must not become zero');

    let disabledClockReads = 0;
    const disabled = createEditorPerformanceMonitor({
        enabled: false,
        now: () => { disabledClockReads += 1; return 1; }
    });
    assert(disabled.measure('editor_set_value_ms', () => 'result') === 'result', 'disabled measurement must preserve callback results');
    disabled.beginSwitch();
    disabled.markFirstContent();
    disabled.finishSwitch();
    assert(disabledClockReads === 0 && disabled.summary().samples === 0, 'disabled measurement must add no timing work or samples');

    let clock = 0;
    const timers = [];
    const monitor = createEditorPerformanceMonitor({
        enabled: true,
        now: () => clock,
        maxSamples: 3,
        setTimeoutFn: (callback, delay) => {
            const timer = { callback, delay, cancelled: false };
            timers.push(timer);
            return timer;
        },
        clearTimeoutFn: timer => { if (timer) timer.cancelled = true; }
    });
    const tokenA = monitor.beginSwitch();
    clock = 10;
    monitor.count('serialize_wysiwyg', 2, tokenA);
    const measured = monitor.measure('editor_set_value_ms', () => {
        clock = 40;
        return 'set';
    }, tokenA);
    assert(measured === 'set', 'measurement must preserve the instrumented callback result');
    clock = 50;
    monitor.markFirstContent(tokenA);
    monitor.recordLongTask(60, { token: tokenA, startTime: 50 });
    monitor.scheduleFinish(tokenA, 260);
    const tokenB = monitor.beginSwitch();
    assert(timers[0].cancelled === true, 'beginSwitch must cancel the previous trace finish timer');
    clock = 70;
    monitor.markFirstContent(tokenA);
    assert(monitor.finishSwitch(tokenA) === null, 'a stale token must not finish the active trace');
    monitor.recordLongTask(10, { token: tokenA, startTime: 60 });
    assert(monitor.summary().samples === 0, 'stale token work must not pollute a newer trace');

    clock = 100;
    monitor.markFirstContent(tokenB);
    monitor.count('serialize_wysiwyg', 0, tokenB);
    const tokenBTimer = monitor.scheduleFinish(tokenB, 260);
    assert(tokenBTimer === true, 'active trace should schedule a stable completion');
    const finishTimer = timers.find(timer => !timer.cancelled && timer.callback);
    finishTimer.callback();
    const first = monitor.summary();
    assert(first.samples === 1 && first.metrics.first_content_ms.p50 === 50, 'the active trace should record first-content latency');
    assert(first.metrics.switch_stable_after_retry_ms.p50 === 50, 'stable completion metric should use the explicit renamed field');

    clock = 200;
    const tokenC = monitor.beginSwitch();
    monitor.count('serialize_wysiwyg', 0, tokenC);
    monitor.finishSwitch(tokenC);
    let summary = monitor.summary();
    assert(summary.samples === 2, 'summary should include completed switch samples');
    assert(summary.countMetrics.serialize_wysiwyg.p50 === 0, 'per-switch count metrics should include zero-operation samples');

    clock = 300;
    const tokenD = monitor.beginSwitch();
    monitor.finishSwitch(tokenD);
    summary = monitor.summary();
    assert(summary.samples === 3, 'the monitor should cap retained traces without retaining article data indefinitely');
    const collectKeys = value => value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)])
        : [];
    const forbiddenKeys = new Set(['notepadId', 'articleId', 'title', 'text', 'markdown']);
    assert(!collectKeys(summary).some(key => forbiddenKeys.has(key)), 'performance output must not contain article identity or content fields');

    monitor.reset();
    assert(monitor.summary().samples === 0 && monitor.summary().cancelledSwitches === 0, 'reset must clear traces and pending state');

    console.log('Editor performance monitor checks passed');
})();
