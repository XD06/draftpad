const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function slugify(text, seen) {
    const base = String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-') || 'section';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
}

/**
 * Build the canonical heading lookup used by the editor and its table of contents.
 * The parser intentionally preserves the editor's existing ATX-only semantics.
 * 围栏代码块（``` / ~~~）内的行不算标题——否则代码示例里的 "# 注释" 会
 * 混进目录。闭合围栏遵循 CommonMark：同字符、长度不小于开启行、不得再
 * 带围栏字符（允许尾随空格）。
 */
export function buildMarkdownHeadingIndex(markdown = '') {
    const seen = new Map();
    const headingLineBySlug = new Map();
    const headingIds = [];
    let fenceMarker = null;
    let fenceLength = 0;
    const toc = String(markdown || '')
        .split('\n')
        .map((line, index) => {
            const fence = line.match(FENCE_RE);
            if (fenceMarker) {
                // 闭合围栏：同字符、长度不小于开启行，其余部分不得再含围栏字符
                if (fence && fence[1][0] === fenceMarker && fence[1].length >= fenceLength
                    && !line.trim().slice(fence[1].length).includes(fenceMarker)) {
                    fenceMarker = null;
                }
                return null;
            }
            if (fence) {
                fenceMarker = fence[1][0];
                fenceLength = fence[1].length;
                return null;
            }
            const match = line.match(HEADING_RE);
            if (!match) return null;
            const text = match[2].replace(/[`*_~[\]()]/g, '').trim();
            const id = slugify(text, seen);
            headingLineBySlug.set(id, index);
            headingIds[index] = id;
            return { id, text, level: match[1].length, line: index };
        })
        .filter(Boolean);

    return { toc, headingLineBySlug, headingIds };
}

const TOC_MARK_SELECTOR = 'mark, .md-mark, u, [data-draw], .has-annotation, [data-note]';

/**
 * 收集各标题区段内的划线/高亮/批注元素，供文章目录作为子条目展示。
 * 单次 DOM 顺序遍历：遇到带 data-heading-id 的标题就切换当前分组，命中装饰
 * 元素就归类（加粗不进目录——调研类文章的加粗动辄几十处，会淹没标题层级；
 * 且加粗常被当普通强调使用，不像批注/高亮/划线那样自带「值得回头定位」语义）。
 * 已收录元素的嵌套后代跳过，避免同一段文字重复出现。
 *
 * 分组依据是标题上的 data-heading-id（HeadingAnchor 的 Decoration）。这些 id
 * 与目录扫描之间存在异步窗口（syncRenderedHeadingIds 在编辑器 ready 之前只会
 * 排队），此时全部标记会落进 '__preamble__' 组——合并目标组必须**就地补建**，
 * 否则 `groups.get(toc[0].id)` 拿不到组、整批标记被静默丢弃（warm 启动路径
 * 标记不进目录的根因之一）。没有标题的分组（文首片段）并入第一个标题。
 */
export function collectTocMarkEntries(toc, root = document.querySelector('.vditor-wysiwyg .vditor-reset')) {
    const groups = new Map();
    if (!root || !toc.length) return groups;
    const classify = (el) => {
        if (el.matches('.has-annotation, [data-note]')) return { type: 'note', badge: 'N', typeLabel: '批注' };
        if (el.matches('mark, .md-mark')) return { type: 'highlight', badge: 'H', typeLabel: '高亮' };
        return { type: 'underline', badge: 'U', typeLabel: '划线' };
    };
    const accepted = new Set();
    let currentGroupId = '__preamble__';
    groups.set(currentGroupId, []);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
        if (/^H[1-6]$/.test(node.tagName) && node.dataset.headingId) {
            currentGroupId = node.dataset.headingId;
            if (!groups.has(currentGroupId)) groups.set(currentGroupId, []);
            continue;
        }
        if (!node.matches(TOC_MARK_SELECTOR)) continue;
        let nested = false;
        let ancestor = node.parentElement;
        while (ancestor && ancestor !== root) {
            if (accepted.has(ancestor)) { nested = true; break; }
            ancestor = ancestor.parentElement;
        }
        if (nested) continue;
        const snippet = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!snippet) continue;
        accepted.add(node);
        if (!groups.has(currentGroupId)) groups.set(currentGroupId, []);
        const info = classify(node);
        groups.get(currentGroupId).push({
            el: node,
            ...info,
            snippet: snippet.length > 26 ? `${snippet.slice(0, 26)}…` : snippet
        });
    }
    // 没有标题的分组（文首片段）并入第一个标题，避免出现孤儿条目。
    const preamble = groups.get('__preamble__');
    if (preamble?.length && toc.length) {
        const firstId = toc[0].id;
        if (!groups.has(firstId)) groups.set(firstId, []);
        groups.get(firstId).unshift(...preamble);
    }
    groups.delete('__preamble__');
    return groups;
}
