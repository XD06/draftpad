const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-migrate-cli-'));
const sourceDir = path.join(root, 'source data');
const reportDir = path.join(root, 'reports');

fs.mkdirSync(sourceDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(sourceDir, 'notepads.json'), JSON.stringify({
    notepads: [
        { id: 'default', name: 'Default Notepad' },
        { id: 'n1', name: 'Research' }
    ]
}, null, 2));
fs.writeFileSync(path.join(sourceDir, 'thoughts.json'), JSON.stringify([
    { id: 't1', text: 'first thought' },
    { id: 't2', text: 'second thought' }
], null, 2));
fs.writeFileSync(path.join(sourceDir, 'default.txt'), 'default note');
fs.writeFileSync(path.join(sourceDir, 'Research.txt'), 'research note');

const result = spawnSync(process.execPath, [
    path.join(__dirname, 'scripts', 'migrate-local-to-s3.js'),
    '--dry-run',
    '--source-data-dir', sourceDir,
    '--prefix', 'dumbpad-real-preview',
    '--report-dir', reportDir
], {
    cwd: __dirname,
    env: {
        ...process.env,
        STORAGE_LAYOUT: 'split',
        S3_BUCKET: 'dry-run-bucket',
        S3_ACCESS_KEY: '',
        S3_SECRET_KEY: '',
        S3_API_KEY: ''
    },
    encoding: 'utf8'
});

assert(result.status === 0, `dry-run migrate should succeed: ${result.stderr}`);

const output = JSON.parse(result.stdout);
assert(output.dryRun === true, 'output should mark dry-run');
assert(output.dataDir === sourceDir, 'output should include source data dir');
assert(output.prefix === 'dumbpad-real-preview', 'output should include target prefix');
assert(output.sourceSummary.notepadCount === 2, 'output should count notepads');
assert(output.sourceSummary.thoughtCount === 2, 'output should count thoughts');
assert(output.uploaded === 6, 'dry-run should report root files plus split thoughts');
assert(output.missing === 7, 'dry-run should report optional missing directories, including derived agent-runs');
assert(output.reportPath.startsWith(reportDir), 'report should be written to report dir');
assert(fs.existsSync(output.reportPath), 'report file should exist');

const report = JSON.parse(fs.readFileSync(output.reportPath, 'utf8'));
assert(report.uploaded.some(item => item.key === 'dumbpad-real-preview/thoughts/t1.json'), 'report should include split thought t1');
assert(report.uploaded.some(item => item.key === 'dumbpad-real-preview/Research.txt'), 'report should include text note');
assert(report.missing.some(item => item.label === 'agent-runs'), 'report should include the optional derived agent-runs directory');

console.log('Local to S3 migration CLI dry-run checks passed');
