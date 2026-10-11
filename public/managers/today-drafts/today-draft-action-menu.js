/**
 * 即时草稿的行操作菜单：长按/右键草稿行后浮出的横向图标条（iOS 风格玻璃材质）。
 * 只负责定位、开合、点外关闭与图标渲染；具体动作通过 onSelect(id) 交给 manager，
 * 本模块不接触草稿数据，也不依赖 DOM 之外的状态。
 *
 * 图标来自 iCloud 风格 iconfont 精灵（1024 网格、fill:currentColor），随主题换色。
 * 菜单挂在 document.body（position:fixed 相对视口），不挂在纸张里——纸张有
 * overflow:hidden，靠近顶部的行上方浮出会被裁掉。
 */

// 可选动作目录：icon 指向下方 sprite 的 symbol id，danger 走警示色。
export const DRAFT_MENU_ACTIONS = Object.freeze({
    copy: { icon: 'tdam-copy', label: '复制全文' },
    thought: { icon: 'tdam-idea', label: '转为 Thought' },
    article: { icon: 'tdam-note', label: '转为文章' },
    today: { icon: 'tdam-plus', label: '加入今日' },
    plan: { icon: 'tdam-plan', label: '计划' },
    delete: { icon: 'tdam-delete', label: '删除', danger: true }
});

