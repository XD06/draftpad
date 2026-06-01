export function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function escapeRegExp(string) {
    return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function linkifyText(text, escapeHtmlFn = escapeHtml) {
    if (!text) return '';
    const escaped = escapeHtmlFn(text);
    return escaped.replace(/((?:https?:\/\/|www\.)[^\s<>'"]+)/gi, (match) => {
        let url = match;
        let trailing = '';
        const punctuation = /[.,;:!?\)]$/;
        while (punctuation.test(url)) {
            if (url.endsWith(')')) {
                const openParentheses = (url.match(/\(/g) || []).length;
                const closeParentheses = (url.match(/\)/g) || []).length;
                if (closeParentheses > openParentheses) {
                    trailing = url.slice(-1) + trailing;
                    url = url.slice(0, -1);
                    continue;
                }
            } else {
                trailing = url.slice(-1) + trailing;
                url = url.slice(0, -1);
                continue;
            }
            break;
        }
        let href = url;
        if (url.toLowerCase().startsWith('www.')) {
            href = 'https://' + url;
        }
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="thought-link">${url}</a>${trailing}`;
    });
}
