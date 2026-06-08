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

for (const file of files) {
    const relative = path.relative(ROOT, file);
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

console.log(`Checked ${files.length} JavaScript files and verified server startup.`);
