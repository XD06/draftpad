const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Pins the legacy-layout read paths that keep Thought lists and relation
// panels fast: writeThought/deleteThought maintain the thoughts index (so
// keyword search filters on one small read), searchThoughtsLight rebuilds a
// stale index instead of degrading to full reads forever, and the relations
// route resolves edge targets through one batched read.
process.env.STORAGE_BACKEND = 'local';
process.env.STORAGE_LAYOUT = 'legacy';
process.env.DATA_DIR = path.join(os.tmpdir(), `dumbpad-thought-legacy-index-${Date.now()}`);

const storage = require('../scripts/storage');

function indexFile() {
    return path.join(process.env.DATA_DIR, 'indexes', 'thoughts-index.json');
}

function readIndexFile() {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
}

async function run() {
    const first = {
        id: 'legacy-index-a',
        text: 'alpha needle',
        subItems: [{ id: 's1', text: 'sub one', completed: false }],
        tags: ['work'],
        completed: false,
        pinned: false,
        version: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000
    };
    const second = { ...first, id: 'legacy-index-b', text: 'beta only', tags: ['life'], subItems: [] };

    await storage.writeThought(first);
    await storage.writeThought(second);

    let index = readIndexFile();
    let byId = new Map(index.items.map(item => [item.id, item]));
    assert(byId.has('legacy-index-a') && byId.has('legacy-index-b'), 'legacy writeThought should maintain the thoughts index');
    assert(typeof byId.get('legacy-index-a').searchText === 'string', 'legacy index entries should carry searchText for keyword search');

    await storage.writeThought({ ...first, text: 'alpha needle revised', version: 2 });
    index = readIndexFile();
    assert(
        index.items.find(item => item.id === 'legacy-index-a').searchText.includes('revised'),
        'legacy writeThought should refresh the index entry for edited thoughts'
    );

    // A missing/stale index must self-heal on search while staying exact.
    fs.rmSync(indexFile(), { force: true });
    const healed = await storage.searchThoughtsLight({ query: 'needle', limit: 8 });
    assert.strictEqual(healed.length, 1, 'self-healed search should still find the matching thought');
    assert.strictEqual(healed[0].id, 'legacy-index-a', 'self-healed search should return the matching thought');
    assert.strictEqual(healed[0].text, 'alpha needle revised', 'search results should carry the full current text');
    index = readIndexFile();
    assert(
        Array.isArray(index.items) && index.items.every(item => typeof item.searchText === 'string'),
        'searchThoughtsLight should rebuild the index once instead of degrading to full reads forever'
    );

    const cached = await storage.searchThoughtsLight({ query: 'beta', limit: 8 });
    assert.strictEqual(cached.length, 1, 'index-backed search should find matches');
    assert.strictEqual(cached[0].id, 'legacy-index-b', 'index-backed search should return the right thought');

    const resolved = await storage.readThoughtsByIds(['legacy-index-a', 'missing-id', 'legacy-index-a']);
    assert.strictEqual(resolved.size, 2, 'readThoughtsByIds should deduplicate ids');
    assert.strictEqual(resolved.get('legacy-index-a')?.text, 'alpha needle revised', 'readThoughtsByIds should resolve existing thoughts');
    assert.strictEqual(resolved.get('missing-id'), null, 'readThoughtsByIds should report missing thoughts as null');

    await storage.deleteThought('legacy-index-a');
    assert(
        !readIndexFile().items.some(item => item.id === 'legacy-index-a'),
        'legacy deleteThought should remove the thoughts index entry'
    );

    // Route wiring: the relations endpoint must resolve edge targets through
    // the batched read (per-edge readThought re-read the whole legacy
    // collection once per edge).
    const routesSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'thought-routes.js'), 'utf8');
    assert(
        routesSource.includes('storage.readThoughtsByIds('),
        'thought relations endpoint should resolve edge targets through readThoughtsByIds'
    );
    assert(
        !/async function edgeToResponse[\s\S]*?await storage\.readThought\(/.test(routesSource),
        'relations endpoint should not read thoughts per edge'
    );

    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    console.log('Thought legacy index checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
