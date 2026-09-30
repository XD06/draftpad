import { createTodayDraft, dayWindowKeys, localDayKey, TodayDraftsStore } from './today-drafts-store.js';
import { escapeTodayDraftHtml, renderTodayDrafts } from './today-drafts-renderer.js';
import { getTodayDraftSwipeState, isTodayDraftFlipHandoff, isTodayDraftPagerEdge } from './today-drafts-swipe.js';
import { TODAY_DRAFT_LINE_UNIT, findTodayDraftPageByRow, flattenTodayDraftPages, paginateTodayDraftRows } from './today-drafts-paging.js';
import TodayDraftsApiClient from './today-drafts-api-client.js';
import TodayDraftsOutbox from './today-drafts-outbox.js';

const DAY_LABELS = ['2d ago', 'yest', 'today'];
// 行程达纸宽 25% 判落页（older 折痕左缘→右缘、newer 反向）
const FLIP_COMMIT_RATIO = 0.25;
const FLIP_RELEASE_MS = 340;
// 卷起窄条的最大宽度（占纸宽比例）：起手与落页时收拢为 0，中段最宽
const FLIP_CURL_RATIO = 0.22;
// 折痕两侧羽化落影的宽度（占纸宽比例，上限 56px）
const FLIP_FEATHER_RATIO = 0.07;

function prefersReducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

function formatDayDate(dayKey) {
    const [, month, day] = String(dayKey).split('-');
    return `${Number(month)}/${Number(day)}`;
}

