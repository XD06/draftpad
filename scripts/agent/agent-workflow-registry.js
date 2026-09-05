const {
    RECALL_CONTEXT_TOOL_NAMES,
    RECALL_CONTEXT_WORKFLOW_ID
} = require('./agent-tool-registry');

class AgentWorkflowError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AgentWorkflowError';
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

/**
 * The P0 registry is intentionally closed: this module describes only the
 * read-only Thought recall workflow. Adding another workflow must be an
 * explicit code change, not a runtime/model-provided registration.
 */
function createAgentWorkflowRegistry(options = {}) {
    const maxSteps = boundedInteger(
        options.maxSteps ?? process.env.AI_AGENT_MAX_STEPS,
        3,
        1,
        3
    );

    const recallContext = Object.freeze({
        id: RECALL_CONTEXT_WORKFLOW_ID,
        title: '找回相关内容',
        primarySourceKind: 'thought',
        readOnly: true,
        writeLevel: 'none',
        maxSteps,
        allowedTools: [...RECALL_CONTEXT_TOOL_NAMES],
        output: {
            kind: 'recall_result',
            requiresCitations: true,
            allowsProposal: false
        }
    });

    function getWorkflow(workflowId) {
        if (workflowId !== RECALL_CONTEXT_WORKFLOW_ID) return null;
        return clone(recallContext);
    }

    function listWorkflows() {
        return [clone(recallContext)];
    }

    function resolveWorkflow({ workflowId, primarySourceKind } = {}) {
        const workflow = getWorkflow(workflowId);
        if (!workflow) {
            throw new AgentWorkflowError('workflow_not_found', 'This workflow is not registered');
        }
        if (primarySourceKind && primarySourceKind !== workflow.primarySourceKind) {
            throw new AgentWorkflowError('invalid_primary_source', 'recall_context can only start from a Thought');
        }
        return workflow;
    }

    function assertToolAllowed(workflowId, toolName) {
        const workflow = resolveWorkflow({ workflowId });
        if (!workflow.allowedTools.includes(toolName)) {
            throw new AgentWorkflowError('tool_not_allowed', 'This tool is not allowed by the selected workflow');
        }
        return true;
    }

    return {
        getWorkflow,
        // `get` and `resolve` keep the registry ergonomic for both route and
        // run-service callers without opening a dynamic registration API.
        get: getWorkflow,
        resolveWorkflow,
        resolve: resolveWorkflow,
        listWorkflows,
        assertToolAllowed
    };
}

module.exports = {
    AgentWorkflowError,
    createAgentWorkflowRegistry
};
