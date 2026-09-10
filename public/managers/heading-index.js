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
