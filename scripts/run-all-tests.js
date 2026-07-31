#!/usr/bin/env node
// Runs the whole test suite: every test/test_*.js, serially, from the repo root.
// Excludes test_s3_real_smoke.js by default (it needs a live S3 endpoint and an
// explicit confirm env); pass --include-s3-real to run it too.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const includeS3Real = process.argv.includes('--include-s3-real');
const EXCLUDE = new Set(includeS3Real ? [] : ['test_s3_real_smoke.js']);

const files = fs.readdirSync(TEST_DIR)
    .filter(f => /^test_.*\.js$/.test(f) && !EXCLUDE.has(f))
    .sort();

console.log(`Running ${files.length} test files from test/\n`);

const failures = [];
let passed = 0;
const started = Date.now();

for (const file of files) {
    const result = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120000
    });
    if (result.status === 0) {
        passed++;
        console.log(`PASS  ${file}`);
    } else {
        failures.push(file);
        console.log(`FAIL  ${file}  (exit ${result.status})`);
        const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-8).join('\n');
        if (tail) console.log(tail.split('\n').map(l => '      ' + l).join('\n'));
    }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n===== ${passed}/${files.length} passed in ${secs}s =====`);
if (failures.length) {
    console.log('Failed:\n' + failures.map(f => '  - ' + f).join('\n'));
    process.exit(1);
}
