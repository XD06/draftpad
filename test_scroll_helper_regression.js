const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

assert(
    source.includes('const scrollStateByTarget = new WeakMap();') &&
        source.includes("document.addEventListener('scroll', handleScroll, true);"),
    'Scroll helper should capture scroll events from dynamic nested scrollers and track each target independently'
);
assert(
    !source.includes('let lastScrollY = 0;') &&
        !source.includes("setTimeout(() => {\n                [\n                    document.querySelector('.typora-editor-shell .vditor-wysiwyg')"),
    'Scroll helper should not share one scroll position or bind only the scrollers available after a fixed delay'
);

console.log('Scroll helper regression checks passed');
