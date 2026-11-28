/**
 * Tiptap Schema 扩展：批注、蓝色划线、高亮、时间标记与软换行。
 * 存储/渲染形态必须与旧 Vditor 适配器逐字节对齐（hybrid-editor.js 的
 * restoreAllRenderedMarks / renderInlineMarks 与 time-command.js），
 * roundtrip 兼容由 test/test_tiptap_roundtrip.js 固化，改动前先读它。
 */
import { Mark, Node, Extension, StarterKit, TaskList, TaskItem, InputRule, findParentNode, CodeBlockLowlight, Underline, PM, getMarkdownSpec } from './tiptap-runtime.js';
import { TIME_COMMAND, parseTimeMarkerText, buildTimeMarker } from './time-command.js';
import {
    buildCodeBlockNodeView,
    extractClipboardHtmlText,
    findCodeBlockWrapperFromEvent,
    reconcileCodeBlockDOM,
} from './tiptap-code-block-view.js';
import { buildTaskItemNodeView } from './tiptap-task-item-view.js';
import {
    clearTouchPointerActivity,
    markTouchPointerActivity,
    settleEditorFocusAfterAction,
} from './tiptap-pointer-focus.js';

const { Plugin, PluginKey, TextSelection } = PM.state;
const { Decoration, DecorationSet } = PM.view;

export const ANNOTATION_SPAN_STYLE = 'text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;';
export const DRAW_SPAN_STYLE = 'text-decoration:underline blue;text-decoration-thickness:2px;';
export const NOTE_LABEL_STYLE = 'color:#e74c3c;font-size:0.65em;margin-left:2px;';

export const TIME_KIND_LABELS = {
    create: '创建',
    update: '更新',
};

// 与 managers/time-command.js 的 TIME_MARKER_RE 保持一致（该正则未导出）。
const TIME_TOKEN_GLOBAL = /\[\[time:(?:(create|update)(?:@([1-4]))?:)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\]/g;
const TIME_TOKEN_AT = new RegExp(TIME_TOKEN_GLOBAL.source, 'y');
const ANNOTATION_TOKEN_AT = /==([^=\n]+?)==\{(?:用户批注:\s*)?([^}]*)\}/y;
const HIGHLIGHT_TOKEN_AT = /==([^=\n]+?)==/y;

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

function normalizeTimeKind(kind) {
    return kind === 'update' ? 'update' : 'create';
}

function normalizeTimeLevel(level) {
    const value = Number.parseInt(level, 10);
    if (!Number.isFinite(value)) return 1;
    return Math.min(4, Math.max(1, value));
}

/** 与 managers/time-command.js renderTimeMarkers 输出等价的时间标记 span。 */
export function buildTimeMarkerElement(token, kind, level, stamp, { draggable = false } = {}) {
    const normalizedKind = normalizeTimeKind(kind);
    const normalizedLevel = normalizedKind === 'update' ? normalizeTimeLevel(level) : 1;
    const label = TIME_KIND_LABELS[normalizedKind];
    const span = document.createElement('span');
    span.className = `md-time-marker is-${normalizedKind} is-level-${normalizedLevel}`;
    span.setAttribute('data-time-marker', 'true');
    span.setAttribute('data-time-kind', normalizedKind);
    span.setAttribute('data-time-level', String(normalizedLevel));
    span.setAttribute('data-time-source', token);
    span.setAttribute('data-time-label', label);
    span.setAttribute('data-time-stamp', stamp);
    span.setAttribute('title', `${label}时间：${stamp}`);
    span.setAttribute('aria-label', `${label}时间：${stamp}`);
    span.textContent = token;
    if (draggable) span.setAttribute('data-time-draggable', 'true');
    return span;
}

/** 旧 annotationHtml / restoreAllRenderedMarks 的存储形态：span[data-note] + sub 标签。 */
export function buildAnnotationSourceHtml(markedText, comment) {
    const safeComment = escapeAttribute(comment || '');
    const label = escapeHtml(comment || '');
    return `<span data-note="${safeComment}" style="${ANNOTATION_SPAN_STYLE}">${markedText}</span><sub data-note-label style="${NOTE_LABEL_STYLE}">（${label}）</sub>`;
}

/** 渲染态批注元素（parse/装饰共用的等价物）。 */
export function buildAnnotationElement(text, comment) {
    const span = document.createElement('span');
    span.className = 'has-annotation';
    span.setAttribute('data-note', comment);
    span.setAttribute('data-comment', comment);
    span.setAttribute('style', ANNOTATION_SPAN_STYLE);
    span.textContent = text;
    return span;
}

/**
 * 把 markdown-it 渲染后仍留在文本节点里的 ==高亮== / ==文本=={用户批注: …}
 * 源码 token 替换为渲染元素。跳过 pre/code 内部。
 */
function replaceHighlightTokens(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const targets = [];
    let textNode = walker.nextNode();
    while (textNode) {
        const value = textNode.nodeValue || '';
        if (!textNode.parentElement?.closest?.('pre, code') && value.includes('==')) {
            targets.push(textNode);
        }
        textNode = walker.nextNode();
    }
    for (const textNode of targets) {
        const value = textNode.nodeValue || '';
        const parts = splitInlineSourceTokens(value);
        if (!parts.changed) continue;
        const fragment = document.createDocumentFragment();
        for (const part of parts.nodes) {
            if (part.type === 'text') {
                fragment.appendChild(document.createTextNode(part.text));
            } else if (part.type === 'highlight') {
                fragment.appendChild(document.createElement('mark')).textContent = part.text;
            } else if (part.type === 'annotation') {
                fragment.appendChild(buildAnnotationElement(part.text, part.note));
            }
        }
        textNode.parentNode.replaceChild(fragment, textNode);
    }
}

/** 把一段文本切分为 text/highlight/annotation 片段（时间 token 由独立扫描处理）。 */
export function splitInlineSourceTokens(value) {
    const nodes = [];
    let changed = false;
    let cursor = 0;
    const pushText = (start, end) => {
        if (start < end) nodes.push({ type: 'text', text: value.slice(start, end) });
    };
    while (cursor < value.length) {
        const rest = value.slice(cursor);
        ANNOTATION_TOKEN_AT.lastIndex = 0;
        const annotationMatch = ANNOTATION_TOKEN_AT.exec(rest);
        if (annotationMatch) {
            pushText(cursor, cursor + annotationMatch.index);
            nodes.push({ type: 'annotation', text: annotationMatch[1], note: annotationMatch[2] || '' });
            cursor += annotationMatch.index + annotationMatch[0].length;
            changed = true;
            continue;
        }
        HIGHLIGHT_TOKEN_AT.lastIndex = 0;
        const highlightMatch = HIGHLIGHT_TOKEN_AT.exec(rest);
        if (highlightMatch) {
            pushText(cursor, cursor + highlightMatch.index);
            nodes.push({ type: 'highlight', text: highlightMatch[1] });
            cursor += highlightMatch.index + highlightMatch[0].length;
            changed = true;
            continue;
        }
        const nextEq = rest.indexOf('=', 1);
        const skip = nextEq === -1 ? rest.length : nextEq;
        pushText(cursor, cursor + skip);
        cursor += skip;
    }
    return { changed, nodes };
}

/** [[time:*]] 文本节点 → md-time-marker 元素。 */
export function replaceTimeMarkerTokens(element, { draggable = false } = {}) {
    TIME_TOKEN_GLOBAL.lastIndex = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node = walker.nextNode();
    while (node) {
        const value = node.nodeValue || '';
        if (!node.parentElement?.closest?.('pre, code') && value.includes('[[')) targets.push(node);
        node = walker.nextNode();
    }
    for (const textNode of targets) {
        const value = textNode.nodeValue || '';
        TIME_TOKEN_GLOBAL.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let match;
        while ((match = TIME_TOKEN_GLOBAL.exec(value))) {
            if (match.index > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)));
            const kind = match[1] === 'update' ? 'update' : 'create';
            const level = kind === 'update' ? match[2] || 1 : 1;
            fragment.appendChild(buildTimeMarkerElement(match[0], kind, level, match[3], { draggable }));
            cursor = TIME_TOKEN_GLOBAL.lastIndex;
        }
        if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
        if (cursor > 0) textNode.parentNode.replaceChild(fragment, textNode);
    }
}

/** 旧 <mark note> 形态与 span[data-note] 存储形态的 DOM 归一化。 */
export function normalizeAnnotationElements(element) {
    element.querySelectorAll('mark[note]').forEach((mark) => {
        mark.replaceWith(buildAnnotationElement(mark.textContent || '', mark.getAttribute('note') || ''));
    });
    element.querySelectorAll('span[data-note]').forEach((span) => {
        const comment = span.getAttribute('data-note') || span.getAttribute('data-comment') || '';
        span.classList.add('has-annotation');
        span.setAttribute('data-comment', comment);
        span.setAttribute('style', `${ANNOTATION_SPAN_STYLE}display:inline;`);
        span.querySelector?.('.annotation-badge')?.remove();
        const next = span.nextElementSibling;
        if (next?.tagName === 'SUB' && (next.hasAttribute('data-note-label') || (next.textContent || '').startsWith('（'))) {
            next.remove();
        }
    });
}

/** 依次执行全部行内源码归一化（parse.updateDOM 共用入口）。 */
export function normalizeMarkdownDom(element) {
    replaceTimeMarkerTokens(element);
    replaceHighlightTokens(element);
    normalizeAnnotationElements(element);
    return element;
}

/**
 * 批注气泡徽标的图形（与旧 Vditor hybrid-editor 注入的完全一致）。
 * 徽标是**纯显示元素**：只存在于编辑器渲染态，Markdown 序列化走
 * AnnotationMark 的 markdown.serialize open/close，不经过 renderHTML，
 * 所以它永远不进正文（复制全文时 app.js 也有 .annotation-badge 的兜底清理）。
 */
export const ANNOTATION_BADGE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

/** 每次调用返回一个新节点：DOMOutputSpec 里的 Node 会被搬进 DOM，不能复用实例。 */
export function createAnnotationBadge() {
    const badge = document.createElement('span');
    badge.className = 'annotation-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = ANNOTATION_BADGE_SVG;
    return badge;
}

export const AnnotationMark = Mark.create({
    name: 'annotation',

    /**
     * 必须高于 Link 的 priority（1000）：Tiptap 按 priority 降序摊平扩展后建 schema，
     * 而 PM 渲染行内 mark 时按 **schema rank 排序取共同前缀** 决定开闭元素。annotation
     * 的 rank 排在 link 之后时，一条覆盖链接的批注会在 `<a>` 前后各断一次——渲染成
     * 三个 .has-annotation + 三个徽标，序列化还把 `<sub>（批注）</sub>` 写进链接的
     * label 里（`[<span data-note>…</span><sub>…</sub>](url)`）。排到最前才是批注
     * 包住链接。跨行内代码靠的是 code.excluded 豁免（tiptap-editor.js 的 create 钩子），
     * 与本条无关，两者都要。
     */
    priority: 1100,

    inclusive: false,

    addAttributes() {
        return {
            note: {
                default: '',
                parseHTML: (element) => element.getAttribute('data-note') ?? element.getAttribute('data-comment') ?? '',
            },
        };
    },

    parseHTML() {
        return [
            { tag: 'span[data-note]' },
            { tag: 'span.has-annotation' },
        ];
    },

    renderHTML({ mark }) {
        // 渲染态结构（与旧 Vditor 的显示层一致）：外层 .has-annotation 负责定位与
        // data-note/data-comment，内层 span 承担波浪线并持有内容洞，徽标作为它的兄弟
        // 节点挂在末尾。PM 规定「内容洞必须是父节点的唯一的子节点」，所以徽标不能与
        // 洞平级放在外层——必须包一层。Markdown 序列化不经过这里（见 addStorage），
        // 徽标因此不会进正文。
        return ['span', {
            class: 'has-annotation',
            'data-note': mark.attrs.note,
            'data-comment': mark.attrs.note,
            style: 'display:inline;',
        }, ['span', { style: ANNOTATION_SPAN_STYLE }, 0], createAnnotationBadge()];
    },

    addStorage() {
        return {
            markdown: {
                serialize: {
                    open: (_state, mark) => `<span data-note="${escapeAttribute(mark.attrs.note)}" style="${ANNOTATION_SPAN_STYLE}">`,
                    close: (_state, mark) => `</span><sub data-note-label style="${NOTE_LABEL_STYLE}">（${escapeHtml(mark.attrs.note)}）</sub>`,
                    mixable: false,
                    expelEnclosingWhitespace: true,
                },
                parse: {
                    updateDOM: (element) => normalizeAnnotationElements(element),
                },
            },
        };
    },
});

export const DrawMark = Mark.create({
    name: 'draw',

    /**
     * 高于 Link（1000）、低于 annotation（1100），理由与批注那条同构：PM 渲染行内 mark 时
     * 按 **schema rank 排序取共同前缀** 决定开闭元素，默认 priority 100 让 draw 排在
     * link / bold / code 之后，于是「一次画线跨过链接或加粗」被 `<a>`、`<strong>` 前后各断
     * 一次，渲染成多个 `<span data-draw>` 段；序列化再叠加 expelEnclosingWhitespace 把段间
     * 空格留在 span 外面，刷新后 `getMarkRange` 只能沿连续段展开——取消一次只去掉一段，
     * 而不是用户当初那一个整体。抬到 Link 之上后一次选区收成单 span、取消一次清干净。
     * 排在 annotation 之下是刻意的：批注必须始终是最外层（徽标与 `<sub>` 标签的归属靠它）。
     * 跨过行内代码靠的是 code.excluded 豁免（`tiptap-editor.js` 的 create 钩子），与 priority
     * 是两条独立机制；代码 chip 的自身样式不丢——code mark 仍在那段文字上，只是被外层 span
     * 包住（实测 `<span data-draw>甲<code>乙</code>丙</span>`）。
     */
    priority: 1090,

    parseHTML() {
        return [{ tag: 'span[data-draw]' }];
    },

    renderHTML() {
        return ['span', { 'data-draw': 'true', style: DRAW_SPAN_STYLE }, 0];
    },

    addStorage() {
        return {
            markdown: {
                serialize: {
                    open: `<span data-draw style="${DRAW_SPAN_STYLE}">`,
                    close: '</span>',
                    mixable: false,
                    expelEnclosingWhitespace: true,
                },
                parse: {},
            },
        };
    },
});

/**
 * 「纯下划线」判定：只有 text-decoration 的值就是 underline 本身才算下划线格式。
 *
 * 为什么要自己收窄：Tiptap 的 Underline 用的是 `value.includes('underline')`，而 PM 的
 * style 规则是**按规则名去查 inline style 的 getPropertyValue**（prosemirror-model 的
 * matchingStyles，注释里明说简写属性在 style.item 里会被拆成长属性、所以直接查名字）。
 * 浏览器查 `text-decoration` 时会把长属性重新序列化回简写：实测 Chrome 对批注的
 * `text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px` 返回
 * ——两者都含 'underline'，于是被额外套上 underline mark。后果不只是多一条直线：
 * **`<u>` 会被写回正文**（存进去是 `<span data-note=…>`，刷新一次再保存就变成
 * `<u><span data-note=…></u>`）。
 *
 * 实测（Chrome 153）逐条形态：`underline` → `underline`；`underline solid` → `underline`；
 * `underline wavy` → `underline wavy`；`underline solid red` → `underline red`；
 * 只写长属性 `text-decoration-line: underline` → **空串**（查不到就不进规则）。
 * 也就是说把存储样式改写成长属性能躲开这条规则，但那要换掉批注 / 划线的存储形态，
 * 而且救不了已经被污染成 `<u>` 的老文章，所以仍然在解析判定上收窄。
 *
 * 因此带颜色 / 粗细 / 线型（wavy、dashed、dotted）的装饰一律不当作 underline：那是批注、
 * 划线或外部富文本的语义，不是「正文加下划线」。`solid` 是初始值，允许显式写出来。
 * 已知取舍：外部粘贴来的 `underline red` / `underline double` / `underline overline`
 * 不再被识别为下划线（`<u>` 标签与纯 `underline` 照常）。
 */
function isPlainUnderlineStyle(value) {
    const tokens = String(value).trim().toLowerCase().split(/\s+/)
        .filter(token => token && token !== 'solid');
    return tokens.length === 1 && tokens[0] === 'underline';
}

/**
 * 识别上面那个 bug 在老文章里留下的 `<u>`：它自己没有正文文字，内容全是批注 / 划线的
 * span（外加批注的 `<sub>` 说明标签，它在归一化时会被吃掉）。这种 `<u>` 是纯残留，
 * 不再解析成 underline，下次保存自然消失——不需要迁移数据。
 * 只要 `<u>` 里还有自己的文字，就按「用户真的给这段加了 下划线」处理，照常解析。
 *
 * 判定是**保守**的：只认这个 bug 实际产出的扁平形态。`<u><em><span data-note>…`、`<u>` 里夹
 * `<br>` 或嵌套 `<u>` 时会放过（残留不清，那条直线还在），因为反向误判的代价是删掉用户真的
 * 下划线，代价更大；放过的残留用户可以选中那段按 Mod+U 取消。边界由回归 §10 固化。
 */
