/**
 * Tiptap Schema 扩展：批注、蓝色划线、高亮、时间标记与软换行。
 * 存储/渲染形态必须与旧 Vditor 适配器逐字节对齐（hybrid-editor.js 的
 * restoreAllRenderedMarks / renderInlineMarks 与 time-command.js），
 * roundtrip 兼容由 test/test_tiptap_roundtrip.js 固化，改动前先读它。
 */
import { Mark, Node, Extension, TaskList, TaskItem, InputRule, findParentNode, CodeBlockLowlight, Underline, PM } from './tiptap-runtime.js';
import { TIME_COMMAND, parseTimeMarkerText, buildTimeMarker } from './time-command.js';
import { buildCodeBlockNodeView } from './tiptap-code-block-view.js';
import { buildTaskItemNodeView } from './tiptap-task-item-view.js';

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
 * `underline 2.5px wavy rgb(231, 76, 60)`，对划线的 `underline blue` 返回 `underline 2px blue`
 * ——两者都含 'underline'，于是被额外套上 underline mark。后果不只是多一条直线：
 * **`<u>` 会被写回正文**（存进去是 `<span data-note=…>`，刷新一次再保存就变成
 * `<u><span data-note=…></u>`）。改成只写长属性也躲不开，因为查的就是简写名。
 *
 * 因此带颜色 / 粗细 / 线型（wavy、dashed、dotted）的装饰一律不当作 underline：那是批注、
 * 划线或外部富文本的语义，不是「正文加下划线」。`solid` 是初始值，允许显式写出来。
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
    if (silent) return true;
    const token = state.push('fence', 'code', 0);
    token.info = 'dumbpad-frontmatter';
    token.markup = '---';
    token.content = state.getLines(startLine + 1, closing, 0, true);
    token.map = [startLine, closing + 1];
    state.line = closing + 1;
    return true;
}

/** 普通段落回车=软换行：与旧 handleWysiwygSoftEnter 行为一致——
 * 仅拦截"doc > paragraph"的顶层普通段落且非空时，Enter 插入段内换行
 * 而非拆分段落；标题/列表/引用/代码保持各自默认回车行为。 */
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
                        if (!selection.empty || selection.$from.parent.type.name !== 'paragraph') return false;
                        if (selection.$from.depth !== 1) return false;
                        const paragraph = selection.$from.parent;
                        if (!paragraph.textContent.replace(/[\u200B\uFEFF]/g, '').trim()) return false;
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
 * 不覆盖 `---`/`___`/``` 围栏：`---` 紧跟在一行文字后面时，markdown 语义是 setext 标题下划线
 * 而不是分隔线，就地拆块会与重新解析打架，属于另一个决策，不在这里顺手改。
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
                /\n[ \t]*(#{1,6})[ \t]$/,
                (chain, match) => chain.setNode('heading', { level: match[1].length }),
                (match, can) => levels.includes(match[1].length)
                    && can.setNode('heading', { level: match[1].length }),
            ),
            blockRule(
                /\n[ \t]*([-+*])[ \t]$/,
                chain => chain.toggleBulletList(),
                (match, can) => can.toggleBulletList(),
            ),
            blockRule(
                /\n[ \t]*(\d+)\.[ \t]$/,
                (chain, match) => chain
                    .toggleOrderedList()
                    .updateAttributes('orderedList', { start: Number(match[1]) }),
                (match, can) => can.toggleOrderedList(),
            ),
            blockRule(
                /\n[ \t]*>[ \t]$/,
                chain => chain.toggleBlockquote(),
                (match, can) => can.toggleBlockquote(),
            ),
        ];
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

/** 待办输入（Typora 流程，列表内）：无序列表项里输入 "[ ]"/"[x]" 再按
 * 空格，把当前列表转成任务列表。官方 TaskItem 的 input rule 只覆盖顶层
 * 普通段落（listItem 的 contentMatch 无法 findWrapping 到 taskItem），
 * 这里只接管列表内场景：删除括号文本后完全交给框架命令
 * toggleList('taskList', 'taskItem') 完成转换，不手写节点构造与光标计算。 */
export const TaskListInputShortcut = Extension.create({
    name: 'taskListInputShortcut',

    addInputRules() {
        return [
            new InputRule({
                find: /\[([ xX])?\]\s$/,
                handler: ({ state, range, chain, match }) => {
                    const listItem = findParentNode(node => node.type.name === 'listItem')(state.selection);
                    if (!listItem) return;
                    const checked = (match[1] || '').toLowerCase() === 'x';
                    chain()
                        .deleteRange(range)
                        .toggleList('taskList', 'taskItem', false)
                        .updateAttributes('taskItem', { checked })
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
        return ({ node, view }) => buildCodeBlockNodeView()({ node, view });
    },
});

// 官方 TaskItem 的 change 处理器闭包 getPos 在真实应用中返回 undefined，
// 勾选会静默丢失；换成自管视图（posAtDOM 反查位置）。
export const DumbPadTaskItem = TaskItem.extend({
    addNodeView() {
        return ({ node, view }) => buildTaskItemNodeView()({ node, view });
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
