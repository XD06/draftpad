// Regression for the trash index write lock (withTrashWriteLock):
// addTrashItem / deleteTrashItem / emptyTrash each do an index
// read-modify-write; without the mutex, concurrent writers last-wins each
// other (a concurrent add is lost, a deleted entry resurrects).
// Interleaving here relies on real async local-fs awaits, so the race is
// reproducible without artificial timers.

const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.STORAGE_BACKEND = 'local';
process.env.STORAGE_LAYOUT = 'legacy';
process.env.DATA_DIR = path.join(os.tmpdir(), `dumbpad-trash-lock-${Date.now()}`);

const storage = require('../scripts/storage');

function addEntry(sourceId) {
    return storage.addTrashItem({
        type: 'notepad',
        sourceId,
        title: sourceId,
        preview: '',
        payload: { notepad: { id: sourceId } }
    });
}

async function main() {
    // 1. Concurrent adds must all land in the index.
    await Promise.all(Array.from({ length: 8 }, (_, i) => addEntry(`p-${i}`)));
    let items = await storage.listTrashItems();
    assert.strictEqual(items.length, 8, `concurrent adds lost entries: ${items.length}`);

    // 2. Concurrent delete + add: both orders serialize to the same outcome —
    // the deleted entry stays gone and the new entry stays present.
    const deletedTrashId = items[0].trashId;
    await Promise.all([
        storage.deleteTrashItem(deletedTrashId),
        addEntry('late')
    ]);
    items = await storage.listTrashItems();
    assert(!items.some(entry => entry.trashId === deletedTrashId), 'deleted entry must not resurrect in the index');
    assert(items.some(entry => entry.sourceId === 'late'), 'concurrent add must not be lost from the index');

    // 3. Index and payload stay in sync after the race.
    const late = items.find(entry => entry.sourceId === 'late');
    const payload = await storage.getTrashItem(late.trashId);
    assert(payload && payload.payload?.payload?.notepad?.id === 'late', 'payload for the surviving entry must be readable');

    // 4. Empty while adding: index must never reference a deleted payload.
    await Promise.all([
        storage.emptyTrash(),
        addEntry('during-empty')
    ]);
    for (const entry of await storage.listTrashItems()) {
        const item = await storage.getTrashItem(entry.trashId);
        assert(item, `index entry ${entry.trashId} references a missing payload`);
    }

    console.log('Trash write lock checks passed');
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
