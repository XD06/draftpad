/**
 * 文章嵌入媒体（Tiptap）：/file 上传的音视频落成可内联播放的媒体节点而非
 * 附件 chip。markdown 形态沿用「title 携带元数据」的既有先例（图片
 * dumbpad-width、附件 dumbpad-file），视频/音频分别以 dumbpad-video=1 /
 * dumbpad-audio=1 开头，src 指向资产的 original 变体（服务端对媒体返回
 * inline + Range）。解析侧经 storage.markdown.parse.updateDOM 把 marked
 * 渲染出的 <img title^="dumbpad-video/audio"> 改名成 <video>/<audio>，再由
 * 本节点的 parseHTML 收编为 articleMedia 原子节点；序列化侧写回同形态
 * markdown，往返逐字节稳定。文件名条（下载/删除）由 NodeView 提供，原生
 * 播放控件的事件经 stopEvent 留给浏览器，不进 PM 管线。
 */
import { Node } from './tiptap-runtime.js';
import {
    parseMediaTitle,
    formatFileSize,
} from './article-file-command.js';
import { getFileCategory, getFileIconSvg } from './file-type-icons.js';

/** 节点 src（/api/assets/<id>/original|preview）→ 下载变体 URL；非资产 src 返回空。 */
function mediaDownloadUrlFromSource(source) {
    const match = String(source || '').match(/\/api\/assets\/([a-f0-9-]{16,64})\/(?:preview|original)(?:$|[?#])/i);
    return match ? `/api/assets/${match[1]}/download` : '';
}

/** marked 把媒体 markdown 渲染成 <img>，这里在 schema 解析前改名成媒体元素。 */
function upgradeMediaPlaceholders(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('img[title]').forEach((img) => {
        const info = parseMediaTitle(img.getAttribute('title'));
        if (!info) return;
        const media = document.createElement(info.kind);
        media.setAttribute('src', img.getAttribute('src') || '');
        media.setAttribute('controls', '');
        media.setAttribute('preload', 'metadata');
        // title 必须跟到媒体元素上：schema 的属性解析靠它读回元数据。
        media.setAttribute('title', img.getAttribute('title') || '');
        media.setAttribute('data-dumbpad-media', info.kind);
        img.replaceWith(media);
    });
}

/** 文件名条操作按钮（下载/删除）的极简线稿图标。 */
function actionIconSvg(path) {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function buildMediaNodeView({ node, editor, view, getPos }) {
    let currentNode = node;
    let mediaEl = null;

    // wrapper 元素生命周期与节点绑定（PM 只在创建时读一次 dom）：
    // src/title 变化（撤销/重做）只重建内部内容，绝不整体替换 wrapper。
    const wrapper = document.createElement('span');
    wrapper.className = 'dumbpad-article-media';

    const mediaInfo = () => parseMediaTitle(currentNode.attrs.title)
        || { kind: 'video', name: '', size: 0, type: '' };

    function render() {
        const info = mediaInfo();
        const kind = info.kind;
        const displayName = info.name || (kind === 'audio' ? '音频' : '视频');
        const cat = getFileCategory(displayName, info.type);
        const themeColor = cat.color || 'var(--primary-color)';

        wrapper.dataset.mediaKind = kind;
        wrapper.style.setProperty('--media-theme', themeColor);

        while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);

        const media = document.createElement(kind);
        media.setAttribute('controls', '');
        media.setAttribute('preload', 'metadata');
        media.setAttribute('src', String(currentNode.attrs.src || ''));

        const meta = document.createElement('span');
        meta.className = 'dumbpad-article-media-meta';

        const icon = document.createElement('span');
        icon.className = 'dumbpad-article-media-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = getFileIconSvg(cat, info.type, { size: 16 });

        const name = document.createElement('span');
        name.className = 'dumbpad-article-media-name';
        name.textContent = `${displayName} · ${formatFileSize(info.size)}`;

        meta.append(icon, name);

        const downloadHref = mediaDownloadUrlFromSource(currentNode.attrs.src);
        if (downloadHref) {
            const download = document.createElement('a');
            download.className = 'dumbpad-article-media-download';
            download.href = downloadHref;
            download.setAttribute('download', displayName);
            download.title = '下载媒体';
            download.setAttribute('aria-label', '下载媒体');
            download.innerHTML = actionIconSvg('<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>');
            meta.append(download);
        }

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'dumbpad-article-media-delete';
        deleteButton.title = '删除媒体';
        deleteButton.setAttribute('aria-label', '删除媒体');
        deleteButton.innerHTML = actionIconSvg('<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>');
        deleteButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!editor.isEditable) return;
            const pos = typeof getPos === 'function' ? getPos() : null;
            if (pos === null || typeof pos !== 'number') return;
            const size = view.state.doc.nodeAt(pos)?.nodeSize;
            if (!size) return;
            view.dispatch(view.state.tr.delete(pos, pos + size));
            view.focus();
        });
        meta.append(deleteButton);

        // 视频：播放器在上、文件名条在下；音频：紧凑卡片把信息条放上面。
        if (kind === 'audio') {
            wrapper.append(meta, media);
        } else {
            wrapper.append(media, meta);
        }

        mediaEl = media;
    }

    render();

    return {
        dom: wrapper,
        stopEvent(event) {
            // 原生控件的点击会以媒体元素为 target（shadow DOM 重定向），
            // 一律交给浏览器；文件名条上的按钮由自己的监听处理。
            if (event.target?.closest?.('.dumbpad-article-media-meta')) return true;
            return event.target === mediaEl;
        },
        ignoreMutation() {
            return true;
        },
        update(updatedNode) {
            if (updatedNode.type.name !== 'articleMedia') return false;
            currentNode = updatedNode;
            render();
            return true;
        },
        destroy() {},
    };
}

/**
 * 嵌入媒体节点（视频/音频共用，kind 由 title 前缀派生）：
 * - 内联原子节点，与图片同处一段，块级观感由 CSS display:block 提供；
 * - NodeView 渲染原生播放器 + 文件名条；atom + stopEvent 保证控件可点、
 *   点卡片其余部分仍能得到 PM 节点选区（Backspace 可删）。
 */
export const DumbPadMedia = Node.create({
    name: 'articleMedia',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
        return {
            src: { default: '' },
            title: { default: null },
        };
    },

    parseHTML() {
        return [
            { tag: 'video[src]' },
            { tag: 'audio[src]' },
        ];
    },

    renderHTML({ node }) {
        // 剪贴板/HTML 序列化形态：保留原生媒体元素与 kind 标记。
        const info = parseMediaTitle(node.attrs.title);
        const kind = info?.kind || 'video';
        return [kind, {
            src: String(node.attrs.src || ''),
            controls: '',
            preload: 'metadata',
            'data-dumbpad-media': kind,
        }];
    },

    addNodeView() {
        return buildMediaNodeView;
    },

    addStorage() {
        return {
            markdown: {
                serialize(state, node) {
                    const info = parseMediaTitle(node.attrs.title);
                    const kind = info?.kind || 'video';
                    const name = `${info?.name || (kind === 'audio' ? '音频' : '视频')} · ${formatFileSize(info?.size || 0)}`;
                    const src = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
                    const label = name.replace(/[\[\]\\]/g, '\\$&');
                    const title = node.attrs.title
                        ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"`
                        : '';
                    // 内联原子：不 closeBlock，段落序列化时自然融入所在行。
                    state.write(`![${label}](${src}${title})`);
                },
                parse: {
                    updateDOM: upgradeMediaPlaceholders,
                },
            },
        };
    },
});

export const ARTICLE_MEDIA_NODE_NAME = 'articleMedia';
