const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadTextFormatting() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-text-formatting.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { escapeHtml, escapeRegExp, linkifyText };\n';
    const context = {
        module: { exports: {} },
        exports: {}
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const { escapeHtml, escapeRegExp, linkifyText } = loadTextFormatting();

    assert(escapeHtml(null) === '', 'escapeHtml should match DOM escaping for nullish values');
    assert(escapeHtml('<tag attr="x">&') === '&lt;tag attr=&quot;x&quot;&gt;&amp;', 'escapeHtml should escape HTML-sensitive characters');
    assert(escapeRegExp('a+b*(c)') === 'a\\+b\\*\\(c\\)', 'escapeRegExp should escape regex metacharacters');

    const linked = linkifyText('Visit www.example.com/path, then https://example.org/a(b).');
    assert(
        linked.includes('<a href="https://www.example.com/path" target="_blank" rel="noopener noreferrer" class="thought-link">www.example.com/path</a>,'),
        'linkifyText should link www URLs and preserve trailing comma'
    );
    assert(
        linked.includes('<a href="https://example.org/a(b)" target="_blank" rel="noopener noreferrer" class="thought-link">https://example.org/a(b)</a>.'),
        'linkifyText should keep balanced closing parentheses inside URLs and preserve trailing period'
    );

    const escapedLink = linkifyText('https://example.com/?a=1&b=<x>');
    assert(escapedLink.includes('a=1&amp;b=&lt;x&gt</a>;'), 'linkifyText should preserve the existing escape-before-link behavior for escaped angle brackets');
    assert(linkifyText('') === '', 'linkifyText should keep empty text empty');

    console.log('Thought text formatting checks passed');
}

run();
