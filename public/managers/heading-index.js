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
 * 收集各标题区段内的划线/高亮/批注元素与顶层列表条目，供文章目录作为子条目
 * 展示（两类条目按文档序混排在同一条流里——app.js 的每节预算与滚动跟随都按
 * 这条流的先后工作，分两次收集再拼接会打乱「探针线之上最近条目」的判定）。
 * 单次 DOM 顺序遍历：遇到带 data-heading-id 的标题就切换当前分组，命中装饰
 * 元素就归类（加粗不进目录——调研类文章的加粗动辄几十处，会淹没标题层级；
 * 且加粗常被当普通强调使用，不像批注/高亮/划线那样自带「值得回头定位」语义）。
 * 已收录元素的嵌套后代跳过，避免同一段文字重复出现。
 *
 * 列表条目只收「直接父 ul/ol 的父级恰为 root」的 li——嵌套子列表、引用块和
 * 表格里的列表由此天然排除（它们的 ul/ol 不在 root 之下），清单型长文的目录
 * 条目数才有界（每节预算与「+N」折叠在 app.js）。条目片段取「自身文字」：
 * 递归拼接文本但跳过嵌套 UL/OL 子树与 taskItem 的 LABEL 复选框，父条目不会
 * 把子列表的文字全部拖进片段；空白条目（刚新建、还没写字）不占目录行。
 * 已收录的 li 不进标记的嵌套去重集——任务项里的内嵌高亮/批注仍各自成条目。
 *
 * 分组依据是标题上的 data-heading-id（HeadingAnchor 的 Decoration）。这些 id
 * 与目录扫描之间存在异步窗口（syncRenderedHeadingIds 在编辑器 ready 之前只会
 * 排队），此时全部标记会落进 '__preamble__' 组——合并目标组必须**就地补建**，
 * 否则 `groups.get(toc[0].id)` 拿不到组、整批标记被静默丢弃（warm 启动路径
 * 标记不进目录的根因之一）。没有标题的分组（文首片段）并入第一个标题。
 */
export function collectTocSectionEntries(toc, root = document.querySelector('.vditor-wysiwyg .vditor-reset')) {
    const groups = new Map();
    if (!root || !toc.length) return groups;
    const classify = (el) => {
        if (el.matches('.has-annotation, [data-note]')) return { type: 'note', badge: 'N', typeLabel: '批注' };
        if (el.matches('mark, .md-mark')) return { type: 'highlight', badge: 'H', typeLabel: '高亮' };
        return { type: 'underline', badge: 'U', typeLabel: '划线' };
    };
    const fit = (snippet) => (snippet.length > 26 ? `${snippet.slice(0, 26)}…` : snippet);
    // 仅顶层列表的 li：父级必须是直接挂在 root 下的 ul/ol。taskList 由 NodeView
    // 渲染出 li[data-type=taskItem][data-checked]，有序序号优先取 li[value]，
    // 否则 ol[start] + 在父列表中的位置（目录徽标显示真实序号，跳步号一眼可辨）。
    const listEntryOf = (node) => {
        if (node.tagName !== 'LI') return null;
        const list = node.parentElement;
        if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) return null;
        if (list.parentElement !== root) return null;
        if (list.matches('ul[data-type="taskList"]')) {
            return { listType: 'task', typeLabel: '待办', badge: node.dataset.checked === 'true' ? '✓' : '•' };
        }
        if (list.tagName === 'OL') {
            const valueAttr = node.getAttribute('value');
            const explicit = valueAttr === null ? NaN : Number(valueAttr);
            const startAttr = Number(list.getAttribute('start'));
            const ordinal = Number.isFinite(explicit)
                ? explicit
                : (Number.isFinite(startAttr) ? startAttr : 1) + Array.prototype.indexOf.call(list.children, node);
            return { listType: 'ordered', typeLabel: '有序项', badge: String(ordinal) };
        }
        return { listType: 'bullet', typeLabel: '无序项', badge: '•' };
    };
    const ownText = (node) => {
        let out = '';
        const visit = (el) => {
            for (const child of el.childNodes) {
                if (child.nodeType === 3) out += child.nodeValue;
                else if (child.nodeType === 1 && !/^(UL|OL|LABEL)$/.test(child.tagName)) visit(child);
            }
        };
        visit(node);
        return out.replace(/\s+/g, ' ').trim();
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
        const listInfo = listEntryOf(node);
        if (listInfo) {
            const snippet = ownText(node);
            if (!snippet) continue;
            if (!groups.has(currentGroupId)) groups.set(currentGroupId, []);
            groups.get(currentGroupId).push({ el: node, kind: 'list', ...listInfo, snippet: fit(snippet) });
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
            kind: 'mark',
            ...info,
            snippet: fit(snippet)
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
