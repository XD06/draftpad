const crypto = require('crypto');

const RECALL_CONTEXT_WORKFLOW_ID = 'recall_context';
const AGENT_RUN_STATUSES = Object.freeze([
    'queued',
    'running',
    'cancelling',
    'cancelled',
    'completed',
    'failed'
]);
const TERMINAL_AGENT_RUN_STATUSES = new Set(['cancelled', 'completed', 'failed']);
const AGENT_RUN_STATUS_TRANSITIONS = Object.freeze({
    queued: new Set(['running', 'cancelled', 'failed']),
    running: new Set(['cancelling', 'completed', 'failed']),
    cancelling: new Set(['cancelled', 'failed']),
    cancelled: new Set(),
    completed: new Set(),
    failed: new Set()
});
const SOURCE_REF_KINDS = new Set(['thought', 'notepad']);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const AGENT_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CITATION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

class AgentContractError extends Error {
    constructor(message, { code = 'agent_contract_invalid', errors = [] } = {}) {
        super(message);
        this.name = 'AgentContractError';
        this.code = code;
        this.errors = errors;
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function trimString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isSafeNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function sha256(value) {
    return `sha256:${crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;
}

function isSha256(value) {
    return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isSha256Hex(value) {
    return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

function hashIdempotencyKey(value) {
    const key = trimString(value);
    if (!key) {
        throw new AgentContractError('Idempotency key is required', {
            code: 'agent_invalid_idempotency_key'
        });
    }
    return sha256(key);
}

function formatValidation(errors, value = null) {
    return {
        valid: errors.length === 0,
        errors,
        value: errors.length === 0 ? value : null
    };
}

function validateSourceRef(sourceRef) {
    const errors = [];
    if (!isPlainObject(sourceRef)) {
        return formatValidation(['sourceRef must be an object']);
    }

    const kind = trimString(sourceRef.kind);
    const id = trimString(sourceRef.id);
    const label = trimString(sourceRef.label);
    const version = Number(sourceRef.version);
    const excerptHash = trimString(sourceRef.excerptHash);
    const location = sourceRef.location;

    if (!SOURCE_REF_KINDS.has(kind)) errors.push('sourceRef.kind must be thought or notepad');
    if (!id || id.length > 256) errors.push('sourceRef.id must be a non-empty string up to 256 characters');
    if (!label || label.length > 240) errors.push('sourceRef.label must be a non-empty string up to 240 characters');
    if (!isSafeNonNegativeInteger(version)) errors.push('sourceRef.version must be a non-negative safe integer');
    if (!isSha256(excerptHash)) errors.push('sourceRef.excerptHash must be a sha256 digest');
    if (!isPlainObject(location)) {
        errors.push('sourceRef.location must be an object');
    } else {
        const start = Number(location.start);
        const end = Number(location.end);
        if (!isSafeNonNegativeInteger(start)) errors.push('sourceRef.location.start must be a non-negative safe integer');
        if (!isSafeNonNegativeInteger(end) || end < start) {
            errors.push('sourceRef.location.end must be a safe integer not before start');
        }
    }

    if (errors.length) return formatValidation(errors);
    return formatValidation([], {
        kind,
        id,
        version,
        excerptHash,
        label,
        location: {
            start: Number(location.start),
            end: Number(location.end)
        }
    });
}

function assertValidSourceRef(sourceRef) {
    const validation = validateSourceRef(sourceRef);
    if (!validation.valid) {
        throw new AgentContractError('Invalid sourceRef', {
            code: 'agent_invalid_source_ref',
            errors: validation.errors
        });
    }
    return validation.value;
}

function validateSourceSnapshot(sourceSnapshot, primarySource) {
    const errors = [];
    if (!isPlainObject(sourceSnapshot)) return formatValidation(['sourceSnapshot must be an object']);
    const id = trimString(sourceSnapshot.id);
    const version = Number(sourceSnapshot.version);
    const hash = trimString(sourceSnapshot.hash);
    if (!id || id.length > 256) errors.push('sourceSnapshot.id must be a non-empty string up to 256 characters');
    if (!isSafeNonNegativeInteger(version)) errors.push('sourceSnapshot.version must be a non-negative safe integer');
    // The existing Thought analysis signature stores the SHA-256 digest without
    // a prefix, so retain that stable compact form instead of duplicating text.
    if (!isSha256Hex(hash)) errors.push('sourceSnapshot.hash must be a lowercase sha256 hex digest');

    if (primarySource !== undefined) {
        const primaryValidation = validateSourceRef(primarySource);
        if (!primaryValidation.valid) {
            errors.push('sourceSnapshot requires a valid primarySource');
        } else {
            if (primaryValidation.value.kind !== 'thought') {
                errors.push('sourceSnapshot is only valid for a Thought primarySource in P0');
            }
            if (id && id !== primaryValidation.value.id) errors.push('sourceSnapshot.id must match primarySource.id');
            if (isSafeNonNegativeInteger(version) && version !== primaryValidation.value.version) {
                errors.push('sourceSnapshot.version must match primarySource.version');
            }
        }
    }

    if (errors.length) return formatValidation(errors);
    return formatValidation([], { id, version, hash });
}

function assertValidSourceSnapshot(sourceSnapshot, primarySource) {
    const validation = validateSourceSnapshot(sourceSnapshot, primarySource);
    if (!validation.valid) {
        throw new AgentContractError('Invalid sourceSnapshot', {
            code: 'agent_invalid_source_snapshot',
            errors: validation.errors
        });
    }
    return validation.value;
}

function createSourceRef({ kind, id, version, label, location, excerpt } = {}) {
    if (excerpt === undefined || excerpt === null) {
        throw new AgentContractError('Source excerpt is required to create sourceRef', {
            code: 'agent_source_excerpt_required'
        });
    }
    return assertValidSourceRef({
        kind,
        id,
        version,
        label,
        location,
        excerptHash: sha256(excerpt)
    });
}

function sourceRefIdentityKey(sourceRef) {
    const value = assertValidSourceRef(sourceRef);
    return [
        value.kind,
        value.id,
        value.version,
        value.excerptHash,
        value.location.start,
        value.location.end
    ].join('\u0000');
}

function isAgentRunStatus(status) {
    return AGENT_RUN_STATUSES.includes(status);
}

function isTerminalAgentRunStatus(status) {
    return TERMINAL_AGENT_RUN_STATUSES.has(status);
}

function canTransitionAgentRunStatus(fromStatus, toStatus) {
    if (!isAgentRunStatus(fromStatus) || !isAgentRunStatus(toStatus)) return false;
    if (fromStatus === toStatus) return true;
    return AGENT_RUN_STATUS_TRANSITIONS[fromStatus].has(toStatus);
}

function validateAgentRunTransition(fromStatus, toStatus) {
    if (canTransitionAgentRunStatus(fromStatus, toStatus)) {
        return formatValidation([], { fromStatus, toStatus });
    }
    return formatValidation([`Invalid AgentRun status transition: ${fromStatus} -> ${toStatus}`]);
}

function assertValidAgentRunTransition(fromStatus, toStatus) {
    const validation = validateAgentRunTransition(fromStatus, toStatus);
    if (!validation.valid) {
        throw new AgentContractError('Invalid AgentRun status transition', {
            code: 'agent_invalid_status_transition',
            errors: validation.errors
        });
    }
    return validation.value;
}

function normalizeSourceRefList(sourceRefs, fieldName, errors, { maxItems = 32 } = {}) {
    if (!Array.isArray(sourceRefs)) {
        errors.push(`${fieldName} must be an array`);
        return [];
    }
    if (sourceRefs.length > maxItems) {
        errors.push(`${fieldName} must contain at most ${maxItems} items`);
        return [];
    }

    const normalized = [];
    const seen = new Set();
    sourceRefs.forEach((sourceRef, index) => {
        const validation = validateSourceRef(sourceRef);
        if (!validation.valid) {
            errors.push(...validation.errors.map(error => `${fieldName}[${index}]: ${error}`));
            return;
        }
        const key = sourceRefIdentityKey(validation.value);
        if (seen.has(key)) {
            errors.push(`${fieldName}[${index}] duplicates an earlier sourceRef`);
            return;
        }
        seen.add(key);
        normalized.push(validation.value);
    });
    return normalized;
}

function normalizeUsage(value, errors) {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
        errors.push('usage must be an object');
        return undefined;
    }
    const normalized = {};
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) {
        if (value[key] === undefined) continue;
        const number = Number(value[key]);
        if (!isSafeNonNegativeInteger(number)) {
            errors.push(`usage.${key} must be a non-negative safe integer`);
            continue;
        }
        normalized[key] = number;
    }
    return normalized;
}

function normalizeRunError(value, errors) {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
        errors.push('error must be an object');
        return undefined;
    }
    const code = trimString(value.code);
    const message = trimString(value.message);
    if (!code || code.length > 120) errors.push('error.code must be a non-empty string up to 120 characters');
    if (message.length > 1000) errors.push('error.message must be at most 1000 characters');
    if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
        errors.push('error.retryable must be a boolean');
    }
    if (!code || code.length > 120 || message.length > 1000 || (value.retryable !== undefined && typeof value.retryable !== 'boolean')) {
        return undefined;
    }
    return {
        code,
        ...(message ? { message } : {}),
        ...(value.retryable === undefined ? {} : { retryable: value.retryable })
    };
}

function validateAgentRun(run) {
    const errors = [];
    if (!isPlainObject(run)) return formatValidation(['AgentRun must be an object']);

    const id = trimString(run.id);
    const workflowId = trimString(run.workflowId);
    const actorId = trimString(run.actorId);
    const objectScope = trimString(run.objectScope);
    const status = trimString(run.status);
    const createdAt = Number(run.createdAt);
    const updatedAt = Number(run.updatedAt);
    const primarySourceValidation = validateSourceRef(run.primarySource);
    const allowedReadSet = normalizeSourceRefList(run.allowedReadSet, 'allowedReadSet', errors);

    if (!AGENT_RUN_ID_PATTERN.test(id)) errors.push('AgentRun.id must use letters, numbers, underscores, or hyphens');
    if (workflowId !== RECALL_CONTEXT_WORKFLOW_ID) {
        errors.push(`AgentRun.workflowId must be ${RECALL_CONTEXT_WORKFLOW_ID} for P0`);
    }
    if (!actorId || actorId.length > 160) errors.push('AgentRun.actorId must be a non-empty string up to 160 characters');
    if (!objectScope || objectScope.length > 160) errors.push('AgentRun.objectScope must be a non-empty string up to 160 characters');
    if (!isAgentRunStatus(status)) errors.push('AgentRun.status is invalid');
    if (!isSafeNonNegativeInteger(createdAt)) errors.push('AgentRun.createdAt must be a non-negative safe integer');
    if (!isSafeNonNegativeInteger(updatedAt) || updatedAt < createdAt) {
        errors.push('AgentRun.updatedAt must be a safe integer not before createdAt');
    }
    if (!primarySourceValidation.valid) {
        errors.push(...primarySourceValidation.errors.map(error => `primarySource: ${error}`));
    }

    let primarySource = null;
    if (primarySourceValidation.valid) {
        primarySource = primarySourceValidation.value;
        const primaryKey = sourceRefIdentityKey(primarySource);
        if (!allowedReadSet.some(sourceRef => sourceRefIdentityKey(sourceRef) === primaryKey)) {
            errors.push('allowedReadSet must include primarySource');
        }
    }

    const idempotencyKeyHash = run.idempotencyKeyHash === undefined ? '' : trimString(run.idempotencyKeyHash);
    if (hasOwn(run, 'idempotencyKey')) {
        errors.push('AgentRun must not persist a raw idempotencyKey');
    }
    if (idempotencyKeyHash && !isSha256(idempotencyKeyHash)) {
        errors.push('AgentRun.idempotencyKeyHash must be a sha256 digest');
    }

    const lastEventId = run.lastEventId === undefined ? undefined : Number(run.lastEventId);
    if (lastEventId !== undefined && !isSafeNonNegativeInteger(lastEventId)) {
        errors.push('AgentRun.lastEventId must be a non-negative safe integer');
    }

    const startedAt = run.startedAt === undefined ? undefined : Number(run.startedAt);
    const finishedAt = run.finishedAt === undefined ? undefined : Number(run.finishedAt);
    if (startedAt !== undefined && (!isSafeNonNegativeInteger(startedAt) || startedAt < createdAt)) {
        errors.push('AgentRun.startedAt must be a safe integer not before createdAt');
    }
    if (finishedAt !== undefined && (!isSafeNonNegativeInteger(finishedAt) || finishedAt < createdAt)) {
        errors.push('AgentRun.finishedAt must be a safe integer not before createdAt');
    }
    if (isTerminalAgentRunStatus(status) && finishedAt === undefined) {
        errors.push('Terminal AgentRun must include finishedAt');
    }
    if (!isTerminalAgentRunStatus(status) && finishedAt !== undefined) {
        errors.push('Nonterminal AgentRun must not include finishedAt');
    }

    const model = run.model === undefined ? '' : trimString(run.model);
    if (model.length > 240) errors.push('AgentRun.model must be at most 240 characters');
    const sourceSnapshot = run.sourceSnapshot === undefined
        ? undefined
        : validateSourceSnapshot(run.sourceSnapshot, primarySource);
    if (sourceSnapshot && !sourceSnapshot.valid) {
        errors.push(...sourceSnapshot.errors.map(error => `sourceSnapshot: ${error}`));
    }
    if (run.sourceStale !== undefined && typeof run.sourceStale !== 'boolean') {
        errors.push('AgentRun.sourceStale must be a boolean');
    }
    const steps = run.steps === undefined ? undefined : Number(run.steps);
    if (steps !== undefined && !isSafeNonNegativeInteger(steps)) errors.push('AgentRun.steps must be a non-negative safe integer');
    const usage = normalizeUsage(run.usage, errors);
    const error = normalizeRunError(run.error, errors);

    if (errors.length) return formatValidation(errors);

    const value = {
        schemaVersion: 1,
        id,
        workflowId,
        actorId,
        objectScope,
        primarySource,
        allowedReadSet,
        status,
        createdAt,
        updatedAt,
        ...(idempotencyKeyHash ? { idempotencyKeyHash } : {}),
        ...(lastEventId === undefined ? {} : { lastEventId }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(model ? { model } : {}),
        ...(sourceSnapshot === undefined ? {} : { sourceSnapshot: sourceSnapshot.value }),
        ...(run.sourceStale === undefined ? {} : { sourceStale: run.sourceStale }),
        ...(steps === undefined ? {} : { steps }),
        ...(usage === undefined ? {} : { usage }),
        ...(error === undefined ? {} : { error })
    };
    if (hasOwn(run, 'result')) value.result = run.result;
    if (hasOwn(run, 'proposal')) value.proposal = run.proposal;
    return formatValidation([], value);
}

function validateRecallResult(result, { allowedSourceRefs } = {}) {
    const errors = [];
    if (!isPlainObject(result)) return formatValidation(['Recall result must be an object']);

    const allowed = normalizeSourceRefList(allowedSourceRefs, 'allowedSourceRefs', errors, { maxItems: 64 });
    const allowedByKey = new Map(allowed.map(sourceRef => [sourceRefIdentityKey(sourceRef), sourceRef]));
    const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
    if (summary.length > 12000) errors.push('Recall result summary must be at most 12000 characters');

    if (!Array.isArray(result.citations)) {
        errors.push('Recall result citations must be an array');
    } else if (result.citations.length > 32) {
        errors.push('Recall result citations must contain at most 32 items');
    }
    const citations = [];
    const citationIds = new Set();
    (Array.isArray(result.citations) ? result.citations : []).forEach((citation, index) => {
        if (!isPlainObject(citation)) {
            errors.push(`citations[${index}] must be an object`);
            return;
        }
        const citationId = trimString(citation.citationId);
        if (!CITATION_ID_PATTERN.test(citationId)) {
            errors.push(`citations[${index}].citationId is invalid`);
            return;
        }
        if (citationIds.has(citationId)) {
            errors.push(`citations[${index}].citationId duplicates an earlier citation`);
            return;
        }
        const sourceRefValidation = validateSourceRef(citation.sourceRef);
        if (!sourceRefValidation.valid) {
            errors.push(...sourceRefValidation.errors.map(error => `citations[${index}].sourceRef: ${error}`));
            return;
        }
        const key = sourceRefIdentityKey(sourceRefValidation.value);
        const allowedSourceRef = allowedByKey.get(key);
        if (!allowedSourceRef) {
            errors.push(`citations[${index}].sourceRef was not returned by this run`);
            return;
        }
        citationIds.add(citationId);
        // Keep the server-originated label instead of trusting a model-supplied label.
        citations.push({ citationId, sourceRef: allowedSourceRef });
    });

    if (!Array.isArray(result.claims)) {
        errors.push('Recall result claims must be an array');
    } else if (result.claims.length > 40) {
        errors.push('Recall result claims must contain at most 40 items');
    }
    const claims = [];
    (Array.isArray(result.claims) ? result.claims : []).forEach((claim, index) => {
        if (!isPlainObject(claim)) {
            errors.push(`claims[${index}] must be an object`);
            return;
        }
        const text = typeof claim.text === 'string' ? claim.text.trim() : '';
        if (!text || text.length > 2400) {
            errors.push(`claims[${index}].text must be a non-empty string up to 2400 characters`);
        }
        if (!Array.isArray(claim.citationIds) || claim.citationIds.length === 0 || claim.citationIds.length > 8) {
            errors.push(`claims[${index}].citationIds must contain 1 to 8 citation IDs`);
            return;
        }
        const claimCitationIds = [];
        const seen = new Set();
        claim.citationIds.forEach((citationId, citationIndex) => {
            const normalizedId = trimString(citationId);
            if (!CITATION_ID_PATTERN.test(normalizedId) || !citationIds.has(normalizedId)) {
                errors.push(`claims[${index}].citationIds[${citationIndex}] does not reference a valid citation`);
                return;
            }
            if (seen.has(normalizedId)) {
                errors.push(`claims[${index}].citationIds[${citationIndex}] duplicates a citation ID`);
                return;
            }
            seen.add(normalizedId);
            claimCitationIds.push(normalizedId);
        });
        if (text && text.length <= 2400 && claimCitationIds.length > 0) {
            claims.push({ text, citationIds: claimCitationIds });
        }
    });

    if (errors.length) return formatValidation(errors);
    return formatValidation([], { summary, claims, citations });
}

function assertValidRecallResult(result, options) {
    const validation = validateRecallResult(result, options);
    if (!validation.valid) {
        throw new AgentContractError('Invalid structured recall result', {
            code: 'agent_invalid_recall_result',
            errors: validation.errors
        });
    }
    return validation.value;
}

function validateTerminalAgentRun(run) {
    const base = validateAgentRun(run);
    if (!base.valid) return base;

    const errors = [];
    const value = { ...base.value };
    if (!isTerminalAgentRunStatus(value.status)) {
        errors.push('AgentRun is not terminal');
    } else if (value.status === 'completed') {
        const result = validateRecallResult(run.result, { allowedSourceRefs: value.allowedReadSet });
        if (!result.valid) {
            errors.push(...result.errors.map(error => `result: ${error}`));
        } else {
            value.result = result.value;
        }
        if (value.error) errors.push('Completed AgentRun must not include error');
    } else if (value.status === 'failed') {
        if (!value.error?.code) errors.push('Failed AgentRun must include error.code');
        if (hasOwn(run, 'result')) errors.push('Failed AgentRun must not include result');
    } else if (value.status === 'cancelled') {
        if (hasOwn(run, 'result')) errors.push('Cancelled AgentRun must not include result');
        if (hasOwn(run, 'proposal')) errors.push('Cancelled AgentRun must not include proposal');
    }

    if (errors.length) return formatValidation(errors);
    if (hasOwn(run, 'proposal')) value.proposal = run.proposal;
    return formatValidation([], value);
}

function assertValidTerminalAgentRun(run) {
    const validation = validateTerminalAgentRun(run);
    if (!validation.valid) {
        throw new AgentContractError('Invalid terminal AgentRun', {
            code: 'agent_invalid_terminal_run',
            errors: validation.errors
        });
    }
    return validation.value;
}

function createAgentRun(input = {}) {
    const now = input.now === undefined ? Date.now() : Number(input.now);
    const rawKey = input.idempotencyKey;
    const run = {
        schemaVersion: 1,
        id: input.id,
        workflowId: input.workflowId || RECALL_CONTEXT_WORKFLOW_ID,
        actorId: input.actorId,
        objectScope: input.objectScope,
        primarySource: input.primarySource,
        allowedReadSet: input.allowedReadSet,
        status: input.status || 'queued',
        createdAt: input.createdAt === undefined ? now : input.createdAt,
        updatedAt: input.updatedAt === undefined ? now : input.updatedAt,
        ...(input.idempotencyKeyHash ? { idempotencyKeyHash: input.idempotencyKeyHash } : {}),
        ...(!input.idempotencyKeyHash && rawKey ? { idempotencyKeyHash: hashIdempotencyKey(rawKey) } : {}),
        ...(input.lastEventId === undefined ? { lastEventId: 0 } : { lastEventId: input.lastEventId }),
        ...(input.model ? { model: input.model } : {}),
        ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {})
    };
    return assertValidAgentRun(run);
}

function assertValidAgentRun(run) {
    const validation = validateAgentRun(run);
    if (!validation.valid) {
        throw new AgentContractError('Invalid AgentRun', {
            code: 'agent_invalid_run',
            errors: validation.errors
        });
    }
    return validation.value;
}

function toActiveAgentRunIndexEntry(run) {
    const value = assertValidAgentRun(run);
    if (isTerminalAgentRunStatus(value.status)) return null;
    return {
        id: value.id,
        workflowId: value.workflowId,
        actorId: value.actorId,
        objectScope: value.objectScope,
        primarySource: value.primarySource,
        status: value.status,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        ...(value.idempotencyKeyHash ? { idempotencyKeyHash: value.idempotencyKeyHash } : {})
    };
}

module.exports = {
    AGENT_RUN_STATUSES,
    AGENT_RUN_STATUS_TRANSITIONS,
    AgentContractError,
    RECALL_CONTEXT_WORKFLOW_ID,
    SOURCE_REF_KINDS,
    assertValidAgentRun,
    assertValidAgentRunTransition,
    assertValidRecallResult,
    assertValidSourceRef,
    assertValidSourceSnapshot,
    assertValidTerminalAgentRun,
    canTransitionAgentRunStatus,
    createAgentRun,
    createSourceRef,
    hashIdempotencyKey,
    isAgentRunStatus,
    isSha256,
    isSha256Hex,
    isTerminalAgentRunStatus,
    sha256,
    sourceRefIdentityKey,
    toActiveAgentRunIndexEntry,
    validateAgentRun,
    validateAgentRunTransition,
    validateRecallResult,
    validateSourceRef,
    validateSourceSnapshot,
    validateTerminalAgentRun
};
