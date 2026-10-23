/**
 * 粘贴 / 拖入图片的上传拦截（Tiptap）：浏览器把剪贴板或拖拽里的图片文件
 * 塞进 clipboardData.files / dataTransfer.files，同时把图片写成 HTML 里的
 * `<img src="data:image/png;base64,…">`。内核默认走 HTML 解析路径，于是整张
 * 图以 Base64 落进正文（源码模式看到一屏 base64，且没有 dumbpad-width，
 * 渲染时按原始宽度铺满纸面）。这里抢在解析之前接管：文件走资产上传，
 * 落文形态与 /file 完全一致（`![名](previewUrl "dumbpad-width=360")`）。
 * 存量 Base64 图片不动（allowBase64 仍开着，旧正文照常可读）。
 */
import { Extension, PM } from './tiptap-runtime.js';
import { buildArticleImageMarkdown } from './article-file-command.js';
import { AssetApiClient, isImageFile } from './asset-api-client.js';

const { Plugin, PluginKey } = PM.state;

export const imagePastePluginKey = new PluginKey('dumbpadImagePaste');

/** 事件里的图片文件（剪贴板 / 拖拽同一套 FileList）。 */
export function collectImageFiles(dataTransfer) {
    return Array.from(dataTransfer?.files || []).filter(isImageFile);
}

export const TiptapImagePaste = Extension.create({
    name: 'tiptapImagePaste',

    // adapter：HybridMarkdownEditor 实例（取 assetApi 与当前编辑器）。
    addOptions() {
        return { getAdapter: () => null };
    },

    addProseMirrorPlugins() {
        const getAdapter = this.options.getAdapter;
        let uploading = false;

        const uploadAndInsert = async (view, files) => {
            const adapter = getAdapter();
            if (!adapter || uploading) return;
            uploading = true;
            try {
                if (!adapter.assetApi) {
                    adapter.assetApi = new AssetApiClient({ maxFileBytes: adapter.assetMaxFileBytes ?? undefined });
                }
                const results = await Promise.all(files.map(file => adapter.assetApi.uploadImage(file)
                    .catch((error) => {
                        console.error('Failed to upload pasted image:', error);
                        return null;
                    })));
                const markdowns = results.filter(Boolean).map(buildArticleImageMarkdown);
                const failed = results.filter(item => !item).length;
                if (failed) {
                    window.toaster?.show?.(`${failed} 张图片上传失败，请重试`, 'error', false, 3200);
                }
                if (!markdowns.length) return;
                // 上传期间用户可能继续编辑：用当前位置而不是事件发生时的位置。
                adapter.editor?.commands?.insertContentAt?.(
                    adapter.editor.state.selection.from,
                    markdowns.join('\n\n')
                );
                adapter.notifyEditorValueChanged?.(adapter.getValue());
            } finally {
                uploading = false;
            }
        };

        const takeOver = (view, event, dataTransfer) => {
            const files = collectImageFiles(dataTransfer);
            if (!files.length) return false;
            if (!view.editable) return false;
            event.preventDefault();
            void uploadAndInsert(view, files);
            return true;
        };

        return [
            new Plugin({
                key: imagePastePluginKey,
                props: {
                    handlePaste: (view, event) => takeOver(view, event, event.clipboardData),
                    handleDrop: (view, event) => takeOver(view, event, event.dataTransfer),
                },
            }),
        ];
    },
});
