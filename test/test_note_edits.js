'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyNoteEdit, applyNoteEdits, countOccurrences, buildOutline, VALID_ACTIONS } = require('../scripts/note-edits');

// Load the browser-side heading parser the same way test_heading_index.js does
// so we can assert the server outline matches the editor's table of contents.
const headingSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'managers', 'heading-index.js'), 'utf8')
    .replace(/export function /g, 'function ')
    + '\nmodule.exports = { buildMarkdownHeadingIndex };\n';
const headingCtx = { module: { exports: {} }, exports: {}, Map, String, Array };
vm.runInNewContext(headingSource, headingCtx, { filename: 'heading-index.js' });
const { buildMarkdownHeadingIndex } = headingCtx.module.exports;

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

// --- structure-aware outline (#1 phase 2) -----------------------------------
// The server outline must stay identical to the editor's table of contents,
// otherwise an agent's section slug would not line up with what a human sees.
[
    '',
    'intro\n# Title\nbody\n### Deep',
    '## **Hello** `World` ~~Now~~ ###',
    '# API 设计\n# API 设计\n# API-设计',
    '# !!!\n# ???\n# 中文 标题！',
    '# Alpha #\r\n###### Zeta ######\r\n'
].forEach(doc => {
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(buildOutline(doc))),
        JSON.parse(JSON.stringify(buildMarkdownHeadingIndex(doc).toc)),
        `server outline should match the editor TOC for: ${JSON.stringify(doc)}`
    );
});

// --- section edits (#1 phase 2) ---------------------------------------------
const doc = '# A\naaa\n# B\nbbb\n# C\nccc';

r = applyNoteEdit(doc, { action: 'replace_section', section: 'b', text: 'BBB' });
assert(r.ok && r.content === '# A\naaa\n# B\nBBB\n# C\nccc', 'replace_section swaps only the body under a heading');
assert(r.section === 'b', 'replace_section reports the resolved section slug');

r = applyNoteEdit(doc, { action: 'replace_section', section: 'c', text: 'CCC' });
assert(r.ok && r.content === '# A\naaa\n# B\nbbb\n# C\nCCC', 'replace_section handles the final section');

r = applyNoteEdit(doc, { action: 'replace_section', section: 'b', text: '' });
assert(r.ok && r.content === '# A\naaa\n# B\n# C\nccc', 'replace_section with empty text clears the body but keeps the heading');

r = applyNoteEdit(doc, { action: 'append_to_section', section: 'b', text: 'extra' });
assert(r.ok && r.content === '# A\naaa\n# B\nbbb\nextra\n# C\nccc', 'append_to_section adds to the end of the section body');

r = applyNoteEdit(doc, { action: 'append_to_section', section: 'B', text: 'z' });
assert(r.ok && r.section === 'b', 'a section can be resolved by exact heading text but is reported by slug');

r = applyNoteEdit(doc, { action: 'replace_section', section: 'nope', text: 'x' });
assert(!r.ok && r.errorCode === 'section_not_found' && r.section === 'nope', 'a missing section is reported');

r = applyNoteEdit(doc, { action: 'replace_section', text: 'x' });
assert(!r.ok && r.errorCode === 'missing_section', 'a section edit requires a section identifier');

r = applyNoteEdit(doc, { action: 'append_to_section', section: 'a' });
assert(!r.ok && r.errorCode === 'missing_text', 'a section edit requires text');

r = applyNoteEdit('# Dup\naaa\n# Dup\nbbb', { action: 'replace_section', section: 'Dup', text: 'x' });
assert(!r.ok && r.errorCode === 'ambiguous_section' && r.matchCount === 2, 'an ambiguous heading text is rejected in favor of a slug');

r = applyNoteEdit('# Dup\naaa\n# Dup\nbbb', { action: 'replace_section', section: 'dup-1', text: 'x' });
assert(r.ok && r.content === '# Dup\naaa\n# Dup\nx', 'a duplicated heading is addressable by its unique slug');

// --- invalid action ----------------------------------------------------------
r = applyNoteEdit('hello', { action: 'nope' });
assert(!r.ok && r.errorCode === 'invalid_action', 'unknown action is rejected');

r = applyNoteEdit('hello', {});
assert(!r.ok && r.errorCode === 'invalid_action', 'missing action is rejected');

// --- action catalog ----------------------------------------------------------
['append', 'prepend', 'overwrite', 'replace', 'replace_first', 'insert_before', 'insert_after', 'replace_section', 'append_to_section'].forEach(action => {
    assert(VALID_ACTIONS.has(action), `${action} should be a recognized note edit action`);
});

// --- batch edits (#1 phase 3) -----------------------------------------------
// A batch applies edits in order, feeds each edit the running result, and is
// atomic: if any edit fails the caller writes nothing.
let batch = applyNoteEdits('a foo b', [
    { action: 'replace', target: 'foo', replacement: 'bar', expectedCount: 1 },
    { action: 'append', text: ' end' }
]);
assert(batch.ok && batch.content === 'a bar b end', 'a batch applies edits in order');
assert(batch.modified === true && batch.results.length === 2, 'a batch reports per-edit results');
assert(batch.results[0].action === 'replace' && batch.results[0].replaced === 1, 'a batch result carries per-edit metadata');

batch = applyNoteEdits('x', [
    { action: 'append', text: 'y' },
    { action: 'replace', target: 'xy', replacement: 'Z' }
]);
assert(batch.ok && batch.content === 'Z', 'a later edit operates on the running result of an earlier one');

batch = applyNoteEdits('a foo b', [
    { action: 'append', text: ' ok' },
    { action: 'replace', target: 'missing', replacement: 'x' }
]);
assert(!batch.ok && batch.index === 1 && batch.errorCode === 'target_not_found', 'a failed edit reports its index and stops the batch');

batch = applyNoteEdits('a', []);
assert(!batch.ok && batch.errorCode === 'no_edits', 'an empty batch is rejected');

batch = applyNoteEdits('a', 'not-an-array');
assert(!batch.ok && batch.errorCode === 'no_edits', 'a non-array batch is rejected');

console.log('Note fine-grained edit primitive checks passed');
