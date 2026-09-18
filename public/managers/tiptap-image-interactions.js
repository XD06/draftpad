/**
 * 文章图片/附件交互层（Tiptap）：图片尺寸菜单（窄/中/宽/自适应）、下载原图、
 * 查看大图 lightbox、删除图片、指针拖拽换位，以及附件链接菜单（下载/删除）。
 * 宽度与类名以 PM 节点 Decoration 应用（不改 DOM、不改存储形态），动作全部走
 * 框架命令（setNodeMarkup / delete / insert），菜单 DOM 挂在插件 view 上，点击
 * 走 view.dom 的 DOM 监听；禁止回到 Markdown 源码做字符串手术 + setValue 全量重刷。
 */
import { Extension, Image, PM, getMarkRange } from './tiptap-runtime.js';
import { ARTICLE_FILE_TITLE_PREFIX } from './article-file-command.js';

const { Plugin, PluginKey } = PM.state;
const { Decoration, DecorationSet } = PM.view;

const ASSET_URL_RE = /\/api\/assets\/([a-f0-9-]{16,64})\/(?:preview|original)(?:$|[?#])/i;
const ASSET_DOWNLOAD_URL_RE = /\/api\/assets\/[a-f0-9-]{16,64}\/download(?:$|[?#])/i;
const IMAGE_WIDTH_RE = /dumbpad-width=(\d{2,4})/;
const MIN_IMAGE_WIDTH = 160;
const MIN_IMAGE_MAX_WIDTH = 240;
const DRAG_THRESHOLD_PX = 6;
// 拖拽结束后的 click 抑制、触屏点按后的 click 抑制（与旧编辑器同值）。
const DRAG_CLICK_GUARD_MS = 250;
const TAP_CLICK_GUARD_MS = 450;

export const articleImageDecorationKey = new PluginKey('dumbpadArticleImageDecorations');
export const articleImageInteractionKey = new PluginKey('dumbpadArticleImageInteractions');

/** title="dumbpad-width=N" → N（0 表示自适应，与旧 getArticleImageWidth 一致）。 */
export function readImageWidth(title) {
    const match = String(title || '').match(IMAGE_WIDTH_RE);
    return match ? Number(match[1]) : 0;
}

/** 图片 src → 资产 id（旧 getArticleAssetId 的 URL 分支）。 */
export function articleAssetIdFromSource(source) {
    const match = String(source || '').match(ASSET_URL_RE);
    return match ? match[1] : '';
}

/** 旧 isLegacyArticleImage：Base64 内联图片没有资产 id，走 src 自身。 */
export function isLegacyArticleImageSource(source) {
    return /^data:image\//i.test(String(source || ''));
}

/** 旧 decorateArticleImages 的准入判定：只有资产图片（含遗留 Base64）参与装饰与交互。 */
export function isArticleAssetImageSource(source) {
    return Boolean(articleAssetIdFromSource(source)) || isLegacyArticleImageSource(source);
}

/**
/**
 * 附件链接判定：title 以 dumbpad-file=1 开头（/file 与设置里插入的形态），或 href 就是
 * 资产下载 URL（更早的旧数据、或 title 丢失的形态）。命中就走「菜单」而不是交给
 * Tiptap 的 Link 扩展去 window.open（对 /download 就是直接下载）。
 */
export function isArticleFileLink(link) {
    if (!link?.getAttribute) return false;
    if (String(link.getAttribute('title') || '').startsWith(ARTICLE_FILE_TITLE_PREFIX)) return true;
    return ASSET_DOWNLOAD_URL_RE.test(String(link.getAttribute('href') || ''));
}

/**
 * 解析期归一化：旧附件 label 以「📎 」开头（图标已改由 CSS 提供），载入时把这段
 * 装饰前缀从渲染 DOM 的文本节点里去掉，避免出现「主题图标 + 📎」双图标。
 * 只动第一个文本节点，不 flatten 链接内部的其他元素。
 */
export function stripLegacyFileLabelEmoji(element) {
    element.querySelectorAll('a[href]').forEach((link) => {
        if (!isArticleFileLink(link)) return;
        const first = link.firstChild;
        if (!first || first.nodeType !== 3) return;
        const stripped = String(first.nodeValue || '').replace(/^\s*\u{1F4CE}\s*/u, '');
        if (stripped !== first.nodeValue) first.nodeValue = stripped;
    });
}

/** 元素矩形：方法缺失或返回 undefined 时都当作「拿不到」（无布局环境）。 */
function blockRect(element) {
    const rect = element?.getBoundingClientRect?.();
    return rect && typeof rect.top === 'number' ? rect : null;
}

/** 图片宽度 Decoration：类名与 style.width 都由 PM 渲染，不触碰存储形态。 */
export function buildArticleImageDecorations(state) {
    const decorations = [];
    state.doc.descendants((node, pos) => {
        if (node.type.name !== 'image') return true;
        if (!isArticleAssetImageSource(node.attrs.src)) return true;
        const attrs = { class: 'dumbpad-article-image' };
        const width = readImageWidth(node.attrs.title);
        if (width) attrs.style = `width:${width}px`;
        decorations.push(Decoration.node(pos, pos + node.nodeSize, attrs));
        return true;
    });
    return DecorationSet.create(state.doc, decorations);
}

/**
 * 图片节点：
 * - 不作为原生 draggable（HTML5 拖拽在触屏不可用，且与 contenteditable 选区
 *   模型冲突）。换位统一由插件 view 的指针流程完成，落到单个框架事务。
 * - `allowBase64`：旧笔记里的内联 Base64 图片必须继续可读（内核默认
 *   `allowBase64: false`，`img[src^="data:"]` 会被 schema 直接丢掉，等于静默
 *   删除用户内容）。
 * - markdown 序列化：内核自带的 image 序列化不回 `closeBlock`，块级图片后面
 *   的下一个块会粘在图片 markdown 后面（`![图](url)\n\n段落` → `![图](url)段落`，
 *   重新解析后图文合并）。这里逐字节复刻内核实现并补上块分隔。
 */
export const DumbPadImage = Image.configure({ allowBase64: true }).extend({
    draggable: false,

    addStorage() {
        return {
            markdown: {
                serialize(state, node) {
                    const src = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
                    const alt = state.esc(String(node.attrs.alt || ''));
                    const title = node.attrs.title
                        ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"`
                        : '';
                    state.write(`![${alt}](${src}${title})`);
                    state.closeBlock(node);
                },
            },
        };
    },
});

/**
 * 附件链接：给 link mark 加一个只渲染不存储的全局属性——title 以
 * dumbpad-file=1 开头时在 <a> 上输出 dumbpad-article-file 类（styles.css 的
 * 附件胶囊样式与点击菜单都依赖该类）。属性本身不进 markdown 序列化。
 */
export const DumbPadArticleFileLink = Extension.create({
    name: 'dumbpadArticleFileLink',

    addGlobalAttributes() {
        return [
            {
                types: ['link'],
                attributes: {
                    articleFileClass: {
                        default: null,
                        parseHTML: () => null,
                        // 与 isArticleFileLink 同一套判定：title 标了附件，或 href 就是资产
                        // 下载 URL（旧数据 / title 丢失的形态）都要拿到 chip 样式与 download。
                        renderHTML: (attributes) => {
                            const title = String(attributes.title || '');
                            const href = String(attributes.href || '');
                            const isFile = title.startsWith(ARTICLE_FILE_TITLE_PREFIX)
                                || ASSET_DOWNLOAD_URL_RE.test(href);
                            return isFile ? { class: 'dumbpad-article-file', download: '' } : {};
                        },
                    },
                },
            },
        ];
    },

    // 解析期归一化挂在这里（Extension 的 storage.markdown.parse 同样被
    // tiptap-markdown 的解析器收集，与 tiptap-extensions.js 的 updateDOM 同机制）：
    // 旧附件 label 的「📎 」前缀在载入时去掉，图标统一由 CSS 提供。
    addStorage() {
        return {
            markdown: {
                parse: {
                    updateDOM: (element) => stripLegacyFileLabelEmoji(element),
                },
            },
        };
    },
});

export const TiptapImageInteractions = Extension.create({
    name: 'tiptapImageInteractions',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: articleImageDecorationKey,
                props: {
                    decorations: (state) => buildArticleImageDecorations(state),
                },
            }),
            new Plugin({
                key: articleImageInteractionKey,
                view: (editorView) => new ArticleImageInteractionView(editorView),
            }),
        ];
    },
});

