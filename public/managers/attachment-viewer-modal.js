/**
 * 方案 A 附件浮层控制器：把 attachment-viewer-modal-demos.html 的交互逻辑接进 DumbPad。
 * 只替换 demo 的 5 个点（数据来源 / 保存动作 / toast / 下载·复制 / 挂载入口），
 * 其余 HTML 结构、class、状态机、字数统计、焦点与键盘行为全部照搬 demo。
 */
import { PreviewManager } from './preview.js';
import { getFileCategory } from './file-type-icons.js';
import { formatFileSize } from './article-file-command.js';
import NoteSyncController from './note-sync-controller.js';
import {
    getAssetPreviewUrl,
    getAssetOriginalUrl,
    getAssetDownloadUrl,
} from './asset-api-client.js';

const CONFLICT_MESSAGE = '内容已在其他设备更新，请刷新后再保存或复制当前内容';
// 只借用 NoteSyncController 的纯函数 mergeContents()（app.js:3051 的同一套
// 三方合并）；不碰它的启动缓存，所以给它一个不会落盘的 storageManager。
const noteSyncController = new NoteSyncController({
    storageManager: { load: () => null, save: () => {} }
});

const state = {
    overlay: null,
    modal: null,
    previewPane: null,
    textarea: null,
    attachment: null,
    assetId: '',
    contentVersion: 0,
    currentContent: '',
    loadedBaseline: null,
    lastSavedContent: null,
    lastFocused: null,
    saving: false,
    loadToken: 0,
};
let markedLoader = null;
let sanitizerLoader = null;

/* ------------------------------------------------------------------
   数据来源：把三个入口传来的附件对象归一成同一形态。
   ------------------------------------------------------------------ */
function normalizeAttachment(raw = {}) {
    const previewUrl = getAssetPreviewUrl(raw) || '';
    const originalUrl = getAssetOriginalUrl(raw) || '';
    const downloadUrl = getAssetDownloadUrl(raw) || '';
    return {
        // Thought 附件的 id 是「实例 id」，assetId 才是服务端资产 id；
        // 设置列表 / 文章胶囊则只有 id。统一由 resolveAssetId() 判定。
        assetId: String(raw.assetId || '').trim(),
        id: String(raw.id || '').trim(),
        name: String(raw.name || '未命名附件'),
        type: String(raw.type || ''),
        size: Number(raw.size || 0),
        previewUrl,
        originalUrl,
        downloadUrl,
        dataUrl: String(raw.dataUrl || ''),
    };
}

/** 资产 id 以 URL 为准（三个入口的 URL 都由服务端下发），字段只作提示。 */
function resolveAssetId(att) {
    const hint = String(att.assetId || '').trim();
    if (/^[a-f0-9-]{16,64}$/i.test(hint)) return hint;
    for (const url of [att.originalUrl, att.downloadUrl, att.previewUrl]) {
        const match = String(url || '').match(/\/api\/assets\/([a-f0-9-]{16,64})\//i);
        if (match) return match[1];
    }
    return '';
}

function resolveReadUrl(att) {
    // 文件类资产没有 previewUrl（asset-routes.js 的 responseAsset 只在图片时下发），
    // 因此正文优先取 original；preview / download / dataUrl 依次兜底。
    return att.originalUrl || att.previewUrl || att.downloadUrl || att.dataUrl || '';
}

function detectEncoding(att) {
    const match = /charset\s*=\s*([^;\s]+)/i.exec(att.type || '');
    return match ? match[1].toUpperCase() : 'UTF-8';
}

function contentEndpoint(assetId) {
    return `/api/assets/${encodeURIComponent(assetId)}/content`;
}

/**
 * 读接口：资产型附件走 GET /content（UTF-8 文本 + contentVersion，no-store）；
 * 遗留内联附件（dataUrl，没有资产 id）仍走它自己的 URL 读文本，但不可编辑保存。
 */
async function readAttachmentContent(att, assetId) {
    const url = assetId ? contentEndpoint(assetId) : resolveReadUrl(att);
    if (!url) throw new Error('附件地址不可用，无法读取内容');
    const response = await window.fetch(url, { credentials: 'same-origin' });
    if (assetId) {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `附件读取失败（HTTP ${response.status}）`);
        return {
            text: String(data.content ?? ''),
            contentVersion: Number(data.contentVersion) || 0,
            name: String(data.name || att.name),
            type: String(data.type || att.type),
            size: Number(data.size) || att.size,
        };
    }
    if (!response.ok) throw new Error(`附件读取失败（HTTP ${response.status}）`);
    return { text: await response.text(), contentVersion: 0, name: att.name, type: att.type, size: att.size };
}

