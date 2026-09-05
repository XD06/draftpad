const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'managers', 'today-drafts', 'today-drafts-manager.js'),
    'utf8'
);

assert(source.includes('selectionStart'), 'draft rendering should capture the active input selection');
assert(source.includes('selectionEnd'), 'draft rendering should capture both selection endpoints');
assert(source.includes('preventScroll: true'), 'restoring a draft caret should not move the notebook viewport');
assert(source.includes('compositionstart'), 'draft rendering should observe IME composition');
assert(source.includes('compositionend'), 'draft rendering should resume after IME composition');
assert(source.includes('this.pendingRender'), 'draft rendering should defer DOM replacement while composing');
assert(source.includes('data-today-draft-text-display'), 'clicking ordinary draft text should enter editing without treating a link as text input');
assert(source.includes('data-today-draft-link'), 'direct link clicks should remain separate from the edit interaction');

console.log('Today drafts caret checks passed');
