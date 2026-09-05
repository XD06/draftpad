const { createAgentContextService, AgentContextError } = require('./agent-context-service');

const RECALL_CONTEXT_WORKFLOW_ID = 'recall_context';
const RECALL_CONTEXT_TOOL_NAMES = Object.freeze([
    'build_recall_candidates',
    'get_thought_excerpt',
    'get_notepad_excerpt',
    'get_thought_relations'
]);

class AgentToolError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AgentToolError';
        this.code = code;
    }
}

function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function objectArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new AgentToolError('invalid_tool_args', 'Tool arguments must be an object');
    }
    return args;
}

function assertOnlyKeys(args, allowed) {
    for (const key of Object.keys(args)) {
        if (!allowed.includes(key)) {
            throw new AgentToolError('invalid_tool_args', `Unexpected tool argument: ${key}`);
        }
    }
}

function normalizeId(args) {
    const id = String(args.id || '').trim();
    if (!id) throw new AgentToolError('invalid_tool_args', 'A non-empty id is required');
    return id;
}

function jsonCharLength(value) {
    try {
        return JSON.stringify(value).length;
    } catch (_error) {
        throw new AgentToolError('invalid_tool_result', 'Tool returned a non-serializable result');
    }
}

function normalizeUsage(value) {
    const source = value && typeof value === 'object' ? value : {};
    const calls = source.calls && typeof source.calls === 'object' ? source.calls : {};
    const normalizedCalls = {};
    for (const name of RECALL_CONTEXT_TOOL_NAMES) {
        normalizedCalls[name] = Math.max(0, Math.floor(Number(calls[name]) || 0));
    }
    return {
        calls: normalizedCalls,
        totalCalls: Math.max(0, Math.floor(Number(source.totalCalls) || 0)),
        contextChars: Math.max(0, Math.floor(Number(source.contextChars) || 0))
    };
}

/**
 * Restricts model tool calls to the one P0 read-only workflow. The registry is
 * deliberately not a generic dispatch table: an unknown workflow or tool
 * cannot be reached by passing a different name from a model response.
 */