function fillFileMeta(att) {
    const title = document.getElementById('file-title-a');
    const tag = document.querySelector('.modal-header-a .file-tag');
    const sub = document.querySelector('.modal-header-a .file-sub-meta');
    const category = getFileCategory(att.name, att.type);
    if (title) title.textContent = att.name || '未命名附件';
    if (tag) tag.textContent = category.badge || 'FILE';
    if (sub) sub.textContent = `${formatFileSize(att.size)} · ${detectEncoding(att)}`;
}

/* ------------------------------------------------------------------
   toast：demo 的 triggerToast / .demo-toast → window.toaster
   ------------------------------------------------------------------ */
function triggerToast(text, type = 'success') {
    const toaster = window.toaster;
    if (!toaster || typeof toaster.show !== 'function') return;
    toaster.show(text, type, false, 2200);
}

/* ------------------------------------------------------------------
   markdown 渲染：复用 managers/preview.js 的 PreviewManager 实现，
   输出再过项目自己的 sanitizer（app.js:730-735 同一条链路）。
   ------------------------------------------------------------------ */
async function renderMarkdown(md) {
    markedLoader ||= import('/js/marked/marked.esm.js');
    sanitizerLoader ||= import('./markdown-html-sanitizer.js');
    const [{ marked }, { sanitizeHtml }] = await Promise.all([markedLoader, sanitizerLoader]);
    const html = PreviewManager.prototype.getFormattedContentForPrint.call({ marked }, md || '', true);
    if (state.previewPane) state.previewPane.innerHTML = sanitizeHtml(html);
}

function renderMarkdownSafely(md) {
    Promise.resolve(renderMarkdown(md)).catch((error) => {
        triggerToast(error?.message || '预览渲染失败', 'error');
    });
}

/* ------------------------------------------------------------------
   以下四个函数与 demo 逐字一致（纯前端，不在 5 个改动点内）。
   ------------------------------------------------------------------ */
function syncContent() {
    if (state.textarea) state.textarea.value = state.currentContent;
}

// 底部状态栏字数：实时统计（原先是写死的假数据）
function updateContentMetrics() {
    const el = document.getElementById('word-count-a');
    if (!el) return;
    const chars = [...state.currentContent].length;
    el.textContent = chars.toLocaleString('en-US') + ' 字 · UTF-8';
}

// 保存状态三态：idle 就绪 / dirty 有未保存改动 / saved 已保存
function setSaveState(stateName) {
    const text = document.getElementById('save-status-text-a');
    const dot = document.getElementById('status-dot-a');
    if (!text || !dot) return;

    if (stateName === 'dirty') {
        text.textContent = '有未保存改动...';
        text.style.color = 'var(--warn-color)';
    } else if (stateName === 'saved') {
        text.textContent = '已保存于 ' + new Date().toLocaleTimeString();
        text.style.color = 'var(--success-color)';
    } else {
        text.textContent = '就绪';
        text.style.color = '';
    }
    dot.classList.toggle('is-dirty', stateName === 'dirty');
}

function handleEditorInput() {
    if (state.textarea) {
        state.currentContent = state.textarea.value;
        setSaveState('dirty');
        updateContentMetrics();
    }
}

