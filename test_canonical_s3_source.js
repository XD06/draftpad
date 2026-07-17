const { collectCanonicalS3Files } = require('./scripts/backup/canonical-s3-source');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const objects = new Map([
    ['dumbpad-prod/notepads.json', Buffer.from('{"notepads":[]}')],
    ['dumbpad-prod/default.txt', Buffer.from('note')],
    ['dumbpad-prod/assets/image/original', Buffer.from('original')],
    ['dumbpad-prod/assets/image/preview', Buffer.from('preview')],
    ['dumbpad-prod/thoughts.meta/idea.json', Buffer.from('derived')],
    ['dumbpad-prod/indexes/search.json', Buffer.from('derived')]
]);

const objectStore = {
    async list(prefix) {
        return [...objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, size: value.length }));
    },
    async get(key) {
        return Buffer.from(objects.get(key));
    }
};

(async () => {
    const files = await collectCanonicalS3Files({ objectStore, prefix: 'dumbpad-prod' });
    assert(files.length === 3, 'S3 source collection should include only canonical objects');
    assert(files.some(file => file.path === 'assets/image/original'), 'S3 source collection should preserve asset originals');
    assert(!files.some(file => file.path.endsWith('/preview')), 'S3 source collection should skip image previews');
    assert(!files.some(file => file.path.startsWith('thoughts.meta/')), 'S3 source collection should skip AI metadata');

    const changingObjects = new Map([
        ['dumbpad-prod/notepads.json', Buffer.from('{"notepads":[]}')],
        ['dumbpad-prod/default.txt', Buffer.from('before')]
    ]);
    let changeDuringFirstRead = true;
    const changingStore = {
        async list(prefix) {
            return [...changingObjects.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({ key, size: value.length }));
        },
        async get(key) {
            const value = Buffer.from(changingObjects.get(key));
            if (changeDuringFirstRead) {
                changeDuringFirstRead = false;
                changingObjects.set('dumbpad-prod/default.txt', Buffer.from('after the source changed'));
            }
            return value;
        }
    };
    const stableFiles = await collectCanonicalS3Files({ objectStore: changingStore, prefix: 'dumbpad-prod', maxAttempts: 2 });
    assert(
        stableFiles.find(file => file.path === 'default.txt').buffer.toString('utf8') === 'after the source changed',
        'S3 source collection should retry when the canonical inventory changes during a read'
    );
    console.log('Canonical S3 source checks passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
