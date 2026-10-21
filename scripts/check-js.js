const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.playwright-cli']);
const SERVER_SMOKE_TIMEOUT_MS = 5000;

function collectJsFiles(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                collectJsFiles(path.join(dir, entry.name), files);
            }
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(path.join(dir, entry.name));
        }
    }

    return files;
}

const files = collectJsFiles(ROOT).sort();
let failed = false;
let skippedVendor = 0;

// public/vendor/** 是 esbuild 的 IIFE 产物（scripts/build-tiptap-bundle.js 生成），
// 不是 ESM 模块，也不由我们手改。对它们做 ESM 解析没有意义：旧实现对每个 .js
// 无条件走 esbuild 的 ESM 解析，体积大的 mermaid bundle 会因 esbuild 常驻进程
// 清理临时文件被 Windows 拒绝访问而报假失败（错误里既没有行号也没有源码片段，
// 只有 "Access is denied"，每次结果随环境抖动）。这里整体跳过 vendor 产物，
// 只检查真正手写/可维护的源码。
const VENDOR_DIR = path.join(ROOT, 'public', 'vendor') + path.sep;
const isVendorArtifact = file => file.startsWith(VENDOR_DIR);

// node --check 以 CJS 规则解析无 type:module 的 .js，会放过部分 ESM 语法错误
// （Chrome 加载时才炸）。追加 esbuild 的 ESM 解析兜底（构建期仅在存在
// node_modules 时启用，Docker 运行时不含 devDependencies 则跳过该步）。
let esbuild = null;
try {
    esbuild = require('esbuild');
} catch (_error) {
    console.warn('esbuild not available; skipping ESM parse check (run npm install in dev to enable)');
}

// esbuild 的 JS API 背后是一个常驻子进程：解析本身不落地文件，但进程退出/复用
// 时会清理自己的临时文件，在受限环境（沙箱、杀毒软件、只读 TEMP）下会抛
// "Access is denied"。这类错误没有 errors[].text、也没有 location——真正的语法
// 错误一定带行列号（实测：`Transform failed with 1 error: … Unexpected ";"`）。
// 两者必须分开：环境问题只告警（否则一次权限抖动就掩盖真实语法错误的信号），
// 语法错误判失败。判定刻意保守：只有「带 text + location 的 esbuild 解析结果」
// 才算语法错误；「无解析结果 + 明确的权限/磁盘错误关键词」才算环境问题；
// 其余无法解释的失败一律按失败处理（不把看不懂的失败冒充成通过）。
function isEnvironmentError(error) {
    const errors = Array.isArray(error?.errors) ? error.errors : [];
    if (errors.some(entry => entry?.text && entry?.location)) return false;
    return /EPERM|EACCES|Access is denied|ENOSPC/i.test(String(error?.message || ''));
}

for (const file of files) {
    const relative = path.relative(ROOT, file);
    if (isVendorArtifact(file)) {
        skippedVendor += 1;
        continue;
    }
    if (esbuild) {
        try {
            esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'js' });
        } catch (error) {
            if (isEnvironmentError(error)) {
                console.warn(`ESM parse check skipped (esbuild environment error): ${relative}`);
            } else {
                const location = error.errors?.[0]?.location;
                failed = true;
                console.error(`ESM parse check failed: ${relative} @ ${location ? `${location.line}:${location.column}` : ''}`);
                if (location?.lineText) console.error(`  ${location.lineText}`);
            }
        }
    }
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: ROOT,
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        failed = true;
        console.error(`Syntax check failed: ${relative}`);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
    }
}

if (failed) {
    process.exit(1);
}

function prepareSmokeDataDir() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-check-'));
    const now = Date.now();
    fs.writeFileSync(
        path.join(dataDir, 'notepads.json'),
        JSON.stringify({
            notepads: [{ id: 'default', name: 'Default Notepad', createdAt: now, updatedAt: now, version: 1 }]
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(dataDir, 'default.txt'), '', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), '[]', 'utf8');
    return dataDir;
}

function runServerSmokeCheck() {
    const dataDir = prepareSmokeDataDir();
    try {
        const result = spawnSync(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: {
                ...process.env,
                PORT: '0',
                BASE_URL: 'http://127.0.0.1:0',
                DATA_DIR: dataDir,
                STORAGE_BACKEND: 'local',
                STORAGE_LAYOUT: 'legacy',
                DUMBPAD_PIN: '',
                AI_API_KEY: '',
                AI_INSIGHT_API_KEY: '',
                AI_INSIGHT_MODEL: '',
                AI_EMBEDDING_API_KEY: '',
                AI_RERANK_API_KEY: '',
                OPENCODE_API_KEY: '',
                SILICON_API_KEY: '',
                NODE_ENV: 'test'
            },
            encoding: 'utf8',
            timeout: SERVER_SMOKE_TIMEOUT_MS
        });

        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (!output.includes('Server is running on port')) {
            console.error('Runtime smoke check failed: server did not start cleanly.');
            if (result.error) console.error(result.error.message);
            if (result.stdout) process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            process.exit(1);
        }
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

runServerSmokeCheck();

const checkedCount = files.length - skippedVendor;
console.log(`Checked ${checkedCount} JavaScript files and verified server startup.`
    + (skippedVendor ? ` (skipped ${skippedVendor} IIFE bundle(s) under public/vendor/)` : ''));
