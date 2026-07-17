const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const hybrid = fs.readFileSync(path.join(root, 'public', 'hybrid-editor.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');
const loginStyles = fs.readFileSync(path.join(root, 'public', 'Assets', 'login.css'), 'utf8');
const fontPath = path.join(root, 'font', 'changerwencai.woff2');
const languageIconPath = path.join(root, 'public', 'Assets', 'code-language-icons', 'python.png');
const languageIconLicensePath = path.join(root, 'public', 'Assets', 'code-language-icons', 'LICENSE.txt');
const codeBlockSurfaceRule = styles.match(
    /\.typora-editor-shell \.vditor-reset \.vditor-wysiwyg__block\[data-type="code-block"\] > pre\s*\{([^}]*)\}/
)?.[1] || '';

assert(fs.existsSync(fontPath), 'the approved Chinese webfont should be bundled locally');
assert(fs.existsSync(languageIconPath), 'common language badges should use bundled offline icons');
assert(fs.existsSync(languageIconLicensePath), 'bundled language icons should retain their license and trademark notice');
assert(styles.includes('url("/font/changerwencai.woff2") format("woff2")'), 'the main interface should use the compressed approved Chinese webfont');
assert(loginStyles.includes('url("/font/changerwencai.woff2") format("woff2")'), 'the login interface should use the same compressed Chinese webfont');
assert(styles.includes('--code-bg: #fafaf8;'), 'light code blocks should use the approved warm white background');
assert(styles.includes('background-image: none !important;'), 'code blocks should explicitly remove Vditor background artwork');
assert(styles.includes('.dumbpad-code-lines::before') && styles.includes('content: attr(data-line-numbers);'), 'code line numbers should be a CSS-only visual gutter');
assert(
    styles.includes('.vditor-wysiwyg__block[data-type="code-block"] > pre') &&
        styles.includes('.vditor-wysiwyg__pre:not([style*="display: none"]):not([style*="display:none"]) + .vditor-wysiwyg__preview'),
    'code blocks should keep one stable visual surface and hide the duplicate preview while editing'
);
assert(
    /margin-bottom:\s*1em;/.test(codeBlockSurfaceRule),
    'the visible code surface should keep the same bottom margin in reading and editing modes'
);
assert(hybrid.includes('decorateCodeBlockLineNumbers(root)') && hybrid.includes('pre.dataset.lineNumbers = lineNumbers'), 'the editor should calculate visual line-number metadata after rendering');
assert(hybrid.includes('needsCodeDecoration') && hybrid.includes('this.decorateCodeBlockLineNumbers(root);'), 'Vditor code DOM replacements should be redecorated in the mutation microtask before paint');
assert(hybrid.includes('restoreCodeBlockLineNumberDecorations(clone)'), 'Markdown serialization should remove line-number decoration metadata');
assert(
    hybrid.includes("tools.className = 'dumbpad-code-tools'") &&
        hybrid.includes("copyButton.className = 'dumbpad-code-copy'") &&
        hybrid.includes("copyButton.setAttribute('aria-label', '复制代码')") &&
        hybrid.includes("pre.querySelector(':scope > code')"),
    'the editable code surface should provide an accessible copy icon that reads the current code'
);
assert(styles.includes('> pre > .dumbpad-code-tools'), 'the editable code tools should use the code block visual language');
assert(
    hybrid.includes("languageButton.className = 'dumbpad-code-language-badge'") &&
        hybrid.includes("languageBadge.className = 'dumbpad-code-language-badge is-readonly'") &&
        styles.includes('.dumbpad-code-language-badge'),
    'the code language should remain visible as a compact badge in editing and reading surfaces'
);
assert(
    hybrid.includes("popover.className = 'dumbpad-code-language-popover'") &&
        hybrid.includes('document.body.appendChild(popover)') &&
        hybrid.includes('findCodeLanguageSuggestions(input.value, 3)') &&
        hybrid.includes("input.addEventListener('compositionstart'") &&
        styles.includes('.dumbpad-code-language-popover'),
    'language editing should use an external IME-safe combobox with at most three suggestions'
);
assert(
    hybrid.includes('option.textContent = item.id') &&
        !hybrid.includes("detail.className = 'dumbpad-code-language-detail'") &&
        hybrid.includes("popover.style.setProperty('--code-language-popover-size'") &&
        styles.includes('width: calc(var(--code-language-popover-size, 9) * 1ch + 20px);'),
    'the language picker should show token-only options and size itself to the longest visible token'
);
assert(
    hybrid.includes("icon.className = 'dumbpad-code-language-icon'") &&
        styles.includes('.dumbpad-code-language-icon') &&
        codeBlockSurfaceRule.includes('padding: 30px 16px 12px 54px !important;'),
    'language badges should support compact icons in a reserved top tool row above code content'
);
assert(
    styles.includes('white-space: pre-wrap;') && styles.includes('overflow-wrap: anywhere;') && styles.includes('min-width: 0;'),
    'long code lines should wrap inside the article width without losing whitespace'
);
assert(!hybrid.includes("code.innerHTML = lineNumbers"), 'line numbers must never be inserted into code content');

console.log('Code block presentation checks passed');
