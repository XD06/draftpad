const contracts = require('./scripts/agent/agent-contracts');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function run() {
    const sourceRef = contracts.createSourceRef({
        kind: 'thought',
        id: 'thought-source',
        version: 3,
        label: '来源 Thought',
        location: { start: 0, end: 12 },
        excerpt: '离线优先的想法'
    });

    assert(sourceRef.excerptHash === contracts.sha256('离线优先的想法'), 'sourceRef must hash the exact excerpt with sha256');
    assert(contracts.validateSourceRef(sourceRef).valid, 'created sourceRef should validate');
    assert(
        !contracts.validateSourceRef({ ...sourceRef, excerptHash: 'sha256:not-a-real-hash' }).valid,
        'sourceRef must reject malformed hashes'
    );

    const run = contracts.createAgentRun({
        id: 'agr_contract_1',
        actorId: 'local-owner',
        objectScope: 'local-all',
        primarySource: sourceRef,
        allowedReadSet: [sourceRef],
        idempotencyKey: 'client-key-never-persisted',
        sourceSnapshot: {
            id: 'thought-source',
            version: 3,
            hash: 'a'.repeat(64)
        },
        now: 100
    });

    assert(run.status === 'queued', 'new AgentRun should start queued');
    assert(!Object.hasOwn(run, 'idempotencyKey'), 'AgentRun must keep only an idempotency hash');
    assert(contracts.isSha256(run.idempotencyKeyHash), 'AgentRun should keep a sha256 idempotency hash');
    assert(contracts.validateAgentRun(run).valid, 'created AgentRun should validate');
    assert(run.sourceSnapshot.hash === 'a'.repeat(64), 'compact source snapshot should be retained without source content');
    assert(
        !contracts.validateAgentRun({
            ...run,
            sourceSnapshot: { ...run.sourceSnapshot, id: 'another-thought' }
        }).valid,
        'sourceSnapshot must bind to the primary Thought id and version'
    );
    assert(contracts.validateAgentRunTransition('queued', 'running').valid, 'queued -> running should be allowed');
    assert(contracts.validateAgentRunTransition('running', 'completed').valid, 'running -> completed should be allowed');
    assert(!contracts.validateAgentRunTransition('completed', 'running').valid, 'terminal state must not transition back to running');
    assert(contracts.isTerminalAgentRunStatus('completed'), 'completed must be terminal');
    assert(!contracts.isTerminalAgentRunStatus('cancelling'), 'cancelling must stay nonterminal');

    const validResult = {
        summary: '这条记录与当前思路都强调离线优先。',
        claims: [{
            text: '两条内容都强调离线优先。',
            citationIds: ['src_1']
        }],
        citations: [{
            citationId: 'src_1',
            sourceRef: { ...sourceRef, label: '模型不能替换的标签' }
        }]
    };
    const resultValidation = contracts.validateRecallResult(validResult, { allowedSourceRefs: [sourceRef] });
    assert(resultValidation.valid, 'structured result with an allowed citation should validate');
    assert(
        resultValidation.value.citations[0].sourceRef.label === sourceRef.label,
        'validated result must retain the server-originated citation label'
    );

    const unknownSource = contracts.createSourceRef({
        kind: 'notepad',
        id: 'notepad-other',
        version: 1,
        label: '范围外文章',
        location: { start: 0, end: 4 },
        excerpt: '范围外'
    });
    assert(
        !contracts.validateRecallResult({
            ...validResult,
            citations: [{ citationId: 'src_1', sourceRef: unknownSource }]
        }, { allowedSourceRefs: [sourceRef] }).valid,
        'result must reject citations not returned by this run'
    );
    assert(
        !contracts.validateRecallResult({
            ...validResult,
            claims: [{ text: '没有引文的断言', citationIds: [] }]
        }, { allowedSourceRefs: [sourceRef] }).valid,
        'fact claims must include at least one valid citation'
    );

    const completed = {
        ...run,
        status: 'completed',
        updatedAt: 200,
        finishedAt: 200,
        sourceStale: true,
        result: validResult
    };
    const terminal = contracts.validateTerminalAgentRun(completed);
    assert(terminal.valid, 'completed run with valid cited result should validate as terminal');
    assert(terminal.value.sourceStale === true, 'sourceStale must be retained as derived AgentRun state');
    assert(
        !contracts.validateTerminalAgentRun({
            ...completed,
            result: {
                ...validResult,
                claims: [{ text: '伪造引用', citationIds: ['missing'] }]
            }
        }).valid,
        'completed terminal run must retain safe structured result validation'
    );
    assert(
        !contracts.validateAgentRun({ ...run, idempotencyKey: 'raw-key' }).valid,
        'raw idempotency keys must never be accepted as persisted AgentRun fields'
    );

    console.log('Agent contracts checks passed');
}

try {
    run();
} catch (error) {
    console.error(error);
    process.exit(1);
}
