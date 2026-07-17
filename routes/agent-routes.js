const { openAgentEventStream } = require('../scripts/agent/agent-event-stream');
const { AgentRunError, toPublicRun } = require('../scripts/agent/agent-run-service');

function localActorFromRequest(_req) {
    // The global /api PIN middleware has already authenticated this request.
    // Keep an explicit actor/scope boundary so multi-user authorization can be
    // introduced later without changing the runtime/tool interfaces.
    return { actorId: 'local-owner', objectScope: 'local-all' };
}

function idempotencyKeyFrom(value) {
    const key = String(value || '').trim();
    if (key.length < 8 || key.length > 256) {
        throw new AgentRunError('idempotencyKey 必须为 8 到 256 个字符', {
            code: 'agent_invalid_idempotency_key',
            status: 400
        });
    }
    return key;
}

function runIdFrom(value) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
        throw new AgentRunError('AI 运行 ID 不合法', { code: 'agent_invalid_run_id', status: 400 });
    }
    return id;
}

function sendAgentError(res, error) {
    const status = Number(error?.status);
    const known = error instanceof AgentRunError;
    const code = String(error?.code || 'agent_internal_error');
    const mappedStatus = Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : code === 'not_found' || code === 'agent_source_not_found'
            ? 404
            : code === 'forbidden' || code === 'agent_forbidden'
                ? 403
                : code === 'agent_not_configured'
                    ? 503
                    : 500;
    const message = known
        ? error.message
        : mappedStatus >= 500
            ? 'AI 服务暂时不可用'
            : (error?.message || 'AI 请求失败');
    res.status(mappedStatus).json({
        error: message,
        code,
        retryable: error?.retryable === true
    });
}

function registerAgentRoutes(app, { agentRunService, actorResolver = localActorFromRequest } = {}) {
    if (!agentRunService) throw new Error('registerAgentRoutes requires agentRunService');

    const publicRun = run => (typeof agentRunService.toPublicRun === 'function'
        ? agentRunService.toPublicRun(run)
        : toPublicRun(run));
    const actorFor = req => actorResolver(req);

    app.get('/api/agent/capability', (req, res) => {
        const status = typeof agentRunService.getCapability === 'function'
            ? agentRunService.getCapability()
            : { enabled: false, ready: false, reason: 'unavailable', model: null };
        res.json({
            enabled: status?.enabled === true,
            ready: status?.ready === true,
            reason: status?.reason || null,
            model: status?.ready === true ? (status.model || null) : null
        });
    });

    app.post('/api/agent/runs', async (req, res) => {
        try {
            const workflowId = String(req.body?.workflowId || '').trim();
            const source = req.body?.source && typeof req.body.source === 'object' ? req.body.source : {};
            const result = await agentRunService.createRun({
                actor: actorFor(req),
                workflowId,
                source: {
                    kind: String(source.kind || '').trim(),
                    id: String(source.id || '').trim()
                },
                idempotencyKey: idempotencyKeyFrom(req.body?.idempotencyKey)
            });
            res.status(result.reused ? 200 : 202).json({
                runId: result.run.id,
                status: result.run.status,
                reused: result.reused === true,
                run: publicRun(result.run)
            });
        } catch (error) {
            sendAgentError(res, error);
        }
    });

    app.get('/api/agent/runs/:runId', async (req, res) => {
        try {
            const run = await agentRunService.getRun({ actor: actorFor(req), runId: runIdFrom(req.params.runId) });
            res.json({ run: publicRun(run) });
        } catch (error) {
            sendAgentError(res, error);
        }
    });

    app.get('/api/agent/runs/:runId/events', async (req, res) => {
        try {
            const runId = runIdFrom(req.params.runId);
            const actor = actorFor(req);
            // Authorize before sending the 200 SSE headers; otherwise the
            // client cannot distinguish a missing/forbidden run from a stream
            // that merely ended early.
            await agentRunService.getRun({ actor, runId });
            openAgentEventStream({ req, res, runService: agentRunService, actor, runId });
        } catch (error) {
            sendAgentError(res, error);
        }
    });

    app.post('/api/agent/runs/:runId/cancel', async (req, res) => {
        try {
            const run = await agentRunService.cancelRun({ actor: actorFor(req), runId: runIdFrom(req.params.runId) });
            res.json({ run: publicRun(run) });
        } catch (error) {
            sendAgentError(res, error);
        }
    });
}

module.exports = {
    idempotencyKeyFrom,
    localActorFromRequest,
    registerAgentRoutes,
    runIdFrom,
    sendAgentError
};
