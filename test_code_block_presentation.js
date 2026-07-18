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
assert(
    hybrid.includes('new MutationObserver(records') &&
        hybrid.includes('const changedCode = new Set()') &&
        hybrid.includes('this.decorateCodeBlockLineNumbers(root, changedCode)'),
    'Vditor code DOM replacements should redecorate only changed code blocks before paint'
);
assert(
    hybrid.includes("const DISPLAY_MERMAID_LANGUAGE = 'dumbpad-mermaid'") &&
        hybrid.includes('restoreEditorDisplayLanguages') &&
        hybrid.includes(".replace(/(^|\\n)([ \\t]*`{3,})mermaid"),
    'Mermaid source should bypass Vditor diagram rendering inside the editor and restore on serialization'
);
assert(
    hybrid.includes('bindMermaidPasteNormalization()') &&
        hybrid.includes("event.clipboardData?.getData('text/plain')") &&
        hybrid.includes('this.prepareMermaidDisplayValue(text)') &&
        hybrid.includes('new DataTransfer()') &&
        hybrid.includes("new ClipboardEvent('paste'") &&
        hybrid.includes('event.target.dispatchEvent(normalizedEvent)') &&
        hybrid.includes("this.closestElement(range.startContainer, 'code')") &&
        hybrid.includes('event.clipboardData?.files?.length'),
    'Mermaid clipboard text should be normalized before Vditor can render it without intercepting files or code content'
);
assert(hybrid.includes('restoreCodeBlockLineNumberDecorations(clone)'), 'Markdown serialization should remove line-number decoration metadata');
assert(
    hybrid.includes("root?.querySelectorAll?.('pre').forEach(pre =>") &&
        hybrid.includes("pre.querySelector(':scope > .dumbpad-code-header')?.remove()") &&
        hybrid.includes('delete pre.dataset.dumbpadCodeSignature'),
    'Markdown serialization should always remove code headers even if Vditor replaced their decoration metadata'
);
assert(
    hybrid.includes('scheduleMissingCodeBlockDecoration()') &&
        hybrid.includes("?.querySelectorAll('pre > code')") &&
        hybrid.includes('pair => candidateSet.add(pair)'),
    'typing should restore headers on both Vditor code surfaces after either surface is replaced'
);
assert(
    hybrid.includes("el.closest?.('.dumbpad-code-header')") &&
        hybrid.includes("tools.setAttribute('contenteditable', 'false')"),
    'global editor enable/disable must never make code toolbar labels editable code content'
);
assert(
    hybrid.includes('bindCodeBlockCaretPlacement()') &&
        hybrid.includes('restoreCodeCaretFromPointer(pending)') &&
        hybrid.includes('caretRangeFromPoint'),
    'opening a code block should restore the caret at the pointer location instead of the first character'
);
assert(
    hybrid.includes('renderMermaidDiagrams()') &&
        hybrid.includes('window.Vditor.mermaidRender(') &&
        hybrid.includes("render.className = 'dumbpad-mermaid-render language-mermaid'") &&
        hybrid.includes("root?.querySelectorAll?.('.dumbpad-mermaid-render').forEach(render => render.remove())"),
    'Mermaid should remain safe source while editing and render on entering reading mode'
);
assert(
    hybrid.includes('serializeWysiwygRoot(root, fallback') &&
        hybrid.includes("const rawValue = this.serializeWysiwygRoot(root, this._lastValue || '', {") &&
        hybrid.includes("clone.querySelectorAll('.dumbpad-mermaid-render').forEach(render => render.remove())"),
    'every code-fence DOM serialization path should strip toolbars and reading-only Mermaid renders'
);
assert(
    hybrid.includes('restoreSerializedCodeLanguages(serialized, codeLanguages)') &&
        hybrid.includes('replaceCodeFenceLanguage(block.raw, language)') &&
        hybrid.includes("root.querySelectorAll(':scope > .vditor-wysiwyg__block[data-type=\"code-block\"]')"),
    'serialization should restore each rendered code block language, including Mermaid, before saving'
);
assert(
    hybrid.includes('ensurePendingCodeFenceParagraph(root, range)') &&
        hybrid.includes("root.insertBefore(paragraph, root.childNodes[offset] || null)"),
    'a fence typed directly beside another code block should get a paragraph host before Vditor auto-renders it'
);
assert(
    hybrid.includes("tools.className = 'dumbpad-code-header dumbpad-code-tools'") &&
        hybrid.includes("copyButton.className = 'dumbpad-code-copy'") &&
        hybrid.includes("copyButton.setAttribute('aria-label', '复制代码')") &&
        hybrid.includes("pre.querySelector(':scope > code')") &&
        hybrid.includes('tools.append(languageButton, copyButton)'),
    'the editable code surface should provide a left-aligned language control and accessible copy action in one header'
);
assert(
    hybrid.includes('createCodeCopyButton(pre)') &&
        hybrid.includes("header.querySelector(':scope > .dumbpad-code-copy')") &&
        styles.includes('> pre > .vditor-copy') &&
        styles.includes('display: none !important;'),
    'reading code blocks should keep the shared copy action in the header and suppress the floating Vditor copy control'
);
assert(styles.includes('> pre > .dumbpad-code-header'), 'reading and editing code tools should share one integrated header surface');
assert(
    hybrid.includes("languageButton.className = 'dumbpad-code-language-badge'") &&
        hybrid.includes("languageBadge.className = 'dumbpad-code-language-badge is-readonly'") &&
        hybrid.includes("header.className = 'dumbpad-code-header is-readonly'") &&
        styles.includes('.dumbpad-code-language-badge'),
    'the code language should remain visible at the left edge of the integrated header in editing and reading surfaces'
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
        codeBlockSurfaceRule.includes('padding: 29px 16px 12px 54px !important;') &&
        styles.includes('height: 24px;'),
    'language badges should support compact icons in a thin header with a small gap before the first code line'
);
assert(
    styles.includes('white-space: pre-wrap;') && styles.includes('overflow-wrap: anywhere;') && styles.includes('min-width: 0;'),
    'long code lines should wrap inside the article width without losing whitespace'
);
assert(!hybrid.includes("code.innerHTML = lineNumbers"), 'line numbers must never be inserted into code content');

console.log('Code block presentation checks passed');
