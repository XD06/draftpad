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

  show(message, type = 'success', isStatic = false, timeoutMs = 1000, onClick = null) {
    // isStatic toasts persist until clicked (e.g. the PWA "new version
    // available" notice) and must bypass the timeoutMs guard — otherwise
    // timeoutMs=0 (intended as "no auto-dismiss") is rejected here and the
    // toast never appears, so users never get the update notification.
    if (!isStatic && (!timeoutMs || timeoutMs < 1)) return;

    const toast = this.buildToast(message, this.normalizeType(type));

    this.container.appendChild(toast);

    setTimeout(() => {
      if (onClick) {
        toast.style.cursor = 'pointer';
        toast.addEventListener('click', () => {
          this.hide(toast);
          onClick();
        });
      } else {
        toast.addEventListener('click', () => this.hide(toast));
      }
      toast.classList.add('show');
    }, 10);

    if (!isStatic) {
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
          this.hide(toast);
        }, 300);
      }, timeoutMs);
    }
    return toast;
  }

  hide(toast) {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentNode === this.container) {
        this.container.removeChild(toast);
      }
    }, 300);
  }

  clear() {
    // use to clear static toast messages
    if (!this.container) return;
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
  }
}