// 图标精灵全局一份；<use> 引用同文档内的 symbol。
const SPRITE_HTML = `<svg class="tdam-sprite" aria-hidden="true" focusable="false"><defs>
<symbol id="tdam-note" viewBox="0 0 1024 1024"><g transform="translate(-88.00 -88.02) scale(1.171902)"><path d="M885.674667 135.125333c12.373333 10.581333 13.824 29.269333 3.2 41.642667L676.266667 424.874667a29.525333 29.525333 0 1 1-44.842667-38.442667l212.650667-248.106667a29.525333 29.525333 0 0 1 41.642666-3.2z"></path><path d="M236.288 163.413333A108.288 108.288 0 0 0 128 271.658667v516.010666A108.288 108.288 0 0 0 236.288 896h480.426667a108.288 108.288 0 0 0 108.373333-108.288V405.674667a29.525333 29.525333 0 1 0-59.093333 0v382.037333c0 27.178667-22.058667 49.194667-49.237334 49.194667H236.330667a49.237333 49.237333 0 0 1-49.237334-49.194667V271.701333c0-27.221333 22.016-49.237333 49.194667-49.237333h435.2a29.525333 29.525333 0 1 0 0-59.093333h-435.2z"></path><path d="M305.237333 334.762667a29.525333 29.525333 0 0 0 0 59.093333h153.6a29.525333 29.525333 0 0 0 0-59.093333h-153.6zM275.669333 521.813333c0-16.298667 13.226667-29.525333 29.568-29.525333h189.013334a29.525333 29.525333 0 0 1 0 59.093333h-189.013334a29.525333 29.525333 0 0 1-29.568-29.568zM305.237333 649.813333a29.525333 29.525333 0 1 0 0 59.093334h334.72a29.525333 29.525333 0 1 0 0-59.093334H305.237333z"></path></g></symbol>
<symbol id="tdam-copy" viewBox="0 0 1024 1024"><g transform="translate(16.59 16.59) scale(0.967603)"><path d="M640 46.933333a166.4 166.4 0 0 1 166.4 166.4v4.266667h4.266667a166.4 166.4 0 0 1 166.314666 161.109333L977.066667 384v426.666667a166.4 166.4 0 0 1-161.109334 166.314666L810.666667 977.066667H384a166.4 166.4 0 0 1-166.314667-161.109334L217.6 810.666667v-4.266667H213.333333a166.4 166.4 0 0 1-166.314666-161.109333L46.933333 640V213.333333A166.4 166.4 0 0 1 213.333333 46.933333zM806.4 640a166.4 166.4 0 0 1-166.4 166.4H294.4v4.266667a89.6 89.6 0 0 0 85.12 89.493333l4.48 0.106667h426.666667a89.6 89.6 0 0 0 89.493333-85.12L900.266667 810.666667V384a89.6 89.6 0 0 0-85.12-89.493333L810.666667 294.4h-4.266667zM640 123.733333H213.333333A89.6 89.6 0 0 0 123.733333 213.333333v426.666667a89.6 89.6 0 0 0 89.6 89.6h426.666667a89.6 89.6 0 0 0 89.6-89.6V213.333333A89.6 89.6 0 0 0 640 123.733333z"></path></g></symbol>
<symbol id="tdam-idea" viewBox="0 0 1024 1024"><g transform="translate(-153.03 -146.15) scale(1.288900)"><path d="M515.96 625.88c-89.74 0-174.37-10.19-238.29-28.69-32.27-9.34-57.94-20.44-76.27-32.99-22.94-15.7-34.57-33.73-34.57-53.59s11.41-37.17 33.92-52.07c17.44-11.55 42.27-21.91 73.79-30.79 58.53-16.49 138.11-27.67 230.14-32.34 11.04-0.56 20.43 7.93 20.99 18.96 0.56 11.03-7.93 20.43-18.96 20.99-87.82 4.45-166.42 15.43-221.32 30.9-62.01 17.47-78.55 36.1-78.55 44.36s17.13 29.39 81.96 48.16c60.41 17.49 141.09 27.12 227.17 27.12 23.05 0 46.06-0.71 68.38-2.1 11.04-0.69 20.52 7.69 21.21 18.72 0.69 11.02-7.69 20.52-18.72 21.21-23.15 1.44-46.99 2.17-70.87 2.17zM663.09 614.81c-10.36 0-19.13-7.99-19.92-18.5-0.83-11.01 7.43-20.62 18.44-21.45 35.05-2.64 81.03-15.96 81.49-16.09 64.87-18.78 82-39.72 82-48.17 0-7.09-10.86-20.18-41.46-33.74-32.3-14.32-78.18-25.73-132.68-33-0.1-0.01-0.2-0.03-0.31-0.04-0.05 0-5.1-0.76-13.51-1.81-10.96-1.38-18.73-11.37-17.35-22.33 1.38-10.96 11.38-18.74 22.33-17.35 8.17 1.02 13.3 1.77 14.27 1.92 62.88 8.4 208.71 35.56 208.71 106.38 0 19.86-11.63 37.89-34.57 53.59-18.34 12.55-44 23.65-76.27 32.99-2.01 0.58-50.46 14.61-89.64 17.57-0.51 0.04-1.02 0.06-1.53 0.06z"></path><path d="M395.4 554.69c-2.92 0-5.89-0.64-8.69-2-9.94-4.81-14.11-16.77-9.3-26.71 8.57-17.73 17.9-35.73 27.72-53.53 5.34-9.67 17.5-13.18 27.18-7.84 9.67 5.34 13.18 17.51 7.84 27.18-9.48 17.16-18.47 34.53-26.73 51.6-3.45 7.14-10.59 11.3-18.02 11.3zM367.32 819.74c-9.45 0-18.1-2.25-25.93-6.77-34.01-19.64-38.76-75.29-13.71-160.93 3.1-10.6 14.21-16.68 24.81-13.58 10.6 3.1 16.68 14.21 13.58 24.81-21.61 73.92-14.64 109.31-4.68 115.06 6.56 3.78 24.57 0.33 53.77-21.88 30.57-23.25 65.32-60.58 100.49-107.97 6.58-8.87 19.11-10.72 27.98-4.14 8.87 6.58 10.72 19.11 4.14 27.98-37.39 50.37-74.87 90.47-108.39 115.97-27.54 20.94-51.66 31.45-72.05 31.45zM687.4 375.33c-1.76 0-3.54-0.23-5.32-0.72-10.65-2.93-16.91-13.94-13.98-24.59 20.39-74.08 10.5-102.47 2.43-107.13-10.21-5.89-45.2 6.33-99.75 64.16-7.58 8.04-20.24 8.41-28.27 0.83-8.04-7.58-8.4-20.24-0.83-28.27 62.84-66.62 114.31-91.29 148.85-71.35 32.79 18.93 38.37 71.62 16.14 152.39-2.44 8.87-10.49 14.7-19.27 14.7z"></path><path d="M664.77 819.65c-31.36 0-71.58-24.69-118.22-72.94-7.68-7.94-7.46-20.6 0.48-28.28 7.94-7.68 20.6-7.46 28.28 0.48 23.65 24.47 45.89 42.64 64.31 52.54 13.87 7.46 25.43 10.02 30.9 6.86 7.32-4.23 16.89-29.53 0.73-95.06-15.06-61.06-47.06-135.74-90.1-210.29-43.04-74.55-91.72-139.61-137.07-183.18-48.67-46.76-75.37-51.13-82.69-46.9-10.19 5.88-17.11 42.21 5.6 118.19 3.16 10.58-2.85 21.73-13.43 24.89-10.58 3.17-21.73-2.85-24.89-13.43-26.17-87.56-21.77-144.37 12.72-164.28 17.2-9.93 38.63-8.87 63.69 3.14 20.04 9.6 42.48 26.28 66.71 49.56 47.99 46.11 99.12 114.3 144 192.02 44.87 77.72 78.36 156.1 94.3 220.72 8.05 32.62 11.26 60.39 9.56 82.55-2.13 27.71-11.93 46.8-29.13 56.73-7.74 4.47-16.35 6.69-25.76 6.69z"></path></g></symbol>
<symbol id="tdam-delete" viewBox="0 0 1024 1024"><g transform="translate(59.44 62.00) scale(0.883922)"><path d="M519.620465 0c-103.924093 0-188.511256 82.467721-192.083349 185.820279H85.015814A48.91386 48.91386 0 0 0 36.101953 234.686512a48.91386 48.91386 0 0 0 48.913861 48.866232h54.010046V831.345116c0 102.852465 69.822512 186.844279 155.909954 186.844279h439.200744c86.087442 0 155.909953-83.491721 155.909954-186.844279V284.100465h48.91386a48.91386 48.91386 0 0 0 48.913861-48.890046 48.91386 48.91386 0 0 0-48.913861-48.866233h-227.756651A191.559442 191.559442 0 0 0 519.620465 0z m-107.234232 177.080558c3.548279-49.771163 46.627721-88.540279 99.851907-88.540279 53.224186 0 96.327442 38.745302 99.351813 88.540279h-199.20372z m-111.997024 752.044651c-30.981953 0-65.083535-39.15014-65.083535-95.041488V287.744h575.488v546.839814c0 55.915163-34.077767 95.041488-65.059721 95.041488H300.389209v-0.500093z"></path><path d="M368.116093 796.814884c24.361674 0 44.27014-21.670698 44.27014-48.818605v-278.623256c0-27.147907-19.908465-48.818605-44.27014-48.818604-24.33786 0-44.27014 21.670698-44.27014 48.818604v278.623256c0 27.147907 19.360744 48.818605 44.293954 48.818605z m154.933581 0c24.361674 0 44.293953-21.670698 44.293954-48.818605v-278.623256c0-27.147907-19.932279-48.818605-44.293954-48.818604-24.33786 0-44.27014 21.670698-44.270139 48.818604v278.623256c0 27.147907 19.932279 48.818605 44.293953 48.818605z m132.810419 0c24.33786 0 44.27014-21.670698 44.27014-48.818605v-278.623256c0-27.147907-19.932279-48.818605-44.27014-48.818604s-44.27014 21.670698-44.27014 48.818604v278.623256c0 27.147907 19.360744 48.818605 44.27014 48.818605z"></path></g></symbol>
<symbol id="tdam-plan" viewBox="0 0 1024 1024"><g transform="translate(32.27 32.11) scale(0.937731)"><path d="M379.328 544H260.544a32.192 32.192 0 1 1 0-64h118.784a32.192 32.192 0 1 1 0 64zM896 448a29.6 29.6 0 0 1-32-32v-32H128v416a72.416 72.416 0 0 0 64 64h192c19.808 0 32 4.128 32 38.208A35.2 35.2 0 0 1 384 928H192a129.568 129.568 0 0 1-128-128V229.248A134.4 134.4 0 0 1 192 96h64v-26.464A35.2 35.2 0 0 1 288 32a35.2 35.2 0 0 1 32 37.6V96h351.552v-26.464a32.672 32.672 0 1 1 64.576 0V96h64a129.568 129.568 0 0 1 128 128v192A29.6 29.6 0 0 1 896 448z m-32-224a72.416 72.416 0 0 0-64-64h-64v58.368a32.672 32.672 0 1 1-64.576 0V160H319.744v58.368A35.2 35.2 0 0 1 288 256a35.2 35.2 0 0 1-32-37.632V160H192a72.416 72.416 0 0 0-64 64v96h736V224z m-160 256.448a255.744 255.744 0 1 1-256 255.712 256.192 256.192 0 0 1 256-255.712zM704.416 928a192 192 0 1 0-192-192 192.16 192.16 0 0 0 192 192zM704 608a35.808 35.808 0 0 1 32.288 38.4v89.088H800a32.288 32.288 0 0 1 0 64.576h-95.84A32.192 32.192 0 0 1 672 768c0-0.64 0.32-1.152 0.352-1.76a42.208 42.208 0 0 1-0.8-4.736V646.4A35.808 35.808 0 0 1 704 608z"></path></g></symbol>
<symbol id="tdam-plus" viewBox="0 0 1024 1024"><path d="M512 128a48 48 0 0 1 48 48v288h288a48 48 0 0 1 0 96H560v288a48 48 0 0 1-96 0V560H176a48 48 0 0 1 0-96h288V176a48 48 0 0 1 48-48z"></path></symbol>
</defs></svg>`;

