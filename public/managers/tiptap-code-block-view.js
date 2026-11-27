/**
 * Tiptap 代码块 NodeView：复刻旧 vditor 块的只读头部（语言徽章 + 复制按钮）
 * 与行号侧栏。DOM 结构与 styles.css 既有的 .vditor-wysiwyg__block 规则逐层
 * 对齐（header 绝对定位于 pre 内、gutter 走 data-line-numbers），零新增样式。
 * 徽章图标复用 managers/code-language-catalog.js。
 */
import { findCodeLanguageSuggestions, getCodeLanguageIconPath, resolveCodeLanguage } from './code-language-catalog.js';
import { renderMermaidSvg } from './mermaid-render.js';
import { openArticleLightbox } from './tiptap-image-interactions.js';

const MERMAID_LANGUAGE = 'mermaid';
const MERMAID_RENDER_DEBOUNCE_MS = 220;
const MERMAID_ERROR_HINT = 'Mermaid 图表语法有误，已保留源码，不影响其他内容编辑。';
export const LONG_CODE_LINE_THRESHOLD = 18;

export function countCodeBlockLines(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    return normalized ? normalized.split('\n').length : 0;
}
// 图标是纯填充路径（无描边），颜色交给 CSS 的 fill: currentColor。
const MERMAID_FULLSCREEN_ICON_SVG = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M547.4 197.4v46l200.3 0.1L546.1 444l32.4 32.6 201.9-200.7v200.9h46V197.5zM471.4 584.4l-32.6-32.6L243.6 747V547.9h-46v278.7h279v-46H275z"></path></svg>';

function normalizeCodeLanguage(language) {
    const value = String(language || 'plaintext').trim().toLowerCase() || 'plaintext';
    return value === 'dumbpad-frontmatter' ? 'frontmatter' : value;
}

/**
 * mermaid 对语法错误的表达不止一种：有的版本 reject，有的把「Syntax error」画成一张
 * 图返回。两种都得当成失败，否则错误图会顶替源码。真机形态由
 * test/browser/mermaid-preview.js 的报错用例钉住。
 */
function looksLikeMermaidError(svg) {
    return /class="error-message"|>Syntax error|No "graph types" were found/i.test(String(svg || ''));
}

function buildLineNumbers(codeText) {
    const lineCount = String(codeText || '').split('\n').length;
    const rows = [];
    for (let index = 0; index < lineCount; index += 1) {
        rows.push(String(index + 1));
    }
    return rows.join('\n');
}

const CODE_BLOCK_WRAPPER_TAG_RE = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HGROUP|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/i;
const SKIP_CLIPBOARD_TAG_RE = /^(?:STYLE|SCRIPT|NOSCRIPT|META|LINK|TITLE)$/i;

function isCodeHeaderElement(node) {
    return node?.nodeType === 1 && Boolean(node.classList?.contains?.('dumbpad-code-header'));
}

function isTrailingHackBreak(node) {
    return node?.nodeType === 1 && node.nodeName === 'BR' && Boolean(node.classList?.contains?.('ProseMirror-trailingBreak'));
}

function isBlockLikeInsidePre(node) {
    return node?.nodeType === 1 && (node.nodeName === 'CODE' || CODE_BLOCK_WRAPPER_TAG_RE.test(node.nodeName));
}

function isSkipChromeInPre(node) {
    return node?.nodeType === 1 && (
        node.classList?.contains?.('dumbpad-code-header')
        || node.classList?.contains?.('dumbpad-mermaid-render')
        || node.classList?.contains?.('mermaid-error-hint')
    );
}

function hasContentAfterBreakInBlock(brNode, blockBoundary) {
    let cursor = brNode;
    while (cursor && cursor !== blockBoundary) {
        let sibling = cursor.nextSibling;
        while (sibling) {
            if (sibling.nodeType === 3) {
                if (sibling.nodeValue && sibling.nodeValue.length > 0) return true;
            } else if (sibling.nodeType === 1) {
                if (CODE_BLOCK_WRAPPER_TAG_RE.test(sibling.nodeName)) return true;
                if (sibling.nodeName === 'BR') return true;
                if (sibling.querySelector?.('br') || (sibling.textContent && sibling.textContent.length > 0)) {
                    return true;
                }
            }
            sibling = sibling.nextSibling;
        }
        cursor = cursor.parentNode;
        if (cursor && cursor !== blockBoundary && cursor.nodeType === 1 && CODE_BLOCK_WRAPPER_TAG_RE.test(cursor.nodeName)) {
            break;
        }
    }
    return false;
}

function normalizedTextOffset(rawText, domOffset) {
    const clamped = Math.max(0, Math.min(Number(domOffset) || 0, rawText.length));
    return rawText.slice(0, clamped).replace(/\r\n?/g, '\n').length;
}

