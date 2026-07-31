'use strict';

// Fine-grained note (article body) editing primitives.
//
// These helpers exist so an AI agent (or any automation) can make small,
// targeted changes to a Markdown note without downloading the whole document,
// mutating it client-side, and posting a full overwrite back. A full overwrite
// is both wasteful and dangerous: it races with other devices and can silently
// clobber remote edits. The primitives here mirror a code editor's
// search/replace tool - match exact text, optionally assert how many times it
// occurs, and fail loudly instead of guessing.
//
// Every function is pure (no I/O), so the HTTP routes stay thin and the
// behavior is directly unit-testable.

// Actions that only need `text` and never touch existing content by matching.
const SIMPLE_ACTIONS = new Set(['append', 'prepend', 'overwrite']);
// Actions that locate existing text via `target`.
const TARGET_ACTIONS = new Set(['replace', 'replace_first', 'insert_before', 'insert_after']);
// Actions that locate a Markdown section via `section` (a heading slug or text).
const SECTION_ACTIONS = new Set(['replace_section', 'append_to_section']);

const VALID_ACTIONS = new Set([...SIMPLE_ACTIONS, ...TARGET_ACTIONS, ...SECTION_ACTIONS]);

// --- Structure awareness (Markdown ATX headings) -------------------------
// Mirror public/managers/heading-index.js so a server-computed outline lines
// up exactly with the table of contents the editor shows. A consistency test
// (test_note_edits.js) pins the two implementations together.
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function slugify(text, seen) {
    const base = String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-') || 'section';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
}

