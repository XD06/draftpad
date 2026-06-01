function registerSearchRoutes(app, context) {
    const { searchNotepads } = context;

    app.get('/api/search', async (req, res) => {
        const query = req.query.query || req.query.q || '';
        const results = await searchNotepads(query);

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
