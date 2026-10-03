/**
 * Tiptap 文章编辑器的 /file 命令：光标前输入 /file 后按 Enter，打开文件
 * 选择器，上传后把 /file 替换为资产引用 Markdown（图片带 dumbpad-width
 * 默认宽、文件用旧 buildArticleFileMarkdown 形态）。WYSIWYG 路径经
 * editorProps.handleKeyDown 拦截（directProps 优先于 SoftEnterShortcut
 * 等插件键位），位置经 transaction 监听随文档编辑重映射；源码模式走
 * textarea 的 findFileCommandBeforeCursor / replaceFileCommand。上传期间
 * 用户继续编辑是常态：插入用的是映射后的最新位置，失败时响亮提示。
 */
import { Extension, PM } from './tiptap-runtime.js';
import { getFileCategory, getFileIconSvg } from './file-type-icons.js';
import {
    AssetApiClient,
    ARTICLE_FILE_ACCEPT,
    isImageFile,
} from './asset-api-client.js';
import {
    FILE_COMMAND,
    DEFAULT_ARTICLE_IMAGE_WIDTH,
    findFileCommandBeforeCursor,
    buildArticleFileMarkdown,
    formatFileSize,
    replaceFileCommand,
} from './article-file-command.js';

const { Plugin, PluginKey } = PM.state;
const { Decoration, DecorationSet } = PM.view;

export const articleUploadProgressPluginKey = new PluginKey('dumbpadArticleUploadProgress');

function renderUploadCardWidgetDom(item, view) {
    if (item.dom) return item.dom;

    const card = document.createElement('span');
    card.className = 'article-upload-card';
    card.dataset.uploadId = item.id;
    card.setAttribute('contenteditable', 'false');
    card.setAttribute('role', 'status');

    const cat = item.isImage
        ? { id: 'image', name: '图片', color: 'var(--primary-color)' }
        : getFileCategory(item.file?.name, item.file?.type);
    const themeColor = cat.color || 'var(--primary-color)';
    card.style.setProperty('--upload-theme', themeColor);

    const icon = document.createElement('span');
    icon.className = 'article-upload-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.color = themeColor;
    icon.style.background = `color-mix(in srgb, ${themeColor} 15%, transparent)`;
    icon.innerHTML = item.isImage
        ? getFileIconSvg('image', item.file?.type || '', { size: 20 })
        : getFileIconSvg(cat, item.file?.type || '', { size: 20 });

    const content = document.createElement('span');
    content.className = 'article-upload-content';

    const heading = document.createElement('span');
    heading.className = 'article-upload-heading';

    const nameEl = document.createElement('span');
    nameEl.className = 'article-upload-name';
    nameEl.textContent = item.file?.name || (item.isImage ? '图片' : '文件');

    const sizeEl = document.createElement('span');
    sizeEl.className = 'article-upload-size';
    sizeEl.textContent = formatFileSize(item.file?.size || item.total || 0);

    heading.append(nameEl, sizeEl);

    const statusEl = document.createElement('span');
    statusEl.className = 'article-upload-status';
    const percent = Math.round(item.percent || 0);
    statusEl.textContent = item.phase === 'processing'
        ? '服务器处理中…'
        : (item.phase === 'error' ? (item.error || '上传失败') : `上传中 ${percent}%`);

    const progress = document.createElement('span');
    progress.className = 'article-upload-progress';

    const progressFill = document.createElement('span');
    progressFill.className = 'article-upload-progress-fill';
    progressFill.style.width = `${item.phase === 'error' ? 100 : percent}%`;
    progress.append(progressFill);

    content.append(heading, statusEl, progress);
    card.append(icon, content);

    const actions = document.createElement('span');
    actions.className = 'article-upload-actions';
    actions.hidden = item.phase !== 'error';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        view?.dispatch?.(view.state.tr.setMeta(articleUploadProgressPluginKey, {
            type: 'REMOVE_UPLOADS',
            ids: [item.id],
        }));
    });
    actions.append(removeBtn);
    card.append(actions);

    item.dom = card;
    item.statusEl = statusEl;
    item.progressFill = progressFill;
    item.actions = actions;

    return card;
}

