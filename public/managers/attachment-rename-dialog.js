/**
 * 轻量附件重命名组件（无遮罩锚点微气泡，零布局位移）：
 * 所有入口（文章内胶囊/图片/媒体卡、设置附件列表、方案 A / 原生 PDF 浮层顶栏、
 * Thought 编辑态附件行）统一在触发锚点旁展开轻量微气泡，默认与标题左侧起始处对齐，
 * 不修改原卡片/顶栏 DOM 尺寸，避免周围按钮与列表项发生位移。
 */
const TEXT_COMPAT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv'];
const POPOVER_MARGIN = 10;

let popoverEl = null;
let activePopoverSession = null;

function splitFilenameParts(name = '') {
    const value = String(name || '');
    const dot = value.lastIndexOf('.');
    if (dot <= 0 || dot === value.length - 1) return { stem: value, ext: '' };
    return { stem: value.slice(0, dot), ext: value.slice(dot + 1) };
}

function resolveCompatibleExtensions(ext = '', kind = 'file', mimeType = '') {
    const extLower = String(ext || '').trim().toLowerCase();
    const mimeLower = String(mimeType || '').trim().toLowerCase().split(';', 1)[0];
    if (kind !== 'file') {
        if (extLower === 'jpg' || extLower === 'jpeg') {
            return extLower === 'jpg' ? ['jpg', 'jpeg'] : ['jpeg', 'jpg'];
        }
        return null;
    }
    if (TEXT_COMPAT_EXTENSIONS.includes(extLower) || mimeLower.startsWith('text/')) {
        return extLower
            ? [extLower, ...TEXT_COMPAT_EXTENSIONS.filter(item => item !== extLower)]
            : [...TEXT_COMPAT_EXTENSIONS];
    }
    return null;
}

function assembleFinalFilename(rawInput, activeExt, compatibleExts) {
    const clean = String(rawInput || '').trim();
    if (!clean) return '';
    if (!activeExt) return clean;
    const lower = clean.toLowerCase();
    const activeLower = activeExt.toLowerCase();
    if (lower.endsWith(`.${activeLower}`) && clean.length > activeLower.length + 1) {
        return clean;
    }
    if (Array.isArray(compatibleExts)) {
        const matched = compatibleExts.find(candidate => (
            lower.endsWith(`.${candidate}`) && clean.length > candidate.length + 1
        ));
        if (matched) return clean;
    }
    return `${clean}.${activeExt}`;
}

function buildRenameFieldState({
    currentName = '',
    kind = 'file',
    mimeType = '',
    showSyncOption = false,
    defaultSync = true,
}) {
    const safeCurrent = String(currentName || '').trim() || '未命名附件';
    const { stem, ext } = splitFilenameParts(safeCurrent);
    const compatibleExts = resolveCompatibleExtensions(ext, kind, mimeType);
    let activeExt = ext;
    let syncChecked = Boolean(defaultSync);

    const row = document.createElement('div');
    row.className = 'dumbpad-inline-rename-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dumbpad-inline-rename-input';
    input.value = stem;
    input.placeholder = '输入新名称';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', '附件新名称');
    row.appendChild(input);

    if (activeExt) {
        const extBtn = document.createElement('button');
        extBtn.type = 'button';
        extBtn.className = 'dumbpad-inline-ext-chip';
        const paintExt = () => {
            extBtn.textContent = compatibleExts ? `.${activeExt} ⇄` : `.${activeExt}`;
            extBtn.classList.toggle('is-switchable', Boolean(compatibleExts));
            extBtn.title = compatibleExts
                ? `点击在兼容后缀 (${compatibleExts.join(' / ')}) 间切换`
                : `格式 .${activeExt} 已锁定，输入主文件名即可`;
        };
        paintExt();
        extBtn.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        extBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!compatibleExts) {
                setInfoTip(`已锁定 .${activeExt} 格式，仅改主干即可`);
                input.focus({ preventScroll: true });
                return;
            }
            const idx = compatibleExts.indexOf(activeExt.toLowerCase());
            activeExt = compatibleExts[(idx + 1) % compatibleExts.length];
            paintExt();
            input.focus({ preventScroll: true });
        });
        row.appendChild(extBtn);
    }

    let syncBtn = null;
    if (showSyncOption) {
        syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.className = 'dumbpad-inline-sync-chip';
        const paintSync = () => {
            syncBtn.classList.toggle('is-on', syncChecked);
            syncBtn.setAttribute('aria-pressed', syncChecked ? 'true' : 'false');
            syncBtn.textContent = syncChecked ? '● 同步全站原名' : '○ 仅改此处';
            syncBtn.title = syncChecked
                ? '同步修改服务端原文件名与所有文档引用'
                : '仅修改当前显示名称，不改服务端原名';
        };
        paintSync();
        syncBtn.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        syncBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            syncChecked = !syncChecked;
            paintSync();
            input.focus({ preventScroll: true });
        });
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'dumbpad-inline-rename-msg';
    messageEl.setAttribute('role', 'alert');
    messageEl.hidden = true;

    const setError = (text) => {
        row.classList.add('is-error');
        messageEl.classList.remove('is-tip');
        messageEl.textContent = text || '';
        messageEl.hidden = !text;
    };

    const setInfoTip = (text) => {
        row.classList.remove('is-error');
        messageEl.classList.add('is-tip');
        messageEl.textContent = text || '';
        messageEl.hidden = !text;
    };

    const clearMessage = () => {
        row.classList.remove('is-error');
        messageEl.classList.remove('is-tip');
        messageEl.textContent = '';
        messageEl.hidden = true;
    };

    input.addEventListener('input', clearMessage);

    return {
        row,
        input,
        syncBtn,
        messageEl,
        getName: () => assembleFinalFilename(input.value, activeExt, compatibleExts),
        getSync: () => (showSyncOption ? syncChecked : defaultSync),
        setError,
        setInfoTip,
        clearMessage,
        focusAndSelect() {
            input.focus({ preventScroll: true });
            try {
                input.select();
            } catch (_err) {
                // ignore selection errors in detached hosts
            }
        },
    };
}

