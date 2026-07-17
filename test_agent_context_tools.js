const assert = require('assert');
const { createAgentContextService, AgentContextError } = require('./scripts/agent/agent-context-service');
const { createAgentToolRegistry, AgentToolError, RECALL_CONTEXT_TOOL_NAMES } = require('./scripts/agent/agent-tool-registry');
const { createAgentWorkflowRegistry, AgentWorkflowError } = require('./scripts/agent/agent-workflow-registry');
const { toOpenAITools } = require('./scripts/agent/agent-model-client');

function makeFixture() {
    const sourceText = 'DumbPad 的 Agent 应该只读取有限上下文，并且每一条结论都能回到真实来源。'.repeat(8);
    const thoughts = {
        source: {
            id: 'source',
            version: 4,
            text: sourceText,
            tags: ['AI', '架构'],
            subItems: [{ text: '验证引用和权限边界', completed: false }],
            createdAt: 100,
            updatedAt: 120,
            completed: false,
            pinned: true,
            attachments: [{ id: 'should-never-be-returned' }]
        },
        related: {
            id: 'related',
            version: 2,
            text: '关联候选必须先由服务端生成，模型不能浏览全部 Thought。'.repeat(5),
            tags: ['AI', '安全'],
            subItems: [{ text: '限制 allowedReadSet', completed: true }],
            createdAt: 200,
            updatedAt: 220,
            completed: true
        },
        indexedThought: {
            id: 'indexed-thought',
            version: 3,
            text: '搜索索引只提供一个简短 Thought 候选。',
            tags: ['检索'],
            createdAt: 300,
            updatedAt: 310
        },
        outside: {
            id: 'outside',
            version: 1,
            text: '这个 Thought 不在本次候选集合。',
            tags: [],
            createdAt: 400,
            updatedAt: 410
        }
    };
    const relations = {
        source: {
            id: 'source',
            edges: [{
                targetId: 'related',
                score: 0.91,
                confidence: 0.88,
                relationType: 'same_topic',
                method: 'rerank',
                reasons: ['共享有限上下文原则', '不应暴露整库', '第三个理由', '不得泄露'],
                signals: { vector: 0.9, entity: 0.8, internalPrompt: 0.99 }
            }],
            suggestions: [{ targetId: 'outside', score: 0.01, reasons: ['低分候选'] }]
        },
        related: {
            id: 'related',
            edges: [{ targetId: 'source', score: 0.91, reasons: ['双向关系'] }],
            suggestions: []
        }
    };
    const notepads = [{
        id: 'note-api',
        name: 'Agent API 设计说明',
        version: 7,
        createdAt: 500,
        updatedAt: 510
    }];
    const noteContent = 'Notepad 也只能按候选读取一个短片段，绝不能把完整 Markdown 直接交给模型。'.repeat(8);
    const calls = {
        readThought: 0,
        readRelations: 0,
        readNotepadsMeta: 0,
        readNoteContent: 0,
        readThoughts: 0,
        getSearchDocuments: 0,
        writes: 0,
        search: 0
    };
    const storage = {
        async readThought(id) {
            calls.readThought += 1;
            return thoughts[id] || null;
        },
        async readRelations(id) {
            calls.readRelations += 1;
            return relations[id] || { id, edges: [], suggestions: [] };
        },
        async readNotepadsMeta() {
            calls.readNotepadsMeta += 1;
            return { notepads };
        },
        async readNoteContent(notepad) {
            calls.readNoteContent += 1;
            assert.strictEqual(notepad.id, 'note-api');
            return noteContent;
        },
        async readThoughts() {
            calls.readThoughts += 1;
            throw new Error('Agent context must not scan all Thoughts');
        },
        async getSearchDocuments() {
            calls.getSearchDocuments += 1;
            throw new Error('Agent context must not build its own full search documents');
        },
        async writeThought() {
            calls.writes += 1;
            throw new Error('Agent context must never write');
        }
    };
    async function searchNotepads(query) {
        calls.search += 1;
        assert(query.includes('AI') || query.includes('Agent') || query.includes('DumbPad'));
        return [
            {
                id: 'note-api',
                type: 'notepad',
                title: 'Agent API 设计说明',
                snippet: 'API 文档中的有限上下文与引用约束。',
                snippetStart: 5,
                matchType: 'content'
            },
            {
                id: 'indexed-thought',
                type: 'thought',
                title: '搜索 Thought',
                snippet: '搜索索引中的 Thought 候选。',
                snippetStart: 0,
                matchType: 'content'
            }
        ];
    }
    return { storage, calls, searchNotepads, sourceText, noteContent, thoughts };
}

