export function renderThoughtCard({
    thought,
    query = '',
    parseLegacyText,
    sortSubItems,
    linkify,
    highlightSearch,
    escapeHtml,
    renderAISuggestedTags,
    renderAIStatus,
    normalizeAIStatus
}) {
    const dateStr = new Date(thought.createdAt).toLocaleString();
    let subItems = thought.subItems || [];
    let bodyText = thought.text;

    if (subItems.length === 0 && /^- \[[ x]\]/m.test(thought.text)) {
        const parsed = parseLegacyText(thought.text);
        subItems = parsed.subItems;
        bodyText = parsed.bodyText;
    }

    const sortedSubItems = sortSubItems(subItems);
    let bodyHtml = linkify(bodyText).split('\n').join('<br>');
    if (query) {
        bodyHtml = highlightSearch(bodyHtml, query);
    }

    const tags = thought.tags || [];
    const tagsHtml = tags.length ? `
                <div class="thought-tags">
                    ${tags.map(tag => `
                        <span class="thought-tag-wrap">
                            <button type="button" class="thought-tag" data-card-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>
                            <button type="button" class="thought-tag-remove" data-remove-tag="${escapeHtml(tag)}" title="从当前 Thought 移除标签" aria-label="从当前 Thought 移除标签">×</button>
                        </span>
                    `).join('')}
                </div>
            ` : '';
    const aiTagsHtml = renderAISuggestedTags(thought, tags);
    const relationCount = Number.isFinite(Number(thought.relationCount)) ? Number(thought.relationCount) : 0;
    const aiStatus = normalizeAIStatus(thought.aiStatus);
    const aiStatusHtml = renderAIStatus(thought, aiStatus, relationCount);
    const hasSubtasks = sortedSubItems.length > 0;
    const emptySubtaskActionHtml = hasSubtasks ? '' : `
                <button class="thought-tool-btn subtask-add-inline subtask-add-footer" title="添加子任务" aria-label="添加子任务">
                    <svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
            `;
    const footerHtml = `
                <div class="thought-card-footer">
                    ${emptySubtaskActionHtml}
                    <button class="thought-tool-btn thought-attachment-add-footer" type="button" title="添加附件" aria-label="添加附件">
                        <svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                        </svg>
                    </button>
                    ${aiStatusHtml}
                    <button class="thought-tool-btn thought-relations-btn" data-relations="${escapeHtml(thought.id)}" title="查看关联想法" aria-label="查看关联想法">
                        <svg class="thought-tool-icon relations-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                        </svg>
                        <span class="relations-count ${relationCount > 0 ? 'has-count' : 'is-zero'}">${relationCount}</span>
                    </button>
                    <button class="thought-tool-btn thought-edit-btn" data-edit="${escapeHtml(thought.id)}" title="编辑" aria-label="编辑">
                        <svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                </div>
            `;

    const subtasksHtml = renderSubtasks({
        sortedSubItems,
        query,
        linkify,
        highlightSearch
    });
    const isLong = bodyText.split('\n').length > 6 || bodyText.length > 200 || subItems.length > 3;
    const isPinned = thought.pinned === true;
    const attachments = Array.isArray(thought.attachments) ? thought.attachments : [];

    return {
        bodyText,
        isLong,
        html: `
                <div class="thought-swipe-action" aria-hidden="true">
                    <span class="thought-swipe-action-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>
                        </svg>
                    </span>
                    <span class="thought-swipe-action-label">松开删除</span>
                </div>
                <div class="timeline-node"></div>
                <div class="thought-card-header">
                    <div class="thought-dot" title="点击切换完成状态">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </div>
                    <div class="thought-time">${dateStr}</div>
                    <button class="thought-pin-btn ${isPinned ? 'pinned' : ''}" data-pin="${escapeHtml(thought.id)}" title="${isPinned ? '取消置顶' : '置顶'}" aria-label="${isPinned ? '取消置顶' : '置顶'}">
                        <svg class="thought-pin-icon" viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 17v5"></path>
                            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>
                        </svg>
                    </button>
                </div>
                <div class="thought-body">
                    <div class="thought-text">${bodyHtml}</div>
                    <button class="thought-copy-btn" title="复制">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                </div>
                ${attachments.length ? renderAttachments(attachments) : ''}
                ${tagsHtml}
                ${aiTagsHtml}
                ${subtasksHtml}
                ${footerHtml}
            `
    };
}