function updateUploadProgress(item, progress = {}) {
    if (progress.phase) item.phase = progress.phase;
    if (typeof progress.percent === 'number') item.percent = progress.percent;
    if (typeof progress.total === 'number') item.total = progress.total;
    if (typeof progress.loaded === 'number') item.loaded = progress.loaded;
    if (progress.error) item.error = progress.error;

    if (!item.dom) return;

    const roundPercent = Math.min(100, Math.max(0, Math.round(item.percent || 0)));
    if (item.phase === 'error') {
        item.dom.classList.add('is-error');
        if (item.statusEl) item.statusEl.textContent = item.error || '上传失败';
        if (item.progressFill) item.progressFill.style.width = '100%';
        if (item.actions) item.actions.hidden = false;
        item.dom.setAttribute('aria-label', `${item.file?.name || '文件'}，上传失败`);
    } else if (item.phase === 'processing') {
        if (item.statusEl) item.statusEl.textContent = '服务器处理中…';
        if (item.progressFill) item.progressFill.style.width = '100%';
        item.dom.setAttribute('aria-label', `${item.file?.name || '文件'}，服务器处理中…`);
    } else {
        if (item.statusEl) item.statusEl.textContent = `上传中 ${roundPercent}%`;
        if (item.progressFill) item.progressFill.style.width = `${roundPercent}%`;
        item.dom.setAttribute('aria-label', `${item.file?.name || '文件'}，上传中 ${roundPercent}%`);
    }
}

export const TiptapArticleUploadProgress = Extension.create({
    name: 'tiptapArticleUploadProgress',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: articleUploadProgressPluginKey,
                state: {
                    init() {
                        return { items: [] };
                    },
                    apply(tr, pluginState) {
                        const meta = tr.getMeta(articleUploadProgressPluginKey);
                        let items = pluginState.items;
                        if (meta) {
                            if (meta.type === 'ADD_UPLOADS') {
                                items = [...items, ...(meta.uploads || [])];
                            } else if (meta.type === 'REMOVE_UPLOADS') {
                                const removeIds = new Set(meta.ids || []);
                                items = items.filter(item => !removeIds.has(item.id));
                            } else if (meta.type === 'CLEAR') {
                                items = [];
                            }
                        }
                        if (tr.docChanged && items.length > 0) {
                            items = items.map(item => ({
                                ...item,
                                pos: tr.mapping.map(item.pos, 0),
                            }));
                        }
                        return { items };
                    },
                },
                props: {
                    decorations(state) {
                        const pluginState = articleUploadProgressPluginKey.getState(state);
                        if (!pluginState || !pluginState.items.length) {
                            return DecorationSet.empty;
                        }
                        const docSize = state.doc.content.size;
                        const decorations = [];
                        pluginState.items.forEach((item, index) => {
                            const pos = Math.max(0, Math.min(item.pos, docSize));
                            decorations.push(
                                Decoration.widget(pos, (view) => renderUploadCardWidgetDom(item, view), {
                                    key: item.id,
                                    side: index,
                                    stopEvent: () => true,
                                })
                            );
                        });
                        return DecorationSet.create(state.doc, decorations);
                    },
                },
            }),
        ];
    },
});

const FILE_COMMAND_LENGTH = FILE_COMMAND.length;

