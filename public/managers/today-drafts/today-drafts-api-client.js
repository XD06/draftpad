export class TodayDraftsApiError extends Error {
    constructor(message, { status = 0, body = null } = {}) {
        super(message);
        this.name = 'TodayDraftsApiError';
        this.status = status;
        this.body = body;
    }
}

export default class TodayDraftsApiClient {
    constructor({ baseUrl = '/api/today-drafts', fetchImpl = window.fetch.bind(window) } = {}) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.fetchImpl = fetchImpl;
    }

    draftUrl(id) {
        return `${this.baseUrl}/${encodeURIComponent(id)}`;
    }

    async request(url, options = {}) {
        const response = await this.fetchImpl(url, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {})
            }
        });
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.json() : null;
        if (!response.ok) {
            throw new TodayDraftsApiError(body?.error || `HTTP ${response.status}`, { status: response.status, body });
        }
        return body;
    }

    list() {
        return this.request(this.baseUrl);
    }

    get(id) {
        return this.request(this.draftUrl(id));
    }

    put(id, { text, completed, baseVersion } = {}) {
        const body = { text, completed };
        if (Number.isSafeInteger(Number(baseVersion)) && Number(baseVersion) > 0) {
            body.baseVersion = Number(baseVersion);
        }
        return this.request(this.draftUrl(id), { method: 'PUT', body: JSON.stringify(body) });
    }

    delete(id, baseVersion) {
        return this.request(this.draftUrl(id), {
            method: 'DELETE',
            body: JSON.stringify({ baseVersion: Number(baseVersion) })
        });
    }
}