function renderAttachments(attachments) {
    if (!attachments.length) return '';
    const items = attachments.map(att => {
        const isImage = att.type && att.type.startsWith('image/');
        const name = escapeAttText(att.name || '文件');
        if (isImage) {
            return `<button type="button" class="thought-attachment thought-attachment-image thought-attachment-preview" data-att-id="${escapeAttText(att.id || '')}" data-preview-att="${escapeAttText(att.id || '')}" aria-label="预览图片：${name}">
                        <img src="${escapeAttText(getAttachmentPreviewUrl(att))}" alt="${name}" loading="lazy">
                    </button>`;
        }
        const sizeText = formatAttSize(att.size);
        const icon = getFileIcon(att.type);
        return `<a class="thought-attachment thought-attachment-file" href="${escapeAttText(getAttachmentDownloadUrl(att))}" download="${name}" data-att-id="${escapeAttText(att.id || '')}">
                    <span class="thought-attachment-icon">${icon}</span>
                    <span class="thought-attachment-info">
                        <span class="thought-attachment-name">${name}</span>
                        <span class="thought-attachment-size">${sizeText}</span>
                    </span>
                </a>`;
    }).join('');
    return `<div class="thought-attachments">${items}</div>`;
}

function escapeAttText(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getAttachmentPreviewUrl(attachment = {}) {
    return String(attachment.previewUrl || attachment.dataUrl || '');
}

function getAttachmentDownloadUrl(attachment = {}) {
    return String(attachment.downloadUrl || attachment.originalUrl || attachment.dataUrl || '');
}

function formatAttSize(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(type) {
    const t = String(type || '');
    if (t.startsWith('image/')) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>';
    if (t.startsWith('video/')) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
    if (t.startsWith('audio/')) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

function renderSubtasks({ sortedSubItems, query, linkify, highlightSearch }) {
    if (sortedSubItems.length === 0) return '';

    let subtasksHtml = '<div class="subtask-list">';
    sortedSubItems.forEach((item, index) => {
        let label = linkify(item.text);
        if (query) {
            label = highlightSearch(label, query);
        }
        const isExtra = sortedSubItems.length > 3 && index >= 3;
        const extraClass = isExtra ? 'subtask-extra' : '';
        subtasksHtml += `<div class="subtask ${item.completed ? 'completed' : ''} ${extraClass}" data-subid="${item.id}">
                        <input type="checkbox" class="subtask-check" ${item.completed ? 'checked' : ''}>
                        <span class="subtask-text">${label}</span>
                        <button class="subtask-copy-btn" title="复制">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                    </div>`;
    });

    if (sortedSubItems.length > 3) {
        const remainingCount = sortedSubItems.length - 3;
        const completedCount = sortedSubItems.filter(item => item.completed).length;
        const totalCount = sortedSubItems.length;
        const radius = 7;
        const circumference = Math.round(2 * Math.PI * radius);
        const progress = totalCount > 0 ? (completedCount / totalCount) : 0;
        const strokeDashoffset = circumference - (progress * circumference);

        subtasksHtml += `
                        <div class="subtasks-summary-row">
                            <div class="summary-left">
                                <svg class="progress-ring" width="18" height="18" viewBox="0 0 18 18">
                                    <circle class="progress-ring-bg" cx="9" cy="9" r="7" fill="none" stroke-width="2"/>
                                    <circle class="progress-ring-fg" cx="9" cy="9" r="7" fill="none" stroke-width="2"
                                            stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}"
                                            stroke-linecap="round" transform="rotate(-90 9 9)"/>
                                </svg>
                            </div>
                            <div class="summary-right">
                                <span class="summary-more-num">+${remainingCount}</span>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chevron-down-icon">
                                    <polyline points="6 9 12 15 18 9"></polyline>
                                </svg>
                            </div>
                        </div>
                    `;
    }

    subtasksHtml += '<button class="subtask-add-inline" title="添加子任务"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button></div>';
    return subtasksHtml;
}