/* ------------------------------------------------------------------
   保存动作：真正原地写回同一个资产（PUT /api/assets/:id/content）。
   routes/asset-routes.js 的 baseVersion 冲突返回 409 + currentVersion；
   这里复用 app.js:3044-3101 的处理顺序：拉远端 → 三方合并 → 可合就带新
   版本重存，不可合就冲突 toast + 保持 dirty + 保留用户输入。
   ------------------------------------------------------------------ */
async function saveFileContent() {
    if (!state.attachment || state.saving) return;
    state.saving = true;
    let text = state.textarea ? state.textarea.value : state.currentContent;
    try {
        // 最多两轮：第一轮被 409 打断并自动合并后，第二轮带新版本重存。
        for (let attempt = 0; attempt < 2; attempt += 1) {
            state.currentContent = text;
            // app.js:2977-2980 同款离线守卫：断网必须响亮失败且不清空 textarea
            if (!window.navigator.onLine) throw new Error('网络已断开，保存失败，内容已保留');
            if (!state.assetId) throw new Error('该附件不支持在线编辑（缺少资产 id），内容已保留');

            const response = await window.fetch(contentEndpoint(state.assetId), {
                method: 'PUT',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'X-Asset-Base-Version': String(state.contentVersion)
                },
                body: text
            });
            const data = await response.json().catch(() => ({}));

            if (response.status === 409) {
                let remote;
                try {
                    remote = await readAttachmentContent(state.attachment, state.assetId);
                } catch (error) {
                    throw new Error(error?.message || '读取远端内容失败，内容已保留');
                }
                const merge = noteSyncController.mergeContents({
                    base: state.loadedBaseline,
                    local: text,
                    remote: remote.text
                });
                const conflictVersion = Number(data.currentVersion);
                state.contentVersion = Number.isFinite(conflictVersion) ? conflictVersion : remote.contentVersion;
                if (!merge.ok) {
                    window.toaster?.show?.(CONFLICT_MESSAGE, 'error', true, 6000);
                    setSaveState('dirty');
                    return;
                }
                text = merge.content;
                state.currentContent = text;
                syncContent();
                updateContentMetrics();
                if (merge.content === remote.text) {
                    // 远端已包含本地改动：直接采用远端，不必再写
                    state.loadedBaseline = text;
                    state.lastSavedContent = text;
                    state.attachment = { ...state.attachment, size: remote.size };
                    fillFileMeta(state.attachment);
                    renderMarkdownSafely(text);
                    setSaveState('saved');
                    triggerToast('已自动合并远端修改', 'success');
                    return;
                }
                triggerToast('已自动合并远端修改，正在同步', 'success');
                continue;
            }

            if (!response.ok) throw new Error(data?.error || `保存失败（HTTP ${response.status}）`);
            const savedVersion = Number(data.contentVersion);
            state.contentVersion = Number.isFinite(savedVersion) ? savedVersion : state.contentVersion + 1;
            state.loadedBaseline = text;
            state.lastSavedContent = text;
            state.attachment = { ...state.attachment, size: Number(data.size) || text.length };
            fillFileMeta(state.attachment);
            renderMarkdownSafely(text);
            syncContent();
            setSaveState('saved');
            triggerToast('附件修改已成功保存至服务端！', 'success');
            return;
        }
        // 两轮都被 409 打断：不静默失败
        window.toaster?.show?.(CONFLICT_MESSAGE, 'error', true, 6000);
        setSaveState('dirty');
    } catch (error) {
        triggerToast(error?.message || '保存失败，内容已保留', 'error');
        setSaveState('dirty');
        // 不清空 textarea：用户已输入内容原样保留
    } finally {
        state.saving = false;
    }
}

/* ------------------------------------------------------------------
   下载 / 复制：复用项目现有逻辑（含失败提示）。
   ------------------------------------------------------------------ */
