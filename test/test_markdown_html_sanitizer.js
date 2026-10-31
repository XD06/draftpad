// Regression for public/managers/markdown-html-sanitizer.js — the sanitizer
// applied to marked output before the copy-all / print paths touch
// innerHTML / document.write. jsdom provides the inert <template> parser.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');

function loadSanitizer() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'markdown-html-sanitizer.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export \{ sanitizeHtml \};/, 'module.exports = { sanitizeHtml };');
    const context = {
        module: { exports: {} },
        document: dom.window.document
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

const { sanitizeHtml } = loadSanitizer();

function removed(html, fragment) {
    return !sanitizeHtml(html).includes(fragment);
}

function main() {
    // Event handlers are stripped, the element itself survives.
    let out = sanitizeHtml('<img src="x" onerror="alert(1)">');
    assert(!/onerror/i.test(out), 'onerror must be removed');
    assert(out.includes('<img src="x">'), 'img element must survive: ' + out);

    // Case-insensitive attribute match.
    out = sanitizeHtml('<IMG SRC=x ONERROR=alert(1)>');
    assert(!/onerror/i.test(out), 'ONERROR must be removed');

    // on* prefix only: data-note and standard attributes survive.
    out = sanitizeHtml('<span data-note="1" class="x" title="keep">t</span>');
    assert(out.includes('data-note="1"') && out.includes('class="x"') && out.includes('title="keep"'), 'non-event attributes must survive');

    // Dangerous elements disappear entirely.
    for (const payload of ['<script>alert(1)</script>', '<iframe src="x"></iframe>', '<svg onload="alert(1)"></svg>', '<object data="x"></object>', '<style>body{}</style>']) {
        out = sanitizeHtml(payload);
        assert(removed(payload, payload.slice(1, 6)), 'dangerous element must be removed: ' + payload);
    }

    // Dangerous URL schemes are neutralized to "#", safe ones survive.
    out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    assert(out.includes('href="#"'), 'javascript: href must be neutralized: ' + out);
    out = sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>');
    assert(out.includes('href="#"'), 'case-mixed scheme must be neutralized');
    out = sanitizeHtml('<a href="javascript&#58;alert(1)">x</a>');
    assert(out.includes('href="#"'), 'entity-encoded scheme must be neutralized');
    out = sanitizeHtml('<a href="jav\tascript:alert(1)">x</a>');
    assert(out.includes('href="#"'), 'tab-obfuscated scheme must be neutralized');
    out = sanitizeHtml('<a href="https://example.com/a?b=1">x</a>');
    assert(out.includes('href="https://example.com/a?b=1"'), 'https href must survive');
    out = sanitizeHtml('<img src="data:image/png;base64,AAAA">');
    assert(out.includes('src="data:image/png;base64,AAAA"'), 'raster data image must survive');
    out = sanitizeHtml('<img src="data:text/html;base64,AAAA">');
    assert(out.includes('src="#"'), 'non-raster data URL must be neutralized');

    // Copy-all annotation markup used by app.js post-processing must survive.
    out = sanitizeHtml('<span class="has-annotation" data-note="n"><span>t</span></span><sub data-note-label="n">n</sub>');
    assert(out.includes('data-note="n"') && out.includes('data-note-label="n"'), 'annotation markup must survive');

    // Harmless markdown output is untouched.
    out = sanitizeHtml('<h1>Title</h1>\n<p>Text &amp; more</p>');
    assert(out.includes('<h1>Title</h1>') && out.includes('Text &amp; more'), 'plain markdown output must be preserved');

    console.log('markdown-html-sanitizer checks passed');
}

main();
