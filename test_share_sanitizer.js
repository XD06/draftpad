const assert = require('assert');
const { marked } = require('marked');
const { sanitizeHtml, escapeHtml } = require('./routes/share-routes');

// The public share page renders untrusted notepad content as HTML. marked v15
// does not sanitize raw HTML, so sanitizeHtml is the only barrier between a
// note author and script execution in a viewer's browser. These checks lock
// the known bypass classes closed and confirm legitimate content survives.
function run() {
    // --- Executable markup must be removed ---
    assert(!/<script/i.test(sanitizeHtml('<script>alert(1)</script>')), 'plain script tags must be stripped');
    assert(
        !/<script/i.test(sanitizeHtml('<scr<script>ipt>alert(1)</scr</script>ipt>')),
        'a script tag reassembled after a single pass must still be stripped (fixpoint)'
    );
    assert(!/<iframe/i.test(sanitizeHtml('<iframe src="//evil"></iframe>')), 'iframes must be stripped');
    assert(!/<object/i.test(sanitizeHtml('<object data="evil.swf"></object>')), 'object embeds must be stripped');
    assert(!/<embed/i.test(sanitizeHtml('<embed src="evil.swf">')), 'embeds must be stripped');
    assert(!/<form/i.test(sanitizeHtml('<form action="//evil"><input></form>')), 'forms and inputs must be stripped');
    assert(!/srcdoc/i.test(sanitizeHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe>')), 'srcdoc must be stripped');

    // --- Event handler attributes must be removed ---
    assert(!/onerror/i.test(sanitizeHtml('<img src=x onerror=alert(1)>')), 'unquoted on* handlers must be stripped');
    assert(!/onclick/i.test(sanitizeHtml('<a href="#" onclick="alert(1)">x</a>')), 'quoted on* handlers must be stripped');
    assert(!/onmouseover/i.test(sanitizeHtml("<b onmouseover='alert(1)'>x</b>")), 'single-quoted on* handlers must be stripped');

    // --- Dangerous URL schemes must be neutralized, including obfuscations ---
    const jsPlain = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    assert(!/javascript:/i.test(jsPlain) && /href="#"/.test(jsPlain), 'javascript: URLs must be neutralized to #');
    assert(!/javascript/i.test(sanitizeHtml('<a href="javascript&#58;alert(1)">x</a>')), 'entity-encoded colon (javascript&#58;) must be caught');
    assert(!/javascript/i.test(sanitizeHtml('<a href="jav\tascript:alert(1)">x</a>')), 'tab-split javascript: must be caught');
    assert(!/javascript/i.test(sanitizeHtml('<a href="  JAVASCRIPT:alert(1)">x</a>')), 'leading-space upper-case javascript: must be caught');
    assert(!/vbscript/i.test(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')), 'vbscript: URLs must be neutralized');
    assert(/href="#"/.test(sanitizeHtml('<a href="data:text/html,<b>x</b>">x</a>')), 'data:text/html URLs must be neutralized');

    // --- Legitimate content must be preserved ---
    const safeLink = sanitizeHtml('<a href="https://example.com/path?q=1">ok</a>');
    assert(/href="https:\/\/example\.com\/path\?q=1"/.test(safeLink), 'https links must be preserved intact');
    assert(/href="\/local\/page"/.test(sanitizeHtml('<a href="/local/page">ok</a>')), 'relative links must be preserved');
    const rasterImg = sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
    assert(/data:image\/png;base64,iVBORw0KGgo=/.test(rasterImg), 'inline raster data images must be preserved');
    const rich = sanitizeHtml(marked.parse('# Title\n\n- one\n- two\n\n**bold** and [link](https://example.com)'));
    assert(/<h1[^>]*>Title<\/h1>/.test(rich), 'headings must render');
    assert(/<li>one<\/li>/.test(rich) && /<li>two<\/li>/.test(rich), 'list items must render');
    assert(/<strong>bold<\/strong>/.test(rich), 'bold must render');
    assert(/href="https:\/\/example\.com"/.test(rich), 'markdown links to safe schemes must render');

    // --- The mark-token placeholders used by the share render pipeline must
    // survive sanitization untouched so Phase 3 rehydration still works. ---
    assert(sanitizeHtml('<p>@@MARK_TOKEN_0@@ text</p>') === '<p>@@MARK_TOKEN_0@@ text</p>', 'mark-token placeholders must survive');

    // --- End-to-end: raw HTML injected via markdown is defused ---
    const e2e = sanitizeHtml(marked.parse('normal text <img src=x onerror=alert(1)> more'));
    assert(!/onerror/i.test(e2e), 'on* handlers injected through markdown raw HTML must be stripped end-to-end');

    // escapeHtml sanity (used for titles/annotations).
    assert(escapeHtml('<b>"x"</b>') === '&lt;b&gt;&quot;x&quot;&lt;/b&gt;', 'escapeHtml must encode angle brackets and quotes');

    console.log('Share page sanitizer checks passed');
}

run();
