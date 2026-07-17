const assert = require('assert');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = __dirname;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function waitForServer(child, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out starting DumbPad test server')), timeoutMs);
        const onData = chunk => {
            if (String(chunk).includes('Server is running on port')) {
                clearTimeout(timer);
                child.stdout.off('data', onData);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        child.once('exit', code => {
            clearTimeout(timer);
            reject(new Error(`DumbPad test server exited early (${code})`));
        });
    });
}

async function waitForRun(baseUrl, headers, runId) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/api/agent/runs/${encodeURIComponent(runId)}`, { headers });
        assert.strictEqual(response.status, 200);
        const body = await response.json();
        if (['completed', 'failed', 'cancelled'].includes(body.run.status)) return body.run;
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Timed out waiting for AgentRun terminal state');
}

async function run() {
    let modelTurn = 0;
    let relatedThoughtId = '';
    const provider = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        assert.strictEqual(req.url, '/v1/chat/completions');
        assert.strictEqual(body.model, 'test-agent-model');
        assert.strictEqual(req.headers.authorization, 'Bearer test-agent-key');
        modelTurn += 1;
        const message = modelTurn === 1
            ? {
                content: '',
                tool_calls: [{
                    id: 'call_candidates',
                    type: 'function',
                    function: { name: 'build_recall_candidates', arguments: '{}' }
                }]
            }
            : modelTurn === 2
                ? {
                    content: '',
                    tool_calls: [{
                        id: 'call_excerpt',
                        type: 'function',
                        function: { name: 'get_thought_excerpt', arguments: JSON.stringify({ id: relatedThoughtId }) }
                    }]
                }
                : {
                content: JSON.stringify({
                    summary: '找到了可回看的旧方案。',
                    claims: [{ text: '旧 Thought 记录了同一主题的实现取舍。', citationIds: ['src_2'] }],
                    citations: [{ citationId: 'src_2' }]
                })
            };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            model: 'test-agent-model',
            choices: [{ message }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        }));
    });
    const providerPort = await listen(provider);
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dumbpad-agent-route-'));
    const appPort = 43000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(appPort),
            DATA_DIR: dataDir,
            NODE_ENV: 'test',
            DUMBPAD_PIN: '1234',
            AI_AGENT_ENABLED: 'true',
            AI_AGENT_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
            AI_AGENT_API_KEY: 'test-agent-key',
            AI_AGENT_MODEL: 'test-agent-model',
            AI_AGENT_TIMEOUT_MS: '3000',
            AI_AGENT_MAX_STEPS: '3',
            AI_AGENT_EVENT_BUFFER_LIMIT: '16',
            STORAGE_BACKEND: 'local'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const stderr = [];
    child.stderr.on('data', chunk => stderr.push(String(chunk)));

    try {
        await waitForServer(child);
        const baseUrl = `http://127.0.0.1:${appPort}`;
        const headers = { Authorization: 'Bearer 1234', 'Content-Type': 'application/json' };
        const createdThoughtResponse = await fetch(`${baseUrl}/api/thoughts`, {
            method: 'POST', headers,
            body: JSON.stringify({ text: '测试 Agent 只读找回能力' })
        });
        assert.strictEqual(createdThoughtResponse.status, 200);
        const thought = await createdThoughtResponse.json();
        const relatedThoughtResponse = await fetch(`${baseUrl}/api/thoughts`, {
            method: 'POST', headers,
            body: JSON.stringify({ text: '早期 AI 方案记录：保持上下文工具只读，并用结构化引用展示来源。'.repeat(12) })
        });
        assert.strictEqual(relatedThoughtResponse.status, 200);
        const relatedThought = await relatedThoughtResponse.json();
        relatedThoughtId = relatedThought.id;
        const relationResponse = await fetch(`${baseUrl}/api/thoughts/${encodeURIComponent(thought.id)}/relations`, {
            method: 'POST', headers,
            body: JSON.stringify({ targetId: relatedThought.id, relationType: 'same_topic' })
        });
        assert.strictEqual(relationResponse.status, 201);

        const capability = await fetch(`${baseUrl}/api/agent/capability`, { headers });
        assert.strictEqual(capability.status, 200);
        assert.strictEqual((await capability.json()).ready, true);

        const createdRunResponse = await fetch(`${baseUrl}/api/agent/runs`, {
            method: 'POST', headers,
            body: JSON.stringify({
                workflowId: 'recall_context',
                source: { kind: 'thought', id: thought.id },
                idempotencyKey: 'route-test-idempotency-key'
            })
        });
        assert.strictEqual(createdRunResponse.status, 202);
        const createdRun = await createdRunResponse.json();
        assert(createdRun.runId && createdRun.run);
        const terminal = await waitForRun(baseUrl, headers, createdRun.runId);
        assert.strictEqual(terminal.status, 'completed');
        assert.strictEqual(terminal.result.summary, '找到了可回看的旧方案。');
        assert.strictEqual(terminal.result.citations[0].sourceRef.id, relatedThought.id);
        assert.strictEqual(terminal.sourceStale, false);
        assert.strictEqual(modelTurn, 3, 'Agent should use a bounded tool loop before finalizing');

        const invalid = await fetch(`${baseUrl}/api/agent/runs`, {
            method: 'POST', headers,
            body: JSON.stringify({ workflowId: 'recall_context', source: { kind: 'thought', id: thought.id }, idempotencyKey: 'short' })
        });
        assert.strictEqual(invalid.status, 400);

        const stream = await fetch(`${baseUrl}/api/agent/runs/${encodeURIComponent(createdRun.runId)}/events`, { headers });
        assert.strictEqual(stream.status, 200);
        const reader = stream.body.getReader();
        const first = await Promise.race([
            reader.read(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out reading Agent SSE')), 2000))
        ]);
        assert(String(new TextDecoder().decode(first.value || new Uint8Array())).includes('agent stream connected'));
        await reader.cancel();
    } finally {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
        await new Promise(resolve => provider.close(resolve));
        await fs.rm(dataDir, { recursive: true, force: true });
    }
    if (stderr.length) console.warn(stderr.join(''));
    console.log('Agent routes checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
