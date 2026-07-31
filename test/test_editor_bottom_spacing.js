const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Issue #6 (revised): on PC the article region must sit a real distance ABOVE
// the bottom of the editor viewport. The first fix padded empty space INSIDE
// the white card (pre.vditor-reset), which left an ugly tall empty area at the
// bottom of short notes. The breathing room now lives on the scroll container
// (.vditor-wysiwyg): a short note leaves a clean gap below the card and a long
// note never scrolls its last line flush against the bottom edge, while the
// card itself only carries a small, balanced internal bottom padding. Mobile
// keeps its own safe-area based bottom padding.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'Assets', 'ios-theme.css'), 'utf8');

// --- the desktop scroll container carries the bottom breathing room ---------
const scrollerSelector = 'body:not(.thoughts-mode) .typora-editor-shell .vditor-wysiwyg {';
const scrollerIdx = css.indexOf(scrollerSelector);
assert(scrollerIdx !== -1, 'the desktop WYSIWYG scroll container rule (.vditor-wysiwyg) must exist');

const scrollerBlock = css.slice(scrollerIdx, css.indexOf('}', scrollerIdx));
const scrollerPad = scrollerBlock.match(/padding-bottom:\s*(\d+)px/);
assert(scrollerPad, 'the desktop scroll container must set an explicit padding-bottom for bottom breathing room');
assert(
    Number(scrollerPad[1]) >= 120,
    `desktop scroll-container bottom padding should give real breathing room (got ${scrollerPad[1]}px, expected >= 120px)`
);

// That breathing room must apply on desktop only (min-width: 981px); mobile
// manages its own safe-area bottom padding.
const scrollerMedia = css.slice(0, scrollerIdx).lastIndexOf('@media');
assert(scrollerMedia !== -1, 'the desktop scroll container rule must sit inside a media query');
assert(
    /min-width:\s*981px/.test(css.slice(scrollerMedia, css.indexOf('{', scrollerMedia))),
    'the scroll-container breathing room must apply on desktop (min-width: 981px)'
);

// --- the card itself must hug its content, not carry a big internal pad ------
const cardSelector = 'body:not(.thoughts-mode) .typora-editor-shell .vditor-wysiwyg pre.vditor-reset {';
const cardIdx = css.indexOf(cardSelector);
assert(cardIdx !== -1, 'the desktop WYSIWYG content rule (pre.vditor-reset) must exist');

const cardBlock = css.slice(cardIdx, css.indexOf('}', cardIdx));
const cardPad = cardBlock.match(/padding-bottom:\s*(\d+)px/);
assert(
    !cardPad || Number(cardPad[1]) <= 48,
    `the article card must hug its content -- internal bottom padding should stay small (got ${cardPad ? cardPad[1] + 'px' : 'none'}, expected <= 48px), otherwise the empty area inside the card returns`
);

// Mobile must keep its existing safe-area based bottom padding untouched.
assert(
    css.includes('padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 64px)'),
    'mobile safe-area bottom padding must remain in place'
);

console.log('Editor bottom spacing regression checks passed');