/** 尺寸菜单/lightbox/附件菜单的 DOM 生命周期与交互。 */
class ArticleImageInteractionView {
    constructor(view) {
        this.view = view;
        this.activeImage = null;
        this.activeFileLink = null;
        this.drag = null;
        this.lastDragAt = 0;
        this.lastTapAt = 0;

        this.sizeMenu = this.buildSizeMenu();
        this.lightbox = this.buildLightbox();
        this.fileMenu = this.buildFileMenu();

        this.handleClick = (event) => this.onClick(event);
        this.handlePointerDown = (event) => this.onPointerDown(event);
        this.handlePointerMove = (event) => this.onPointerMove(event);
        this.handlePointerUp = (event) => this.onPointerUp(event);
        // <img> 的原生拖拽默认开启（schema 的 draggable:false 只关掉 PM 自己的
        // 节点拖拽），会把内容拖出编辑器或触发 drop 插入。与旧
        // bindArticleImageDragging 一致：拦掉原生拖拽，换位交给指针流程。
        this.handleDragStart = (event) => {
            if (!this.view.editable) return;
            const image = event.target?.closest?.('img');
            if (image && isArticleAssetImageSource(image.getAttribute('src'))) {
                event.preventDefault();
                return;
            }
            // 附件链接同理：原生拖拽会把它当文本拖走并触发 drop 插入。
            const fileLink = event.target?.closest?.('a[href]');
            if (fileLink && isArticleFileLink(fileLink)) event.preventDefault();
        };
        // 点编辑器其他位置/其他面板时收起浮层（旧 ensureArticleImageSizeMenu /
        // ensureArticleFileMenu 的 document 级 mousedown 兜底）。触发元素自身
        // 例外：触屏点按会在 pointerup 之后补发兼容 mousedown，否则刚打开的菜单
        // 会被同一次点按立刻关掉。
        this.handleDocumentMousedown = (event) => {
            if (!this.sizeMenu.hidden
                && !this.sizeMenu.contains(event.target)
                && event.target !== this.activeImage) {
                this.hideSizeMenu();
            }
            if (!this.fileMenu.hidden
                && !this.fileMenu.contains(event.target)
                && event.target !== this.activeFileLink) {
                this.hideFileMenu();
            }
        };
        this.handleDocumentKeydown = (event) => {
            if (event.key !== 'Escape') return;
            if (!this.lightbox.hidden) {
                event.preventDefault();
                this.closeLightbox();
            }
        };

        // 与旧 bindArticleImageInteractions 同机制：直接在 view.dom 挂 DOM 监听。
        // 不用 PM 的 handleClick prop——它依赖 PM 鼠标管线（posAtCoords /
        // view.mouseDown 状态机），无布局环境不可靠。
        // click 必须挂**捕获阶段**：Tiptap 的 Link 扩展默认 openOnClick=true，它的 PM
        // handleClick（冒泡阶段）会对链接调 window.open(href, target="_blank")——对
        // /api/assets/<id>/download 就是直接下载，冒泡阶段的 preventDefault 已经来不及。
        // 捕获阶段先拦下再 stopPropagation，PM 的处理器就看不到这次点击（图片同理）。
        view.dom.addEventListener('click', this.handleClick, true);
        view.dom.addEventListener('pointerdown', this.handlePointerDown);
        view.dom.addEventListener('pointermove', this.handlePointerMove);
        view.dom.addEventListener('pointerup', this.handlePointerUp);
        view.dom.addEventListener('pointercancel', this.handlePointerUp);
        view.dom.addEventListener('dragstart', this.handleDragStart);
        document.addEventListener('keydown', this.handleDocumentKeydown);
        document.addEventListener('mousedown', this.handleDocumentMousedown);
    }

