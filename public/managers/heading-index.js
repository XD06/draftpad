const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

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
 */
export function buildMarkdownHeadingIndex(markdown = '') {
    const seen = new Map();
    const headingLineBySlug = new Map();
    const headingIds = [];
    const toc = String(markdown || '')
        .split('\n')
        .map((line, index) => {
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
