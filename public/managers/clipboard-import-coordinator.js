export class ClipboardImportCoordinator {
    constructor({ registry, toaster } = {}) {
        this.registry = registry;
        this.toaster = toaster;
        this.dialog = document.getElementById('clipboard-import-dialog');
        this.textarea = document.getElementById('clipboard-import-text');
        this.status = document.getElementById('clipboard-import-status');
        this.confirmButton = document.getElementById('clipboard-import-confirm');
        this.selectedTargetId = 'article';
        this.previousFocus = null;
        this.bindEvents();
    }

    bindEvents() {
        document.getElementById('clipboard-import-trigger')?.addEventListener('click', () => this.open({ readClipboard: true }));
        this.dialog?.querySelector('[data-clipboard-import-close]')?.addEventListener('click', () => this.close());
        this.dialog?.querySelector('[data-clipboard-import-retry]')?.addEventListener('click', () => this.readClipboard());
        this.dialog?.querySelector('[data-clipboard-import-cancel]')?.addEventListener('click', () => this.close());
        this.dialog?.addEventListener('click', event => {
            if (event.target === this.dialog) this.close();
            const target = event.target.closest('[data-import-target]');
            if (target) this.selectTarget(target.dataset.importTarget);
        });
        this.confirmButton?.addEventListener('click', () => this.commit());
        document.addEventListener('keydown', event => {
            if (!this.isOpen()) return;
            if (event.key === 'Escape') this.close();
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                this.commit();
            }
        });
    }

    isOpen() {
        return Boolean(this.dialog && !this.dialog.hidden);
    }

    open({ readClipboard = false } = {}) {
        if (!this.dialog) return;
        this.previousFocus = document.activeElement;
        this.dialog.hidden = false;
        document.body.classList.add('clipboard-import-open');
        this.selectTarget(this.selectedTargetId);
        this.setStatus('可编辑内容后，选择要保存的位置。');
        requestAnimationFrame(() => this.textarea?.focus());
        if (readClipboard) this.readClipboard();
    }

    close() {
        if (!this.dialog) return;
        this.dialog.hidden = true;
        document.body.classList.remove('clipboard-import-open');
        this.previousFocus?.focus?.();
        this.previousFocus = null;
    }

    selectTarget(id) {
        const target = this.registry?.get(id) || this.registry?.list()?.[0];
        if (!target) return;
        this.selectedTargetId = target.id;
        this.dialog?.querySelectorAll('[data-import-target]').forEach(button => {
            const selected = button.dataset.importTarget === target.id;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        if (this.confirmButton) this.confirmButton.textContent = target.confirmLabel || '保存';
    }

    setStatus(message, { error = false } = {}) {
        if (!this.status) return;
        this.status.textContent = message;
        this.status.classList.toggle('is-error', error);
    }

    async readClipboard() {
        if (!navigator.clipboard?.readText) {
            this.setStatus('此设备不支持直接读取，请在文本框中粘贴内容。', { error: true });
            return;
        }
        this.setStatus('正在读取剪贴板…');
        try {
            const text = await navigator.clipboard.readText();
            if (text) this.textarea.value = text;
            this.setStatus(text
                ? '已读取剪贴板内容，可继续编辑。'
                : this.textarea?.value.trim()
                    ? '已保留当前内容，可继续编辑。'
                    : '剪贴板没有文本，可直接输入或粘贴。');
        } catch (error) {
            this.setStatus('未取得剪贴板权限，可点击重试或直接粘贴。', { error: true });
            console.info('Clipboard import unavailable:', error?.message || error);
        }
    }

    async commit() {
        const text = this.textarea?.value?.trim() || '';
        if (!text) {
            this.setStatus('先输入或粘贴一点内容。', { error: true });
            this.textarea?.focus();
            return;
        }
        if (!this.registry?.get(this.selectedTargetId)) {
            this.setStatus('请选择保存位置。', { error: true });
            return;
        }

        if (this.confirmButton) this.confirmButton.disabled = true;
        try {
            await this.registry.importText(this.selectedTargetId, text);
            this.textarea.value = '';
            this.close();
        } catch (error) {
            console.error('Clipboard import failed:', error);
            this.setStatus(error?.message || '保存失败，请重试。', { error: true });
            this.toaster?.show?.(error?.message || '保存失败', 'error', false, 2600);
        } finally {
            if (this.confirmButton) this.confirmButton.disabled = false;
        }
    }
}