    /** 源码模式：编辑器 DOM 仍在（只是 display:none），菜单必须自己收起。 */
    isSourceMode() {
        return this.view.dom.closest?.('.typora-editor-shell')?.classList.contains('is-source-mode') === true;
    }

    /** 每次状态更新后清理失效浮层：目标元素被重绘/切笔记后菜单不能留在屏幕上。 */
    update() {
        if (!this.sizeMenu.hidden && (!this.activeImage?.isConnected || this.isSourceMode())) {
            this.hideSizeMenu();
        }
        if (!this.fileMenu.hidden && (!this.activeFileLink?.isConnected || this.isSourceMode())) {
            this.hideFileMenu();
        }
    }

    /* ---------------- DOM 构建（沿用旧编辑器的类名与结构，CSS 零改动） ---------------- */

    buildSizeMenu() {
        const menu = document.createElement('div');
        menu.className = 'article-image-size-menu';
        menu.hidden = true;
        menu.innerHTML = `
            <button type="button" data-image-width="360" title="窄">窄</button>
            <button type="button" data-image-width="720" title="中">中</button>
            <button type="button" data-image-width="1080" title="宽">宽</button>
            <button type="button" data-image-width="0" title="自适应">自适应</button>
            <span class="article-image-size-menu-divider" aria-hidden="true"></span>
            <a class="article-image-download" data-image-download download title="下载原图" aria-label="下载原图">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>
            </a>
            <button type="button" class="article-image-fullscreen" data-image-fullscreen title="查看大图" aria-label="查看大图">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5"></path><path d="M16 3h5v5"></path><path d="M21 16v5h-5"></path><path d="M3 16v5h5"></path></svg>
            </button>
            <button type="button" class="article-image-delete" data-image-delete title="删除图片" aria-label="删除图片">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>
            </button>
        `;
        // 菜单内的按下不能让编辑器失焦（否则选区/图片节点状态丢失）。
        menu.addEventListener('mousedown', (event) => event.preventDefault());
        menu.addEventListener('click', (event) => {
            if (event.target.closest('[data-image-fullscreen]')) {
                const image = this.activeImage;
                if (!image) return;
                this.hideSizeMenu();
                this.openLightbox(image);
                return;
            }
            if (event.target.closest('[data-image-delete]')) {
                this.deleteImage();
                return;
            }
            const button = event.target.closest('[data-image-width]');
            if (!button) return;
            this.setImageWidth(Number(button.dataset.imageWidth || 0));
        });
        document.body.appendChild(menu);
        return menu;
    }

