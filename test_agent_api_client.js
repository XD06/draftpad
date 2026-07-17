const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadClient() {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'agent-api-client.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace('export class AgentApiError', 'class AgentApiError')
        .replace('export default class AgentApiClient', 'class AgentApiClient')
        .replace('export function unwrapAgentRun', 'function unwrapAgentRun')
        + '\nmodule.exports = { AgentApiClient, AgentApiError, unwrapAgentRun };\n';
    const context = { module: { exports: {} }, exports: {}, URLSearchParams, globalThis: {} };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body
    };
}

async function run() {
    const { AgentApiClient, AgentApiError, unwrapAgentRun } = loadClient();
    const calls = [];
    const client = new AgentApiClient({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return jsonResponse({ runId: 'run-1', status: 'queued' }, { status: 202 });
        }
    });

    await client.createRun({
        workflowId: 'recall_context',
        source: { kind: 'thought', id: 'a/b' },
        idempotencyKey: 'idem-1'
    });
    assert.strictEqual(calls[0].url, '/api/agent/runs');
    assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
        workflowId: 'recall_context',
        source: { kind: 'thought', id: 'a/b' },
        idempotencyKey: 'idem-1'
    });
    assert.strictEqual(client.getEventsUrl('a/b', 7), '/api/agent/runs/a%2Fb/events?lastEventId=7');
    assert.strictEqual(client.getEventsUrl('a/b', 0), '/api/agent/runs/a%2Fb/events');
    assert.strictEqual(unwrapAgentRun({ run: { id: 'run-1' } }).id, 'run-1');
    assert.strictEqual(unwrapAgentRun({ runId: 'run-1', status: 'queued' }).runId, 'run-1');

    const failed = new AgentApiClient({
        fetchImpl: async () => jsonResponse({ error: { code: 'agent_not_configured', message: '未配置' } }, { ok: false, status: 503 })
    });
    await assert.rejects(
        () => failed.getCapability(),
        error => error instanceof AgentApiError && error.code === 'agent_not_configured' && error.retryable === true
    );
    console.log('Agent API client checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
