const { createAnalysisSourceSignature } = require('../thought-ai-source');
const { createSourceRef, assertValidSourceRef } = require('./agent-contracts');

const MAX_RECALL_CANDIDATES = 8;
const MAX_RELATION_ROWS_TO_INSPECT = 24;
const MAX_CANDIDATE_SNIPPET_CHARS = 220;
const MAX_LABEL_CHARS = 120;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 48;
const MAX_SUBITEMS = 4;
const MAX_SUBITEM_CHARS = 140;
const MAX_RELATION_REASONS = 3;
const MAX_RELATION_REASON_CHARS = 120;
const MAX_RELATION_SIGNALS = 6;
const PUBLIC_RELATION_SIGNAL_KEYS = new Set([
    'vector', 'keyword', 'tag', 'entity', 'topic', 'intent', 'reranker', 'manual'
]);

class AgentContextError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AgentContextError';
        this.code = code;
    }
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asId(value) {
    const id = String(value || '').trim();
    if (!id) throw new AgentContextError('invalid_request', 'A non-empty resource id is required');
    return id;
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
}

function clipText(value, maxChars) {
    return String(value || '').slice(0, Math.max(0, maxChars));
}

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function labelForThought(thought) {
    const firstLine = String(thought?.text || '')
        .split(/\r?\n/)
        .map(normalizeWhitespace)
        .find(Boolean);
    return clipText(firstLine || 'Untitled Thought', MAX_LABEL_CHARS);
}

function labelForNotepad(notepad) {
    return clipText(normalizeWhitespace(notepad?.name) || 'Untitled Notepad', MAX_LABEL_CHARS);
}

function versionOf(resource) {
    return Math.max(0, Math.floor(finiteNumber(resource?.version, 0)));
}

function locationFor(start, excerpt) {
    const safeStart = Math.max(0, Math.floor(finiteNumber(start, 0)));
    return { start: safeStart, end: safeStart + String(excerpt || '').length };
}

function sourceRefKey(sourceRef) {
    const location = sourceRef.location || {};
    return [
        sourceRef.kind,
        sourceRef.id,
        sourceRef.version,
        sourceRef.excerptHash,
        location.start,
        location.end
    ].join(':');
}

function uniqueSourceRefs(sourceRefs) {
    const seen = new Set();
    const result = [];
    for (const sourceRef of asArray(sourceRefs)) {
        const normalized = assertValidSourceRef(sourceRef);
        const key = sourceRefKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
    }
    return result;
}

function normalizedActor(actor) {
    if (typeof actor === 'string' && actor.trim()) return { id: actor.trim() };
    if (actor && typeof actor === 'object') {
        const id = String(actor.id || actor.actorId || '').trim();
        if (id) return { ...actor, id };
    }
    throw new AgentContextError('invalid_actor', 'An explicit actor is required for agent context reads');
}

function actorForRun(run) {
    if (run?.actor) return run.actor;
    return {
        actorId: run?.actorId,
        objectScope: run?.objectScope
    };
}

function compactTags(tags) {
    return asArray(tags)
        .map(tag => clipText(normalizeWhitespace(tag), MAX_TAG_CHARS))
        .filter(Boolean)
        .slice(0, MAX_TAGS);
}

function compactSubItems(subItems) {
    return asArray(subItems)
        .slice(0, MAX_SUBITEMS)
        .map(item => ({
            text: clipText(String(item?.text || ''), MAX_SUBITEM_CHARS),
            completed: Boolean(item?.completed)
        }))
        .filter(item => item.text);
}

function compactSignals(signals) {
    const result = {};
    for (const [key, value] of Object.entries(signals || {})) {
        if (Object.keys(result).length >= MAX_RELATION_SIGNALS) break;
        if (!PUBLIC_RELATION_SIGNAL_KEYS.has(key)) continue;
        const score = Number(value);
        if (!Number.isFinite(score)) continue;
        result[clipText(key, 32)] = Number(score.toFixed(4));
    }
    return result;
}

