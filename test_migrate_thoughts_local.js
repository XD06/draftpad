const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function runMigration(dataDir, sourcePath, extraArgs = []) {
    const result = spawnSync(process.execPath, [
        'scripts/migrate-thoughts-local.js',
        '--source',
        sourcePath,
        ...extraArgs
    ], {
        cwd: ROOT,
        env: {
            ...process.env,
            DATA_DIR: dataDir,
            OPENCODE_API_KEY: '',
            SILICON_API_KEY: '',
            AI_API_KEY: '',
            AI_EMBEDDING_API_KEY: ''
        },
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        throw new Error(`migration failed: ${result.stderr || result.stdout}`);
    }

    const jsonStart = result.stdout.lastIndexOf('{');
    if (jsonStart === -1) throw new Error(`migration did not print JSON: ${result.stdout}`);
    return JSON.parse(result.stdout.slice(jsonStart));
}

function run() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-migrate-thoughts-'));
    const sourcePath = path.join(dataDir, 'old-thoughts.json');
    const now = Date.now();

    fs.writeFileSync(path.join(dataDir, 'thoughts.json'), JSON.stringify([
        {
            id: 'existing',
            text: 'Existing thought',
            subItems: [],
            tags: ['DumbPad'],
            completed: false,
            version: 1,
            createdAt: now - 1000,
            updatedAt: now - 1000
        }
    ], null, 2));
    fs.writeFileSync(sourcePath, JSON.stringify({
        thoughts: [
            {
                id: 'legacy-a',
                content: 'Legacy imported thought',
                tags: ['#AI', 'AI'],
                tasks: ['first task'],
                created_at: '2026-05-01T00:00:00.000Z'
            },
            {
                id: 'existing',
                text: 'Existing thought',
                tags: ['DumbPad'],
                createdAt: now - 1000
            },
            {
                id: 'empty',
                text: ''
            }
        ]
    }, null, 2));

    const dryRun = runMigration(dataDir, sourcePath, ['--dry-run']);
    assert(dryRun.imported === 1, 'dry run should report one importable thought');
    assert(!dryRun.backup, 'dry run should not write a backup');

    const firstRun = runMigration(dataDir, sourcePath);
    assert(firstRun.imported === 1, 'first run should import one thought');
    assert(firstRun.skipped === 1, 'first run should skip existing duplicate');
    assert(firstRun.invalid === 1, 'first run should report invalid empty thought');
    assert(firstRun.backup && fs.existsSync(firstRun.backup), 'first run should create a backup');

    const thoughts = JSON.parse(fs.readFileSync(path.join(dataDir, 'thoughts.json'), 'utf8'));
    const imported = thoughts.find(thought => thought.id === 'legacy-a');
    assert(imported, 'imported thought should be saved');
    assert(imported.text === 'Legacy imported thought', 'content should be normalized to text');
    assert(imported.tags.length === 1 && imported.tags[0] === 'AI', 'tags should be normalized and deduplicated');
    assert(imported.subItems.length === 1 && imported.subItems[0].text === 'first task', 'tasks should be normalized to subItems');

    const secondRun = runMigration(dataDir, sourcePath);
    assert(secondRun.imported === 0, 'second run should be idempotent');
    assert(secondRun.skipped === 2, 'second run should skip existing imported and original thought');

    console.log('Thought migration checks passed');
}

try {
    run();
} catch (error) {
    console.error(error);
    process.exit(1);
}
