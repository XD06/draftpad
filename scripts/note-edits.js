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

const VALID_ACTIONS = new Set([...SIMPLE_ACTIONS, ...TARGET_ACTIONS]);

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
    applyNoteEdit,
    statusForEditError
};