function isDecorationArtifactUnderline(element) {
    const children = element?.children;
    if (!children || !children.length) return false;
    const nodes = element.childNodes || [];
    for (let index = 0; index < nodes.length; index += 1) {
        if (nodes[index].nodeType === 3 && nodes[index].textContent.trim()) return false;
    }
    for (let index = 0; index < children.length; index += 1) {
        if (!children[index].matches?.('span[data-note], span[data-draw], sub[data-note-label]')) {
            return false;
        }
    }
    return true;
}

/**
 * 覆盖 StarterKit 的 Underline（tiptap-editor.js 里 `underline: false` 关掉原版），
 * 只改 parseHTML，其余（renderHTML `<u>`、commands、Mod+U、markdown 位）全部继承。
 * 两条规则都要：tag 规则负责清掉已被污染的老数据，style 规则负责不再制造新污染。
 */
export const DumbPadUnderline = Underline.extend({
    parseHTML() {
        return [
            // PM 语义：getAttrs 返回 false 会跳过这条规则（元素内容照常解析，等于把 <u> 拆掉），
            // 返回 null 则按无属性应用 mark。
            { tag: 'u', getAttrs: (element) => (isDecorationArtifactUnderline(element) ? false : null) },
            {
                style: 'text-decoration',
                consuming: false,
                getAttrs: (value) => (isPlainUnderlineStyle(value) ? {} : false),
            },
        ];
    },
});

export const MdHighlight = Mark.create({
    name: 'mdHighlight',

    /**
     * 与 DrawMark 同一条理由（见那里的注释），只是层级低一档：批注 1100 > 划线 1090 >
     * 高亮 1080 > Link 1000，保证高亮不会盖到批注/划线的 span 外面去。抬之前一次高亮跨
     * 链接会被拆成多个 `<mark>`，刷新后取消一次只去掉其中一段。
     */
    priority: 1080,

    parseHTML() {
        return [{ tag: 'mark' }];
    },

    renderHTML() {
        return ['mark', { class: 'md-mark' }, 0];
    },

    addStorage() {
        return {
            markdown: {
                serialize: {
                    open: '<mark>',
                    close: '</mark>',
                    mixable: true,
                },
                parse: {
                    updateDOM: (element) => replaceHighlightTokens(element),
                },
            },
        };
    },
});

export const TimeMarkerNode = Node.create({
    name: 'timeMarker',

    inline: true,
    atom: true,
    group: 'inline',
    draggable: true,

    addAttributes() {
        return {
            source: { default: '', parseHTML: (element) => element.getAttribute('data-time-source') || '' },
            kind: { default: 'create', parseHTML: (element) => element.getAttribute('data-time-kind') || 'create' },
            level: { default: 1, parseHTML: (element) => normalizeTimeLevel(element.getAttribute('data-time-level')) },
            stamp: { default: '', parseHTML: (element) => element.getAttribute('data-time-stamp') || '' },
            label: { default: '创建', parseHTML: (element) => element.getAttribute('data-time-label') || '创建' },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-time-marker]' }];
    },

    renderHTML({ node }) {
        const kind = normalizeTimeKind(node.attrs.kind);
        const level = kind === 'update' ? normalizeTimeLevel(node.attrs.level) : 1;
        const label = TIME_KIND_LABELS[kind];
        return ['span', {
            class: `md-time-marker is-${kind} is-level-${level}`,
            'data-time-marker': 'true',
            'data-time-kind': kind,
            'data-time-level': String(level),
            'data-time-source': node.attrs.source,
            'data-time-label': label,
            'data-time-stamp': node.attrs.stamp,
            title: `${label}时间：${node.attrs.stamp}`,
            'aria-label': `${label}时间：${node.attrs.stamp}`,
        }, node.attrs.source];
    },

    addStorage() {
        return {
            markdown: {
                serialize: (state, node) => {
                    state.write(node.attrs.source || '');
                },
                parse: {
                    updateDOM: (element) => replaceTimeMarkerTokens(element),
                },
            },
        };
    },
});

/**
 * 光标与「链接文本」的位置关系（绝对位置）。link mark 是 inclusive 的，所以光标
 * 落在链接内部、或贴在链接左右边界时，活跃 mark 里都带着 link。无链接则返回 null。
 */
function linkRunRelation(state) {
    const linkType = state.schema.marks.link;
    if (!linkType) return null;
    const selection = state.selection;
    if (!selection.empty) return null;
    const $from = selection.$from;
    const marks = selection.storedMarks || $from.marks();
    if (!marks.some(mark => mark.type === linkType)) return null;
    const base = $from.start();
    const offset = $from.parentOffset;
    let start = 0;
    for (let index = 0; index < $from.parent.childCount; index += 1) {
        const child = $from.parent.child(index);
        const end = start + child.nodeSize;
        if (linkType.isInSet(child.marks)) {
            if (offset > start && offset < end) return { mode: 'inside', end: base + end };
            if (offset === end) return { mode: 'edge', pos: base + end };
            if (offset === start) return { mode: 'edge', pos: base + start };
        }
        start = end;
    }
    return { mode: 'outside' };
}

/**
 * 插入段内软换行（Enter / Shift-Enter / Mod-Enter 共用）。光标与链接有关时必须特殊
 * 处理：`replaceSelectionWith` 默认让插入的节点继承光标处的活跃 mark，链接里的活跃
 * mark 就是 link——于是 `<br>` 落进 `<a>` 里（附件 chip 是 inline-flex，被撑成一整块
 * 空白，多次回车越来越高），或者把链接劈成两个 `<a>`。两种都会把换行写进 markdown 的
 * 链接 label（`[甲\n乙](url)`），重新解析后链接语法就坏了——是数据损坏，不只是视觉问题。
 * 规则：光标在链接文本内部 → 换行放到整条链接之后、光标跟到换行后面（用户按回车想要
 * 的是「下一行」，而不是把 label 剪开）；光标贴在链接边界 → 位置不变，但不继承 link mark。
 */
function insertSoftBreak(state, dispatch, nodeType) {
    if (!nodeType) return false;
    const relation = linkRunRelation(state);
    if (!dispatch) return true;
    if (relation?.mode === 'inside') {
        const tr = state.tr.insert(relation.end, nodeType.create());
        tr.setSelection(TextSelection.create(tr.doc, relation.end + 1));
        dispatch(tr.scrollIntoView());
        return true;
    }
    // 与链接无关时保持原行为（继承光标处的活跃 mark）；贴在链接边界时位置不变，
    // 但不让 <br> 继承 link mark。
    const inheritMarks = relation?.mode !== 'edge';
    dispatch(state.tr.replaceSelectionWith(nodeType.create(), inheritMarks).scrollIntoView());
    return true;
}

/** 软换行：存储为段内单个换行符（与旧编辑器一致），段尾换行序列化时丢弃。 */
export const MdSoftBreak = Node.create({
    name: 'hardBreak',

    inline: true,
    group: 'inline',
    selectable: false,
    linebreakReplacement: true,

    /**
     * 软换行在"文本视图"里就是一个换行符。不声明 leafText 的话，PM 的 textContent /
     * textBetween 会把 <br> 塌缩成空串，两个后果：
     * 1) Tiptap 的 input rule runner 取"光标前文本"时（L0 → node.textContent）拿不到
     *    换行，改用 "%leaf%" 占位符拼串，并且和它自己的复核步骤（走 textBetween）对不上，
     *    于是**软回车之后所有带"行首或空白"前提的内联规则全部失效**——`**粗体**`、`_斜体_`
     *    会原样留在正文（实测：只有无前缀要求的 `` `code` `` 侥幸生效）。
     * 2) 从编辑器复制纯文本时段内换行丢失。
     *
     * 为什么写在 extendNodeSchema 而不是顶层字段：Tiptap 组装 PM NodeSpec 时用的是
     * 白名单（content/marks/group/inline/atom/selectable/draggable/code/whitespace/
     * linebreakReplacement/defining/isolating/attrs/parseDOM/toDOM），顶层 leafText
     * 会被直接丢弃（实测 schema.nodes.hardBreak.spec 里没有它）；而 extendNodeSchema
     * 的返回值在白名单**之前**被展开，是官方留的透传口子。该 hook 对每个节点都会跑一次，
     * 所以必须按 name 收窄，别把 leafText 塞给别的节点。
     *
     * 注意：Markdown 序列化不经过这里（见下面 addStorage.markdown.serialize），存储形态不变。
     */
    extendNodeSchema(node) {
        return node.name === 'hardBreak' ? { leafText: () => '\n' } : {};
    },

    parseHTML() {
        return [{ tag: 'br' }];
    },

    renderHTML() {
        return ['br'];
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Enter': () => this.editor.commands.setHardBreak(),
            'Shift-Enter': () => this.editor.commands.setHardBreak(),
        };
    },

    addCommands() {
        return {
            setHardBreak: () => ({ state, dispatch }) =>
                insertSoftBreak(state, dispatch, state.schema.nodes.hardBreak),
        };
    },

    addStorage() {
        return {
            markdown: {
                serialize: (state, node, parent, index) => {
                    for (let i = index + 1; i < parent.childCount; i += 1) {
                        if (parent.child(i).type !== node.type) {
                            state.write('\n');
                            return;
                        }
                    }
                },
                parse: {},
            },
        };
    },
});

/** /time 命令：普通段落内光标前恰为 "/time" 时，Enter 替换为时间标记节点。 */
export const TimeCommandShortcut = Extension.create({
    name: 'timeCommandShortcut',

    addProseMirrorPlugins() {
        return [
            new globalThis.DumbPadTiptap.PM.state.Plugin({
                props: {
                    handleKeyDown: (view, event) => {
                        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
                            return false;
                        }
                        const { state } = view;
                        const selection = state.selection;
                        if (!selection.empty || selection.$from.parent.type.name !== 'paragraph') return false;
                        const commandLength = TIME_COMMAND.length;
                        const textBefore = selection.$from.parent.textBetween(
                            Math.max(0, selection.$from.parentOffset - TIME_COMMAND.length),
                            selection.$from.parentOffset
                        );
                        if (textBefore !== TIME_COMMAND) return false;
                        const markerSource = buildTimeMarker(new Date(), 'create', 1);
                        const parsed = parseTimeMarkerText(markerSource);
                        if (!parsed) return false;
                        const node = state.schema.nodes.timeMarker.create({
                            source: parsed.source,
                            kind: parsed.kind,
                            level: parsed.level,
                            stamp: parsed.stamp,
                            label: parsed.label,
                        });
                        view.dispatch(state.tr.replaceWith(selection.from - TIME_COMMAND.length, selection.from, node));
                        return true;
                    },
                },
            }),
        ];
    },
});

/**
 * YAML frontmatter（--- 包裹的文档头）：解析为独立节点原样保存。
 * 旧 Vditor/Lute 把 frontmatter 渲染为代码块且序列化时不改写；Tiptap
 * 默认会把它拆成 thematic break + setext 标题，保存即破坏数据。
 */
export const FrontmatterNode = Node.create({
    name: 'frontmatter',

    priority: 1000,

    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    atom: false,

    parseHTML() {
        return [{ tag: 'pre[data-dumbpad-frontmatter]', contentElement: 'code' }];
    },

    renderHTML() {
        return ['pre', {
            'data-dumbpad-frontmatter': 'true',
            class: 'dumbpad-frontmatter',
        }, ['code', 0]];
    },

    addStorage() {
        return {
            markdown: {
                serialize(state, node) {
                    state.write('---\n');
                    state.text(node.textContent || '', false);
                    state.ensureNewLine();
                    state.write('---');
                    state.closeBlock(node);
                },
                parse: {
                    setup(markdownit) {
                        markdownit.block.ruler.before('hr', 'dumbpad_frontmatter', frontmatterRule);
                    },
                    updateDOM(element) {
                        element.querySelectorAll('code.language-dumbpad-frontmatter').forEach((code) => {
                            const pre = code.closest('pre');
                            if (pre) pre.setAttribute('data-dumbpad-frontmatter', 'true');
                        });
                    },
                },
            },
        };
    },
});

/** 首个块若为 --- 包裹的 YAML 头，转成 fence token（language-dumbpad-frontmatter）。 */
function frontmatterRule(state, startLine, endLine, silent) {
    if (startLine !== 0) return false;
    const firstLine = state.getLines(startLine, 1, 0).trim();
    if (firstLine !== '---') return false;
    let closing = -1;
    for (let line = startLine + 1; line < endLine; line += 1) {
        const lineStart = state.bMarks[line] + state.tShift[line];
        const lineEnd = state.eMarks[line];
        if (state.src.slice(lineStart, lineEnd).trim() === '---') {
            closing = line;
            break;
        }
    }
    if (closing === -1) return false;
    // 与 setValue 的 FRONTMATTER_LEAD_RE（`^---\n([\s\S]*?)\n---`）对齐：闭合的 ---
    // 必须独占一行且前面有内容行，所以 ---\n--- 这种「两条分隔线」不算 frontmatter，
    // 交回 hr 规则。否则粘贴与落盘映射会互相错开，解析结果在 --- 与围栏之间来回抖。
    if (closing < startLine + 2) return false;
    if (silent) return true;
    const token = state.push('fence', 'code', 0);
    token.info = 'dumbpad-frontmatter';
    token.markup = '---';
    token.content = state.getLines(startLine + 1, closing, 0, true);
    token.map = [startLine, closing + 1];
    state.line = closing + 1;
    return true;
}

const installedFrontmatterRules = new WeakSet();

/**
 * 把 frontmatter 块规则装进 markdown-it 的 block ruler——**粘贴路径靠它**。
 *
 * 为什么需要：`setValue` 有 `frontmatterToFence` 做预处理，粘贴走的是 tiptap-markdown
 * 的 `clipboardTextParser` → `parser.parse(text)` → `md.render()`，没有那层预处理。
 * 规则缺席时首个 `---` 解析成 `<hr>`、第二个被 setext 当成标题下划线吃掉，
 * 「---\ntitle: x\n---」落库变成 `<h2>title: x</h2>` 且少一行 `---`，保存即永久损坏。
 * 装上之后粘贴与 setValue 走同一条解析：`---` 块 → fence token
 * （language-dumbpad-frontmatter）→ 代码块，`getValue` 的 `fenceToFrontmatter` 再映射回原文。
 *
 * 与 DumbPadMixedTaskListGuard 同套路：只借 `storage.markdown.parse`，不新增节点。
 * 两点约束：
 * - `setup` 每次 parse 都会被重跑（tiptap-markdown 在 parse 里遍历扩展），所以必须
 *   按 markdownit 实例去重，否则 `__rules__` 随粘贴次数线性增长。
 * - 上面的 `FrontmatterNode`（独立节点方案）至今未注册，不要把它和这个一起注册——
 *   那会让 `---` 头同时有「fence 双轨」和「自有节点」两套互相冲突的解释。
 */
export const DumbPadFrontmatterParseRule = Extension.create({
    name: 'dumbpadFrontmatterParseRule',

    addStorage() {
        return {
            markdown: {
                parse: {
                    setup(markdownit) {
                        if (installedFrontmatterRules.has(markdownit)) return;
                        installedFrontmatterRules.add(markdownit);
                        markdownit.block.ruler.before('hr', 'dumbpad_frontmatter', frontmatterRule);
                    },
                },
            },
        };
    },
});

/**
 * 软换行的生效范围：`doc > paragraph` 与 `blockquote > paragraph`。
 * 标题/列表/表格/代码块仍走各自默认回车行为（和旧 handleWysiwygSoftEnter 一致）。
 */
function softBreakScope($pos) {
    if ($pos.parent.type.name !== 'paragraph') return null;
    if ($pos.depth === 1) return { inQuote: false };
    if ($pos.depth === 2 && $pos.node(1).type.name === 'blockquote') return { inQuote: true };
    return null;
}

/** 段落内光标所在「视觉行」的起止偏移：软换行 `<br>` 就是视觉行的分隔线。 */
function visualLineRange(para, parentOffset) {
    let start = 0;
    let end = -1;
    para.forEach((child, offset) => {
        if (child.type.name !== 'hardBreak') return;
        const childEnd = offset + child.nodeSize;
        if (childEnd <= parentOffset) start = childEnd;
        else if (offset >= parentOffset && end < 0) end = offset;
    });
    return { start, end: end < 0 ? para.content.size : end };
}

/** 当前视觉行是否空白（软换行插入的零宽保护字符算空白）。 */
function visualLineIsBlank(para, parentOffset) {
    const { start, end } = visualLineRange(para, parentOffset);
    return !para.textBetween(start, end).replace(/[\u200B\uFEFF]/g, '').trim();
}

/**
 * 引用块里在空行上按回车 = 退出引用块（Typora 式），并且不留游离空行：
 * 1) 这条空行如果是刚才那次回车造出来的软换行，先删掉它——段尾软换行本来就不写进
 *    源（`> 甲\n> ` 会被压回 `> 甲`），留在块尾只会让引用块显示成多一行空白；
 * 2) 段落整体空掉时把它从引用块里摘走（引用块只剩这一个空段落时整块撤掉）；
 * 3) 光标落到引用块下面的段落里——引用块后面必须真有一个可输入的段落，用户才感到
 *    「已经出去了」。
 * 全程一个事务，撤销一次就回到退出前的状态。
 */
