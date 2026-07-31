'use strict';

const assert = require('assert');
const { applyNoteEdit, countOccurrences, VALID_ACTIONS } = require('../scripts/note-edits');

// Phase 1 of the fine-grained note editing work (#1). These primitives let an
// AI agent make small, targeted edits to a Markdown note instead of rewriting
// the whole article. The key safety property is the optional occurrence guard:
// a replace can assert exactly how many matches it expects and fail loudly
// rather than silently clobbering every occurrence.

// --- countOccurrences -------------------------------------------------------
assert.strictEqual(countOccurrences('a b a b a', 'a'), 3, 'counts non-overlapping matches');
assert.strictEqual(countOccurrences('aaaa', 'aa'), 2, 'non-overlapping count for repeated needle');
assert.strictEqual(countOccurrences('hello', 'z'), 0, 'missing needle counts zero');
assert.strictEqual(countOccurrences('hello', ''), 0, 'empty needle counts zero');

// --- simple actions (backward compatible) -----------------------------------
let r = applyNoteEdit('hello', { action: 'append', text: ' world' });
assert(r.ok && r.modified && r.content === 'hello world', 'append adds to the end');

r = applyNoteEdit('hello', { action: 'prepend', text: 'say ' });
assert(r.ok && r.content === 'say hello', 'prepend adds to the front');

r = applyNoteEdit('hello', { action: 'overwrite', text: 'new body' });
assert(r.ok && r.content === 'new body', 'overwrite replaces the whole body');

r = applyNoteEdit('hello', { action: 'overwrite' });
assert(r.ok && r.content === '', 'overwrite without text clears the body');

r = applyNoteEdit('hello', { action: 'append' });
assert(r.ok && r.modified === false && r.content === 'hello', 'append without text is a no-op');

// --- replace all + replace_first --------------------------------------------
r = applyNoteEdit('a foo b foo c', { action: 'replace', target: 'foo', replacement: 'bar' });
assert(r.ok && r.content === 'a bar b bar c', 'replace swaps every occurrence');
assert(r.matchCount === 2 && r.replaced === 2, 'replace reports match and replaced counts');

r = applyNoteEdit('a foo b foo c', { action: 'replace_first', target: 'foo', replacement: 'bar' });
assert(r.ok && r.content === 'a bar b foo c', 'replace_first swaps only the first occurrence');
assert(r.matchCount === 2 && r.replaced === 1, 'replace_first reports 2 matches but 1 replaced');

r = applyNoteEdit('keep this', { action: 'replace', target: 'this', replacement: '' });
assert(r.ok && r.content === 'keep ', 'replace with empty replacement deletes the target');

// --- occurrence guard (the core safety feature) -----------------------------
r = applyNoteEdit('x foo y foo z', { action: 'replace', target: 'foo', replacement: 'bar', expectedCount: 2 });
assert(r.ok && r.content === 'x bar y bar z', 'replace succeeds when expectedCount matches');

r = applyNoteEdit('x foo y foo z', { action: 'replace', target: 'foo', replacement: 'bar', expectedCount: 1 });
assert(!r.ok && r.errorCode === 'count_mismatch', 'replace fails when expectedCount does not match');
assert(r.matchCount === 2, 'count mismatch reports the actual match count');
assert(r.target === 'foo', 'count mismatch echoes the target for debugging');

r = applyNoteEdit('only one foo here', { action: 'replace_first', target: 'foo', replacement: 'bar', expectedCount: 1 });
assert(r.ok && r.content === 'only one bar here', 'expectedCount:1 lets an agent assert a unique target before editing');

r = applyNoteEdit('foo foo', { action: 'replace', target: 'foo', replacement: 'bar', expectedCount: 0 });
assert(!r.ok && r.errorCode === 'bad_expected_count', 'expectedCount must be a positive integer');

r = applyNoteEdit('foo foo', { action: 'replace', target: 'foo', replacement: 'bar', expectedCount: 1.5 });
assert(!r.ok && r.errorCode === 'bad_expected_count', 'expectedCount must be an integer');

// --- replace error cases -----------------------------------------------------
r = applyNoteEdit('hello', { action: 'replace', target: 'missing', replacement: 'x' });
assert(!r.ok && r.errorCode === 'target_not_found' && r.matchCount === 0, 'replace reports a missing target');

r = applyNoteEdit('hello', { action: 'replace', replacement: 'x' });
assert(!r.ok && r.errorCode === 'missing_target', 'replace requires a target');

// --- anchor inserts ----------------------------------------------------------
r = applyNoteEdit('# Title\n\nbody', { action: 'insert_after', target: '# Title\n', text: '\nintro line' });
assert(r.ok && r.content === '# Title\n\nintro line\nbody', 'insert_after places text right after the anchor');

r = applyNoteEdit('body end', { action: 'insert_before', target: 'end', text: 'the ' });
assert(r.ok && r.content === 'body the end', 'insert_before places text right before the anchor');

r = applyNoteEdit('a x b x c', { action: 'insert_after', target: 'x', text: 'X', expectedCount: 1 });
assert(!r.ok && r.errorCode === 'count_mismatch' && r.matchCount === 2, 'anchor insert honors the occurrence guard');

r = applyNoteEdit('a x b', { action: 'insert_after', target: 'missing', text: 'X' });
assert(!r.ok && r.errorCode === 'target_not_found', 'anchor insert reports a missing anchor');

r = applyNoteEdit('a x b', { action: 'insert_after', target: 'x' });
assert(!r.ok && r.errorCode === 'missing_text', 'anchor insert requires text to insert');

// --- invalid action ----------------------------------------------------------
r = applyNoteEdit('hello', { action: 'nope' });
assert(!r.ok && r.errorCode === 'invalid_action', 'unknown action is rejected');

r = applyNoteEdit('hello', {});
assert(!r.ok && r.errorCode === 'invalid_action', 'missing action is rejected');

// --- action catalog ----------------------------------------------------------
['append', 'prepend', 'overwrite', 'replace', 'replace_first', 'insert_before', 'insert_after'].forEach(action => {
    assert(VALID_ACTIONS.has(action), `${action} should be a recognized note edit action`);
});

console.log('Note fine-grained edit primitive checks passed');
