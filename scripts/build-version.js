/**
 * 计算 BUILD_VERSION：基于文件内容 SHA-1（public/、font/ 与 package*.json）生成
 * 10 位稳定指纹作为 Service Worker 缓存名。使用内容哈希而非 mtime，避免 Docker
 * 重建或 git 检出刷新时间戳时误作废全部客户端缓存；启动重写文件仍排除在外。
 */
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

function hashFileContent(filePath) {
    return crypto
        .createHash('sha1')
        .update(fs.readFileSync(filePath))
        .digest('hex')
        .slice(0, 12);
}

function collectDirectoryContentStats(dir, baseDir = dir, prefix = '', stats = []) {
    if (!fs.existsSync(dir)) return stats;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectDirectoryContentStats(fullPath, baseDir, prefix, stats);
            continue;
        }
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (!prefix && GENERATED_ASSET_PATHS.has(relativePath)) continue;
        stats.push([
            prefix ? `${prefix}${relativePath}` : relativePath,
            hashFileContent(fullPath),
        ].join(':'));
    }
    return stats;
}

function collectBuildFingerprintStats(publicDir) {
    const stats = collectDirectoryContentStats(publicDir);
    const rootDir = path.join(__dirname, '..');
    const fontDir = path.join(rootDir, 'font');
    collectDirectoryContentStats(fontDir, fontDir, 'font/', stats);
    for (const fileName of ['package.json', 'package-lock.json']) {
        const filePath = path.join(rootDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        stats.push([
            fileName,
            hashFileContent(filePath),
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