export class TodayDraftActionMenu {
    constructor({ host = document.body } = {}) {
        this.host = host;
        this.root = null;
        this.bar = null;
        this.tail = null;
        this.isOpen = false;
        this.anchorEl = null;
        this._onSelect = null;
        this._onClose = null;
        this._listen = false;
        this._handleOutsidePointer = this._handleOutsidePointer.bind(this);
        this._handleKeydown = this._handleKeydown.bind(this);
        this._handleViewportChange = this._handleViewportChange.bind(this);
    }

    ensureRoot() {
        if (this.root) return this.root;
        const root = document.createElement('div');
        root.className = 'tdam';
        root.hidden = true;
        root.innerHTML = `${SPRITE_HTML}
            <div class="tdam__bar" role="toolbar" aria-label="草稿操作"></div>
            <span class="tdam__tail" aria-hidden="true"></span>`;
        this.host.appendChild(root);
        this.root = root;
        this.bar = root.querySelector('.tdam__bar');
        this.tail = root.querySelector('.tdam__tail');
        this.bar.addEventListener('click', event => this.handleClick(event));
        return root;
    }

    renderActions(actionIds) {
        const buttons = [];
        actionIds.forEach((id, index) => {
            const action = DRAFT_MENU_ACTIONS[id];
            if (!action) return;
            // 删除这类破坏性动作前插一条分隔线，和常规动作分开。
            if (action.danger && index > 0) buttons.push('<span class="tdam__split" aria-hidden="true"></span>');
            buttons.push(`<button type="button" class="tdam__btn${action.danger ? ' tdam--danger' : ''}" data-tdam-action="${id}" aria-label="${action.label}" title="${action.label}"><svg class="tdam__ic" aria-hidden="true" focusable="false"><use href="#${action.icon}"/></svg></button>`);
        });
        this.bar.innerHTML = buttons.join('');
    }

