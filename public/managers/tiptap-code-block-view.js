/**
 * Tiptap 代码块 NodeView：复刻旧 vditor 块的只读头部（语言徽章 + 复制按钮）
 * 与行号侧栏。DOM 结构与 styles.css 既有的 .vditor-wysiwyg__block 规则逐层
 * 对齐（header 绝对定位于 pre 内、gutter 走 data-line-numbers），零新增样式。
 * 徽章图标复用 managers/code-language-catalog.js。
 */
import { getCodeLanguageIconPath, resolveCodeLanguage } from './code-language-catalog.js';

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
    return (node) => {
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
                await navigator.clipboard.writeText(currentNode?.textContent || '');
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
        pre.appendChild(header);
        pre.appendChild(code);
        wrapper.appendChild(pre);

        let currentLanguage = null;

        const renderChrome = (updatedNode) => {
            let language = String(updatedNode.attrs.language || 'plaintext').trim().toLowerCase() || 'plaintext';
            if (language === 'dumbpad-frontmatter') language = 'frontmatter';
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

        return {
            dom: wrapper,
            contentDOM: code,
            update(updatedNode) {
                if (updatedNode.type !== node.type) return false;
                renderChrome(updatedNode);
                return true;
            },
            ignoreMutation(mutation) {
                // header/gutter 由 NodeView 自管；属性变化不回传 PM。
                return mutation.type === 'attributes' && mutation.target === pre;
            },
        };
    };
}
