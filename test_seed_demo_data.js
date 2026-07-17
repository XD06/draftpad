const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbpad-demo-seed-'));
process.env.STORAGE_BACKEND = 'local';
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.S3_ENDPOINT = 'http://127.0.0.1:1';
process.env.S3_BUCKET = 'dumbpad-test';
process.env.S3_ACCESS_KEY = 'test';
process.env.S3_SECRET_KEY = 'test';

const storage = require('./scripts/storage');
const { NOTES, THOUGHTS, seedDemoData } = require('./scripts/seed-demo-data');

(async () => {
    try {
        const reset = await seedDemoData({ reset: true });
        assert.strictEqual(reset.notepads, NOTES.length, 'reset should write every demo article');
        assert.strictEqual(reset.thoughts, THOUGHTS.length, 'reset should write every demo thought');

        const meta = await storage.readNotepadsMeta();
        const userNote = {
            id: 'user-local-note',
            name: '保留的本地文章',
            version: 3,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        meta.notepads.push(userNote);
        await storage.saveNotepadsMeta(meta);
        await storage.writeNoteContent(userNote, '这不是演示数据，合并时必须保留。');

        const thoughts = await storage.readThoughts();
        thoughts.push({
            id: 'user-local-thought',
            text: '保留的本地 Thought',
            subItems: [],
            tags: ['本地'],
            attachments: [],
            completed: false,
            pinned: false,
            version: 2,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        await storage.saveThoughts(thoughts);

        const merged = await seedDemoData({ merge: true });
        assert.strictEqual(merged.mode, 'merge', 'merge mode should report its non-destructive strategy');
        assert.strictEqual(merged.preservedNotepads, 1, 'merge should preserve non-demo articles');
        assert.strictEqual(merged.preservedThoughts, 1, 'merge should preserve non-demo thoughts');

        const mergedMeta = await storage.readNotepadsMeta();
        assert(mergedMeta.notepads.some(item => item.id === userNote.id), 'the user article should survive demo merging');
        assert(mergedMeta.notepads.some(item => item.id === 'demo-assets-code'), 'the resource and code-block demo article should be installed');
        assert(mergedMeta.notepads.some(item => item.id === 'demo-data-safety'), 'the data-safety demo article should be installed');
        assert.strictEqual(await storage.readNoteContent(userNote), '这不是演示数据，合并时必须保留。');

        const mergedThoughts = await storage.readThoughts();
        assert(mergedThoughts.some(item => item.id === 'user-local-thought'), 'the user Thought should survive demo merging');
        assert(mergedThoughts.some(item => item.id === 'demo-thought-editor-assets'), 'the editor resource demo Thought should be installed');
        assert(mergedThoughts.some(item => item.id === 'demo-thought-security'), 'the security demo Thought should be installed');
        assert(
            mergedThoughts.some(item => item.id === 'demo-thought-known-bug' && item.tags.includes('已修复')),
            'the historical Enter regression should be presented as fixed'
        );

        console.log('Demo data seed checks passed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