function actor() {
    return { id: 'local-owner', objectScope: 'local-all' };
}

async function expectCode(promise, ErrorType, code) {
    await assert.rejects(promise, error => error instanceof ErrorType && error.code === code);
}

async function run() {
    const fixture = makeFixture();
    const context = createAgentContextService({
        storage: fixture.storage,
        searchNotepads: fixture.searchNotepads,
        maxCandidates: 3,
        maxExcerptChars: 120
    });

    const snapshot = await context.snapshotThought({ actor: actor(), thoughtId: 'source' });
    assert.strictEqual(snapshot.kind, 'thought');
    assert.strictEqual(snapshot.version, 4, 'snapshot should preserve the Thought version');
    assert.match(snapshot.semanticHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(snapshot.signature.hash, /^[a-f0-9]{64}$/);
    assert(snapshot.excerpt.length <= 120, 'primary source model excerpt must be capped');
    assert(snapshot.thought.excerpt.length <= 120, 'snapshot projection must not expose the full Thought body');
    assert.strictEqual(snapshot.sourceRef.version, 4);
    assert.strictEqual(snapshot.thought.attachments, undefined, 'snapshot must not include attachments');

    const runRecord = {
        workflowId: 'recall_context',
        actor: actor(),
        primarySource: snapshot.sourceRef,
        sourceSnapshot: snapshot,
        allowedReadSet: [snapshot.sourceRef]
    };
    const candidates = await context.buildRecallCandidates({ run: runRecord });
    assert(candidates.count <= 3, 'server-built candidates must remain capped at eight or fewer');
    assert(candidates.candidates.some(candidate => candidate.id === 'related'), 'relations should seed Thought candidates');
    assert(candidates.candidates.some(candidate => candidate.id === 'note-api'), 'injected indexed search should seed Notepad candidates');
    assert(candidates.allowedReadSet.some(sourceRef => sourceRef.id === 'related'));
    assert(candidates.allowedReadSet.some(sourceRef => sourceRef.id === 'note-api'));
    assert.strictEqual(fixture.calls.search, 1, 'search must be injected rather than assembled from full documents');
    assert(candidates.candidates.every(candidate => candidate.snippet.length <= 120));
    assert(candidates.candidates.every(candidate => !Object.hasOwn(candidate, 'attachments')));

    const thoughtExcerpt = await context.getThoughtExcerpt({ run: runRecord, id: 'related', maxChars: 999 });
    assert(thoughtExcerpt.excerpt.length <= 120, 'Thought excerpts must be clamped by config');
    assert(thoughtExcerpt.sourceRefs.length === 1);
    assert(runRecord.allowedReadSet.some(sourceRef => sourceRef.excerptHash === thoughtExcerpt.sourceRef.excerptHash));
    assert(thoughtExcerpt.subItems.length <= 4, 'Thought sub-items must be field capped');
    assert.strictEqual(thoughtExcerpt.attachments, undefined, 'Thought excerpts must not expose attachments');

    const noteExcerpt = await context.getNotepadExcerpt({ run: runRecord, id: 'note-api', maxChars: 999 });
    assert(noteExcerpt.excerpt.length <= 120, 'Notepad excerpts must be clamped by config');
    assert.strictEqual(noteExcerpt.sourceRefs[0].kind, 'notepad');
    assert(runRecord.allowedReadSet.some(sourceRef => sourceRef.excerptHash === noteExcerpt.sourceRef.excerptHash));

    const relationData = await context.getThoughtRelations({ run: runRecord, id: 'source' });
    assert(relationData.edges.length <= 3, 'relation output must be field capped');
    assert(relationData.edges.every(edge => edge.targetId !== 'outside' || runRecord.allowedReadSet.some(ref => ref.id === 'outside')),
        'relation output must not expose an unapproved target');
    assert(relationData.edges[0].reasons.length <= 3, 'relation reasons must be capped');
    assert(!Object.hasOwn(relationData.edges[0].signals, 'internalPrompt'), 'non-numeric relation diagnostics must not leak');

    await expectCode(
        context.getThoughtExcerpt({ run: runRecord, id: 'not-in-set', maxChars: 20 }),
        AgentContextError,
        'not_in_allowed_read_set'
    );
    await expectCode(
        context.snapshotThought({ actor: { id: 'other-user' }, thoughtId: 'source' }),
        AgentContextError,
        'forbidden'
    );

    fixture.thoughts.related.version = 3;
    await expectCode(
        context.getThoughtExcerpt({ run: runRecord, id: 'related', maxChars: 20 }),
        AgentContextError,
        'stale_source'
    );
    fixture.thoughts.related.version = 2;

    assert.strictEqual(fixture.calls.readThoughts, 0, 'context service must never full-scan Thoughts');
    assert.strictEqual(fixture.calls.getSearchDocuments, 0, 'context service must never call getSearchDocuments');
    assert.strictEqual(fixture.calls.writes, 0, 'context service must never write storage');

    const restrictedContext = createAgentContextService({
        storage: fixture.storage,
        searchNotepads: fixture.searchNotepads,
        maxCandidates: 4,
        maxExcerptChars: 120,
        authorizeRead: ({ resource }) => resource.id !== 'outside'
    });
    const restrictedSnapshot = await restrictedContext.snapshotThought({ actor: actor(), thoughtId: 'source' });
    const restrictedRun = {
        workflowId: 'recall_context',
        actor: actor(),
        primarySource: restrictedSnapshot.sourceRef,
        sourceSnapshot: restrictedSnapshot,
        allowedReadSet: [restrictedSnapshot.sourceRef]
    };
    const restrictedCandidates = await restrictedContext.buildRecallCandidates({ run: restrictedRun });
    assert(!restrictedCandidates.candidates.some(candidate => candidate.id === 'outside'),
        'a relation outside actor scope must be skipped rather than added to allowedReadSet');

    const toolRun = {
        workflowId: 'recall_context',
        actor: actor(),
        primarySource: snapshot.sourceRef,
        sourceSnapshot: snapshot,
        allowedReadSet: [snapshot.sourceRef]
    };
    const tools = createAgentToolRegistry({ contextService: context, maxContextChars: 6000, maxToolCalls: 8 });
    assert.deepStrictEqual(tools.toolNames, RECALL_CONTEXT_TOOL_NAMES);
    assert.strictEqual(tools.getDefinitions('recall_context').length, 4, 'only the four P0 tools are model-visible');
    assert.strictEqual(toOpenAITools(tools.getDefinitions('recall_context')).length, 4,
        'registry definitions must use the simplified shape consumed by the model client');
    assert.deepStrictEqual(tools.getDefinitions('develop_thought'), [], 'P1 tools must not be exposed');

    const toolCandidates = await tools.execute({ run: toolRun, name: 'build_recall_candidates', args: {} });
    assert(toolCandidates.data.candidates.length <= 3);
    assert(!Object.hasOwn(toolCandidates.data, 'allowedReadSet'), 'allowedReadSet is server-owned, not model-visible data');
    assert(toolCandidates.sourceRefs.length > 0);
    assert(toolCandidates.allowedReadSet.length >= toolCandidates.sourceRefs.length);
    const toolThought = await tools.execute({
        run: toolRun,
        name: 'get_thought_excerpt',
        args: { id: 'related', maxChars: 1000 }
    });
    assert(toolThought.data.excerpt.length <= 120);
    assert.strictEqual(toolThought.sourceRefs[0].id, 'related');
    await expectCode(
        tools.execute({ run: toolRun, name: 'get_thought_excerpt', args: { id: 'related', arbitrary: true } }),
        AgentToolError,
        'invalid_tool_args'
    );
    await expectCode(
        tools.execute({ run: { ...toolRun, workflowId: 'develop_thought' }, name: 'build_recall_candidates', args: {} }),
        AgentToolError,
        'workflow_not_allowed'
    );

    const workflows = createAgentWorkflowRegistry();
    const workflow = workflows.resolve({ workflowId: 'recall_context', primarySourceKind: 'thought' });
    assert.strictEqual(workflow.readOnly, true);
    assert.strictEqual(workflow.writeLevel, 'none');
    assert.deepStrictEqual(workflow.allowedTools, RECALL_CONTEXT_TOOL_NAMES);
    assert.strictEqual(workflows.listWorkflows().length, 1, 'P0 registry must remain closed to future workflows');
    await expectCode(
        Promise.resolve().then(() => workflows.resolve({ workflowId: 'review_inbox' })),
        AgentWorkflowError,
        'workflow_not_found'
    );

    console.log('Agent context/tool/workflow checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
