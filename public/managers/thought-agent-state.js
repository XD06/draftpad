const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);

export function isAgentRunTerminal(status) {
    return TERMINAL_STATUSES.has(String(status || '').toLowerCase());
}

export function isAgentRunActive(status) {
    return ACTIVE_STATUSES.has(String(status || '').toLowerCase());
}

export function normalizeAgentRunStatus(status, fallback = 'idle') {
    const value = String(status || '').toLowerCase();
    if (TERMINAL_STATUSES.has(value) || ACTIVE_STATUSES.has(value)) return value;
    return fallback;
}

export function normalizeAgentError(error) {
    if (!error) return null;
    if (typeof error === 'string') return { message: error, code: '' };
    if (typeof error === 'object') {
        return {
            message: String(error.message || error.code || 'AI 运行失败'),
            code: String(error.code || ''),
            retryable: error.retryable === true
        };
    }
    return { message: 'AI 运行失败', code: '' };
}

function hasOwn(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function readText(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    for (const key of ['text', 'markdown', 'answer', 'content', 'summary']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key];
    }
    if (Array.isArray(value.claims)) {
        return value.claims
            .map(claim => typeof claim === 'string' ? claim : claim?.text)
            .filter(text => typeof text === 'string' && text.trim())
            .join('\n');
    }
    return '';
}

function readCitations(value) {
    if (!value || typeof value !== 'object') return [];
    const citations = Array.isArray(value.citations)
        ? value.citations
        : Array.isArray(value.sources) ? value.sources : [];
    return citations.filter(item => item && typeof item === 'object').slice(0, 12);
}

function normalizeEventId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function runIdFrom(run = {}) {
    return String(run?.id || run?.runId || '').trim();
}

function sourceSnapshotFrom(run = {}, fallback = null) {
    return run?.sourceSnapshot || run?.source || run?.sourceRef || fallback;
}

export function createThoughtAgentState({ thoughtId = '', run = null, sourceSnapshot = null } = {}) {
    const result = run?.result ?? null;
    return {
        thoughtId: String(thoughtId || run?.source?.id || '').trim(),
        runId: runIdFrom(run),
        idempotencyKey: String(run?.idempotencyKey || ''),
        status: normalizeAgentRunStatus(run?.status),
        phase: '',
        text: readText(result),
        result,
        citations: readCitations(result).length ? readCitations(result) : readCitations(run),
        error: normalizeAgentError(run?.error),
        sourceSnapshot: sourceSnapshotFrom(run, sourceSnapshot),
        sourceStale: run?.sourceStale === true,
        model: String(run?.model || result?.model || ''),
        sourceCount: Number(run?.sourceCount ?? result?.sourceCount ?? 0) || 0,
        lastEventId: normalizeEventId(run?.lastEventId),
        needsRefresh: false,
        updatedAt: Date.now()
    };
}

export function applyAgentRunSnapshot(state, rawRun = {}) {
    const run = rawRun?.run && typeof rawRun.run === 'object' ? rawRun.run : rawRun;
    if (!run || typeof run !== 'object') return state;
    const resultProvided = hasOwn(run, 'result');
    const nextResult = resultProvided ? run.result : state.result;
    const snapshot = sourceSnapshotFrom(run, state.sourceSnapshot);
    const resultText = readText(nextResult);
    const citations = readCitations(nextResult);
    const runCitations = readCitations(run);
    return {
        ...state,
        runId: runIdFrom(run) || state.runId,
        idempotencyKey: String(run.idempotencyKey || state.idempotencyKey || ''),
        status: normalizeAgentRunStatus(run.status, state.status),
        text: resultText || state.text,
        result: nextResult,
        citations: citations.length ? citations : (runCitations.length ? runCitations : state.citations),
        error: hasOwn(run, 'error') ? normalizeAgentError(run.error) : state.error,
        sourceSnapshot: snapshot,
        sourceStale: run.sourceStale === true || state.sourceStale === true,
        model: String(run.model || nextResult?.model || state.model || ''),
        sourceCount: Number(run.sourceCount ?? nextResult?.sourceCount ?? state.sourceCount ?? 0) || 0,
        lastEventId: Math.max(state.lastEventId || 0, normalizeEventId(run.lastEventId)),
        needsRefresh: false,
        updatedAt: Date.now()
    };
}

export function applyAgentEvent(state, event = {}) {
    const type = String(event.type || '').trim();
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const eventId = normalizeEventId(event.id ?? event.lastEventId);
    if (eventId && eventId <= (state.lastEventId || 0) && type !== 'run.reset') return state;

    const base = {
        ...state,
        lastEventId: eventId ? Math.max(eventId, state.lastEventId || 0) : state.lastEventId,
        needsRefresh: false,
        updatedAt: Date.now()
    };

    if (type === 'run.started') {
        return {
            ...base,
            runId: String(data.runId || data.id || base.runId || ''),
            status: 'running',
            phase: 'started',
            sourceSnapshot: data.sourceSnapshot || data.source || base.sourceSnapshot,
            model: String(data.model || base.model || '')
        };
    }
    if (type === 'retrieval.started') return { ...base, status: 'running', phase: 'retrieval' };
    if (type === 'retrieval.completed') {
        return {
            ...base,
            status: 'running',
            phase: 'retrieval_completed',
            sourceCount: Number(data.sourceCount ?? data.count ?? base.sourceCount ?? 0) || 0
        };
    }
    if (type === 'generation.started') return { ...base, status: 'running', phase: 'generation' };
    if (type === 'text.delta') {
        const delta = typeof data.text === 'string' ? data.text
            : typeof data.delta === 'string' ? data.delta
                : typeof data.content === 'string' ? data.content : '';
        return {
            ...base,
            status: 'running',
            phase: 'generation',
            text: `${base.text || ''}${delta}`
        };
    }
    if (type === 'run.completed') {
        const merged = applyAgentRunSnapshot({ ...base, status: 'completed', phase: 'completed' }, data.run || data);
        return {
            ...merged,
            status: 'completed',
            phase: 'completed',
            result: hasOwn(data, 'result') ? data.result : merged.result,
            text: readText(data.result) || readText(data) || merged.text,
            citations: readCitations(data.result).length ? readCitations(data.result)
                : (readCitations(data).length ? readCitations(data) : merged.citations),
            error: null
        };
    }
    if (type === 'run.failed') {
        return {
            ...base,
            status: 'failed',
            phase: 'failed',
            error: normalizeAgentError(data.error || data)
        };
    }
    if (type === 'run.cancelled') {
        return { ...base, status: 'cancelled', phase: 'cancelled', error: null };
    }
    if (type === 'run.reset') {
        return { ...base, phase: 'refreshing', text: '', needsRefresh: true };
    }
    return base;
}

function readSourceVersion(source) {
    const value = source?.version ?? source?.sourceVersion ?? source?.baseVersion ?? source?.sourceRef?.version;
    const version = Number(value);
    return Number.isFinite(version) ? version : null;
}

export function isAgentSourceStale(state, thought) {
    if (state?.sourceStale === true) return true;
    const snapshotVersion = readSourceVersion(state?.sourceSnapshot);
    const currentVersion = Number(thought?.version);
    return snapshotVersion !== null && Number.isFinite(currentVersion) && snapshotVersion !== currentVersion;
}

export function getAgentSourceLabel(citation = {}) {
    const source = citation.sourceRef || citation.source || citation;
    return String(source?.label || source?.title || source?.id || '关联内容').trim() || '关联内容';
}
