export class ToastManager {
  constructor(containerElement) {
    this.container = containerElement;
    this.isError = 'error';
    this.isSuccess = 'success';
  }

  show(message, type = 'success', isStatic = false, timeoutMs = 1000, onClick = null) {
    // isStatic toasts persist until clicked (e.g. the PWA "new version
    // available" notice) and must bypass the timeoutMs guard — otherwise
    // timeoutMs=0 (intended as "no auto-dismiss") is rejected here and the
    // toast never appears, so users never get the update notification.
    if (!isStatic && (!timeoutMs || timeoutMs < 1)) return;

    const toast = document.createElement('div');
    toast.classList.add('toast');
    toast.textContent = message;

    if (type === this.isSuccess) toast.classList.add('success');
    else if (type === 'info') toast.classList.add('info');
    else toast.classList.add('error');

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