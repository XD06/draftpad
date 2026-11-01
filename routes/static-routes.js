const fs = require('fs').promises;
const path = require('path');

function registerStaticRoutes(app, context) {
    const {
        publicDir,
        assetsDir,
        buildVersion
    } = context;

    app.get('/service-worker.js', async (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        try {
            let swContent = await fs.readFile(path.join(publicDir, 'service-worker.js'), 'utf8');
            swContent = swContent.replace(
                /let APP_VERSION = ".*?";/,
                `let APP_VERSION = "${buildVersion}";`
            );

            res.send(swContent);
        } catch (error) {
            console.error('Error reading service-worker.js:', error);
            res.status(500).send('Error loading service worker');
        }
    });

    const sendAssetManifest = (req, res) => {
        // 两份 manifest 在启动时重写，必须协商缓存让客户端及时拿到新版本。
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(assetsDir, 'asset-manifest.json'));
    };

    const sendPwaManifest = (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(assetsDir, 'manifest.json'));
    };

    app.get('/asset-manifest.json', sendAssetManifest);
    app.get('/Assets/asset-manifest.json', sendAssetManifest);
    app.get('/manifest.json', sendPwaManifest);
    app.get('/Assets/manifest.json', sendPwaManifest);

    // PWA 图标衍生自同一文件名，协商缓存避免启动屏长期滞留旧底色图。
    for (const iconName of ['dumbpad-icon-192.png', 'dumbpad-icon-512.png', 'dumbpad-maskable-512.png']) {
        app.get(`/Assets/${iconName}`, (req, res) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(path.join(assetsDir, iconName));
        });
    }

    app.get('/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
}

module.exports = { registerStaticRoutes };
