// Regression for thought write type guards: persisting a non-string text /
// non-array subItems / non-string-tag array used to poison the collection and
// turn every later GET /api/thoughts into a 500 (toLowerCase on a non-string).
// Drives the route handlers directly against a temp local storage.

const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.STORAGE_BACKEND = 'local';
process.env.STORAGE_LAYOUT = 'legacy';
process.env.DATA_DIR = path.join(os.tmpdir(), `dumbpad-thought-guard-${Date.now()}`);

const storage = require('../scripts/storage');
const { registerThoughtRoutes } = require('../routes/thought-routes');

const routes = new Map();
registerThoughtRoutes({
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
    patch: (p, h) => routes.set(`PATCH ${p}`, h),
    delete: () => {}
}, {
    storage,
    aiQueue: { _private: { withRelationWriteLock: task => task() }, queueThought: () => {}, getQueueStatus: () => null },
    scheduleIndexNotepads: () => {},
    broadcastWebSocketMessage: () => {}
});

function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
}

function post(body) {
    const res = fakeRes();
    return routes.get('POST /api/thoughts')({ body }, res).then(() => res);
}

function patch(id, body) {
    const res = fakeRes();
    return routes.get('PATCH /api/thoughts/:id')({ body, params: { id } }, res).then(() => res);
}

function list() {
    const res = fakeRes();
    return routes.get('GET /api/thoughts')({ query: {} }, res).then(() => res);
}

async function main() {
    let res = await post({ text: { poisoned: true } });
    assert.strictEqual(res.statusCode, 400, `non-string create text must 400, got ${res.statusCode}`);

    res = await post({ text: 'ok', subItems: 'nope' });
    assert.strictEqual(res.statusCode, 400, `non-array create subItems must 400, got ${res.statusCode}`);

    res = await post({ text: 'ok', tags: ['a', 7] });
    assert.strictEqual(res.statusCode, 400, `non-string tag must 400, got ${res.statusCode}`);

    res = await post({ text: 'parent', subItems: [{ id: '1', text: 'child', completed: false }], tags: ['work'] });
    assert.strictEqual(res.statusCode, 200, `valid create must pass, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    const thoughtId = res.body.id;

    res = await patch(thoughtId, { action: 'overwrite', text: { poisoned: true } });
    assert.strictEqual(res.statusCode, 400, `overwrite with object text must 400, got ${res.statusCode}`);

    res = await patch(thoughtId, { action: 'overwrite', subItems: [{ text: { poisoned: true } }] });
    assert.strictEqual(res.statusCode, 400, `overwrite with non-string subitem text must 400, got ${res.statusCode}`);

    res = await patch(thoughtId, { action: 'overwrite', tags: 'not-an-array' });
    assert.strictEqual(res.statusCode, 400, `overwrite with non-array tags must 400, got ${res.statusCode}`);

    res = await patch(thoughtId, { action: 'update_subitem', subId: '1', text: { poisoned: true } });
    assert.strictEqual(res.statusCode, 400, `update_subitem with object text must 400, got ${res.statusCode}`);

    res = await patch(thoughtId, { action: 'overwrite', text: 'clean text', subItems: [{ id: '2', text: 'sub', completed: true }], tags: ['clean'] });
    assert.strictEqual(res.statusCode, 200, `valid overwrite must pass, got ${res.statusCode}: ${JSON.stringify(res.body)}`);

    res = await list();
    assert.strictEqual(res.statusCode, 200, `list must stay healthy, got ${res.statusCode}`);
    assert(Array.isArray(res.body.thoughts) || Array.isArray(res.body), 'list must return the collection');
    const listed = (res.body.thoughts || res.body).find(item => item.id === thoughtId);
    assert(listed && listed.text === 'clean text', 'overwrite result must be persisted');

    console.log('Thought write type guard checks passed');
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