function exitBlockquoteLine(state, view, $pos) {
    const { paragraph, hardBreak } = state.schema.nodes;
    if (!paragraph) return false;
    const depth = $pos.depth;
    const quoteDepth = depth - 1;
    const paraStart = $pos.before(depth);
    const paraEnd = $pos.after(depth);
    const quoteStart = $pos.before(quoteDepth);
    const quoteEnd = $pos.after(quoteDepth);
    const quote = $pos.node(quoteDepth);
    const para = $pos.parent;
    const paraIsBlank = !para.textContent.replace(/[\u200B\uFEFF]/g, '').trim();
    const tr = state.tr;
    if (paraIsBlank && quote.childCount === 1) {
        tr.replaceWith(quoteStart, quoteEnd, paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, quoteStart + 1));
        view.dispatch(tr.scrollIntoView());
        return true;
    }
    if (paraIsBlank) {
        tr.delete(paraStart, paraEnd);
    } else {
        const { start } = visualLineRange(para, $pos.parentOffset);
        if (start > 0) {
            // 段落内容从 paraStart + 1 起算（paraStart 指向段落节点自己的开标签）。
            const brPos = paraStart + start;
            const br = tr.doc.nodeAt(brPos);
            if (br && hardBreak && br.type === hardBreak) tr.delete(brPos, brPos + br.nodeSize);
        }
    }
    const afterQuote = tr.mapping.map(quoteEnd);
    const next = tr.doc.nodeAt(afterQuote);
    if (!next || next.type !== paragraph || next.textContent.trim()) {
        tr.insert(afterQuote, paragraph.create());
    }
    tr.setSelection(TextSelection.create(tr.doc, afterQuote + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
}

/** 引用块内的普通段落（软换行作用域之一）。 */
function isQuoteParagraph($pos) {
    return $pos.depth === 2 && $pos.parent.type.name === 'paragraph'
        && $pos.node(1).type.name === 'blockquote';
}

/**
 * 引用块内行首退格 = 并回上一行，而不是「整行抬出引用块」。
 * 两种情况：
 * 1. 同一引用块内还有上一段（老数据 `> 甲\n>\n> 乙`，回车曾经会拆段）——PM 默认的
 *    joinBackward 取的切点会越过引用块这一层，结果是抬出而不是并合，就是用户报的
 *    「退格退出区域」。这里显式并合同一引用块里的相邻两段。
 * 2. 这是引用块唯一的一段、上面正好是同类型的文本块（`前言` + `> 甲`）——PM 默认会把
 *    整段 lift 出去，变成两段之间多一个空行（用户报的「退格后出现空白行 + 退出区域」）。
 *    这里把「上一行 + 引用行」合成一个块替换掉引用块，引用壳随之消失。
 * 其余形态（多段引用的第一段、上面是标题等）仍交给默认行为。
 */
function joinQuoteParagraph(state, view, $pos) {
    const depth = $pos.depth;
    const { doc } = state;
    // index(depth - 1) 才是「这一段在引用块里的下标」；index(depth) 是段内子节点的下标。
    const index = $pos.index(depth - 1);

    if (index > 0) {
        const before = $pos.node(depth - 1).maybeChild(index - 1);
        if (!before || !before.isTextblock) return false;
        let tr;
        try {
            tr = state.tr.join($pos.before(depth));
        } catch (_error) {
            return false;
        }
        if (!tr.docChanged) return false;
        view.dispatch(tr.scrollIntoView());
        return true;
    }

    // 引用块的第一段：只有单段引用、且上一块是同类型文本块时才并合，否则交给默认行为。
    if (depth < 2 || $pos.node(depth - 1).childCount !== 1) return false;
    const quoteStart = $pos.before(depth - 1);
    const $quote = doc.resolve(quoteStart);
    const quoteIndex = $quote.index();
    const quote = $quote.parent.maybeChild(quoteIndex);
    const above = $quote.parent.maybeChild(quoteIndex - 1);
    const para = $pos.parent;
    if (!quote || !above || above.type !== para.type) return false;
    const aboveStart = quoteStart - above.nodeSize;

    // PM 的 delete 会把「只删包装标记」的区间规范化成无操作，所以这里直接用合并后的
    // 整块替换「上一行 + 引用块」——引用壳随之消失，不会留下空引用或多余空行。
    let tr;
    try {
        const merged = above.type.create(above.attrs, above.content.append(para.content));
        tr = state.tr.replaceWith(aboveStart, quoteStart + quote.nodeSize, merged);
        tr.setSelection(TextSelection.create(tr.doc, aboveStart + 1 + above.content.size));
    } catch (_error) {
        return false;
    }
    if (!tr.docChanged) return false;
    view.dispatch(tr.scrollIntoView());
    return true;
}

/**
 * 引用块内行首退格。必须比 PM 基础键位先跑（priority 1000），否则默认 joinBackward
 * 先把整行抬出引用块，这里就再也没机会并回上一行。
 */
export const QuoteBackspaceShortcut = Extension.create({
    name: 'quoteBackspaceShortcut',

    priority: 1000,

    addProseMirrorPlugins() {
        return [
            new globalThis.DumbPadTiptap.PM.state.Plugin({
                props: {
                    handleKeyDown: (view, event) => {
                        if (event.key !== 'Backspace' || event.shiftKey
                            || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
                            return false;
                        }
                        const { state } = view;
                        const selection = state.selection;
                        if (!selection.empty) return false;
                        const $from = selection.$from;
                        if ($from.parentOffset !== 0 || !isQuoteParagraph($from)) return false;
                        return joinQuoteParagraph(state, view, $from);
                    },
                },
            }),
        ];
    },
});


/**
 * 回车 / 退格的软换行语义：
 * - 顶层普通段落、引用块内段落：回车 = 段内软换行（不拆段、不产生空行）；
 * - 引用块内的空行回车 = 退出引用块；
 * - 引用块内行首退格 = 并回上一行；
 * - 标题 / 列表 / 表格 / 代码块：完全交给各自默认行为（和旧 handleWysiwygSoftEnter 一致）。
 */
export const SoftEnterShortcut = Extension.create({
    name: 'softEnterShortcut',

    addProseMirrorPlugins() {
        return [
            new globalThis.DumbPadTiptap.PM.state.Plugin({
                props: {
                    handleKeyDown: (view, event) => {
                        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
                            return false;
                        }
                        const { state } = view;
                        const selection = state.selection;
                        if (!selection.empty) return false;
                        const $from = selection.$from;
                        const scope = softBreakScope($from);
                        if (!scope) return false;
                        const paragraph = $from.parent;
                        if (scope.inQuote) {
                            if (visualLineIsBlank(paragraph, $from.parentOffset)) {
                                return exitBlockquoteLine(state, view, $from);
                            }
                        } else if (!paragraph.textContent.replace(/[\u200B\uFEFF]/g, '').trim()) {
                            return false;
                        }
                        const { hardBreak } = state.schema.nodes;
                        if (!hardBreak) return false;
                        insertSoftBreak(state, (tr) => view.dispatch(tr), hardBreak);
                        return true;
                    },
                },
            }),
        ];
    },
});

/**
 * 校验 runner 给的匹配起点确实落在顶层普通段落的软换行上，返回拆块位置。
 * 位置会再向前吞掉紧邻的其它软换行：连按两次 Enter 造出的空行本来就是靠 `<br>` 表示的，
 * 拆块之后块与块之间自带间距，把游离换行留在上一块尾部只是脏状态（段尾换行本来也不写进源）。
 * `range.from >= range.to` 是纯防御：命中串必然以换行开头，正常情况下不可能为空。
 */
function softBreakRulePosition(state, range) {
    if (range.from >= range.to) return null;
    const $caret = state.doc.resolve(range.to);
    if ($caret.depth !== 1 || $caret.parent.type.name !== 'paragraph') return null;
    if (state.doc.nodeAt(range.from)?.type.name !== 'hardBreak') return null;
    let position = range.from;
    const contentStart = $caret.start();
    while (position > contentStart
        && state.doc.nodeAt(position - 1)?.type.name === 'hardBreak') {
        position -= 1;
    }
    return position;
}

/**
 * 软换行之后的「视觉行首」也算行首：任何一行开头打 `# `/`- `/`1. `/`> `，当场在软换行处
 * 拆块并应用块类型。目标只有一个——**打字时的结果与刷新后一致**。磁盘格式本来就已经是对的
 * （`甲\n# 乙` 重新解析就是 paragraph + heading，`breaks: true` 下 Markdown 源里单个换行
 * 后面跟块标记不要求空行），缺的只是编辑器在输入那一刻没把「视觉行首」当行首。
 *
 * 为什么不直接把官方规则放宽锚定：StarterKit 的块级规则全是 `^` 锚定（heading
 * `^(#{1,6})\s$`、blockquote `^\s*>\s$`、bulletList `^\s*([-+*])\s$`、orderedList
 * `^(\d+)\.\s$`），只在「PM 块首」触发，而软换行不是块首——整段只有一个块首。把 `^`
 * 换成允许换行也不够用：官方 handler 的作用范围是**整个块**（`textblockTypeInputRule` 直接
 * `setBlockType(块范围)`、`wrappingInputRule` 直接 `findWrapping(块范围)`），会把上一视觉行
 * 一起变成标题/塞进列表，那是错的。所以这里自己拆：删掉「软换行 + 缩进 + 标记」→ 在软换行的
 * 位置 `splitBlock()` → 只对拆出来的后半块跑框架命令（`setNode` / `toggle*`）。仍是单个事务，
 * 走 input rule 的 undoable 元数据（可撤销）、自然触发保存，与 `TaskListInputShortcut` 同一套写法。
 *
 * 三条不显眼但承重的约束：
 * 1. 前提是 `MdSoftBreak` 声明了 `leafText: () => '\n'`——runner 拼「光标前文本」和它自己的
 *    textBetween 复核都用 '\n' 代表软换行，这些以 `\n` 开头的 find 才有机会命中。
 * 2. 换行与标记之间只允许空格/制表符（`[ \t]`，**不是** `\s`）：一次匹配不能跨过两个视觉行，
 *    `\n\s*` 会把夹在中间那一行的内容一起吞进拆块区间。与上面「向后吞连续换行」是两件事，
 *    不能互相替代（实测 `甲<br><br><空格> - 乙` 在 `[ \t]*` 下得到 `甲` + 列表，内容不丢）。
 * 3. `priority: 101`：段首正好就是软换行时（空段落按 Shift+Enter 会得到 paragraph(<br>)），
 *    `- ` 会**同时**命中这里的 find 和官方的 `/^\s*([-+*])\s$/`（那里的 `\s*` 正好吃掉 `<br>`
 *    的 '\n'），而官方 handler 会把整块包进列表。Tiptap 收集输入规则时把扩展数组反转后再按
 *    priority 降序排，同 priority 就变成「后声明的先跑」——把正确性压在数组顺序上太脆，
 *    显式高一级才与声明位置无关。
 *
 * 生效范围与 SoftEnterShortcut 造软换行的门槛一致：只有 `doc > paragraph`，且必须是空选区
 * （SoftEnterShortcut 与 insertSoftBreak 都要求空选区，这里同样不让一次按键顺手改动选中的
 * 内容）。标题/列表/引用/表格里确实可能出现 `<br>`（Shift+Enter 走 `setHardBreak`，它没有
 * depth 守卫），那些块不接管，免得把块结构拆坏。
 *
 * 不覆盖 `---`/`___`/`***`：分隔线的实时转换（含「视觉行首的 `---` 会被重新解析当成 setext
 * 标题下划线」这条最重的违规）由下面的 DividerInputShortcut 专门接管——它要在拆块之后再插
 * 一个块节点，与这里的「拆块 + 应用块型」不是同一步形状。
 * ``` 围栏跨行、还要整体转块，拆块表达不了，由下面的 CodeFenceInputShortcut 接管。
 */
export const SoftBreakBlockRules = Extension.create({
    name: 'softBreakBlockRules',

    priority: 101,

    addInputRules() {
        // 标题档位以 Heading 扩展的 options.levels 为准（实测 addInputRules 时机
        // editor.extensionManager 已就绪，能拿到真实配置：levels 设成 [1,2] 时 `### ` 不拆块）。
        // 取不到才退回官方默认 1–6，并响亮提示一次——那种情况下「配置里禁用的档位」会被
        // 当成允许，写出去的 level 与渲染的标签可能不一致。
        const headingExtension = this.editor?.extensionManager?.extensions?.find(
            extension => extension.name === 'heading',
        );
        const configuredLevels = headingExtension?.options?.levels;
        const levels = Array.isArray(configuredLevels) && configuredLevels.length
            ? configuredLevels
            : [1, 2, 3, 4, 5, 6];
        if (!Array.isArray(configuredLevels) || !configuredLevels.length) {
            console.warn('[dumbpad] 没取到 Heading 的 levels，软换行块规则按官方默认 1–6 处理');
        }

        /**
         * 命中后先确认「这块能变成目标块型」再动手：runner 只检查事务里有没有步骤
         * （InputRule.run 的 `!tr.steps.length`），所以 `deleteRange` 之后框架命令若失败，
         * 标记会被吃掉而块型没变——留下半截事务。用 runner 给的 can() 在动手前预检同一件事。
         */
        const blockRule = (find, apply, check) => new InputRule({
            find,
            handler: ({ state, range, match, chain, can }) => {
                // 非空选区不接管：拆块的 deleteRange 会把用户选中的文本一起删掉。runner 的
                // textBefore 只取到选区**起点**，所以够得着这条规则的形状正是「选区在标记右侧」。
                if (!state.selection.empty) return null;
                if (!check(match, can())) return null;
                const brPos = softBreakRulePosition(state, range);
                if (brPos === null) return null;
                apply(
                    chain()
                        .deleteRange({ from: brPos, to: range.to })
                        .splitBlock(),
                    match,
                ).run();
            },
        });

        return [
            blockRule(
                /\n[ \t\u00a0]*(#{1,6})[ \t\u00a0]$/,
                (chain, match) => chain.setNode('heading', { level: match[1].length }),
                (match, can) => levels.includes(match[1].length)
                    && can.setNode('heading', { level: match[1].length }),
            ),
            blockRule(
                /\n[ \t\u00a0]*([-+*])[ \t\u00a0]$/,
                chain => chain.toggleBulletList(),
                (match, can) => can.toggleBulletList(),
            ),
            blockRule(
                /\n[ \t\u00a0]*(\d+)\.[ \t\u00a0]$/,
                (chain, match) => chain
                    .toggleOrderedList()
                    .updateAttributes('orderedList', { start: Number(match[1]) }),
                (match, can) => can.toggleOrderedList(),
            ),
            blockRule(
                /\n[ \t\u00a0]*>[ \t\u00a0]$/,
                chain => chain.toggleBlockquote(),
                (match, can) => can.toggleBlockquote(),
            ),
        ];
    },
});

/**
 * 段落里手打的 ``` 围栏当场转正为代码块：开栏行（``` + 可选语言）回车即开块，
 * 完整围栏在收尾反引号落下时补转。
 *
 * 旧 Vditor 编辑器里这件事是「顺手」发生的：handleWysiwygSoftEnter 在软换行后异步
 * 同步编辑器值，Lute 重解析时认出围栏。Tiptap 内核没有这一步——反引号留在段落文本里，
 * 序列化时被转义写成 \`，重新解析永远是纯文本：用户敲的围栏永远变不成代码块，刷新后
 * 源码模式还能看到反斜杠污染。解析侧本来就没问题（未转义的围栏源码 setValue 直接解析成
 * codeBlock，CommonMark 允许围栏打断段落），缺的只是打字那一刻的转换。
 *
 * 两条输入规则（收尾规则声明在前：同一段文本下「…\n```」既形似收尾行也形似开栏行，
 * runner 取第一条命中的规则，完整围栏必须优先按带围栏体解析）：
 * ① 完整围栏 —— 收尾 ``` 的最后一个反引号落下时转正（文本输入路径）；
 * ② 开栏行 —— 回车时转正（InputRule runner 在 Enter 键位上会以**虚拟的 "\n"** 补跑
 *    一遍规则——模拟即将插入的换行；IME compositionend 后则补跑空串。「匹配串去掉
 *    虚拟换行后已完整落进文档」的复核挡住逐字打 ```` ```c ```` 时的抢跑，语言标记
 *    不会打一半就生效）。这就是旧 Vditor 的触发时机：
 *    ```` ```c ```` + 回车当场得到代码块，光标落在块内，不必再敲收尾围栏。
 *
 * 只接管 `doc > paragraph`（与 SoftEnterShortcut 的软换行作用域一致），且要求：
 * - 空选区（不让一次按键顺手改动选中的内容，与 blockRule 同一条红线）；
 * - 光标已在段末——「```尾文」在 CommonMark 里不是合法收尾（收尾围栏只许跟空白），
 *   后面还有文字时就地转换会与重新解析打架，宁可不转；
 * - 开栏必须落在「视觉行首」：要么前面是软换行（并向前吞掉紧邻的连续软换行，与
 *   softBreakRulePosition 同一套语义——段尾软换行本来就不写进源），要么就在块首。
 *
 * 为什么不复用官方 CodeBlock 的输入规则：它 `^` 锚定块首（空段落 ```` ``` ```` + 空格 /
 * Enter 的路径归它，实测先行），软换行不是块首、围栏体又跨多个视觉行，框架的
 * textblockTypeInputRule 作用域是整个块，会把围栏前的文字一起拖进代码块。所以自己拆：
 * 前缀文字留在段落、围栏整体转成 codeBlock 节点插到段落之后（围栏吃满整段时连段落一起
 * 让位），单个事务、走 input rule 的 undoable 元数据（可撤销、自然触发保存）。
 *
 * 范围取舍：只认反引号围栏（~~~ 波浪围栏与缩进围栏不在内）；```` `(?:^|\n) ```` 的 `^`
 * 在超长段落上会误中 runner 的 500 字符窗口开头而不是块首，段首分支必须复核 range.from
 * 真的是块内容起点，否则放弃转换。
 */
export const CodeFenceInputShortcut = Extension.create({
    name: 'codeFenceInputShortcut',

    addInputRules() {
        /**
         * 共享守卫：软换行作用域、空选区、光标在段末、开栏行首（含连续软换行的回吞）。
         * 命中返回转正事务需要的位置上下文，否则 null（规则放弃，不接管这次输入）。
         */
        const fenceContext = (state, range, match) => {
            if (!state.selection.empty) return null;
            const $caret = state.doc.resolve(range.to);
            if ($caret.depth !== 1 || $caret.parent.type.name !== 'paragraph') return null;
            const paragraph = $caret.parent;
            // 打字尚未落进文档（字符交给规则处理时还没插入），range.to 就是光标：
            // 要求它已在段末，收尾围栏之后不允许再有文字。
            if ($caret.parentOffset !== paragraph.content.size) return null;
            // range.from 指向匹配串在文档里的起点（不含还没插入的那个字符）：
            // 软换行分支必须是 hardBreak 节点，并向前吞掉紧邻的连续软换行；
            // 块首分支必须真的是块内容起点（防 500 字符窗口截断误判）。
            let from = range.from;
            if (match[0].startsWith('\n')) {
                if (state.doc.nodeAt(from)?.type.name !== 'hardBreak') return null;
                const contentStart = $caret.start();
                while (from > contentStart && state.doc.nodeAt(from - 1)?.type.name === 'hardBreak') {
                    from -= 1;
                }
            } else if (from !== $caret.start()) {
                return null;
            }
            return { $caret, paragraph, from, caretPos: range.to };
        };

        /** 转正事务：代码块插到段落之后的块边界（该位置不受随后段内删除的影响），再删掉
         * 段内围栏文本；围栏吃满整段时连段落一起让位。光标落进代码块末尾——开栏回车得到
         * 空块直接开始写代码，收尾转正则刚写完的就是代码（退出走 Mod-Enter/方向键）。 */
        const commitFence = (chain, state, context, language, body) => {
            const { $caret, paragraph, from, caretPos } = context;
            const paraStart = $caret.before(1);
            const paraEnd = $caret.after(1);
            const wholeParagraph = from === paraStart + 1;
            const fenceNode = state.schema.nodes.codeBlock.create(
                { language: language || null },
                body ? [state.schema.text(body)] : null,
            );
            const deletedLength = wholeParagraph ? paragraph.nodeSize : caretPos - from;
            const blockStart = wholeParagraph ? paraStart : paraEnd - deletedLength;
            chain()
                .command(({ tr }) => {
                    tr.insert(paraEnd, fenceNode);
                    tr.delete(wholeParagraph ? paraStart : from, wholeParagraph ? paraEnd : caretPos);
                    tr.setSelection(TextSelection.create(tr.doc, blockStart + 1 + body.length));
                    tr.scrollIntoView();
                })
                .run();
        };

        const fenceLanguage = (raw) => String(raw || '').replace(/[\u200B\uFEFF]/g, '').trim();

        return [
            // ① 完整围栏：开栏行（``` + 可选语言）+ 围栏体（可跨软换行）+ 收尾行。
            // 匹配串里的 \n 是 MdSoftBreak 的 leafText：软换行在文本视图里就是一个换行符。
            // 围栏体允许为空（\`\`\`\n\`\`\` 直接得到空代码块）。
            new InputRule({
                find: /(?:^|\n)```([^\n`]*)\n(?:([\s\S]*?)\n)?```$/,
                handler: ({ state, range, match, chain }) => {
                    const context = fenceContext(state, range, match);
                    if (!context) return;
                    const { codeBlock } = state.schema.nodes;
                    if (!codeBlock) return;
                    commitFence(chain, state, context, fenceLanguage(match[1]), (match[2] || '').replace(/[\u200B\uFEFF]/g, ''));
                },
            }),
            // ② 开栏行 + 回车。Enter 的补跑在匹配串尾虚拟一个 "\n"（模拟即将插入的
            // 换行，不在文档里；IME compositionend 补跑则是空串），find 因此容忍
            // 可选的串尾 \n。「匹配串（去掉虚拟换行）已完整落进文档」是补跑的指纹：
            // 逐字打 ```` ```c ```` 时语言标记还没进文档，对不上，不会在打到一半时
            // 抢跑把想继续打的字符关进块里。
            new InputRule({
                find: /(?:^|\n)```([^\n`]*)\n?$/,
                handler: ({ state, range, match, chain }) => {
                    const $caret = state.doc.resolve(range.to);
                    if ($caret.depth !== 1 || $caret.parent.type.name !== 'paragraph') return;
                    const virtualNewline = match[0].endsWith('\n');
                    const inDocPart = virtualNewline ? match[0].slice(0, -1) : match[0];
                    const docMatch = state.doc.textBetween(
                        Math.max(range.to - inDocPart.length, $caret.start()),
                        range.to,
                    );
                    if (docMatch !== inDocPart) return;
                    const context = fenceContext(state, range, match);
                    if (!context) return;
                    const { codeBlock } = state.schema.nodes;
                    if (!codeBlock) return;
                    commitFence(chain, state, context, fenceLanguage(match[1]), '');
                },
            }),
        ];
    },
});