export function closeActiveAttachmentRename() {
    if (activePopoverSession) {
        activePopoverSession.cancel();
    }
}

function getViewportBounds() {
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
}

function positionPopoverNearAnchor(popover, anchorEl, fallbackRect, align = 'start') {
    const rect = anchorEl?.isConnected
        ? anchorEl.getBoundingClientRect()
        : (fallbackRect || { left: 24, top: 80, right: 160, bottom: 112, width: 136, height: 32 });
    const bounds = getViewportBounds();
    const popWidth = popover.offsetWidth || 296;
    const popHeight = popover.offsetHeight || 132;

    let left = align === 'center'
        ? ((rect.left + rect.right) / 2) - popWidth / 2
        : rect.left;
    left = Math.max(bounds.left + POPOVER_MARGIN, Math.min(bounds.right - popWidth - POPOVER_MARGIN, left));

    let top = rect.bottom + 8;
    if (top + popHeight > bounds.bottom - POPOVER_MARGIN) {
        const aboveTop = rect.top - popHeight - 8;
        if (aboveTop >= bounds.top + POPOVER_MARGIN || (rect.top - bounds.top) > (bounds.bottom - rect.bottom)) {
            top = Math.max(bounds.top + POPOVER_MARGIN, aboveTop);
        } else {
            top = Math.max(bounds.top + POPOVER_MARGIN, bounds.bottom - popHeight - POPOVER_MARGIN);
        }
    }
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
}

/**
 * 统一的无遮罩锚点重命名微气泡：紧贴触发按钮或元素浮出，
 * 默认与标题起始处左对齐，原有卡片与顶栏 DOM 一像素不改、零位移。
 */
