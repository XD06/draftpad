/**
 * Phase C — WYSIWYG caret-stability regression guard.
 *
 * These checks cover the pure logic and code wiring of the caret-stability
 * feature (flag reader, active-block detection, deferred decoration, and the
 * removal of guess-based retries on the stable typing path).  Because the
 * fix manipulates a live Vditor DOM + browser Selection, DOM behaviour cannot
 * be fully asserted in Node.
 *
 * REQUIRED MANUAL REAL-MACHINE REGRESSION (do before shipping the flag ON):
 * The feature ships OFF by default; enable it for testing via any of:
 *   - localStorage.setItem('dumbpad:caret-stability', 'on')   // then reload
 *   - window.__DUMBPAD_CARET_STABILITY = true
 * With the flag ON, in a real browser verify the caret does NOT jump when:
 *   1. Typing continuously in headings (#, ##) and ordered/unordered lists.
 *   2. Inserting a /time marker and continuing to type around it.
 *   3. Pasting multi-line/rich content mid-paragraph.
 *   4. Deleting an image/attachment card and continuing to type.
 *   5. Typing '==highlight==' inside an active block, then moving the caret
 *      away — the highlight should render only after the caret leaves.
 * With the flag OFF, confirm the editor behaves exactly as the shipped
 * baseline (this is the safe rollback path: flag off === old behaviour).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readHybridEditorSource() {
    return fs.readFileSync(path.join(ROOT, 'public', 'hybrid-editor.js'), 'utf8');
}

/**
 * Extract a class method by name from the source and return it as a callable
 * function.  Uses brace-matching so nested blocks are handled correctly.
 * The method is turned into `function <name>(...) { ... }` which is a valid
 * function declaration, then returned via a Function factory.  Extra scope
 * identifiers (e.g. window, Node) are injected as factory parameters.
 */
function extractMethod(source, name, scopeNames = []) {
    const signatureIndex = source.indexOf(`\n    ${name}(`);
    assert(signatureIndex >= 0, `method ${name} should exist in hybrid-editor.js`);
    const braceStart = source.indexOf('{', signatureIndex);
    assert(braceStart >= 0, `method ${name} should have a body`);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
        }
    }
    assert(end > braceStart, `method ${name} should have a balanced body`);
    const methodText = source.slice(signatureIndex + 1, end + 1); // "name(...) { ... }"
    const fnSource = `function ${methodText}\n; return ${name};`;
    const factory = new Function(...scopeNames, fnSource);
    return { factory, methodText };
}