    buildLightbox() {
        const lightbox = document.createElement('div');
        lightbox.className = 'article-image-lightbox';
        lightbox.hidden = true;
        lightbox.tabIndex = -1;
        lightbox.setAttribute('role', 'dialog');
        lightbox.setAttribute('aria-modal', 'true');
        lightbox.setAttribute('aria-label', '文章图片预览');
        lightbox.innerHTML = `
            <div class="article-image-lightbox-bar">
                <span class="article-image-lightbox-name"></span>
                <a class="article-image-lightbox-download" download title="下载原图" aria-label="下载原图">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>
                </a>
                <button type="button" class="article-image-lightbox-close" title="关闭" aria-label="关闭图片预览">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
                </button>
            </div>
            <img class="article-image-lightbox-image" alt="">
        `;
        lightbox.addEventListener('click', (event) => {
            if (event.target === lightbox) this.closeLightbox();
        });
        lightbox.querySelector('.article-image-lightbox-close').addEventListener('click', () => this.closeLightbox());
        document.body.appendChild(lightbox);
        return lightbox;
    }

    buildFileMenu() {
        const menu = document.createElement('div');
        menu.className = 'article-file-menu';
        menu.hidden = true;
        menu.setAttribute('role', 'toolbar');
        menu.setAttribute('aria-label', '附件操作');
        menu.innerHTML = `
            <a class="article-file-download" data-file-download download title="下载附件" aria-label="下载附件">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>
            </a>
            <button type="button" class="article-file-delete" data-file-delete title="删除附件" aria-label="删除附件">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>
            </button>
        `;
        menu.addEventListener('mousedown', (event) => event.preventDefault());
        menu.addEventListener('click', (event) => {
            if (!event.target.closest('[data-file-delete]')) return;
            this.deleteFileLink();
        });
        document.body.appendChild(menu);
        return menu;
    }

