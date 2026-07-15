const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, 'public', 'sidebar.js');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/export function /g, 'function ')
    + '\nmodule.exports = { getRecentNotepadId, getPinnedNotepadId, getNewestCreatedNotepadId, getStartupNotepadId };\n';

const entries = new Map();
const localStorage = {
    getItem(key) {
        return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
        entries.set(key, String(value));
    }
};

const context = {
    module: { exports: {} },
    exports: {},
    localStorage,
    JSON,
    Map,
    Set,
    Date,
    Number,
    String,
    Array
};
vm.runInNewContext(source, context, { filename: sourcePath });

const {
    getRecentNotepadId,
    getPinnedNotepadId,
    getNewestCreatedNotepadId,
    getStartupNotepadId
} = context.module.exports;

const notepads = [
    { id: 'old-created', name: 'Old', createdAt: 10, updatedAt: 20 },
    { id: 'pinned-older', name: 'Pinned old', createdAt: 30, updatedAt: 40, pinned: true, pinnedAt: 50 },
    { id: 'pinned-newer', name: 'Pinned new', createdAt: 60, updatedAt: 70, pinned: true, pinnedAt: 80 },
    { id: 'newest-created', name: 'Newest', createdAt: 90, updatedAt: 95 }
];

localStorage.setItem('dumbpad_recents', JSON.stringify([
    { id: 'old-created', touchedAt: 200 },
    { id: 'missing', touchedAt: 300 },
    { id: 'newest-created', touchedAt: 100 }
]));

assert.strictEqual(getRecentNotepadId(notepads), 'old-created', 'recent selection should ignore deleted IDs and use the newest local record');
assert.strictEqual(getPinnedNotepadId(notepads), 'pinned-newer', 'pinned selection should prefer the latest pinned item');
assert.strictEqual(getNewestCreatedNotepadId(notepads), 'newest-created', 'created fallback should select the newest created item');
assert.strictEqual(getStartupNotepadId(notepads), 'old-created', 'startup should prefer the most recently opened existing article');

localStorage.setItem('dumbpad_recents', '[]');
assert.strictEqual(getStartupNotepadId(notepads), 'pinned-newer', 'startup should fall back to a pinned article when there is no recent article');
assert.strictEqual(
    getStartupNotepadId(notepads.map(notepad => ({ ...notepad, pinned: false, pinnedAt: undefined }))),
    'newest-created',
    'startup should fall back to the newest created article without recent or pinned articles'
);

console.log('Notepad pinning checks passed');