function buildArticleImageMarkdown(asset = {}) {
    const alt = String(asset?.name || '图片').replace(/[[\]\\]/g, '\\$&');
    return `![${alt}](${asset.previewUrl} "dumbpad-width=${DEFAULT_ARTICLE_IMAGE_WIDTH}")`;
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
                // 原生文件对话框拿走焦点后要还给编辑器，否则用户取消后看不到光标、
                // 也直接打不了字（必须手动点一下编辑区）。
                restoreEditorFocus();
            });
            adapter.container.appendChild(fileInput);
        }
        fileInput.click();
    }

    /** 上传/取消之后把焦点与光标交还编辑器（对话框期间焦点在隐藏 input 上）。 */
    function restoreEditorFocus() {
        if (adapter.sourceMode) {
            adapter.getSourceTextarea()?.focus();
            return;
        }
        adapter.focus?.();
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
        const doc = view.state.doc;
        // 斜杠菜单路径在打开选择器前已删掉命令文本，此时 pendingPos 之后没有
        // 内容；用户也可能在上传期间继续编辑。位置必须先夹紧到文档范围再取
        // 文本——textBetween 越界会抛 TypeError 并中断整个上传链（表现为
        // 「选择器弹了、文件选了、却什么都没发生」）。
        const pos = Math.max(0, Math.min(pendingPos, doc.content.size));
        const to = Math.min(pos + FILE_COMMAND_LENGTH, doc.content.size);
        if (to > pos && doc.textBetween(pos, to) === FILE_COMMAND) {
            view.dispatch(view.state.tr.delete(pos, to));
        }
        // pendingPos 保留：handleTransaction 会在删除事务里把它映射到位。
    }

    async function handleFiles(files) {
        if (!files.length) return;
        const isWysiwyg = pendingPos !== null && !adapter.sourceMode;
        if (!isWysiwyg && !pendingSourceRange) return;

        const assetApi = getAssetApi();

        if (isWysiwyg) {
            deletePendingCommand();
            const view = adapter.editor?.view;
            const startPos = pendingPos;
            const uploadItems = files.map((file, idx) => {
                const isImage = isImageFile(file);
                return {
                    id: `upload-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
                    file,
                    isImage,
                    pos: startPos,
                    percent: 0,
                    phase: 'uploading',
                    error: null,
                    dom: null,
                    statusEl: null,
                    progressFill: null,
                    actions: null,
                };
            });

            if (view) {
                view.dispatch(view.state.tr.setMeta(articleUploadProgressPluginKey, {
                    type: 'ADD_UPLOADS',
                    uploads: uploadItems,
                }));
            }

            if (files.length > 1) {
                window.toaster?.show?.(`正在上传 ${files.length} 个文件…`, 'info', false, 2400);
            }

            const uploads = uploadItems.map((item) => {
                const onProgress = (p) => updateUploadProgress(item, p);
                const upload = item.isImage
                    ? assetApi.uploadImage(item.file, { onProgress })
                    : assetApi.uploadFile(item.file, { onProgress });
                return { item, upload };
            });

            const markdowns = [];
            const failures = [];
            await Promise.all(uploads.map(async ({ item, upload }, index) => {
                try {
                    const asset = await upload;
                    markdowns[index] = item.isImage
                        ? buildArticleImageMarkdown(asset)
                        : buildArticleFileMarkdown(asset);
                } catch (error) {
                    console.error(`Failed to upload article ${item.isImage ? 'image' : 'file'}:`, error);
                    updateUploadProgress(item, { phase: 'error', error: error?.message || '上传失败' });
                    failures.push(item.file);
                }
            }));

            const successfulIds = uploads
                .map((u, i) => (markdowns[i] ? u.item.id : null))
                .filter(Boolean);
            if (view && successfulIds.length > 0) {
                view.dispatch(view.state.tr.setMeta(articleUploadProgressPluginKey, {
                    type: 'REMOVE_UPLOADS',
                    ids: successfulIds,
                }));
            }

            const ready = markdowns.filter(Boolean);
            if (ready.length) {
                insertIntoWysiwyg(ready);
            }
            if (failures.length) {
                const label = failures.some(file => isImageFile(file)) ? '图片' : '文件';
                window.toaster?.show?.(`${label}上传失败，请重试`, 'error', false, 3200);
            }
            pendingPos = null;
            pendingSourceRange = null;
            return;
        }

        // 源码模式
        deletePendingCommand();
        if (files.length === 1) {
            window.toaster?.show?.(`正在上传 ${files[0].name}…`, 'info', false, 2400);
        } else {
            window.toaster?.show?.(`正在上传 ${files.length} 个文件…`, 'info', false, 2400);
        }

        const uploads = files.map((file) => {
            const isImage = isImageFile(file);
            let lastPercent = 0;
            const onProgress = ({ phase, percent }) => {
                if (phase === 'processing') {
                    window.toaster?.show?.(`服务器处理中：${file.name}…`, 'info', false, 1800);
                } else if (typeof percent === 'number' && percent - lastPercent >= 15) {
                    lastPercent = percent;
                    window.toaster?.show?.(`上传中 ${percent}%：${file.name}`, 'info', false, 1200);
                }
            };
            const upload = isImage
                ? assetApi.uploadImage(file, { onProgress })
                : assetApi.uploadFile(file, { onProgress });
            return { isImage, upload };
        });

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
            insertIntoSourceMode(ready);
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
        restoreEditorFocus();
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
        textarea.focus();
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
        // 斜杠菜单的 /file 入口（tiptap-slash-menu.js）：菜单已删掉命令文本，
        // 这里只挂起插入位置并打开选择器。取消上传时 restoreEditorFocus 把
        // 焦点还编辑器，pendingPos 由 openPicker 的 cancel 路径清空。
        openPickerAt(pos) {
            pendingPos = pos;
            openPicker();
        },
    };
}