function compactRelation(edge, state) {
    const targetId = String(edge?.targetId || '').trim();
    if (!targetId) return null;
    const relation = {
        targetId,
        state,
        score: Number(finiteNumber(edge?.score, 0).toFixed(4)),
        confidence: Number(finiteNumber(edge?.confidence, 0).toFixed(4)),
        relationType: clipText(normalizeWhitespace(edge?.relationType), 48),
        method: clipText(normalizeWhitespace(edge?.method || edge?.source), 48),
        reasons: asArray(edge?.reasons)
            .map(reason => clipText(normalizeWhitespace(reason), MAX_RELATION_REASON_CHARS))
            .filter(Boolean)
            .slice(0, MAX_RELATION_REASONS)
    };
    const signals = compactSignals(edge?.signals);
    if (Object.keys(signals).length) relation.signals = signals;
    return relation;
}

function relationPriority(relation) {
    return Math.max(finiteNumber(relation?.score, 0), finiteNumber(relation?.confidence, 0));
}

function recallQueryFor(thought) {
    const tags = compactTags(thought?.tags).slice(0, 2);
    const body = normalizeWhitespace([
        thought?.text || '',
        ...asArray(thought?.subItems).map(item => item?.text || '')
    ].join(' '));
    const parts = [...tags, body].filter(Boolean);
    return clipText(parts.join(' '), 96);
}

