const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.STORAGE_BACKEND = 's3';
process.env.STORAGE_LAYOUT = 'split';
process.env.S3_BUCKET = 'dumbpad-pagination-test';
process.env.S3_ACCESS_KEY = 'test-access-key';
process.env.S3_SECRET_KEY = 'test-secret-key';
process.env.S3_REGION = 'us-east-1';
process.env.S3_PREFIX = '';
process.env.DATA_DIR = path.join(os.tmpdir(), `dumbpad-thought-page-${Date.now()}`);

const objects = new Map();
const commandCounts = new Map();
const fakeS3 = {
    async send(command) {
        const name = command.constructor.name;
        commandCounts.set(name, (commandCounts.get(name) || 0) + 1);
        const input = command.input;

        if (name === 'HeadObjectCommand') {
            if (!objects.has(input.Key)) {
                const error = new Error('missing object');
                error.name = 'Unknown';
                error.$metadata = { httpStatusCode: 400 };
                throw error;
            }
            return { ContentLength: Buffer.byteLength(objects.get(input.Key)) };
        }
        if (name === 'PutObjectCommand') {
            objects.set(input.Key, Buffer.isBuffer(input.Body) ? input.Body.toString('utf8') : String(input.Body || ''));
            return {};
        }
        if (name === 'GetObjectCommand') {
            if (!objects.has(input.Key)) {
                const error = new Error('missing object');
                error.name = 'Unknown';
                error.$metadata = { httpStatusCode: 400 };
                throw error;
            }
            return { Body: Buffer.from(objects.get(input.Key)) };
        }
        if (name === 'ListObjectsV2Command') {
            return {
                Contents: [...objects.keys()]
                    .filter(key => key.startsWith(input.Prefix || ''))
                    .map(Key => ({ Key }))
            };
        }
        if (name === 'DeleteObjectCommand') return {};
        throw new Error(`Unhandled fake S3 command: ${name}`);
    }
};

const s3 = require('../scripts/s3-service');
s3.initS3({ client: fakeS3, bucket: process.env.S3_BUCKET });
s3.initS3 = () => fakeS3;

const storage = require('../scripts/storage');

function count(name) {
    return commandCounts.get(name) || 0;
}

function makeThought(index) {
    const createdAt = 1_700_000_000_000 + index;
    return {
        id: `thought-${String(index).padStart(2, '0')}`,
        text: index === 39 ? 'needle last thought' : `Thought ${index}`,
        subItems: [{ id: `sub-${index}`, text: `subtask ${index}`, completed: false }],
        tags: [index % 2 ? 'odd' : 'even'],
        completed: index >= 30,
        pinned: index < 2,
        pinnedAt: index < 2 ? createdAt : undefined,
        version: 1,
        createdAt,
        updatedAt: createdAt
    };
}

function timelineCursor(thought) {
    return {
        pinned: thought.pinned === true,
        pinnedAt: Number(thought.pinnedAt || 0),
        completed: thought.completed === true,
        createdAt: Number(thought.createdAt || 0),
        id: String(thought.id)
    };
}

