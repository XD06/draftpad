const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadState() {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'thought-agent-state.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { applyAgentEvent, applyAgentRunSnapshot, createThoughtAgentState, isAgentRunActive, isAgentRunTerminal, normalizeAgentError };\n';
    const context = { module: { exports: {} }, exports: {}, Set, Number, String, Date, Object, Array, Math };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function loadController(state) {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'thought-agent-controller.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace("import AgentApiClient, { unwrapAgentRun } from './agent-api-client.js';", 'const { default: AgentApiClient, unwrapAgentRun } = deps.api;')
        .replace(/import \{[\s\S]*?\} from '\.\/thought-agent-state\.js';/, 'const { applyAgentEvent, applyAgentRunSnapshot, createThoughtAgentState, isAgentRunActive, isAgentRunTerminal, normalizeAgentError } = deps.state;')
        .replace('export class ThoughtAgentController', 'class ThoughtAgentController')
        .replace('export { createIdempotencyKey, parseStreamEvent };', '')
        + '\nmodule.exports = { ThoughtAgentController, parseStreamEvent };\n';
    const context = {
        module: { exports: {} }, exports: {}, deps: { api: { default: class {}, unwrapAgentRun: response => response?.run || response }, state },
        globalThis: { crypto: { randomUUID: () => 'test-id' } }, Set, Map, Number, String, Date, Object, Array, Math,
        setTimeout, clearTimeout, Promise
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

class FakeEventSource {
    static CLOSED = 2;
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.listeners = new Map();
        FakeEventSource.instances.push(this);
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    emit(type, data, id) { this.listeners.get(type)?.({ type, data: JSON.stringify(data), lastEventId: String(id) }); }
    close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
}

async function run() {
    const calls = [];
    const apiClient = {
        async createRun(payload) {
            calls.push(['create', payload]);
            return { runId: 'run-1', status: 'queued' };
        },
        async getRun() {
            calls.push(['get']);
            return { run: { id: 'run-1', status: 'running' } };
        },
        async cancelRun() {
            calls.push(['cancel']);
            return { run: { id: 'run-1', status: 'cancelled' } };
        },
        getEventsUrl(runId, lastEventId) { return `/events/${runId}?lastEventId=${lastEventId}`; }
    };
    const updates = [];
    const { ThoughtAgentController } = loadController(loadState());
    const controller = new ThoughtAgentController({
        apiClient,
        EventSourceImpl: FakeEventSource,
        createIdempotencyKey: () => 'idem-1',
        onStateChange: (_id, state) => updates.push(state)
    });

    await controller.start({ id: 'thought-1', version: 4 });
    assert.strictEqual(JSON.stringify(calls[0][1]), JSON.stringify({
        workflowId: 'recall_context',
        source: { kind: 'thought', id: 'thought-1' },
        idempotencyKey: 'idem-1'
    }));
    const stream = FakeEventSource.instances[0];
    assert(stream.url.includes('lastEventId=0'));
    stream.emit('run.started', { runId: 'run-1' }, 1);
    stream.emit('text.delta', { text: '安全输出' }, 2);
    stream.emit('run.completed', { result: { text: '最终输出', citations: [] } }, 3);
    const state = controller.getState('thought-1');
    assert.strictEqual(state.status, 'completed');
    assert.strictEqual(state.text, '最终输出');
    assert.strictEqual(stream.closed, true, 'terminal state should close the SSE connection');
    await controller.cancel('thought-1');
    assert.strictEqual(calls.filter(call => call[0] === 'cancel').length, 0, 'terminal runs must not issue cancel requests');
    assert(updates.length >= 4, 'controller should publish state transitions independent of DOM rendering');
    console.log('Thought agent controller checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
