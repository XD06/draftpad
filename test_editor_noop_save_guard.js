const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function readHybridEditorSource() {
    return fs.readFileSync(path.join(ROOT, 'public', 'hybrid-editor.js'), 'utf8');
}

// Brace-match the body of a method (from its signature's `{` to the matching
// `}`) so assertions target one method, not the whole file.
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

function stripLineComments(code) {
    // hybrid-editor.js is CRLF; `.*` stops before \r so we drop only comments.
    return code.split('\n').map(line => line.replace(/\/\/.*/, '')).join('\n');
}

function run() {
    const source = readHybridEditorSource();

    // --- The semantic-equality oracle itself. ---
    const guard = stripLineComments(extractMethodBody(source, 'isMeaningfulMarkdownChange(candidate, base)'));
    assert(
        guard.includes('if (a === b) return false;'),
        'byte-identical values are not a change (cheap short-circuit, no render)'
    );
    assert(
        /const lute = this\.editor\?\.vditor\?\.lute;/.test(guard),
        'the guard must render through the editor\'s live Lute instance (real config), not a fresh one'
    );
    assert(
        guard.includes("if (!lute || typeof lute.Md2HTML !== 'function') return true;"),
        'without a Lute renderer the guard must default to meaningful (never silently drop an edit)'
    );
    assert(
        guard.includes('return lute.Md2HTML(a) !== lute.Md2HTML(b);'),
        'meaningfulness is decided by comparing rendered HTML: equal render == pure reformatting noise'
    );
    assert(
        /catch \(_error\) \{\s*return true;/.test(guard),
        'a render error must default to meaningful (save), never a dropped edit'
    );

    // --- Wiring: the guard must gate BOTH persistence entry points. ---
    const emitChange = stripLineComments(extractMethodBody(source, 'this.emitChange = debounce('));
    assert(
        emitChange.includes('const fromSource = this.sourceMode && this.sourceTextarea;'),
        'emitChange must still take source-mode text verbatim (never gate the user\'s literal Markdown)'
    );
    assert(
        emitChange.includes('if (!fromSource && !this.isMeaningfulMarkdownChange(value, this._lastValue)) return;'),
        'emitChange must skip adopting/saving a WYSIWYG re-serialization that is only reformatting noise'
    );
    // The early-return must precede the _lastValue write, or noise would still
    // pollute the canonical value even when the save is skipped.
    const guardIdx = emitChange.indexOf('isMeaningfulMarkdownChange(value, this._lastValue)) return;');
    const adoptIdx = emitChange.indexOf('this._lastValue = value;');
    assert(guardIdx !== -1 && adoptIdx !== -1 && guardIdx < adoptIdx,
        'the no-op guard must run before _lastValue is overwritten');

    const getValue = stripLineComments(extractMethodBody(source, 'getValue()'));
    assert(
        getValue.includes('serialized !== this._lastValue'),
        'getValue must byte-check first so the common (unchanged) case stays cheap'
    );
    assert(
        getValue.includes('!this.isMeaningfulMarkdownChange(serialized, this._lastValue)'),
        'getValue must fall back to the canonical _lastValue when the re-serialization is reformat-only'
    );
    assert(
        /return this\._lastValue;/.test(getValue),
        'getValue must return the pristine _lastValue for a reformat-only re-serialization'
    );

    console.log('Editor no-op save guard checks passed');
}

run();
