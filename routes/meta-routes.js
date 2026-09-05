function registerMetaRoutes(app, context) {
    const {
        storage,
        authService = null,
        aiQueue = null,
        agentModelClient = null,
        buildVersion = 'unknown',
        assetMaxFileBytes = 20 * 1024 * 1024
    } = context;

    app.get('/api/meta', (_req, res) => {
        const agent = typeof agentModelClient?.getStatus === 'function'
            ? agentModelClient.getStatus()
            : { enabled: false, ready: false };
        const insight = typeof aiQueue?.getInsightProviderStatus === 'function'
            ? aiQueue.getInsightProviderStatus()
            : { ready: false };
        res.json({
            version: buildVersion,
            auth: { mode: authService ? 'v2' : 'legacy' },
            storage: { backend: storage.backend || 'local' },
            capabilities: {
                agent: { enabled: agent.enabled === true, ready: agent.ready === true },
                ai: { insightReady: insight.ready === true, queueAvailable: typeof aiQueue?.getQueueStatus === 'function' },
                s3: { enabled: storage.backend === 's3' }
            },
            limits: {
                assetMaxFileBytes,
                assetPageMax: 100,
                thoughtPageMax: 50
            }
        });
    });
}

module.exports = { registerMetaRoutes };
