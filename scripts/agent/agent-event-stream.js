function normalizeEventId(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseLastEventId(value) {
    if (Array.isArray(value)) value = value[0];
    return normalizeEventId(String(value || '').trim());
}

function formatSSEEvent(event = {}) {
    const id = normalizeEventId(event.id);
    const type = String(event.type || 'message').replace(/[\r\n]/g, '');
    const payload = JSON.stringify(event.data ?? {});
    return `id: ${id}\nevent: ${type}\ndata: ${payload}\n\n`;
}

function formatSSEComment(comment = 'keep-alive') {
    return `: ${String(comment).replace(/[\r\n]/g, ' ')}\n\n`;
}

function writeSSE(res, event) {
    if (!res || res.writableEnded || res.destroyed) return false;
    res.write(formatSSEEvent(event));
    if (typeof res.flush === 'function') res.flush();
    return true;
}

function openAgentEventStream({ req, res, runService, actor, runId, heartbeatMs = 15000 } = {}) {
    if (!res || !runService || !runId) throw new Error('SSE stream requires response, run service and run id');

    res.status(200);
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write(formatSSEComment('agent stream connected'));
    res.flush?.();

    const lastEventId = parseLastEventId(req?.headers?.['last-event-id'] || req?.query?.lastEventId);
    let closeSubscription = () => {};
    let heartbeat = null;
    let closed = false;

    const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        closeSubscription();
        closeSubscription = () => {};
        if (!res.writableEnded) res.end();
    };

    Promise.resolve(runService.subscribe({ actor, runId, lastEventId, onEvent: event => writeSSE(res, event) }))
        .then(unsubscribe => {
            if (typeof unsubscribe === 'function') closeSubscription = unsubscribe;
            if (closed) closeSubscription();
        })
        .catch(error => {
            if (!closed) {
                writeSSE(res, {
                    id: 0,
                    type: 'run.failed',
                    data: { code: error?.code || 'agent_stream_error', message: '无法订阅 AI 运行状态' }
                });
                close();
            }
        });

    heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return close();
        res.write(formatSSEComment('keep-alive'));
        res.flush?.();
    }, Math.max(5000, Number(heartbeatMs) || 15000));
    heartbeat.unref?.();

    req?.on?.('close', close);
    req?.on?.('aborted', close);
    return close;
}

module.exports = {
    formatSSEComment,
    formatSSEEvent,
    normalizeEventId,
    openAgentEventStream,
    parseLastEventId,
    writeSSE
};
