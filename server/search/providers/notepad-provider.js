'use strict';

// Notepad (article) search provider for the global search registry.
//
// Reads from the in-memory search corpus cached by server/indexing.js (same
// lifecycle as the legacy Fuse index: rebuilt on a debounce after writes).
// Produces one result per matching article with per-line occurrences plus a
// fence-aware section label for each hit, so the UI can expand the currently
// open article into individually clickable match entries.

const {
    documentMatches,
    findLineOccurrences,
    sortOccurrences,
    buildSnippet,
    createSectionMapper,
    rankSearchResults
} = require('../matcher.js');

const MAX_RESULTS = 30;
const MAX_OCCURRENCES = 50;

function createNotepadSearchProvider({ getCorpus }) {
    return {
        type: 'notepad',
        scope: 'notepads',
        async search(keywords) {
            const corpus = await getCorpus();
            const results = [];
            for (const doc of Array.isArray(corpus) ? corpus : []) {
                if (doc?.type !== 'notepad') continue;
                if (!documentMatches(doc, keywords)) continue;

                const title = String(doc.title || '');
                const content = String(doc.content || '');
                const titleMatch = keywords.some(keyword => title.toLowerCase().includes(keyword));
                const sectionFor = createSectionMapper(content);
                const found = findLineOccurrences(
                    content.split('\n').map(text => ({ text })),
                    keywords,
                    { limit: MAX_OCCURRENCES, sectionFor }
                );
                const { snippet, snippetStart, snippetPrefixLength } = buildSnippet(content, keywords);

                results.push({
                    id: doc.id,
                    type: 'notepad',
                    title,
                    name: title,
                    snippet,
                    snippetStart,
                    snippetPrefixLength,
                    matchType: titleMatch ? 'title' : 'content',
                    matches: [],
                    matchCount: (titleMatch ? 1 : 0) + found.totalMatches,
                    coLineCount: found.coLineCount,
                    occurrencesTruncated: found.truncated,
                    occurrences: sortOccurrences(found.occurrences),
                    updatedAt: Number(doc.updatedAt || 0)
                });
            }
            return rankSearchResults(results, MAX_RESULTS);
        }
    };
}

module.exports = { createNotepadSearchProvider, MAX_RESULTS, MAX_OCCURRENCES };