    /* ---------------- 位置解析 ---------------- */

    /** 渲染元素 → 图片节点位置（posAtDOM 反查，不猜文本）。 */
    imagePos(element) {
        if (!element?.isConnected) return null;
        try {
            const pos = this.view.posAtDOM(element, 0);
            const node = this.view.state.doc.nodeAt(pos);
            return node && node.type.name === 'image' ? pos : null;
        } catch (_error) {
            // 无布局环境或元素已被重绘替换：动作放弃，不猜位置。
            return null;
        }
    }

    /** 顶层独占块的图片（旧 getArticleImageBlock）：嵌套在列表/表格里不参与拖拽。 */
    isStandaloneImage(pos) {
        const $pos = this.view.state.doc.resolve(pos);
        return $pos.depth === 0 && $pos.nodeAfter?.type.name === 'image';
    }

    /**
     * 渲染元素 → 链接文本范围（旧 deleteArticleFile 的框架版）。以渲染元素自身的
     * DOM 范围为准：链接只有一个字符、或紧邻另一个属性不同的链接时，`pos+1` 可能
     * 落在邻居的 mark 上，mark 反查会命中错误的那一个（只作为兜底）。
     */
    linkRange(element) {
        try {
            const doc = this.view.state.doc;
            const start = this.view.posAtDOM(element, 0);
            const end = this.view.posAtDOM(element, element.childNodes.length);
            if (end > start && end <= doc.content.size) return { from: start, to: end };
            const linkType = this.view.state.schema.marks.link;
            for (const candidate of [Math.min(start + 1, doc.content.size), start]) {
                const range = getMarkRange(doc.resolve(candidate), linkType);
                if (range) return range;
            }
            return null;
        } catch (_error) {
            return null;
        }
    }

    /** 指针位置 → 目标块的落点（顶层块边界 + 上下半区）。 */
    resolveDropTarget(event) {
        const blocks = Array.from(this.view.dom.children || []);
        if (!blocks.length) return null;
        const hit = this.topLevelBlockElement(event);
        if (hit) {
            const rect = blockRect(hit);
            // 与旧 getArticleImageDropTarget 一致：拿不到高度时算「插入到块之前」。
            const after = rect?.height ? event.clientY > rect.top + rect.height / 2 : false;
            return this.dropTargetFor(hit, after ? 'after' : 'before');
        }
        // 指针不在任何顶层块内（文末空白、容器内边距、浮动 UI 上）：按旧
        // getArticleImageDropTarget 的兜底判定首/末块或垂直最近的块，否则把图片
        // 拖到文末会静默变成 no-op。
        const first = blocks[0];
        const last = blocks[blocks.length - 1];
        const firstRect = blockRect(first);
        const lastRect = blockRect(last);
        if (firstRect && event.clientY <= firstRect.top) return this.dropTargetFor(first, 'before');
        if (lastRect && event.clientY >= lastRect.bottom) return this.dropTargetFor(last, 'after');
        let nearest = first;
        let nearestDistance = Infinity;
        for (const block of blocks) {
            const rect = blockRect(block);
            if (!rect) continue;
            const distance = Math.abs(event.clientY - (rect.top + rect.height / 2));
            if (distance < nearestDistance) {
                nearest = block;
                nearestDistance = distance;
            }
        }
        const nearestRect = blockRect(nearest);
        const afterNearest = nearestRect?.height ? event.clientY > nearestRect.top + nearestRect.height / 2 : true;
        return this.dropTargetFor(nearest, afterNearest ? 'after' : 'before');
    }

