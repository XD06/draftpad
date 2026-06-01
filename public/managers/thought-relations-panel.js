const MANUAL_RELATION_ICON_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAACXBIWXMAAAsTAAALEwEAmpwYAAABUklEQVR4nM2Tu0rEQBSGPwVtxHoVvC74BF66tVJ7LcRi0cewVQsVG7HSxcJ3ULFQX0Sx0bUQFEER3fUWGfgDQ5ghySSFPwxzOOfk/yYnGUjXCNAAmsCn9gPlC2sOeAUixzL52SLmo5b5CTAJ9Gg/Vf4FGA4FNCxzl2LIfiigKYMJnfISeAMugCFgSvXbUEBLBr0yt+d/rryJP0IBNzIwM28rHtPeVt7E16GAPRmcWSfHiuP8bihgEHhKjMYGRKoPUEDTwKMHYPI1SlC/B3AELOq7dBaFRJ4RxesZ2AG6shqOAwtAxQEwN3we2ACOgTurbiCp2rIeaAGHCYBLM6o/pJmvW/+5ubE/jr/Ipyw9rKrpG6gDVd2H97IARmtq/AKWlOsDtssCuN4ki3IBQiBRXkByXMtAh6evpr77vAAbkmVtEqgV4Ar49Ribkxvz7lDA/9Uf8JCaXbQbHiUAAAAASUVORK5CYII=';

export function renderRelationsPanelContent({ thoughtId, status, relations, suggestions = [], error = null, escapeHtml }) {
    const manualControls = renderManualRelationControls(thoughtId, escapeHtml);
    const listHtml = renderRelationsList(relations, escapeHtml);
    const suggestionsHtml = renderSuggestedRelationsList(suggestions, escapeHtml);
    if (relations.length > 0 || suggestions.length > 0) return manualControls + listHtml + suggestionsHtml;
    if (status === 'pending') {
        return manualControls + '<div class="thought-relations-state">AI 正在分析，关联会自动刷新</div>';
    }
    if (status === 'error') {
        const msg = error?.message ? `：${escapeHtml(error.message)}` : '';
        return manualControls + `<div class="thought-relations-state error">AI 分析失败${msg}</div>`;
    }
    if (status === 'missing') {
        return manualControls + '<div class="thought-relations-state">AI 尚未分析，可稍后重试</div>';
    }
    return manualControls + '<div class="thought-relations-state">暂无关联想法</div>';
}

export function renderManualRelationControls(thoughtId, escapeHtml) {
    return `
        <div class="thought-manual-relation" data-manual-relation="${escapeHtml(thoughtId)}">
            <input class="thought-manual-relation-input" type="text" placeholder="搜索并手动链接 Thought" autocomplete="off">
            <div class="thought-manual-relation-results"></div>
        </div>
    `;
}

export function textSnippetAroundQuery(text, query, maxLength = 96) {
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
    const cleanQuery = String(query || '').trim();
    if (!cleanText || !cleanQuery || cleanText.length <= maxLength) return cleanText;

    const index = cleanText.toLowerCase().indexOf(cleanQuery.toLowerCase());
    if (index < 0) return `${cleanText.slice(0, maxLength)}...`;

    const side = Math.max(12, Math.floor((maxLength - cleanQuery.length) / 2));
    const start = Math.max(0, index - side);
    const end = Math.min(cleanText.length, index + cleanQuery.length + side);
    return `${start > 0 ? '...' : ''}${cleanText.slice(start, end)}${end < cleanText.length ? '...' : ''}`;
}

export function buildManualRelationSummary(text, matchedSubItem, query) {
    const mainText = text || '空白想法';
    const lowerText = mainText.toLowerCase();
    const lowerQuery = String(query || '').toLowerCase();
    if (lowerQuery && lowerText.includes(lowerQuery)) {
        return textSnippetAroundQuery(mainText, query, 96);
    }
    if (matchedSubItem) {
        const mainPrefix = mainText.length > 36 ? `${mainText.slice(0, 36)}...` : mainText;
        return `${mainPrefix} · ${textSnippetAroundQuery(matchedSubItem, query, 72)}`;
    }
    return mainText.length > 96 ? `${mainText.slice(0, 96)}...` : mainText;
}

