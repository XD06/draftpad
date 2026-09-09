/**
 * Tiptap Schema 扩展：批注、蓝色划线、高亮、时间标记与软换行。
 * 存储/渲染形态必须与旧 Vditor 适配器逐字节对齐（hybrid-editor.js 的
 * restoreAllRenderedMarks / renderInlineMarks 与 time-command.js），
 * roundtrip 兼容由 test/test_tiptap_roundtrip.js 固化，改动前先读它。
 */
import { Mark, Node, Extension } from './tiptap-runtime.js';
import { TIME_COMMAND, parseTimeMarkerText, buildTimeMarker } from './time-command.js';

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
        return ['span', {
            class: 'has-annotation',
            'data-note': mark.attrs.note,
            'data-comment': mark.attrs.note,
            style: `display:inline;${ANNOTATION_SPAN_STYLE}`,
        }, 0];
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

/** 软换行：存储为段内单个换行符（与旧编辑器一致），段尾换行序列化时丢弃。 */
export const MdSoftBreak = Node.create({
    name: 'hardBreak',

    inline: true,
    group: 'inline',
    selectable: false,
    linebreakReplacement: true,

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
            setHardBreak: () => ({ commands }) => commands.insertContent({ type: this.name }),
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
                        view.dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
                        return true;
                    },
                },
            }),
        ];
    },
});

/** 待办输入：空段落输入 "- " 直接转成任务项（勾选框），优先于无序列表规则。 */
export const TaskInputShortcut = Extension.create({
    name: 'taskInputShortcut',

    addProseMirrorPlugins() {
        return [
            new globalThis.DumbPadTiptap.PM.state.Plugin({
                props: {
                    handleTextInput: (view, from, to, text) => {
                        if (text !== ' ') return false;
                        const { state } = view;
                        const { $from } = state.selection;
                        if (!state.selection.empty) return false;
                        if ($from.parent.type.name !== 'paragraph') return false;
                        if ($from.parentOffset !== 1) return false;
                        if ($from.parent.textBetween(0, 1) !== '-') return false;
                        const { schema } = state;
                        if (!schema.nodes.taskList || !schema.nodes.taskItem) return false;
                        const paragraph = $from.parent;
                        const rest = paragraph.cut($from.parentOffset + 1);
                        const innerParagraph = schema.nodes.paragraph.create(null, rest.content);
                        const item = schema.nodes.taskItem.create({ checked: false }, innerParagraph);
                        const list = schema.nodes.taskList.create(null, [item]);
                        view.dispatch(state.tr.replaceWith($from.before(), $from.after(), list).scrollIntoView());
                        return true;
                    },
                },
            }),
        ];
    },
});
