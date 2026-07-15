const assert = require('assert');
const { createSearchIndex } = require('./server/indexing.js');

async function run() {
    const index = createSearchIndex({
        storage: {
            backend: 'local',
            async getSearchDocuments() {
                return [
                    { id: 'alpha', type: 'notepad', title: 'Project Alpha', content: 'Ship the search highlight before Friday.', tags: ['release'] },
                    { id: 'beta', type: 'notepad', title: 'Archive', content: 'No matching content.', tags: [] }
                ];
            }
        },
        dataDir: __dirname,
        notepadsFile: __filename
    });

    await index.indexNotepads();
    const results = await index.searchNotepads('highlight');
    assert.strictEqual(results.length, 1, 'search should return the matching document');
    assert.strictEqual(results[0].matchType, 'content', 'search should identify a content match');
    assert(
        results[0].matches.some(match => match.key === 'content' && Array.isArray(match.indices) && match.indices.length > 0),
        'search results should retain Fuse match offsets for frontend highlighting'
    );
    assert(results[0].snippet.includes('highlight'), 'search should keep a keyword-adjacent content snippet');
    console.log('Search indexing checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
