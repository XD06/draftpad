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
    // 历史日只读：不可删除、不可编辑；操作（复制 / 加入今日 / 转为 Thought /
    // 转为文章）全部走长按唤出的操作菜单，行内不再渲染滑动动作层。
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
    // 行尾复制按钮：inline 跟在正文末尾，平时隐藏（见 today-drafts.css），
    // 桌面 hover / 键盘焦点时亮出。历史只读行同样保留——复制非破坏。
    // 触摸端不亮它：长按归操作菜单，菜单里自带复制。
    // 预置两份图形：复制成功后由 manager 切 is-copy-success，勾形短暂替代表形。
    const copyButton = `<button type="button" class="today-draft-copy" data-today-draft-copy aria-label="复制草稿内容" title="复制草稿内容"><svg class="today-draft-copy-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><rect x="9" y="9" width="12.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"></rect><path d="M14.5 5V4.5A2.5 2.5 0 0 0 12 2H4.5A2.5 2.5 0 0 0 2 4.5V12a2.5 2.5 0 0 0 2.5 2.5H5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg><svg class="today-draft-copy-glyph today-draft-copy-check" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>`;
    return `<li class="today-draft-row${completedClass}${readonly ? ' is-readonly' : ''}" data-today-draft-id="${id}">
        ${check}
        <span class="today-draft-text today-draft-text-display"${textAttrs}>${text}${copyButton}</span>
        ${timestamp}
    </li>`;
}

export function renderTodayDrafts(items = [], options = {}) {
    return items.map(item => renderTodayDraftItem(item, options)).join('');
}
