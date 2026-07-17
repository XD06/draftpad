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
        source.includes("from './managers/code-fence-command.js'") &&
            source.includes('if (this.handlePendingCodeFenceTyping(event)) return;') &&
            source.includes('if (this.handlePendingCodeFenceEnter(event)) return;'),
        'pending code fences should intercept the third backtick and Enter before Vditor command handling'
    );
    assert(
        source.includes('handlePendingCodeFenceInput()') &&
            source.includes('PENDING_CODE_FENCE_GUARD') &&
            source.includes("this.container.addEventListener('beforeinput', this.pendingCodeFenceBeforeInputHandler, true)"),
        'pending code-fence language typing should remain guarded for keyboard and beforeinput insertion paths'
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
        source.includes('this.editor.deleteValue();') &&
            source.includes('this.editor.insertValue(markerText, true);') &&
            !source.includes('this.insertRenderedTimeMarkerAtRange(commandRange, markerText);'),
        'WYSIWYG /time insertion should replace the selected command through Vditor, preserving its block model'
    );
    assert(
        source.includes("this.closestElement(range.startContainer, 'code, .md-time-marker')") &&
            !source.includes("this.closestElement(range.startContainer, 'pre, code, .md-time-marker')"),
        'WYSIWYG /time detection must not reject the Vditor root pre element'
    );
    assert(
        source.includes('replaceRenderedTimeMarker(marker, nextMarker = \'\')') &&
            source.includes('this.replaceRenderedTimeMarker(marker, nextMarker);'),
        'Rendered time marker updates should avoid full-editor rerenders that reset the caret'
    );
    assert(
        source.includes('startParagraph.parentElement !== root') &&
            source.includes("const caretGuard = document.createTextNode('\\u200B');"),
        'Plain WYSIWYG Enter should be limited to root paragraphs and keep a caret guard for stable soft breaks'
    );
    assert(
        source.includes('isCaretAdjacentToTimeMarker(range)') &&
            source.includes('if (this.isCaretAdjacentToTimeMarker(range)) return null;'),
        'Enter immediately after a rendered /time marker should use Vditor paragraph creation instead of DumbPad soft breaks'
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
            source.includes('this.sourceTextarea.setSelectionRange(this.sourceCaretOffset, this.sourceCaretOffset);') &&
            source.includes('this.sourceTextarea.focus();') &&
            !source.includes('this.sourceTextarea.focus({ preventScroll: true });'),
        'Source mode should map the WYSIWYG caret to its Markdown offset and let the browser reveal the selection'
    );
    assert(
        source.includes("this.container.addEventListener('compositionstart'") &&
            source.includes("this.container.addEventListener('compositionend'") &&
            source.includes('this.isComposing = true;') &&
            source.includes('this.isComposing = false;') &&
            source.includes('this.isReadingMode || !this.sourceMode || this.isComposing'),
        'Composition input should defer marker decoration until the IME commits text'
    );
    assert(
        !source.includes('this.decorateRenderedMarks(true);'),
        'Marker observer should coalesce decoration instead of mutating during the input microtask'
    );
    assert(
        source.includes('range.insertNode(caretNode);') && source.includes("const CARET_MARKER = '\\uFEFF';"),
        'Decoration should anchor the caret even when raw /time source appears in a neighboring node'
    );
    assert(
        source.includes('bindTimeMarkerDragging()') &&
            source.includes('moveTimeMarker(value, drag.source, drag.sourceOffset, dropOffset)') &&
            source.includes('getMarkdownOffsetBeforeNode(root, marker)') &&
            source.includes("renderTimeMarkers(html, 'md-time-marker', { draggable: true })") &&
            source.includes('data-time-draggable="true"'),
        'Dragging a rendered time marker should move the corresponding Markdown marker instead of moving DOM only'
    );
    assert(
        source.includes('getCaretRangeFromPoint(clientX, clientY)') &&
            source.includes('showTimeMarkerDropCaret(root, event)') &&
            source.includes('this.hideTimeMarkerDropCaret();') &&
            source.includes("caret.className = 'time-marker-drop-caret';"),
        'Time marker dragging should show a non-editable visual caret at the Markdown drop position'
    );
    assert(
        source.includes('this.editor?.focus?.();') &&
            source.includes('restoreWysiwygCaretFromMarker()'),
        'Leaving Markdown source mode should restore focus to the visible editor at the preserved caret position'
    );
    assert(
        source.includes('setWysiwygValueAtMarkdownOffset(value = \'\', markdownOffset = 0, emit = true)') &&
            source.includes('restoreWysiwygCaretFromMarker()') &&
            source.includes('getMovedTimeMarkerCaretOffset(drag, dropOffset, next.length)') &&
            source.includes('this.setWysiwygValueAtMarkdownOffset(sourceValue, this.sourceCaretOffset, false);'),
        'Source-to-WYSIWYG transitions and marker moves should restore the exact Markdown caret offset after Vditor rerenders'
    );
    console.log('Hybrid editor time command checks passed');
}

run();
