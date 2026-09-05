const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readHybridEditorSource() {
    return fs.readFileSync(path.join(ROOT, 'public', 'hybrid-editor.js'), 'utf8');
}

// Extract a method body by brace matching, starting at a signature substring.
function extractMethodBody(source, signature) {
    const start = source.indexOf(signature);
    assert(start !== -1, `expected to find ${signature} in hybrid-editor.js`);
    const braceStart = source.indexOf('{', start);
    assert(braceStart !== -1, `expected an opening brace after ${signature}`);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(braceStart, i + 1);
        }
    }
    throw new Error(`could not find the closing brace for ${signature}`);
}

function run() {
    const source = readHybridEditorSource();
    const setSourceMode = extractMethodBody(source, 'setSourceMode(enabled)');
    // Strip line comments so assertions inspect executable code, not the rationale
    // comment (which legitimately names readWysiwygMarkdownValue to explain the fix).
    const setSourceModeCode = setSourceMode
        .split('\n')
        .map(line => line.replace(/\/\/.*/, ''))
        .join('\n');

    // Entering source mode must display the canonical stored markdown, NOT a fresh
    // re-serialization of the WYSIWYG DOM. Re-serializing via readWysiwygMarkdownValue()
    // -> Lute wysiwygDom2Md reformats content that was never edited (it pads every GFM
    // table cell to the column width, expands "| --- |" separators to full-width dashes,
    // and drops the blank line after a YAML front-matter "---" fence which then degrades
    // into setext dashes on the next round-trip). Running that on every source toggle
    // silently rewrote untouched documents and the damage compounded on each toggle.
    assert(
        setSourceModeCode.includes("const value = this._lastValue || this.pendingValue || '';"),
        'Entering source mode must show the canonical _lastValue, not a re-serialized DOM'
    );

    // The lossy WYSIWYG->markdown re-serialization must never run when toggling into
    // source mode. _lastValue already tracks every edit (emitChange / notifyEditorValueChanged)
    // and equals the pristine markdown when nothing was edited.
    assert(
        !setSourceModeCode.includes('readWysiwygMarkdownValue'),
        'setSourceMode must not re-serialize the DOM (readWysiwygMarkdownValue) when entering source mode'
    );

    // Leaving source mode must still rebuild the WYSIWYG surface from the edited source
    // textarea (this direction is unchanged and must keep working).
    assert(
        setSourceModeCode.includes('this.setWysiwygValueAtMarkdownOffset(sourceValue, this.sourceCaretOffset, false);'),
        'Leaving source mode must rebuild the WYSIWYG surface from the source textarea value'
    );

    // _lastValue must remain the single source of truth kept in sync on every edit path,
    // so that using it in source mode is loss-free.
    assert(
        source.includes('this._lastValue = value;') &&
            source.includes('this.emitChange = debounce('),
        'WYSIWYG edits must keep _lastValue in sync via the debounced emitChange pipeline'
    );

    console.log('Source-mode round-trip checks passed');
}

run();
