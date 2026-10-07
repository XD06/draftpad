/**
 * 从文章 Markdown 内容推导「临时标题」：优先取全文最高级别的标题（H1 优先于
 * H2……同级取第一个），一个标题都没有时取第一句并在固定字数处截断。纯函数、
 * 无 DOM 依赖，供 app.js 在新建未命名文章（名字仍是 Notepad N 占位符）时自动
 * 命名、以及用户后续编辑内容时静默跟随更新——一旦用户手动重命名即不再使用。
 */

/** 标题截断长度（按 Unicode 码点数，中英文一视同仁）；首句兜底与超长标题共用。 */
export const ARTICLE_TITLE_MAX_CHARS = 30;

/** createNotepad 生成的默认占位名；只有仍是占位名的文章才参与自动命名。 */
export const DEFAULT_NOTEPAD_NAME_RE = /^Notepad \d+$/;

const ATX_HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const FRONTMATTER_DELIM_RE = /^-{3,}\s*$/;
const HR_RE = /^([*_-])\1{2,}\s*$/;

/** 逐字符去掉行内 markdown 修饰（强调、行内代码、链接/图片只留文字）。 */
function stripInlineMarkdown(text) {
    let out = String(text || '');
    out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // 行内代码先剥：代码里的 _ * 不该被强调规则吃掉。
    out = out.replace(/`([^`]*)`/g, '$1');
    out = out.replace(/(\*\*\*)(?=\S)([\s\S]*?\S)\1/g, '$2');
    out = out.replace(/(\*\*)(?=\S)([\s\S]*?\S)\1/g, '$2');
    out = out.replace(/(\*)(?=\S)([\s\S]*?\S)\1/g, '$2');
    // CommonMark：词内下划线不是强调（snake_case_words 要保持原样）。
    out = out.replace(/(?<![\w\\])___(?=\S)([\s\S]*?\S)___(?!\w)/g, '$1');
    out = out.replace(/(?<![\w\\])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1');
    out = out.replace(/(?<![\w\\])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1');
    out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
    return out;
}

function normalizeTitle(text) {
    return stripInlineMarkdown(text)
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(text, maxChars) {
    return Array.from(text).slice(0, maxChars).join('');
}

/** 首句兜底：取到第一个句末标点为止（英文句点须后随空白，避免 3.14 被截断）；超长则按固定字数硬截。 */
function firstSentence(text, maxChars) {
    const compact = normalizeTitle(text);
    if (!compact) return '';
    const endRe = /(?:[。！？；…!?;]|\.(?=\s|$))/g;
    const end = endRe.exec(compact);
    if (end && end.index + 1 <= maxChars) return compact.slice(0, end.index + 1);
    return truncate(compact, maxChars);
}

/**
 * 从 Markdown 推导临时标题；推不出可用文字时返回空串（调用方保持现名不动）。
 * frontmatter、代码围栏与分隔线不参与；首句兜底会剥掉引用/列表/任务标记。
 */
export function deriveArticleTitle(markdown, { maxChars = ARTICLE_TITLE_MAX_CHARS } = {}) {
    const lines = String(markdown || '').split(/\r\n?|\n/);
    let start = 0;
    // 文首 --- ... --- frontmatter（编辑器里是 dumbpad-frontmatter 代码块）不算内容；
    // 找不到收尾 --- 时按普通分隔线处理，只跳过首行，不吞掉全部正文。
    if (lines.length > 0 && FRONTMATTER_DELIM_RE.test(lines[0].trim())) {
        let closing = -1;
        for (let j = 1; j < lines.length; j += 1) {
            if (FRONTMATTER_DELIM_RE.test(lines[j].trim())) { closing = j; break; }
        }
        start = closing > -1 ? closing + 1 : 1;
    }

    let fenceMarker = null;
    const headings = [];
    const textLines = [];
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i].replace(/\s+$/, '');
        const fence = line.match(FENCE_RE);
        if (fence) {
            if (!fenceMarker) fenceMarker = fence[1];
            else if (line.trim().startsWith(fenceMarker)) fenceMarker = null;
            continue;
        }
        if (fenceMarker) continue;
        const bare = line.trim();
        if (!bare) continue;
        if (FRONTMATTER_DELIM_RE.test(bare) || HR_RE.test(bare)) continue;
        const heading = bare.match(ATX_HEADING_RE);
        if (heading) {
            const text = normalizeTitle(heading[2].replace(/#+\s*$/, ''));
            if (text) headings.push({ level: heading[1].length, text });
            continue;
        }
        textLines.push(bare);
    }

    if (headings.length > 0) {
        const top = Math.min(...headings.map(h => h.level));
        const first = headings.find(h => h.level === top);
        return truncate(first.text, maxChars);
    }

    for (const line of textLines) {
        const stripped = line
            .replace(/^>[ \t]?/, '')
            .replace(/^[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/, '')
            .replace(/^\d+[.)][ \t]+/, '')
            .replace(/^#{1,6}[ \t]*/, '');
        const sentence = firstSentence(stripped, maxChars);
        if (sentence) return sentence;
    }
    return '';
}