function run() {
    const source = readHybridEditorSource();

    // --- Source wiring assertions (Phase C behaviour is flag-gated) ---
    assert(
        source.includes('isCaretStabilityEnabled()') &&
            source.includes("window.localStorage?.getItem?.('dumbpad:caret-stability')") &&
            source.includes('window.__DUMBPAD_CARET_STABILITY'),
        'Caret-stability must be a runtime feature flag (instance override, window flag, localStorage)'
    );
    assert(
        source.includes('handleWysiwygInput() {') &&
            /handleWysiwygInput\(\)\s*\{\s*if \(this\.isCaretStabilityEnabled\(\)\) \{\s*this\.handleWysiwygInputStable\(\);\s*return;/.test(source),
        'The typing path must branch to the stable handler only when the flag is enabled'
    );
    assert(
        source.includes('this.typingDecorateTimer = this.scheduleMarkDecorationRetry(80);'),
        'The default (flag OFF) typing path must remain unchanged, preserving the 80ms retry'
    );
    // The stable typing path must NOT schedule the guess-based retries.
    const { methodText: stableBody } = extractMethod(source, 'handleWysiwygInputStable');
    assert(
        !stableBody.includes('scheduleMarkDecorationRetry'),
        'The stable typing path must drop the 80/240ms guess-based decoration retries'
    );
    assert(
        stableBody.includes('this.scheduleDecorateRenderedMarks(this.getPerformanceToken(), generation, true)'),
        'The stable typing path must request active-block-skipping decoration'
    );
    assert(
        source.includes('decorateRenderedMarks(preserveCaret = true, performanceToken = this.getPerformanceToken(), skipActiveBlock = false)'),
        'decorateRenderedMarks must accept a skipActiveBlock parameter'
    );
    assert(
        source.includes('const deferActiveBlock = skipActiveBlock && this.isCaretStabilityEnabled();') &&
            source.includes('const activeBlock = deferActiveBlock ? this.getActiveCaretBlock(root) : null;') &&
            source.includes('this.scheduleDeferredActiveBlockDecoration();'),
        'decorateRenderedMarks must defer decoration for the caret block when the flag is on'
    );
    assert(
        source.includes('const caretSnapshot = (preserveCaret && !caretInSkippedBlock) ? this.saveCaretSnapshot(root) : null;'),
        'The caret snapshot restore must be skipped when the caret block was deferred (live Range stays valid)'
    );
    assert(
        source.includes("document.addEventListener('selectionchange', this.deferredActiveBlockHandler)"),
        'Deferred decoration must run once the caret leaves the edited block (selectionchange)'
    );
    assert(
        source.includes('if (needsFix) this.scheduleDecorateRenderedMarks(this.getPerformanceToken(), this.decorationGeneration, this.isCaretStabilityEnabled());'),
        'The marker MutationObserver must also skip the active block when the flag is enabled'
    );

    // --- Executable check: default OFF, runtime toggles ---
    const { factory: flagFactory } = extractMethod(source, 'isCaretStabilityEnabled', ['window']);

    const noWindow = flagFactory(undefined);
    assert(noWindow.call({ caretStabilityOverride: null }) === false,
        'With no window and no override the flag defaults OFF');

    const emptyWindow = flagFactory({});
    assert(emptyWindow.call({ caretStabilityOverride: null }) === false,
        'With an empty window the flag defaults OFF (verified baseline preserved)');

    assert(emptyWindow.call({ caretStabilityOverride: true }) === true,
        'An instance override of true must enable the flag');
    assert(emptyWindow.call({ caretStabilityOverride: false }) === false,
        'An instance override of false must force the flag OFF');

    const flaggedWindow = flagFactory({ __DUMBPAD_CARET_STABILITY: true });
    assert(flaggedWindow.call({ caretStabilityOverride: null }) === true,
        'window.__DUMBPAD_CARET_STABILITY=true must enable the flag');

    const makeStorageWindow = (value) => flagFactory({ localStorage: { getItem: () => value } });
    assert(makeStorageWindow('on').call({ caretStabilityOverride: null }) === true,
        "localStorage 'on' must enable the flag");
    assert(makeStorageWindow('true').call({ caretStabilityOverride: null }) === true,
        "localStorage 'true' must enable the flag");
    assert(makeStorageWindow('off').call({ caretStabilityOverride: null }) === false,
        "localStorage 'off' must disable the flag");
    assert(makeStorageWindow(null).call({ caretStabilityOverride: null }) === false,
        'Missing localStorage value must leave the flag OFF');

    // --- Executable check: active caret block detection ---
    const Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    function makeEl(parent) {
        const el = { nodeType: Node.ELEMENT_NODE, parentElement: parent || null };
        el.contains = (n) => {
            let cur = n;
            while (cur) { if (cur === el) return true; cur = cur.parentElement; }
            return false;
        };
        return el;
    }
    function makeText(parent, value) {
        return { nodeType: Node.TEXT_NODE, nodeValue: value, parentElement: parent };
    }

    const root = makeEl(null);
    const block = makeEl(root);        // top-level block (direct child of root)
    const inner = makeEl(block);       // e.g. a nested <strong> inside the paragraph
    const caretText = makeText(inner, 'editing here');
    const otherBlock = makeEl(root);

    const makeSelectionWindow = (range, collapsed) => ({
        getSelection: () => ({
            rangeCount: range ? 1 : 0,
            isCollapsed: collapsed,
            getRangeAt: () => range
        })
    });

    const { factory: blockFactory } = extractMethod(source, 'getActiveCaretBlock', ['window', 'Node']);

    const collapsedRange = { startContainer: caretText, startOffset: 3 };
    const winCollapsed = makeSelectionWindow(collapsedRange, true);
    const getBlock = blockFactory(winCollapsed, Node);
    assert(getBlock.call({}, root) === block,
        'getActiveCaretBlock must resolve the top-level block that contains the caret');

    const winRanged = makeSelectionWindow(collapsedRange, false);
    const getBlockRanged = blockFactory(winRanged, Node);
    assert(getBlockRanged.call({}, root) === null,
        'A non-collapsed selection must not report an active block');

    const outsideText = makeText(makeEl(null), 'detached');
    const winOutside = makeSelectionWindow({ startContainer: outsideText, startOffset: 0 }, true);
    const getBlockOutside = blockFactory(winOutside, Node);
    assert(getBlockOutside.call({}, root) === null,
        'A caret outside the editor root must not report an active block');

    const winNoRange = makeSelectionWindow(null, true);
    const getBlockNoRange = blockFactory(winNoRange, Node);
    assert(getBlockNoRange.call({}, root) === null,
        'No selection range must not report an active block');

    console.log('Hybrid editor caret-stability checks passed');
}

run();
