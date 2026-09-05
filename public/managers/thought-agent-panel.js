import {
    getAgentSourceLabel,
    isAgentRunActive,
    isAgentRunTerminal,
    isAgentSourceStale
} from './thought-agent-state.js';

export function escapeAgentHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function statusLabel(state = {}) {
    if (state.status === 'queued') return '正在准备找回';
    if (state.status === 'cancelling') return '正在取消';
    if (state.phase === 'retrieval') return '正在查找相关内容';
    if (state.phase === 'retrieval_completed') return state.sourceCount
        ? `已查阅 ${state.sourceCount} 条内容，正在组织线索`
        : '已完成检索，正在组织线索';
    if (state.phase === 'generation') return '正在组织关联线索';
    if (state.status === 'completed') return '已完成找回';
    if (state.status === 'cancelled') return '已取消';
    if (state.status === 'failed') return '找回失败';
    return '从过去的内容中找回相关线索';
}

function recallIcon() {
    return `<svg class="thought-agent-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="m20 20-4.2-4.2"></path><path d="M11 8v3l2 1"></path></svg>`;
}

function closeIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>`;
}

function retryIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5.3"></path><path d="M20 4v7h-7"></path></svg>`;
}

function stopIcon() {
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"></rect></svg>`;
}

function renderText(text, escapeHtml) {
    const value = String(text || '').trim();
    if (!value) return '';
    return `<div class="thought-agent-answer">${escapeHtml(value)}</div>`;
}

function citationLocation(source = {}) {
    const kind = String(source.kind || '').toLowerCase();
    if (kind === 'thought') return 'Thought';
    if (kind === 'notepad' || kind === 'note') return '文章';
    return '来源';
}

function renderCitations(citations, escapeHtml) {
    const entries = Array.isArray(citations) ? citations.slice(0, 8) : [];
    if (!entries.length) return '';
    return `
        <section class="thought-agent-citations" aria-label="本次引用来源">
            <div class="thought-agent-section-title">本次引用</div>
            <div class="thought-agent-citation-list">
                ${entries.map((citation, index) => {
                    const source = citation?.sourceRef || citation?.source || citation || {};
                    const citationId = String(citation?.citationId || citation?.id || source?.id || index);
                    const label = getAgentSourceLabel(citation);
                    const kind = citationLocation(source);
                    const version = Number(source?.version);
                    const meta = Number.isFinite(version) ? `${kind} · v${version}` : kind;
                    return `<button type="button" class="thought-agent-citation" data-agent-citation="${escapeHtml(citationId)}" title="查看引用来源">
                        <span class="thought-agent-citation-label">${escapeHtml(label)}</span>
                        <span class="thought-agent-citation-meta">${escapeHtml(meta)}</span>
                    </button>`;
                }).join('')}
            </div>
        </section>
    `;
}

function renderActions(state, escapeHtml) {
    if (isAgentRunActive(state.status)) {
        return `<button type="button" class="thought-agent-action thought-agent-cancel" data-agent-cancel title="取消找回" aria-label="取消找回">${stopIcon()}<span>取消</span></button>`;
    }
    if (isAgentRunTerminal(state.status) || state.status === 'idle') {
        const label = state.status === 'idle' ? '开始找回' : '重新找回';
        return `<button type="button" class="thought-agent-action thought-agent-retry" data-agent-retry title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${retryIcon()}<span>${escapeHtml(label)}</span></button>`;
    }
    return '';
}

export function renderThoughtAgentPanel({ state = {}, thought = {}, escapeHtml = escapeAgentHtml } = {}) {
    const stale = isAgentSourceStale(state, thought);
    const active = isAgentRunActive(state.status);
    const error = state?.error?.message ? String(state.error.message) : '';
    const empty = !active && !state.text && !error && !isAgentRunTerminal(state.status);
    const sourceCount = Number(state.sourceCount || 0);
    const status = statusLabel(state);
    const thoughtId = String(thought?.id || state?.thoughtId || '');
    return `
        <div class="thought-agent-panel ${active ? 'is-running' : ''} ${stale ? 'is-stale' : ''}" data-agent-panel="${escapeHtml(thoughtId)}" aria-live="polite">
            <div class="thought-agent-panel-head">
                <div class="thought-agent-heading">${recallIcon()}<span>找回相关内容</span></div>
                <div class="thought-agent-head-actions">
                    ${renderActions(state, escapeHtml)}
                    <button type="button" class="thought-agent-close" data-agent-close title="收起" aria-label="收起">${closeIcon()}</button>
                </div>
            </div>
            <div class="thought-agent-status ${error ? 'error' : ''}">${escapeHtml(status)}</div>
            ${sourceCount ? `<div class="thought-agent-source-count">本次已使用 ${escapeHtml(sourceCount)} 条相关来源</div>` : ''}
            ${stale ? '<div class="thought-agent-stale-notice">这份结果基于编辑前的内容；当前 Thought 已修改，建议重新找回。</div>' : ''}
            ${renderText(state.text, escapeHtml)}
            ${error ? `<div class="thought-agent-error">${escapeHtml(error)}</div>` : ''}
            ${renderCitations(state.citations, escapeHtml)}
            ${empty ? '<div class="thought-agent-empty">点击“开始找回”，仅在有限的相关内容中检索，不会修改你的 Thought。</div>' : ''}
        </div>
    `;
}

export function renderThoughtAgentFooterButton({ state = {}, escapeHtml = escapeAgentHtml } = {}) {
    const active = isAgentRunActive(state.status);
    const title = active ? '正在找回相关内容' : '找回相关内容';
    return `<button type="button" class="thought-tool-btn thought-agent-recall-btn ${active ? 'is-running' : ''}" data-agent-recall title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" aria-expanded="false">${recallIcon()}<span class="thought-agent-footer-label">找回</span></button>`;
}
