const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadState() {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'thought-agent-state.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { applyAgentEvent, applyAgentRunSnapshot, createThoughtAgentState, isAgentRunActive, isAgentRunTerminal, isAgentSourceStale };\n';
    const context = { module: { exports: {} }, exports: {}, Set, Number, String, Date, Object, Array, Math };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const {
        applyAgentEvent,
        applyAgentRunSnapshot,
        createThoughtAgentState,
        isAgentRunActive,
        isAgentRunTerminal,
        isAgentSourceStale
    } = loadState();

    let state = createThoughtAgentState({ thoughtId: 't1' });
    state = applyAgentRunSnapshot(state, {
        id: 'run-1',
        status: 'queued',
        sourceSnapshot: { kind: 'thought', id: 't1', version: 3 }
    });
    assert.strictEqual(state.runId, 'run-1');
    assert(isAgentRunActive(state.status));

    state = applyAgentEvent(state, { id: 1, type: 'run.started', data: { runId: 'run-1' } });
    state = applyAgentEvent(state, { id: 2, type: 'text.delta', data: { text: '第一段' } });
    state = applyAgentEvent(state, { id: 2, type: 'text.delta', data: { text: '重复' } });
    assert.strictEqual(state.text, '第一段', 'duplicate SSE ids must not append output twice');
    state = applyAgentEvent(state, {
        id: 3,
        type: 'run.completed',
        data: {
            result: {
                summary: '最终结果',
                citations: [{ citationId: 'src-1', sourceRef: { kind: 'thought', id: 't2', label: '来源', version: 4 } }]
            }
        }
    });
    assert.strictEqual(state.status, 'completed');
    assert(isAgentRunTerminal(state.status));
    assert.strictEqual(state.text, '最终结果');
    assert.strictEqual(state.citations.length, 1);
    assert(isAgentSourceStale(state, { id: 't1', version: 4 }), 'changed source version should mark result stale');
    assert(!isAgentSourceStale(state, { id: 't1', version: 3 }), 'same source version should remain current');
    const deletedSource = applyAgentRunSnapshot(state, { id: 'run-1', status: 'completed', sourceStale: true });
    assert(isAgentSourceStale(deletedSource, { id: 't1', version: 3 }), 'server stale flag should cover a deleted or otherwise unreadable source');

    const reset = applyAgentEvent(state, { id: 4, type: 'run.reset', data: {} });
    assert.strictEqual(reset.needsRefresh, true, 'SSE reset should trigger a status refresh');
    console.log('Thought agent state checks passed');
}

run();
