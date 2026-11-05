/**
 * 即时草稿的行操作菜单：长按/右键草稿行后浮出的横向图标条（iOS 风格玻璃材质）。
 * 只负责定位、开合、点外关闭与图标渲染；具体动作通过 onSelect(id) 交给 manager，
 * 本模块不接触草稿数据，也不依赖 DOM 之外的状态。
 *
 * 材质与图标和文章编辑器选区菜单共用一套：DOM 挂 .selection-menu
 * .typora-selection-menu 基类（styles.css 统一给圆角、40/44px 按钮、20/21px
 * 图标、hover/焦点环、::after 尖角与 .sm-below 翻转），图标走
 * selection-menu-icons.js 的全局精灵。本视图只留少量本地差异（position:fixed
 * 相对视口、层级、删除动作警示色、灯泡尺寸补偿、文档图标描边补粗、[hidden]），
 * 见 today-drafts.css。
 * 菜单挂在 document.body，不挂在纸张里——纸张有 overflow:hidden，靠近顶部的行
 * 上方浮出会被裁掉。
 */
import { createSelectionMenuIcon, ensureSelectionMenuSprite } from '../selection-menu-icons.js';

// 可选动作目录：icon 指向共享精灵的 symbol id，danger 走警示色。
// 图标与 floating-actions 的目标视图按钮同源：Thought=灯泡、加入今日=即时草稿
// 笔记+笔、计划=日历、复制=双方块、删除=垃圾桶；「转为文章」用单独的文档图标
// （圆角框 + 三行正文），不用加号——加号在这套图标里显得格格不入。
export const DRAFT_MENU_ACTIONS = Object.freeze({
    copy: { icon: 'sm-copy', label: '复制全文' },
    thought: { icon: 'sm-thought', label: '转为 Thought' },
    article: { icon: 'sm-article', label: '转为文章' },
    today: { icon: 'sm-drafts', label: '加入今日' },
    plan: { icon: 'sm-plan', label: '计划' },
    delete: { icon: 'sm-trash', label: '删除', danger: true }
});

export class InstantDraftActionMenu {
    constructor({ host = document.body } = {}) {
        this.host = host;
        this.root = null;
        this.bar = null;
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
        const doc = this.host.ownerDocument || document;
        // 精灵全局一份：文章编辑器选区菜单、Thought 卡片工具条与本菜单共用。
        ensureSelectionMenuSprite(doc);
        const root = doc.createElement('div');
        root.className = 'selection-menu typora-selection-menu today-draft-action-menu';
        root.hidden = true;
        const bar = doc.createElement('div');
        bar.className = 'menu-btn-group';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', '草稿操作');
        bar.setAttribute('aria-orientation', 'horizontal');
        root.appendChild(bar);
        this.host.appendChild(root);
        this.root = root;
        this.bar = bar;
        this.bar.addEventListener('click', event => this.handleClick(event));
        return root;
    }

    renderActions(actionIds) {
        const doc = this.host.ownerDocument || document;
        const fragment = doc.createDocumentFragment();
        actionIds.forEach((id, index) => {
            const action = DRAFT_MENU_ACTIONS[id];
            if (!action) return;
            // 删除这类破坏性动作前插一条分隔线，和常规动作分开。
            if (action.danger && index > 0) {
                const split = doc.createElement('span');
                split.className = 'sm-split';
                split.setAttribute('aria-hidden', 'true');
                fragment.appendChild(split);
            }
            const button = doc.createElement('button');
            button.type = 'button';
            if (action.danger) button.classList.add('tdam--danger');
            button.dataset.tdamAction = id;
            button.setAttribute('aria-label', action.label);
            button.title = action.label;
            // <use> 的 href / xlink:href 双写由共享 helper 负责（iOS 15 Safari）。
            button.appendChild(createSelectionMenuIcon(action.icon, doc));
            const label = doc.createElement('span');
            label.className = 'sm-label';
            label.textContent = action.label;
            button.appendChild(label);
            fragment.appendChild(button);
        });
        this.bar.replaceChildren(fragment);
    }

    open({ anchorEl, actionIds = [], onSelect, onClose } = {}) {
        if (!anchorEl || !actionIds.length) return false;
        this.close();
        this.ensureRoot();
        this.anchorEl = anchorEl;
        this._onSelect = typeof onSelect === 'function' ? onSelect : null;
        this._onClose = typeof onClose === 'function' ? onClose : null;
        this.renderActions(actionIds);
        this.root.hidden = false;
        this.isOpen = true;
        this.position(anchorEl);
        this.bindListeners();
        return true;
    }

    position(anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        // 根元素才是整条胶囊（含 5px 内边距），bar 只是按钮组，量宽度必须量根，
        // 否则菜单会偏左半个 padding、尖角也会偏。
        const menuWidth = this.root.offsetWidth || this.bar.offsetWidth || 150;
        const menuHeight = this.root.offsetHeight || this.bar.offsetHeight || 40;
        const margin = 8;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const centerX = rect.left + rect.width / 2;
        let left = centerX - menuWidth / 2;
        left = Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - menuWidth - margin)));

        // 默认浮在行上方；上方放不下就翻到下方，共享 .sm-below 让尖角与动画反转。
        let below = false;
        let top = rect.top - menuHeight - 12;
        if (top < margin) {
            below = true;
            top = rect.bottom + 12;
        }
        if (top + menuHeight > viewportHeight - margin) {
            top = Math.max(margin, viewportHeight - menuHeight - margin);
            below = false;
        }

        this.root.classList.toggle('sm-below', below);
        this.root.style.left = `${Math.round(left)}px`;
        this.root.style.top = `${Math.round(top)}px`;
        // 共享 ::after 尖角仍要指向行中心：菜单被视口夹住后不能再用写死的 50%。
        const tailX = centerX - left - 6;
        this.root.style.setProperty('--sm-tail-x', `${Math.round(Math.max(10, Math.min(menuWidth - 16, tailX)))}px`);
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
        this.root.hidden = true;
        if (!this.isOpen) return;
        this.isOpen = false;
        this.anchorEl = null;
        this.bar.replaceChildren();
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
