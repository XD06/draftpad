/**
 * 方案 A 附件浮层控制器：把 attachment-viewer-modal-demos.html 的交互逻辑接进 DumbPad。
 * 只替换 demo 的 5 个点（数据来源 / 保存动作 / toast / 下载·复制 / 挂载入口），
 * 其余 HTML 结构、class、状态机、字数统计、焦点与键盘行为全部照搬 demo。
 */
import { PreviewManager } from './preview.js';
import { getFileCategory } from './file-type-icons.js';
import { formatFileSize } from './article-file-command.js';
import {
    AssetApiClient,
    getAssetPreviewUrl,
    getAssetOriginalUrl,
    getAssetDownloadUrl,
} from './asset-api-client.js';

const OVERLAY_KEY = 'dumbpad_attachment_overlay_v1';
const CONFLICT_MESSAGE = '内容已在其他设备更新，请刷新后再保存或复制当前内容';

const state = {
    overlay: null,
    modal: null,
    previewPane: null,
    textarea: null,
    attachment: null,
    baseId: '',
    overlayAtOpen: '',
    currentContent: '',
    loadedBaseline: null,
    lastSavedContent: null,
    lastFocused: null,
    saving: false,
    loadToken: 0,
};

const assetApi = new AssetApiClient();
let markedLoader = null;
let sanitizerLoader = null;

/* ------------------------------------------------------------------
   数据来源：把三个入口传来的附件对象归一成同一形态。
   ------------------------------------------------------------------ */
function normalizeAttachment(raw = {}) {
    const previewUrl = getAssetPreviewUrl(raw) || '';
    const originalUrl = getAssetOriginalUrl(raw) || '';
    const downloadUrl = getAssetDownloadUrl(raw) || '';
    const id = String(raw.assetId || raw.id || '').trim();
    return {
        id,
        name: String(raw.name || '未命名附件'),
        type: String(raw.type || ''),
        size: Number(raw.size || 0),
        previewUrl,
        originalUrl,
        downloadUrl,
        dataUrl: String(raw.dataUrl || ''),
    };
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

function readOverlay() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(OVERLAY_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeOverlay(assetId, descriptor) {
    if (!assetId) return;
    try {
        const map = readOverlay();
        map[assetId] = descriptor;
        window.localStorage.setItem(OVERLAY_KEY, JSON.stringify(map));
    } catch {
        /* 隐私模式下 localStorage 不可用：保存仍已落到服务端，只是下次打开不追新资产 */
    }
}

function overlaySnapshot(assetId) {
    const entry = readOverlay()[assetId];
    return entry ? JSON.stringify(entry) : '';
}

async function readAttachmentContent(att) {
    const url = resolveReadUrl(att);
    if (!url) throw new Error('附件地址不可用，无法读取内容');
    const response = await window.fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`附件读取失败（HTTP ${response.status}）`);
    return await response.text();
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
   保存动作：真实写入服务端。
   routes/asset-routes.js 没有内容更新端点（硬约束 7 禁止改后端），
   因此复用现成的 POST /api/assets/files 上传端点把编辑后的字节存成真实资产；
   资产没有 version 字段，所以 409 冲突用「打开时的快照 vs 保存时的快照」
   做等价判定，行为复用 app.js:3044-3101 的冲突分支（error toast + 保留输入）。
   ------------------------------------------------------------------ */
async function saveFileContent() {
    if (!state.attachment || state.saving) return;
    const text = state.textarea ? state.textarea.value : state.currentContent;
    state.currentContent = text;
    state.saving = true;
    try {
        // app.js:2977-2980 同款离线守卫：断网必须响亮失败且不清空 textarea
        if (!window.navigator.onLine) throw new Error('网络已断开，保存失败，内容已保留');

        // 409 等价冲突：另一个标签页 / 设备已经改写过同一附件
        if (overlaySnapshot(state.baseId) !== state.overlayAtOpen) {
            window.toaster?.show?.(CONFLICT_MESSAGE, 'error', true, 6000);
            setSaveState('dirty');
            return;
        }

        const file = new File([text], state.attachment.name || 'attachment.md', {
            type: state.attachment.type || 'text/markdown',
        });
        const saved = await assetApi.uploadFile(file);
        const next = normalizeAttachment({ ...state.attachment, ...saved });

        writeOverlay(state.baseId, {
            id: String(saved.assetId || saved.id || ''),
            name: next.name,
            type: next.type,
            size: next.size,
            previewUrl: next.previewUrl,
            originalUrl: next.originalUrl,
            downloadUrl: next.downloadUrl,
        });

        state.attachment = next;
        state.loadedBaseline = text;
        state.lastSavedContent = text;
        state.overlayAtOpen = overlaySnapshot(state.baseId);
        fillFileMeta(next);
        renderMarkdownSafely(text);
        syncContent();
        setSaveState('saved');
        triggerToast('附件修改已成功保存至服务端！', 'success');
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
    if (!base.id && !resolveReadUrl(base)) {
        triggerToast('附件信息不完整，无法打开', 'error');
        return;
    }

    const saved = readOverlay()[base.id] || null;
    const active = saved ? normalizeAttachment({ ...base, ...saved }) : base;
    state.attachment = active;
    state.baseId = base.id;
    state.overlayAtOpen = overlaySnapshot(base.id);
    state.lastFocused = trigger || document.activeElement;

    fillFileMeta(active);
    setModeA('preview');
    openActiveModal();
    // openActiveModal 会把 lastFocused 设为当前 activeElement，用入口覆盖回来
    lastFocused = state.lastFocused;

    const token = ++state.loadToken;
    try {
        const text = await readAttachmentContent(active);
        if (token !== state.loadToken || !state.overlay.classList.contains('open')) return;
        state.currentContent = text;
        state.loadedBaseline = text;
        state.lastSavedContent = text;
        syncContent();
        renderMarkdownSafely(text);
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