export function openAttachmentRenamePopover({
    anchorEl = null,
    anchorRect = null,
    align = 'start',
    currentName = '',
    kind = 'file',
    mimeType = '',
    title = '重命名附件',
    hint = 'Enter 保存 · Esc 取消',
    showSyncOption = true,
    defaultSync = true,
    trigger = null,
    onConfirm,
} = {}) {
    closeActiveAttachmentRename();

    if (!popoverEl || !document.body.contains(popoverEl)) {
        popoverEl = document.createElement('div');
        popoverEl.id = 'attachment-rename-popover';
        popoverEl.className = 'dumbpad-rename-popover';
        popoverEl.setAttribute('role', 'dialog');
        popoverEl.setAttribute('aria-modal', 'false');
        popoverEl.hidden = true;
        document.body.appendChild(popoverEl);
    }

    const focusBackTarget = trigger || anchorEl || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const snapshotRect = anchorRect || (anchorEl?.isConnected ? anchorEl.getBoundingClientRect() : null);

    popoverEl.replaceChildren();
    popoverEl.hidden = false;

    const head = document.createElement('div');
    head.className = 'dumbpad-rename-popover-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'dumbpad-rename-popover-title';
    titleEl.textContent = title;
    head.appendChild(titleEl);

    const fields = buildRenameFieldState({
        currentName,
        kind,
        mimeType,
        showSyncOption,
        defaultSync,
    });
    if (fields.syncBtn) {
        head.appendChild(fields.syncBtn);
    }

    const foot = document.createElement('div');
    foot.className = 'dumbpad-rename-popover-foot';
    const shortcutHint = document.createElement('span');
    shortcutHint.className = 'dumbpad-rename-popover-hint';
    shortcutHint.textContent = hint;

    const btnGroup = document.createElement('div');
    btnGroup.className = 'dumbpad-rename-popover-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'dumbpad-rename-popover-btn';
    cancelBtn.textContent = '取消';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'dumbpad-rename-popover-btn is-primary';
    saveBtn.textContent = '保存';
    btnGroup.append(cancelBtn, saveBtn);
    foot.append(shortcutHint, btnGroup);

    popoverEl.append(head, fields.row, fields.messageEl, foot);
    positionPopoverNearAnchor(popoverEl, anchorEl, snapshotRect, align);

    let settled = false;
    let submitting = false;
    let isComposing = false;
    let resolvePopover = () => {};

    const handleReposition = () => {
        if (settled || popoverEl.hidden) return;
        positionPopoverNearAnchor(popoverEl, anchorEl, snapshotRect, align);
    };

    const cleanup = (restoreFocus = false) => {
        document.removeEventListener('mousedown', handleOutsidePointer, true);
        document.removeEventListener('touchstart', handleOutsidePointer, true);
        document.removeEventListener('keydown', handleCaptureEscape, true);
        window.removeEventListener('resize', handleReposition);
        window.removeEventListener('scroll', handleReposition, true);
        window.visualViewport?.removeEventListener('resize', handleReposition);
        window.visualViewport?.removeEventListener('scroll', handleReposition);
        if (popoverEl) {
            popoverEl.hidden = true;
            popoverEl.replaceChildren();
        }
        if (activePopoverSession?.popover === popoverEl) {
            activePopoverSession = null;
        }
        if (restoreFocus && focusBackTarget && document.contains(focusBackTarget)) {
            try {
                focusBackTarget.focus({ preventScroll: true });
            } catch (_err) {
                // ignore focus restoration errors
            }
        }
    };

    const cancel = ({ restoreFocus = true } = {}) => {
        if (settled) return;
        settled = true;
        cleanup(restoreFocus);
        resolvePopover(null);
    };

    const handleOutsidePointer = (event) => {
        if (settled || popoverEl.hidden) return;
        if (popoverEl.contains(event.target)) return;
        cancel({ restoreFocus: false });
    };

    // 捕获阶段截停 Escape，避免打开弹窗之上时的 Esc 顺便关掉下方的方案 A/设置/PDF 浮层。
    const handleCaptureEscape = (event) => {
        if (settled || popoverEl.hidden || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        cancel({ restoreFocus: true });
    };

    return new Promise((resolve) => {
        resolvePopover = resolve;

        const submit = async () => {
            if (settled || submitting) return;
            const nextName = fields.getName();
            if (!nextName) {
                fields.setError('附件名称不能为空');
                fields.focusAndSelect();
                return;
            }
            const syncReferences = fields.getSync();
            fields.clearMessage();
            submitting = true;
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中…';
            cancelBtn.disabled = true;
            fields.input.disabled = true;
            try {
                const outcome = typeof onConfirm === 'function'
                    ? await onConfirm({ name: nextName, syncReferences })
                    : { name: nextName, syncReferences };
                if (settled) return;
                settled = true;
                cleanup(false);
                resolve(outcome || { name: nextName, syncReferences });
            } catch (error) {
                if (settled) return;
                submitting = false;
                saveBtn.disabled = false;
                saveBtn.textContent = '保存';
                cancelBtn.disabled = false;
                fields.input.disabled = false;
                fields.setError(error?.message || '重命名失败，请重试');
                fields.focusAndSelect();
            }
        };

        activePopoverSession = { popover: popoverEl, cancel };

        document.addEventListener('mousedown', handleOutsidePointer, true);
        document.addEventListener('touchstart', handleOutsidePointer, true);
        document.addEventListener('keydown', handleCaptureEscape, true);
        window.addEventListener('resize', handleReposition);
        window.addEventListener('scroll', handleReposition, true);
        window.visualViewport?.addEventListener('resize', handleReposition);
        window.visualViewport?.addEventListener('scroll', handleReposition);

        cancelBtn.addEventListener('click', (event) => {
            event.preventDefault();
            cancel({ restoreFocus: true });
        });
        saveBtn.addEventListener('click', (event) => {
            event.preventDefault();
            submit();
        });
        fields.input.addEventListener('compositionstart', () => { isComposing = true; });
        fields.input.addEventListener('compositionend', () => { isComposing = false; });
        fields.input.addEventListener('keydown', (event) => {
            if (isComposing || event.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                submit();
            }
        });

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (!settled) fields.focusAndSelect();
            });
        } else {
            fields.focusAndSelect();
        }
    });
}