export class TodayDraftsManager {
    constructor({
        store = new TodayDraftsStore(),
        apiClient = new TodayDraftsApiClient(),
        outbox = new TodayDraftsOutbox(),
        onMoveToThought = async () => false,
        toaster = null
    } = {}) {
        this.store = store;
        this.apiClient = apiClient;
        this.outbox = outbox;
        this.onMoveToThought = onMoveToThought;
        this.toaster = toaster;
        this.view = document.getElementById('today-drafts-view');
        this.writingArea = document.getElementById('today-drafts-writing-area');
        this.list = document.getElementById('today-drafts-list');
        this.input = document.getElementById('today-drafts-input');
        this.form = document.getElementById('today-drafts-form');
        this.toggleButton = document.getElementById('toggle-today-drafts');
        this.pager = document.getElementById('today-drafts-pager');
        this.base = document.getElementById('today-drafts-base');
        this.flipStatic = document.getElementById('today-drafts-flip-static');
        this.flipFlap = document.getElementById('today-drafts-flip-flap');
        this.flipCurl = document.getElementById('today-drafts-flip-curl');
        this.flipShadow = document.getElementById('today-drafts-flip-shadow');
        this.flipCrease = document.getElementById('today-drafts-flip-crease');
        this.eyebrow = document.getElementById('today-drafts-eyebrow');
        this.items = this.store.load().items;
        // 翻页的当前视图日；历史日只读（右滑可重新加入今日），只有今天可以编辑。
        this.viewDay = localDayKey();
        // 一天的内容超过一张纸时按页纵向切开，viewPageIndex 是当天内的页码（0 起）。
        // pageList / pagesByDay 每次 render 都在真实布局里量出来。
        this.viewPageIndex = 0;
        this.pageList = [];
        this.pagesByDay = {};
        this.resizeRenderQueued = false;
        this.pagerInteraction = null;
        this.flipAnim = null;
        this.flipFrameRaf = null;
        this.pendingFlipFrame = null;
        this.movingDraftIds = new Set();
        this.isActive = false;
        this.dayTimer = null;
        this.syncTimer = null;
        this.syncInFlight = false;
        this.syncQueued = false;
        this.isComposingDraft = false;
        this.pendingRender = false;
        this.flipFrameBudget = 0;
        this.flipSlowFrames = 0;
        this.bindEvents();
        window.addEventListener('today_drafts_update', event => this.handleSocketUpdate(event.detail || {}));
        // 移动端切后台/来电/切应用时浏览器可以吞掉 pointerup：翻页图层会卡在
        // 半开状态（is-flipping 的 user-select 与图层栈还挂着），回到前台就
        // 表现为「页面卡死」。可见性丢失与窗口失焦时无条件清场，代价为零——
        // 正常路径下这些时刻不会有进行中的手势。
        const abortFlipSession = () => {
            if (!this.pagerInteraction && !this.flipAnim && !this.flipFrameRaf) return;
            this.pagerInteraction = null;
            this.pendingRender = false;
            this.hideFlipLayers();
            this.pager?.style.setProperty('transform', '');
            this.pager?.style.setProperty('transition', '');
            if (this.isActive) this.render();
        };
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) abortFlipSession();
        });
        window.addEventListener('blur', abortFlipSession);
        // On (re)connect, flush anything queued while offline AND pull the
        // retention window from the server: updates pushed by other devices
        // while this client was disconnected never arrived, so without a
        // refetch the local list stays stale until the user re-enters the tab.
        window.addEventListener('ws_connected', () => {
            this.retryOutbox();
            if (this.isActive) this.refreshWindowDrafts();
        });
        // 分页预算来自真实纸高与真实换行，视口一变两者都会变：转屏 / 分屏 /
        // 桌面拖窗口都要重算，否则页里会留着上一尺寸的排版。拖边缘会连发几十个
        // resize，一帧只重排一次。
        window.addEventListener('resize', () => {
            if (!this.isActive || this.resizeRenderQueued) return;
            this.resizeRenderQueued = true;
            requestAnimationFrame(() => {
                this.resizeRenderQueued = false;
                this.render();
            });
        });
        this.render();
    }

    bindEvents() {
        // 页眉的「N/M」是翻页入口：草稿铺满整页时，纸边热区之外还需要一个看得见、
        // 点得中的落点，方向与左滑一致（翻向更新的一页）。
        this.eyebrow?.addEventListener('click', () => this.flipToAdjacentPage());
        // 新增草稿输入框是 textarea：随内容自动增高，输入时实时软换行。
        const autoResizeInput = () => {
            if (!this.input) return;
            this.input.style.height = 'auto';
            this.input.style.height = `${Math.max(44, this.input.scrollHeight)}px`;
            // 分页预算按折叠高度预留，输入行自己长高时靠这一页纵向滚动兜底。
            this.syncPageOverflow();
        };
        this.input?.addEventListener('input', autoResizeInput);
        this.input?.addEventListener('keydown', event => {
            // Enter 提交；Shift+Enter 留给软换行；中文输入法确认回车不提交。
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
            event.preventDefault();
            this.form?.requestSubmit?.() || this.add(this.input.value);
        });
        this.form?.addEventListener('submit', event => {
            event.preventDefault();
            this.add(this.input?.value || '');
        });
        this.list?.addEventListener('click', event => {
            if (event.target.closest('[data-today-draft-link]')) return;
            const display = event.target.closest('[data-today-draft-text-display]');
            const row = display?.closest('[data-today-draft-id]');
            if (row) this.beginEditingDraft(row);
        });
        this.list?.addEventListener('change', event => {
            const row = event.target.closest('[data-today-draft-id]');
            if (!row || !event.target.matches('[data-today-draft-complete]')) return;
            this.update(row.dataset.todayDraftId, { completed: event.target.checked });
        });
        this.list?.addEventListener('input', event => {
            const row = event.target.closest('[data-today-draft-id]');
            if (!row || !event.target.matches('[data-today-draft-text]')) return;
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.max(44, event.target.scrollHeight)}px`;
            this.update(row.dataset.todayDraftId, { text: event.target.value }, { render: false });
            row.classList.toggle('is-empty', !event.target.value.trim());
            // 编辑中的行会实时长高，超出纸面的部分必须能滚，否则用户看不见自己在打什么。
            this.syncPageOverflow();
        });
        this.list?.addEventListener('compositionstart', event => {
            if (event.target.matches('[data-today-draft-text]')) this.isComposingDraft = true;
        });
        this.list?.addEventListener('compositionend', event => {
            if (!event.target.matches('[data-today-draft-text]')) return;
            this.isComposingDraft = false;
            if (this.pendingRender) this.render();
        });
        this.list?.addEventListener('keydown', event => {
            if (event.target.closest('[data-today-draft-link]')) return;
            const display = event.target.closest('[data-today-draft-text-display]');
            if (display && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                this.beginEditingDraft(display.closest('[data-today-draft-id]'));
                return;
            }
            if (event.key !== 'Enter') return;
            // Shift+Enter 在编辑器里软换行；中文输入法确认回车不拆行。
            if (event.shiftKey || event.isComposing || this.isComposingDraft) return;
            const input = event.target.closest('[data-today-draft-text]');
            if (!input) return;
            event.preventDefault();
            if (!input.value.trim()) return;
            this.addAfter(input.closest('[data-today-draft-id]')?.dataset.todayDraftId);
        });
        this.list?.addEventListener('focusout', event => {
            const input = event.target.closest('[data-today-draft-text]');
            if (!input) return;
            const row = input.closest('[data-today-draft-id]');
            if (!row) return;
            if (!input.value.trim()) {
                this.remove(row.dataset.todayDraftId);
                return;
            }
            this.render();
        });
        this.bindDraftSwipeActions();
        this.bindPagerFlipActions();
    }

    bindDraftSwipeActions() {
        let interaction = null;
        let suppressNextClick = false;

        const releasePointer = (event, row = interaction?.row) => {
            const pointerId = event?.pointerId ?? interaction?.pointerId;
            if (!row || pointerId === undefined) return;
            try {
                if (!row.hasPointerCapture || row.hasPointerCapture(pointerId)) {
                    row.releasePointerCapture?.(pointerId);
                }
            } catch {
                // A cancelled touch can release capture before its cleanup event.
            }
        };

        const resetSwipe = event => {
            const row = interaction?.row;
            releasePointer(event, row);
            row?.classList.remove('is-swiping', 'is-swipe-ready', 'is-swipe-thought', 'is-swipe-delete');
            row?.style.removeProperty('--today-draft-swipe-x');
            row?.style.removeProperty('--today-draft-swipe-opacity');
            interaction = null;
        };

        this.list?.addEventListener('pointerdown', event => {
            if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || interaction) return;
            const row = event.target.closest('[data-today-draft-id]');
            if (!row || event.target.closest('[data-today-draft-complete], .today-draft-check')) return;
            if (event.target.closest('[data-today-draft-link]')) return;
            const textInput = event.target.closest('[data-today-draft-text]');
            if (textInput && event.pointerType === 'mouse') return;
            if (event.pointerType === 'mouse' && event.target.closest('[data-today-draft-text-display]')) return;
            // 纸边那一条留给翻整页（见 today-drafts-swipe.js 的 TODAY_DRAFT_PAGER_EDGE）：
            // 这里不认领，pointerdown 会继续冒泡到 pager 的翻页手势。
            if (isTodayDraftPagerEdge({ clientX: event.clientX, rect: row.getBoundingClientRect() })) return;

            interaction = {
                row,
                id: row.dataset.todayDraftId,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                deltaX: 0,
                isDragging: false,
                threshold: Math.max(64, row.offsetWidth * 0.28),
                maxSwipe: Math.max(92, row.offsetWidth * 0.38)
            };
            try {
                row.setPointerCapture?.(event.pointerId);
            } catch {
                // Pointer capture is an enhancement; touch-action still protects vertical scrolling.
            }
        });

        this.list?.addEventListener('pointermove', event => {
            if (!interaction || event.pointerId !== interaction.pointerId) return;
            const { row, startX, startY } = interaction;
            interaction.deltaX = event.clientX - startX;
            const deltaY = Math.abs(event.clientY - startY);
            if (!interaction.isDragging && Math.abs(interaction.deltaX) > 14 && Math.abs(interaction.deltaX) > deltaY * 1.3) {
                interaction.isDragging = true;
                if (document.activeElement?.matches?.('[data-today-draft-text]')) document.activeElement.blur();
                row.classList.add('is-swiping');
            }
            if (!interaction.isDragging) return;

            event.preventDefault();
            // 拖过交接线 = 这一下是想翻整页：行的动作条当场撤销，同一根手指接上翻页。
            // 不这么做的话，「翻页」和「行短滑」在纸面上根本分不开，误删就是这么来的。
            if (this.handOffRowSwipeToFlip(interaction, event)) {
                interaction = null;
                return;
            }
            const state = getTodayDraftSwipeState(interaction.deltaX, interaction.threshold, interaction.maxSwipe);
            row.style.setProperty('--today-draft-swipe-x', `${state.swipeX}px`);
            row.style.setProperty('--today-draft-swipe-opacity', String(state.actionOpacity));
            row.classList.toggle('is-swipe-ready', state.ready);
            row.classList.toggle('is-swipe-thought', state.direction === 'thought');
            row.classList.toggle('is-swipe-delete', state.direction === 'delete');
        });

        const finishSwipe = async event => {
            if (!interaction || event.pointerId !== interaction.pointerId) return;
            const current = interaction;
            const historyView = this.viewDay !== localDayKey();
            const state = getTodayDraftSwipeState(current.deltaX, current.threshold, current.maxSwipe);
            const action = current.isDragging && state.ready ? state.direction : null;
            if (current.isDragging) {
                suppressNextClick = true;
                setTimeout(() => {
                    suppressNextClick = false;
                }, 0);
            }
            releasePointer(event, current.row);

            if (!action) {
                resetSwipe();
                return;
            }

            interaction = null;
            current.row.classList.remove('is-swiping');
            current.row.classList.add('is-swipe-ready', action === 'thought' ? 'is-swipe-thought' : 'is-swipe-delete');
            if (historyView) {
                // 历史页两个方向都是复制，原记录留在历史日：
                // 右滑 = 重新加入今日（保留完成状态）；左滑 = 转为 Thought。
                if (action === 'thought') {
                    await this.copyDraftToThought(current.id);
                } else {
                    this.copyDraftToToday(current.id);
                }
                current.row.classList.remove('is-swipe-ready', 'is-swipe-thought', 'is-swipe-delete');
                current.row.style.removeProperty('--today-draft-swipe-x');
                current.row.style.removeProperty('--today-draft-swipe-opacity');
                return;
            }
            if (action === 'delete') {
                current.row.classList.add('is-swipe-departing');
                await new Promise(resolve => setTimeout(resolve, 160));
                this.remove(current.id);
                return;
            }

            const item = this.items.find(candidate => candidate.id === current.id);
            if (!item || this.movingDraftIds.has(current.id)) return;
            this.movingDraftIds.add(current.id);
            try {
                const moved = await this.onMoveToThought({ ...item });
                if (moved) {
                    this.remove(current.id);
                    return;
                }
            } catch (error) {
                console.warn('Failed to move today draft into Thought:', error);
            } finally {
                this.movingDraftIds.delete(current.id);
            }
            current.row.classList.remove('is-swipe-ready', 'is-swipe-thought');
            current.row.style.removeProperty('--today-draft-swipe-x');
            current.row.style.removeProperty('--today-draft-swipe-opacity');
        };

        this.list?.addEventListener('pointerup', finishSwipe);
        this.list?.addEventListener('pointercancel', resetSwipe);
        this.list?.addEventListener('click', event => {
            if (!suppressNextClick) return;
            suppressNextClick = false;
            event.preventDefault();
            event.stopPropagation();
        }, true);
    }

    pagerBox() {
        const rect = this.pager?.getBoundingClientRect();
        return {
            left: rect?.left || 0,
            top: rect?.top || 0,
            width: this.pager?.clientWidth || 1,
            height: this.pager?.clientHeight || 1
        };
    }

    // 行拖拽中途交棒给翻页：起点在行中间也照翻，只要行程过了交接线。
    // 沿用行手势原本的 startX/startY，折痕进度从当前指尖位置连续接上（不跳回 0）；
    // isDragging 留在 false，让翻页自己的 pointermove 判定方向并 beginFlip。
    handOffRowSwipeToFlip(current, event) {
        if (this.pagerInteraction || this.flipAnim || this.flipFrameRaf) return false;
        const width = this.pager?.clientWidth || 0;
        if (!isTodayDraftFlipHandoff({ deltaX: current.deltaX, width })) return false;
        const dir = current.deltaX > 0 ? 'older' : 'newer';
        // 序列尽头没什么可翻（今天末页再左滑、前天再右滑）：这条手势仍归行的短滑。
        if (!this.pageAt(dir === 'older' ? -1 : 1)) return false;
        const row = current.row;
        row.classList.remove('is-swiping', 'is-swipe-ready', 'is-swipe-thought', 'is-swipe-delete');
        row.style.removeProperty('--today-draft-swipe-x');
        row.style.removeProperty('--today-draft-swipe-opacity');
        this.pagerInteraction = {
            pointerId: current.pointerId,
            startX: current.startX,
            startY: current.startY,
            deltaX: current.deltaX,
            dir: null,
            progress: 0,
            isDragging: false,
            ready: false,
            invalid: false,
            box: this.pagerBox()
        };
        try {
            this.view?.setPointerCapture?.(event.pointerId);
        } catch {
            // Pointer capture is an enhancement.
        }
        return true;
    }

    // 整页仿真翻页：右滑（deltaX > 0）掀页看更早历史，左滑（deltaX < 0）
    // 拉回更新日期（阅读类 App 方向语义）。动页由两份拷贝渲染：flip-static
    // 露出已落定部分，flip-flap 镜像出纸背，flip-fx 三件套负责折痕亮线与
    // 两侧羽化落影。拖拽逐帧跟手，松手 rAF 补间落页或回弹。
    bindPagerFlipActions() {
        let suppressNextClick = false;

        const setReady = (current, ready) => {
            const wasReady = current.ready;
            current.ready = ready;
            if (ready && !wasReady) navigator.vibrate?.(8);
        };

        this.view?.addEventListener('pointerdown', event => {
            if (!event.isPrimary) return;
            // 上一页的落页/回弹补间还没收尾时，新手势直接接管并清场复原
            if (this.flipAnim) {
                this.hideFlipLayers();
                this.render();
            }
            if (this.pagerInteraction) return;
            // 页眉的「N/M」是点按入口，不参与拖拽：手势一旦认领就会 setPointerCapture，
            // 浏览器会把随后的 click 改派到捕获元素上，按钮自己的点击就丢了（真机实测）。
            if (event.target.closest('input, textarea, button, a, [contenteditable]')) return;
            // 行上的横向拖动起手归行操作；从纸边那条热区起笔才直接翻整页。
            // 行中间的长横扫另有中途交棒（handOffRowSwipeToFlip），两条加起来
            // 才是完整答案：草稿铺满整页时，纸面空白所剩无几，只有热区翻不动页。
            const rowUnderPointer = event.target.closest('[data-today-draft-id]');
            if (rowUnderPointer && !isTodayDraftPagerEdge({
                clientX: event.clientX,
                rect: rowUnderPointer.getBoundingClientRect()
            })) return;
            this.pagerInteraction = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                deltaX: 0,
                dir: null,
                progress: 0,
                isDragging: false,
                ready: false,
                invalid: false,
                box: this.pagerBox()
            };
            try {
                this.view?.setPointerCapture?.(event.pointerId);
            } catch {
                // Pointer capture is an enhancement.
            }
        });

        this.view?.addEventListener('pointermove', event => {
            const current = this.pagerInteraction;
            if (!current || event.pointerId !== current.pointerId) return;
            current.deltaX = event.clientX - current.startX;
            const deltaY = event.clientY - current.startY;
            if (!current.isDragging && !current.invalid && Math.abs(current.deltaX) > 14 && Math.abs(current.deltaX) > Math.abs(deltaY) * 1.3) {
                current.dir = current.deltaX > 0 ? 'older' : 'newer';
                event.preventDefault();
                window.getSelection?.()?.removeAllRanges();
                this.beginFlip(current);
                if (current.invalid) return;
                current.isDragging = true;
                if (document.activeElement?.matches?.('[data-today-draft-text]')) document.activeElement.blur();
            }
            if (!current.isDragging) {
                if (current.invalid) {
                    // 边界橡皮筋：越界方向按比例轻推整卡，松手弹回
                    const overDrag = Math.sign(current.deltaX) * Math.min(14, Math.abs(current.deltaX) * 0.08);
                    if (this.pager) this.pager.style.transform = `translate3d(${overDrag.toFixed(1)}px, 0, 0)`;
                }
                return;
            }

            event.preventDefault();
            const box = current.box;
            // 行程驱动：older 折痕从左缘扫向右缘，newer 反向
            current.progress = Math.min(1, Math.abs(current.deltaX) / box.width);
            setReady(current, current.progress >= FLIP_COMMIT_RATIO);
            this.scheduleFlipFrame(current);
        });

        const finishFlipGesture = event => {
            const current = this.pagerInteraction;
            if (!current || event.pointerId !== current.pointerId) return;
            this.pagerInteraction = null;
            try {
                if (this.view?.hasPointerCapture?.(event.pointerId)) this.view.releasePointerCapture(event.pointerId);
            } catch {
                // A cancelled pointer can release capture before its cleanup event.
            }
            if (!current.isDragging) {
                // 未成形的拖拽（含边界橡皮筋）弹回原位
                if (this.pager) {
                    this.pager.style.transition = 'transform 200ms cubic-bezier(0.25, 1, 0.5, 1)';
                    this.pager.style.transform = '';
                    setTimeout(() => {
                        if (!this.pagerInteraction) this.pager.style.transition = '';
                    }, 220);
                }
                // 手势期间被记账的异步刷新在这里补上（finishFlip 走 animate 后自带 render）。
                if (this.pendingRender && !this.isComposingDraft) this.render();
                return;
            }
            suppressNextClick = true;
            setTimeout(() => {
                suppressNextClick = false;
            }, 0);
            this.animateFlipRelease(current);
        };

        this.view?.addEventListener('pointerup', finishFlipGesture);
        this.view?.addEventListener('pointercancel', event => {
            const current = this.pagerInteraction;
            if (!current || event.pointerId !== current.pointerId) return;
            this.pagerInteraction = null;
            if (current.isDragging) {
                this.animateFlipRelease(current);
            } else {
                if (this.pager) this.pager.style.transform = '';
                this.hideFlipLayers();
                if (this.pendingRender && !this.isComposingDraft) this.render();
            }
        });
        this.view?.addEventListener('click', event => {
            if (!suppressNextClick) return;
            suppressNextClick = false;
            event.preventDefault();
            event.stopPropagation();
        }, true);
    }

    // ---- 分页：一张纸 = 书写区高度 ÷ 44px 纸纹行 ---------------------------

    pageLinesFor(day) {
        const height = this.writingArea?.clientHeight || 0;
        if (!height) return 0;
        // 历史页不渲染输入行，整幅纸都是正文；今天要先扣掉输入行的真实高度
        // （44px 纸纹 + 3px 收边 + 1px 分隔线），否则整幅纸排满时输入行会被挤出纸面。
        const reserved = day === localDayKey() ? (this.form?.offsetHeight || TODAY_DRAFT_LINE_UNIT) : 0;
        return Math.floor((height - reserved) / TODAY_DRAFT_LINE_UNIT);
    }

    currentKey() {
        return `${this.viewDay}#${this.viewPageIndex}`;
    }

    currentPage() {
        return this.pageList.find(page => page.key === this.currentKey()) || null;
    }

    pageAt(offset) {
        const position = this.pageList.findIndex(page => page.key === this.currentKey());
        if (position < 0) return null;
        return this.pageList[position + offset] || null;
    }

    pageIndexForDraft(id) {
        const draft = this.items.find(item => item.id === id);
        if (!draft) return null;
        const day = draft.day || localDayKey();
        const rowIndex = this.itemsForDay(day).findIndex(item => item.id === id);
        if (rowIndex < 0) return null;
        const page = findTodayDraftPageByRow(this.pagesByDay[day], rowIndex);
        return page ? page.index : null;
    }

    // 条目落在哪一页就翻到哪一页：同一天内换页只重绘，不重新拉数据。
    goToDraft(id) {
        const pageIndex = this.pageIndexForDraft(id);
        if (pageIndex === null) return false;
        const draft = this.items.find(item => item.id === id);
        const day = draft?.day || localDayKey();
        if (this.viewDay === day && this.viewPageIndex === pageIndex) return false;
        this.viewDay = day;
        this.viewPageIndex = pageIndex;
        this.render();
        return true;
    }

    // 点页眉「N/M」翻向更新的一页：借手势同一套 beginFlip / animateFlipRelease，
    // 只是进度由补间从 0 推到 1，落页与记账路径完全共用。手势或补间进行中不插手。
    flipToAdjacentPage() {
        if (this.pagerInteraction || this.flipAnim || this.flipFrameRaf) return false;
        const page = this.currentPage();
        if (!page || page.pageCount <= 1) return false;
        const target = this.pageAt(1);
        if (!target) {
            // 已经是全序列最后一页：回到当天第 1 页，没有相邻页可掀，直接重排。
            this.viewPageIndex = 0;
            this.render();
            return true;
        }
        const current = {
            dir: 'newer',
            progress: 0,
            isDragging: true,
            ready: true,
            invalid: false,
            box: { width: this.pager?.clientWidth || 1 }
        };
        this.beginFlip(current);
        if (current.invalid) {
            this.hideFlipLayers();
            return false;
        }
        this.animateFlipRelease(current);
        return true;
    }

    // 每条草稿实际吃掉几条纸纹只能在真实布局里量（换行取决于宽度与标点）。
    // 三天的行一次性铺进同宽的隐藏 sizer，读一轮 offsetHeight 就拆掉——整趟只一次
    // 强制布局，比按文本猜宽度可靠，也不会出现「量到的和渲染的不是同一套规则」。
    measureLineCounts(groups) {
        if (!this.base || !this.list) return groups.map(items => items.map(() => 1));
        const width = this.list.clientWidth;
        if (!width) return groups.map(items => items.map(() => 1));
        const today = localDayKey();
        const sizer = document.createElement('ol');
        sizer.className = 'today-drafts-list today-drafts-sizer';
        sizer.setAttribute('aria-hidden', 'true');
        sizer.style.width = `${width}px`;
        sizer.innerHTML = groups
            .map((items, index) => renderTodayDrafts(items, this.pageDays[index] === today ? {} : { readonly: true }))
            .join('');
        this.base.appendChild(sizer);
        const heights = [...sizer.children].map(node => node.offsetHeight);
        sizer.remove();
        let cursor = 0;
        return groups.map(items => {
            const counts = heights.slice(cursor, cursor + items.length)
                .map(height => Math.max(1, Math.round(height / TODAY_DRAFT_LINE_UNIT) || 1));
            cursor += items.length;
            return counts;
        });
    }

    measurePageModel() {
        const days = dayWindowKeys();
        this.pageDays = days;
        const groups = days.map(day => this.itemsForDay(day));
        const lineCounts = this.measureLineCounts(groups);
        const pagesByDay = {};
        days.forEach((day, index) => {
            // 量不到纸高或排版宽度（视图还没铺开）时不猜页边界：整日留作一页，
            // 宁可暂时超出纸面由纵向滚动兜底，也不要按假数据把内容打散成几十页。
            const budget = this.pageLinesFor(day);
            pagesByDay[day] = paginateTodayDraftRows(lineCounts[index], budget || Number.POSITIVE_INFINITY);
        });
        this.pagesByDay = pagesByDay;
        this.pageList = flattenTodayDraftPages({ dayKeys: days, pagesByDay });
    }

    clampView() {
        if (!dayWindowKeys().includes(this.viewDay)) this.viewDay = localDayKey();
        const pages = this.pagesByDay[this.viewDay] || [];
        this.viewPageIndex = Math.min(Math.max(0, this.viewPageIndex || 0), Math.max(0, pages.length - 1));
    }

    // 单条草稿比一页还高（粘贴长文）时不再把内容吞掉，让这一页能纵向滚。
    syncPageOverflow() {
        const area = this.writingArea;
        if (!area || !area.clientHeight) return;
        const content = (this.list?.scrollHeight || 0) + (this.form?.offsetHeight || 0);
        area.classList.toggle('is-overflowing', content > area.clientHeight + 1);
    }

    eyebrowText(page) {
        const label = this.dayLabel(page.day);
        return page.pageCount > 1 ? `${label} · ${page.index + 1}/${page.pageCount}` : label;
    }

    dayLabel(day) {
        const pages = dayWindowKeys();
        return `${DAY_LABELS[pages.indexOf(day)] || ''} · ${formatDayDate(day)}`;
    }

    setEyebrow(page) {
        if (!this.eyebrow || !page) return;
        this.eyebrow.textContent = this.eyebrowText(page);
        const paged = page.pageCount > 1;
        // 一页可翻时它不是按钮，而是纯日期标注：禁用比藏起来稳（藏起来标题行会跳位）。
        this.eyebrow.disabled = !paged;
        this.eyebrow.title = paged
            ? `第 ${page.index + 1}/${page.pageCount} 页 · 点这里${this.pageAt(1) ? '翻到下一页' : '回到第 1 页'}`
            : '';
    }

    // 状态栏统计跟随当前查看的日期（翻到昨天就显示昨天的完成度），不再永远显示今天。
    setHeaderStats(day) {
        const items = this.itemsForDay(day);
        const completed = items.filter(item => item.completed).length;
        const count = document.getElementById('today-drafts-count');
        if (count) count.textContent = items.length ? `${completed}/${items.length} 已完成` : '用完即走';
    }

    // 翻页拷贝用的整卡静态 HTML：与 index.html 的纸卡同构（页眉 + 书写区），
    // 但不带任何 id、不绑事件——纯视觉镜像，指针事件由图层 pointer-events 关掉。
    buildFlipCardHtml(page) {
        const isToday = page.day === localDayKey();
        const dayItems = this.itemsForDay(page.day);
        const items = page.indexes.map(index => dayItems[index]).filter(Boolean);
        const completed = items.filter(item => item.completed).length;
        const countText = items.length ? `${completed}/${items.length} 已完成` : '用完即走';
        const inputRow = isToday
            ? `<div class="today-drafts-input-row" aria-hidden="true">
                    <span class="today-drafts-input-marker" aria-hidden="true">+</span>
                    <textarea rows="1" readonly tabindex="-1" placeholder="写下一件现在要做的事"${this.input?.style.height ? ` style="height:${this.input.style.height}"` : ''}>${escapeTodayDraftHtml(this.input?.value || '')}</textarea>
                </div>`
            : '';
        return `<div class="today-drafts-header">
                <div>
                    <h2>今日草稿<span class="today-drafts-eyebrow">${escapeTodayDraftHtml(this.eyebrowText(page))}</span></h2>
                    <p class="today-drafts-subtitle">保留最近 3 天，左右滑动翻页。</p>
                </div>
                <div class="today-drafts-status"><span>${escapeTodayDraftHtml(countText)}</span></div>
            </div>
            <div class="today-drafts-writing-area${items.length === 0 ? ' is-empty' : ''}">
                <ol class="today-drafts-list">${renderTodayDrafts(items, isToday ? {} : { readonly: true })}</ol>
                ${inputRow}
            </div>`;
    }

    flipElements() {
        return [this.flipStatic, this.flipFlap, this.flipCurl, this.flipShadow, this.flipCrease];
    }

    stopFlipAnim() {
        if (this.flipAnim) {
            cancelAnimationFrame(this.flipAnim);
            this.flipAnim = null;
        }
    }

    scheduleFlipFrame(current) {
        this.pendingFlipFrame = current;
        if (this.flipFrameRaf) return;
        const scheduledAt = performance.now();
        this.flipFrameRaf = requestAnimationFrame(() => {
            this.flipFrameRaf = null;
            const frame = this.pendingFlipFrame;
            this.pendingFlipFrame = null;
            // 帧预算自适应：rAF 排队间隔持续超过 34ms（<30fps，低端真机上
            // clip-path 逐帧重绘的开销）时进入降级——跳过装饰层（卷曲光影/
            // 羽化落影/折痕亮线三件套）的更新，只保留核心翻页（动页裁剪 +
            // 纸背镜像），paint 面积砍掉近半；帧率恢复后自动退出，观感回升。
            const interval = performance.now() - scheduledAt;
            this.flipSlowFrames = interval > 34 ? Math.min(6, this.flipSlowFrames + 1) : Math.max(0, this.flipSlowFrames - 2);
            this.flipFrameBudget = this.flipSlowFrames >= 2 ? 1 : 0;
            if (frame) this.applyFlipFrame(frame);
        });
    }

    stopFlipFrame() {
        if (this.flipFrameRaf) cancelAnimationFrame(this.flipFrameRaf);
        this.flipFrameRaf = null;
        this.pendingFlipFrame = null;
    }

    hideFlipLayers() {
        this.stopFlipAnim();
        this.stopFlipFrame();
        this.pager?.classList.remove('is-flipping');
        for (const layer of this.flipElements()) {
            if (!layer) continue;
            layer.hidden = true;
            layer.style.clipPath = '';
            layer.style.transform = '';
            layer.style.left = '';
            layer.style.width = '';
            layer.style.opacity = '';
        }
        if (this.flipStatic) this.flipStatic.innerHTML = '';
        if (this.flipFlap) this.flipFlap.innerHTML = '';
    }

    beginFlip(current) {
        const targetPage = this.pageAt(current.dir === 'older' ? -1 : 1);
        if (!targetPage || !this.pager || !this.flipStatic || !this.flipFlap) {
            current.invalid = true;
            return;
        }
        const targetDay = targetPage.day;
        current.targetPage = targetPage;
        // 动页：older 掀起的是当前页（露出底下的目标页），newer 拉回来盖的是目标页
        const movingPage = current.dir === 'older' ? this.currentPage() : targetPage;
        const isHistory = movingPage.day !== localDayKey();
        const cardHtml = this.buildFlipCardHtml(movingPage);
        for (const layer of [this.flipStatic, this.flipFlap]) {
            layer.hidden = false;
            layer.innerHTML = cardHtml;
            layer.classList.toggle('is-history', isHistory);
            layer.style.clipPath = '';
            layer.style.transform = '';
        }
        if (current.dir === 'older') {
            // 掀页前先把目标整卡（含页眉）铺进文档流底层，随折痕推进逐渐露出
            this.applyPageToBase(targetPage);
            this.setEyebrow(targetPage);
            this.setHeaderStats(targetDay);
        }
        this.flipCurl?.classList.toggle('is-toward-right', current.dir === 'older');
        this.flipCurl?.classList.toggle('is-toward-left', current.dir === 'newer');
        for (const layer of this.flipElements()) {
            if (layer) layer.hidden = false;
        }
        this.pager?.classList.add('is-flipping');
        this.applyFlipFrame(current);
    }

    // 每帧渲染：折痕位置由滑动进度直接驱动，older 从左缘扫向右缘，
    // newer 从右缘拉回左缘。卷起窄条宽度随进度呈正弦起伏（起手与落页时
    // 收拢为 0），投影恒在纸面内。
    applyFlipFrame(current) {
        const width = Math.max(1, current.box?.width || this.pager?.clientWidth || 1);
        const dir = current.dir;
        const p = Math.max(0, Math.min(1, current.progress || 0));
        const crease = (dir === 'older' ? p : 1 - p) * width;
        const curl = width * FLIP_CURL_RATIO * Math.sin(Math.PI * p);
        const feather = Math.min(width * FLIP_FEATHER_RATIO, 56);
        const strength = Math.min(1, curl / (width * 0.1));

        if (this.flipStatic) {
            // 未掀部分：折痕一侧的动页正脸
            this.flipStatic.hidden = false;
            this.flipStatic.style.clipPath = crease >= width - 0.5
                ? 'inset(0 0 0 100%)'
                : `inset(0 0 0 ${crease.toFixed(2)}px)`;
        }
        if (this.flipFlap) {
            // 纸背：local 坐标里裁出折痕旁的窄条，再绕折痕线反射到对侧
            const localLeft = dir === 'older' ? crease - curl : crease;
            this.flipFlap.hidden = false;
            this.flipFlap.style.clipPath = curl > 0.5
                ? `inset(0 ${(width - localLeft - curl).toFixed(2)}px 0 ${Math.max(0, localLeft).toFixed(2)}px)`
                : 'inset(0 0 0 100%)';
            this.flipFlap.style.transform = `translate3d(${(2 * crease).toFixed(2)}px, 0, 0) scaleX(-1)`;
        }
        if (this.flipShadow) {
            this.flipShadow.hidden = this.flipFrameBudget ? true : false;
            if (!this.flipFrameBudget) {
                this.flipShadow.style.left = `${(crease - feather).toFixed(2)}px`;
                this.flipShadow.style.width = `${(feather * 2).toFixed(2)}px`;
                this.flipShadow.style.opacity = strength.toFixed(3);
            }
        }
        if (this.flipCrease) {
            // 折痕亮线很细（3px），paint 成本可忽略，降级时也保留——落页方向感靠它。
            this.flipCrease.hidden = false;
            this.flipCrease.style.left = `${(crease - 1.5).toFixed(2)}px`;
            this.flipCrease.style.width = '3px';
            this.flipCrease.style.opacity = strength.toFixed(3);
        }
        if (this.flipCurl) {
            this.flipCurl.hidden = this.flipFrameBudget ? true : false;
            if (!this.flipFrameBudget) {
                this.flipCurl.style.left = `${(dir === 'older' ? crease : crease - curl).toFixed(2)}px`;
                this.flipCurl.style.width = `${Math.max(0, curl).toFixed(2)}px`;
                this.flipCurl.style.opacity = curl > 0.5 ? '1' : '0';
            }
        }
    }

    animateFlipRelease(current) {
        this.stopFlipFrame();
        const from = current.progress || 0;
        const target = current.ready ? 1 : 0;
        const distance = Math.abs(target - from);
        const apply = t => {
            current.progress = from + (target - from) * t;
            this.applyFlipFrame(current);
        };
        const duration = prefersReducedMotion() ? 0 : Math.max(120, Math.round(FLIP_RELEASE_MS * distance));
        if (duration <= 0) {
            apply(1);
            this.finishFlip(current);
            return;
        }
        this.stopFlipAnim();
        const startedAt = performance.now();
        const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
        const step = now => {
            const t = Math.min(1, (now - startedAt) / duration);
            apply(easeOutCubic(t));
            if (t < 1) {
                this.flipAnim = requestAnimationFrame(step);
                return;
            }
            this.flipAnim = null;
            this.finishFlip(current);
        };
        this.flipAnim = requestAnimationFrame(step);
    }

    finishFlip(current) {
        if (current.ready && current.targetPage) {
            this.viewDay = current.targetPage.day;
            this.viewPageIndex = current.targetPage.index;
        }
        this.hideFlipLayers();
        this.render();
    }

    itemsForDay(day) {
        const today = localDayKey();
        return this.items.filter(item => (item.day || today) === day);
    }

    applyPageToBase(page) {
        const isToday = page.day === localDayKey();
        const dayItems = this.itemsForDay(page.day);
        const items = page.indexes.map(index => dayItems[index]).filter(Boolean);
        if (this.list) this.list.innerHTML = renderTodayDrafts(items, isToday ? {} : { readonly: true });
        this.base?.classList.toggle('is-history', !isToday);
    }

    activate() {
        this.isActive = true;
        void this.refreshWindowDrafts();
        this.toggleButton?.classList.add('active');
        this.scheduleDayBoundary();
    }

    deactivate() {
        this.isActive = false;
        this.toggleButton?.classList.remove('active');
        this.hideFlipLayers();
        this.pagerInteraction = null;
        if (this.pager) {
            this.pager.style.transform = '';
            this.pager.style.transition = '';
        }
        clearTimeout(this.dayTimer);
        this.dayTimer = null;
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
        // Leaving the Today tab must not strand a pending edit in the outbox
        // (the timer above may have been the only thing about to send it).
        // Flush now; retryOutbox is idempotent and safe to run in background.
        if (this.outbox.load().length > 0) this.retryOutbox();
    }

    async refreshWindowDrafts() {
        const state = this.store.load();
        this.items = state.items;
        this.render();
        try {
            const remote = await this.apiClient.list();
            this.mergeRemoteItems(remote?.items);
            await this.retryOutbox();
        } catch (error) {
            console.info('Today drafts are currently using local storage:', error?.message || error);
        }
    }

    // Global-search jump: search covers the whole 3-day window, so the target
    // may live on a history page — switch the pager to that day, then flash
    // the row. The caller (app.js) is responsible for navigating to the
    // today workspace first; activate() synchronously renders the local
    // store, so items are populated by the time this runs.
    async revealDraftById(targetId) {
        const id = String(targetId || '').trim();
        if (!id) throw new Error('revealDraftById requires an id');
        if (!this.items.some(item => item.id === id)) {
            await this.refreshWindowDrafts();
        }
        const draft = this.items.find(item => item.id === id);
        if (!draft) throw new Error('该草稿已不存在');

        const day = draft.day || localDayKey();
        if (this.viewDay !== day) {
            this.viewDay = day;
            this.render();
        }
        // 一屏只渲染当前页的行，同一天更早页上的记录要先落到它所在的那一页。
        this.goToDraft(id);
        const row = this.base?.querySelector(`[data-today-draft-id="${CSS.escape(id)}"]`);
        if (!row) throw new Error('无法定位该草稿');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('reveal-focus');
        setTimeout(() => row.classList.remove('reveal-focus'), 1800);
        return true;
    }

    scheduleDayBoundary() {
        clearTimeout(this.dayTimer);
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setHours(24, 0, 2, 0);
        this.dayTimer = setTimeout(() => {
            // 跨日不再清空：窗口整体右移一天，只有滑出窗口的最老一天需要
            // 排队删除，昨天与前天降级为历史页。
            const windowKeys = new Set(dayWindowKeys());
            const stale = this.items.filter(item => !windowKeys.has(item.day || localDayKey()));
            this.items = this.items.filter(item => windowKeys.has(item.day || localDayKey()));
            stale.forEach(item => this.outbox.enqueueDelete(item));
            this.viewDay = localDayKey();
            this.viewPageIndex = 0;
            this.persist();
            this.render();
            if (stale.length > 0) this.scheduleSync(0);
            if (this.isActive) this.scheduleDayBoundary();
        }, Math.max(1000, nextDay.getTime() - now.getTime()));
    }

    add(text, { focus = false, afterId = null, keepView = false, completed = false } = {}) {
        const draft = createTodayDraft(text);
        draft.completed = completed === true;
        if (!draft.text && !focus) return null;
        if (afterId) {
            const index = this.items.findIndex(item => item.id === afterId);
            this.items.splice(index < 0 ? this.items.length : index + 1, 0, draft);
        } else {
            this.items.push(draft);
        }
        if (!keepView) this.viewDay = draft.day;
        this.persist();
        this.render();
        this.queueUpsert(draft, 0);
        if (this.input) {
            this.input.value = '';
            this.input.style.height = '';
        }
        // 新条目可能被排到下一页（当天写满时），跟着跳过去，否则用户会觉得
        // 「按了回车什么都没发生」。copyDraftToToday 传 keepView，留在历史页不打断浏览。
        if (!keepView) this.goToDraft(draft.id);
        if (focus) {
            requestAnimationFrame(() => this.beginEditingDraft(this.list?.querySelector(`[data-today-draft-id="${draft.id}"]`)));
        } else {
            this.input?.focus();
        }
        return draft;
    }

    addAfter(id) {
        return this.add('', { focus: true, afterId: id });
    }

    addImportedText(text) {
        return this.add(text);
    }

    // 历史页右滑：把同一行文本复制成一条今天的草稿，原记录留在历史日。
    // 完成状态原样保留；短暂高亮源行 + toast 作为落点反馈（不跳页，不打断浏览）。
    copyDraftToToday(id) {
        const item = this.items.find(candidate => candidate.id === id);
        if (!item) return null;
        const added = this.add(item.text, { keepView: true, completed: item.completed === true });
        if (!added) return null;
        this.flashCopiedRow(id);
        this.toaster?.show(item.completed ? '已重新加入今日草稿（已完成）' : '已重新加入今日草稿', 'success', false, 2200);
        return added;
    }

    // 历史页左滑：把文本转成一条 Thought（复用今天页的 onMoveToThought 回调），
    // 与「重新加入今日」对称——只复制不删除，历史行保留并闪一下确认。
    async copyDraftToThought(id) {
        const item = this.items.find(candidate => candidate.id === id);
        if (!item || this.movingDraftIds.has(id)) return false;
        this.movingDraftIds.add(id);
        try {
            const moved = await this.onMoveToThought({ ...item });
            if (moved) this.flashCopiedRow(id);
            return moved;
        } catch (error) {
            console.warn('Failed to copy historical draft into Thought:', error);
            return false;
        } finally {
            this.movingDraftIds.delete(id);
        }
    }

    flashCopiedRow(id) {
        requestAnimationFrame(() => {
            const row = this.list?.querySelector(`[data-today-draft-id="${id}"]`);
            if (!row) return;
            row.classList.add('is-copied');
            setTimeout(() => row.classList.remove('is-copied'), 900);
        });
    }

    update(id, patch, { render = true } = {}) {
        const item = this.items.find(candidate => candidate.id === id);
        if (!item) return;
        item.text = patch.text === undefined ? item.text : String(patch.text);
        item.completed = patch.completed === undefined ? item.completed : Boolean(patch.completed);
        item.updatedAt = Date.now();
        this.persist();
        this.queueUpsert(item, render ? 0 : 450);
        if (render) this.render();
    }

    remove(id) {
        const removed = this.items.find(item => item.id === id);
        this.items = this.items.filter(item => item.id !== id);
        this.persist();
        this.render();
        if (removed) {
            this.outbox.enqueueDelete(removed);
            this.scheduleSync(0);
        }
    }

    persist() {
        this.store.save({ day: localDayKey(), items: this.items });
    }

    queueUpsert(draft, delay) {
        this.outbox.enqueueUpsert(draft);
        this.scheduleSync(delay);
    }

    scheduleSync(delay = 350) {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.retryOutbox(), delay);
    }

    mergeRemoteItems(remoteItems) {
        const localById = new Map(this.items.map(item => [item.id, item]));
        const remoteById = new Map((Array.isArray(remoteItems) ? remoteItems : []).map(item => [item.id, item]));
        const merged = [];

        for (const remote of remoteById.values()) {
            const local = localById.get(remote.id);
            if (this.outbox.hasPending(remote.id) && local) {
                local.version = remote.version;
                local.day = remote.day;
                merged.push(local);
            } else {
                merged.push(remote);
            }
            localById.delete(remote.id);
        }

        for (const local of localById.values()) {
            merged.push(local);
            this.outbox.enqueueUpsert(local);
        }

        this.items = merged.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        this.persist();
        this.render();
    }

    async retryOutbox() {
        // A sync already running: remember that another run was requested and
        // let the in-flight one chain it in its finally block. Returning here
        // without rescheduling is what used to strand edits queued while a
        // request was in flight (the caller's timer had already fired).
        if (this.syncInFlight) {
            this.syncQueued = true;
            return;
        }
        if (this.outbox.load().length === 0) return;
        this.syncInFlight = true;
        this.syncQueued = false;
        try {
            const result = await this.outbox.retry(this.apiClient);
            for (const saved of result.saved) {
                if (saved.item.kind === 'delete') continue;
                const remote = saved.result?.draft;
                const index = this.items.findIndex(item => item.id === saved.item.draftId);
                if (!remote || index < 0) continue;
                if (Number(this.items[index].updatedAt) <= Number(saved.item.draft.updatedAt)) {
                    this.items[index] = remote;
                } else {
                    this.items[index].version = remote.version;
                    this.items[index].day = remote.day;
                }
            }
            this.persist();
            this.render();
        } catch (error) {
            console.info('Today drafts sync will retry later:', error?.message || error);
            // Network/server failure: nothing else will trigger a retry while
            // the user idles on the tab (ws_connected only fires on reconnect),
            // so schedule one ourselves. Backoff keeps this cheap while offline.
            if (this.outbox.load().length > 0) this.scheduleSync(3000);
        } finally {
            this.syncInFlight = false;
            if (this.syncQueued && this.outbox.load().length > 0) {
                this.syncQueued = false;
                this.scheduleSync(0);
            }
        }
    }

    handleSocketUpdate({ action, payload } = {}) {
        const draft = payload && typeof payload === 'object' ? payload : null;
        if (!draft?.id || this.outbox.hasPending(draft.id)) return;
        if (action === 'delete') {
            this.items = this.items.filter(item => item.id !== draft.id);
        } else if (dayWindowKeys().includes(draft.day || localDayKey())) {
            const index = this.items.findIndex(item => item.id === draft.id);
            if (index >= 0) this.items[index] = draft;
            else this.items.push(draft);
            this.items.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        }
        this.persist();
        this.render();
    }

    captureActiveDraftInput() {
        const input = document.activeElement?.matches?.('[data-today-draft-text]')
            ? document.activeElement
            : null;
        const row = input?.closest('[data-today-draft-id]');
        if (!input || !row || !this.list?.contains(input)) return null;
        return {
            id: row.dataset.todayDraftId,
            value: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            selectionDirection: input.selectionDirection
        };
    }

    restoreActiveDraftInput(state) {
        if (!state || !this.list) return;
        const row = [...this.list.querySelectorAll('[data-today-draft-id]')]
            .find(candidate => candidate.dataset.todayDraftId === state.id);
        const input = this.beginEditingDraft(row, { focus: false });
        if (!input) return;
        input.value = state.value;
        try {
            input.focus({ preventScroll: true });
        } catch {
            input.focus();
        }
        if (typeof state.selectionStart !== 'number' || typeof state.selectionEnd !== 'number') return;
        const start = Math.min(state.selectionStart, input.value.length);
        const end = Math.min(state.selectionEnd, input.value.length);
        try {
            input.setSelectionRange(start, end, state.selectionDirection || 'none');
        } catch {
            // Some browser input implementations do not accept a selection direction.
        }
    }

    beginEditingDraft(row, { focus = true } = {}) {
        if (!row) return null;
        const existingInput = row.querySelector('[data-today-draft-text]');
        if (existingInput) return existingInput;
        const display = row.querySelector('[data-today-draft-text-display]');
        if (!display) return null;
        const item = this.items.find(candidate => candidate.id === row.dataset.todayDraftId);
        // 行内编辑器用 textarea：编辑时与展示态一样自动换行，共用 44px 纸纹节奏。
        const editor = document.createElement('textarea');
        editor.className = 'today-draft-text';
        editor.rows = 1;
        editor.dataset.todayDraftText = '';
        editor.value = item?.text || '';
        editor.setAttribute('aria-label', '草稿内容');
        editor.autocomplete = 'off';
        display.replaceWith(editor);
        editor.style.height = 'auto';
        editor.style.height = `${Math.max(44, editor.scrollHeight)}px`;
        if (!focus) return editor;
        try {
            editor.focus({ preventScroll: true });
        } catch {
            editor.focus();
        }
        editor.setSelectionRange(editor.value.length, editor.value.length);
        return editor;
    }

    render() {
        if (this.isComposingDraft) {
            this.pendingRender = true;
            return;
        }
        // 翻页手势进行中不重铺底页：beginFlip 已把目标页整卡铺进底层等待露出，
        // 此时任何异步刷新（远端合并/outbox 回填）进来 render 都会把它刷回
        // 当前页，掀开的角底下露出同一页。先记账，手势结束 finishFlip 会重绘。
        if (this.pagerInteraction) {
            this.pendingRender = true;
            return;
        }
        const activeInput = this.captureActiveDraftInput();
        const today = localDayKey();
        this.measurePageModel();
        this.clampView();
        const page = this.currentPage() || this.pageList[0];
        this.viewDay = page.day;
        this.viewPageIndex = page.index;
        this.applyPageToBase(page);
        this.setEyebrow(page);
        this.restoreActiveDraftInput(activeInput);
        this.pendingRender = false;
        const todayItems = this.items.filter(item => (item.day || today) === today);
        this.writingArea?.classList.toggle('is-empty', todayItems.length === 0);
        this.setHeaderStats(this.viewDay);
        this.syncPageOverflow();
    }
}
