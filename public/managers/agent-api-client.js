export class AgentApiError extends Error {
    constructor(message, { status = 0, body = null, code = '', retryable = false } = {}) {
        super(message);
        this.name = 'AgentApiError';
        this.status = Number(status) || 0;
        this.body = body;
        this.code = code || body?.error?.code || body?.code || '';
        this.retryable = retryable;
    }
}

function getErrorMessage(status, body) {
    const message = body?.error?.message || body?.message || body?.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
    return status ? `HTTP ${status}` : 'AI 请求失败';
}

function readJson(response) {
    const contentType = response?.headers?.get?.('content-type') || '';
    if (!contentType.includes('application/json')) return Promise.resolve(null);
    return response.json().catch(() => null);
}

function normalizeLastEventId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export default class AgentApiClient {
    constructor({ baseUrl = '/api/agent', fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
        this.baseUrl = String(baseUrl || '/api/agent').replace(/\/+$/, '');
        this.fetchImpl = fetchImpl;
    }

    runUrl(runId, suffix = '') {
        return `${this.baseUrl}/runs/${encodeURIComponent(String(runId || ''))}${suffix}`;
    }

    async request(url, options = {}) {
        if (typeof this.fetchImpl !== 'function') {
            throw new AgentApiError('当前环境不支持 AI 请求', { code: 'fetch_unavailable' });
        }

        let response;
        try {
            response = await this.fetchImpl(url, {
                ...options,
                headers: {
                    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(options.headers || {})
                }
            });
        } catch (error) {
            throw new AgentApiError(error?.message || '网络连接失败', {
                code: 'agent_network_error',
                retryable: true
            });
        }

        const body = await readJson(response);
        if (!response?.ok) {
            const status = Number(response?.status) || 0;
            throw new AgentApiError(getErrorMessage(status, body), {
                status,
                body,
                code: body?.error?.code || body?.code || '',
                retryable: status === 0 || status === 408 || status === 429 || status >= 500
            });
        }
        return body;
    }

    getCapability() {
        return this.request(`${this.baseUrl}/capability`);
    }

    createRun({ workflowId = 'recall_context', source, idempotencyKey } = {}) {
        return this.request(`${this.baseUrl}/runs`, {
            method: 'POST',
            body: JSON.stringify({ workflowId, source, idempotencyKey })
        });
    }

    getRun(runId) {
        return this.request(this.runUrl(runId));
    }

    cancelRun(runId) {
        return this.request(this.runUrl(runId, '/cancel'), { method: 'POST' });
    }

    getEventsUrl(runId, lastEventId = 0) {
        const id = normalizeLastEventId(lastEventId);
        const suffix = id ? `?lastEventId=${encodeURIComponent(String(id))}` : '';
        return `${this.runUrl(runId, '/events')}${suffix}`;
    }
}

export function unwrapAgentRun(response = {}) {
    if (response?.run && typeof response.run === 'object') return response.run;
    if (response && typeof response === 'object' && (response.id || response.runId || response.status)) return response;
    return null;
}
