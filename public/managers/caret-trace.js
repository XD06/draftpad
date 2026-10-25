/**
 * 视线/光标不统一的真机取证记录器（仅 ?debugCaret=1 或 localStorage 开关时启用）。
 * 只在触发时刻起一小段逐帧采样（避免每帧量镜像反过来扰动被测时序）。
 * 导出为 JSON，经剪贴板回传；关闭时零开销（不起帧循环）。
 */
export const CARET_TRACE_FLAG_KEY = 'dumbpad_caret_trace';

export function isCaretTraceEnabled(search = globalThis.location?.search || '') {
    try {
        if (new URLSearchParams(String(search || '')).get('debugCaret') === '1') return true;
    } catch {
        // 忽略：回落到 localStorage 开关
    }
    try {
        return globalThis.localStorage?.getItem(CARET_TRACE_FLAG_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * 纯记录器：环形缓冲 + 跳变摘要。不碰 DOM，几何由调用方提供，
 * 因此时序结论能在 node/jsdom 里直接断言。
 */
export function createCaretTrace({
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    maxSamples = 2000,
} = {}) {
    const limit = Math.max(50, Number(maxSamples) || 2000);
    const samples = [];
    const events = [];
    const startedAt = now();

    const push = (buffer, entry) => {
        buffer.push(entry);
        if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    };
    const elapsed = () => +(now() - startedAt).toFixed(1);

    /** 只带跳变与事件的时间线，用于快速定位「哪一下、紧跟哪个事件」。 */
    const timeline = () => ({
        jumps: samples.filter(s => s.jump !== undefined).map(s => ({ ...s })),
        events: events.map(e => ({ ...e })),
    });

    /**
     * 导出全文。写成闭包而不是 `this.timeline()`：调用方常把它当回调取走
     * （`const dump = trace.export` / 传给按钮），脱离接收者时 this 会是
     * undefined，方法里再取 this 直接抛 TypeError。
     */
    const dump = () => JSON.stringify({
        startedAt: new Date().toISOString(),
        count: { samples: samples.length, events: events.length },
        timeline: timeline(),
        samples,
        events,
    });

    return {
        /** 标记一个链路事件（切换、vv 开合、归位执行、焦点变化…）。 */
        mark(label, fields = {}) {
            push(events, { t: elapsed(), label, ...fields });
        },

        /** 采一帧几何。 */
        sample(fields = {}) {
            const scrollTop = Math.round(Number(fields.scrollTop) || 0);
            const previous = samples.length ? samples[samples.length - 1] : null;
            const entry = {
                t: elapsed(),
                scrollTop,
                caretY: Number.isFinite(Number(fields.caretY)) ? Math.round(Number(fields.caretY)) : null,
                vvH: Math.round(Number(fields.viewportHeight) || 0),
                vvTop: Math.round(Number(fields.viewportOffsetTop) || 0),
                innerH: Math.round(Number(fields.innerHeight) || 0),
                max: Math.round(Number(fields.scrollHeight) || 0) - Math.round(Number(fields.clientHeight) || 0),
                mode: fields.mode || '?',
                focus: fields.focus || '',
            };
            // 跳变：相邻两帧滚动位移超阈值就标出来，省得人肉翻上千行找那一下。
            if (previous) {
                const delta = entry.scrollTop - previous.scrollTop;
                if (Math.abs(delta) > 40) entry.jump = delta;
            }
            push(samples, entry);
            return entry;
        },

        timeline,
        export: dump,

        reset() {
            samples.length = 0;
            events.length = 0;
        },
    };
}

/**
 * 光标行在**文档坐标**里的纵坐标。源码面用离屏镜像量（textarea 高度由内容
 * 撑开、自身不滚），渲染面用选区矩形。只在选区真的变了时调用，帧循环里
 * 用 `caretDocY - scrollTop` 换算视口坐标——每帧插拔镜像会把采样本身变成
 * 一次重排，扰动正是要测的时序。
 */
export function measureCaretDocumentY({ doc = document, win = window, textarea = null, scroller = null } = {}) {
    const scrollTop = Number(scroller?.scrollTop) || 0;
    if (textarea && textarea.isConnected) {
        const computed = win.getComputedStyle(textarea);
        const mirror = doc.createElement('div');
        const style = mirror.style;
        style.position = 'absolute';
        style.left = '-99999px';
        style.top = '0';
        style.visibility = 'hidden';
        style.pointerEvents = 'none';
        style.boxSizing = 'content-box';
        style.width = `${textarea.clientWidth}px`;
        style.font = computed.font;
        style.lineHeight = computed.lineHeight;
        style.letterSpacing = computed.letterSpacing;
        style.whiteSpace = 'pre-wrap';
        style.wordBreak = computed.wordBreak || 'normal';
        style.overflowWrap = computed.overflowWrap || 'break-word';
        style.padding = '0';
        mirror.textContent = textarea.value.slice(0, Number(textarea.selectionStart || 0));
        const marker = doc.createElement('span');
        marker.textContent = '\u200b';
        mirror.appendChild(marker);
        doc.body.appendChild(mirror);
        try {
            return Math.round(textarea.getBoundingClientRect().top + scrollTop
                + (parseFloat(computed.paddingTop) || 0) + marker.offsetTop);
        } finally {
            mirror.remove();
        }
    }
    const selection = win.getSelection?.();
    if (selection && selection.rangeCount) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (Number.isFinite(rect.top)) return Math.round(rect.top + scrollTop);
    }
    return null;
}

/**
 * 挂上真机采样。`burstFrames` 帧后自动停表，平时零开销。
 * 事件（切换、键盘、焦点、归位）都打点并起一段 burst。
 */
export function installCaretTrace({ editor, win = window, doc = document, trace = null, burstFrames = 130 } = {}) {
    const recorder = trace || createCaretTrace();
    const frames = Math.max(10, Number(burstFrames) || 130);
    const page = () => doc.scrollingElement || doc.documentElement;
    const inner = () => editor?.scroller || doc.querySelector('.typora-editor-shell .vditor-wysiwyg');
    // 与 getScrollContainer() 同判据：内层能滚就用内层，否则整页。
    const scroller = () => {
        const candidate = inner();
        return candidate && candidate.scrollHeight - candidate.clientHeight > 1 ? candidate : page();
    };

    let burst = 0;
    let caretDocY = null;
    let loopStarted = false;

    const refreshCaret = () => {
        const textarea = editor?.sourceMode ? (editor.getSourceTextarea?.() || null) : null;
        caretDocY = measureCaretDocumentY({ doc, win, textarea, scroller: scroller() });
        return caretDocY;
    };

    const takeSample = () => {
        const current = scroller();
        const vv = win.visualViewport;
        recorder.sample({
            scrollTop: current ? current.scrollTop : 0,
            scrollHeight: current ? current.scrollHeight : 0,
            clientHeight: current ? current.clientHeight : 0,
            viewportHeight: vv ? vv.height : win.innerHeight,
            viewportOffsetTop: vv ? vv.offsetTop : 0,
            innerHeight: win.innerHeight,
            // 整页滚动时 rect 已含 −scrollTop，换算成文档位后这里只做一次减法。
            caretY: caretDocY === null ? null : caretDocY - (Number(current?.scrollTop) || 0),
            mode: editor?.sourceMode ? 'source' : 'render',
            focus: doc.activeElement ? doc.activeElement.tagName.toLowerCase() : '',
        });
    };

    const startBurst = () => {
        burst = frames;
        if (loopStarted) return;
        loopStarted = true;
        const loop = () => {
            if (burst <= 0) { loopStarted = false; return; }
            burst -= 1;
            takeSample();
            win.requestAnimationFrame(loop);
        };
        win.requestAnimationFrame(loop);
    };

    const trigger = (label, fields = {}) => {
        recorder.mark(label, fields);
        refreshCaret();
        startBurst();
    };

    // 适配器侧打点：在实例上包一层同名方法，先记下调用时的几何，再转发给原型
    // （不写进 tiptap-editor.js，取证代码不进生产路径）。
    ['setSourceMode', 'scrollTextareaSelectionIntoView', 'scrollEditorCaretIntoView', 'restoreScrollFraction']
        .forEach(name => {
            if (typeof editor?.[name] !== 'function') return;
            const original = editor[name].bind(editor);
            editor[name] = (...args) => {
                trigger(`${name}.call`, {
                    scrollTop: Number(scroller()?.scrollTop) || 0,
                    caretDocY,
                    mode: editor.sourceMode ? 'source' : 'render',
                    focus: doc.activeElement ? doc.activeElement.tagName.toLowerCase() : '',
                });
                return original(...args);
            };
        });

    const vv = win.visualViewport;
    if (vv) {
        ['resize', 'scroll'].forEach(type => {
            vv.addEventListener(type, () => trigger(`vv.${type}`, {
                height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop),
                innerHeight: Math.round(win.innerHeight),
                keyboard: win.innerHeight - vv.height > 120,
            }), { passive: true });
        });
    }
    win.addEventListener('focusin', e => trigger('focusin', { to: e.target?.tagName?.toLowerCase?.() || '' }), { passive: true });
    win.addEventListener('focusout', e => trigger('focusout', { from: e.target?.tagName?.toLowerCase?.() || '' }), { passive: true });
    doc.addEventListener('selectionchange', () => { refreshCaret(); }, { passive: true });
    doc.getElementById('toggle-source-mode')?.addEventListener('click', () => {
        // 点击时还在旧面，先按旧面量一次；下一帧新面挂好后再量一次。
        trigger('toggle.click', { mode: editor?.sourceMode ? 'source' : 'render' });
        win.setTimeout(() => { refreshCaret(); startBurst(); }, 0);
    }, { passive: true });

    return {
        trace: recorder,
        trigger,
        refreshCaret,
        takeSample,
        readGeometry: () => ({
            scrollTop: Number(scroller()?.scrollTop) || 0,
            caretDocY,
            scroller: scroller() === page() ? 'page' : 'inner',
            mode: editor?.sourceMode ? 'source' : 'render',
        }),
    };
}
