function decodeBasicHtmlEntities(value = '') {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function annotationSource(markedText = '', comment = '') {
    const label = decodeBasicHtmlEntities(comment);
    return `<span data-note="${comment}" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">${markedText}</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（${label}）</sub>`;
}

export function stripHybridDisplayArtifacts(value = '') {
    let output = String(value || '')
        .replace(/[\u2060\uE001]/g, '')
        .replace(/\u200B(?=\s*<(?:mark\b|span\s+data-(?:draw|note)\b))/gi, '');
    output = output
        .replace(/\u200B(?=\s*\[\[time:)/g, '')
        .replace(/(\[\[time:[^\]]+\]\])\u200B/g, '$1');

    output = output.replace(
        /<span class="has-annotation" data-comment="([^"]*)"[^>]*>\s*<span style="[^"]*wavy[^"]*"[^>]*>([\s\S]*?)<\/span>\s*(?:<span class="annotation-badge"[\s\S]*?<\/span>)?\s*(?:<sub[^>]*>[\s\S]*?<\/sub>)?\s*<\/span>/gi,
        (_match, comment, markedText) => annotationSource(markedText, comment)
    );

    output = output.replace(
        /<time\b(?=[^>]*\bdata-time-marker="true")(?=[^>]*\bdata-time-source="([^"]+)")[^>]*>[\s\S]*?<\/time>/gi,
        (_match, source) => decodeBasicHtmlEntities(source)
    );
    output = output.replace(
        /<span\b(?=[^>]*\bdata-time-marker="true")(?=[^>]*\bdata-time-source="([^"]+)")[^>]*>[\s\S]*?<\/span>/gi,
        (_match, source) => decodeBasicHtmlEntities(source)
    );

    output = output
        .replace(/<span class="annotation-badge"[\s\S]*?<\/span>/gi, '')
        .replace(/<mark class="md-mark">([\s\S]*?)<\/mark>/gi, '<mark>$1</mark>')
        .replace(/<sub\b(?=[^>]*style="[^"]*display\s*:\s*none)[^>]*>[\s\S]*?<\/sub>/gi, '');

    return output;
}

const ARTICLE_UPLOAD_TOKEN_PATTERN = /\[\[资源上传中 [^\[\]\n]*\]\]/g;

// Remove "[[资源上传中 ...]]" placeholder tokens that have no live upload
// state (stale tokens persisted by an autosave, seen after a refresh or on
// another device). Active tokens are kept so the in-progress upload card
// keeps working in the originating editor.
export function stripInactiveArticleUploadTokens(value = '', isActiveToken = () => false) {
    return String(value || '').replace(ARTICLE_UPLOAD_TOKEN_PATTERN, token => (
        isActiveToken(token) ? token : ''
    ));
}

function collapseEmphasisEscapesInSegment(segment = '') {
    // Collapse runs of 2+ backslashes directly before `_` or `*` down to a
    // single escape. Lute's WYSIWYG round-trip can re-escape an already
    // escaped emphasis marker (\_ -> \\_ -> \\\_ ...); collapsing keeps the
    // serialize/parse cycle idempotent so the escapes cannot grow unbounded.
    return segment.replace(/\\{2,}([_*])/g, '\\$1');
}

function collapseEmphasisEscapesOutsideInlineCode(line = '') {
    return line
        .split(/(`+[^`]*`+)/)
        .map(part => part.startsWith('`') ? part : collapseEmphasisEscapesInSegment(part))
        .join('');
}

// Normalize over-escaped emphasis markers outside fenced code, math blocks
// and inline code spans. Must stay idempotent: applying it twice yields the
// same output as applying it once.
export function collapseOverEscapedEmphasis(value = '') {
    const lines = String(value || '').split('\n');
    let fenceMarker = '';
    let inMathBlock = false;
    const out = lines.map(line => {
        if (!fenceMarker && /^\s*\$\$/.test(line)) {
            // `$$` both opens and closes a math block (possibly on one line).
            const dollarPairs = (line.match(/\$\$/g) || []).length;
            if (dollarPairs % 2 === 1) inMathBlock = !inMathBlock;
            return line;
        }
        if (inMathBlock) return line;
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceMatch) {
            if (!fenceMarker) fenceMarker = fenceMatch[1][0];
            else if (fenceMatch[1][0] === fenceMarker) fenceMarker = '';
            return line;
        }
        if (fenceMarker) return line;
        return collapseEmphasisEscapesOutsideInlineCode(line);
    });
    return out.join('\n');
}
