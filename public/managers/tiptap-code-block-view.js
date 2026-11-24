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
        header.appendChild(copyButton);

        const code = document.createElement('code');
        // 命中既有 hljs 配色规则（浅色 token 走 github.min.css，暗色覆盖在 styles.css）
        code.className = 'hljs';
        pre.appendChild(header);
        pre.appendChild(code);
        wrapper.appendChild(pre);

        let currentLanguage = null;
        let currentCodeNode = node;
        const languagePicker = createCodeLanguagePickerController();

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