    /**
     * 顶层块 DOM + 前/后 → 文档落点。按 doc 子节点顺序用 `nodeDOM` 身份比对定位
     * ——不能用 `posAtDOM(block, 0)`：它对非叶子块返回的是「块内容起点」（起点 + 1），
     * 空段落会解析成 null（拖拽静默失效），非空段落会算成块内位置（插入时把段落切开）。
     */
    dropTargetFor(block, placement) {
        const doc = this.view.state.doc;
        let pos = 0;
        for (let index = 0; index < doc.childCount; index += 1) {
            const node = doc.child(index);
            if (this.view.nodeDOM(pos) === block) {
                return {
                    pos: placement === 'after' ? pos + node.nodeSize : pos,
                    element: block,
                    placement,
                };
            }
            pos += node.nodeSize;
        }
        return null;
    }

    topLevelBlockElement(event) {
        const fromPoint = typeof document.elementFromPoint === 'function'
            ? document.elementFromPoint(event.clientX, event.clientY)
            : null;
        let element = fromPoint;
        while (element && element.parentElement !== this.view.dom) element = element.parentElement;
        return element?.parentElement === this.view.dom ? element : null;
    }

    /* ---------------- 图片尺寸菜单 ---------------- */

    maxImageWidth() {
        // 与旧 setArticleImageWidth 一致：内容区宽度兜底到视口宽度。
        const rootWidth = Number(this.view.dom.clientWidth || 0);
        return Math.max(MIN_IMAGE_MAX_WIDTH, Math.floor(rootWidth || window.innerWidth - 48));
    }

    openSizeMenu(image) {
        const pos = this.imagePos(image);
        if (pos === null) return;
        this.activeImage = image;
        const assetId = articleAssetIdFromSource(image.getAttribute('src'));
        const download = this.sizeMenu.querySelector('[data-image-download]');
        download.href = assetId
            ? `/api/assets/${assetId}/download`
            : (image.getAttribute('src') || '');
        download.download = image.getAttribute('alt') || '图片';
        this.positionMenuUnderElement(this.sizeMenu, image, 210);
        this.sizeMenu.hidden = false;
    }

    hideSizeMenu() {
        this.sizeMenu.hidden = true;
        this.activeImage = null;
    }

