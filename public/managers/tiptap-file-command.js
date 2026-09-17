/**
 * Tiptap 文章编辑器的 /file 命令：光标前输入 /file 后按 Enter，打开文件
 * 选择器，上传后把 /file 替换为资产引用 Markdown（图片带 dumbpad-width
 * 默认宽、文件用旧 buildArticleFileMarkdown 形态）。WYSIWYG 路径经
 * editorProps.handleKeyDown 拦截（directProps 优先于 SoftEnterShortcut
 * 等插件键位），位置经 transaction 监听随文档编辑重映射；源码模式走
 * textarea 的 findFileCommandBeforeCursor / replaceFileCommand。上传期间
 * 用户继续编辑是常态：插入用的是映射后的最新位置，失败时响亮提示。
 */
import {
    AssetApiClient,
    ARTICLE_FILE_ACCEPT,
    isImageFile,
} from './asset-api-client.js';
import {
    FILE_COMMAND,
    findFileCommandBeforeCursor,
    buildArticleFileMarkdown,
    replaceFileCommand,
} from './article-file-command.js';

const FILE_COMMAND_LENGTH = FILE_COMMAND.length;

function buildArticleImageMarkdown(asset = {}) {
    const alt = String(asset?.name || '图片').replace(/[[\]\\]/g, '\\$&');
    return `![${alt}](${asset.previewUrl} "dumbpad-width=720")`;
}

