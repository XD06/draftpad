// 计算 BUILD_VERSION：把 public/ 全目录（路径:size:mtime）与 package.json /
// package-lock.json 的 sha1 前 10 位当作 Service Worker 的缓存名指纹。
// 启动时被重写的生成产物必须排除在指纹之外，否则每次服务重启都会换缓存名。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 这两个文件由 scripts/pwa-manifest-generator.js 在每次启动时 writeFileSync
// 重写——即使内容一字未变，mtime 也会刷新。计入指纹的后果：每次重启都产生
// 新的 BUILD_VERSION，所有客户端判定「有新版本」，重下整套预缓存（约 80 项）
// 并弹一条假的「新版本可用」toast，cache-first 的 vendor/字体缓存也一并失效。
const GENERATED_ASSET_PATHS = new Set([
    'Assets/manifest.json',
    'Assets/asset-manifest.json',
]);

function collectPublicAssetStats(dir, baseDir = dir, stats = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectPublicAssetStats(fullPath, baseDir, stats);
            continue;
        }
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (GENERATED_ASSET_PATHS.has(relativePath)) continue;
        const stat = fs.statSync(fullPath);
        stats.push([
            relativePath,
            stat.size,
            Math.floor(stat.mtimeMs),
        ].join(':'));
    }
    return stats;
}

function collectBuildFingerprintStats(publicDir) {
    const stats = collectPublicAssetStats(publicDir);
    const rootDir = path.join(__dirname, '..');
    for (const fileName of ['package.json', 'package-lock.json']) {
        const filePath = path.join(rootDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);
        stats.push([
            fileName,
            stat.size,
            Math.floor(stat.mtimeMs),
        ].join(':'));
    }
    return stats;
}

function getBuildVersion(publicDir, version = '1.0.0') {
    try {
        const hash = crypto
            .createHash('sha1')
            .update(collectBuildFingerprintStats(publicDir).sort().join('|'))
            .digest('hex')
            .slice(0, 10);
        return `${version}-${hash}`;
    } catch (error) {
        console.warn('Unable to compute asset build version:', error);
        return version;
    }
}

module.exports = { collectBuildFingerprintStats, getBuildVersion, GENERATED_ASSET_PATHS };