/**
 * 分隔线当场成型：软换行后的「视觉行首」打 `---` 也立刻转成分隔线。
 *
 * 官方 HorizontalRule 只有一条输入规则 `/^(?:---|—-|___\s|\*\*\*\s)$/`，一个结构性缺口：
 * `^` 锚 PM 块首，而 Enter 造的是段内 `<br>`（`MdSoftBreak`）不是新块——于是
 * `甲` + Enter + `---` 在屏幕上永远是字面文本，序列化仍是 `甲\n---`，**重新解析被
 * setext 当成标题下划线**：`甲` 变成二级标题、`---` 被吃掉。这是「打字时 ≠ 刷新后」
 * 里最重的一档（静默改内容），也是「有时要刷新才变成分隔线」的真相。
 *
 * 为什么按「分隔线」解释而不是当场把上一块变成 H2：拆块后的落盘形态是 `甲\n\n---`
 * （hr 的 closeBlock 会补空行），重新解析仍是 paragraph + hr，**两个方向都稳定**；
 * 而 setext 是笔记场景里几乎没人要的结果，实时预览编辑器（Typora 等）同样把行首
 * `---` 解释成分隔线。粘贴 `甲\n---` 仍按标准 Markdown 解析成 H2——那是另一条入口，
 * 与打字时机无关，且自身往返稳定。
 *
 * 刻意**不**放宽 `___` / `***` 的空格门槛：那是上游留的护身符——`***重点***` 这类强调
 * 标记正是从三个星号开头，去掉空格要求会把「打一半的强调标记」当场变成分隔线。
 *
 * 作用域与 CodeFenceInputShortcut 一致：只有 `doc > paragraph`（代码块内不命中，实测
 * 官方规则在代码块里也不命中；列表 / 引用 / 标题内不接管），且空选区。软换行分支复用
 * `softBreakRulePosition`（必须是真 hardBreak 节点，并向前吞掉紧邻的连续软换行）。
 *
 * 只补「视觉行首」这一条，不补 PM 块首：块首的第 3 个连字符就已经被官方规则命中，
 * 用户打不出第 4 个（`----` 的实测结果是分隔线 + 后面段落里一个游离 `-`，两个方向一致），
 * 所以这里加 `^` 分支只会多一条抢不到的死规则。
 */
export const DividerInputShortcut = Extension.create({
    name: 'dividerInputShortcut',

    addInputRules() {
        return [
            // 视觉行首（软换行之后）：删掉「软换行 + 缩进 + 标记」→ 拆块 → 分隔线插到块边界。
            new InputRule({
                find: /\n[ \t]*(-{3,}|_{3,}[ \t]|\*{3,}[ \t])$/,
                handler: ({ state, range, chain }) => {
                    if (!state.selection.empty) return;
                    const $caret = state.doc.resolve(range.to);
                    if ($caret.depth !== 1 || $caret.parent.type.name !== 'paragraph') return;
                    if (!state.schema.nodes.horizontalRule) return;
                    const brPos = softBreakRulePosition(state, range);
                    if (brPos === null) return;
                    chain()
                        .deleteRange({ from: brPos, to: range.to })
                        .splitBlock()
                        .setHorizontalRule()
                        .run();
                },
            }),
        ];
    },
});

/**
 * 文章最开头打 `---` 当场转正为 frontmatter 块（language=dumbpad-frontmatter 的代码块），
 * 与另外两条已有入口同一套存储形态：① 粘贴（`DumbPadFrontmatterParseRule` 的 markdown-it
 * 块规则）；② `setValue`（`frontmatterToFence` 的 `^---\n…\n---` 预处理）。缺的第三条正是
 * 用户报的「想手打 frontmatter 却只得到分隔线」。
 *
 * 判定门槛（全部满足才接管）：文档**第一个块**、`doc > paragraph`、段落里只有这三个连字符、
 * 光标在段末、空选区。其它位置的 `---` 仍归 DividerInputShortcut / 官方规则产分隔线——
 * frontmatter 只可能出现在文首，把范围放窄才不会误伤「文章顶端就想来条分隔线」的写法
 * （那种写法改用 `*** ` / `___ `，官方规则在块首同样命中）。
 *
 * 转正用单个事务里的 `replaceRangeWith`（不是先删后插：文档只有一个空段落时删掉它会留下
 * 非法的空 doc），光标落进块首——直接开始打 YAML。退出沿用官方 CodeBlock 键位（实测
 * Mod-Enter 与三连回车都能出块，落盘仍是 `---\n…\n---`）。
 * 序列化后 `fenceToFrontmatter` 会把它映射回 `---\n…\n---`，空块的落盘形态 `---\n\n---\n`
 * 与「打字 == 载入」由 test_tiptap_frontmatter_input.js 固化。
 *
 * `priority: 110`：输入规则按 priority 降序收集、第一条命中即停（与 SoftBreakBlockRules
 * 的 101 同一个理由）。实测把它降到 1 就会被官方 HorizontalRule 抢走（文首 `---` 又变回
 * 分隔线）；与官方同为默认 100 时靠扩展声明顺序恰好也能赢，但那个并列次序是实现细节，
 * 不该依赖，所以显式写高。
 */
export const FrontmatterLeadInputShortcut = Extension.create({
    name: 'frontmatterLeadInputShortcut',

    priority: 110,

    addInputRules() {
        return [new InputRule({
            find: /^---$/,
            handler: ({ state, range, chain }) => {
                if (!state.selection.empty) return;
                const $caret = state.doc.resolve(range.to);
                if ($caret.depth !== 1 || $caret.parent.type.name !== 'paragraph') return;
                const codeBlock = state.schema.nodes.codeBlock;
                if (!codeBlock) return;
                // 必须是文档第一个块（runner 的 textBefore 有 500 字符窗口，^ 要复核起点）
                if (range.from !== 1 || $caret.start() !== 1) return;
                // 段落里只能有这三个连字符：字符交给规则时还没落进文档，
                // 所以「已插入的前缀 + 光标在段末」才是完整标记的判据。
                const typed = state.doc.textBetween(1, range.to);
                if (typed + '-' !== '---') return;
                if ($caret.parentOffset !== $caret.parent.content.size) return;
                const blockStart = $caret.before(1);
                const blockEnd = $caret.after(1);
                chain().command(({ tr }) => {
                    tr.replaceRangeWith(blockStart, blockEnd,
                        codeBlock.create({ language: 'dumbpad-frontmatter' }, null));
                    tr.setSelection(TextSelection.create(tr.doc, blockStart + 1));
                    tr.scrollIntoView();
                    return true;
                }).run();
            },
        })];
    },
});

/** tiptap-markdown 的 MarkdownTightLists 只给 bulletList/orderedList 声明
 * 全局 tight 属性，taskList 没有声明。序列化时 renderList 对没有 tight
 * 属性的节点回退到 options.tightLists（未传 → 宽松列表），保存会在任务
 * 项之间插入空行，破坏与旧编辑器逐字节一致的契约。补同形态的 tight 属性
 * （解析沿用 data-tight / 无段落判定，渲染不输出任何 DOM 属性）。 */
export const DumbPadTaskList = TaskList.extend({
    addAttributes() {
        return {
            tight: {
                default: true,
                parseHTML: element =>
                    element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
                renderHTML: () => ({}),
            },
        };
    },
});

/**
 * 待办三态（进行中 = `- [~] `）。
 *
 * markdown-it 只认 `[ ]`/`[x]` 做任务标记，`[~] ` 会原样留在列表项首段文本里：
 * 条目落到编辑器是普通列表项 + 字面 "[~] "，`getValue()` 再把它转义成
 * `- \[~\~\] 甲`——保存即改坏文档。本扩展在**解析期**把它还原成任务项：
 *
 * 1. `setup` 在 markdown-it 的 `inline` 之后、`github-task-lists` 之前，把列表项
 *    首段开头的 `[~]` 改写成 `[ ] `（只动 token，不碰源码），并往正文塞一个
 *    零宽哨兵——改写后内核插件才认，而 `updateDOM` 阶段复选框信息已被内核吃
 *    掉，只有哨兵能把「进行中」与普通未完成区分开；
 * 2. `updateDOM` 就地把带哨兵的条目改成进行中任务项（`data-doing="true"`），
 *    随后把哨兵从文本节点里删掉，文档里不留痕；
 * 3. `DumbPadTaskItem`（同文件）把 `doing` 声明成节点属性：parseHTML 只认第 2 步
 *    盖的 data-doing，renderHTML 不输出；序列化器按 `doing` 输出 `[~] `，其余
 *    一律回落到内核的 `[x]`/`[ ]`。
 *
 * 口径与内核 `[ ]` 任务标记一致：`[~] 甲`（带空格）/ 空标记 `[~]` 才算待办，
 * `[~]甲`（粘连）仍是字面文本。嵌套条目同样生效。为什么走独立扩展而不覆盖
 * DumbPadTaskItem 的 addStorage：内核收集 markdown 配置是浅合并，覆盖 parse 会
 * 连 setup（`[ ]` 识别全靠它）一起挤掉；updateDOM 按扩展注册顺序执行，本扩展
 * 紧跟 DumbPadTaskList 之后。
 */
const installedDoingTaskItemRules = new WeakSet();

// 首段开头的 `[~]`（后接空格或行尾）；粘连的 `[~]甲` 不算标记。
const DOING_TASK_MARK_LEAD_RE = /^\[~\] /;
const DOING_TASK_MARK_BARE_RE = /^\[~\]$/;
// 解析期的零宽哨兵（U+2063 不可见分隔符）：文本节点能携带、上屏不可见，
// updateDOM 读完即删。
const DOING_SENTINEL = '\u2063';

/** 哨兵是否落在本 li 的**自有**文本里（子列表属于子级 li，不算）。 */
function liHasOwnSentinel(listItem) {
    for (let node = listItem.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 3 && node.nodeValue.includes(DOING_SENTINEL)) return true;
        // 条目正文在自己的 ul/ol 之前（子列表之后的内容属于下层条目）。
        if (node.nodeType === 1 && /^(UL|OL)$/.test(node.nodeName)) break;
        if (node.nodeType === 1 && node.textContent.includes(DOING_SENTINEL)) return true;
    }
    return false;
}

/**
 * 把首段开头的 `[~]` 换成 `[ ] `，并在正文最前面塞一个零宽哨兵。
 *
 * 两处必须同时改：内核插件只看 `inline.content` 的前缀，渲染器又只认
 * `inline.content` 里的源码——所以 content 只替换**前缀这几个字符**，正文
 * 原样保留（整串重写会把 `**粗体**` 这类行内语法一起吃掉）。哨兵走 text
 * 子节点：html_inline 会被渲染器拆掉尖括号，只有文本能活到 updateDOM。
 */
function rewriteDoingTaskItemTokens(state) {
    const tokens = state.tokens;
    for (let index = 2; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type !== 'inline'
            || tokens[index - 1]?.type !== 'paragraph_open'
            || tokens[index - 2]?.type !== 'list_item_open') continue;
        const first = token.children?.[0];
        if (!first || first.type !== 'text') continue;
        if (!DOING_TASK_MARK_LEAD_RE.test(first.content) && !DOING_TASK_MARK_BARE_RE.test(first.content)) continue;
        // 只换**前缀那几个字符**，正文源码原样保留（整串重写会吃掉 `**`/`` ` ``）。
        // 标记 → 内核的 `[ ] `：插件只认这个带尾随空格的前缀；裸标记 `[~]`
        // 没正文，补成 `[ ] `。哨兵放在 `[ ] ` 之后（插件只看前缀）。
        token.content = token.content.replace(/^\[~\] ?/, '[ ] ');
        first.content = `[ ] ${DOING_SENTINEL}${first.content.slice('[~]'.length).replace(/^ /, '')}`;
    }
}

