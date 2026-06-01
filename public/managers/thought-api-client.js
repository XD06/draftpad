export class ThoughtApiError extends Error {
    constructor(message, { status = 0, body = null } = {}) {
        super(message);
        this.name = 'ThoughtApiError';
        this.status = status;
        this.body = body;
    }
}

export default class ThoughtApiClient {
    constructor({ baseUrl = '/api/thoughts', fetchImpl = window.fetch.bind(window) } = {}) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.fetchImpl = fetchImpl;
    }

    thoughtUrl(id, suffix = '') {
        return `${this.baseUrl}/${encodeURIComponent(id)}${suffix}`;
    }

    async request(url, options = {}) {
        const response = await this.fetchImpl(url, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {})
            }
        });

        let body = null;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            body = await response.json();
        }

        if (!response.ok) {
            throw new ThoughtApiError(`HTTP ${response.status}`, {
                status: response.status,
                body
            });
        }

        return body;
    }

    list({ date = '', query = '', limit = '', light = false } = {}) {
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        if (query) params.set('q', query);
        if (limit) params.set('limit', String(limit));
        if (light) params.set('light', '1');
        const qs = params.toString();
        return this.request(`${this.baseUrl}${qs ? `?${qs}` : ''}`);
    }

    create(body) {
        return this.request(this.baseUrl, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    patch(id, body) {
        return this.request(this.thoughtUrl(id), {
            method: 'PATCH',
            body: JSON.stringify(body)
        });
    }

    overwrite(id, thoughtState) {
        return this.patch(id, {
            action: 'overwrite',
            text: thoughtState.text || '',
            subItems: Array.isArray(thoughtState.subItems) ? thoughtState.subItems : [],
            tags: Array.isArray(thoughtState.tags) ? thoughtState.tags : [],
            completed: thoughtState.completed === true
        });
    }

    toggleComplete(id) {
        return this.patch(id, { action: 'toggle_complete' });
    }

    delete(id) {
        return this.request(this.thoughtUrl(id), { method: 'DELETE' });
    }

    addSubitem(id, text) {
        return this.patch(id, { action: 'add_subitem', text });
    }

    updateSubitem(id, subId, text) {
        return this.patch(id, { action: 'update_subitem', subId, text });
    }

    deleteSubitem(id, subId) {
        return this.patch(id, { action: 'delete_subitem', subId });
    }

    toggleSubitem(id, subId) {
        return this.patch(id, { action: 'toggle_subitem', subId });
    }

    getAIStatus(id) {
        return this.request(this.thoughtUrl(id, '/ai-status'));
    }

    retryAI(id) {
        return this.request(this.thoughtUrl(id, '/ai-process'), { method: 'POST' });
    }

    getRelations(id) {
        return this.request(this.thoughtUrl(id, '/relations'));
    }

    createRelation(id, targetId, relationType = 'manual') {
        return this.request(this.thoughtUrl(id, '/relations'), {
            method: 'POST',
            body: JSON.stringify({ targetId, relationType })
        });
    }

    deleteRelation(id, targetId) {
        return this.request(this.thoughtUrl(id, `/relations/${encodeURIComponent(targetId)}`), {
            method: 'DELETE'
        });
    }

    requestOutboxItem(item) {
        return this.request(item.url, {
            method: item.method,
            body: item.body ? JSON.stringify(item.body) : undefined
        });
    }
}
