const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function readHybridEditorSource() {
    return fs.readFileSync(path.join(ROOT, 'public', 'hybrid-editor.js'), 'utf8');
}

function run() {
    const source = readHybridEditorSource();

    assert(
        source.includes('notifyEditorValueChanged(value = \'\')'),
        'Hybrid editor should expose a single path for programmatic value-change notifications'
    );
    assert(
        source.includes('event.stopImmediatePropagation?.();'),
        'WYSIWYG /time handling should stop the Enter event from reaching Vditor newline handlers'
    );
    assert(
        source.includes('if (this.handleWysiwygTimeCommand(event)) return;') &&
            source.includes('this.handleWysiwygSoftEnter(event);'),
        'WYSIWYG /time handling should run before plain paragraph soft Enter handling'
    );
    assert(
        source.includes('this.notifyEditorValueChanged(this.editor?.getValue?.() || this._lastValue || \'\');'),
        'WYSIWYG /time handling should notify the outer save pipeline after inserting a marker'
    );
    assert(
        source.includes('startParagraph.parentElement !== root') &&
            source.includes('const caretGuard = document.createTextNode(\'\\u200B\');'),
        'Plain WYSIWYG Enter should be limited to root paragraphs and keep a caret guard for stable soft breaks'
    );
    assert(
        !source.includes('this._lastValue = this.stripDisplayGuards(this.editor?.getValue?.() || this._lastValue || \'\');\n        this.scheduleDecorateRenderedMarks();'),
        'WYSIWYG /time handling should not update only the internal cache without dispatching input/change'
    );

    console.log('Hybrid editor time command checks passed');
}

run();
