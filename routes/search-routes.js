// Global search route. Thin HTTP boundary over the domain provider registry
// in server/search/: it validates parameters, delegates matching to the
// registry and keeps the historical response contract (results / totalPages
// / currentPage, per-result id/type/title/snippet/matchType/matches) while
// adding multi-keyword AND matching, per-line occurrences and a source type
// on every result. Matching semantics live in server/search, not here.

const { SCOPES, DEFAULT_SCOPE } = require('../server/search/registry.js');

function registerSearchRoutes(app, context) {
    const { searchRegistry } = context;

    app.get('/api/search', async (req, res) => {
        const query = req.query.query || req.query.q || '';
        const scope = String(req.query.scope || DEFAULT_SCOPE).toLowerCase();
        if (!SCOPES.includes(scope)) {
            return res.status(400).json({ error: `scope must be ${SCOPES.join(', ')}`, code: 'INVALID_SEARCH_SCOPE' });
        }

        const { keywords, results } = await searchRegistry.search({ query, scope });

        const page = parseInt(req.query.page) || 1;
        const requestedPageSize = parseInt(req.query.pageSize);
        const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
            ? requestedPageSize
            : (results.length || 10);
        const paginatedResults = results.slice((page - 1) * pageSize, page * pageSize);
        res.json({
            query,
            keywords,
            results: paginatedResults,
            totalPages: results.length === 0 ? 0 : Math.ceil(results.length / pageSize),
            currentPage: page
        });
    });
}

module.exports = { registerSearchRoutes };
