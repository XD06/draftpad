const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

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
