function registerSearchRoutes(app, context) {
    const { searchNotepads, storage } = context;

    function thoughtSearchResult(thought, query) {
        const text = String(thought?.text || '');
        const subItems = Array.isArray(thought?.subItems) ? thought.subItems : [];
        const tags = Array.isArray(thought?.tags) ? thought.tags : [];
        const lowerQuery = String(query || '').trim().toLowerCase();
        const matchedSubItem = subItems.find(item => String(item?.text || '').toLowerCase().includes(lowerQuery));
        const matchedTag = tags.find(tag => String(tag || '').toLowerCase().includes(lowerQuery));
        const matchType = text.toLowerCase().includes(lowerQuery) ? 'text' : (matchedSubItem ? 'subitem' : 'tag');
        const source = matchType === 'subitem' ? String(matchedSubItem.text || '') : (matchType === 'tag' ? String(matchedTag || '') : text);
        const matchStart = lowerQuery ? source.toLowerCase().indexOf(lowerQuery) : 0;
        const start = matchStart > 36 ? matchStart - 36 : 0;
        const end = Math.min(source.length, Math.max(start + 96, matchStart + lowerQuery.length + 36));
        const snippet = `${start > 0 ? '...' : ''}${source.slice(start, end).trim()}${end < source.length ? '...' : ''}`;
        return {
            id: String(thought.id),
            type: 'thought',
            title: text.length > 80 ? `${text.slice(0, 80).trim()}...` : text,
            name: snippet || text,
            snippet,
            snippetStart: start,
            snippetPrefixLength: start > 0 ? 3 : 0,
            matchType,
            matches: []
        };
    }

    async function searchThoughts(query) {
        const lowerQuery = String(query || '').trim().toLowerCase();
        const thoughts = await storage.readThoughts();
        return thoughts
            .filter(thought => !lowerQuery
                || String(thought?.text || '').toLowerCase().includes(lowerQuery)
                || (thought?.subItems || []).some(item => String(item?.text || '').toLowerCase().includes(lowerQuery))
                || (thought?.tags || []).some(tag => String(tag || '').toLowerCase().includes(lowerQuery)))
            .sort((left, right) => Number(right?.updatedAt || right?.createdAt || 0) - Number(left?.updatedAt || left?.createdAt || 0))
            .map(thought => thoughtSearchResult(thought, query));
    }

    app.get('/api/search', async (req, res) => {
        const query = req.query.query || req.query.q || '';
        const scope = String(req.query.scope || 'notepads').toLowerCase();
        if (!['notepads', 'thoughts', 'all'].includes(scope)) {
            return res.status(400).json({ error: 'scope must be notepads, thoughts, or all', code: 'INVALID_SEARCH_SCOPE' });
        }
        const [notepadResults, thoughtResults] = await Promise.all([
            scope === 'thoughts' ? [] : searchNotepads(query),
            scope === 'notepads' ? [] : searchThoughts(query)
        ]);
        const results = [...notepadResults, ...thoughtResults];

        const page = parseInt(req.query.page) || 1;
        const requestedPageSize = parseInt(req.query.pageSize);
        const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
            ? requestedPageSize
            : (results.length || 10);
        const paginatedResults = results.slice((page - 1) * pageSize, page * pageSize);
        res.json({
            results: paginatedResults,
            totalPages: results.length === 0 ? 0 : Math.ceil(results.length / pageSize),
            currentPage: page
        });
    });
}

module.exports = { registerSearchRoutes };
