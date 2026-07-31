const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Issue #6: on PC the WYSIWYG article body sat flush against the bottom edge of
// the editor viewport, so the last lines were cramped and awkward to edit. The
// desktop WYSIWYG content root (pre.vditor-reset) must carry a real bottom
// padding so the end of a note has breathing room. Mobile keeps its own
// safe-area based bottom padding.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'Assets', 'ios-theme.css'), 'utf8');

const selector = 'body:not(.thoughts-mode) .typora-editor-shell .vditor-wysiwyg pre.vditor-reset {';
const idx = css.indexOf(selector);
assert(idx !== -1, 'the desktop WYSIWYG content rule (pre.vditor-reset) must exist');

const block = css.slice(idx, css.indexOf('}', idx));
const match = block.match(/padding-bottom:\s*(\d+)px/);
assert(match, 'the desktop WYSIWYG content rule must set an explicit padding-bottom');
assert(
    Number(match[1]) >= 120,
    `desktop bottom padding should give real breathing room (got ${match[1]}px, expected >= 120px)`
);

// The rule must live inside a desktop media query, not accidentally apply on
// mobile (which manages its own safe-area bottom padding).
const lastMedia = css.slice(0, idx).lastIndexOf('@media');
assert(lastMedia !== -1, 'the desktop WYSIWYG content rule must sit inside a media query');
const mediaDecl = css.slice(lastMedia, css.indexOf('{', lastMedia));
assert(
    /min-width:\s*981px/.test(mediaDecl),
    'the extra bottom padding must apply on desktop (min-width: 981px)'
);

// Mobile must keep its existing safe-area based bottom padding untouched.
assert(
    css.includes('padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 64px)'),
    'mobile safe-area bottom padding must remain in place'
);

console.log('Editor bottom spacing regression checks passed');