function downloadActiveAttachment() {
    const url = getAssetDownloadUrl(state.attachment || {});
    if (!url) {
        triggerToast('附件下载地址不可用', 'error');
        return;
    }
    triggerToast('正在下载原文件...', 'info');
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = state.attachment?.name || 'attachment';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

async function copyFullContent() {
    const content = state.currentContent;
    try {
        await window.navigator.clipboard.writeText(content);
        triggerToast('已成功复制全文到剪贴板', 'success');
        return;
    } catch {
        /* 走 app.js:3977-3994 的 DOM 兜底 */
    }
    try {
        const helper = document.createElement('textarea');
        helper.value = content;
        helper.style.position = 'fixed';
        helper.style.left = '-9999px';
        document.body.appendChild(helper);
        helper.select();
        const ok = document.execCommand('copy');
        helper.remove();
        if (!ok) throw new Error('copy failed');
        triggerToast('已成功复制全文到剪贴板', 'success');
    } catch {
        triggerToast('复制失败', 'error');
    }
}

/* ------------------------------------------------------------------
   挂载入口：demo 的 openActiveModal / closeModal / 遮罩 / ESC / Tab / 焦点回归。
   ------------------------------------------------------------------ */
let lastFocused = null;

function openActiveModal() {
    const overlay = state.overlay;
    const modal = state.modal;
    if (!overlay || !modal) return;
    lastFocused = document.activeElement;

    modal.style.display = 'flex';
    // demo 里的 chip 快捷浮层是 demo 舞台脚手架，DumbPad 没有，做空值保护
    const chipPopover = document.getElementById('chip-popover');
    if (chipPopover) chipPopover.style.display = 'none';
    void modal.offsetWidth; // 强制一次布局，入场动画才会从 scale(0.96) 真正开始
    overlay.classList.add('open');

    // 焦点移入对话框，键盘 / 读屏用户不会仍停在背后的页面上
    requestAnimationFrame(() => {
        if (overlay.classList.contains('open')) {
            modal.focus({ preventScroll: true });
        }
    });
}

function closeModal() {
    const overlay = state.overlay;
    const modal = state.modal;
    if (!overlay || !overlay.classList.contains('open')) return;

    overlay.classList.remove('open');

    // 退场动画结束后再移出布局：关闭后的对话框不该还能被 Tab / 读屏访问
    window.setTimeout(() => {
        if (!overlay.classList.contains('open')) {
            modal.style.display = 'none';
        }
    }, 320);

    // 关闭后把焦点还给触发它的那个入口
    if (lastFocused && document.contains(lastFocused)) {
        lastFocused.focus({ preventScroll: true });
    }
    lastFocused = null;
}

function handleOverlayClick(event) {
    if (event.target.id === 'modal-overlay') {
        closeModal();
    }
}

// 方案 A 模式切换
function setModeA(mode) {
    const isPrev = mode === 'preview';
    const setBtn = (id, on) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    };
    setBtn('btn-desk-prev-a', isPrev);
    setBtn('btn-desk-edit-a', !isPrev);
    setBtn('btn-mob-prev-a', isPrev);
    setBtn('btn-mob-edit-a', !isPrev);

    const previewPane = document.getElementById('pane-preview-a');
    const editPane = document.getElementById('pane-edit-a');
    if (previewPane) previewPane.classList.toggle('active', isPrev);
    if (editPane) editPane.classList.toggle('active', !isPrev);
    document.querySelector('.modal-header-a')?.classList.toggle('is-editing', !isPrev);

    // 顶部保存按钮（桌面为文字+图标，移动端只保留圆形图标按钮）
    // 🌟 用 .is-hidden 保留占位而非 display:none：
    //    右侧操作组宽度恒定，切换时中间的预览 / 编辑分段器不会左右偏移
    document.getElementById('btn-save-a')?.classList.toggle('is-hidden', isPrev);

    if (isPrev) {
        renderMarkdownSafely(state.currentContent);
    } else {
        state.textarea?.focus();
    }
}

