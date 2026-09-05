const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadOutbox() {
    const sourcePath = path.join(__dirname, '..', 'public', 'managers', 'thought-outbox.js');
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
    let mode = '409';
    const lastRequest = {};
    const apiClient = {
        async requestOutboxItem(item) {
            calls += 1;
            lastRequest.item = item;
            if (mode === '409') {
                const error = new Error('HTTP 409');
                error.status = 409;
                error.body = { currentVersion: 4 };
                throw error;
            }
            return { thought: { id: 'thought-1', text: item.body?.text, version: (Number(item.body?.baseVersion) || 0) + 1 } };
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

    // Keep-local resolution: rebasing onto the remote version must clear the
    // conflict and let the next retry resend, so the queue can recover instead
    // of dead-locking forever on "conflict".
    const rebased = outbox.rebaseConflict('thought-1', 4);
    assert.ok(rebased, 'rebaseConflict should return the updated item');
    assert.strictEqual(rebased.state, undefined, 'rebase must clear the conflict state');
    assert.strictEqual(rebased.body.baseVersion, 4, 'rebase must move baseVersion to the remote current version');
    const afterRebase = outbox.load();
    assert.strictEqual(afterRebase.length, 1, 'the rebased edit stays queued');
    assert.strictEqual(afterRebase[0].state, undefined, 'the persisted item must no longer be a conflict');

    mode = 'ok';
    const resolved = await outbox.retry(apiClient);
    assert.strictEqual(calls, 2, 'a rebased edit must be resent on the next retry');
    assert.strictEqual(lastRequest.item.body.baseVersion, 4, 'the resent edit carries the rebased baseVersion');
    assert.strictEqual(resolved.remaining.length, 0, 'a successful resend clears the queue');
    assert.strictEqual(outbox.count(), 0, 'the outbox is empty after recovery');

    // Discard-local resolution must drop the conflicted item entirely so the
    // remote version can win.
    const outbox2 = new ThoughtOutbox({ storage: createStorage() });
    outbox2.enqueueOverwrite({ id: 'thought-2', text: 'local only', version: 1 });
    outbox2.markConflict('thought-2', { currentVersion: 5 });
    assert.strictEqual(outbox2.load()[0].state, 'conflict', 'setup: thought-2 is conflicted');
    const discarded = outbox2.discardConflict('thought-2');
    assert.strictEqual(discarded, true, 'discardConflict should report removal');
    assert.strictEqual(outbox2.count(), 0, 'discarding a conflict empties the queue');

    // A 404 means the Thought no longer exists remotely (deleted on another
    // device, or a pending temp id that never reached the server). The item
    // must be dropped instead of retrying forever with the badge stuck on
    // "待同步".
    const outbox3 = new ThoughtOutbox({ storage: createStorage() });
    outbox3.enqueueOverwrite({ id: 'thought-3', text: 'deleted elsewhere', version: 2 });
    outbox3.enqueueDeleteThought('thought-4');
    let notFoundCalls = 0;
    const failingClient = {
        async requestOutboxItem() {
            notFoundCalls += 1;
            const error = new Error('HTTP 404');
            error.status = 404;
            error.body = { error: 'Thought not found' };
            throw error;
        }
    };
    const dropped = await outbox3.retry(failingClient);
    assert.strictEqual(notFoundCalls, 2, 'both queued items should be attempted once');
    assert.strictEqual(dropped.dropped404.length, 2, '404 answers must be reported as dropped items');
    assert.strictEqual(dropped.remaining.length, 0, '404 answers must not stay queued');
    assert.strictEqual(outbox3.count(), 0, 'the outbox must be empty after 404 drops');
    assert.strictEqual(dropped.changed, true, 'dropping 404 items counts as a queue change');
    await outbox3.retry(failingClient);
    assert.strictEqual(notFoundCalls, 2, 'dropped items must not be retried again');

    console.log('Thought outbox conflict checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
