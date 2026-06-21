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
    let output = String(value || '').replace(/\u200B(?=\s*<(?:mark\b|span\s+data-(?:draw|note)\b))/gi, '');

    output = output.replace(
        /<span class="has-annotation" data-comment="([^"]*)"[^>]*>\s*<span style="[^"]*wavy[^"]*"[^>]*>([\s\S]*?)<\/span>\s*(?:<span class="annotation-badge"[\s\S]*?<\/span>)?\s*(?:<sub[^>]*>[\s\S]*?<\/sub>)?\s*<\/span>/gi,
        (_match, comment, markedText) => annotationSource(markedText, comment)
    );

    output = output.replace(
        /<time\b(?=[^>]*\bdata-time-marker="true")(?=[^>]*\bdata-time-source="([^"]+)")[^>]*>[\s\S]*?<\/time>/gi,
        (_match, source) => decodeBasicHtmlEntities(source)
    );

    output = output
        .replace(/<span class="annotation-badge"[\s\S]*?<\/span>/gi, '')
        .replace(/<mark class="md-mark">([\s\S]*?)<\/mark>/gi, '<mark>$1</mark>')
        .replace(/<sub\b(?=[^>]*style="[^"]*display\s*:\s*none)[^>]*>[\s\S]*?<\/sub>/gi, '');

    return output;
}
