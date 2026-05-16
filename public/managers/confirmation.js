export default class ConfirmationManager {
  constructor() {
    this.modal = null;
    this.init();
  }

  init() {
    // Create modal structure if it doesn't exist
    if (document.getElementById('universal-confirmation-modal')) return;

    const modalHtml = `
      <div id="universal-confirmation-modal" class="modal confirmation-modal-overlay">
        <div class="confirmation-dialog">
          <div class="confirmation-body">
            <div class="confirmation-icon-wrapper">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
            </div>
            <div class="confirmation-text">
              <h3 id="confirmation-title">确认删除</h3>
              <p id="confirmation-message">确定要永久删除这条灵感记录吗？此操作无法撤销。</p>
            </div>
          </div>
          <div class="confirmation-actions">
            <button id="confirmation-cancel" class="conf-btn-secondary">取消</button>
            <button id="confirmation-confirm" class="conf-btn-danger">确定删除</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    this.modal = document.getElementById('universal-confirmation-modal');
  }

  async show(options) {
    // Handle legacy call: show(message, onConfirm, onCancel)
    let message = '';
    let title = '确认操作';
    let confirmText = '确定';
    let cancelText = '取消';
    let type = 'danger';

    if (typeof options === 'string') {
        message = options;
    } else {
        message = options.message || '';
        title = options.title || title;
        confirmText = options.confirmText || confirmText;
        cancelText = options.cancelText || cancelText;
        type = options.confirmType || type;
    }

    const titleEl = document.getElementById('confirmation-title');
    const messageEl = document.getElementById('confirmation-message');
    const confirmBtn = document.getElementById('confirmation-confirm');
    const cancelBtn = document.getElementById('confirmation-cancel');

    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    // Set button style based on type
    confirmBtn.className = type === 'danger' ? 'danger-btn' : 'primary-btn';

    this.modal.classList.add('visible');

    return new Promise((resolve) => {
      const handleConfirm = () => {
        this.close();
        cleanup();
        resolve(true);
      };

      const handleCancel = () => {
        this.close();
        cleanup();
        resolve(false);
      };

      const cleanup = () => {
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
        this.modal.removeEventListener('click', handleBackdropClick);
      };

      const handleBackdropClick = (e) => {
        if (e.target === this.modal) handleCancel();
      };

      confirmBtn.addEventListener('click', handleConfirm);
      cancelBtn.addEventListener('click', handleCancel);
      this.modal.addEventListener('click', handleBackdropClick);
    });
  }

  close() {
    this.modal.classList.remove('visible');
  }
}