/**
 * 三个真实入口（文章附件胶囊 / Thought 附件卡 / 设置列表）统一调这里。
 * @param {object} raw 附件描述对象
 * @param {HTMLElement} trigger 触发入口，关闭后焦点回到它
 */
async function openAttachmentViewer(raw, trigger) {
    if (!state.overlay || !state.modal) return;
    const base = normalizeAttachment(raw);
    const assetId = resolveAssetId(base);
    if (!assetId && !resolveReadUrl(base)) {
        triggerToast('附件信息不完整，无法打开', 'error');
        return;
    }

    state.attachment = base;
    state.assetId = assetId;
    state.contentVersion = 0;
    state.lastFocused = trigger || document.activeElement;

    fillFileMeta(base);
    setModeA('preview');
    openActiveModal();
    // openActiveModal 会把 lastFocused 设为当前 activeElement，用入口覆盖回来
    lastFocused = state.lastFocused;

    const token = ++state.loadToken;
    try {
        const loaded = await readAttachmentContent(base, assetId);
        if (token !== state.loadToken || !state.overlay.classList.contains('open')) return;
        state.currentContent = loaded.text;
        state.contentVersion = loaded.contentVersion;
        state.loadedBaseline = loaded.text;
        state.lastSavedContent = loaded.text;
        state.attachment = { ...base, name: loaded.name, type: loaded.type, size: loaded.size };
        fillFileMeta(state.attachment);
        syncContent();
        renderMarkdownSafely(loaded.text);
        updateContentMetrics();
        setSaveState('idle');
    } catch (error) {
        if (token !== state.loadToken) return;
        triggerToast(error?.message || '附件读取失败', 'error');
        // 请求失败不静默、不清空 textarea
        updateContentMetrics();
        setSaveState('idle');
    }
}

/* ------------------------------------------------------------------
   键盘：与 demo 一致；Ctrl/Cmd+S 只在浮层打开时接管，避免吞掉文章保存快捷键。
   ------------------------------------------------------------------ */
function installKeyHandlers() {
    // 用 div 模拟的按钮（附件胶囊 / Thought 附件）补上键盘激活
    document.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"]')) {
            e.preventDefault();
            e.target.click();
        }
    });

    window.addEventListener('keydown', (e) => {
        const overlay = state.overlay;
        const isOpen = overlay?.classList.contains('open');

        if (e.key === 'Escape' && isOpen) {
            closeModal();
            return;
        }

        if (isOpen && (e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            saveFileContent();
            return;
        }

        // 对话框打开时 Tab 在内部循环，不跑到遮罩后面的页面上
        if (e.key === 'Tab' && isOpen) {
            const modal = state.modal;
            const focusables = [...modal.querySelectorAll('button, textarea, [href], [tabindex]:not([tabindex="-1"])')]
                .filter((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
            if (!focusables.length) return;

            const first = focusables[0];
            const last = focusables[focusables.length - 1];

            if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });
}

/**
 * 由 app.js 在 DOMContentLoaded 里调用（此时 window.toaster 已就绪）。
 * 把 demo 的内联事件用到的同名函数挂到 window，HTML 结构保持 1:1。
 */
export function installAttachmentViewerModal() {
    state.overlay = document.getElementById('modal-overlay');
    state.modal = document.getElementById('modal-a');
    state.previewPane = document.getElementById('render-preview-a');
    state.textarea = document.getElementById('textarea-a');
    if (!state.overlay || !state.modal || !state.previewPane || !state.textarea) return false;

    Object.assign(window, {
        openAttachmentViewer,
        openActiveModal,
        closeModal,
        handleOverlayClick,
        setModeA,
        handleEditorInput,
        saveFileContent,
        copyFullContent,
        triggerToast,
        downloadActiveAttachment,
        syncContent,
        updateContentMetrics,
        setSaveState,
        renderMarkdown: renderMarkdownSafely,
    });

    installKeyHandlers();
    syncContent();
    renderMarkdownSafely(state.currentContent);
    updateContentMetrics();
    setSaveState('idle');
    return true;
}