async function run() {
    const thoughts = Array.from({ length: 40 }, (_, index) => makeThought(index));
    objects.set('indexes/thoughts-index.json', JSON.stringify({
        items: thoughts.map(thought => ({
            id: thought.id,
            type: 'thought',
            textPreview: thought.text.slice(0, 300),
            tags: thought.tags,
            completed: thought.completed,
            pinned: thought.pinned,
            pinnedAt: thought.pinnedAt || 0,
            subtaskPartial: false,
            createdAt: thought.createdAt,
            updatedAt: thought.updatedAt
        })),
        updatedAt: Date.now()
    }));
    thoughts.forEach(thought => {
        objects.set(`thoughts/${thought.id}.json`, JSON.stringify(thought));
    });

    const getsBefore = count('GetObjectCommand');
    const listsBefore = count('ListObjectsV2Command');
    const firstPage = await storage.listThoughtsPage({
        limit: 5,
        sort: 'timeline',
        status: 'all'
    });
    assert(firstPage?.usedIndex === true, 'split Thought pagination should use the persisted index');
    assert.strictEqual(firstPage.items.length, 5, 'indexed pagination should read only one page of Thoughts');
    assert(firstPage.hasMore === true, 'indexed pagination should report remaining Thoughts');
    assert(firstPage.items[0].pinned === true, 'timeline pagination should keep pinned Thoughts first');
    assert.strictEqual(
        count('GetObjectCommand') - getsBefore,
        6,
        'indexed page should read the index plus only the five requested Thought objects'
    );
    assert.strictEqual(
        count('ListObjectsV2Command') - listsBefore,
        0,
        'indexed page should not list the complete split Thought prefix'
    );

    const secondPage = await storage.listThoughtsPage({
        limit: 5,
        sort: 'timeline',
        status: 'all',
        cursor: timelineCursor(firstPage.items[firstPage.items.length - 1])
    });
    const firstIds = new Set(firstPage.items.map(thought => thought.id));
    assert(secondPage.items.every(thought => !firstIds.has(thought.id)), 'indexed cursor pages should not repeat Thoughts');

    const todoPage = await storage.listThoughtsPage({
        limit: 40,
        sort: 'timeline',
        status: 'todo',
        tag: 'even'
    });
    assert(todoPage.items.every(thought => thought.completed !== true && thought.tags.includes('even')), 'indexed filters should apply before reading Thought files');

    const queryFallback = await storage.listThoughtsPage({ query: 'needle', limit: 5, sort: 'timeline' });
    assert.strictEqual(queryFallback, null, 'full-text queries should preserve the complete-read fallback for exact results');

    // An index without searchText (pre-search layout) must fall back to a
    // full read so results stay complete instead of silently truncated.
    const legacySearch = await storage.searchThoughtsLight({ query: 'needle', limit: 8 });
    assert.strictEqual(legacySearch.length, 1, 'legacy indexes should fall back to a complete read for search');
    assert.strictEqual(legacySearch[0].id, 'thought-39', 'the fallback search should match Thought text');

    // A current index filters on the stored corpus and reads only the
    // matched Thought objects.
    objects.set('indexes/thoughts-index.json', JSON.stringify({
        items: thoughts.map(thought => ({
            id: thought.id,
            type: 'thought',
            textPreview: thought.text.slice(0, 300),
            searchText: [thought.text, (thought.subItems || []).map(s => s.text).join('\n'), thought.tags.join('\n')]
                .filter(Boolean)
                .join('\n')
                .toLowerCase(),
            tags: thought.tags,
            completed: thought.completed,
            pinned: thought.pinned,
            pinnedAt: thought.pinnedAt || 0,
            subtaskPartial: false,
            createdAt: thought.createdAt,
            updatedAt: thought.updatedAt
        })),
        updatedAt: Date.now()
    }));
    const getsBeforeSearch = count('GetObjectCommand');
    const indexSearch = await storage.searchThoughtsLight({ query: 'NEEDLE', limit: 8 });
    assert.strictEqual(indexSearch.length, 1, 'index-backed search should match case-insensitively');
    assert.strictEqual(indexSearch[0].id, 'thought-39', 'index-backed search should return the matched Thought');
    assert.strictEqual(indexSearch[0].text, 'needle last thought', 'index-backed search results should carry the full text');
    assert.strictEqual(
        count('GetObjectCommand') - getsBeforeSearch,
        2,
        'index-backed search should read the index plus only the matched Thought objects'
    );
    const subtaskSearch = await storage.searchThoughtsLight({ query: 'subtask 7', limit: 8 });
    assert(subtaskSearch.some(item => item.id === 'thought-07'), 'index-backed search should match subtask text');

    console.log('Thought storage pagination checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