export function highlightPlainText(text, query, escapeHtml) {
    const cleanText = String(text || '');
    const cleanQuery = String(query || '').trim();
    if (!cleanText || !cleanQuery) return escapeHtml(cleanText);

    const lowerText = cleanText.toLowerCase();
    const lowerQuery = cleanQuery.toLowerCase();
    let lastIdx = 0;
    let idx = lowerText.indexOf(lowerQuery);
    let html = '';

    while (idx !== -1) {
        html += escapeHtml(cleanText.slice(lastIdx, idx));
        html += `<mark class="thought-highlight">${escapeHtml(cleanText.slice(idx, idx + cleanQuery.length))}</mark>`;
        lastIdx = idx + cleanQuery.length;
        idx = lowerText.indexOf(lowerQuery, lastIdx);
    }

    html += escapeHtml(cleanText.slice(lastIdx));
    return html;
}

export function renderManualRelationSearchOptions({ thoughts, sourceId, linkedIds, query, escapeHtml }) {
    const linked = linkedIds instanceof Set ? linkedIds : new Set(linkedIds || []);
    const q = String(query || '').trim();
    const options = (Array.isArray(thoughts) ? thoughts : [])
        .filter(item => item.id !== sourceId && !linked.has(item.id))
        .slice(0, 6);

    if (options.length === 0) return '<div class="thought-manual-relation-empty">没有可链接结果</div>';

    return options.map(item => {
        const text = String(item.text || '').replace(/\s+/g, ' ').trim();
        const subItems = Array.isArray(item.subItems) ? item.subItems : [];
        const matchedSubItem = subItems
            .map(subItem => String(subItem?.text || '').replace(/\s+/g, ' ').trim())
            .find(subText => subText.toLowerCase().includes(q.toLowerCase()));
        const summary = buildManualRelationSummary(text, matchedSubItem, q);
        const summaryHtml = highlightPlainText(summary, q, escapeHtml);
        return `
                    <button type="button" class="thought-manual-relation-option" data-manual-relation-target="${escapeHtml(item.id)}">
                        ${summaryHtml}
                    </button>
                `;
    }).join('');
}

export function relationTypeLabel(type = '') {
    const labels = {
        duplicate: '重复',
        question_answer: '问答',
        supports: '补充',
        contradicts: '矛盾',
        step_sequence: '步骤',
        cause_effect: '因果',
        same_project: '同项目',
        same_topic: '同主题',
        example_of: '例子',
        alternative: '备选',
        related_context: '背景',
        loosely_related: '弱相关'
    };
    return labels[type] || '相关';
}

export function relationStrengthClass(score) {
    if (score >= 0.82) return 'strong';
    if (score >= 0.65) return 'medium';
    return 'weak';
}

export function relationDisplayDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString();
}

export function relationDetailLine(parts = []) {
    return parts
        .map(part => String(part || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' · ');
}

export function renderRelationsMoreButton(count, escapeHtml) {
    if (count <= 0) return '';
    return `<button type="button" class="thought-relations-more">显示其余 ${escapeHtml(count)} 条</button>`;
}

export function isManualRelation(relation = {}) {
    return relation.method === 'manual' || relation.source === 'manual';
}

export function renderManualRelationIcon(relation, escapeHtml) {
    if (!isManualRelation(relation)) return '';
    return `<span class="thought-relation-manual-icon" title="手动关联" aria-label="手动关联"><img src="${escapeHtml(MANUAL_RELATION_ICON_SRC)}" alt="nui2"></span>`;
}

export function renderRelationsList(relations, escapeHtml) {
    const topRelations = relations
        .slice()
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, 15);
    if (topRelations.length === 0) return '';

    return `
        <div class="thought-relations-section">
            <div class="thought-relations-section-title">已关联</div>
            <div class="thought-relations-list">
            ${topRelations.map((relation, index) => {
                const target = relation.thought || {};
                const text = String(target.text || '').replace(/\s+/g, ' ').trim();
                const summary = text || '空白想法';
                const score = Number(relation.score || 0);
                const scoreText = score <= 1 ? `${Math.round(score * 100)}%` : score.toFixed(2);
                const confidence = Number(relation.confidence || 0);
                const confidenceText = confidence ? `${Math.round(confidence * 100)}%` : '';
                const strengthClass = relationStrengthClass(score);
                const relationTypeText = relationTypeLabel(relation.relationType || '');
                const reasons = Array.isArray(relation.reasons) ? relation.reasons.filter(Boolean).slice(0, 2) : [];
                const createdAt = relationDisplayDate(target.createdAt);
                const detailLine = relationDetailLine(reasons);
                const manualIcon = renderManualRelationIcon(relation, escapeHtml);
                const collapsed = index >= 5;

                return `
                    <button class="thought-relation-item ${strengthClass}${collapsed ? ' relation-collapsed' : ''}" data-relation-target="${escapeHtml(target.id || '')}" data-relation-created-at="${escapeHtml(target.createdAt || '')}" type="button"${collapsed ? ' hidden' : ''}>
                        <span class="thought-relation-main">
                            <span class="thought-relation-head">
                                <span class="thought-relation-type">${escapeHtml(relationTypeText)}</span>
                                ${manualIcon}
                                <span class="thought-relation-score">${escapeHtml(scoreText)}</span>
                                ${confidenceText ? `<span class="thought-relation-confidence">置信 ${escapeHtml(confidenceText)}</span>` : ''}
                                ${createdAt ? `<span class="thought-relation-date">${escapeHtml(createdAt)}</span>` : ''}
                            </span>
                            <span class="thought-relation-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
                            ${detailLine ? `<span class="thought-relation-detail-line" title="${escapeHtml(detailLine)}">${escapeHtml(detailLine)}</span>` : ''}
                        </span>
                        <span class="thought-relation-delete" data-relation-delete="${escapeHtml(target.id || '')}" title="删除误判关联" aria-label="删除误判关联">
                            <img width="12" height="12" src="https://img.icons8.com/fluency-systems-regular/48/disconnected.png" alt="disconnected"/>
                                <path d="m6 6 12 12"></path>
                            </svg>
                        </span>
                    </button>
                `;
            }).join('')}
            </div>
            ${renderRelationsMoreButton(topRelations.length - 5, escapeHtml)}
        </div>
    `;
}