function extractTextAndCaret(container, { domSelection = null, preMode = false } = {}) {
    const anchorNode = domSelection?.anchorNode || null;
    const anchorOffset = Number(domSelection?.anchorOffset || 0);
    const focusNode = domSelection?.focusNode || null;
    const focusOffset = Number(domSelection?.focusOffset || 0);
    let out = '';
    let resolvedAnchor = null;
    let resolvedFocus = null;

    const recordBoundary = (el, childIndex) => {
        if (anchorNode === el && anchorOffset === childIndex) resolvedAnchor = out.length;
        if (focusNode === el && focusOffset === childIndex) resolvedFocus = out.length;
    };

    const walkChildren = (parent, blockBoundary, isPreRoot) => {
        const children = Array.from(parent.childNodes || []);
        let prevEmitted = false;
        let prevWasBlock = false;
        for (let index = 0; index < children.length; index += 1) {
            recordBoundary(parent, index);
            const child = children[index];
            if (isPreRoot && isSkipChromeInPre(child)) continue;
            if (!isPreRoot && child.nodeType === 1 && SKIP_CLIPBOARD_TAG_RE.test(child.nodeName)) continue;

            if (child.nodeType === 3) {
                if (prevWasBlock) {
                    out += '\n';
                    prevWasBlock = false;
                }
                const raw = child.nodeValue || '';
                if (anchorNode === child) resolvedAnchor = out.length + normalizedTextOffset(raw, anchorOffset);
                if (focusNode === child) resolvedFocus = out.length + normalizedTextOffset(raw, focusOffset);
                if (raw) {
                    out += raw.replace(/\r\n?/g, '\n');
                    prevEmitted = true;
                }
                continue;
            }

            if (child.nodeType !== 1) continue;

            if (child.nodeName === 'BR') {
                if (isPreRoot && prevEmitted) {
                    out += '\n';
                } else if (!isTrailingHackBreak(child) && hasContentAfterBreakInBlock(child, blockBoundary)) {
                    out += '\n';
                    prevEmitted = true;
                }
                prevWasBlock = false;
                continue;
            }

            const isBlock = isPreRoot ? isBlockLikeInsidePre(child) : CODE_BLOCK_WRAPPER_TAG_RE.test(child.nodeName);
            if (isBlock) {
                if (prevEmitted || prevWasBlock) {
                    out += '\n';
                }
                walkChildren(child, child, false);
                prevEmitted = true;
                prevWasBlock = true;
            } else {
                if (prevWasBlock) {
                    out += '\n';
                    prevWasBlock = false;
                }
                const beforeLen = out.length;
                walkChildren(child, blockBoundary, false);
                if (out.length > beforeLen) prevEmitted = true;
            }
        }
        recordBoundary(parent, children.length);
    };

    walkChildren(container, container, preMode);
    return { text: out, anchorOffset: resolvedAnchor, headOffset: resolvedFocus };
}

/** 从富文本 HTML（仅有 text/html 剪贴板）提取保留换行语义的纯文本，不触发资源加载。 */
export function extractClipboardHtmlText(html) {
    if (!html) return '';
    const detached = document.implementation.createHTMLDocument('');
    detached.body.innerHTML = String(html);
    detached.body.querySelectorAll('style, script, noscript').forEach(el => el.remove());
    return extractTextAndCaret(detached.body, { preMode: false }).text;
}

/** 从代码块 <pre> 及其内部提取真实源码文本与相对选区偏移（兼容被浏览器/IME 拆散的 sibling 元素）。 */
export function extractCodeBlockTextAndCaret(pre, code, domSelection = null) {
    if (!pre) return { text: code?.textContent || '', anchorOffset: null, headOffset: null };
    return extractTextAndCaret(pre, { domSelection, preMode: true });
}

/** 检查代码块 DOM 是否被浏览器/IME 拆出多个 <code> / 块容器 / 非 ProseMirror 占位 <br>。 */
export function isCodeBlockDOMCorrupted(pre, code) {
    if (!pre || !code || !pre.contains(code)) return false;
    for (let child = pre.firstChild; child; child = child.nextSibling) {
        if (child !== code && !isCodeHeaderElement(child)) return true;
    }
    const walker = document.createTreeWalker(code, 1 /* NodeFilter.SHOW_ELEMENT */);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (CODE_BLOCK_WRAPPER_TAG_RE.test(el.nodeName)) return true;
        if (el.nodeName === 'BR' && !isTrailingHackBreak(el)) return true;
    }
    return false;
}

/** 清理 <pre> 中除 .dumbpad-code-header 与唯一 contentDOM <code> 外的游离 DOM 节点。 */
export function cleanStrayPreChildren(pre, header, code) {
    if (!pre) return;
    for (const child of Array.from(pre.childNodes)) {
        if (child !== header && child !== code) child.remove();
    }
}

export function findCodeBlockWrapperFromEvent(view, event) {
    const direct = event?.target?.closest?.('.vditor-wysiwyg__block[data-type="code-block"]');
    if (direct && view?.dom?.contains(direct)) return direct;
    const domSel = view?.domSelectionRange?.() || document.getSelection?.();
    const anchor = domSel?.anchorNode;
    const anchorEl = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
    const fromSel = anchorEl?.closest?.('.vditor-wysiwyg__block[data-type="code-block"]');
    if (fromSel && view?.dom?.contains(fromSel)) return fromSel;
    const $from = view?.state?.selection?.$from;
    if ($from?.parent?.type?.name === 'codeBlock') {
        const nodeDom = view.nodeDOM?.($from.before());
        return nodeDom?.closest?.('.vditor-wysiwyg__block[data-type="code-block"]') || nodeDom || null;
    }
    return null;
}

