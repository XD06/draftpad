const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadSwipeHelpers() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-swipe.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { getThoughtSwipeState };\n';
    const context = { module: { exports: {} }, exports: {}, Math, Number };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

const { getThoughtSwipeState } = loadSwipeHelpers();
const idle = getThoughtSwipeState(0, 150, 180);
assert.strictEqual(idle.swipeX, 0);
assert.strictEqual(idle.ready, false);
assert.strictEqual(idle.progress, 0);
assert.strictEqual(idle.actionOpacity, 0);

const partial = getThoughtSwipeState(75, 150, 180);
assert.strictEqual(partial.swipeX, 75);
assert.strictEqual(partial.ready, false);
assert(partial.progress > 0.49 && partial.progress < 0.51);
assert(partial.actionOpacity > 0.5, 'trash action should become visible well before the threshold');

const ready = getThoughtSwipeState(150, 150, 180);
assert.strictEqual(ready.ready, true);
assert.strictEqual(ready.progress, 1);
assert.strictEqual(ready.actionOpacity, 1);

const clamped = getThoughtSwipeState(500, 150, 180);
assert.strictEqual(clamped.swipeX, 180);
assert.strictEqual(clamped.ready, true);
console.log('Thought swipe helper checks passed');

// Card swipe performance regression: per-pointermove custom property writes
// invalidate style for the whole card subtree, which visibly lagged on cards
// with many subtask rows (and pointermove fires twice per frame on
// high-refresh screens). The move path must coalesce its writes into one
// requestAnimationFrame and only touch the two CSS variables actually
// consumed by the stylesheet; the card transform is driven by --swipe-x.
const thoughtsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
const moveBody = thoughtsSource.slice(
    thoughtsSource.indexOf("card.addEventListener('pointermove', (event) => {"),
    thoughtsSource.indexOf('const finishSwipe = async (event) => {')
);
assert(
    moveBody.includes('requestAnimationFrame(') &&
        moveBody.includes('pendingSwipeState = getThoughtSwipeState(deltaX, threshold, maxSwipe);') &&
        moveBody.includes('if (swipeFrameScheduled) return;'),
    'card swipe move must coalesce style writes into one animation frame'
);
assert(
    !moveBody.includes('card.style.transform') &&
        !moveBody.includes("'--swipe-progress'"),
    'card swipe move must not write inline transform or the unused --swipe-progress variable'
);
assert(
    moveBody.includes("'--swipe-x'") &&
        moveBody.includes("'--swipe-action-opacity'"),
    'card swipe move must still update the consumed swipe variables'
);
console.log('Thought swipe card performance checks passed');
