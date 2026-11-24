/**
 * 轻提示（toast）管理器：一条一条堆在页面底部的胶囊卡片，支持 success /
 * error / info 三种语气。视觉是「玻璃卡片 + 类型色圆形图标 + 文案」，颜色全部
 * 走主题 token（styles.css 的 .toast 一节）。图标是纯装饰（aria-hidden），
 * 文案留在 .toast-text 里——既保证 textContent 仍是纯文本（既有回归与
 * 复制/朗读都依赖它），也让读屏只读一遍消息。
 */

// 类型 → 图标（24 viewBox、stroke 白色，落在类型色圆底上）。
const TOAST_ICONS = {
    success: '<path d="M20 6 9 17l-5-5"></path>',
    error: '<path d="M12 7v6"></path><path d="M12 16.6h.01"></path>',
    info: '<path d="M12 11v6"></path><path d="M12 7.4h.01"></path>',
};

export class ToastManager {
  constructor(containerElement) {
    this.container = containerElement;
    this.isError = 'error';
    this.isSuccess = 'success';
    this.maxTransientToasts = 3;
    this._timers = new WeakMap();
    this._clickHandlers = new WeakMap();
  }

  /** 类型 → 'success' | 'error' | 'info'（未知类型按 info 处理，与旧行为一致）。 */
  normalizeType(type) {
    if (type === this.isSuccess) return 'success';
    if (type === this.isError) return 'error';
    return 'info';
  }

  buildToast(message, type) {
    const toast = document.createElement('div');
    toast.classList.add('toast', type);

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[type] || TOAST_ICONS.info}</svg>`;

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;

    toast.append(icon, text);
    return toast;
  }

  _clearToastTimers(toast) {
    const entry = this._timers.get(toast);
    if (!entry) return;
    if (entry.showTimer) clearTimeout(entry.showTimer);
    if (entry.fadeTimer) clearTimeout(entry.fadeTimer);
    if (entry.removeTimer) clearTimeout(entry.removeTimer);
    this._timers.delete(toast);
  }

  _scheduleTransientDismiss(toast, timeoutMs) {
    this._clearToastTimers(toast);
    const entry = {
      fadeTimer: setTimeout(() => {
        this.hide(toast);
      }, timeoutMs),
    };
    this._timers.set(toast, entry);
  }

  _findMatchingToast(message, normalizedType) {
    if (!this.container?.children) return null;
    const text = String(message ?? '');
    for (const child of Array.from(this.container.children)) {
      if (!child?.classList?.contains('toast')) continue;
      if (!child.classList.contains(normalizedType)) continue;
      if (child.dataset.toastDismissing === 'true') continue;
      if ((child.querySelector('.toast-text')?.textContent ?? child.textContent) === text) {
        return child;
      }
    }
    return null;
  }

  show(message, type = 'success', isStatic = false, timeoutMs = 1000, onClick = null) {
    // isStatic toasts persist until clicked (e.g. the PWA "new version
    // available" notice) and must bypass the timeoutMs guard — otherwise
    // timeoutMs=0 (intended as "no auto-dismiss") is rejected here and the
    // toast never appears, so users never get the update notification.
    if (!isStatic && (!timeoutMs || timeoutMs < 1)) return;
    if (!this.container) return;

    const normalizedType = this.normalizeType(type);
    const existing = this._findMatchingToast(message, normalizedType);
    if (existing) {
      this._clickHandlers.set(existing, typeof onClick === 'function' ? onClick : null);
      existing.style.cursor = typeof onClick === 'function' ? 'pointer' : 'default';
      if (isStatic) {
        this._clearToastTimers(existing);
        existing.dataset.toastStatic = 'true';
      } else if (existing.dataset.toastStatic !== 'true') {
        this._scheduleTransientDismiss(existing, timeoutMs);
      }
      if (!existing.classList.contains('show')) {
        const current = this._timers.get(existing) || {};
        current.showTimer = setTimeout(() => {
          if (existing.dataset.toastDismissing !== 'true') existing.classList.add('show');
        }, 10);
        this._timers.set(existing, current);
      }
      return existing;
    }

    if (!isStatic) {
      const transient = Array.from(this.container.children).filter(
        el => el?.classList?.contains('toast') && el.dataset.toastStatic !== 'true' && el.dataset.toastDismissing !== 'true'
      );
      while (transient.length >= this.maxTransientToasts) {
        const oldest = transient.shift();
        this._clearToastTimers(oldest);
        if (oldest.parentNode === this.container) this.container.removeChild(oldest);
      }
    }

    const toast = this.buildToast(message, normalizedType);
    if (isStatic) toast.dataset.toastStatic = 'true';
    this._clickHandlers.set(toast, typeof onClick === 'function' ? onClick : null);

    this.container.appendChild(toast);

    const entry = {
      showTimer: setTimeout(() => {
        const handler = this._clickHandlers.get(toast);
        if (handler) {
          toast.style.cursor = 'pointer';
        }
        toast.addEventListener('click', () => {
          const currentHandler = this._clickHandlers.get(toast);
          this.hide(toast);
          if (currentHandler) currentHandler();
        }, { once: true });
        if (toast.dataset.toastDismissing !== 'true') {
          toast.classList.add('show');
        }
      }, 10),
    };

    if (!isStatic) {
      entry.fadeTimer = setTimeout(() => {
        this.hide(toast);
      }, timeoutMs);
    }
    this._timers.set(toast, entry);
    return toast;
  }

  hide(toast) {
    if (!toast) return;
    toast.dataset.toastDismissing = 'true';
    this._clearToastTimers(toast);
    toast.classList.remove('show');
    const removeTimer = setTimeout(() => {
      if (toast.parentNode === this.container) {
        this.container.removeChild(toast);
      }
    }, 300);
    this._timers.set(toast, { removeTimer });
  }

  clear() {
    // use to clear static toast messages
    if (!this.container) return;
    for (const child of Array.from(this.container.children)) {
      this._clearToastTimers(child);
    }
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
  }
}
