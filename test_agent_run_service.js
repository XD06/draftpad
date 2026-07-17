const assert = require('assert');
const {
    createSourceRef,
    createAgentRun,
    assertValidAgentRun,
    assertValidTerminalAgentRun,
    isTerminalAgentRunStatus
} = require('./scripts/agent/agent-contracts');
const { createAgentRunService } = require('./scripts/agent/agent-run-service');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function sourceRef({ kind = 'thought', id, version = 1, text, start = 0 }) {
    return createSourceRef({
        kind,
        id,
        version,
        label: id,
        location: { start, end: start + String(text).length },
        excerpt: text
    });
}

function fakeStorage() {
    const runs = new Map();
    return {
        runs,
        async saveAgentRun(run) {
            const normalized = isTerminalAgentRunStatus(run.status)
                ? assertValidTerminalAgentRun(run)
                : assertValidAgentRun(run);
            runs.set(normalized.id, clone(normalized));
            return clone(normalized);
        },
        async readAgentRun(id) {
            return runs.has(id) ? clone(runs.get(id)) : null;
        },
        async listActiveAgentRuns() {
            return [...runs.values()].filter(run => !isTerminalAgentRunStatus(run.status)).map(clone);
        },
        async listNonterminalAgentRuns() {
            return [...runs.values()].filter(run => !isTerminalAgentRunStatus(run.status)).map(clone);
        }
    };
}

async function waitFor(check, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for AgentRun');
}

