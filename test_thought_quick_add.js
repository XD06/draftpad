const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadQuickAdd() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-quick-add.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { buildQuickAddCreateOutboxItem, createLocalPendingThought, markCreatedThoughtPending };\n';
    const context = {
        module: { exports: {} },
        exports: {},
        Date
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const {
        buildQuickAddCreateOutboxItem,
        createLocalPendingThought,
        markCreatedThoughtPending
    } = loadQuickAdd();

    const created = markCreatedThoughtPending({
        id: 'server-1',
        text: 'Created',
        aiStatus: 'missing'
    }, { now: 1700000000000 });
    assert(created.aiStatus === 'pending', 'created thoughts should enter pending AI status locally');
    assert(created.aiPendingSince === 1700000000000, 'created thoughts should record pending timestamp');
    assert(created.text === 'Created', 'created thoughts should preserve server fields');

    const tags = ['Project'];
    const local = createLocalPendingThought({
        text: 'Offline thought',
        tags,
        now: 1700000001000,
        id: 'local-fixed'
    });
    tags.push('mutated');
    assert(local.id === 'local-fixed', 'local pending thoughts should use provided temp id');
    assert(local.tags.join(',') === 'Project', 'local pending thoughts should clone tags');
    assert(local.localPending === true && local.aiStatus === 'missing', 'local pending thoughts should keep existing fallback status');
    assert(local.createdAt === 1700000001000 && local.updatedAt === 1700000001000, 'local pending timestamps should share the same clock value');

    const outbox = buildQuickAddCreateOutboxItem({
        text: 'Offline thought',
        tags: local.tags,
        tempThought: local
    });
    local.tags.push('after');
    assert(outbox.text === 'Offline thought', 'outbox create payload should preserve text');
    assert(outbox.tags.join(',') === 'Project', 'outbox create payload should clone tags');
    assert(Array.isArray(outbox.subItems) && outbox.subItems.length === 0, 'outbox create payload should preserve empty subItems');
    assert(outbox.completed === false, 'outbox create payload should preserve incomplete default');
    assert(outbox.tempThought === local, 'outbox create payload should keep temp thought reference');

    console.log('Thought quick add checks passed');
}

run();
