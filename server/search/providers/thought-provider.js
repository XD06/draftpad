'use strict';

// Thought search provider for the global search registry.
//
// Shortlists candidates through storage.searchThoughtsLight, which filters
// on the thoughts index (one small JSON read even on S3) with the same
// multi-keyword AND semantics and falls back to a full read when the index
// is unusable — a search must never silently return incomplete results.
// Occurrences are computed over the structured object so each hit is labeled
// 正文 / 子任务 / 标签, letting the UI say where inside the thought it matched.

const {
    findLineOccurrences,
    sortOccurrences,
    buildSnippet,
    rankSearchResults
} = require('../matcher.js');

const MAX_RESULTS = 20;
const MAX_OCCURRENCES = 50;

// Compose the searchable line list in document order: body text lines first,
// then subtask lines, then tags. `context` labels where each line lives.
function buildThoughtLines(thought) {
    const lines = [];
    String(thought?.text || '').split('\n').forEach(text => lines.push({ text, context: '正文' }));
    (Array.isArray(thought?.subItems) ? thought.subItems : []).forEach(item => {
        String(item?.text || '').split('\n').forEach(text => lines.push({ text, context: '子任务' }));
    });
    (Array.isArray(thought?.tags) ? thought.tags : []).forEach(tag => lines.push({ text: String(tag || ''), context: '标签' }));
    return lines;
}

function buildThoughtResult(thought, keywords) {
    const text = String(thought?.text || '');
    const title = text.length > 80 ? `${text.slice(0, 80).trim()}...` : text;
    const lines = buildThoughtLines(thought);
    const found = findLineOccurrences(lines, keywords, { limit: MAX_OCCURRENCES });
    const content = lines.map(line => line.text).join('\n');
    const { snippet, snippetStart, snippetPrefixLength } = buildSnippet(content, keywords);
    const titleMatch = keywords.some(keyword => text.split('\n')[0].toLowerCase().includes(keyword));

    return {
        id: thought.id,
        type: 'thought',
        title,
        name: snippet || title,
        snippet,
        snippetStart,
        snippetPrefixLength,
        matchType: titleMatch ? 'title' : 'content',
        matches: [],
        matchCount: (titleMatch ? 1 : 0) + found.totalMatches,
        coLineCount: found.coLineCount,
        occurrencesTruncated: found.truncated,
        occurrences: sortOccurrences(found.occurrences),
        updatedAt: Number(thought.updatedAt || thought.createdAt || 0)
    };
}

function createThoughtSearchProvider({ storage }) {
    return {
        type: 'thought',
        scope: 'thoughts',
        async search(keywords) {
            const thoughts = await storage.searchThoughtsLight({ keywords, limit: MAX_RESULTS });
            return rankSearchResults(
                thoughts.map(thought => buildThoughtResult(thought, keywords)),
                MAX_RESULTS
            );
        }
    };
}

module.exports = { createThoughtSearchProvider, buildThoughtLines, buildThoughtResult, MAX_RESULTS };
