const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadOutbox() {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'thought-outbox.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace('export default class ThoughtOutbox', 'class ThoughtOutbox')
        + '\nmodule.exports = ThoughtOutbox;\n';
    const context = {
        module: { exports: {} },
        exports: {},
        window: { localStorage: null },
        console
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function createStorage() {
    const data = new Map();
    return {
        getItem(key) { return data.get(key) || null; },
        setItem(key, value) { data.set(key, value); }
    };
}

async function run() {
    const ThoughtOutbox = loadOutbox();
    const outbox = new ThoughtOutbox({ storage: createStorage() });
    outbox.enqueueOverwrite({ id: 'thought-1', text: 'local edit', version: 3 });

    let calls = 0;
    const apiClient = {
        async requestOutboxItem() {
            calls += 1;
            const error = new Error('HTTP 409');
            error.status = 409;
            error.body = { currentVersion: 4 };
            throw error;
        }
    };

    const first = await outbox.retry(apiClient);
    assert.strictEqual(calls, 1, 'the queued mutation should be attempted once');
    assert.strictEqual(first.conflicts.length, 1, 'a version conflict should be reported separately');
    assert.strictEqual(first.remaining.length, 1, 'a conflicted local edit must be retained');
    assert.strictEqual(first.remaining[0].state, 'conflict', '409 must mark the item as a conflict');
    assert.strictEqual(first.remaining[0].attempts, 0, '409 must not consume retry attempts');

    await outbox.retry(apiClient);
    assert.strictEqual(calls, 1, 'conflicted mutations must not be retried automatically');

    console.log('Thought outbox conflict checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
