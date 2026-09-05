const { endpoint } = require('../ai-provider');

const DEFAULT_TIMEOUT_MS = 45000;

class AgentModelError extends Error {
    constructor(message, { code = 'agent_model_error', retryable = true } = {}) {
        super(message);
        this.name = 'AgentModelError';
        this.code = code;
        this.retryable = retryable;
    }
}

function asPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function trimTrailingSlash(value = '') {
    return String(value || '').replace(/\/+$/, '');
}

function normalizeToolCall(raw = {}) {
    const name = String(raw?.function?.name || raw?.name || '').trim();
    const callId = String(raw?.id || '').trim();
    let argumentsValue = raw?.function?.arguments ?? raw?.arguments ?? {};
    if (typeof argumentsValue === 'string') {
        try {
            argumentsValue = argumentsValue.trim() ? JSON.parse(argumentsValue) : {};
        } catch {
            throw new AgentModelError('Agent model returned invalid tool arguments', {
                code: 'agent_invalid_tool_arguments',
                retryable: false
            });
        }
    }
    if (!name || !callId || !argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== 'object') {
        throw new AgentModelError('Agent model returned an invalid tool call', {
            code: 'agent_invalid_tool_call',
            retryable: false
        });
    }
    return { id: callId, name, arguments: argumentsValue };
}

function normalizeAssistantMessage(message = {}) {
    const toolCalls = Array.isArray(message?.tool_calls)
        ? message.tool_calls.map(normalizeToolCall)
        : [];
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!content && toolCalls.length === 0) {
        throw new AgentModelError('Agent model returned an empty response', {
            code: 'agent_empty_response',
            retryable: true
        });
    }
    return { content, toolCalls };
}

function toOpenAITools(tools = []) {
    return (Array.isArray(tools) ? tools : []).map(tool => ({
        type: 'function',
        function: {
            name: String(tool.name || ''),
            description: String(tool.description || ''),
            parameters: tool.parameters && typeof tool.parameters === 'object'
                ? tool.parameters
                : { type: 'object', properties: {}, additionalProperties: false },
            ...(tool.strict === true ? { strict: true } : {})
        }
    })).filter(item => item.function.name);
}

function createAgentModelClient(options = {}) {
    const enabledValue = options.enabled ?? process.env.AI_AGENT_ENABLED ?? '';
    const enabled = options.enabled === true || String(enabledValue).toLowerCase() === 'true';
    const baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.AI_AGENT_BASE_URL ?? '');
    const apiKey = String(options.apiKey ?? process.env.AI_AGENT_API_KEY ?? '').trim();
    const model = String(options.model ?? process.env.AI_AGENT_MODEL ?? '').trim();
    const timeoutMs = asPositiveInteger(options.timeoutMs ?? process.env.AI_AGENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
        min: 1000,
        max: 180000
    });
    const fetchImpl = options.fetchImpl || globalThis.fetch;

    function getStatus() {
        if (!enabled) return { enabled: false, ready: false, reason: 'disabled', model: null };
        if (!baseUrl) return { enabled: true, ready: false, reason: 'base_url_missing', model: null };
        if (!apiKey) return { enabled: true, ready: false, reason: 'api_key_missing', model: null };
        if (!model) return { enabled: true, ready: false, reason: 'model_missing', model: null };
        if (typeof fetchImpl !== 'function') return { enabled: true, ready: false, reason: 'fetch_unavailable', model };
        return { enabled: true, ready: true, reason: null, model };
    }

    function assertReady() {
        const status = getStatus();
        if (status.ready) return status;
        throw new AgentModelError('AI Agent is not configured', {
            code: 'agent_not_configured',
            retryable: false
        });
    }

    async function runTurn({ messages, tools = [], signal } = {}) {
        const status = assertReady();
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new AgentModelError('Agent messages are required', {
                code: 'agent_invalid_request',
                retryable: false
            });
        }

        const timeoutController = new AbortController();
        const abortFromCaller = () => timeoutController.abort(signal?.reason || new Error('Agent request cancelled'));
        if (signal?.aborted) abortFromCaller();
        else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
        const timer = setTimeout(() => timeoutController.abort(new Error('Agent request timed out')), timeoutMs);

        try {
            const response = await fetchImpl(endpoint(baseUrl, '/chat/completions'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: status.model,
                    messages,
                    tools: toOpenAITools(tools),
                    tool_choice: tools.length ? 'auto' : 'none',
                    temperature: 0.2,
                    stream: false
                }),
                signal: timeoutController.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const detail = String(payload?.error?.message || '').trim();
                throw new AgentModelError(
                    detail ? `Agent model request failed: ${detail}` : `Agent model request failed with status ${response.status}`,
                    {
                        code: response.status === 429 ? 'agent_rate_limited' : 'agent_model_request_failed',
                        retryable: response.status === 429 || response.status >= 500
                    }
                );
            }
            const message = payload?.choices?.[0]?.message;
            const normalized = normalizeAssistantMessage(message);
            return {
                ...normalized,
                model: payload?.model || status.model,
                usage: {
                    promptTokens: Number(payload?.usage?.prompt_tokens || 0) || 0,
                    completionTokens: Number(payload?.usage?.completion_tokens || 0) || 0,
                    totalTokens: Number(payload?.usage?.total_tokens || 0) || 0
                }
            };
        } catch (error) {
            if (error instanceof AgentModelError) throw error;
            if (timeoutController.signal.aborted) {
                const isCallerAbort = Boolean(signal?.aborted);
                throw new AgentModelError(isCallerAbort ? 'Agent request cancelled' : 'Agent request timed out', {
                    code: isCallerAbort ? 'agent_cancelled' : 'agent_timeout',
                    retryable: !isCallerAbort
                });
            }
            throw new AgentModelError(error?.message || 'Agent model request failed', {
                code: 'agent_model_network_error',
                retryable: true
            });
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', abortFromCaller);
        }
    }

    return {
        getStatus,
        isReady: () => getStatus().ready,
        runTurn
    };
}

module.exports = {
    AgentModelError,
    createAgentModelClient,
    normalizeAssistantMessage,
    normalizeToolCall,
    toOpenAITools
};
