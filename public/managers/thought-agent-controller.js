import AgentApiClient, { unwrapAgentRun } from './agent-api-client.js';
import {
    applyAgentEvent,
    applyAgentRunSnapshot,
    createThoughtAgentState,
    isAgentRunActive,
    isAgentRunTerminal,
    normalizeAgentError
} from './thought-agent-state.js';

const STREAM_EVENT_TYPES = [
    'run.started',
    'retrieval.started',
    'retrieval.completed',
    'generation.started',
    'text.delta',
    'run.completed',
    'run.failed',
    'run.cancelled',
    'run.reset'
];

function createIdempotencyKey() {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `recall-${uuid}`;
    return `recall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseStreamData(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function parseStreamEvent(event, fallbackType = '') {
    return {
        id: event?.lastEventId || event?.id || 0,
        type: String(event?.type || fallbackType || '').trim(),
        data: parseStreamData(event?.data)
    };
}

export class ThoughtAgentController {
    constructor({
        apiClient = new AgentApiClient(),
        EventSourceImpl = globalThis.EventSource,
        onStateChange = () => {},
        createIdempotencyKey: createKey = createIdempotencyKey,
        reconnectDelayMs = 1200
    } = {}) {
        this.apiClient = apiClient;
        this.EventSourceImpl = EventSourceImpl;
        this.onStateChange = onStateChange;
        this.createIdempotencyKey = createKey;
        this.reconnectDelayMs = Math.max(200, Number(reconnectDelayMs) || 1200);
        this.states = new Map();
        this.streams = new Map();
        this.reconnectTimers = new Map();
    }

    getState(thoughtId) {
        return this.states.get(String(thoughtId || '')) || createThoughtAgentState({ thoughtId });
    }

    setState(thoughtId, nextState) {
        const id = String(thoughtId || nextState?.thoughtId || '');
        if (!id) return nextState;
        const state = { ...nextState, thoughtId: id };
        this.states.set(id, state);
        this.onStateChange(id, state);
        return state;
    }

    applyRun(thoughtId, run) {
        const current = this.getState(thoughtId);
        return this.setState(thoughtId, applyAgentRunSnapshot(current, run));
    }

    async start(thought, { force = false } = {}) {
        const thoughtId = String(thought?.id || '');
        if (!thoughtId) return createThoughtAgentState();
        const current = this.getState(thoughtId);
        if (isAgentRunActive(current.status)) return current;
        if (!force && current.runId && !isAgentRunTerminal(current.status)) return current;

        this.closeStream(thoughtId);
        const idempotencyKey = this.createIdempotencyKey();
        const provisional = {
            ...createThoughtAgentState({
                thoughtId,
                sourceSnapshot: { kind: 'thought', id: thoughtId, version: thought?.version }
            }),
            status: 'queued',
            phase: 'queued',
            idempotencyKey
        };
        this.setState(thoughtId, provisional);

        try {
            const response = await this.apiClient.createRun({
                workflowId: 'recall_context',
                source: { kind: 'thought', id: thoughtId },
                idempotencyKey
            });
            const run = unwrapAgentRun(response) || {
                id: response?.runId,
                status: response?.status,
                source: response?.source
            };
            const next = this.applyRun(thoughtId, run);
            if (next.runId && !isAgentRunTerminal(next.status)) this.openStream(thoughtId, next.runId, next.lastEventId);
            return next;
        } catch (error) {
            return this.setState(thoughtId, {
                ...provisional,
                status: 'failed',
                phase: 'failed',
                error: normalizeAgentError(error)
            });
        }
    }

    async retry(thought) {
        return this.start(thought, { force: true });
    }

    async cancel(thoughtId) {
        const id = String(thoughtId || '');
        const current = this.getState(id);
        if (!id || !current.runId || !isAgentRunActive(current.status)) return current;
        const cancelling = this.setState(id, { ...current, status: 'cancelling', phase: 'cancelling', error: null });
        try {
            const response = await this.apiClient.cancelRun(cancelling.runId);
            const next = this.applyRun(id, unwrapAgentRun(response) || response);
            if (isAgentRunTerminal(next.status)) this.closeStream(id);
            return next;
        } catch (error) {
            return this.setState(id, { ...current, error: normalizeAgentError(error) });
        }
    }

    async refresh(thoughtId) {
        const id = String(thoughtId || '');
        const current = this.getState(id);
        if (!id || !current.runId) return current;
        try {
            const response = await this.apiClient.getRun(current.runId);
            const next = this.applyRun(id, unwrapAgentRun(response) || response);
            if (isAgentRunTerminal(next.status)) {
                this.closeStream(id);
            } else if (!this.streams.has(id)) {
                this.openStream(id, next.runId, next.lastEventId);
            }
            return next;
        } catch (error) {
            return this.setState(id, { ...current, error: normalizeAgentError(error), needsRefresh: false });
        }
    }

    handleStreamEvent(thoughtId, runId, event) {
        const current = this.getState(thoughtId);
        if (!current.runId || current.runId !== runId) return current;
        const next = this.setState(thoughtId, applyAgentEvent(current, event));
        if (next.needsRefresh) {
            this.closeStream(thoughtId);
            this.refresh(thoughtId);
            return next;
        }
        if (isAgentRunTerminal(next.status)) this.closeStream(thoughtId);
        return next;
    }

    openStream(thoughtId, runId, lastEventId = 0) {
        const id = String(thoughtId || '');
        if (!id || !runId || typeof this.EventSourceImpl !== 'function') return null;
        this.closeStream(id);
        const source = new this.EventSourceImpl(this.apiClient.getEventsUrl(runId, lastEventId));
        this.streams.set(id, source);

        const handle = (event, type) => this.handleStreamEvent(id, runId, parseStreamEvent(event, type));
        STREAM_EVENT_TYPES.forEach(type => {
            source.addEventListener?.(type, event => handle(event, type));
        });
        source.onmessage = event => handle(event, 'message');
        source.onerror = () => {
            const state = this.getState(id);
            if (state.runId !== runId || isAgentRunTerminal(state.status)) {
                this.closeStream(id);
                return;
            }
            if (source.readyState === this.EventSourceImpl.CLOSED || source.readyState === 2) {
                this.closeStream(id);
                this.scheduleReconnect(id);
            }
        };
        return source;
    }

    scheduleReconnect(thoughtId) {
        const id = String(thoughtId || '');
        if (!id || this.reconnectTimers.has(id)) return;
        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(id);
            const state = this.getState(id);
            if (!isAgentRunActive(state.status)) return;
            await this.refresh(id);
        }, this.reconnectDelayMs);
        this.reconnectTimers.set(id, timer);
    }

    closeStream(thoughtId) {
        const id = String(thoughtId || '');
        const source = this.streams.get(id);
        if (source) {
            source.onmessage = null;
            source.onerror = null;
            source.close?.();
            this.streams.delete(id);
        }
        const timer = this.reconnectTimers.get(id);
        if (timer) clearTimeout(timer);
        this.reconnectTimers.delete(id);
    }

    destroy() {
        [...this.streams.keys()].forEach(id => this.closeStream(id));
        this.states.clear();
    }
}

export { createIdempotencyKey, parseStreamEvent };