// Build the heading outline: [{ id, text, level, line }] with 0-based lines.
function buildOutline(content) {
    const seen = new Map();
    return String(content || '')
        .split('\n')
        .map((line, index) => {
            const match = line.match(HEADING_RE);
            if (!match) return null;
            const text = match[2].replace(/[`*_~[\]()]/g, '').trim();
            return { id: slugify(text, seen), text, level: match[1].length, line: index };
        })
        .filter(Boolean);
}

// Character offset at which each line begins.
function lineStartOffsets(source) {
    const offsets = [0];
    for (let i = 0; i < source.length; i += 1) {
        if (source[i] === '\n') offsets.push(i + 1);
    }
    return offsets;
}

// Resolve a section by slug first, then by exact heading text.
function findSection(outline, identifier) {
    const id = String(identifier == null ? '' : identifier).trim();
    if (!id) return { error: 'missing_section' };
    const bySlug = outline.find(h => h.id === id);
    if (bySlug) return { section: bySlug };
    const byText = outline.filter(h => h.text === id);
    if (byText.length === 1) return { section: byText[0] };
    if (byText.length > 1) return { error: 'ambiguous_section', matchCount: byText.length };
    return { error: 'section_not_found' };
}

// Character range [start, end) of a section body: everything below the heading
// line up to the next heading of any level (or the end of the document).
function sectionBodyRange(source, outline, index) {
    const offsets = lineStartOffsets(source);
    const headingLine = outline[index].line;
    const bodyStart = headingLine + 1 < offsets.length ? offsets[headingLine + 1] : source.length;
    const nextHeading = outline[index + 1];
    const bodyEnd = nextHeading ? offsets[nextHeading.line] : source.length;
    return { bodyStart, bodyEnd };
}

// Count non-overlapping occurrences of `needle` in `haystack`.
function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count += 1;
        idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
}

// Validate an optional occurrence guard. Returns null when valid, or an error
// result when the caller supplied a malformed expectedCount.
function checkExpectedCount(edit, matchCount, noun) {
    if (edit.expectedCount === undefined || edit.expectedCount === null) return null;
    const expected = Number(edit.expectedCount);
    if (!Number.isInteger(expected) || expected < 1) {
        return fail('bad_expected_count', 'expectedCount must be a positive integer');
    }
    if (matchCount !== expected) {
        return fail(
            'count_mismatch',
            `Expected ${expected} occurrence(s) of ${noun} but found ${matchCount}`,
            { matchCount }
        );
    }
    return null;
}

function ok(content, extra) {
    return { ok: true, content, modified: true, ...extra };
}

function unchanged(content) {
    return { ok: true, content, modified: false };
}

function fail(code, error, extra) {
    return { ok: false, errorCode: code, error, ...extra };
}

// Apply a single fine-grained edit to `content`.
//
// Returns one of:
//   { ok: true, content, modified: true, matchCount?, replaced? }
//   { ok: true, content, modified: false }              // no-op (e.g. append with no text)
//   { ok: false, errorCode, error, matchCount?, target? } // invalid edit -> caller returns 400
function applyNoteEdit(content, edit) {
    const source = typeof content === 'string' ? content : '';
    const action = edit && edit.action;

    if (!VALID_ACTIONS.has(action)) {
        return fail('invalid_action', 'Invalid action');
    }

    const text = edit.text;
    const target = edit.target;
    const replacement = edit.replacement;

    switch (action) {
        case 'append':
            if (text === undefined) return unchanged(source);
            return ok(source + text);
        case 'prepend':
            if (text === undefined) return unchanged(source);
            return ok(text + source);
        case 'overwrite':
            return ok(text || '');
        case 'replace':
        case 'replace_first': {
            if (!target) {
                return fail('missing_target', `${action} action requires a non-empty target`);
            }
            const matchCount = countOccurrences(source, target);
            if (matchCount === 0) {
                return fail('target_not_found', 'Target text not found in document', { matchCount: 0, target });
            }
            const guard = checkExpectedCount(edit, matchCount, 'target');
            if (guard) return { ...guard, target };
            const repl = replacement || '';
            if (action === 'replace') {
                return ok(source.split(target).join(repl), { matchCount, replaced: matchCount });
            }
            return ok(source.replace(target, repl), { matchCount, replaced: 1 });
        }
        case 'insert_before':
        case 'insert_after': {
            if (!target) {
                return fail('missing_target', `${action} action requires a non-empty target anchor`);
            }
            if (text === undefined) {
                return fail('missing_text', `${action} action requires text to insert`);
            }
            const matchCount = countOccurrences(source, target);
            if (matchCount === 0) {
                return fail('target_not_found', 'Anchor text not found in document', { matchCount: 0, target });
            }
            const guard = checkExpectedCount(edit, matchCount, 'anchor');
            if (guard) return { ...guard, target };
            const idx = source.indexOf(target);
            const next = action === 'insert_before'
                ? source.slice(0, idx) + text + source.slice(idx)
                : source.slice(0, idx + target.length) + text + source.slice(idx + target.length);
            return ok(next, { matchCount });
        }
        case 'replace_section':
        case 'append_to_section': {
            const outline = buildOutline(source);
            const found = findSection(outline, edit.section);
            if (found.error === 'missing_section') {
                return fail('missing_section', `${action} action requires a section slug or heading`);
            }
            if (found.error === 'ambiguous_section') {
                return fail(
                    'ambiguous_section',
                    'Multiple headings share that text; target it by slug from GET /api/notes/:id/outline',
                    { matchCount: found.matchCount, section: String(edit.section) }
                );
            }
            if (found.error) {
                return fail('section_not_found', 'Section heading not found in document', { section: String(edit.section) });
            }
            if (text === undefined) {
                return fail('missing_text', `${action} action requires text`);
            }
            const index = outline.indexOf(found.section);
            const { bodyStart, bodyEnd } = sectionBodyRange(source, outline, index);
            if (action === 'replace_section') {
                const before = source.slice(0, bodyStart);
                const after = source.slice(bodyEnd);
                let body = text;
                // Keep the heading on its own line and separated from what follows.
                if (before.length && !before.endsWith('\n') && body) body = '\n' + body;
                if (after.length && body && !body.endsWith('\n')) body += '\n';
                return ok(before + body + after, { section: found.section.id });
            }
            // append_to_section: insert at the end of the section body.
            const before = source.slice(0, bodyEnd);
            const after = source.slice(bodyEnd);
            let toInsert = text;
            if (before.length && !before.endsWith('\n')) toInsert = '\n' + toInsert;
            if (after.length && !toInsert.endsWith('\n')) toInsert = toInsert + '\n';
            return ok(before + toInsert + after, { section: found.section.id });
        }
        default:
            return fail('invalid_action', 'Invalid action');
    }
}

// Map an edit failure onto an HTTP status. Callers turn { ok: false } results
// into 4xx responses; everything here is a client-correctable request.
function statusForEditError(errorCode) {
    return 400;
}

module.exports = {
    VALID_ACTIONS,
    countOccurrences,
    buildOutline,
    applyNoteEdit,
    statusForEditError
};
