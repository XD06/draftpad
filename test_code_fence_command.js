const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, 'public', 'managers', 'code-fence-command.js');
const hybrid = fs.readFileSync(path.join(__dirname, 'public', 'hybrid-editor.js'), 'utf8');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
    + '\nmodule.exports = { PENDING_CODE_FENCE_GUARD, buildPendingCodeFenceText, parseCodeFenceCommand, buildCodeFenceMarkdown, normalizeCodeFenceLanguage, readCodeFenceLanguage, readCodeFenceBody, replaceCodeFenceLanguage };\n';
const context = { module: { exports: {} }, exports: {}, String, RegExp };
vm.runInNewContext(source, context, { filename: sourcePath });

const {
    PENDING_CODE_FENCE_GUARD,
    buildPendingCodeFenceText,
    parseCodeFenceCommand,
    buildCodeFenceMarkdown,
    normalizeCodeFenceLanguage,
    readCodeFenceLanguage,
    readCodeFenceBody,
    replaceCodeFenceLanguage
} = context.module.exports;

assert.strictEqual(PENDING_CODE_FENCE_GUARD.length, 1, 'pending fence guard should be one invisible character');
assert.strictEqual(buildPendingCodeFenceText('``', '', '`'), `\`\`${PENDING_CODE_FENCE_GUARD}\``, 'the third keyboard backtick should enter the guarded command state');
assert.strictEqual(buildPendingCodeFenceText('', '', '```'), `\`\`${PENDING_CODE_FENCE_GUARD}\``, 'IME or batched beforeinput should also preserve time to type a language');
assert.strictEqual(buildPendingCodeFenceText('text ', '', '```'), null, 'inline triples should remain ordinary input');
assert.strictEqual(parseCodeFenceCommand(`\`\`${PENDING_CODE_FENCE_GUARD}\``), '', 'plain triple backticks should create an untyped code block');
assert.strictEqual(parseCodeFenceCommand(`\`\`${PENDING_CODE_FENCE_GUARD}\`python`), 'python', 'a language name should remain editable before Enter');
assert.strictEqual(parseCodeFenceCommand('text ```python'), null, 'inline backticks must not become a fenced block');
assert.strictEqual(parseCodeFenceCommand(`\`\`${PENDING_CODE_FENCE_GUARD}\`python extra`), null, 'spaces are not valid in the fence language token');

const built = buildCodeFenceMarkdown('python');
assert.strictEqual(built.markdown, '```python\n\n```', 'confirmed fences should include an editable blank code line and a closing fence');
assert.strictEqual(built.caretOffset, '```python\n'.length, 'the caret should land on the first code line');
assert.strictEqual(normalizeCodeFenceLanguage('  c++  '), 'c++', 'language labels should be trimmed and preserve common punctuation');
assert.strictEqual(normalizeCodeFenceLanguage('python script'), null, 'language labels with spaces should be rejected');
assert.strictEqual(readCodeFenceLanguage('```javascript\nconst value = 1;\n```'), 'javascript', 'rendered fences should expose their current language');
assert.strictEqual(readCodeFenceBody('```javascript\nconst value = 1;\n```'), 'const value = 1;', 'rendered fences should expose code content for safe block matching');
assert.strictEqual(
    replaceCodeFenceLanguage('```\nconst value = 1;\n```', 'javascript'),
    '```javascript\nconst value = 1;\n```',
    'a rendered fence should support setting its language after Vditor creates the block'
);
assert(hybrid.includes('this.setWysiwygCodeFenceValue(next, domIndex);'), 'confirmed fences should use the dedicated code-block focus path');
assert(hybrid.includes('focusInsertedCodeBlock(blockIndex)'), 'the editor should activate the rendered code source layer after creating a fence');
assert(hybrid.includes("languageInput.className = 'dumbpad-code-language'"), 'editable rendered code blocks should provide a language input fallback');
assert(hybrid.includes('updateCodeBlockLanguage(block, languageInput.value)'), 'the language input should update the matching Markdown fence');

const enterMethod = hybrid.match(/    handlePendingCodeFenceEnter\([^)]*\) \{([\s\S]*?)\r?\n    \}\r?\n\r?\n    isArticleFileCommandKeydown/);
assert(enterMethod, 'code fence Enter handling should remain independently inspectable');
assert(!enterMethod[1].includes('setWysiwygValueAtMarkdownOffset'), 'code fences must not inject the generic private caret marker into code content');
assert(!hybrid.includes("event.isComposing || this.isComposing) {\n            return false;\n        }\n        if (!event.target?.closest?.('.vditor-wysiwyg'))"), 'literal backticks committed by an IME should still reach the pending fence guard');

console.log('Code fence command checks passed');