function excerptAt(content, requestedStart, maxChars) {
    const text = String(content || '');
    const start = Math.max(0, Math.min(text.length, Math.floor(finiteNumber(requestedStart, 0))));
    return {
        start,
        excerpt: text.slice(start, start + Math.max(0, maxChars))
    };
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Creates the read-only context boundary for the first agent workflow.
 *
 * It intentionally depends only on narrow storage read methods and an optional
 * already-built search-index function. It never calls readThoughts(),
 * getSearchDocuments(), or any storage write method.
 */
function createAgentContextService(options = {}) {
    const storage = options.storage || require('../storage');
    const searchNotepads = typeof options.searchNotepads === 'function' ? options.searchNotepads : null;
    const getNotepadMeta = typeof options.getNotepadMeta === 'function' ? options.getNotepadMeta : null;
    const maxCandidates = boundedInteger(
        options.maxCandidates ?? process.env.AI_AGENT_MAX_TOOL_RESULTS,
        MAX_RECALL_CANDIDATES,
        1,
        MAX_RECALL_CANDIDATES
    );
    const maxExcerptChars = boundedInteger(
        options.maxExcerptChars ?? process.env.AI_AGENT_MAX_EXCERPT_CHARS,
        600,
        64,
        2000
    );
    const maxRelationItems = boundedInteger(options.maxRelationItems, maxCandidates, 1, MAX_RECALL_CANDIDATES);
    const authorizeRead = typeof options.authorizeRead === 'function'
        ? options.authorizeRead
        : ({ actor }) => actor.id === 'local-owner' && (!actor.objectScope || actor.objectScope === 'local-all');

    async function assertAuthorized(actor, resource, run) {
        const normalized = normalizedActor(actor);
        const allowed = await authorizeRead({ actor: normalized, resource, run });
        if (allowed !== true) {
            throw new AgentContextError('forbidden', 'The actor cannot read this agent context resource');
        }
        return normalized;
    }

    async function isAuthorized(actor, resource, run) {
        try {
            await assertAuthorized(actor, resource, run);
            return true;
        } catch (error) {
            if (error instanceof AgentContextError && error.code === 'forbidden') return false;
            throw error;
        }
    }

    function makeThoughtSourceRef(thought, excerpt, start = 0) {
        return createSourceRef({
            kind: 'thought',
            id: asId(thought?.id),
            version: versionOf(thought),
            label: labelForThought(thought),
            location: locationFor(start, excerpt),
            excerpt: String(excerpt || '')
        });
    }

    function makeNotepadSourceRef(notepad, excerpt, start = 0) {
        return createSourceRef({
            kind: 'notepad',
            id: asId(notepad?.id),
            version: versionOf(notepad),
            label: labelForNotepad(notepad),
            location: locationFor(start, excerpt),
            excerpt: String(excerpt || '')
        });
    }

    function sourceRefsForRun(run) {
        const values = [];
        if (run?.primarySource) values.push(run.primarySource);
        if (run?.sourceSnapshot?.sourceRef) values.push(run.sourceSnapshot.sourceRef);
        values.push(...asArray(run?.allowedReadSet));
        return uniqueSourceRefs(values);
    }

    function primarySourceForRun(run) {
        const primary = run?.primarySource || run?.sourceSnapshot?.sourceRef;
        if (!primary) {
            throw new AgentContextError('invalid_run', 'The run does not include a primary source snapshot');
        }
        const sourceRef = assertValidSourceRef(primary);
        if (sourceRef.kind !== 'thought') {
            throw new AgentContextError('invalid_run', 'recall_context requires a Thought primary source');
        }
        return sourceRef;
    }

    function appendAllowedSourceRefs(run, sourceRefs) {
        if (!run || typeof run !== 'object') {
            throw new AgentContextError('invalid_run', 'A mutable run record is required');
        }
        run.allowedReadSet = uniqueSourceRefs([...sourceRefsForRun(run), ...asArray(sourceRefs)]);
        return run.allowedReadSet;
    }

    function allowedRefsForObject(run, kind, id) {
        const resourceId = asId(id);
        return sourceRefsForRun(run).filter(sourceRef => sourceRef.kind === kind && sourceRef.id === resourceId);
    }

    async function readAllowedThought(run, id) {
        const thoughtId = asId(id);
        const refs = allowedRefsForObject(run, 'thought', thoughtId);
        if (!refs.length) {
            throw new AgentContextError('not_in_allowed_read_set', 'The requested Thought is outside this run’s allowed read set');
        }
        const actor = normalizedActor(actorForRun(run));
        await assertAuthorized(actor, { kind: 'thought', id: thoughtId }, run);
        const thought = await storage.readThought(thoughtId);
        if (!thought) throw new AgentContextError('not_found', 'The requested Thought no longer exists');
        const version = versionOf(thought);
        const allowedRef = refs.find(sourceRef => sourceRef.version === version);
        if (!allowedRef) {
            throw new AgentContextError('stale_source', 'The requested Thought changed after this run’s source set was created');
        }
        return { thought, allowedRef };
    }

    async function findNotepadMetaById(id) {
        const notepadId = asId(id);
        if (getNotepadMeta) return (await getNotepadMeta(notepadId)) || null;
        if (typeof storage.readNotepadsMeta !== 'function') {
            throw new AgentContextError('context_unavailable', 'Notepad metadata reader is not configured');
        }
        const meta = await storage.readNotepadsMeta();
        return asArray(meta?.notepads).find(notepad => String(notepad?.id || '') === notepadId) || null;
    }

    async function findNotepadMetasById(ids) {
        const uniqueIds = [...new Set(asArray(ids).map(asId))];
        if (!uniqueIds.length) return new Map();
        if (getNotepadMeta) {
            const items = await Promise.all(uniqueIds.map(async id => [id, await getNotepadMeta(id)]));
            return new Map(items.filter(([, notepad]) => notepad?.id));
        }
        if (typeof storage.readNotepadsMeta !== 'function') {
            throw new AgentContextError('context_unavailable', 'Notepad metadata reader is not configured');
        }
        const meta = await storage.readNotepadsMeta();
        const byId = new Map(asArray(meta?.notepads).map(notepad => [String(notepad?.id || ''), notepad]));
        return new Map(uniqueIds.map(id => [id, byId.get(id)]).filter(([, notepad]) => notepad?.id));
    }

    async function readAllowedNotepad(run, id) {
        const notepadId = asId(id);
        const refs = allowedRefsForObject(run, 'notepad', notepadId);
        if (!refs.length) {
            throw new AgentContextError('not_in_allowed_read_set', 'The requested Notepad is outside this run’s allowed read set');
        }
        const actor = normalizedActor(actorForRun(run));
        await assertAuthorized(actor, { kind: 'notepad', id: notepadId }, run);
        const notepad = await findNotepadMetaById(notepadId);
        if (!notepad) throw new AgentContextError('not_found', 'The requested Notepad no longer exists');
        const version = versionOf(notepad);
        const allowedRef = refs.find(sourceRef => sourceRef.version === version);
        if (!allowedRef) {
            throw new AgentContextError('stale_source', 'The requested Notepad changed after this run’s source set was created');
        }
        return { notepad, allowedRef };
    }

    function thoughtOverview(thought, { relation = null, snippet, snippetStart = 0 } = {}) {
        const excerpt = clipText(snippet ?? thought?.text ?? '', Math.min(maxExcerptChars, MAX_CANDIDATE_SNIPPET_CHARS));
        const sourceRef = makeThoughtSourceRef(thought, excerpt, snippetStart);
        const overview = {
            kind: 'thought',
            id: sourceRef.id,
            title: sourceRef.label,
            version: sourceRef.version,
            createdAt: finiteNumber(thought?.createdAt, 0),
            updatedAt: finiteNumber(thought?.updatedAt || thought?.createdAt, 0),
            completed: Boolean(thought?.completed),
            pinned: Boolean(thought?.pinned),
            tags: compactTags(thought?.tags),
            snippet: excerpt,
            sourceRef
        };
        if (relation) overview.relation = relation;
        return overview;
    }

    function notepadOverview(notepad, result = {}) {
        const rawStart = Math.max(0, Math.floor(finiteNumber(result?.snippetStart, 0)));
        const excerpt = clipText(result?.snippet || result?.name || notepad?.name || '', Math.min(maxExcerptChars, MAX_CANDIDATE_SNIPPET_CHARS));
        const sourceRef = makeNotepadSourceRef(notepad, excerpt, rawStart);
        return {
            kind: 'notepad',
            id: sourceRef.id,
            title: sourceRef.label,
            version: sourceRef.version,
            createdAt: finiteNumber(notepad?.createdAt, 0),
            updatedAt: finiteNumber(notepad?.updatedAt || notepad?.createdAt, 0),
            snippet: excerpt,
            matchType: clipText(normalizeWhitespace(result?.matchType), 32),
            sourceRef
        };
    }

    async function snapshotThought({ actor, thoughtId } = {}) {
        const id = asId(thoughtId);
        const normalized = await assertAuthorized(actor, { kind: 'thought', id }, null);
        const thought = await storage.readThought(id);
        if (!thought) throw new AgentContextError('not_found', 'The requested Thought no longer exists');

        const signature = createAnalysisSourceSignature(thought);
        const excerpt = clipText(thought.text, maxExcerptChars);
        const sourceRef = makeThoughtSourceRef(thought, excerpt, 0);
        return {
            kind: 'thought',
            id: sourceRef.id,
            version: sourceRef.version,
            semanticHash: `sha256:${signature.hash}`,
            signature: {
                version: signature.version,
                hash: signature.hash
            },
            sourceRef,
            // This is intentionally a capped projection rather than the raw
            // storage record. The run service may place it in the initial
            // model context without also handing the model attachments or a
            // full Thought body.
            thought: {
                id: sourceRef.id,
                title: sourceRef.label,
                version: sourceRef.version,
                excerpt,
                tags: compactTags(thought.tags),
                subItems: compactSubItems(thought.subItems),
                completed: Boolean(thought.completed),
                pinned: Boolean(thought.pinned)
            },
            excerpt,
            recallQuery: recallQueryFor(thought),
            capturedAt: Date.now(),
            actorId: normalized.id
        };
    }

    async function buildRecallCandidates({ run } = {}) {
        const primarySource = primarySourceForRun(run);
        const actor = normalizedActor(actorForRun(run));
        await assertAuthorized(actor, { kind: 'thought', id: primarySource.id }, run);
        appendAllowedSourceRefs(run, [primarySource]);

        const candidates = [];
        const candidateKeys = new Set();
        const addCandidate = candidate => {
            if (!candidate || candidates.length >= maxCandidates) return;
            const key = `${candidate.kind}:${candidate.id}`;
            if (candidateKeys.has(key)) return;
            if (candidate.kind === 'thought' && candidate.id === primarySource.id) return;
            candidateKeys.add(key);
            candidates.push(candidate);
            appendAllowedSourceRefs(run, [candidate.sourceRef]);
        };

        const relations = await storage.readRelations(primarySource.id) || { id: primarySource.id, edges: [] };
        const relationRows = [
            ...asArray(relations.edges).slice(0, MAX_RELATION_ROWS_TO_INSPECT).map(edge => compactRelation(edge, 'confirmed')),
            ...asArray(relations.suggestions).slice(0, MAX_RELATION_ROWS_TO_INSPECT).map(edge => compactRelation(edge, 'suggested'))
        ]
            .filter(Boolean)
            .filter(relation => relation.targetId !== primarySource.id)
            .sort((left, right) => relationPriority(right) - relationPriority(left));

        const uniqueRelations = [];
        const relationTargetIds = new Set();
        for (const relation of relationRows) {
            if (relationTargetIds.has(relation.targetId)) continue;
            relationTargetIds.add(relation.targetId);
            uniqueRelations.push(relation);
            if (uniqueRelations.length >= Math.min(MAX_RELATION_ROWS_TO_INSPECT, maxCandidates * 2)) break;
        }

        const relationOverviews = await mapWithConcurrency(uniqueRelations, 4, async relation => {
            const thought = await storage.readThought(relation.targetId);
            if (!thought) return null;
            if (!await isAuthorized(actor, { kind: 'thought', id: relation.targetId }, run)) return null;
            return thoughtOverview(thought, { relation });
        });
        for (const candidate of relationOverviews) addCandidate(candidate);

        let searchStatus = searchNotepads ? 'skipped' : 'not_configured';
        const recallQuery = clipText(run?.sourceSnapshot?.recallQuery || run?.recallQuery || primarySource.label, 96);
        if (searchNotepads && candidates.length < maxCandidates && recallQuery) {
            try {
                const rawResults = await searchNotepads(recallQuery);
                const searchResults = asArray(rawResults)
                    .filter(result => result && (result.type === 'thought' || result.type === 'notepad'))
                    .slice(0, Math.min(MAX_RELATION_ROWS_TO_INSPECT, maxCandidates * 2));
                const notepadIds = searchResults.filter(result => result.type === 'notepad').map(result => result.id);
                const notepadsById = await findNotepadMetasById(notepadIds);

                const searchOverviews = await mapWithConcurrency(searchResults, 4, async result => {
                    const id = String(result.id || '').trim();
                    if (!id) return null;
                    if (result.type === 'thought') {
                        if (id === primarySource.id) return null;
                        if (!await isAuthorized(actor, { kind: 'thought', id }, run)) return null;
                        const thought = await storage.readThought(id);
                        if (!thought) return null;
                        return thoughtOverview(thought, {
                            snippet: result.snippet || result.name || '',
                            snippetStart: finiteNumber(result.snippetStart, 0)
                        });
                    }
                    const notepad = notepadsById.get(id);
                    if (!notepad) return null;
                    if (!await isAuthorized(actor, { kind: 'notepad', id }, run)) return null;
                    return notepadOverview(notepad, result);
                });
                for (const candidate of searchOverviews) addCandidate(candidate);
                searchStatus = 'ready';
            } catch (error) {
                // Search is a convenience source, not a prerequisite for an
                // otherwise valid relation-based recall result. Do not expose a
                // storage/index implementation error to the model.
                searchStatus = 'unavailable';
            }
        }

        return {
            primarySource,
            candidates,
            count: candidates.length,
            searchStatus,
            sourceRefs: candidates.map(candidate => candidate.sourceRef),
            allowedReadSet: sourceRefsForRun(run)
        };
    }

    async function getThoughtExcerpt({ run, id, maxChars } = {}) {
        const { thought, allowedRef } = await readAllowedThought(run, id);
        const length = boundedInteger(maxChars, maxExcerptChars, 1, maxExcerptChars);
        const { start, excerpt } = excerptAt(thought.text, allowedRef.location?.start, length);
        const sourceRef = makeThoughtSourceRef(thought, excerpt, start);
        appendAllowedSourceRefs(run, [sourceRef]);
        return {
            kind: 'thought',
            id: sourceRef.id,
            title: sourceRef.label,
            version: sourceRef.version,
            excerpt,
            subItems: compactSubItems(thought.subItems),
            tags: compactTags(thought.tags),
            completed: Boolean(thought.completed),
            sourceRef,
            sourceRefs: [sourceRef]
        };
    }

    async function getNotepadExcerpt({ run, id, maxChars } = {}) {
        const { notepad, allowedRef } = await readAllowedNotepad(run, id);
        if (typeof storage.readNoteContent !== 'function') {
            throw new AgentContextError('context_unavailable', 'Notepad content reader is not configured');
        }
        const content = await storage.readNoteContent(notepad);
        const length = boundedInteger(maxChars, maxExcerptChars, 1, maxExcerptChars);
        const { start, excerpt } = excerptAt(content, allowedRef.location?.start, length);
        const sourceRef = makeNotepadSourceRef(notepad, excerpt, start);
        appendAllowedSourceRefs(run, [sourceRef]);
        return {
            kind: 'notepad',
            id: sourceRef.id,
            title: sourceRef.label,
            version: sourceRef.version,
            excerpt,
            sourceRef,
            sourceRefs: [sourceRef]
        };
    }

    async function getThoughtRelations({ run, id } = {}) {
        const { thought } = await readAllowedThought(run, id);
        const relations = await storage.readRelations(thought.id) || { id: thought.id, edges: [] };
        const allowedThoughtIds = new Set(
            sourceRefsForRun(run)
                .filter(sourceRef => sourceRef.kind === 'thought')
                .map(sourceRef => sourceRef.id)
        );
        const visible = (items, state) => asArray(items)
            .map(edge => compactRelation(edge, state))
            .filter(Boolean)
            .filter(relation => allowedThoughtIds.has(relation.targetId))
            .slice(0, maxRelationItems);
        const sourceRefs = sourceRefsForRun(run).filter(sourceRef => sourceRef.kind === 'thought' && sourceRef.id === thought.id);
        return {
            kind: 'thought_relations',
            id: thought.id,
            version: versionOf(thought),
            edges: visible(relations.edges, 'confirmed'),
            suggestions: visible(relations.suggestions, 'suggested'),
            sourceRefs
        };
    }

    return {
        snapshotThought,
        buildRecallCandidates,
        getThoughtExcerpt,
        getNotepadExcerpt,
        getThoughtRelations,
        config: Object.freeze({ maxCandidates, maxExcerptChars, maxRelationItems }),
        _private: {
            recallQueryFor,
            sourceRefsForRun,
            appendAllowedSourceRefs,
            compactRelation,
            AgentContextError
        }
    };
}

module.exports = {
    AgentContextError,
    createAgentContextService
};
