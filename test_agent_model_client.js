const assert = require('assert');
const {
    AgentModelError,
    createAgentModelClient,
    normalizeAssistantMessage,
    toOpenAITools
} = require('./scripts/agent/agent-model-client');

function response(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => body
    };
}

async function run() {
    const disabled = createAgentModelClient({ enabled: false });
    assert.strictEqual(disabled.getStatus().reason, 'disabled');
    await assert.rejects(
        () => disabled.runTurn({ messages: [{ role: 'user', content: 'x' }] }),
        error => error instanceof AgentModelError && error.code === 'agent_not_configured'
    );

    let request = null;
    const client = createAgentModelClient({
        enabled: true,
        baseUrl: 'https://agent.example/v1/',
        apiKey: 'agent-secret',
        model: 'agent-model',
        fetchImpl: async (url, options) => {
            request = { url, options };
            return response({
                model: 'agent-model',
                choices: [{
                    message: {
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: { name: 'build_recall_candidates', arguments: '{}' }
                        }]
                    }
                }],
                usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
            });
        }
    });
    const result = await client.runTurn({
        messages: [{ role: 'user', content: '帮我找回相关内容' }],
        tools: [{
            name: 'build_recall_candidates',
            description: 'test',
            parameters: { type: 'object', properties: {}, additionalProperties: false }
        }]
    });
    assert.strictEqual(request.url, 'https://agent.example/v1/chat/completions');
    assert.strictEqual(request.options.headers.Authorization, 'Bearer agent-secret');
    const payload = JSON.parse(request.options.body);
    assert.strictEqual(payload.model, 'agent-model');
    assert.strictEqual(payload.tools[0].function.name, 'build_recall_candidates');
    assert.strictEqual(result.toolCalls[0].name, 'build_recall_candidates');
    assert.strictEqual(result.usage.totalTokens, 6);

    assert.throws(
        () => normalizeAssistantMessage({ tool_calls: [{ id: 'x', function: { name: 'x', arguments: '{bad' } }] }),
        error => error.code === 'agent_invalid_tool_arguments'
    );
    assert.deepStrictEqual(toOpenAITools([{ name: 'x', description: 'x', strict: true, parameters: { type: 'object' } }]), [{
        type: 'function', function: { name: 'x', description: 'x', strict: true, parameters: { type: 'object' } }
    }]);

    const failed = createAgentModelClient({
        enabled: true,
        baseUrl: 'https://agent.example/v1',
        apiKey: 'agent-secret',
        model: 'agent-model',
        fetchImpl: async () => response({ error: { message: 'slow down' } }, { ok: false, status: 429 })
    });
    await assert.rejects(
        () => failed.runTurn({ messages: [{ role: 'user', content: 'x' }] }),
        error => error.code === 'agent_rate_limited' && error.retryable === true
    );

    console.log('Agent model client checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
