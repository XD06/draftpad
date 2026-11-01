const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const thoughtsCss = fs.readFileSync(path.join(root, 'public', 'Assets', 'thoughts.css'), 'utf8');
const iosCss = fs.readFileSync(path.join(root, 'public', 'Assets', 'ios-theme.css'), 'utf8');

function rule(css, selector) {
    const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert(match, `Missing CSS rule for ${selector}`);
    return match[1];
}

function matchingRules(css, selector) {
    const expression = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
    return [...css.matchAll(expression)].map(match => match[1]);
}

function assertNoCardLift(css, label) {
    const hoverRules = matchingRules(css, '.thought-card:hover');
    hoverRules.forEach((content, index) => {
        assert(!/\btransform\s*:/.test(content), `${label} hover rule ${index + 1} must not move Thought cards`);
        assert(!/\bbox-shadow\s*:/.test(content), `${label} hover rule ${index + 1} must not repaint card shadows`);
    });
}

const baseCard = rule(thoughtsCss, '.thought-card');
const iosCard = rule(iosCss, '.thought-card');
assert(!/\bwill-change\s*:\s*transform/.test(baseCard), 'idle Thought cards must not reserve transform compositing');
assert(!/\btransition\s*:\s*all/.test(baseCard), 'base Thought cards must not transition every property');
assert(!/\btransition\s*:\s*all/.test(iosCard), 'iOS Thought cards must not reintroduce transition: all');
assertNoCardLift(thoughtsCss, 'thoughts.css');
assertNoCardLift(iosCss, 'ios-theme.css');

const swipingCard = rule(thoughtsCss, '.thought-card.swiping');
assert(/\bwill-change\s*:\s*transform/.test(swipingCard), 'only active swipe gestures may reserve transform compositing');
assert(/\btransition\s*:\s*none/.test(swipingCard), 'swiping should track the pointer without delayed visual transitions');
assert(!/\bbox-shadow\s*:/.test(swipingCard), 'swiping must not repaint card shadows or add a left-edge inset stripe');
assert(!/\bborder-color\s*:/.test(swipingCard), 'swiping must not repaint card border color');
assert(/@property\s+--swipe-x\s*\{[^}]*inherits\s*:\s*false/.test(thoughtsCss), '--swipe-x must disable inheritance to avoid per-frame card subtree style recalculation');
assert(/@property\s+--swipe-action-opacity\s*\{[^}]*inherits\s*:\s*false/.test(thoughtsCss), '--swipe-action-opacity must disable inheritance to avoid per-frame card subtree style recalculation');

const pinnedTimeBefore = rule(thoughtsCss, '.thought-card.pinned .thought-time::before');
assert(/content\s*:\s*"置顶"/.test(pinnedTimeBefore), 'pinned Thought cards must show inline 置顶 badge in timestamp');
assert(!/\.thought-card\.pinned::before/.test(thoughtsCss), 'pinned Thought cards must not draw a left-edge inset stripe');

assert(!/\banimation\s*:\s*thoughtFadeIn/.test(thoughtsCss), 'opening Thoughts must not run a decorative view animation');
assert(!/\bbackdrop-filter\s*:/.test(rule(thoughtsCss, '.thoughts-header-actions')), 'the Thoughts header should use an opaque surface');
assert(!/\bbackdrop-filter\s*:/.test(rule(thoughtsCss, '.thoughts-input-bar')), 'the fixed Thought composer should not sample the page during scrolling');
assert(!/\bmax-width\s*:/.test(rule(thoughtsCss, '.thoughts-input-bar:focus-within')), 'composer focus must not animate layout width');

const reducedMotion = thoughtsCss.slice(thoughtsCss.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
assert(/\.view-container[\s\S]*animation\s*:\s*none/.test(reducedMotion), 'reduced motion must disable Thoughts view animation');
assert(/\.thought-card[\s\S]*transition-duration\s*:/.test(reducedMotion), 'reduced motion must cover Thought cards');

console.log('Thought motion policy checks passed');