export function renderSuggestedRelationsList(suggestions, escapeHtml) {
    const topSuggestions = suggestions
        .slice()
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, 8);
    if (topSuggestions.length === 0) return '';

    return `
        <div class="thought-relations-section">
            <div class="thought-relations-section-title muted">推荐关联</div>
            <div class="thought-relations-list suggested">
            ${topSuggestions.map((relation, index) => {
                const target = relation.thought || {};
                const text = String(target.text || '').replace(/\s+/g, ' ').trim();
                const summary = text || '空白想法';
                const score = Number(relation.score || 0);
                const scoreText = score <= 1 ? `${Math.round(score * 100)}%` : score.toFixed(2);
                const confidence = Number(relation.confidence || 0);
                const confidenceText = confidence ? `${Math.round(confidence * 100)}%` : '';
                const createdAt = relationDisplayDate(target.createdAt);
                const relationTypeText = relationTypeLabel(relation.relationType || '');
                const reasons = Array.isArray(relation.reasons) ? relation.reasons.filter(Boolean).slice(0, 3) : [];
                const detailLine = relationDetailLine(reasons);
                const collapsed = index >= 5;

                return `
                    <div class="thought-relation-suggestion weak${collapsed ? ' relation-collapsed' : ''}" data-relation-target="${escapeHtml(target.id || '')}"${collapsed ? ' hidden' : ''}>
                        <button class="thought-relation-suggestion-main" data-relation-target="${escapeHtml(target.id || '')}" data-relation-created-at="${escapeHtml(target.createdAt || '')}" type="button">
                            <span class="thought-relation-head">
                                <span class="thought-relation-type">${escapeHtml(relationTypeText)}</span>
                                <span class="thought-relation-score">${escapeHtml(scoreText)}</span>
                                ${confidenceText ? `<span class="thought-relation-confidence">置信 ${escapeHtml(confidenceText)}</span>` : ''}
                                ${createdAt ? `<span class="thought-relation-date">${escapeHtml(createdAt)}</span>` : ''}
                            </span>
                            <span class="thought-relation-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
                            ${detailLine ? `<span class="thought-relation-detail-line" title="${escapeHtml(detailLine)}">${escapeHtml(detailLine)}</span>` : ''}
                        </button>
                        <span class="thought-relation-suggestion-actions">
                            <button type="button" class="thought-relation-suggestion-confirm" data-relation-confirm-target="${escapeHtml(target.id || '')}" title="确认关联" aria-label="确认关联">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M20 6 9 17l-5-5"></path>
                                </svg>
                            </button>
                            <button type="button" class="thought-relation-suggestion-ignore" data-relation-ignore-target="${escapeHtml(target.id || '')}" title="忽略推荐" aria-label="忽略推荐">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M18 6 6 18"></path>
                                    <path d="m6 6 12 12"></path>
                                </svg>
                            </button>
                        </span>
                    </div>
                `;
            }).join('')}
            </div>
            ${renderRelationsMoreButton(topSuggestions.length - 5, escapeHtml)}
        </div>
    `;
}
