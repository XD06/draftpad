const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadRelationsState() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-relations-state.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { applyManualRelationCreated, applyManualRelationCreateFailure, applyRelationDeleted, applyRelationDeleteFailure, normalizeRelationCount };\n';
    const context = {
        module: { exports: {} },
        exports: {},
        Number,
        Math
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const {
        applyManualRelationCreated,
        applyManualRelationCreateFailure,
        applyRelationDeleted,
        applyRelationDeleteFailure,
        normalizeRelationCount
    } = loadRelationsState();

    assert(normalizeRelationCount('3') === 3, 'relation counts should parse numeric strings');
    assert(normalizeRelationCount(-2) === 0, 'relation counts should never go below zero');
    assert(normalizeRelationCount('bad', 4) === 4, 'invalid relation counts should use fallback');

    const created = { relationCount: 1, aiStatus: 'missing' };
    assert(applyManualRelationCreated(created, '5') === 5, 'manual relation success should return server count');
    assert(created.relationCount === 5 && created.aiStatus === 'ready', 'manual relation success should mark AI ready and update count');

    const createFailed = { relationCount: 2 };
    assert(applyManualRelationCreateFailure(createFailed) === 3, 'manual relation failure should optimistically increment count');
    assert(createFailed.localPending === true, 'manual relation failure should mark local pending');

    const deleted = { relationCount: 4 };
    assert(applyRelationDeleted(deleted, '2') === 2, 'relation delete success should prefer server count');
    assert(deleted.relationCount === 2, 'relation delete success should update thought count');

    const deletedFallback = { relationCount: 4 };
    assert(applyRelationDeleted(deletedFallback, undefined) === 3, 'relation delete success should decrement when server count is absent');

    const deleteFailed = { relationCount: 0 };
    assert(applyRelationDeleteFailure(deleteFailed) === 0, 'relation delete failure should not decrement below zero');
    assert(deleteFailed.localPending === true, 'relation delete failure should mark local pending');

    console.log('Thought relations state checks passed');
}

run();
