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
        source.includes('this.notifyEditorValueChanged();'),
        'WYSIWYG /time handling should notify the outer save pipeline after DOM-local time marker changes'
    );
    assert(
        source.includes('readWysiwygMarkdownValue(fallback = \'\')') &&
            source.includes('this.restoreRenderedTimeMarkers(clone);'),
        'WYSIWYG markdown reads should restore rendered time markers before serializing'
    );
    assert(
        source.includes('this.insertRenderedTimeMarkerAtRange(commandRange, markerText);') &&
            !source.includes('this.editor?.insertValue?.(buildTimeMarker(), true);'),
        'WYSIWYG /time insertion should keep inline position without Vditor block serialization'
    );
    assert(
        source.includes('replaceRenderedTimeMarker(marker, nextMarker = \'\')') &&
            source.includes('this.replaceRenderedTimeMarker(marker, nextMarker);'),
        'Rendered time marker updates should avoid full-editor rerenders that reset the caret'
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

    assert(
        source.includes("root.querySelectorAll('.md-time-marker')") &&
            !source.includes("'.md-time-marker, .md-mark, [data-draw], .has-annotation'"),
        'Only time markers should stay atomic; highlight, draw-line and annotation text must remain editable'
    );
    assert(
        source.includes('getMarkdownOffsetForDomPoint(root, node, offset)') &&
            source.includes('this.getMarkdownOffsetForDomPoint(root, range.startContainer, range.startOffset)') &&
            source.includes('this.sourceTextarea.setSelectionRange(this.sourceCaretOffset, this.sourceCaretOffset);'),
        'Source mode should map the WYSIWYG caret to its Markdown offset instead of resetting to zero'
    );
    assert(
        !source.includes('this.decorateRenderedMarks(true);'),
        'Marker observer should coalesce decoration instead of mutating during the input microtask'
    );
    assert(
        source.includes('range.insertNode(caretNode);') && source.includes("const CARET_MARKER = '\\uFEFF';"),
        'Decoration should anchor the caret even when raw /time source appears in a neighboring node'
    );
    console.log('Hybrid editor time command checks passed');
}

run();