export const DumbPadDoingTaskItem = Extension.create({
    name: 'dumbpadDoingTaskItem',

    addStorage() {
        return {
            markdown: {
                parse: {
                    setup(markdownit) {
                        if (installedDoingTaskItemRules.has(markdownit)) return;
                        installedDoingTaskItemRules.add(markdownit);
                        const rules = markdownit.core.ruler.__rules__;
                        if (rules.some(rule => rule.name === 'github-task-lists')) {
                            markdownit.core.ruler.before('github-task-lists', 'dumbpad_doing_task_item', rewriteDoingTaskItemTokens);
                        } else {
                            markdownit.core.ruler.after('inline', 'dumbpad_doing_task_item', rewriteDoingTaskItemTokens);
                        }
                    },
                    updateDOM: (element) => {
                        // 哨兵在 li 的**首个文本**里（紧跟内核复选框之后）；取该 li
                        // 的「自有」文本块判断，父级不会误认子级的哨兵。
                        // 先收集再清理：清理会删掉哨兵本身。
                        const marking = Array.from(element.querySelectorAll('li'))
                            .filter(listItem => liHasOwnSentinel(listItem));
                        marking.forEach(listItem => listItem.setAttribute('data-doing', 'true'));
                        // 只删哨兵所在的文本节点里的这几个字符：整段 textContent
                        // 回写会把粗体/行内代码等子元素全部抹平。
                        const walker = element.ownerDocument.createTreeWalker(element, 4);
                        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                            if (node.nodeValue.includes(DOING_SENTINEL)) {
                                node.nodeValue = node.nodeValue.replaceAll(DOING_SENTINEL, '');
                            }
                        }
                    },
                },
            },
        };
    },
});

const installedEmptyTaskItemRules = new WeakSet();

/**
 * 内核的 github-task-lists 插件只在条目首段文本以 "[ ] "/"[x] "（**带尾随空格**）
 * 开头时才盖任务章，而 markdown-it 的 inline 解析会把行尾空格剥掉——「空待办」
 * （`- [ ] `，用户在任务项上回车得到的正是它）的 token 内容只剩 "[ ]"，插件不认，
 * 条目退化成普通列表 + 字面 "[ ]" 文本，序列化再被转义成 `- \[ \]`：每次保存
 * 污染一次，嵌套空任务项同样中招。
 *
 * 这条 core 规则赶在 github-task-lists 之前，把列表项首段开头**裸收尾**的
 * `[ ]`/`[x]` 补上尾随空格（只动 token，不碰源码）。插件随后 unshift 复选框并
 * `slice(3)` 吃掉 "[ ]"，残留的单个空格是空白文本节点，PM 解析时丢弃——条目
 * 回到「真的空」；往返逐字节稳定（`- [ ] ` → 解析 → 再序列化仍 `- [ ] `）。
 * 已有后续内容的条目（"[ ] 甲"）本来就带空格，规则原样放过。
 */
function padEmptyTaskItemTokens(state) {
    const tokens = state.tokens;
    // 与 github-task-lists 的门完全一致：list_item_open > paragraph_open > inline。
    for (let index = 2; index < tokens.length; index += 1) {
        if (tokens[index].type !== 'inline'
            || tokens[index - 1]?.type !== 'paragraph_open'
            || tokens[index - 2]?.type !== 'list_item_open') continue;
        const inline = tokens[index];
        const first = inline.children?.[0];
        if (!first || first.type !== 'text') continue;
        if (!/^\[[ xX~]\]$/.test(first.content)) continue;
        first.content = `${first.content} `;
        inline.content = `${inline.content} `;
    }
}

/**
 * 空任务项解析补丁。必须注册在 DumbPadTaskList 之后：上游 TaskList 的
 * setup 挂载 github-task-lists，本规则用 ruler.before 显式插到它前面
 * （setup 每次 parse 重跑，按 markdown-it 实例去重）。上游缺席时（没有
 * TaskList 扩展就没有任务项）安静跳过。
 */
export const DumbPadEmptyTaskItemParseRule = Extension.create({
    name: 'dumbpadEmptyTaskItemParseRule',

    addStorage() {
        return {
            markdown: {
                parse: {
                    setup(markdownit) {
                        if (installedEmptyTaskItemRules.has(markdownit)) return;
                        installedEmptyTaskItemRules.add(markdownit);
                        const rules = markdownit.core.ruler.__rules__;
                        if (rules.some(rule => rule.name === 'github-task-lists')) {
                            markdownit.core.ruler.before('github-task-lists', 'dumbpad_empty_task_item', padEmptyTaskItemTokens);
                        } else {
                            markdownit.core.ruler.after('inline', 'dumbpad_empty_task_item', padEmptyTaskItemTokens);
                        }
                    },
                },
            },
        };
    },
});

const installedEmptyListMarkerRules = new WeakSet();

const EMPTY_LIST_MARKER_LINE_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]*$/;
const CONTENT_LIST_MARKER_LINE_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;

function rawLine(state, line) {
    return state.src.slice(state.bMarks[line], state.eMarks[line]);
}

/**
 * 空列表项**不能打断段落**（CommonMark）：前一行是段落文字时，「只有标记的行」
 * 退化为惰性续行，而单个 `-` 组成的行又恰好是 setext 下划线——`- 甲\n  - ` 重新
 * 解析变成 `## 甲`（父行被吞成二级标题、空项消失），`甲\n- ` 同理。这是「列表下
 * 唯一的空嵌套项」（回车 + Tab 的正常打字流落盘形态）的解析入口损坏。
 *
 * 这条 block 规则赶在 lheading（setext）之前：当前行是非空文本、下一行**只由单个
 * 列表标记构成**（`---`/`--`/`***` 等多字符分隔线与 setext 下划线都不匹配，真实的
 * setext 与 hr 不受影响）时，把当前行就地落成段落再前进一行，空标记行交给列表
 * 规则——段落已关闭，空条目得以正常起列表（与「标记行前有空行」同一条成功路径）。
 *
 * 两条防误伤：
 * - 当前行自己是列表行时（列表项子状态里 getLines 拿到的原始行仍带标记），空标记
 *   行必须**严格更深一层**才起火——同层兄弟空项（`- 乙` 之后的 `  - `）本来就解析
 *   正确，抢过来会把一个列表拆成两个；
 * - 段落内容用 `getLines(..., state.blkIndent)` 提取，与 paragraph 规则同一调用，
 *   列表项子状态的标记偏移由 blkIndent 吃掉，`- 甲` 不会整行漏进文本。
 */
function emptyListMarkerInterruptRule(state, startLine, endLine, silent) {
    if (startLine + 1 >= endLine) return false;
    const currentRaw = rawLine(state, startLine);
    if (!currentRaw.trim()) return false;
    const nextRaw = rawLine(state, startLine + 1);
    const nextMarker = nextRaw.match(EMPTY_LIST_MARKER_LINE_RE);
    if (!nextMarker) return false;
    const currentListMarker = currentRaw.match(CONTENT_LIST_MARKER_LINE_RE)
        ?? currentRaw.match(EMPTY_LIST_MARKER_LINE_RE);
    if (currentListMarker) {
        if (nextMarker[1].length <= currentListMarker[1].length) return false;
    }
    if (silent) return true;
    const content = state.getLines(startLine, startLine + 1, state.blkIndent, false).trim();
    const openToken = state.push('paragraph_open', 'p', 1);
    openToken.map = [startLine, startLine + 1];
    const inlineToken = state.push('inline', '', 0);
    inlineToken.content = content;
    inlineToken.children = [];
    inlineToken.map = [startLine, startLine + 1];
    state.push('paragraph_close', 'p', -1);
    state.line = startLine + 1;
    return true;
}

export const DumbPadEmptyListMarkerParseRule = Extension.create({
    name: 'dumbpadEmptyListMarkerParseRule',

    addStorage() {
        return {
            markdown: {
                parse: {
                    setup(markdownit) {
                        if (installedEmptyListMarkerRules.has(markdownit)) return;
                        installedEmptyListMarkerRules.add(markdownit);
                        markdownit.block.ruler.before('lheading', 'dumbpad_empty_list_marker', emptyListMarkerInterruptRule);
                    },
                },
            },
        };
    },
});

/**
 * 混排列表守卫：`- 甲` 与 `- [ ] 乙` 同列表时（不管谁打头、怎么交错），markdown-it
 * 输出**单个** ul.contains-task-list（只有任务项的 li 带 task-list-item 类），而
 * tiptap-markdown 的 TaskList.parse.updateDOM 会给**所有** ul.contains-task-list 无条件
 * 盖 data-type="taskList" 章。盖章后普通 li 塞不进 taskList 的 taskItem+ 内容模型，
 * PM 装配时凭空吐出幽灵节点：普通项打头是空 taskItem（保存固化成 `- [ ] `），任务项
 * 打头是空 listItem（空圆点，保存固化成 `- `）——每次刷新渲染多一个、每次保存污染一次。
 *
 * 这个守卫在解析 DOM 上把混排列表**就地拆成同级的纯种列表段**（严格保持条目顺序）：
 * 连续的任务项归一段 ul[data-type="taskList"]，连续的普通项归一段普通 ul，原 ul 整个
 * 退位。纯任务列表一个字节都不动。任何交错顺序都不再依赖 PM 的内容模型兜底。
 *
 * 为什么是独立扩展而不是覆盖 DumbPadTaskList 的 addStorage：内核解析器收集
 * markdown 配置时做浅合并（{...默认, ...storage.markdown}），覆盖 parse 会把
 * 上游的 setup（挂载 github-task-lists 解析插件、`[ ]` 识别全靠它）整个挤掉，
 * `parent` 注入对 addStorage 也不可靠。updateDOM 按扩展注册顺序执行，本扩展
 * 必须注册在 DumbPadTaskList 之后（tiptap-editor.js 里相邻声明）。
 */
export const DumbPadMixedTaskListGuard = Extension.create({
    name: 'dumbpadMixedTaskListGuard',

    addStorage() {
        return {
            markdown: {
                parse: {
                    updateDOM: (element) => {
                        element.querySelectorAll('ul[data-type="taskList"]').forEach((listElement) => {
                            const items = Array.from(listElement.children)
                                .filter(child => child.tagName === 'LI');
                            const hasPlainItem = items.some(item => !item.classList.contains('task-list-item'));
                            if (!hasPlainItem) return;
                            const tightAttribute = listElement.getAttribute('data-tight');
                            const runs = [];
                            for (const item of items) {
                                const isTask = item.classList.contains('task-list-item');
                                const lastRun = runs[runs.length - 1];
                                if (lastRun && lastRun.isTask === isTask) lastRun.items.push(item);
                                else runs.push({ isTask, items: [item] });
                            }
                            const replacement = document.createDocumentFragment();
                            for (const run of runs) {
                                const subList = document.createElement('ul');
                                if (run.isTask) subList.setAttribute('data-type', 'taskList');
                                if (tightAttribute !== null) subList.setAttribute('data-tight', tightAttribute);
                                subList.append(...run.items);
                                replacement.appendChild(subList);
                            }
                            listElement.replaceWith(replacement);
                        });
                    },
                },
            },
        };
    },
});

/** 待办输入（Typora 流程，列表内）：无序列表项里输入 "[ ]"/"[x]"/"[~]" 再按
 * 空格，把当前列表转成任务列表。官方 TaskItem 的 input rule 只覆盖顶层
 * 普通段落（listItem 的 contentMatch 无法 findWrapping 到 taskItem），
 * 这里只接管列表内场景：删除括号文本后完全交给框架命令
 * toggleList('taskList', 'taskItem') 完成转换，不手写节点构造与光标计算。
 * "[~] " 得到进行中（doing），属性由 DumbPadTaskItem 声明。 */
export const TaskListInputShortcut = Extension.create({
    name: 'taskListInputShortcut',

    addInputRules() {
        return [
            new InputRule({
                find: /\[([ xX~])?\]\s$/,
                handler: ({ state, range, chain, match }) => {
                    const listItem = findParentNode(node => node.type.name === 'listItem')(state.selection);
                    if (!listItem) return;
                    const mark = (match[1] || '').toLowerCase();
                    const checked = mark === 'x';
                    chain()
                        .deleteRange(range)
                        .toggleList('taskList', 'taskItem', false)
                        .updateAttributes('taskItem', { checked, doing: mark === '~' })
                        .run();
                },
            }),
        ];
    },
});

/** 自定义 NodeView 的框架级挂载：Tiptap v3 的 createView 只认
 * extensionManager.nodeViews（扩展 addNodeView），editorProps.nodeViews
 * 会被覆盖、仅在首次 setEditable 后经 setProps 间接生效——所以必须走
 * addNodeView。这里用官方扩展 .extend 注入，未命中节点时回落官方行为。 */

export const DumbPadCodeBlock = CodeBlockLowlight.extend({
    addNodeView() {
        return ({ node, view, editor, getPos }) => buildCodeBlockNodeView()({ node, view, editor, getPos });
    },
});

// 官方 TaskItem 的 change 处理器闭包 getPos 在真实应用中返回 undefined，
// 勾选会静默丢失；换成自管视图（posAtDOM 反查位置）。
// `doing`（进行中，对应 `- [~] `）只由 DumbPadDoingTaskItem 在解析期盖章，
// 渲染面零 DOM 属性、markdown 只在 doing 时偏离内核写法，见该扩展注释。
export const DumbPadTaskItem = TaskItem.extend({
    // 不要覆盖官方 addAttributes（会把 checked 顶掉）：合并后再补 doing。
    addAttributes() {
        return {
            ...this.parent?.(),
            doing: {
                default: false,
                keepOnSplit: false,
                parseHTML: element => element.getAttribute('data-doing') === 'true',
                renderHTML: () => ({}),
            },
        };
    },

    addNodeView() {
        return ({ node, view }) => buildTaskItemNodeView()({ node, view });
    },

    addStorage() {
        // 内核 taskItem 的 markdown 规格（序列化器 + `.task-list-item` 解析钩子）
        // 登记在 tiptap-markdown 的内置表里，**不在** TaskItem 扩展自身的 storage
        // 上——要「只换序列化器、保住解析钩子」只能用 getMarkdownSpec 取这一份：
        // addStorage 的返回值会整体替换默认 markdown 配置，而不是与它合并。
        const coreMarkdown = getMarkdownSpec(TaskItem) ?? {};
        const coreSerializer = coreMarkdown.serialize;
        return {
            markdown: {
                ...coreMarkdown,
                serialize(serializer, node) {
                    // 进行中是纯加法：未进行中的条目继续走内核序列化器
                    // （`[x]`/`[ ]`），不需要在这里复刻它的写法。
                    if (node.attrs.doing && !node.attrs.checked) {
                        // 与内核同形：列表标记 `- ` 由父级 taskList 写出，
                        // 条目只写自己的标记。
                        serializer.write('[~] ');
                        serializer.renderContent(node);
                        return;
                    }
                    return coreSerializer?.call(this, serializer, node);
                },
            },
        };
    },
});

/** 标题锚点：目录同步的 id 以 PM 节点 Decoration 渲染，而不是直接改
 * PM 管辖的 DOM 属性——PM 的 DOMObserver 会把外来属性视为脏区并在
 * 重绘时抹掉（实测 ~50ms 内 id 被清空，目录跳转因此失效）。
 * id 顺序由 syncRenderedHeadingIds 经 PluginKey meta 传入，按文档标题
 * 顺序 zip；meta 事务不含步骤，不进撤销历史、不触发保存。id 不带
 * heading- 前缀，与旧编辑器 syncRenderedHeadingIds 及 app.js 的
 * focusEditorHeading/updateActiveTocItem 查询契约一致。 */
export const headingAnchorPluginKey = new PluginKey('dumbpadHeadingAnchors');

export const HeadingAnchor = Extension.create({
    name: 'headingAnchor',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: headingAnchorPluginKey,
                state: {
                    init: () => ({ ids: [], map: DecorationSet.empty }),
                    apply: (tr, value) => {
                        const ids = tr.getMeta(headingAnchorPluginKey);
                        if (!Array.isArray(ids) && !tr.docChanged) return value;
                        const nextIds = Array.isArray(ids) ? ids : value.ids;
                        const anchors = [];
                        tr.doc.descendants((node, pos) => {
                            if (node.type.name !== 'heading') return true;
                            anchors.push([pos, pos + node.nodeSize]);
                            return false;
                        });
                        const decorations = [];
                        nextIds.forEach((id, index) => {
                            const anchor = anchors[index];
                            if (!id || !anchor) return;
                            decorations.push(Decoration.node(anchor[0], anchor[1], {
                                id,
                                'data-heading-id': id,
                            }));
                        });
                        return { ids: nextIds, map: DecorationSet.create(tr.doc, decorations) };
                    },
                },
                props: {
                    decorations(state) {
                        return headingAnchorPluginKey.getState(state)?.map || DecorationSet.empty;
                    },
                },
            }),
        ];
    },
});

/* 目录跳转的落点闪光（区别于搜索命中高亮：只有块级一层、时长更短、更轻——
 * 左侧主色竖条 + 落点文字短暂变主色，无整块背景，样式见 styles.css 的
 * .article-jump-target）。位置由适配器（tiptap-editor.js 的
 * scrollRenderedElementIntoView）经 pluginKey meta 传入 doc 坐标；docChanged 时
 * 经 mapping 跟随内容；clear meta 摘除。必须用 Decoration 而不是 DOM 类名：
 * 直接写在 PM 管辖 DOM 上的类名会被 DOMObserver 在重绘时抹掉（实测编辑模式下
 * is-jump-target 从未露面），Decoration 在编辑/阅读两种模式下都能存活。
 * meta 事务无步骤：不进撤销历史、不触发保存。 */
export const jumpTargetPluginKey = new PluginKey('dumbpadJumpTarget');

const JUMP_TARGET_BLOCK_TYPES = new Set([
    'paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock',
]);