function createAgentToolRegistry(options = {}) {
    const contextService = options.contextService || createAgentContextService(options);
    const maxExcerptChars = boundedInteger(
        options.maxExcerptChars ?? contextService.config?.maxExcerptChars ?? process.env.AI_AGENT_MAX_EXCERPT_CHARS,
        600,
        64,
        2000
    );
    const maxToolCalls = boundedInteger(
        options.maxToolCalls ?? process.env.AI_AGENT_MAX_TOOL_RESULTS,
        8,
        1,
        8
    );
    const maxContextChars = boundedInteger(
        options.maxContextChars ?? process.env.AI_AGENT_MAX_CONTEXT_CHARS,
        6000,
        512,
        12000
    );

    const policies = Object.freeze({
        build_recall_candidates: Object.freeze({ maxCalls: 1, maxResultChars: Math.min(maxContextChars, 5000) }),
        get_thought_excerpt: Object.freeze({ maxCalls: 3, maxResultChars: Math.min(maxContextChars, maxExcerptChars + 1600) }),
        get_notepad_excerpt: Object.freeze({ maxCalls: 2, maxResultChars: Math.min(maxContextChars, maxExcerptChars + 800) }),
        get_thought_relations: Object.freeze({ maxCalls: 2, maxResultChars: Math.min(maxContextChars, 3000) })
    });

    const definitions = Object.freeze([
        {
            name: 'build_recall_candidates',
            description: 'Build the server-bounded candidate set for the locked Thought. Call once before requesting excerpts.',
            strict: true,
            parameters: { type: 'object', properties: {}, additionalProperties: false }
        },
        {
            name: 'get_thought_excerpt',
            description: 'Read a short excerpt of a Thought already returned in this run’s candidate set.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string', minLength: 1 },
                    maxChars: { type: 'integer', minimum: 1, maximum: maxExcerptChars }
                }
            }
        },
        {
            name: 'get_notepad_excerpt',
            description: 'Read a short excerpt of a Notepad already returned in this run’s candidate set.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string', minLength: 1 },
                    maxChars: { type: 'integer', minimum: 1, maximum: maxExcerptChars }
                }
            }
        },
        {
            name: 'get_thought_relations',
            description: 'Read compact relation signals for the primary Thought or a Thought already in this run’s candidate set.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: { id: { type: 'string', minLength: 1 } }
            }
        }
    ]);

    function definitionsForWorkflow(workflowId) {
        if (workflowId !== RECALL_CONTEXT_WORKFLOW_ID) return [];
        return clone(definitions);
    }

    // Keep the short name used by the run service. Definitions are the
    // simplified OpenAI-compatible shape consumed by agent-model-client,
    // which wraps them into `{ type: 'function', function: ... }` on the wire.
    function getDefinitions(workflowId) {
        return definitionsForWorkflow(workflowId);
    }

    function policiesForWorkflow(workflowId) {
        if (workflowId !== RECALL_CONTEXT_WORKFLOW_ID) return {};
        return clone(policies);
    }

    function normalizeArgs(name, rawArgs) {
        const args = objectArgs(rawArgs || {});
        if (name === 'build_recall_candidates') {
            assertOnlyKeys(args, []);
            return {};
        }
        if (name === 'get_thought_excerpt' || name === 'get_notepad_excerpt') {
            assertOnlyKeys(args, ['id', 'maxChars']);
            const id = normalizeId(args);
            if (args.maxChars === undefined) return { id, maxChars: maxExcerptChars };
            const requested = Number(args.maxChars);
            if (!Number.isFinite(requested) || requested <= 0 || !Number.isInteger(requested)) {
                throw new AgentToolError('invalid_tool_args', 'maxChars must be a positive integer');
            }
            return { id, maxChars: Math.min(maxExcerptChars, requested) };
        }
        if (name === 'get_thought_relations') {
            assertOnlyKeys(args, ['id']);
            return { id: normalizeId(args) };
        }
        throw new AgentToolError('unknown_tool', 'This tool is not enabled');
    }

    async function dispatch(run, name, args) {
        if (name === 'build_recall_candidates') return contextService.buildRecallCandidates({ run });
        if (name === 'get_thought_excerpt') return contextService.getThoughtExcerpt({ run, ...args });
        if (name === 'get_notepad_excerpt') return contextService.getNotepadExcerpt({ run, ...args });
        if (name === 'get_thought_relations') return contextService.getThoughtRelations({ run, ...args });
        throw new AgentToolError('unknown_tool', 'This tool is not enabled');
    }

    async function execute({ run, name, args } = {}) {
        if (!run || typeof run !== 'object') {
            throw new AgentToolError('invalid_run', 'A run record is required to execute a tool');
        }
        if (run.workflowId !== RECALL_CONTEXT_WORKFLOW_ID) {
            throw new AgentToolError('workflow_not_allowed', 'This run cannot access recall_context tools');
        }
        if (!RECALL_CONTEXT_TOOL_NAMES.includes(name)) {
            throw new AgentToolError('unknown_tool', 'This tool is not enabled for recall_context');
        }

        const policy = policies[name];
        const usage = normalizeUsage(run.toolUsage);
        if (usage.totalCalls >= maxToolCalls) {
            throw new AgentToolError('tool_call_budget_exceeded', 'The run exhausted its total tool-call budget');
        }
        if (usage.calls[name] >= policy.maxCalls) {
            throw new AgentToolError('tool_call_budget_exceeded', `The run exhausted the ${name} call budget`);
        }

        const normalizedArgs = normalizeArgs(name, args);
        const previousAllowedReadSet = Array.isArray(run.allowedReadSet) ? run.allowedReadSet.slice() : run.allowedReadSet;
        let result;
        try {
            result = await dispatch(run, name, normalizedArgs);
        } catch (error) {
            if (error instanceof AgentContextError) throw error;
            throw error;
        }

        const resultChars = jsonCharLength(result);
        if (resultChars > policy.maxResultChars || usage.contextChars + resultChars > maxContextChars) {
            run.allowedReadSet = previousAllowedReadSet;
            throw new AgentToolError('context_budget_exceeded', 'The tool result exceeds this run’s fixed context budget');
        }

        usage.calls[name] += 1;
        usage.totalCalls += 1;
        usage.contextChars += resultChars;
        run.toolUsage = usage;
        const sourceRefs = Array.isArray(result?.sourceRefs)
            ? result.sourceRefs
            : (result?.sourceRef ? [result.sourceRef] : []);
        const data = { ...(result || {}) };
        // allowedReadSet is server-owned authorization state. It is returned
        // alongside the model-visible data for the run service to persist, not
        // embedded in the content it sends to a model.
        delete data.allowedReadSet;
        return {
            data,
            sourceRefs,
            allowedReadSet: Array.isArray(run.allowedReadSet) ? run.allowedReadSet.slice() : []
        };
    }

    return {
        workflowId: RECALL_CONTEXT_WORKFLOW_ID,
        toolNames: RECALL_CONTEXT_TOOL_NAMES,
        definitionsForWorkflow,
        getDefinitions,
        policiesForWorkflow,
        execute,
        config: Object.freeze({ maxExcerptChars, maxToolCalls, maxContextChars })
    };
}

module.exports = {
    AgentToolError,
    RECALL_CONTEXT_TOOL_NAMES,
    RECALL_CONTEXT_WORKFLOW_ID,
    createAgentToolRegistry
};
