const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Issue #5: the caret occasionally "vanished" mid-edit. Root cause: when a
// background sync / 409 auto-merge landed while the user was typing, the app
// replaced the whole document with a plain setValue(), which collapses the
// WYSIWYG caret to the top of the note. The fix routes those remote applies
// through a caret-preserving path that only kicks in when the editor is focused
// (so notepad switches and first loads still reset the caret as before).
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'hybrid-editor.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// --- Editor: focus probe used to decide whether to preserve the caret --------
assert(
    editorSource.includes('editorHasFocus()'),
    'hybrid-editor should expose editorHasFocus() to gate caret preservation'
);
const focusStart = editorSource.indexOf('editorHasFocus() {');
assert(focusStart !== -1, 'editorHasFocus() must be defined as a method');
const focusBody = editorSource.slice(focusStart, focusStart + 700);
assert(
    focusBody.includes('document.activeElement === this.sourceTextarea') &&
        focusBody.includes("querySelector('.vditor-wysiwyg .vditor-reset')") &&
        focusBody.includes('root.contains('),
    'editorHasFocus() must detect focus in both source-mode and WYSIWYG'
);

// --- Editor: caret-preserving whole-document replacement --------------------
assert(
    editorSource.includes('setValuePreservingCaret(value, emit = false)'),
    'hybrid-editor should expose setValuePreservingCaret(value, emit)'
);
const preserveStart = editorSource.indexOf('setValuePreservingCaret(value, emit = false)');
const preserveBody = editorSource.slice(preserveStart, preserveStart + 900);
assert(
    /if \(!this\.editorHasFocus\(\)\)\s*\{\s*this\.setValue\(value, emit\);/.test(preserveBody),
    'setValuePreservingCaret must fall back to a plain setValue when unfocused'
);
assert(
    preserveBody.includes('this.sourceTextarea.selectionStart') &&
        preserveBody.includes('this.sourceTextarea.setSelectionRange(clamped, clamped)') &&
        preserveBody.includes('Math.min(caret, this.sourceTextarea.value.length)'),
    'setValuePreservingCaret must restore (clamped) the source-mode caret'
);
assert(
    preserveBody.includes('this.getCurrentWysiwygMarkdownOffset()') &&
        preserveBody.includes('this.setWysiwygValueAtMarkdownOffset(value, caretOffset, emit, true)'),
    'remote WYSIWYG applies must preserve both the caret offset and the existing scroll position'
);
assert(
    preserveBody.includes('const scrollTop = this.sourceTextarea.scrollTop') &&
        preserveBody.includes('this.sourceTextarea.scrollTop = scrollTop'),
    'remote source-mode applies must retain the existing textarea scroll position'
);

// The editor must never scroll solely because an IME composition starts. Each
// Chinese character starts a composition, so proactive smooth scrolling makes
// the reading position drift even though the caret is already visible.
assert(
    !editorSource.includes('scrollCaretIntoComfortableView'),
    'composition events must not proactively reposition the editor viewport'
);

// --- App: proxy exposes applyRemoteValue delegating to the editor ------------
assert(
    appSource.includes('applyRemoteValue(val)'),
    'the editor proxy should expose applyRemoteValue(val)'
);
const applyStart = appSource.indexOf('applyRemoteValue(val)');
const applyBody = appSource.slice(applyStart, applyStart + 700);
assert(
    applyBody.includes('editorInstance.setValuePreservingCaret(pendingEditorValue, false)'),
    'applyRemoteValue must delegate to the editor caret-preserving setter'
);
assert(
    applyBody.includes('document.activeElement === bootEditor') &&
        applyBody.includes('setSelectionRange(Math.min(start, max), Math.min(end, max))'),
    'applyRemoteValue must also preserve the boot-editor caret when focused'
);

// --- App: remote/merge applies must go through applyRemoteValue --------------
assert(
    !/editor\.value = merge\.content/.test(appSource) &&
        !/editor\.value = detail\.content/.test(appSource),
    'no remote/merge apply should use a plain caret-dropping editor.value assignment'
);
const remoteApplies = (appSource.match(/editor\.applyRemoteValue\(/g) || []).length;
assert(
    remoteApplies >= 5,
    `every remote/merge apply site should use applyRemoteValue (found ${remoteApplies}, expected >= 5)`
);

assert(editorSource.includes('restorePersistentCaret(snapshot'), 'editor should expose a persisted caret restore path');
assert(appSource.includes('dumbpad_caret_positions_v1'), 'app should persist caret positions separately from note content');
assert(appSource.includes('saveEditorCaretForNotepad'), 'app should save the active article caret before switching notes');
assert(appSource.includes('restoreEditorCaretForNotepad'), 'app should restore the last caret for the selected article');

console.log('Editor caret preservation regression checks passed');
