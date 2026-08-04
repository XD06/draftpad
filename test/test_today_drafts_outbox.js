const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sourcePath = path.join(ROOT, 'public', 'managers', 'today-drafts', 'today-drafts-outbox.js');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/export default class /, 'class ')
    + '\nmodule.exports = TodayDraftsOutbox;\n';
const context = { module: { exports: {} }, exports: {}, Date, Math, console };
vm.runInNewContext(source, context, { filename: sourcePath });
const TodayDraftsOutbox = context.module.exports;

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value)
    };
}

async function run() {
    const outbox = new TodayDraftsOutbox({ storage: memoryStorage() });
    const localDraft = { id: 'today-local-1', text: 'reply soon', completed: false, version: 0, updatedAt: 100 };
    outbox.enqueueUpsert(localDraft);
    outbox.enqueueUpsert({ ...localDraft, text: 'reply to team', updatedAt: 101 });
    assert.strictEqual(outbox.load().length, 1, 'repeated typing should compact to the latest record save');
    assert.strictEqual(outbox.load()[0].draft.text, 'reply to team', 'the outbox should retain the latest text');

    outbox.enqueueDelete({ ...localDraft, version: 0 });
    assert.strictEqual(outbox.load().length, 0, 'deleting an unsynced creation should cancel it without a server call');

    const remoteDraft = { id: 'today-remote-1', text: 'review PR', completed: false, version: 3, updatedAt: 200 };
    outbox.enqueueUpsert(remoteDraft);
    const requests = [];
    const api = {
        put: async (id, body) => {
            requests.push({ id, body });
            return { success: true, draft: { ...remoteDraft, ...body, id, version: 4 } };
        },
        delete: async () => ({ success: true, deleted: true }),
        get: async () => remoteDraft
    };
    const result = await outbox.retry(api);
    assert.strictEqual(requests.length, 1, 'queued writes should replay one request per latest draft');
    assert.strictEqual(requests[0].body.baseVersion, 3, 'existing drafts should retain optimistic-concurrency versions');
    assert.strictEqual(result.saved[0].result.draft.version, 4, 'successful replay should expose the saved server record');
    assert.strictEqual(outbox.load().length, 0, 'successful replay should clear the queue item');

    console.log('Today drafts outbox checks passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