export function createFileCommandController(adapter) {
    // adapter：HybridMarkdownEditor 实例（提供 editor / container /
    // sourceMode / getSourceTextarea / assetMaxFileBytes / assetApi 等）。
    let pendingPos = null;         // WYSIWYG：/file 起始位置（随事务映射）
    let pendingSourceRange = null; // 源码模式：/file 在 textarea 值中的区间
    let fileInput = null;

    const getAssetApi = () => {
        if (!adapter.assetApi) {
            adapter.assetApi = new AssetApiClient({ maxFileBytes: adapter.assetMaxFileBytes ?? undefined });
        }
        return adapter.assetApi;
    };

    const isFileCommandKeydown = (event) => Boolean(
        event && event.key === 'Enter' && !event.ctrlKey && !event.metaKey
        && !event.altKey && !event.shiftKey && !event.isComposing && !adapter.isComposing
    );

    /* ---------------- WYSIWYG：Enter 拦截 ---------------- */

    function handleKeyDown(view, event) {
        if (!isFileCommandKeydown(event)) return false;
        const { state } = view;
        const { selection } = state;
        if (!selection.empty) return false;
        const $from = selection.$from;
        // 代码块 / 内联代码是命令禁区（与旧 handleWysiwygFileCommand 对齐）。
        if ($from.parent.type.spec.code) return false;
        if ($from.marks().some(mark => mark.type.name === 'code')) return false;
        const textBefore = $from.parent.textBetween(
            Math.max(0, $from.parentOffset - FILE_COMMAND_LENGTH),
            $from.parentOffset
        );
        if (textBefore !== FILE_COMMAND) return false;
        // /files、/filexyz 不触发（与旧 findFileCommandBeforeCursor 一致）。
        const after = $from.nodeAfter;
        if (after?.isText && /^[A-Za-z0-9_-]/.test(after.text || '')) return false;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        pendingPos = selection.from - FILE_COMMAND_LENGTH;
        openPicker();
        return true;
    }

    /** 每个文档事务后重映射挂起的插入位置（用户在上传期间继续编辑）。 */
    function handleTransaction(transaction) {
        if (!transaction || !transaction.docChanged || pendingPos === null) return;
        pendingPos = transaction.mapping.map(pendingPos, 1);
    }

    /* ---------------- 文件选择与上传 ---------------- */

    function openPicker({ sourceRange = null } = {}) {
        pendingSourceRange = sourceRange;
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.multiple = true;
            fileInput.accept = ARTICLE_FILE_ACCEPT;
            fileInput.className = 'article-file-command-input';
            fileInput.tabIndex = -1;
            fileInput.setAttribute('aria-hidden', 'true');
            fileInput.addEventListener('change', () => {
                const files = Array.from(fileInput.files || []);
                fileInput.value = '';
                handleFiles(files);
            });
            fileInput.addEventListener('cancel', () => {
                pendingPos = null;
                pendingSourceRange = null;
            });
            adapter.container.appendChild(fileInput);
        }
        fileInput.click();
    }

    function deletePendingCommand() {
        if (pendingSourceRange && adapter.getSourceTextarea()) {
            // 源码模式：textarea 值内先删掉 /file（失败由 toast 提示重试）。
            const textarea = adapter.getSourceTextarea();
            const replaced = replaceFileCommand(textarea.value, pendingSourceRange, '');
            if (replaced) {
                textarea.value = replaced.value;
                textarea.setSelectionRange(replaced.selectionStart, replaced.selectionEnd);
                adapter.notifyEditorValueChanged(textarea.value);
            }
            pendingSourceRange = null;
            return;
        }
        if (pendingPos === null) return;
        const view = adapter.editor.view;
        const text = adapter.editor.state.doc.textBetween(pendingPos, pendingPos + FILE_COMMAND_LENGTH);
        if (text === FILE_COMMAND) {
            view.dispatch(view.state.tr.delete(pendingPos, pendingPos + FILE_COMMAND_LENGTH));
        }
        // pendingPos 保留：handleTransaction 会在删除事务里把它映射到位。
    }

    async function handleFiles(files) {
        if (!files.length) return;
        const hasWysiwygTarget = pendingPos !== null && !adapter.sourceMode;
        if (!hasWysiwygTarget && !pendingSourceRange) return;

        const assetApi = getAssetApi();
        const uploads = files.map((file) => {
            const isImage = isImageFile(file);
            const upload = isImage
                ? assetApi.uploadImage(file, {})
                : assetApi.uploadFile(file, {});
            return { isImage, upload };
        });
        if (files.length > 1) {
            window.toaster?.show?.(`正在上传 ${files.length} 个文件…`, 'info', false, 2400);
        }
        deletePendingCommand();

        const markdowns = [];
        const failures = [];
        await Promise.all(uploads.map(async (item, index) => {
            try {
                const asset = await item.upload;
                markdowns[index] = item.isImage
                    ? buildArticleImageMarkdown(asset)
                    : buildArticleFileMarkdown(asset);
            } catch (error) {
                console.error(`Failed to upload article ${item.isImage ? 'image' : 'file'}:`, error);
                failures.push(files[index]);
            }
        }));

        const ready = markdowns.filter(Boolean);
        if (ready.length) {
            if (pendingSourceRange) {
                insertIntoSourceMode(ready);
            } else {
                insertIntoWysiwyg(ready);
            }
        }
        if (failures.length) {
            const label = failures.some(file => isImageFile(file)) ? '图片' : '文件';
            window.toaster?.show?.(`${label}上传失败，/file 未替换，请重试`, 'error', false, 3200);
        }
        pendingPos = null;
        pendingSourceRange = null;
    }

    function insertIntoWysiwyg(markdowns) {
        // 顺序插入：多文件按选择顺序排布，段间以空行分隔（与旧
        // tokens.join('\n\n') 的落文形态一致）。insertContentAt 会把
        // markdown 字符串解析成文档节点（不能 insertText——那是字面文本），
        // 光标停在插入内容之后，正好作为下一段的锚点。
        let anchor = Math.max(0, Math.min(pendingPos ?? 0, adapter.editor.state.doc.content.size));
        markdowns.forEach((markdown, index) => {
            const payload = index === 0 ? markdown : `\n\n${markdown}`;
            adapter.editor.commands.insertContentAt(anchor, payload);
            anchor = adapter.editor.state.selection.from;
        });
        adapter.notifyEditorValueChanged(adapter.getValue());
    }

    function insertIntoSourceMode(markdowns) {
        const textarea = adapter.getSourceTextarea();
        if (!textarea) return;
        const replaced = replaceFileCommand(textarea.value, pendingSourceRange, markdowns.join('\n\n'));
        if (!replaced) {
            window.toaster?.show?.('插入位置已变化，请重新输入 /file', 'info', false, 3200);
            return;
        }
        textarea.value = replaced.value;
        textarea.setSelectionRange(replaced.selectionStart, replaced.selectionEnd);
        adapter.notifyEditorValueChanged(textarea.value);
    }

    /* ---------------- 源码模式：textarea Enter 拦截 ---------------- */

    function handleSourceKeydown(event) {
        if (!isFileCommandKeydown(event)) return false;
        const textarea = adapter.getSourceTextarea();
        if (!textarea || event.target !== textarea) return false;
        const commandRange = findFileCommandBeforeCursor(
            textarea.value,
            textarea.selectionStart,
            textarea.selectionEnd
        );
        if (!commandRange) return false;
        event.preventDefault();
        event.stopPropagation();
        pendingPos = null;
        openPicker({ sourceRange: commandRange });
        return true;
    }

    return {
        handleKeyDown,
        handleTransaction,
        handleSourceKeydown,
    };
}
