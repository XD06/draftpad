export const AI_PENDING_MIN_VISIBLE_MS = 1200;
const AI_RETRY_ICON_SVG = '<svg class="thought-ai-retry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2L3 11"></path><path d="M3 4v7h7"></path><path d="M4 13a8.1 8.1 0 0 0 15.5 2L21 13"></path><path d="M21 20v-7h-7"></path></svg>';
const AI_INSIGHT_ICON_SVG = '<svg class="thought-ai-insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a4 4 0 0 0-4 4v.3A4.5 4.5 0 0 0 6 16h1"></path><path d="M12 3a4 4 0 0 1 4 4v.3A4.5 4.5 0 0 1 18 16h-1"></path><path d="M9 12h6"></path><path d="M10 16h4"></path><path d="M12 16v5"></path><path d="M8 21h8"></path></svg>';

export function normalizeAIStatus(status = '') {
    return ['pending', 'ready', 'stale', 'empty', 'error', 'missing'].includes(status) ? status : 'missing';
}

export function getAIStatusPendingDelay(thought, nextStatus, { now = Date.now(), minVisibleMs = AI_PENDING_MIN_VISIBLE_MS } = {}) {
    if (nextStatus === 'pending') return 0;
    if (thought?.aiStatus !== 'pending' || !thought.aiPendingSince) return 0;

    const elapsed = now - thought.aiPendingSince;
    return Math.max(0, minVisibleMs - elapsed);
}

export function applyAIStatusDetail(thought, detail = {}, { normalizeTag = value => value, now = Date.now() } = {}) {
    const nextStatus = normalizeAIStatus(detail.status);
    thought.aiStatus = nextStatus;
    if (nextStatus === 'pending') {
        thought.aiPendingSince = now;
    } else {
        delete thought.aiPendingSince;
    }

    thought.aiError = detail.error || null;
    if (Number.isFinite(Number(detail.relationsCount))) {
        thought.relationCount = Number(detail.relationsCount);
    }
    if (Number.isFinite(Number(detail.processedAt))) {
        thought.aiProcessedAt = Number(detail.processedAt);
    }
    if (Array.isArray(detail.aiTags)) {
        thought.aiTags = detail.aiTags.map(tag => normalizeTag(tag)).filter(Boolean);
    }
    return nextStatus;
}

export function normalizeAIStageStatus(status = '') {
    return ['pending', 'ready', 'stale', 'skipped', 'error', 'missing'].includes(status) ? status : 'missing';
}

export function normalizeAIInsightStatus(status = '') {
    return ['missing', 'pending', 'ready', 'error'].includes(status) ? status : 'missing';
}

export function aiStatusLabel(status, relationCount = 0) {
    const count = Number(relationCount || 0);
    if (status === 'pending') return 'AI 处理中';
    if (status === 'ready') return count > 0 ? `AI 已关联 ${count}` : 'AI 已分析';
    if (status === 'stale') return 'AI 待更新';
    if (status === 'empty') return 'AI 无内容';
    if (status === 'error') return 'AI 失败';
    return 'AI 未分析';
}

export function aiStageLabel(status) {
    if (status === 'ready') return '完成';
    if (status === 'pending') return '处理中';
    if (status === 'skipped') return '跳过';
    if (status === 'error') return '失败';
    if (status === 'stale') return '待更新';
    return '未开始';
}

export function aiStatusIcon(status) {
    if (status === 'pending') {
        return '<svg class="thought-tool-icon spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"></path><path d="M12 18v4"></path><path d="m4.93 4.93 2.83 2.83"></path><path d="m16.24 16.24 2.83 2.83"></path><path d="M2 12h4"></path><path d="M18 12h4"></path><path d="m4.93 19.07 2.83-2.83"></path><path d="m16.24 7.76 2.83-2.83"></path></svg>';
    }
    if (status === 'ready') {
        return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8L12 3Z"></path><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"></path></svg>';
    }
    if (status === 'error') {
        return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"></path></svg>';
    }
    if (status === 'stale') {
        return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8.1 8.1 0 0 0-15.5-2L3 11"></path><path d="M3 4v7h7"></path><path d="M4 13a8.1 8.1 0 0 0 15.5 2L21 13"></path><path d="M21 20v-7h-7"></path></svg>';
    }
    if (status === 'empty') {
        return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"></path></svg>';
    }
    return '<svg class="thought-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';
}

export function renderAIStatusButton({ thoughtId, status, relationCount = 0, errorMessage = '', escapeHtml }) {
    const normalizedStatus = normalizeAIStatus(status);
    const label = aiStatusLabel(normalizedStatus, relationCount);
    const count = Math.max(0, Number.isFinite(Number(relationCount)) ? Number(relationCount) : 0);
    const errorSuffix = errorMessage ? `：${errorMessage}` : '';
    return `
            <button type="button" class="thought-tool-btn thought-ai-status ${escapeHtml(normalizedStatus)}" data-ai-status="${escapeHtml(thoughtId)}" title="${escapeHtml(label + errorSuffix)}" aria-label="${escapeHtml(label + '，点击查看详情')}" aria-expanded="false">
                ${aiStatusIcon(normalizedStatus)}
                <span class="thought-ai-count ${count > 0 ? 'has-count' : 'is-zero'}">${count}</span>
            </button>
        `;
}