export const JumpTargetHighlight = Extension.create({
    name: 'jumpTargetHighlight',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: jumpTargetPluginKey,
                state: {
                    init: () => null,
                    apply: (tr, value) => {
                        const meta = tr.getMeta(jumpTargetPluginKey);
                        if (meta !== undefined) {
                            if (!meta || !Number.isFinite(meta.from)) return null;
                            return { from: meta.from };
                        }
                        if (!value) return null;
                        if (!tr.docChanged) return value;
                        return { from: tr.mapping.map(value.from, -1) };
                    },
                },
                props: {
                    decorations(state) {
                        const range = jumpTargetPluginKey.getState(state);
                        if (!range) return DecorationSet.empty;
                        try {
                            const docSize = state.doc.content.size;
                            const from = Math.min(Math.max(0, range.from), docSize);
                            const $from = state.doc.resolve(from);
                            // 从内向外找命中所在的块级单元；目标在列表/待办项里时
                            // 闪光整个条目，与搜索块级高亮的粒度一致。
                            let depth = $from.depth;
                            while (depth > 0 && !JUMP_TARGET_BLOCK_TYPES.has($from.node(depth).type.name)) depth -= 1;
                            if (depth <= 0) return DecorationSet.empty;
                            const parentType = depth > 1 ? $from.node(depth - 1).type.name : '';
                            if (['listItem', 'taskItem'].includes(parentType)) depth -= 1;
                            const decoration = Decoration.node($from.before(depth), $from.after(depth), {
                                class: 'article-jump-target',
                            });
                            return DecorationSet.create(state.doc, [decoration]);
                        } catch (_error) {
                            return DecorationSet.empty;
                        }
                    },
                },
            }),
        ];
    },
});

/* 全局搜索跳转的命中高亮（server 侧逐行 occurrences → 前端 jumpToKeyword）。
 * 词级用 Decoration.inline（关键词底色），命中所在的块用 Decoration.node
 * （段落/标题/列表项/引用/代码块整体闪烁）——Decoration 由 PM 在重绘时
 * 自行维护，能存活于块节点周期性重建，任何注入 DOM 的高亮都做不到。
 * 位置由适配器（tiptap-editor.js 的 jumpToKeyword）经 pluginKey meta 传入
 * doc 坐标；docChanged 时经 mapping 跟随内容变化（远端刷新不漂移）；clear
 * meta 摘除。meta 事务无步骤：不进撤销历史、不触发保存。 */
export const searchHitPluginKey = new PluginKey('dumbpadSearchHit');

const SEARCH_HIT_BLOCK_TYPES = new Set([
    'paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock',
]);
const SEARCH_HIT_LIST_ITEMS = new Set(['listItem', 'taskItem']);

export const SearchHitHighlight = Extension.create({
    name: 'searchHitHighlight',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: searchHitPluginKey,
                state: {
                    init: () => null,
                    apply: (tr, value) => {
                        const meta = tr.getMeta(searchHitPluginKey);
                        if (meta !== undefined) {
                            if (!meta || !Number.isFinite(meta.from) || !Number.isFinite(meta.to)) return null;
                            return { from: meta.from, to: meta.to };
                        }
                        if (!value) return null;
                        if (!tr.docChanged) return value;
                        const from = tr.mapping.map(value.from, -1);
                        const to = tr.mapping.map(value.to, 1);
                        if (from >= to) return null;
                        return { from, to };
                    },
                },
                props: {
                    decorations(state) {
                        const range = searchHitPluginKey.getState(state);
                        if (!range) return DecorationSet.empty;
                        try {
                            const docSize = state.doc.content.size;
                            const from = Math.min(Math.max(0, range.from), docSize);
                            const to = Math.min(Math.max(from + 1, range.to), docSize);
                            const $from = state.doc.resolve(from);
                            const decorations = [Decoration.inline($from.pos, to, {
                                class: 'search-hit-inline',
                            })];
                            // 命中所在的块：从内向外找第一个块级单元；命中在
                            // 列表/待办项里时闪烁整个条目，上下文更完整。
                            let depth = $from.depth;
                            while (depth > 0 && !SEARCH_HIT_BLOCK_TYPES.has($from.node(depth).type.name)) depth -= 1;
                            if (depth > 0) {
                                const parentType = depth > 1 ? $from.node(depth - 1).type.name : '';
                                if (SEARCH_HIT_LIST_ITEMS.has(parentType)) depth -= 1;
                                decorations.push(Decoration.node($from.before(depth), $from.after(depth), {
                                    class: 'article-search-block-hit',
                                }));
                            }
                            return DecorationSet.create(state.doc, decorations);
                        } catch (_error) {
                            return DecorationSet.empty;
                        }
                    },
                },
            }),
        ];
    },
});

/**
 * 空列表项的退格 = 清除继承来的列表标记，原地留一条缩进空行（Typora 语义）。
 *
 * 手机上没有 Tab，嵌套列表的创建路径必须是「Enter 新条目 → Backspace 清掉继承的
 * 标记 → 直接键入 `- `/`[ ] `/`1. `」。键入能不能生成嵌套列表取决于落点段落在
 * listItem 里的孩子序号：schema 里 listItem 的 content 是 `paragraph block*`，
 * **第一个孩子必须是段落**，所以对首段落做 wrap（bulletList）永远找不到合法包装
 * （findWrapping 的外围检查 `li.contentMatchAt(0).findWrapping(bulletList)` 返回
 * null），官方输入规则静默放行，`- ` 以字面文本留在条目里（真机实测复现）。而
 * **尾部空行**（第二个孩子起）落在 `block*` 段，wrap 完全合法——所以本扩展只负责
 * 把空项退格成那条尾部空行，键入侧交给官方输入规则，两半拼起来才是完整的无 Tab
 * 嵌套路径。
 *
 * 退格阶梯（每退一次只降一格，光标始终停在行首，不跳到别处）：
 *   空条目 `2. `          --退格-->  上一条目里的尾部空行（标记没了，缩进保留）
 *   上一条目的尾部空行     --退格-->  空行退出列表成顶层段落（column 0，「最开头」）
 *   嵌套空条目（无前兄弟） --退格-->  连同内层列表一起消费掉，光标上并到上一层的
 *                                文字末尾（内层列表独占时整条消失，否则只删本项）
 * 顶层首个空条目（无前兄弟）不接管：Tiptap 的 lift 本来就是「退出列表成段落」，
 * 正是阶梯的终点。
 *
 * 嵌套分支刻意「上并」而不是把空行挪进父条目：挪出来的空行会顺着阶梯退出列表，
 * 而列表下方的空行退格走 PM 默认并入（光标跳进最后一个条目的文字尾部，再退格
 * 开始吃字）——文字被吃空后本分支又把空行抽回列表上方，首尾相接成环：连续退格
 * 时光标在「列表下方空行」与「条目文字尾部」两处之间循环跳动，每圈吞掉一个
 * 字符（真机逐步复现）。上并让删除流单调向上、有限步终止；「挪空行」只在上面
 * 的 itemIndex > 0 并入分支保留，那里空行不回流，不成环。无 Tab 嵌套路径不受
 * 影响（它用的是并入分支 + 键入侧输入规则；误键 `[ ] ` 后的撤销改由
 * Enter→Backspace 两键重建空行）。
 *
 * 刻意不接管的事：
 * - 非空条目的行首退格维持 Tiptap 默认（并入上一条目），Typora 同样如此；
 * - 顶层列表**非末位**条目的尾部空行不接管（默认并轨语义）：把它拎出列表会拆断
 *   列表，有序列表的编号会被重排，代价大于收益；
 * - 嵌套无前兄弟但列表还有其他条目时，只删当前项、光标落到前一条目文字末尾，
 *   绝不吞兄弟。
 *
 * 必须注册在扩展列表**末尾**（TiptapSlashMenu 之后）：PM 的 handleKeyDown 按插件
 * 注册逆序咨询，本扩展要抢在 Tiptap listKeymap 的 Backspace（空项 lift）之前生效。
 */
export const DumbPadListBlankLineBackspace = Extension.create({
    name: 'dumbpadListBlankLineBackspace',

    addProseMirrorPlugins() {
        const LI_TYPES = ['listItem', 'taskItem'];
        let dedupeKeydownState = null;

        const domBlockHasVisibleText = (view) => {
            try {
                const { selection } = view.state;
                const pos = selection.$from.pos;
                const { node } = view.domAtPos(pos);
                const container = node?.nodeType === 3 ? node.parentElement : node;
                const block = container?.closest?.('p');
                if (!block) return false;
                return (block.textContent || '').replace(/[\u200B\uFEFF]/g, '').length > 0;
            } catch (_err) {
                return false;
            }
        };

        const runListBlankLineBackspace = (view) => {
            const { state } = view;
            const { selection } = state;
            if (!selection.empty) return false;
            const { $from } = selection;
            const parent = $from.parent;
            // 两种目标形态（空条目本体 / 条目尾部空行）都是「空段落的行首」
            if (parent.type.name !== 'paragraph') return false;
            if (parent.content.size !== 0 || $from.parentOffset !== 0) return false;

            // 阶梯终点之后：顶层空行紧跟列表时，退格 = 删除空行并把光标并入
            // 列表最后一个文字块末尾。不接管的话 PM 的 joinBackward 会把空行
            // 重新吸回列表条目（列表 + 空段边界的连接点选在 li 层），与上方
            // 的退出步首尾相接：退格在「条目内空行 ↔ 顶层空行」之间原地循环，
            // 按键等于失灵（真机逐步复现）。显式并入让删除流单调终止。
            if ($from.depth === 1 && $from.index(0) > 0) {
                const prev = $from.node(0).child($from.index(0) - 1);
                if (['bulletList', 'orderedList', 'taskList'].includes(prev.type.name)) {
                    const tr = state.tr;
                    tr.delete($from.before(1), $from.after(1));
                    tr.setSelection(TextSelection.near(tr.doc.resolve($from.before(1)), -1));
                    tr.scrollIntoView();
                    view.dispatch(tr);
                    return true;
                }
            }

            let liDepth = -1;
            for (let d = $from.depth - 1; d >= 1; d--) {
                if (LI_TYPES.includes($from.node(d).type.name)) { liDepth = d; break; }
            }
            if (liDepth < 0) return false;
            // 空段落必须是列表项的直接孩子（li > blockquote > p 这类嵌套不接管）
            if ($from.depth !== liDepth + 1) return false;

            const listItem = $from.node(liDepth);
            const listDepth = liDepth - 1;
            const list = $from.node(listDepth);
            if (!['bulletList', 'orderedList', 'taskList'].includes(list.type.name)) return false;
            const itemIndex = $from.index(listDepth);
            const paragraph = state.schema.nodes.paragraph;
            const tr = state.tr;

            const isEmptyItem = listItem.childCount === 1
                && listItem.firstChild.type.name === 'paragraph'
                && listItem.firstChild.content.size === 0;

            if (isEmptyItem) {
                if (itemIndex > 0) {
                    // 并入前一个条目，成为它的尾部空行：删掉整个空 li，在前一个
                    // li 内容末尾（liFrom-1，位于删除区间之前、位置不受影响）
                    // 插入空段落。光标落在新空行里 = 原地停留。
                    const liFrom = $from.before(liDepth);
                    tr.delete(liFrom, $from.after(liDepth));
                    tr.insert(liFrom - 1, paragraph.create());
                    tr.setSelection(TextSelection.create(tr.doc, liFrom));
                } else if (LI_TYPES.includes($from.node(listDepth - 1).type.name)) {
                    // 嵌套列表里的首个空条目：连同内层列表一起消费掉（列表
                    // 只有它）或只删它（还有兄弟），光标落在消费点之前最近
                    // 的块内内容端（通常是文字尾或紧邻的空行行首）。不把空行
                    // 挪进父条目——那会与「退出列表 → PM 默认并入」首尾相接
                    // 成环（见扩展头注释）。near 兜底覆盖「消费点前是另一个
                    // 列表」这类非文字块边界。
                    const joinAfter = (pos) => {
                        const $join = tr.doc.resolve(pos);
                        if ($join.parent.inlineContent) {
                            tr.setSelection(TextSelection.create(tr.doc, pos));
                        } else {
                            tr.setSelection(TextSelection.near($join, -1));
                        }
                    };
                    if (list.childCount > 1) {
                        tr.delete($from.before(liDepth), $from.after(liDepth));
                        joinAfter($from.before(liDepth) - 1);
                    } else {
                        tr.delete($from.before(listDepth), $from.after(listDepth));
                        joinAfter($from.before(listDepth) - 1);
                    }
                } else {
                    // 顶层首个空条目：Tiptap lift = 退出列表成段落，阶梯终点。
                    return false;
                }
            } else {
                const isTrailingBlank = listItem.childCount >= 2
                    && $from.index(liDepth) === listItem.childCount - 1;
                if (!isTrailingBlank) return false;
                const pSpan = $from.after($from.depth) - $from.before($from.depth);
                if (LI_TYPES.includes($from.node(listDepth - 1).type.name)) {
                    // 尾部空行降一级：从条目里挪到外层条目（内层列表保留）
                    const insertAt = $from.after(listDepth) - pSpan;
                    tr.delete($from.before($from.depth), $from.after($from.depth));
                    tr.insert(insertAt, paragraph.create());
                    tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
                } else {
                    // 尾部空行退出列表成顶层段落（「回到最开头」）。只在末位
                    // 条目接管——非末位拎出会拆断列表、重排有序编号。
                    if (itemIndex !== list.childCount - 1) return false;
                    const insertAt = $from.after(listDepth) - pSpan;
                    tr.delete($from.before($from.depth), $from.after($from.depth));
                    tr.insert(insertAt, paragraph.create());
                    tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
                }
            }
            tr.scrollIntoView();
            view.dispatch(tr);
            return true;
        };

        return [
            new Plugin({
                key: new PluginKey('dumbpadListBlankLineBackspace'),
                props: {
                    handleKeyDown: (view, event) => {
                        const isBackspace = event.key === 'Backspace' || event.keyCode === 8;
                        if (!isBackspace) return false;
                        // 移动端 Gboard / 中文输入法在空段落有时仍带着残留 composing 状态，
                        // 但 DOM 段落里其实没有任何待选拼音；只要当前段在 DOM 侧也是空的，
                        // 就允许退格阶梯推进；真正有未上屏候选字时不夺取退格。
                        if (view.composing && domBlockHasVisibleText(view)) return false;
                        if (!runListBlankLineBackspace(view)) return false;
                        const handledState = view.state;
                        dedupeKeydownState = handledState;
                        queueMicrotask(() => {
                            if (dedupeKeydownState === handledState) dedupeKeydownState = null;
                        });
                        return true;
                    },
                    handleDOMEvents: {
                        // Android Chrome 软键盘退格常以 keyCode 229 / Unidentified 绕过 handleKeyDown，
                        // 若放进 PM 的 beforeinput 会让原生 contenteditable 先把空 <li> 拆到行首并
                        // 触发 50ms blur/focus 闪跳。赶在原生改动之前截住 deleteContentBackward。
                        beforeinput: (view, event) => {
                            if (event?.inputType !== 'deleteContentBackward') return false;
                            if (dedupeKeydownState && dedupeKeydownState === view.state) {
                                dedupeKeydownState = null;
                                event.preventDefault?.();
                                return true;
                            }
                            dedupeKeydownState = null;
                            if (domBlockHasVisibleText(view)) return false;
                            if (!runListBlankLineBackspace(view)) return false;
                            event.preventDefault?.();
                            return true;
                        },
                    },
                },
            }),
        ];
    },
});

