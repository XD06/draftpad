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
// keeps its own safe-area based bottom padding. This test also pins that source
// mode mirrors the WYSIWYG card's TOP alignment so both modes start their text
// in the same place.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'Assets', 'ios-theme.css'), 'utf8');

// --- the desktop scroll container carries the bottom breathing room ---------
const scrollerSelector = 'body:not(.thoughts-mode) .typora-editor-shell .vditor-wysiwyg {';
const scrollerIdx = css.indexOf(scrollerSelector);
assert(scrollerIdx !== -1, 'the desktop WYSIWYG scroll container rule (.vditor-wysiwyg) must exist');

const scrollerBlock = css.slice(scrollerIdx, css.indexOf('}', scrollerIdx));
const scrollerPad = scrollerBlock.match(/padding-bottom:\s*(\d+)px/);
assert(scrollerPad, 'the desktop scroll container must set an explicit padding-bottom for bottom breathing room');
assert(
    Number(scrollerPad[1]) >= 64,
    `desktop scroll-container bottom padding should give real (but not excessive) breathing room (got ${scrollerPad[1]}px, expected >= 64px)`
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
const cardSelector = 'body:not(.thoughts-mode) .typora-editor-shell .vditor-wysiwyg pre.vditor-reset,';
const cardIdx = css.indexOf(cardSelector);
assert(cardIdx !== -1, 'the desktop WYSIWYG content rule (pre.vditor-reset) must exist');

const cardBlock = css.slice(cardIdx, css.indexOf('}', cardIdx));
const cardPad = cardBlock.match(/padding-bottom:\s*(\d+)px/);
assert(
    !cardPad || Number(cardPad[1]) <= 48,
    `the article card must hug its content -- internal bottom padding should stay small (got ${cardPad ? cardPad[1] + 'px' : 'none'}, expected <= 48px), otherwise the empty area inside the card returns`
);

// --- source mode must mirror the WYSIWYG card's TOP alignment ---------------
// Source mode used to sit at top:0 with a huge internal top padding, so its
// text floated far below the card's own top edge and never matched WYSIWYG. It
// must now start its card at the same top offset as the WYSIWYG card margin-top
// and use the same internal top padding, so the first line lands in the same
// place in both modes.
const cardMarginTop = cardBlock.match(/margin:\s*(\d+)px/);
const cardPadTop = cardBlock.match(/[\s;{]padding-top:\s*(\d+)px/);
assert(cardMarginTop && cardPadTop, 'the WYSIWYG card must declare an explicit top margin and top padding');

const sourceSelector = 'body:not(.thoughts-mode) .typora-source-editor {';
const sourceIdx = css.indexOf(sourceSelector);
assert(sourceIdx !== -1, 'the desktop source-mode rule (.typora-source-editor) must exist');
const sourceBlock = css.slice(sourceIdx, css.indexOf('}', sourceIdx));
const sourceTop = sourceBlock.match(/[\s;{]top:\s*(\d+)px/);
const sourcePadTop = sourceBlock.match(/[\s;{]padding-top:\s*(\d+)px/);
assert(sourceTop, 'desktop source mode must set an explicit top offset so its card mirrors the WYSIWYG card');
assert(sourcePadTop, 'desktop source mode must set an explicit top padding');
assert(
    Number(sourceTop[1]) === Number(cardMarginTop[1]),
    `source-mode card top offset (${sourceTop[1]}px) must match the WYSIWYG card margin-top (${cardMarginTop[1]}px) so both modes start at the same place`
);
assert(
    Number(sourcePadTop[1]) === Number(cardPadTop[1]),
    `source-mode internal top padding (${sourcePadTop[1]}px) must match the WYSIWYG card top padding (${cardPadTop[1]}px)`
);

// The source-mode alignment must apply on desktop only (min-width: 981px).
const sourceMedia = css.slice(0, sourceIdx).lastIndexOf('@media');
assert(sourceMedia !== -1, 'the desktop source-mode rule must sit inside a media query');
assert(
    /min-width:\s*981px/.test(css.slice(sourceMedia, css.indexOf('{', sourceMedia))),
    'the source-mode top alignment must apply on desktop (min-width: 981px)'
);

// Mobile must keep its existing safe-area based bottom padding untouched.
assert(
    css.includes('padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 64px)'),
    'mobile safe-area bottom padding must remain in place'
);

console.log('Editor bottom spacing + source/WYSIWYG top alignment regression checks passed');