export function renderAIStageRow({ label, stage = {}, escapeHtml }) {
    const status = normalizeAIStageStatus(stage.status);
    const extra = [
        stage.model,
        Number.isFinite(Number(stage.dims)) ? `${Number(stage.dims)}维` : '',
        Number.isFinite(Number(stage.confirmedCount)) ? `确认${Number(stage.confirmedCount)}` : '',
        Number.isFinite(Number(stage.suggestionCount)) ? `建议${Number(stage.suggestionCount)}` : '',
        stage.rerankJudge && stage.rerankJudge !== 'ready' ? stage.rerankJudge : ''
    ].filter(Boolean).join(' · ');
    return `
            <div class="thought-ai-stage-row ${escapeHtml(status)}">
                <span class="thought-ai-stage-dot"></span>
                <span class="thought-ai-stage-name">${escapeHtml(label)}</span>
                <span class="thought-ai-stage-status">${escapeHtml(aiStageLabel(status))}</span>
                ${extra ? `<span class="thought-ai-stage-extra">${escapeHtml(extra)}</span>` : ''}
            </div>
        `;
}

function plainMarkdownFallback(markdown = '', escapeHtml) {
    return escapeHtml(markdown).replace(/\n/g, '<br>');
}

export function renderAIInsightSection({ insight = {}, escapeHtml, renderedMarkdownHtml = '', isStale = false }) {
    const status = normalizeAIInsightStatus(insight?.status);
    const isPending = status === 'pending';
    const actionLabel = status === 'ready' ? '重新生成思考扩展' : '生成思考扩展';
    const model = insight?.model ? `<span class="thought-ai-insight-model">${escapeHtml(insight.model)}</span>` : '';
    const body = (() => {
        if (status === 'pending') {
            return '<div class="thought-ai-insight-state">正在思考...</div>';
        }
        if (status === 'error') {
            const message = insight?.error?.message || '生成失败';
            return `<div class="thought-ai-insight-state error">思考失败：${escapeHtml(message)}</div>`;
        }
        if (status === 'ready' && insight?.markdown) {
            const html = renderedMarkdownHtml || plainMarkdownFallback(insight.markdown, escapeHtml);
            return `
                <div class="thought-ai-insight-content" data-insight-toggle role="button" tabindex="0" aria-expanded="false">
                    <div class="thought-ai-insight-markdown" data-ai-insight-markdown>${html}</div>
                </div>
            `;
        }
        return '<div class="thought-ai-insight-state">尚未生成</div>';
    })();

    return `
            <div class="thought-ai-insight ${escapeHtml(status)}" data-ai-insight-status="${escapeHtml(status)}">
                <div class="thought-ai-insight-head">
                    <span>思考扩展</span>
                    <div class="thought-ai-insight-actions">
                        ${isStale ? '<span class="thought-ai-stale-note">基于旧版本</span>' : ''}
                        ${model}
                        <button type="button" class="thought-ai-insight-run" title="${escapeHtml(actionLabel)}" aria-label="${escapeHtml(actionLabel)}" ${isPending ? 'disabled' : ''}>
                            ${AI_INSIGHT_ICON_SVG}
                        </button>
                    </div>
                </div>
                <div class="thought-ai-insight-body">${body}</div>
            </div>
        `;
}

export function renderAIStatusDetail({ detail = {}, escapeHtml, renderedInsightHtml = '' }) {
    const isStale = normalizeAIStatus(detail.status) === 'stale';
    const stageRows = [
        ['queued', '排队'],
        ['analysis', '分析'],
        ['embedding', '嵌入'],
        ['relations', '关联']
    ].map(([key, label]) => renderAIStageRow({ label, stage: detail.stages?.[key], escapeHtml })).join('');
    const diagnostics = detail.diagnostics || {};
    const error = detail.error?.message ? `
            <div class="thought-ai-detail-error">${escapeHtml(detail.error.stage || 'AI')}：${escapeHtml(detail.error.message)}</div>
        ` : '';
    const counts = [
        `关联 ${Number(detail.relationCount || 0)}`,
        `建议 ${Number(detail.suggestionCount || 0)}`,
        `待评估 ${Number(diagnostics.candidateCount || detail.stages?.relations?.candidateCount || 0)}`
    ].join(' · ');
    return `
            <div class="thought-ai-detail-head">
                <span>${escapeHtml(aiStatusLabel(normalizeAIStatus(detail.status), detail.relationCount || 0))}</span>
                <button type="button" class="thought-ai-detail-retry" title="重新运行 AI" aria-label="重新运行 AI">
                    ${AI_RETRY_ICON_SVG}
                </button>
            </div>
            ${isStale ? '<div class="thought-ai-stale-notice">正文、子任务或用户标签已变更；关联与思考扩展基于旧版本。</div>' : ''}
            <div class="thought-ai-detail-counts">${escapeHtml(counts)}</div>
            <div class="thought-ai-stage-list">${stageRows}</div>
            ${renderAIInsightSection({ insight: detail.insight, escapeHtml, renderedMarkdownHtml: renderedInsightHtml, isStale })}
            <section class="thought-agent-disclosure">
                <button type="button" class="thought-agent-disclosure-toggle" data-agent-toggle title="找回相关内容" aria-label="找回相关内容" aria-expanded="false">
                    <svg class="thought-agent-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="11" cy="11" r="6"></circle><path d="m20 20-4.2-4.2"></path><path d="M11 8v3l2 1"></path>
                    </svg>
                    <span>找回相关内容</span>
                </button>
                <div class="thought-agent-panel-container" data-agent-panel-host hidden></div>
            </section>
            ${error}
        `;
}

export function renderAIStatusLoading() {
    return '<div class="thought-ai-detail-state">正在读取 AI 状态...</div>';
}

export function renderAIStatusError() {
    return `
                <div class="thought-ai-detail-state error">AI 状态读取失败</div>
                <button type="button" class="thought-ai-detail-retry" title="重新运行 AI" aria-label="重新运行 AI">
                    ${AI_RETRY_ICON_SVG}
                </button>
            `;
}