function findSingleTextChangeBounds(previousText, nextText) {
    let start = 0;
    const minLen = Math.min(previousText.length, nextText.length);
    while (start < minLen && previousText[start] === nextText[start]) {
        start += 1;
    }
    let oldEnd = previousText.length;
    let newEnd = nextText.length;
    while (oldEnd > start && newEnd > start && previousText[oldEnd - 1] === nextText[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    return { start, oldEnd, replacement: nextText.slice(start, newEnd) };
}

/**
 * 自愈被移动端浏览器 / IME / 原生粘贴拆碎的代码块 DOM：
 * 把游离 sibling <code>/<div>/<br> 连同精确光标位置折叠回唯一的 contentDOM，并同步到 ProseMirror 文档。
 */
export function reconcileCodeBlockDOM(view, containerEl) {
    if (!view || view.isDestroyed || !containerEl) return false;
    const wrapper = containerEl.closest?.('.vditor-wysiwyg__block[data-type="code-block"]') || containerEl;
    const pre = wrapper.querySelector?.(':scope > pre');
    const header = pre?.querySelector?.(':scope > .dumbpad-code-header') || null;
    const code = pre?.querySelector?.(':scope > code') || null;
    if (!pre || !code || !isCodeBlockDOMCorrupted(pre, code)) return false;

    let blockPos = -1;
    try {
        const innerPos = view.posAtDOM(code, 0);
        const $inner = view.state.doc.resolve(innerPos);
        for (let d = $inner.depth; d >= 0; d -= 1) {
            if ($inner.node(d).type.name === 'codeBlock') {
                blockPos = $inner.before(d);
                break;
            }
        }
    } catch (_error) {
        return false;
    }
    if (blockPos < 0) return false;
    const liveNode = view.state.doc.nodeAt(blockPos);
    if (!liveNode || liveNode.type.name !== 'codeBlock') return false;

    const domSel = view.domSelectionRange?.() || document.getSelection?.();
    const selInsidePre = Boolean(domSel?.anchorNode && pre.contains(domSel.anchorNode) && !header?.contains(domSel.anchorNode));
    const { text, anchorOffset, headOffset } = extractCodeBlockTextAndCaret(pre, code, selInsidePre ? domSel : null);
    const contentStart = blockPos + 1;
    const contentEnd = blockPos + liveNode.nodeSize - 1;
    const TextSelection = globalThis.DumbPadTiptap?.PM?.state?.TextSelection;

    view.domObserver?.stop?.();
    let rewroteCodeChildren = false;
    try {
        cleanStrayPreChildren(pre, header, code);
        if (isCodeBlockDOMCorrupted(pre, code)) {
            code.replaceChildren(text ? document.createTextNode(text) : document.createElement('br'));
            rewroteCodeChildren = true;
            view.docView?.markDirty?.(contentStart, contentEnd);
        }
    } finally {
        view.domObserver?.start?.();
    }

    const previousText = liveNode.textContent || '';
    const hasLayout = typeof document.createRange?.().getClientRects === 'function';
    if (text !== previousText) {
        const diff = findSingleTextChangeBounds(previousText, text);
        const tr = view.state.tr.replaceWith(
            contentStart + diff.start,
            contentStart + diff.oldEnd,
            diff.replacement ? view.state.schema.text(diff.replacement) : []
        );
        if (TextSelection && anchorOffset !== null) {
            const max = text.length;
            const anchorPos = contentStart + Math.max(0, Math.min(anchorOffset, max));
            const headPos = contentStart + Math.max(0, Math.min(headOffset ?? anchorOffset, max));
            tr.setSelection(TextSelection.create(tr.doc, anchorPos, headPos));
        }
        view.dispatch(hasLayout ? tr.scrollIntoView() : tr);
        return true;
    }

    if (rewroteCodeChildren) {
        view.updateState(view.state);
    }
    if (TextSelection && anchorOffset !== null) {
        const max = previousText.length;
        const anchorPos = contentStart + Math.max(0, Math.min(anchorOffset, max));
        const headPos = contentStart + Math.max(0, Math.min(headOffset ?? anchorOffset, max));
        const selTr = view.state.tr.setSelection(TextSelection.create(view.state.doc, anchorPos, headPos));
        view.dispatch(hasLayout ? selTr.scrollIntoView() : selTr);
    }
    return true;
}

function renderBadge(badge, language) {
    const displayLanguage = String(language || 'plaintext').trim().toLowerCase() || 'plaintext';
    const iconPath = getCodeLanguageIconPath(displayLanguage);
    const parts = [];
    if (iconPath) {
        const icon = document.createElement('img');
        icon.className = 'dumbpad-code-language-icon';
        icon.src = iconPath;
        icon.alt = '';
        icon.width = 12;
        icon.height = 12;
        icon.draggable = false;
        icon.setAttribute('aria-hidden', 'true');
        parts.push(icon);
    }
    const token = document.createElement('span');
    token.className = 'dumbpad-code-language-token';
    token.setAttribute('translate', 'no');
    token.dataset.languageLabel = displayLanguage;
    token.setAttribute('aria-hidden', 'true');
    parts.push(token);
    badge.replaceChildren(...parts);
}

const POPOVER_VIEWPORT_MARGIN = 8;
let sharedLanguagePicker = null;

function createCodeLanguagePickerController() {
    if (sharedLanguagePicker) return sharedLanguagePicker;

    const popover = document.createElement('div');
    popover.className = 'dumbpad-code-language-popover';
    popover.hidden = true;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', '选择代码块语言');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dumbpad-code-language-input';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', '输入代码块语言');

    const list = document.createElement('div');
    list.className = 'dumbpad-code-language-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    popover.appendChild(input);
    popover.appendChild(list);

    let activeState = null;
    let suggestions = [];
    let activeIndex = -1;
    let isComposing = false;

    const getViewportBounds = () => {
        const vv = window.visualViewport;
        if (vv) {
            return {
                left: vv.offsetLeft || 0,
                top: vv.offsetTop || 0,
                right: (vv.offsetLeft || 0) + vv.width,
                bottom: (vv.offsetTop || 0) + vv.height,
            };
        }
        return {
            left: 0,
            top: 0,
            right: window.innerWidth || document.documentElement.clientWidth || 1024,
            bottom: window.innerHeight || document.documentElement.clientHeight || 768,
        };
    };

    const position = () => {
        if (popover.hidden || !activeState?.badge) return;
        if (!activeState.badge.isConnected) {
            close({ restoreFocus: false });
            return;
        }
        const badgeRect = activeState.badge.getBoundingClientRect();
        const bounds = getViewportBounds();
        const popoverWidth = popover.offsetWidth || 156;
        const popoverHeight = popover.offsetHeight || 136;

        let left = badgeRect.left;
        if (left + popoverWidth > bounds.right - POPOVER_VIEWPORT_MARGIN) {
            left = bounds.right - popoverWidth - POPOVER_VIEWPORT_MARGIN;
        }
        left = Math.max(bounds.left + POPOVER_VIEWPORT_MARGIN, left);

        let top = badgeRect.bottom + 4;
        if (top + popoverHeight > bounds.bottom - POPOVER_VIEWPORT_MARGIN) {
            const aboveTop = badgeRect.top - popoverHeight - 4;
            if (aboveTop >= bounds.top + POPOVER_VIEWPORT_MARGIN || (badgeRect.top - bounds.top) > (bounds.bottom - badgeRect.bottom)) {
                top = Math.max(bounds.top + POPOVER_VIEWPORT_MARGIN, aboveTop);
            }
        }
        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
    };

    const updateSizeVar = () => {
        const longestLabel = suggestions.reduce((maxLen, item) => (
            Math.max(maxLen, String(item.label || item.id || '').length)
        ), 0);
        const charCount = Math.max(11, Math.min(22, input.value.length + 2, longestLabel + 2));
        popover.style.setProperty('--code-language-popover-size', String(charCount));
    };

    const highlightOption = () => {
        const options = list.querySelectorAll('.dumbpad-code-language-option');
        options.forEach((opt, idx) => {
            opt.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
        });
    };

    const commitLanguage = (rawValue) => {
        const resolved = resolveCodeLanguage(rawValue);
        if (!resolved) {
            popover.classList.add('is-invalid');
            input.focus();
            return;
        }
        const state = activeState;
        close({ restoreFocus: false });
        state?.onSelect?.(resolved);
    };

    const renderSuggestions = () => {
        suggestions = findCodeLanguageSuggestions(input.value, 3);
        if (activeIndex >= suggestions.length) activeIndex = suggestions.length - 1;
        list.replaceChildren();
        suggestions.forEach((item, index) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'dumbpad-code-language-option';
            option.setAttribute('role', 'option');
            option.dataset.languageId = item.id;
            option.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
            option.textContent = item.label || item.id;
            option.addEventListener('mousedown', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            option.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                commitLanguage(item.id);
            });
            list.appendChild(option);
        });
        list.hidden = suggestions.length === 0;
        updateSizeVar();
        position();
    };

    const handleOutsidePointer = (event) => {
        if (popover.hidden) return;
        const target = event.target;
        if (popover.contains(target) || activeState?.badge?.contains(target)) return;
        close({ restoreFocus: false });
    };

    const handleReposition = () => {
        if (popover.hidden) return;
        position();
    };

    function close({ restoreFocus = false } = {}) {
        const badgeToFocus = restoreFocus ? activeState?.badge : null;
        if (activeState?.badge) {
            activeState.badge.setAttribute('aria-expanded', 'false');
        }
        activeState = null;
        suggestions = [];
        activeIndex = -1;
        isComposing = false;
        popover.classList.remove('is-invalid');
        popover.hidden = true;
        document.removeEventListener('mousedown', handleOutsidePointer, true);
        window.removeEventListener('resize', handleReposition);
        window.removeEventListener('scroll', handleReposition, true);
        window.visualViewport?.removeEventListener('resize', handleReposition);
        window.visualViewport?.removeEventListener('scroll', handleReposition);
        if (badgeToFocus?.isConnected && typeof badgeToFocus.focus === 'function') {
            badgeToFocus.focus();
        }
    }

    input.addEventListener('compositionstart', () => {
        isComposing = true;
    });
    input.addEventListener('compositionend', () => {
        isComposing = false;
        popover.classList.remove('is-invalid');
        activeIndex = -1;
        renderSuggestions();
    });
    input.addEventListener('input', () => {
        popover.classList.remove('is-invalid');
        if (isComposing) return;
        activeIndex = -1;
        renderSuggestions();
    });
    input.addEventListener('keydown', (event) => {
        if (isComposing || event.isComposing || event.keyCode === 229) return;
        if (event.key === 'ArrowDown') {
            if (!suggestions.length) return;
            event.preventDefault();
            activeIndex = (activeIndex + 1 + suggestions.length) % suggestions.length;
            highlightOption();
            return;
        }
        if (event.key === 'ArrowUp') {
            if (!suggestions.length) return;
            event.preventDefault();
            activeIndex = activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1;
            highlightOption();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (activeIndex >= 0 && suggestions[activeIndex]) {
                commitLanguage(suggestions[activeIndex].id);
                return;
            }
            commitLanguage(input.value);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close({ restoreFocus: true });
        }
    });

    sharedLanguagePicker = {
        open({ badge, language, onSelect }) {
            if (!badge) return;
            if (!popover.isConnected) {
                document.body.appendChild(popover);
            }
            if (activeState?.badge === badge && !popover.hidden) {
                close({ restoreFocus: false });
                return;
            }
            if (activeState?.badge) {
                activeState.badge.setAttribute('aria-expanded', 'false');
            }
            activeState = { badge, onSelect };
            badge.setAttribute('aria-expanded', 'true');
            const initialLang = normalizeCodeLanguage(language);
            input.value = initialLang === 'plaintext' ? '' : initialLang;
            activeIndex = -1;
            isComposing = false;
            popover.classList.remove('is-invalid');
            popover.hidden = false;
            renderSuggestions();
            document.addEventListener('mousedown', handleOutsidePointer, true);
            window.addEventListener('resize', handleReposition);
            window.addEventListener('scroll', handleReposition, true);
            window.visualViewport?.addEventListener('resize', handleReposition);
            window.visualViewport?.addEventListener('scroll', handleReposition);
            position();
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    if (popover.hidden) return;
                    input.focus();
                    input.select();
                });
            } else {
                input.focus();
                input.select();
            }
        },
        closeForBadge(badge) {
            if (activeState?.badge === badge && !popover.hidden) {
                close({ restoreFocus: false });
            }
        },
    };
    return sharedLanguagePicker;
}