    /** 四档宽度：窄/中/宽写 title="dumbpad-width=N"，自适应清空 title。 */
    setImageWidth(requestedWidth) {
        const image = this.activeImage;
        const pos = image ? this.imagePos(image) : null;
        // 菜单先收起：图片元素已被重绘/切走时位置反查会失败，早退不能把浮层留在屏幕上。
        this.hideSizeMenu();
        if (pos === null) return;
        const node = this.view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return;
        const maxWidth = this.maxImageWidth();
        const width = requestedWidth
            ? Math.min(Math.max(MIN_IMAGE_WIDTH, requestedWidth), maxWidth)
            : 0;
        const attrs = { ...node.attrs, title: width ? `dumbpad-width=${width}` : null };
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, attrs));
    }

    deleteImage() {
        const image = this.activeImage;
        const pos = image ? this.imagePos(image) : null;
        this.hideSizeMenu();
        if (pos === null) return;
        const node = this.view.state.doc.nodeAt(pos);
        if (!node) return;
        this.view.dispatch(this.view.state.tr.delete(pos, pos + node.nodeSize));
        this.view.focus();
    }

    /* ---------------- 阅读模式 lightbox ---------------- */

    openLightbox(image) {
        const src = image.getAttribute('src') || '';
        const assetId = articleAssetIdFromSource(src);
        const originalUrl = assetId ? `/api/assets/${assetId}/original` : src;
        const downloadUrl = assetId ? `/api/assets/${assetId}/download` : src;
        const name = image.getAttribute('alt') || '图片';
        this.lightbox.hidden = false;
        document.body.classList.add('article-image-lightbox-open');
        this.lightbox.querySelector('.article-image-lightbox-name').textContent = name;
        const fullImage = this.lightbox.querySelector('.article-image-lightbox-image');
        fullImage.alt = name;
        fullImage.src = originalUrl;
        const download = this.lightbox.querySelector('.article-image-lightbox-download');
        download.href = downloadUrl;
        download.download = name;
        this.lightboxTrigger = image;
        this.lightbox.querySelector('.article-image-lightbox-close').focus?.({ preventScroll: true });
    }

    closeLightbox() {
        if (this.lightbox.hidden) return;
        this.lightbox.hidden = true;
        document.body.classList.remove('article-image-lightbox-open');
        this.lightboxTrigger?.focus?.({ preventScroll: true });
        this.lightboxTrigger = null;
    }

    /* ---------------- 附件链接菜单 ---------------- */

    openFileMenu(link) {
        if (!link?.isConnected || !this.view.editable) return;
        this.activeFileLink = link;
        const download = this.fileMenu.querySelector('[data-file-download]');
        download.href = link.getAttribute('href') || '';
        download.download = String(link.textContent || '附件').replace(/^📎\s*/, '').split('·')[0].trim() || '附件';
        this.positionMenuUnderElement(this.fileMenu, link, 68);
        this.fileMenu.hidden = false;
    }

    hideFileMenu() {
        this.fileMenu.hidden = true;
        this.activeFileLink = null;
    }

    deleteFileLink() {
        const link = this.activeFileLink;
        const range = link?.isConnected ? this.linkRange(link) : null;
        // 菜单先收起：链接已被重绘/切走时范围反查会失败，早退不能把浮层留在屏幕上。
        this.hideFileMenu();
        if (!range) return;
        this.view.dispatch(this.view.state.tr.delete(range.from, range.to));
        this.view.focus();
    }

    /* ---------------- 定位 ---------------- */

    positionMenuUnderElement(menu, element, fallbackWidth) {
        const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
        const menuWidth = menu.offsetWidth || fallbackWidth;
        const menuHeight = menu.offsetHeight || 40;
        const centeredLeft = rect ? rect.left + (rect.width - menuWidth) / 2 : 0;
        const below = rect ? rect.bottom + 8 : 8;
        menu.style.left = `${Math.max(10, Math.min(window.innerWidth - menuWidth - 10, centeredLeft))}px`;
        menu.style.top = `${Math.max(10, Math.min(window.innerHeight - menuHeight - 10, below))}px`;
    }

    /* ---------------- 点击 ---------------- */

    onClick(event) {
        if (Date.now() - this.lastDragAt < DRAG_CLICK_GUARD_MS) return;
        const target = event.target;
        const fileLink = target?.closest?.('a[href]');
        if (fileLink && this.view.dom.contains(fileLink) && this.view.editable && isArticleFileLink(fileLink)) {
            // 捕获阶段拦下并阻断：否则 Tiptap 的 Link 扩展会把这次点击变成
            // window.open('/api/assets/<id>/download')，也就是直接下载。
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            this.hideSizeMenu();
            this.openFileMenu(fileLink);
            return;
        }
        const image = target?.closest?.('img');
        if (!image || !this.view.dom.contains(image)) return;
        if (!isArticleAssetImageSource(image.getAttribute('src'))) return;
        // 触屏点按已在 pointerup 处理（preventDefault 的 pointerdown 不产生 click）。
        if (Date.now() - this.lastTapAt < TAP_CLICK_GUARD_MS) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (!this.view.editable) {
            this.hideSizeMenu();
            this.openLightbox(image);
            return;
        }
        this.openSizeMenu(image);
    }

    /* ---------------- 指针拖拽换位 ---------------- */

    onPointerDown(event) {
        if (!this.view.editable) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const image = event.target?.closest?.('img');
        if (!image || !this.view.dom.contains(image)) return;
        if (!isArticleAssetImageSource(image.getAttribute('src'))) return;
        const pos = this.imagePos(image);
        if (pos === null || !this.isStandaloneImage(pos)) return;
        // 触屏按下 contenteditable 内的元素会让浏览器移动选区并弹出键盘，
        // 即使用户只想调尺寸/拖拽（与旧 bindArticleImageDragging 一致）。
        if (event.pointerType !== 'mouse') event.preventDefault();
        this.drag = {
            image,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            drop: null,
        };
        image.setPointerCapture?.(event.pointerId);
    }

    onPointerMove(event) {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
        if (!drag.active) {
            drag.active = true;
            this.hideSizeMenu();
            this.hideFileMenu();
            drag.image.classList.add('is-article-image-dragging');
            this.view.dom.classList.add('is-article-image-drop-target');
        }
        if (this.imagePos(drag.image) === null) {
            this.cancelDrag();
            return;
        }
        event.preventDefault();
        drag.drop = this.resolveDropTarget(event);
        this.showDropCaret(drag.drop);
    }

    onPointerUp(event) {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        this.drag = null;
        drag.image.classList.remove('is-article-image-dragging');
        this.view.dom.classList.remove('is-article-image-drop-target');
        this.hideDropCaret();
        drag.image.releasePointerCapture?.(event.pointerId);
        if (!drag.active) {
            if (drag.pointerType !== 'mouse') {
                event.preventDefault();
                event.stopPropagation();
                this.lastTapAt = Date.now();
                this.openSizeMenu(drag.image);
            }
            return;
        }
        event.preventDefault();
        this.lastDragAt = Date.now();
        this.moveImage(drag);
    }

    cancelDrag() {
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        drag.image.classList.remove('is-article-image-dragging');
        this.view.dom.classList.remove('is-article-image-drop-target');
        this.hideDropCaret();
    }

    /** 换位 = 单个框架事务（delete + insert），进撤销历史并自然触发保存。 */
    moveImage(drag) {
        const pos = this.imagePos(drag.image);
        if (pos === null || !drag.drop) return;
        const node = this.view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return;
        const target = drag.drop.pos;
        if (target >= pos && target <= pos + node.nodeSize) return;
        const tr = this.view.state.tr.delete(pos, pos + node.nodeSize);
        tr.insert(tr.mapping.map(target), node);
        this.view.dispatch(tr.scrollIntoView());
    }

    ensureDropCaret() {
        if (!this.dropCaret) {
            // 复用时间标记的落点竖线样式，不新增 CSS。
            this.dropCaret = document.createElement('div');
            this.dropCaret.className = 'time-marker-drop-caret is-block-drop-caret';
            this.dropCaret.hidden = true;
            document.body.appendChild(this.dropCaret);
        }
        return this.dropCaret;
    }

    showDropCaret(drop) {
        if (!drop?.element) {
            this.hideDropCaret();
            return;
        }
        const caret = this.ensureDropCaret();
        const blockRect = drop.element.getBoundingClientRect();
        const rootRect = this.view.dom.getBoundingClientRect();
        caret.style.left = `${Math.round(rootRect.left)}px`;
        caret.style.top = `${Math.round(drop.placement === 'before' ? blockRect.top - 1 : blockRect.bottom - 1)}px`;
        caret.style.width = `${Math.max(24, Math.round(rootRect.width))}px`;
        caret.hidden = false;
    }

    hideDropCaret() {
        if (this.dropCaret) this.dropCaret.hidden = true;
    }

    /* ---------------- 生命周期 ---------------- */

    destroy() {
        this.cancelDrag();
        this.view.dom.removeEventListener('click', this.handleClick, true);
        this.view.dom.removeEventListener('dragstart', this.handleDragStart);
        this.view.dom.removeEventListener('pointerdown', this.handlePointerDown);
        this.view.dom.removeEventListener('pointermove', this.handlePointerMove);
        this.view.dom.removeEventListener('pointerup', this.handlePointerUp);
        this.view.dom.removeEventListener('pointercancel', this.handlePointerUp);
        document.removeEventListener('keydown', this.handleDocumentKeydown);
        document.removeEventListener('mousedown', this.handleDocumentMousedown);
        document.body.classList.remove('article-image-lightbox-open');
        this.sizeMenu.remove();
        this.lightbox.remove();
        this.fileMenu.remove();
        this.dropCaret?.remove();
    }
}
