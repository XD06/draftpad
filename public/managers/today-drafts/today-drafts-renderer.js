export function escapeTodayDraftHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function linkifyTodayDraftText(value = '') {
    const escaped = escapeTodayDraftHtml(value);
    return escaped.replace(/((?:https?:\/\/|www\.)[^\s<>'"]+)/gi, match => {
        let url = match;
        let trailing = '';
        const punctuation = /[.,;:!?\)]$/;
        while (punctuation.test(url)) {
            if (url.endsWith(')')) {
                const openParentheses = (url.match(/\(/g) || []).length;
                const closeParentheses = (url.match(/\)/g) || []).length;
                if (closeParentheses <= openParentheses) break;
            }
            trailing = url.slice(-1) + trailing;
            url = url.slice(0, -1);
        }
        const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
        return `<a class="today-draft-link" data-today-draft-link href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${trailing}`;
    });
}

export function formatTodayDraftTime(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function renderTodayDraftItem(item, { readonly = false } = {}) {
    const id = escapeTodayDraftHtml(item.id);
    const text = linkifyTodayDraftText(item.text);
    const completed = item.completed ? ' checked' : '';
    const completedClass = item.completed ? ' is-completed' : '';
    const createdAt = Number(item.createdAt ?? item.updatedAt);
    const time = formatTodayDraftTime(createdAt);
    const dateTime = Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : '';
    const timestamp = time
        ? `<time class="today-draft-time" datetime="${dateTime}" title="创建于 ${time}">${time}</time>`
        : '<span class="today-draft-time" aria-hidden="true"></span>';
    // 历史日只读：不可删除、不可编辑；右滑「重新加入今日」（复制进今天，
    // 保留完成状态），左滑「转为 Thought」（动作位沿用删除侧的位置，但语义非破坏）。
    const swipeActions = readonly ? `
        <span class="today-draft-swipe-action today-draft-swipe-action--thought" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12h14m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>
            <span>转为 Thought</span>
        </span>
        <span class="today-draft-swipe-action today-draft-swipe-action--delete" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14m-7-7h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>
            <span>加入今日</span>
        </span>` : `
        <span class="today-draft-swipe-action today-draft-swipe-action--thought" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14m-7-7h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>
            <span>转为 Thought</span>
        </span>
        <span class="today-draft-swipe-action today-draft-swipe-action--delete" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-7 0 1 13h6l1-13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path></svg>
            <span>松开删除</span>
        </span>`;
    const check = readonly
        ? `<span class="today-draft-check is-readonly" aria-hidden="true">
            <input type="checkbox" disabled${completed}>
            <span></span>
        </span>`
        : `<label class="today-draft-check" aria-label="标记完成">
            <input type="checkbox" data-today-draft-complete${completed}>
            <span aria-hidden="true"></span>
        </label>`;
    const textAttrs = readonly
        ? ' aria-hidden="false"'
        : ' data-today-draft-text-display tabindex="0" aria-label="编辑草稿内容"';
    return `<li class="today-draft-row${completedClass}${readonly ? ' is-readonly' : ''}" data-today-draft-id="${id}">${swipeActions}
        ${check}
        <span class="today-draft-text today-draft-text-display"${textAttrs}>${text}</span>
        ${timestamp}
    </li>`;
}

export function renderTodayDrafts(items = [], options = {}) {
    return items.map(item => renderTodayDraftItem(item, options)).join('');
}