export function buildCodeBlockNodeView() {
    return ({ node, view, editor, getPos }) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'vditor-wysiwyg__block';
        wrapper.setAttribute('data-type', 'code-block');

        const pre = document.createElement('pre');
        pre.className = 'vditor-wysiwyg__preview dumbpad-code-lines';

        const header = document.createElement('span');
        header.className = 'dumbpad-code-header is-readonly';
        header.setAttribute('contenteditable', 'false');
        header.setAttribute('aria-label', '代码块工具栏');

        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'dumbpad-code-language-badge is-readonly';
        badge.setAttribute('contenteditable', 'false');
        badge.setAttribute('aria-label', '切换代码块语言');
        badge.setAttribute('aria-haspopup', 'listbox');
        badge.setAttribute('aria-expanded', 'false');
        header.appendChild(badge);

        const actionsGroup = document.createElement('span');
        actionsGroup.className = 'dumbpad-code-actions';
        actionsGroup.setAttribute('contenteditable', 'false');

        const foldHeaderBtn = document.createElement('button');
        foldHeaderBtn.type = 'button';
        foldHeaderBtn.className = 'dumbpad-code-fold-btn';
        foldHeaderBtn.setAttribute('contenteditable', 'false');
        foldHeaderBtn.setAttribute('aria-expanded', 'false');
        foldHeaderBtn.hidden = true;
        actionsGroup.appendChild(foldHeaderBtn);

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'dumbpad-code-copy';
        copyButton.title = '复制代码';
        copyButton.setAttribute('aria-label', '复制代码');
        copyButton.setAttribute('contenteditable', 'false');
        const CODE_COPY_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
        // 复制成功的唯一反馈就是按钮图标变勾（无 toast）：勾用同一套 stroke 图形，
        // 颜色随 .is-copied 的主色调走。
        const CODE_COPIED_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
        copyButton.innerHTML = CODE_COPY_ICON_SVG;
        copyButton.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        copyButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await navigator.clipboard.writeText(currentCodeNode?.textContent || '');
            } catch (_error) {
                // 复制失败静默处理，不阻断编辑。
                return;
            }
            copyButton.innerHTML = CODE_COPIED_ICON_SVG;
            copyButton.classList.add('is-copied');
            copyButton.title = '已复制';
            clearTimeout(copyButton._copiedTimer);
            copyButton._copiedTimer = setTimeout(() => {
                copyButton.innerHTML = CODE_COPY_ICON_SVG;
                copyButton.classList.remove('is-copied');
                copyButton.title = '复制代码';
            }, 1200);
        });
        actionsGroup.appendChild(copyButton);
        header.appendChild(actionsGroup);

        const code = document.createElement('code');
        // 命中既有 hljs 配色规则（浅色 token 走 github.min.css，暗色覆盖在 styles.css）
        code.className = 'hljs';
        pre.appendChild(header);
        pre.appendChild(code);

        // 仅在阅读模式下的超长代码块底缘展示（置于 pre 外、wrapper 内，绝不进入代码文本抽样与编辑光标路径）
        const foldFooterBtn = document.createElement('button');
        foldFooterBtn.type = 'button';
        foldFooterBtn.className = 'dumbpad-code-fold-footer';
        foldFooterBtn.setAttribute('contenteditable', 'false');
        foldFooterBtn.hidden = true;

        wrapper.appendChild(pre);
        wrapper.appendChild(foldFooterBtn);

        let currentLanguage = null;
        let currentCodeNode = node;
        let isCodeCollapsible = false;
        let isCodeCollapsed = true;
        const languagePicker = createCodeLanguagePickerController();

        const isReadonlyMode = () => {
            const editable = editor ? Boolean(editor.isEditable) : Boolean(view?.editable);
            return !editable;
        };

        const CODE_FOLD_EXPAND_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path></svg>';
        const CODE_FOLD_COLLAPSE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 20 5-5 5 5"></path><path d="m7 4 5 5 5-5"></path></svg>';
        const FOOTER_DOWN_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
        const FOOTER_UP_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 15-6-6-6 6"></path></svg>';

        const syncCollapsibleUI = () => {
            const lang = normalizeCodeLanguage(currentCodeNode?.attrs?.language);
            const lines = countCodeBlockLines(currentCodeNode?.textContent || '');
            const eligible = isReadonlyMode()
                && lang !== MERMAID_LANGUAGE
                && lang !== 'frontmatter'
                && lines >= LONG_CODE_LINE_THRESHOLD;
            if (eligible && !isCodeCollapsible) {
                isCodeCollapsed = true;
            }
            isCodeCollapsible = eligible;
            wrapper.classList.toggle('is-code-collapsible', eligible);
            wrapper.classList.toggle('is-code-collapsed', eligible && isCodeCollapsed);
            foldHeaderBtn.hidden = !eligible;
            foldFooterBtn.hidden = !eligible;
            if (eligible) {
                const headerLabel = isCodeCollapsed ? `展开全部 ${lines} 行` : '收起代码';
                foldHeaderBtn.innerHTML = isCodeCollapsed ? CODE_FOLD_EXPAND_ICON_SVG : CODE_FOLD_COLLAPSE_ICON_SVG;
                foldHeaderBtn.title = headerLabel;
                foldHeaderBtn.setAttribute('aria-expanded', String(!isCodeCollapsed));
                foldHeaderBtn.setAttribute('aria-label', headerLabel);
                foldFooterBtn.innerHTML = `<span class="dumbpad-code-fold-pill">${isCodeCollapsed ? FOOTER_DOWN_ICON_SVG : FOOTER_UP_ICON_SVG}<span>${isCodeCollapsed ? `展开代码 · ${lines} 行` : '收起代码'}</span></span>`;
                foldFooterBtn.setAttribute('aria-expanded', String(!isCodeCollapsed));
                foldFooterBtn.setAttribute('aria-label', headerLabel);
            }
        };

        const toggleCodeCollapsed = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!isCodeCollapsible) return;
            isCodeCollapsed = !isCodeCollapsed;
            syncCollapsibleUI();
        };
        foldHeaderBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        foldHeaderBtn.addEventListener('click', toggleCodeCollapsed);
        foldFooterBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        foldFooterBtn.addEventListener('click', toggleCodeCollapsed);

        const isLanguagePickerEditable = () => {
            const editable = editor ? Boolean(editor.isEditable) : Boolean(view?.editable);
            const lang = normalizeCodeLanguage(currentCodeNode?.attrs?.language);
            return editable && lang !== 'frontmatter';
        };

        const syncBadgeEditable = () => {
            const readonly = !isLanguagePickerEditable();
            header.classList.toggle('is-readonly', readonly);
            badge.classList.toggle('is-readonly', readonly);
            badge.disabled = readonly;
            badge.setAttribute('aria-disabled', readonly ? 'true' : 'false');
            if (readonly) languagePicker.closeForBadge(badge);
            syncCollapsibleUI();
        };

        badge.addEventListener('mousedown', (event) => {
            if (!isLanguagePickerEditable()) return;
            event.preventDefault();
            event.stopPropagation();
        });

        badge.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!isLanguagePickerEditable()) return;
            languagePicker.open({
                badge,
                language: currentCodeNode?.attrs?.language,
                onSelect(nextLanguage) {
                    if (typeof getPos !== 'function' || !view) return;
                    const pos = getPos();
                    if (typeof pos !== 'number' || pos < 0) return;
                    const liveNode = view.state.doc.nodeAt(pos);
                    if (!liveNode || liveNode.type !== node.type) return;
                    const nextAttr = nextLanguage === 'plaintext' ? null : nextLanguage;
                    const selection = view.state.selection;
                    const blockEnd = pos + liveNode.nodeSize - 1;
                    const wasInside = selection.from > pos && selection.to < pos + liveNode.nodeSize;
                    const savedOffset = wasInside ? Math.max(1, selection.from - pos) : null;

                    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, {
                        ...liveNode.attrs,
                        language: nextAttr,
                    }));

                    if (wasInside || !liveNode.textContent) {
                        const updatedNode = view.state.doc.nodeAt(pos);
                        const maxPos = updatedNode ? pos + updatedNode.nodeSize - 1 : blockEnd;
                        const targetPos = Math.min(pos + (savedOffset || 1), Math.max(pos + 1, maxPos));
                        if (typeof editor?.commands?.setTextSelection === 'function') {
                            editor.commands.setTextSelection(targetPos);
                        }
                        editor?.commands?.focus?.();
                    }
                },
            });
        });

        const onEditableRefresh = () => syncBadgeEditable();
        document.addEventListener('dumbpad-mermaid-refresh', onEditableRefresh);

        const renderChrome = (updatedNode) => {
            currentCodeNode = updatedNode;
            if (!view?.composing) {
                cleanStrayPreChildren(pre, header, code);
            }
            syncBadgeEditable();
            const language = normalizeCodeLanguage(updatedNode.attrs.language);
            if (currentLanguage !== language) {
                currentLanguage = language;
                renderBadge(badge, language);
            }
            pre.classList.add('dumbpad-code-lines');
            const lineNumbers = buildLineNumbers(updatedNode.textContent || '');
            if (pre.dataset.lineNumbers !== lineNumbers) {
                pre.dataset.lineNumbers = lineNumbers;
            }
        };

        renderChrome(node);

        /* ---------------- mermaid：编辑态实时预览 ----------------
         * Typora 式：光标在块内时看到的是源码，离开块（或点图）后看到的是图。
         * 三条硬约束：
         * 1) 图只画进 wrapper 里 NodeView 自管的兄弟节点，绝不碰 contentDOM——
         *    存储与撤销历史里永远只有源码；
         * 2) 渲染失败（语法写一半、bundle 拉不到）保留源码 + 一行提示，不吞内容；
         * 3) 只有 language 是 mermaid 的块才订阅事务/主题，别的代码块零开销。 */
        let isMermaid = normalizeCodeLanguage(node.attrs.language) === MERMAID_LANGUAGE;
        let mermaidRenderEl = null;
        let mermaidHintEl = null;
        let mermaidSource = null;
        let mermaidTimer = 0;
        let mermaidToken = 0;
        let mermaidEditing = false;
        let mermaidFullscreenButton = null;

        const paintMermaid = () => {
            wrapper.classList.toggle('is-mermaid-editing', mermaidEditing);
            wrapper.classList.toggle('is-mermaid-preview', Boolean(mermaidRenderEl) && !mermaidEditing);
        };

        const dropMermaidRender = () => {
            mermaidRenderEl?.remove();
            mermaidRenderEl = null;
            mermaidSource = null;
        };

        /**
         * 全屏按钮。它挂在 NodeView 自管的 DOM 里（不是 contentDOM），点击必须
         * **完全吞掉**，否则 `.dumbpad-mermaid-render` 的 mousedown 会把光标塞进
         * 代码块、当场切成源码态——用户点「全屏」看到的是源码，图反而消失了。
         * pointerdown 只 stopPropagation 不 preventDefault：取消 pointerdown 会
         * 连带压掉兼容 mouse 事件，桌面浏览器上 click 的时序会变得不可靠。
         */
        const ensureFullscreenButton = () => {
            if (mermaidFullscreenButton) return mermaidFullscreenButton;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dumbpad-mermaid-fullscreen';
            button.title = '全屏查看';
            button.setAttribute('aria-label', '全屏查看图表');
            button.setAttribute('contenteditable', 'false');
            button.innerHTML = MERMAID_FULLSCREEN_ICON_SVG;
            button.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
            });
            button.addEventListener('mousedown', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const svg = mermaidRenderEl?.querySelector('svg');
                if (!svg) return;
                openArticleLightbox({
                    // 灯箱工具条在 390px 上还要塞下 −/％/＋/适应/下载/关闭，
                    // 名字太长会被截成「Mermai…」，短标签更实用。
                    name: '图表',
                    svg,
                    downloadName: 'mermaid.svg',
                    trigger: button,
                });
            });
            mermaidFullscreenButton = button;
            return button;
        };

        const setMermaidHint = (message) => {
            if (!message) {
                mermaidHintEl?.remove();
                mermaidHintEl = null;
                wrapper.classList.remove('dumbpad-mermaid-error');
                return;
            }
            if (!mermaidHintEl) {
                mermaidHintEl = document.createElement('div');
                mermaidHintEl.className = 'mermaid-error-hint';
                mermaidHintEl.setAttribute('contenteditable', 'false');
                wrapper.appendChild(mermaidHintEl);
            }
            mermaidHintEl.textContent = message;
            wrapper.classList.add('dumbpad-mermaid-error');
        };

        const caretInsideBlock = () => {
            if (typeof getPos !== 'function' || !editor?.state || !editor.isEditable) return false;
            // 编辑器没聚焦时一律看图：PM 的初始光标正好落在首块的第一个内容位，
            // 只看选区范围的话，「打开一篇以 mermaid 开头的文章」会永久停在源码态。
            // Tiptap 在 focus/blur 上都会派发事务，所以这里的状态能被 sync 到。
            if (!editor.isFocused) return false;
            let position;
            try {
                position = getPos();
            } catch (_error) {
                return false;
            }
            if (typeof position !== 'number') return false;
            const { selection } = editor.state;
            const size = currentCodeNode?.nodeSize || 0;
            // 严格包含：块两侧边界上的光标（还没进内容）不算「在块里」。
            return selection.from > position && selection.to < position + size;
        };

        async function drawMermaid() {
            if (!isMermaid) return;
            const source = (currentCodeNode?.textContent || '').replace(/[\u200B\uFEFF]/g, '');
            if (!source.trim()) {
                dropMermaidRender();
                setMermaidHint('');
                paintMermaid();
                return;
            }
            if (source === mermaidSource) return;
            const token = (mermaidToken += 1);
            let svg = null;
            try {
                svg = await renderMermaidSvg(source);
            } catch (_error) {
                svg = null;
            }
            if (token !== mermaidToken) return;
            if (!svg || looksLikeMermaidError(svg)) {
                dropMermaidRender();
                setMermaidHint(MERMAID_ERROR_HINT);
                paintMermaid();
                return;
            }
            if (!mermaidRenderEl) {
                mermaidRenderEl = document.createElement('div');
                mermaidRenderEl.className = 'dumbpad-mermaid-render language-mermaid';
                mermaidRenderEl.setAttribute('contenteditable', 'false');
                mermaidRenderEl.addEventListener('mousedown', (event) => {
                    // 点全屏按钮不能把光标送进代码块（否则当场切源码、图消失）。
                    if (event.target?.closest?.('.dumbpad-mermaid-fullscreen')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const position = typeof getPos === 'function' ? getPos() : null;
                    if (typeof position === 'number') {
                        editor?.chain?.().focus().setTextSelection(position + 1).run();
                    }
                });
                wrapper.appendChild(mermaidRenderEl);
            }
            mermaidRenderEl.innerHTML = svg;
            // innerHTML 会清掉子节点，按钮每次渲染后重新挂上（同一个节点复用）。
            mermaidRenderEl.appendChild(ensureFullscreenButton());
            mermaidSource = source;
            setMermaidHint('');
            paintMermaid();
        }

        const scheduleMermaidDraw = (delay = MERMAID_RENDER_DEBOUNCE_MS) => {
            if (!isMermaid) return;
            clearTimeout(mermaidTimer);
            mermaidTimer = setTimeout(() => { void drawMermaid(); }, delay);
        };

        const syncMermaidEditing = () => {
            if (!isMermaid) return;
            const next = caretInsideBlock();
            if (next === mermaidEditing) return;
            mermaidEditing = next;
            paintMermaid();
            if (!mermaidEditing) scheduleMermaidDraw(0);
        };

        // 编辑器进入/退出阅读模式不会产事务（只改 editable），得靠显式通知重判一次。
        const onMermaidRefresh = () => {
            if (!isMermaid) return;
            mermaidEditing = caretInsideBlock();
            paintMermaid();
            if (!mermaidEditing) scheduleMermaidDraw(0);
        };
        const onMermaidTransaction = () => syncMermaidEditing();
        const themeWatcher = typeof MutationObserver === 'function'
            ? new MutationObserver(() => {
                if (!isMermaid) return;
                mermaidSource = null;
                scheduleMermaidDraw(0);
            })
            : null;
        // 监听只挂在 mermaid 块上：普通代码块一个回调都不注册，输入路径零额外开销。
        let mermaidWatchers = false;
        const attachMermaidWatchers = () => {
            if (mermaidWatchers) return;
            mermaidWatchers = true;
            document.addEventListener('dumbpad-mermaid-refresh', onMermaidRefresh);
            editor?.on?.('transaction', onMermaidTransaction);
            themeWatcher?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        };
        const detachMermaidWatchers = () => {
            if (!mermaidWatchers) return;
            mermaidWatchers = false;
            document.removeEventListener('dumbpad-mermaid-refresh', onMermaidRefresh);
            editor?.off?.('transaction', onMermaidTransaction);
            themeWatcher?.disconnect();
        };
        if (isMermaid) {
            attachMermaidWatchers();
            syncMermaidEditing();
            if (!mermaidEditing) scheduleMermaidDraw(0);
        }

        return {
            dom: wrapper,
            contentDOM: code,
            update(updatedNode) {
                if (updatedNode.type !== node.type) return false;
                currentCodeNode = updatedNode;
                renderChrome(updatedNode);
                const nowMermaid = normalizeCodeLanguage(updatedNode.attrs.language) === MERMAID_LANGUAGE;
                if (nowMermaid !== isMermaid) {
                    isMermaid = nowMermaid;
                    mermaidToken += 1;
                    clearTimeout(mermaidTimer);
                    if (!isMermaid) {
                        detachMermaidWatchers();
                        dropMermaidRender();
                        setMermaidHint('');
                        wrapper.classList.remove('is-mermaid-editing', 'is-mermaid-preview');
                    } else {
                        attachMermaidWatchers();
                        syncMermaidEditing();
                        scheduleMermaidDraw(0);
                    }
                    return true;
                }
                if (isMermaid) scheduleMermaidDraw();
                return true;
            },
            ignoreMutation(mutation) {
                // contentDOM 之外的一切由 NodeView 自管：头部、行号属性、mermaid 渲染容器。
                if (mutation.type === 'attributes' && (mutation.target === pre || mutation.target === wrapper)) return true;
                return !code.contains(mutation.target);
            },
            // 整块被选中（NodeSelection）时看图没意义：露出源码。
            selectNode() {
                if (!isMermaid) return;
                mermaidEditing = true;
                paintMermaid();
            },
            deselectNode() {
                if (!isMermaid) return;
                mermaidEditing = false;
                paintMermaid();
                scheduleMermaidDraw(0);
            },
            destroy() {
                mermaidToken += 1;
                clearTimeout(mermaidTimer);
                detachMermaidWatchers();
                document.removeEventListener('dumbpad-mermaid-refresh', onEditableRefresh);
                languagePicker.closeForBadge(badge);
            },
        };
    };
}
