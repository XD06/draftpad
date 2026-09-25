/**
 * Tiptap 代码块 NodeView：复刻旧 vditor 块的只读头部（语言徽章 + 复制按钮）
 * 与行号侧栏。DOM 结构与 styles.css 既有的 .vditor-wysiwyg__block 规则逐层
 * 对齐（header 绝对定位于 pre 内、gutter 走 data-line-numbers），零新增样式。
 * 徽章图标复用 managers/code-language-catalog.js。
 */
import { getCodeLanguageIconPath, resolveCodeLanguage } from './code-language-catalog.js';
import { renderMermaidSvg } from './mermaid-render.js';

const MERMAID_LANGUAGE = 'mermaid';
const MERMAID_RENDER_DEBOUNCE_MS = 220;
const MERMAID_ERROR_HINT = 'Mermaid 图表语法有误，已保留源码，不影响其他内容编辑。';

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

export function buildCodeBlockNodeView({ onToast } = {}) {
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

        const badge = document.createElement('span');
        badge.className = 'dumbpad-code-language-badge is-readonly';
        badge.setAttribute('contenteditable', 'false');
        badge.setAttribute('aria-label', '代码块语言');
        header.appendChild(badge);

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'dumbpad-code-copy';
        copyButton.title = '复制代码';
        copyButton.setAttribute('aria-label', '复制代码');
        copyButton.setAttribute('contenteditable', 'false');
        copyButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
        copyButton.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        copyButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await navigator.clipboard.writeText(currentCodeNode?.textContent || '');
                copyButton.classList.add('is-copied');
                copyButton.title = '已复制';
                onToast?.('代码已复制', 1200);
                clearTimeout(copyButton._copiedTimer);
                copyButton._copiedTimer = setTimeout(() => {
                    copyButton.classList.remove('is-copied');
                    copyButton.title = '复制代码';
                }, 1200);
            } catch (_error) {
                // 复制失败静默处理，不阻断编辑。
            }
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

        const renderChrome = (updatedNode) => {
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

        const paintMermaid = () => {
            wrapper.classList.toggle('is-mermaid-editing', mermaidEditing);
            wrapper.classList.toggle('is-mermaid-preview', Boolean(mermaidRenderEl) && !mermaidEditing);
        };

        const dropMermaidRender = () => {
            mermaidRenderEl?.remove();
            mermaidRenderEl = null;
            mermaidSource = null;
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
            },
        };
    };
}