async function run() {
    const primary = sourceRef({ id: 'thought-current', text: '整理 AI 设计方案' });
    const candidate = sourceRef({ id: 'thought-related', text: '过去的关联设计' });
    const excerpt = sourceRef({ id: 'thought-related', text: '过去的关联设计细节', start: 0 });
    const storage = fakeStorage();
    const contextService = {
        async snapshotThought({ thoughtId }) {
            if (thoughtId !== primary.id) throw new Error('not found');
            return {
                sourceRef: primary,
                signature: { version: 1, hash: 'a'.repeat(64) },
                excerpt: '整理 AI 设计方案'
            };
        }
    };
    const toolRegistry = {
        getDefinitions() {
            return [
                { name: 'build_recall_candidates', description: 'x', parameters: { type: 'object' } },
                { name: 'get_thought_excerpt', description: 'x', parameters: { type: 'object' } }
            ];
        },
        async execute({ run, name }) {
            if (name === 'build_recall_candidates') {
                run.allowedReadSet = [primary, candidate];
                return {
                    data: { candidates: [{ id: candidate.id, title: candidate.label }] },
                    sourceRefs: [candidate],
                    allowedReadSet: run.allowedReadSet
                };
            }
            if (name === 'get_thought_excerpt') {
                run.allowedReadSet = [primary, candidate, excerpt];
                return { data: { excerpt: '过去的关联设计细节' }, sourceRefs: [excerpt], allowedReadSet: run.allowedReadSet };
            }
            throw new Error(`unexpected tool ${name}`);
        }
    };
    const workflowRegistry = { get: () => ({ id: 'recall_context', readOnly: true }) };
    let turn = 0;
    const toolsByTurn = [];
    const modelClient = {
        getStatus: () => ({ enabled: true, ready: true, model: 'fake-agent' }),
        async runTurn({ tools = [] } = {}) {
            turn += 1;
            toolsByTurn.push(tools.map(tool => tool.name));
            if (turn === 1) return {
                content: '',
                toolCalls: [{ id: 'call-1', name: 'build_recall_candidates', arguments: {} }],
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
            };
            if (turn === 2) return {
                content: '',
                toolCalls: [{ id: 'call-2', name: 'get_thought_excerpt', arguments: { id: candidate.id } }],
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
            };
            if (tools.length > 0) return {
                content: '',
                toolCalls: [{ id: 'call-3', name: 'get_thought_excerpt', arguments: { id: candidate.id } }],
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
            };
            return {
                content: JSON.stringify({
                    summary: '找到了早期关联设计。',
                    claims: [{ text: '这条旧 Thought 包含关联设计细节。', citationIds: ['src_2'] }],
                    citations: [{ citationId: 'src_2' }]
                }),
                toolCalls: [],
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
            };
        }
    };
    const service = createAgentRunService({
        storage,
        contextService,
        toolRegistry,
        workflowRegistry,
        modelClient,
        timeoutMs: 1000,
        now: (() => { let tick = 1000; return () => ++tick; })()
    });
    const actor = { actorId: 'local-owner', objectScope: 'local-all' };
    const created = await service.createRun({
        actor,
        workflowId: 'recall_context',
        source: { kind: 'thought', id: primary.id },
        idempotencyKey: 'client-key-1'
    });
    assert.strictEqual(created.reused, false);
    const [reused, concurrentReuse] = await Promise.all([0, 1].map(() => service.createRun({
        actor,
        workflowId: 'recall_context',
        source: { kind: 'thought', id: primary.id },
        idempotencyKey: 'client-key-1'
    })));
    assert.strictEqual(reused.reused, true, 'active idempotency key should reuse its run');
    assert.strictEqual(concurrentReuse.reused, true, 'concurrent same-key creation should also reuse its run');
    assert.strictEqual(reused.run.id, created.run.id);
    assert.strictEqual(concurrentReuse.run.id, created.run.id);

    const events = [];
    const unsubscribe = await service.subscribe({ actor, runId: created.run.id, onEvent: event => events.push(event) });
    const completed = await waitFor(async () => {
        const item = await service.getRun({ actor, runId: created.run.id });
        return item.status === 'completed' ? item : null;
    });
    unsubscribe();
    assert.strictEqual(completed.result.claims[0].citationIds[0], 'src_2');
    assert.strictEqual(completed.result.citations[0].sourceRef.id, candidate.id);
    assert.strictEqual(completed.sourceStale, false);
    assert(events.some(event => event.type === 'retrieval.completed'));
    assert(events.some(event => event.type === 'run.completed'));
    assert(events.every(event => !JSON.stringify(event).includes('client-key-1')), 'events must not leak raw idempotency key');
    assert.deepStrictEqual(toolsByTurn, [
        ['build_recall_candidates', 'get_thought_excerpt'],
        ['build_recall_candidates', 'get_thought_excerpt'],
        []
    ], 'the last allowed turn must disable tools so a provider that keeps requesting tools can return its final structured result');

    const missingModel = createAgentRunService({
        storage: fakeStorage(),
        contextService,
        toolRegistry,
        workflowRegistry,
        modelClient: { getStatus: () => ({ enabled: false, ready: false }) }
    });
    await assert.rejects(
        () => missingModel.createRun({ actor, workflowId: 'recall_context', source: { kind: 'thought', id: primary.id }, idempotencyKey: 'x' }),
        error => error.code === 'agent_not_configured' && error.status === 503
    );

    let cancellationStarted = false;
    const cancellable = createAgentRunService({
        storage: fakeStorage(),
        contextService,
        toolRegistry,
        workflowRegistry,
        modelClient: {
            getStatus: () => ({ enabled: true, ready: true, model: 'fake-agent' }),
            runTurn({ signal }) {
                cancellationStarted = true;
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        const error = new Error('cancelled');
                        error.code = 'agent_cancelled';
                        reject(error);
                    }, { once: true });
                });
            }
        },
        timeoutMs: 1000
    });
    const cancellingRun = await cancellable.createRun({
        actor,
        workflowId: 'recall_context',
        source: { kind: 'thought', id: primary.id },
        idempotencyKey: 'client-key-cancel'
    });
    await waitFor(() => cancellationStarted);
    await cancellable.cancelRun({ actor, runId: cancellingRun.run.id });
    const cancelled = await waitFor(async () => {
        const item = await cancellable.getRun({ actor, runId: cancellingRun.run.id });
        return item.status === 'cancelled' ? item : null;
    });
    assert.strictEqual(cancelled.result, undefined, 'cancelled runs must not publish a result');
    assert.strictEqual(cancelled.error, undefined, 'explicit cancellation must not look like a model failure');

    const recoveryStorage = fakeStorage();
    const interrupted = createAgentRun({
        id: 'agr_interrupted',
        workflowId: 'recall_context',
        actorId: actor.actorId,
        objectScope: actor.objectScope,
        primarySource: primary,
        allowedReadSet: [primary],
        idempotencyKey: 'recovery-key',
        sourceSnapshot: { id: primary.id, version: primary.version, hash: 'a'.repeat(64) },
        now: 100
    });
    await recoveryStorage.saveAgentRun(interrupted);
    const recoveryService = createAgentRunService({
        storage: recoveryStorage,
        contextService,
        toolRegistry,
        workflowRegistry,
        modelClient
    });
    await recoveryService.init();
    const recovered = await recoveryStorage.readAgentRun(interrupted.id);
    assert.strictEqual(recovered.status, 'failed', 'server restart must not resume an in-flight AgentRun');
    assert.strictEqual(recovered.error.code, 'server_restarted');

    console.log('Agent run service checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