const MOBILE_LIST_OR_BLOCK_RULE_RE = /(?:^|\n)[ \t\u00a0\u3000]*(?:[-+*]|\d+\.|\[[ xX~]?\]|#{1,6}|>)[ \t\u00a0\u3000]$/;

/**
 * 移动端输入法与 DOM 变更路径下的输入规则补丁：
 * 1) prosemirror-view 在 compositionend 后还会延迟 20ms 才清 view.composing，而 Tiptap
 *    自带 InputRule 的 setTimeout(..., 0) 赶在这 20ms 内运行，被 `if (view.composing)` 拦掉；
 * 2) Android Chrome 对空行（<p><br></p>）直接键入 `- ` 时有时走 readDOMChange 整块提交，
 *    绕开了 handleTextInput，导致回车→退格后打 `- ` 不成嵌套列表、只剩字面文本。
 * 这里只在「当前仍是普通段落且光标前刚落入明确前缀触发串（排除 undo/paste/载入）」时，
 * 复调内核自己的 inputRulesPlugin.props.handleTextInput，完全复用现有规则优先级与撤销元数据。
 */
export const DumbPadMobileInputRuleSettler = Extension.create({
    name: 'dumbpadMobileInputRuleSettler',

    addProseMirrorPlugins() {
        const pluginKey = new PluginKey('dumbpadMobileInputRuleSettler');
        let composeFlushTimer = null;

        const runInputRulesAtCursor = (view) => {
            if (!view || view.isDestroyed || view.composing) return false;
            const { selection } = view.state;
            if (!selection.empty) return false;
            const { $from } = selection;
            if ($from.parent.type.name !== 'paragraph') return false;
            const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\n');
            if (!MOBILE_LIST_OR_BLOCK_RULE_RE.test(textBefore)) return false;
            for (const plugin of view.state.plugins) {
                if (!plugin?.spec?.isInputRules && !plugin?.isInputRules) continue;
                const handleTextInput = plugin?.props?.handleTextInput;
                if (typeof handleTextInput !== 'function') continue;
                if (handleTextInput(view, $from.pos, $from.pos, '')) return true;
            }
            return false;
        };

        return [
            new Plugin({
                key: pluginKey,
                state: {
                    init: () => ({ allowFallback: false }),
                    apply(tr) {
                        if (!tr.docChanged) return { allowFallback: false };
                        if (tr.getMeta('history$')
                            || tr.getMeta('paste')
                            || tr.getMeta('dumbpadRemotePatch')
                            || tr.getMeta('dumbpadNormalize')
                            || tr.getMeta('addToHistory') === false) {
                            return { allowFallback: false };
                        }
                        return { allowFallback: true };
                    },
                },
                props: {
                    handleDOMEvents: {
                        compositionstart: () => {
                            if (composeFlushTimer) {
                                clearTimeout(composeFlushTimer);
                                composeFlushTimer = null;
                            }
                            return false;
                        },
                        compositionend: (view) => {
                            if (composeFlushTimer) clearTimeout(composeFlushTimer);
                            // 28ms 恰好跨过 prosemirror-view 的 scheduleComposeEnd(view, 20)
                            composeFlushTimer = setTimeout(() => {
                                composeFlushTimer = null;
                                runInputRulesAtCursor(view);
                            }, 28);
                            return false;
                        },
                    },
                },
                view() {
                    return {
                        update(view, prevState) {
                            if (view.composing || view.state.doc === prevState.doc) return;
                            if (!pluginKey.getState(view.state)?.allowFallback) return;
                            const { selection } = view.state;
                            if (!selection.empty || selection.$from.parent.type.name !== 'paragraph') return;
                            const curBefore = selection.$from.parent.textBetween(0, selection.$from.parentOffset, undefined, '\n');
                            if (!MOBILE_LIST_OR_BLOCK_RULE_RE.test(curBefore)) return;
                            const prevSel = prevState.selection;
                            const prevBefore = prevSel.empty && prevSel.$from.parent.type.name === 'paragraph'
                                ? prevSel.$from.parent.textBetween(0, prevSel.$from.parentOffset, undefined, '\n')
                                : '';
                            if (curBefore === prevBefore || curBefore.length <= prevBefore.length) return;
                            queueMicrotask(() => {
                                runInputRulesAtCursor(view);
                            });
                        },
                        destroy() {
                            if (composeFlushTimer) {
                                clearTimeout(composeFlushTimer);
                                composeFlushTimer = null;
                            }
                        },
                    };
                },
            }),
        ];
    },
});

/**
 * 列表项首段落上的 `[ ] ` 就地转待办——修复内核输入规则的「逃逸到根」。
 *
 * 用户逐键输入 `- [ ] ` 造嵌套待办时，`- ` 先把空行转成子弹列表，随后的
 * `[ ] ` 落在**新列表项的第一个段落**上。内核 TaskItem 输入规则此时对首段落
 * 做 wrap：schema 里 listItem 的 content 是 `paragraph block*`，首孩子必须是
 * 段落，wrap 永远失败，内核 v3 回退到「抬升 + 重组」——把当前项一路 lift 到
 * 能 wrap 的层级。列表**嵌套**时这个层级是文档根：taskList 跳出所有容器渲染
 * 在最左边，整个子弹列表被吞掉（真机+jsdom 双重复现）。
 *
 * 本规则以 priority: 101 先于内核规则（100）运行，只接管特征明确的一类场景：
 * 选区在段落内容起点、段落是 listItem/taskItem 的第一个孩子、外层列表恰好
 * 只有当前一项（`- ` 刚转出来的新建态）。处理方式是**就地**把整条列表换成
 * 等价的 taskList（每个子节点原样搬进 taskItem），位置与嵌套层级都不变；
 * 多条目列表与顶层单条目列表仍走内核路径（内核对它们的拆分/转换语义正确）。
 * `[x] ` 变体同样接住（大小写沿用解析侧的宽窄约定，x/X 都认）；`[~] ` 也接，
 * 但同样只认「新建态」，多条目列表里的 `[~] ` 仍交给 TaskListInputShortcut
 * （它的范围更宽，捕获组多了 `~`）——这里不抢它的场景。
 *
 * 处理器先删匹配文本再在**删除后的文档**上重新定位列表跨度（删除会让列表
 * 终点前移），步骤数非空即视为已处理，runner 不再咨询内核规则。
 */
export const DumbPadTaskItemInPlaceShortcut = Extension.create({
    name: 'dumbpadTaskItemInPlaceShortcut',

    priority: 101,

    addInputRules() {
        return [new InputRule({
            find: /^\s*(\[([ xX~])?\])\s$/,
            handler: ({ state, range, match }) => {
                const { selection } = state;
                if (!selection.empty) return null;
                const { $from } = selection;
                if ($from.parent.type.name !== 'paragraph') return null;
                // 块首复核：匹配必须从段落内容起点开始（500 字符回看窗口的 ^
                // 会误中窗口开头而非块首）。
                if (range.from !== $from.start()) return null;
                let liDepth = -1;
                for (let d = $from.depth - 1; d >= 1; d--) {
                    if (['listItem', 'taskItem'].includes($from.node(d).type.name)) { liDepth = d; break; }
                }
                if (liDepth < 0) return null;
                // 段落必须是列表项的直接孩子，且是**第一个孩子**——尾部空行
                // （第二个孩子起）落在 block* 段，内核 wrap 本来就成功，不许劫持。
                if ($from.depth !== liDepth + 1) return null;
                if ($from.index(liDepth) !== 0) return null;
                const listDepth = liDepth - 1;
                const list = $from.node(listDepth);
                if (!['bulletList', 'orderedList'].includes(list.type.name)) return null;
                // 只接管新建态：整条列表就是当前这一项
                if (list.childCount !== 1) return null;

                const taskListType = state.schema.nodes.taskList;
                const taskItemType = state.schema.nodes.taskItem;
                if (!taskListType || !taskItemType) return null;
                const mark = (match?.[2] || '').toLowerCase();

                const tr = state.tr;
                tr.delete(range.from, range.to);
                // 删除会让列表跨度终点前移：在删除后的文档上重新定位
                const $caret = tr.doc.resolve(Math.min(range.from, tr.doc.content.size));
                const listItem = $caret.node(liDepth);
                const listNode = $caret.node(listDepth);
                const children = [];
                listItem.forEach(child => children.push(child));
                const taskItemNode = taskItemType.create({ checked: mark === 'x', doing: mark === '~' }, children);
                const taskListNode = taskListType.create(
                    { tight: listNode.attrs.tight ?? true },
                    [taskItemNode],
                );
                const listFrom = $caret.before(listDepth);
                tr.replaceWith(listFrom, $caret.after(listDepth), taskListNode);
                // replaceWith 对替换区间内部的光标映射不可靠：显式落回
                // taskItem 首段落的内容起点（taskList 开 1 + taskItem 开 1 +
                // 段落开 1），后续键入才在待办里。
                tr.setSelection(TextSelection.create(tr.doc, listFrom + 3));
                tr.scrollIntoView();
            },
        })];
    },
});

/**
 * 移动端 PWA 代码块输入与粘贴守卫：
 * 1) prosemirror-view 在 Android Chrome 上跳过 keyCode 13 的 handleKeyDown，且移动软键盘/IME
 *    的 keyCode 229 或组合态也会绕过 keydown；同时代码块内的 contentDOM（`code`）设为
 *    `display: block` 后，浏览器原生的 `insertParagraph` / `insertLineBreak` / `insertFromPaste` /
 *    含换行符的 `insertText` 会直接在 `<pre>` 下拆出多个同级 `<code>` 或 `<div>`——且被
 *    NodeView 的 `ignoreMutation` 视为 contentDOM 之外而忽略，导致屏幕看似输入成功、源码与
 *    行号却停在第一行、退格跳回第一行、删空第一行后整块消失。
 * 2) 在 `beforeinput` 层拦截 `insertParagraph` / `insertLineBreak` / `insertFromPaste` /
 *    带换行的 `insertText` / `insertReplacementText`，统一走 ProseMirror 事务（含三连回车退出）。
 * 3) 对组合态下的 `paste`（iOS Safari 会跳过 editHandlers.paste）及不可取消的 DOM 拆分
 *    （如 `insertCompositionText` 或原生 HTML 注入），在 `input` / `compositionend` 时
 *    通过 `reconcileCodeBlockDOM` 把游离 DOM 与光标精确折叠回唯一 contentDOM。
 */
export const DumbPadCodeBlockInputGuard = Extension.create({
    name: 'dumbpadCodeBlockInputGuard',

    addProseMirrorPlugins() {
        const editor = this.editor;

        const flushPendingDOM = (view) => {
            if (!view?.domObserver) return;
            if (view.domObserver.flushingSoon > -1) {
                view.domObserver.forceFlush?.();
            } else {
                view.domObserver.flush?.();
            }
        };

        const getCodeBlockContext = (view) => {
            if (!view?.editable) return null;
            const { selection } = view.state;
            const { $from, $to } = selection;
            if ($from.parent.type.name !== 'codeBlock' || !$from.sameParent($to)) return null;
            const blockStart = $from.start();
            return {
                selection,
                $from,
                blockStart,
                blockEnd: blockStart + $from.parent.content.size,
            };
        };

        const resolveTargetRange = (view, event, context) => {
            const targetRange = typeof event?.getTargetRanges === 'function' ? event.getTargetRanges()[0] : null;
            if (targetRange && typeof view.posAtDOM === 'function') {
                try {
                    const start = view.posAtDOM(targetRange.startContainer, targetRange.startOffset);
                    const end = view.posAtDOM(targetRange.endContainer, targetRange.endOffset);
                    const from = Math.max(context.blockStart, Math.min(start, end, context.blockEnd));
                    const to = Math.max(from, Math.min(Math.max(start, end), context.blockEnd));
                    return [from, to];
                } catch (_error) {
                    // 目标范围不在视图内时回落当前选区。
                }
            }
            return [context.selection.from, context.selection.to];
        };

        const insertNormalizedText = (view, from, to, rawText, { isPaste = false } = {}) => {
            const normalized = String(rawText ?? '').replace(/\r\n?/g, '\n');
            const tr = view.state.tr.insertText(normalized, from, to);
            if (isPaste) tr.setMeta('paste', true);
            const hasLayout = typeof document.createRange?.().getClientRects === 'function';
            view.dispatch(hasLayout ? tr.scrollIntoView() : tr);
            return true;
        };

        const applyEnterInCodeBlock = (view, context, allowTripleExit) => {
            const { selection, $from } = context;
            const codeBlockExt = editor?.extensionManager?.extensions?.find(ext => ext.name === 'codeBlock');
            const exitEnabled = codeBlockExt?.options?.exitOnTripleEnter !== false;
            if (allowTripleExit
                && exitEnabled
                && selection.empty
                && $from.parentOffset === $from.parent.content.size
                && $from.parent.textContent.endsWith('\n\n')
                && typeof editor?.chain === 'function') {
                return editor.chain().command(({ tr }) => {
                    tr.delete($from.pos - 2, $from.pos);
                    return true;
                }).exitCode().run();
            }
            return insertNormalizedText(view, selection.from, selection.to, '\n');
        };

        return [
            new Plugin({
                key: new PluginKey('dumbpadCodeBlockInputGuard'),
                props: {
                    handleDOMEvents: {
                        beforeinput: (view, event) => {
                            if (!view?.editable || event?.defaultPrevented) return false;
                            const inputType = event?.inputType;
                            if (inputType !== 'insertParagraph'
                                && inputType !== 'insertLineBreak'
                                && inputType !== 'insertFromPaste'
                                && inputType !== 'insertText'
                                && inputType !== 'insertReplacementText') {
                                return false;
                            }

                            const wrapper = findCodeBlockWrapperFromEvent(view, event);
                            if (wrapper) reconcileCodeBlockDOM(view, wrapper);

                            if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') {
                                flushPendingDOM(view);
                                const context = getCodeBlockContext(view);
                                if (!context) return false;
                                event.preventDefault?.();
                                return applyEnterInCodeBlock(view, context, inputType === 'insertParagraph');
                            }

                            if (inputType === 'insertFromPaste') {
                                const raw = event.dataTransfer?.getData?.('text/plain')
                                    || event.dataTransfer?.getData?.('Text')
                                    || (typeof event.data === 'string' ? event.data : '');
                                if (!raw) return false;
                                flushPendingDOM(view);
                                const context = getCodeBlockContext(view);
                                if (!context) return false;
                                event.preventDefault?.();
                                const [from, to] = resolveTargetRange(view, event, context);
                                return insertNormalizedText(view, from, to, raw, { isPaste: true });
                            }

                            if (!event.isComposing && typeof event.data === 'string' && /[\r\n]/.test(event.data)) {
                                flushPendingDOM(view);
                                const context = getCodeBlockContext(view);
                                if (!context) return false;
                                event.preventDefault?.();
                                const [from, to] = resolveTargetRange(view, event, context);
                                return insertNormalizedText(view, from, to, event.data);
                            }
                            return false;
                        },
                        paste: (view, event) => {
                            const context = getCodeBlockContext(view);
                            if (!context) return false;
                            const clipboardData = event?.clipboardData;
                            if (!clipboardData) return false;
                            const plain = clipboardData.getData('text/plain') || clipboardData.getData('Text') || '';
                            const html = clipboardData.getData('text/html') || '';
                            if (!view.composing && (plain || !html)) return false;
                            const extracted = plain || extractClipboardHtmlText(html);
                            if (!extracted && plain === '' && !html) return false;
                            event.preventDefault?.();
                            return insertNormalizedText(view, context.selection.from, context.selection.to, extracted, { isPaste: true });
                        },
                        input: (view, event) => {
                            if (!view?.editable || view.composing || event?.isComposing) return false;
                            const wrapper = findCodeBlockWrapperFromEvent(view, event);
                            if (wrapper) reconcileCodeBlockDOM(view, wrapper);
                            return false;
                        },
                        compositionend: (view, event) => {
                            const wrapper = findCodeBlockWrapperFromEvent(view, event);
                            if (!wrapper) return false;
                            queueMicrotask(() => {
                                if (!view.isDestroyed && !view.composing) {
                                    reconcileCodeBlockDOM(view, wrapper);
                                }
                            });
                            return false;
                        },
                    },
                },
            }),
        ];
    },
});

/* ============================================================================
 * 精简 GFM Callout 提示块（A4 雾底左浮标风：仅支持 NOTE / TIP / WARNING）
 * - 完全不改动 ProseMirror 文档结构（底层仍是 blockquote > paragraph），
 *   序列化与 Markdown 往返零迁移；
 * - 由 CalloutDecorator 用 PM Decoration 挂出 .dumbpad-callout / 标题图标 widget /
 *   首行标记类，编辑态保留可编辑的 [!TYPE] 微标，阅读态自动隐藏纯语法标签。
 * ============================================================================ */

export const CALLOUT_SPECS = Object.freeze({
    note: Object.freeze({
        label: '备注',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    }),
    tip: Object.freeze({
        label: '提示',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>',
    }),
    warning: Object.freeze({
        label: '注意',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
    }),
});

export function parseCalloutBlockquote(bqNode, bqPos) {
    if (!bqNode || bqNode.type.name !== 'blockquote') return null;
    const firstPara = bqNode.firstChild;
    if (!firstPara || firstPara.type.name !== 'paragraph') return null;

    const firstParaPos = bqPos + 1;
    const contentStart = firstParaPos + 1;

    let leadingText = '';
    let firstHardBreakPos = null;
    let hasInlineAfterLeadingText = false;

    for (let i = 0; i < firstPara.childCount; i += 1) {
        const child = firstPara.child(i);
        if (child.isText) {
            if (firstHardBreakPos === null) {
                leadingText += child.text || '';
                continue;
            }
            hasInlineAfterLeadingText = true;
            break;
        }
        if (child.type.name === 'hardBreak' && firstHardBreakPos === null) {
            firstHardBreakPos = contentStart + leadingText.length;
            continue;
        }
        hasInlineAfterLeadingText = true;
        break;
    }

    const match = leadingText.match(/^(\[!(NOTE|TIP|WARNING)\])(?:([ \t]+)|$)/i);
    if (!match) return null;

    const kind = match[2].toLowerCase();
    const rawTag = match[1];
    const sepSpaces = match[3] || '';
    const remainder = leadingText.slice(match[0].length);

    let tagTo = contentStart + rawTag.length;
    let breakPos = null;
    let isTagOnlyParagraph = false;

    if (firstHardBreakPos !== null && remainder.length === 0) {
        // 形式：[!NOTE]\n正文
        tagTo = contentStart + match[0].length;
        breakPos = firstHardBreakPos;
    } else if (remainder.length === 0 && !hasInlineAfterLeadingText) {
        // 形式：[!NOTE] 独占第一段（如 > [!NOTE]\n>\n> 正文 或刚插入尚未输入）
        tagTo = contentStart + match[0].length;
        isTagOnlyParagraph = bqNode.childCount > 1;
    } else {
        // 形式：[!NOTE] 正文在同一视觉行（把 1 个分隔空格一起纳进 tag，阅读态隐去时正文左齐）
        tagTo = contentStart + rawTag.length + (sepSpaces ? 1 : 0);
    }

    return {
        kind,
        bqPos,
        bqEnd: bqPos + bqNode.nodeSize,
        firstParaPos,
        firstParaEnd: firstParaPos + firstPara.nodeSize,
        tagFrom: contentStart,
        tagTo,
        breakPos,
        isTagOnlyParagraph,
    };
}

