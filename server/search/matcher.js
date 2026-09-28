'use strict';

// Pure text-matching primitives shared by every global-search provider.
//
// One definition of "match" for the whole /api/search surface: the query is
// split into whitespace-separated keywords and a document matches only when
// EVERY keyword appears (case-insensitive) in it. Hits are reported per
// content line so the UI can list every place a document matches — not just
// the first one — and jump straight to each line. No fuzzy matching here:
// the Fuse index stays available for the Agent recall path only.

const { buildOutline } = require('../../scripts/note-edits.js');

const MAX_KEYWORDS = 8;

// Split a raw query into lowercase keywords. Returns [] for empty or
// whitespace-only queries — callers must treat that as "do not search".
function splitKeywords(query) {
    return String(query || '')
        .split(/\s+/)
        .map(keyword => keyword.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_KEYWORDS);
}

// AND semantics: every keyword must appear in title, content or tags.
function documentMatches(doc, keywords) {
    const haystacks = [
        String(doc?.title || ''),
        String(doc?.content || ''),
        (Array.isArray(doc?.tags) ? doc.tags : []).map(String).join('\n')
    ].map(value => value.toLowerCase());
    return keywords.every(keyword => haystacks.some(haystack => haystack.includes(keyword)));
}

// Classify a raw markdown line the way the editor renders it, so match
// entries can carry a small block badge (like the article table of contents).
// Fence state is tracked by the caller; a line inside a fence is code.
function detectBlockType(lineText, inFence = false) {
    if (inFence) return { type: 'code' };
    const line = String(lineText || '');
    const heading = line.match(/^ {0,3}(#{1,6})\s+/);
    if (heading) return { type: 'heading', level: heading[1].length };
    if (/^ {0,3}>/.test(line)) return { type: 'quote' };
    if (/^ {0,3}[-*+]\s+\[[ xX]\]/.test(line)) return { type: 'todo' };
    if (/^ {0,3}[-*+]\s+/.test(line) || /^ {0,3}\d+[.)]\s+/.test(line)) return { type: 'list' };
    return { type: 'text' };
}

// Collect keyword hits over an array of `{ text, context? }` lines, one
// occurrence entry per line that contains at least one hit:
//   { line, lineText, context, matchCount, distinctKeywords, hitIndex,
//     section, block }
// `line` is the index within the passed array, `matchCount` counts keyword
// hits on that line, `distinctKeywords` how many DIFFERENT keywords hit it,
// and `hitIndex` the line's first hit position in the document-wide sequence
// of individual hits — the frontend uses it to jump precisely. `limit` caps
// the returned entries; `totalMatches`/`coLineCount`/`truncated` always
// describe the uncapped result (`coLineCount` = lines hit by every keyword).
// `sectionFor(lineIndex)` (optional) labels each hit with its enclosing
// structure (e.g. the nearest ATX heading). Fenced code blocks are tracked
// with the same CommonMark rules as buildOutline: same fence character,
// at least as long as the opener, closing line carries no fence characters.
function findLineOccurrences(lines, keywords, { limit = Infinity, sectionFor = null } = {}) {
    const occurrences = [];
    let totalMatches = 0;
    let coLineCount = 0;
    let truncated = false;
    let globalHitCount = 0;
    let fenceMarker = null;
    let fenceLength = 0;
    const keywordCount = keywords.length;
    for (let index = 0; index < lines.length; index += 1) {
        const lineText = String(lines[index]?.text || '');
        const fence = lineText.match(/^ {0,3}(`{3,}|~{3,})/);
        let inFence = false;
        if (fenceMarker) {
            if (fence && fence[1][0] === fenceMarker && fence[1].length >= fenceLength
                && !lineText.trim().slice(fence[1].length).includes(fenceMarker)) {
                fenceMarker = null;
                continue;
            }
            inFence = true;
        } else if (fence) {
            fenceMarker = fence[1][0];
            fenceLength = fence[1].length;
            continue;
        }
        const lower = lineText.toLowerCase();
        let matchCount = 0;
        let distinctKeywords = 0;
        for (const keyword of keywords) {
            let hits = 0;
            let cursor = lower.indexOf(keyword);
            while (cursor >= 0) {
                hits += 1;
                cursor = lower.indexOf(keyword, cursor + keyword.length);
            }
            if (hits > 0) {
                matchCount += hits;
                distinctKeywords += 1;
            }
        }
        if (matchCount === 0) continue;
        totalMatches += 1;
        if (distinctKeywords === keywordCount) coLineCount += 1;
        if (occurrences.length >= limit) {
            truncated = true;
            continue;
        }
        occurrences.push({
            line: index,
            lineText,
            context: lines[index]?.context || null,
            matchCount,
            distinctKeywords,
            hitIndex: globalHitCount,
            section: typeof sectionFor === 'function' ? sectionFor(index) : null,
            block: detectBlockType(lineText, inFence)
        });
        globalHitCount += matchCount;
    }
    return { occurrences, totalMatches, coLineCount, truncated };
}

// Relevance order for a document's match entries under multi-keyword
// queries: lines hitting MORE distinct keywords first (a line containing
// both 性能 and 优化 outranks lines with only 优化), then more hits on the
// line, then document order. Single-keyword searches keep document order.
function sortOccurrences(occurrences) {
    return occurrences.sort((left, right) => (
        (right.distinctKeywords - left.distinctKeywords)
        || (right.matchCount - left.matchCount)
        || (left.line - right.line)
    ));
}

// Context window around the first keyword hit for list snippets. Keeps the
// legacy `snippetStart` / `snippetPrefixLength` fields so existing API
// consumers can still reconstruct highlight offsets.
function buildSnippet(content, keywords, { window = 48, prefix = 12 } = {}) {
    const text = String(content || '');
    const lower = text.toLowerCase();
    let first = -1;
    let matchedLength = 0;
    for (const keyword of keywords) {
        const at = keyword ? lower.indexOf(keyword) : -1;
        if (at >= 0 && (first === -1 || at < first)) {
            first = at;
            matchedLength = keyword.length;
        }
    }
    if (first === -1) {
        const head = text.slice(0, window).trim();
        return {
            snippet: head ? `${head}${text.length > window ? '...' : ''}` : '',
            snippetStart: 0,
            snippetPrefixLength: 0
        };
    }
    const start = Math.max(0, first - prefix);
    const end = Math.min(text.length, first + matchedLength + window);
    let snippet = text.slice(start, end).trim();
    let snippetPrefixLength = 0;
    if (start > 0) {
        snippet = `...${snippet}`;
        snippetPrefixLength = 3;
    }
    if (end < text.length) snippet = `${snippet}...`;
    return { snippet, snippetStart: start, snippetPrefixLength };
}

// Map line index → the nearest ATX heading at or before it. Uses the same
// fence-aware outline as section editing and the frontend table of contents,
// so a `# comment` inside a code block is never reported as a section.
// Returns null before the first (real) heading.
function createSectionMapper(content) {
    const outline = buildOutline(content);
    return function sectionFor(line) {
        let low = 0;
        let high = outline.length - 1;
        let found = null;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (outline[mid].line <= line) {
                found = outline[mid].text;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return found;
    };
}

// Deterministic ranking shared by providers: title matches first, then
// documents with more all-keyword co-occurrence lines (strongest multi-
// keyword signal), then more total matches, then more recently updated.
// `cap` bounds the list length.
function rankSearchResults(results, cap) {
    return results
        .sort((left, right) => (
            ((right.matchType === 'title') - (left.matchType === 'title'))
            || (Number(right.coLineCount || 0) - Number(left.coLineCount || 0))
            || (Number(right.matchCount || 0) - Number(left.matchCount || 0))
            || (Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
        ))
        .slice(0, cap);
}

module.exports = {
    MAX_KEYWORDS,
    splitKeywords,
    documentMatches,
    findLineOccurrences,
    sortOccurrences,
    detectBlockType,
    buildSnippet,
    createSectionMapper,
    rankSearchResults
};
