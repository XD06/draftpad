const fs = require('fs');
const Fuse = require('fuse.js');

function createSearchIndex({ storage, dataDir, notepadsFile }) {
    const notepadsCache = {
        documents: [],
        index: null
    };
    let indexTimer = null;
    let indexingPromise = null;

    async function indexNotepads() {
        if (indexingPromise) return indexingPromise;
        console.log('Indexing search documents...');
        indexingPromise = (async () => {
            const items = await storage.getSearchDocuments();
            notepadsCache.documents = items;

            notepadsCache.index = new Fuse(items, {
                keys: ['title', 'content', 'tags'],
                threshold: 0.38,
                minMatchCharLength: 1,
                ignoreLocation: true,
                includeScore: true,
                includeMatches: true
            });

            console.log('Indexing complete. Search documents indexed:', notepadsCache.documents.length);
            indexingPromise = null;
        })().catch(error => {
            indexingPromise = null;
            console.error('Error indexing notepads:', error);
        });
        return indexingPromise;
    }

    function scheduleIndexNotepads(delay = 1500) {
        clearTimeout(indexTimer);
        indexTimer = setTimeout(() => {
            indexNotepads();
        }, delay);
    }

    async function searchNotepads(query) {
        if (!notepadsCache.index) await indexNotepads();
        if (!notepadsCache.index) return [];

        return notepadsCache.index.search(query).map(({ item }) => {
            const title = item.title || '';
            const content = item.content || '';
            const isFilenameMatch = title.toLowerCase().includes(query.toLowerCase());
            let truncatedContent = content;

            if (!isFilenameMatch) {
                const lowerContent = content.toLowerCase();
                const matchIndex = lowerContent.indexOf(query.toLowerCase());

                if (matchIndex !== -1) {
                    let start = matchIndex;
                    let end = matchIndex + query.length;

                    let spaceCount = 0;
                    while (start > 0 && spaceCount < 3) {
                        if (lowerContent[start] === ' ') spaceCount++;
                        start--;
                    }
                    start = Math.max(0, start);

                    while (end < lowerContent.length && (end - start) < 25) {
                        end++;
                    }

                    truncatedContent = content.substring(start, end).trim();
                    if (start > 0) truncatedContent = `...${truncatedContent}`;
                    if (end < content.length) truncatedContent = `${truncatedContent}...`;
                } else {
                    truncatedContent = content.substring(0, 20).trim() + '...';
                }
            }

            let truncatedName = title.substring(0, 20).trim();
            if (title.length >= 20) {
                truncatedName += '...';
            }

            return {
                id: item.id,
                type: item.type,
                title,
                name: isFilenameMatch ? truncatedName : (truncatedContent || content.substring(0, 50)),
                snippet: truncatedContent || '',
                matchType: isFilenameMatch ? 'title' : 'content'
            };
        });
    }

    function watchSearchDocuments() {
        if (storage.backend === 's3') return;

        try {
            fs.watch(dataDir, (eventType, filename) => {
                if (filename && filename.endsWith('.txt')) scheduleIndexNotepads();
            });
        } catch (error) {
            console.warn('[indexing] data directory watch skipped:', error.message);
        }

        try {
            fs.watch(notepadsFile, () => scheduleIndexNotepads());
        } catch (error) {
            console.warn('[indexing] notepads metadata watch skipped:', error.message);
        }
    }

    return {
        indexNotepads,
        scheduleIndexNotepads,
        searchNotepads,
        watchSearchDocuments
    };
}

module.exports = { createSearchIndex };