function createCalloutHeaderEl(kind) {
    const spec = CALLOUT_SPECS[kind] || CALLOUT_SPECS.note;
    const header = document.createElement('div');
    header.className = 'dumbpad-callout-header';
    header.setAttribute('contenteditable', 'false');
    header.innerHTML = `<span class="dumbpad-callout-icon" aria-hidden="true">${spec.icon}</span><span class="dumbpad-callout-title">${spec.label}</span>`;
    return header;
}

function isCaretEditingCalloutTag(parsed, selection) {
    if (!selection) return false;
    const { from, to } = selection;
    // 只有光标真实落在 `[!NOTE]` 标签自身区间（或折行前的行尾）才显露微源码标记；
    // 落在标签后面的 `<br>` 之后或同一行正文里时，编辑态与阅读态一样呈现干净正文。
    const upperBound = parsed.breakPos !== null ? parsed.breakPos : parsed.tagTo - 1;
    return from >= parsed.tagFrom && from <= Math.max(parsed.tagFrom, upperBound) && to <= Math.max(parsed.tagFrom, upperBound);
}

function buildCalloutDecorationState(doc, selection) {
    if (!doc) return { hasCallout: false, set: DecorationSet.empty };
    const decorations = [];
    let hasCallout = false;
    doc.descendants((node, pos) => {
        if (node.type.name !== 'blockquote') return true;
        const parsed = parseCalloutBlockquote(node, pos);
        if (!parsed) return true;
        hasCallout = true;

        const spec = CALLOUT_SPECS[parsed.kind];
        const editingTag = isCaretEditingCalloutTag(parsed, selection);
        decorations.push(Decoration.node(parsed.bqPos, parsed.bqEnd, {
            class: `dumbpad-callout is-callout-${parsed.kind}${editingTag ? ' is-callout-editing-tag' : ''}`,
            'data-callout': parsed.kind,
            'data-callout-label': spec.label,
        }));
        decorations.push(Decoration.widget(
            parsed.bqPos + 1,
            () => createCalloutHeaderEl(parsed.kind),
            {
                side: -1,
                ignoreSelection: true,
                key: `callout-head-${parsed.kind}`,
            }
        ));
        if (parsed.tagTo > parsed.tagFrom) {
            decorations.push(Decoration.inline(parsed.tagFrom, parsed.tagTo, {
                class: 'dumbpad-callout-tag',
            }));
        }
        if (parsed.breakPos !== null) {
            decorations.push(Decoration.node(parsed.breakPos, parsed.breakPos + 1, {
                class: 'dumbpad-callout-tag-break',
            }));
        }
        if (parsed.isTagOnlyParagraph) {
            decorations.push(Decoration.node(parsed.firstParaPos, parsed.firstParaEnd, {
                class: 'dumbpad-callout-tag-line',
            }));
        }
        return true;
    });
    return {
        hasCallout,
        set: decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty,
    };
}

export const calloutDecoratorPluginKey = new PluginKey('dumbpadCalloutDecorator');

export const CalloutDecorator = Extension.create({
    name: 'calloutDecorator',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: calloutDecoratorPluginKey,
                state: {
                    init: (_config, instance) => buildCalloutDecorationState(instance.doc, instance.selection),
                    apply: (tr, value) => {
                        if (tr.docChanged) return buildCalloutDecorationState(tr.doc, tr.selection);
                        if (tr.selectionSet && value?.hasCallout) {
                            return buildCalloutDecorationState(tr.doc, tr.selection);
                        }
                        return value;
                    },
                },
                props: {
                    decorations(state) {
                        return calloutDecoratorPluginKey.getState(state)?.set || DecorationSet.empty;
                    },
                    handleKeyDown(view, event) {
                        if (!view?.editable || event?.key !== 'Backspace' || event?.isComposing) return false;
                        const { selection } = view.state;
                        if (!selection?.empty) return false;
                        const $from = selection.$from;
                        if ($from.depth < 2 || $from.node($from.depth - 1).type.name !== 'blockquote') return false;
                        const bqNode = $from.node($from.depth - 1);
                        const bqPos = $from.before($from.depth - 1);
                        const parsed = parseCalloutBlockquote(bqNode, bqPos);
                        if (!parsed || parsed.breakPos === null || selection.from !== parsed.breakPos + 1) return false;

                        event.preventDefault();
                        const tr = view.state.tr;
                        const firstPara = bqNode.firstChild;
                        const hasBodyInFirstPara = (parsed.breakPos + 1) < (parsed.firstParaEnd - 1);
                        const paraType = view.state.schema.nodes.paragraph;
                        if (bqNode.childCount === 1 && !hasBodyInFirstPara && paraType) {
                            // 空提示块正文行首按退格：直接还原为干净普通空段落
                            tr.replaceWith(parsed.bqPos, parsed.bqEnd, paraType.create());
                            tr.setSelection(TextSelection.create(tr.doc, parsed.bqPos + 1));
                        } else if (firstPara) {
                            // 带正文的提示块首行退格：摘掉 [!TYPE]+<br>，退成普通引用（再按退格由 QuoteBackspaceShortcut 抬出）
                            tr.delete(parsed.tagFrom, parsed.breakPos + 1);
                            tr.setSelection(TextSelection.create(tr.doc, parsed.tagFrom));
                        }
                        view.dispatch(tr.scrollIntoView());
                        return true;
                    },
                },
            }),
        ];
    },
});

/**
 * 单独控制某一个标题居中（整块节点属性 align: 'center' | null）：
 * - Markdown 持久化形态为 `# <center>文本</center>`，兼容 CommonMark 行内标记
 *   （加粗/高亮/批注/链接均可嵌套），目录与自动标题剥离包装标签，分享页与刷新后一致；
 * - 解析期将仅含 `<center>` 包裹层的标题还原为原生节点属性 `data-align="center"`，
 *   编辑器内无冗余 `<center>` DOM；支持 `Mod-Shift-E` 与块级命令切换。
 */
export function unwrapCenteredHeadings(element) {
    if (!element?.querySelectorAll) return element;
    element.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
        const rawAlign = heading.getAttribute('data-align')
            || heading.getAttribute('align')
            || heading.style?.textAlign
            || '';
        if (String(rawAlign).trim().toLowerCase() === 'center') {
            heading.setAttribute('data-align', 'center');
        }
        const nonEmptyNodes = Array.from(heading.childNodes).filter(
            (node) => node.nodeType !== 3 || String(node.textContent || '').trim() !== '',
        );
        const centerWrappers = nonEmptyNodes.filter(
            (node) => node.nodeType === 1 && node.tagName === 'CENTER',
        );
        if (centerWrappers.length > 0 && centerWrappers.length === nonEmptyNodes.length) {
            heading.setAttribute('data-align', 'center');
            centerWrappers.forEach((wrapper) => {
                const fragment = wrapper.ownerDocument.createDocumentFragment();
                while (wrapper.firstChild) fragment.appendChild(wrapper.firstChild);
                wrapper.replaceWith(fragment);
            });
        }
    });
    return element;
}

const BaseHeading = StarterKit?.config?.addExtensions?.call({ options: {} })
    ?.find((ext) => ext?.name === 'heading')
    || Node.create({ name: 'heading', content: 'inline*', group: 'block', defining: true });

export const DumbPadHeading = BaseHeading.extend({
    addAttributes() {
        return {
            ...(this.parent?.() || {}),
            align: {
                default: null,
                parseHTML: (element) => {
                    const raw = element.getAttribute('data-align')
                        || element.getAttribute('align')
                        || element.style?.textAlign;
                    if (String(raw || '').trim().toLowerCase() === 'center') return 'center';
                    if (element.querySelector?.(':scope > center')) return 'center';
                    return null;
                },
                renderHTML: (attributes) => (attributes.align === 'center' ? { 'data-align': 'center' } : {}),
            },
        };
    },

    addCommands() {
        return {
            ...(this.parent?.() || {}),
            setHeadingAlign: (align) => ({ tr, dispatch }) => {
                const { $from } = tr.selection;
                if ($from.parent?.type?.name !== 'heading') return false;
                const pos = $from.before($from.depth);
                const node = $from.parent;
                const nextAlign = align === 'center' ? 'center' : null;
                if ((node.attrs?.align || null) === nextAlign) return true;
                if (dispatch) {
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: nextAlign });
                }
                return true;
            },
            toggleHeadingCenter: () => ({ tr, dispatch }) => {
                const { $from } = tr.selection;
                if ($from.parent?.type?.name !== 'heading') return false;
                const pos = $from.before($from.depth);
                const node = $from.parent;
                const nextAlign = node.attrs?.align === 'center' ? null : 'center';
                if (dispatch) {
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: nextAlign });
                }
                return true;
            },
        };
    },

    addKeyboardShortcuts() {
        return {
            ...(this.parent?.() || {}),
            'Mod-Shift-e': () => this.editor.commands.toggleHeadingCenter(),
            'Mod-Shift-E': () => this.editor.commands.toggleHeadingCenter(),
        };
    },

    addStorage() {
        const coreMarkdown = getMarkdownSpec(BaseHeading) ?? {};
        return {
            markdown: {
                ...coreMarkdown,
                serialize(serializer, node) {
                    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
                    serializer.write(`${serializer.repeat('#', level)} `);
                    if (node.attrs?.align === 'center') serializer.write('<center>');
                    serializer.renderInline(node, false);
                    if (node.attrs?.align === 'center') serializer.write('</center>');
                    serializer.closeBlock(node);
                },
                parse: {
                    ...(coreMarkdown.parse || {}),
                    updateDOM: (element) => unwrapCenteredHeadings(element),
                },
            },
        };
    },
});

const HEADING_ALIGN_ICON_LEFT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="19" y2="18"/></svg>';
const HEADING_ALIGN_ICON_CENTER = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';

export const headingAlignControlPluginKey = new PluginKey('dumbpadHeadingAlignControl');

class HeadingAlignControlView {
    constructor(view, editor) {
        this.view = view;
        this.editor = editor;
        this.visible = false;
        this.rafId = 0;

        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.className = 'dumbpad-heading-align-btn';
        this.button.hidden = true;
        this.button.setAttribute('aria-label', '居中当前标题 (Ctrl+Shift+E)');
        this.button.setAttribute('title', '居中当前标题 (Ctrl+Shift+E)');
        this.iconSpan = document.createElement('span');
        this.iconSpan.className = 'dumbpad-heading-align-icon';
        this.button.append(this.iconSpan);
        document.body.appendChild(this.button);

        this.onPointerDown = (event) => {
            if (event.type === 'pointerdown') {
                if (event.pointerType === 'mouse') clearTouchPointerActivity();
                else if (event.pointerType) markTouchPointerActivity();
            }
            event.preventDefault();
            event.stopPropagation();
        };
        this.onClick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.editor.commands.toggleHeadingCenter();
            settleEditorFocusAfterAction(this.view, { keepFocusOnDesktop: true, event });
            this.sync();
        };
        this.onScroll = () => this.schedulePosition();
        this.onResize = () => this.schedulePosition();
        this.onBlur = () => {
            setTimeout(() => {
                if (!this.view.hasFocus() && document.activeElement !== this.button) {
                    this.hide();
                }
            }, 90);
        };

        this.button.addEventListener('pointerdown', this.onPointerDown);
        this.button.addEventListener('mousedown', this.onPointerDown);
        this.button.addEventListener('click', this.onClick);
        document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
        window.addEventListener('resize', this.onResize, { passive: true });
        this.view.dom.addEventListener('blur', this.onBlur, true);
        this.sync();
    }

    getActiveHeading(state) {
        if (!this.view.editable || !this.view.dom?.isConnected) return null;
        const shell = this.view.dom.closest('.typora-editor-shell');
        if (!shell || shell.classList.contains('is-reading-mode') || shell.classList.contains('is-source-mode')) {
            return null;
        }
        if (document.body.classList.contains('thoughts-mode') || document.body.classList.contains('today-drafts-mode')) {
            return null;
        }
        const { selection } = state;
        if (!selection?.empty) return null;
        const { $from } = selection;
        if ($from.parent?.type?.name !== 'heading') return null;
        if (!this.view.hasFocus() && document.activeElement !== this.button) return null;
        return {
            pos: $from.before($from.depth),
            node: $from.parent,
        };
    }

    sync() {
        const active = this.getActiveHeading(this.view.state);
        if (!active) {
            this.hide();
            return;
        }
        const centered = active.node.attrs?.align === 'center';
        const tip = centered ? '恢复标题左对齐 (Ctrl+Shift+E)' : '居中当前标题 (Ctrl+Shift+E)';
        this.button.classList.toggle('is-active', centered);
        this.button.setAttribute('aria-pressed', String(centered));
        this.button.setAttribute('aria-label', tip);
        this.button.setAttribute('title', tip);
        this.iconSpan.innerHTML = centered ? HEADING_ALIGN_ICON_LEFT : HEADING_ALIGN_ICON_CENTER;
        this.button.hidden = false;
        this.visible = true;
        this.position(active.pos);
    }

    schedulePosition() {
        if (!this.visible || this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            const active = this.getActiveHeading(this.view.state);
            if (!active) {
                this.hide();
                return;
            }
            this.position(active.pos);
        });
    }

    position(headingPos) {
        const dom = this.view.nodeDOM(headingPos);
        const rect = dom?.getBoundingClientRect?.();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;
        const card = this.view.dom.getBoundingClientRect();
        const scroller = this.view.dom.closest('.vditor-wysiwyg') || this.view.dom.closest('.typora-editor-shell');
        const visRect = scroller?.getBoundingClientRect?.() || card;
        const vvTop = window.visualViewport?.offsetTop || 0;
        const vvHeight = window.visualViewport?.height || window.innerHeight || 800;
        const vvWidth = window.visualViewport?.width || window.innerWidth || 1200;

        const boundTop = Math.max(vvTop + 56, Math.max(card.top, visRect.top) + 10);
        const boundBottom = Math.min(vvTop + vvHeight - 8, Math.min(card.bottom, visRect.bottom) - 10);
        if (rect.bottom <= boundTop - 2 || rect.top >= boundBottom + 2) {
            this.button.hidden = true;
            return;
        }
        this.button.hidden = false;

        const cs = window.getComputedStyle(this.view.dom);
        const padLeft = Math.max(12, parseFloat(cs.paddingLeft) || 40);
        const padRight = Math.max(14, parseFloat(cs.paddingRight) || 40);
        const proseLeft = card.left + Math.min(padLeft, 24);
        const proseRight = Math.min(card.right - Math.min(padRight, 26), visRect.right - 14, vvWidth - 12);

        const btnRect = this.button.getBoundingClientRect();
        const btnW = btnRect.width || 26;
        const btnH = btnRect.height || 26;

        let left = proseRight - btnW;
        // 避免和右侧垂直悬浮工具条重叠
        const fabRect = document.querySelector('#floating-actions:not([hidden]), .floating-actions-bar:not([hidden])')?.getBoundingClientRect?.();
        if (fabRect && left + btnW > fabRect.left - 6 && left < fabRect.right + 6) {
            const shifted = fabRect.left - btnW - 8;
            if (shifted >= proseLeft) left = shifted;
        }
        left = Math.max(proseLeft, Math.min(left, Math.max(proseLeft, proseRight - btnW)));

        // 默认对齐标题首行中线（轻量融入行右端，不再飞出白纸右上圆角外）；若左对齐超长文字占满行宽则顺滑上/下让位。
        const hStyle = window.getComputedStyle(dom);
        const lineH = Math.min(rect.height, parseFloat(hStyle.lineHeight) || rect.height || 30);
        let textEndRight = rect.right;
        if (dom.firstChild && typeof document.createRange === 'function') {
            try {
                const range = document.createRange();
                range.selectNodeContents(dom);
                const tRect = range.getBoundingClientRect();
                if (tRect && tRect.width > 0) textEndRight = tRect.right;
            } catch (_) {}
        }

        let top = rect.top + (lineH - btnH) / 2;
        if (textEndRight > left - 8) {
            const above = rect.top - btnH - 4;
            top = above >= boundTop ? above : Math.min(rect.bottom + 4, boundBottom - btnH);
        }
        top = Math.max(boundTop, Math.min(top, Math.max(boundTop, boundBottom - btnH)));
        this.button.style.left = `${Math.round(left)}px`;
        this.button.style.top = `${Math.round(top)}px`;
    }

    hide() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }
        if (!this.visible) return;
        this.visible = false;
        this.button.hidden = true;
    }

    update() {
        this.sync();
    }

    destroy() {
        this.hide();
        this.button.removeEventListener('pointerdown', this.onPointerDown);
        this.button.removeEventListener('mousedown', this.onPointerDown);
        this.button.removeEventListener('click', this.onClick);
        document.removeEventListener('scroll', this.onScroll, { capture: true });
        window.removeEventListener('resize', this.onResize);
        this.view.dom.removeEventListener('blur', this.onBlur, true);
        this.button.remove();
    }
}

export const HeadingAlignControl = Extension.create({
    name: 'headingAlignControl',

    addProseMirrorPlugins() {
        const editor = this.editor;
        return [
            new Plugin({
                key: headingAlignControlPluginKey,
                view: (view) => new HeadingAlignControlView(view, editor),
            }),
        ];
    },
});