    open({ anchorEl, actionIds = [], onSelect, onClose } = {}) {
        if (!anchorEl || !actionIds.length) return false;
        this.close();
        this.ensureRoot();
        this.anchorEl = anchorEl;
        this._onSelect = typeof onSelect === 'function' ? onSelect : null;
        this._onClose = typeof onClose === 'function' ? onClose : null;
        this.renderActions(actionIds);
        this.root.classList.add('is-open');
        this.root.hidden = false;
        this.isOpen = true;
        this.position(anchorEl);
        this.bindListeners();
        return true;
    }

    position(anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const barWidth = this.bar.offsetWidth;
        const barHeight = this.bar.offsetHeight;
        const margin = 8;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const centerX = rect.left + rect.width / 2;
        let left = centerX - barWidth / 2;
        left = Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - barWidth - margin)));

        // 默认浮在行上方；上方放不下就翻到下方，尖角跟着翻转。
        let below = false;
        let top = rect.top - barHeight - 12;
        if (top < margin) {
            below = true;
            top = rect.bottom + 12;
        }
        if (top + barHeight > viewportHeight - margin) {
            top = Math.max(margin, viewportHeight - barHeight - margin);
            below = false;
        }

        this.root.classList.toggle('tdam--below', below);
        this.root.style.left = `${Math.round(left)}px`;
        this.root.style.top = `${Math.round(top)}px`;
        const tailLeft = centerX - left - 6;
        this.tail.style.left = `${Math.round(Math.max(8, Math.min(barWidth - 20, tailLeft)))}px`;
    }

    // 行的 DOM 被整页重铺替换后重新锚定：菜单重排到同一 id 的新行上，浮层与按钮
    // 原地保留。否则期间发生的重绘会把正在被点击的按钮一起清掉，click 直接丢失
    // （桌面端「点菜单没反应」的真机根因）。
    reanchor(anchorEl) {
        if (!this.isOpen || !anchorEl) return;
        this.anchorEl = anchorEl;
        this.position(anchorEl);
    }

    bindListeners() {
        if (this._listen) return;
        this._listen = true;
        document.addEventListener('pointerdown', this._handleOutsidePointer, true);
        document.addEventListener('keydown', this._handleKeydown, true);
        window.addEventListener('scroll', this._handleViewportChange, true);
        window.addEventListener('resize', this._handleViewportChange);
    }

    unbindListeners() {
        if (!this._listen) return;
        this._listen = false;
        document.removeEventListener('pointerdown', this._handleOutsidePointer, true);
        document.removeEventListener('keydown', this._handleKeydown, true);
        window.removeEventListener('scroll', this._handleViewportChange, true);
        window.removeEventListener('resize', this._handleViewportChange);
    }

    _handleOutsidePointer(event) {
        if (this.root?.contains(event.target)) return;
        this.close();
    }

    _handleKeydown(event) {
        if (event.key === 'Escape') this.close();
    }

    _handleViewportChange() {
        this.close();
    }

    close() {
        this.unbindListeners();
        if (!this.root) return;
        this.root.classList.remove('is-open');
        this.root.hidden = true;
        if (!this.isOpen) return;
        this.isOpen = false;
        this.anchorEl = null;
        this.bar.innerHTML = '';
        const onClose = this._onClose;
        this._onSelect = null;
        this._onClose = null;
        onClose?.();
    }

    handleClick(event) {
        const button = event.target.closest?.('[data-tdam-action]');
        if (!button || !this.bar?.contains(button)) return false;
        event.preventDefault();
        event.stopPropagation();
        const actionId = button.dataset.tdamAction;
        const onSelect = this._onSelect;
        this.close();
        onSelect?.(actionId);
        return true;
    }
}
