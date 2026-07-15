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

    list({
        date = '',
        query = '',
        tag = '',
        status = '',
        sort = '',
        limit = '',
        light = false,
        cursor = '',
        updatedSince = '',
        format = ''
    } = {}) {
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        if (query) params.set('q', query);
        if (tag) params.set('tag', tag);
        if (status) params.set('status', status);
        if (sort) params.set('sort', sort);
        if (limit) params.set('limit', String(limit));
        if (light) params.set('light', '1');
        if (cursor) params.set('cursor', cursor);
        if (updatedSince !== '') params.set('updatedSince', String(updatedSince));
        if (format) params.set('format', format);
        const qs = params.toString();
        return this.request(`${this.baseUrl}${qs ? `?${qs}` : ''}`);
    }

    listPage(options = {}) {
        return this.list({ ...options, format: 'page' });
    }

    create(body) {
        return this.request(this.baseUrl, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    get(id) {
        return this.request(this.thoughtUrl(id));
    }

    patch(id, body, baseVersion) {
        const payload = { ...body };
        const version = Number(baseVersion ?? body?.baseVersion);
        if (Number.isFinite(version)) payload.baseVersion = version;
        return this.request(this.thoughtUrl(id), {
            method: 'PATCH',
            body: JSON.stringify(payload)
        });
    }

    overwrite(id, thoughtState) {
        return this.patch(id, {
            action: 'overwrite',
            text: thoughtState.text || '',
            subItems: Array.isArray(thoughtState.subItems) ? thoughtState.subItems : [],
            tags: Array.isArray(thoughtState.tags) ? thoughtState.tags : [],
            completed: thoughtState.completed === true,
            pinned: thoughtState.pinned === true,
            attachments: Array.isArray(thoughtState.attachments) ? thoughtState.attachments : [],
            baseVersion: thoughtState.version
        });
    }

    toggleComplete(id, baseVersion) {
        return this.patch(id, { action: 'toggle_complete' }, baseVersion);
    }

    togglePin(id, baseVersion) {
        return this.patch(id, { action: 'toggle_pin' }, baseVersion);
    }

    delete(id) {
        return this.request(this.thoughtUrl(id), { method: 'DELETE' });
    }

    addSubitem(id, text, baseVersion) {
        return this.patch(id, { action: 'add_subitem', text }, baseVersion);
    }

    updateSubitem(id, subId, text, baseVersion) {
        return this.patch(id, { action: 'update_subitem', subId, text }, baseVersion);
    }

    deleteSubitem(id, subId, baseVersion) {
        return this.patch(id, { action: 'delete_subitem', subId }, baseVersion);
    }

    toggleSubitem(id, subId, baseVersion) {
        return this.patch(id, { action: 'toggle_subitem', subId }, baseVersion);
    }

    getAIStatus(id) {
        return this.request(this.thoughtUrl(id, '/ai-status'));
    }

    retryAI(id) {
        return this.request(this.thoughtUrl(id, '/ai-process'), { method: 'POST' });
    }

    generateInsight(id) {
        return this.request(this.thoughtUrl(id, '/ai-insight'), { method: 'POST' });
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
