const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, 'public', 'managers', 'code-language-catalog.js');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
    + '\nmodule.exports = { CODE_LANGUAGE_CATALOG, findCodeLanguageSuggestions, resolveCodeLanguage, getCodeLanguageIconPath };\n';
const context = { module: { exports: {} }, exports: {}, String, Array, Math };
vm.runInNewContext(source, context, { filename: sourcePath });

const {
    CODE_LANGUAGE_CATALOG,
    findCodeLanguageSuggestions,
    resolveCodeLanguage,
    getCodeLanguageIconPath
} = context.module.exports;

assert(CODE_LANGUAGE_CATALOG.length >= 30, 'the built-in catalog should cover the requested common languages and formats');
assert.deepStrictEqual(
    Array.from(findCodeLanguageSuggestions('', 3), item => item.id),
    ['plaintext', 'javascript', 'python'],
    'an empty query should show only three useful defaults'
);
assert.strictEqual(findCodeLanguageSuggestions('py', 3)[0].id, 'python', 'py should match Python first');
assert.strictEqual(findCodeLanguageSuggestions('js', 3)[0].id, 'javascript', 'js should match JavaScript first');
assert.strictEqual(findCodeLanguageSuggestions('shell', 3)[0].id, 'bash', 'shell should match Bash first');
assert.strictEqual(findCodeLanguageSuggestions('ps', 3)[0].id, 'powershell', 'ps should match PowerShell first');
assert.strictEqual(findCodeLanguageSuggestions('md', 3)[0].id, 'markdown', 'md should match Markdown first');
assert.strictEqual(findCodeLanguageSuggestions('plain', 3)[0].id, 'plaintext', 'plain should match plaintext first');
assert.strictEqual(resolveCodeLanguage('c++'), 'cpp', 'C++ aliases should save the canonical cpp fence');
assert.strictEqual(resolveCodeLanguage('c#'), 'csharp', 'C# aliases should save the canonical csharp fence');
assert.strictEqual(resolveCodeLanguage('plaintxt'), 'plaintext', 'the common plaintxt spelling should resolve to plaintext');
assert.strictEqual(resolveCodeLanguage('vue'), 'vue', 'valid custom language names should remain available');
assert.strictEqual(resolveCodeLanguage('中文'), null, 'invalid fence language text should be rejected');
assert.strictEqual(getCodeLanguageIconPath('python'), '/Assets/code-language-icons/python.png', 'known languages should expose their bundled icon');
assert.strictEqual(getCodeLanguageIconPath('py'), '/Assets/code-language-icons/python.png', 'aliases should resolve to the canonical bundled icon');
assert.strictEqual(getCodeLanguageIconPath('plaintext'), '', 'languages without a bundled logo should use the compact text fallback');

console.log('Code language catalog checks passed');
