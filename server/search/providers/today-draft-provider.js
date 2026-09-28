'use strict';

// Today Draft search provider for the global search registry.
//
// Today drafts are a short-lived, small dataset (3-day rolling window, one
// JSON file), so this provider reads them per query via storage — no cache
// of its own. Drafts outside the retention window are pending deletion and
// are excluded from search. The result carries the `day` key so the UI can
// badge which day a hit belongs to and jump to it in the pager.

const {
    documentMatches,
    findLineOccurrences,
    sortOccurrences,
    buildSnippet,
    rankSearchResults
} = require('../matcher.js');

const MAX_RESULTS = 10;
const MAX_OCCURRENCES = 50;
const RETENTION_DAYS = 3;

// Mirrors routes/today-drafts-routes.js dayWindowKeys: local calendar days
// via setDate, not millisecond subtraction (DST days are not 24h long).
function localDayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function dayWindowKeys(now = new Date()) {
    const keys = new Set();
    for (let offset = 0; offset < RETENTION_DAYS; offset += 1) {
        const shifted = new Date(now);
        shifted.setDate(shifted.getDate() - offset);
        keys.add(localDayKey(shifted));
    }
    return keys;
}

function dayLabel(dayKey, now = new Date()) {
    const labels = ['今天', '昨天', '前天'];
    for (let offset = 0; offset < labels.length; offset += 1) {
        const shifted = new Date(now);
        shifted.setDate(shifted.getDate() - offset);
        if (localDayKey(shifted) === String(dayKey || '')) return labels[offset];
    }
    return String(dayKey || '');
}

function createTodayDraftSearchProvider({ storage }) {
    return {
        type: 'today_draft',
        scope: 'today_drafts',
        async search(keywords) {
            const drafts = await storage.readTodayDrafts();
            const windowKeys = dayWindowKeys();
            const results = [];
            for (const draft of Array.isArray(drafts) ? drafts : []) {
                const day = String(draft?.day || '');
                if (!windowKeys.has(day)) continue;

                const text = String(draft?.text || '');
                if (!documentMatches({ title: text, content: text, tags: [] }, keywords)) continue;

                const title = text.split('\n').find(line => line.trim()) || '今日草稿';
                const found = findLineOccurrences(
                    text.split('\n').map(line => ({ text: line })),
                    keywords,
                    { limit: MAX_OCCURRENCES }
                );
                const { snippet, snippetStart, snippetPrefixLength } = buildSnippet(text, keywords);
                const titleMatch = keywords.some(keyword => title.toLowerCase().includes(keyword));

                results.push({
                    id: draft.id,
                    type: 'today_draft',
                    day,
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
                    updatedAt: Number(draft.updatedAt || draft.createdAt || 0)
                });
            }
            return rankSearchResults(results, MAX_RESULTS);
        }
    };
}

module.exports = { createTodayDraftSearchProvider, dayWindowKeys, dayLabel, MAX_RESULTS };
