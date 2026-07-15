const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadAIStatusModule() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-ai-status.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export const /g, 'const ')
        .replace(/export function /g, 'function ')
        + `
module.exports = {
    AI_PENDING_MIN_VISIBLE_MS,
    applyAIStatusDetail,
    getAIStatusPendingDelay,
    normalizeAIStatus,
    normalizeAIStageStatus,
    normalizeAIInsightStatus,
    aiStatusLabel,
    aiStageLabel,
    aiStatusIcon,
    renderAIStatusButton,
    renderAIStageRow,
    renderAIInsightSection,
    renderAIStatusDetail,
    renderAIStatusLoading,
    renderAIStatusError
};
`;
    const context = {
        module: { exports: {} },
        exports: {}
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function run() {
    const ai = loadAIStatusModule();

    assert(ai.normalizeAIStatus('ready') === 'ready', 'known AI status should pass through');
    assert(ai.normalizeAIStatus('unknown') === 'missing', 'unknown AI status should normalize to missing');
    assert(ai.normalizeAIStageStatus('skipped') === 'skipped', 'known AI stage status should pass through');
    assert(ai.normalizeAIStageStatus('unknown') === 'missing', 'unknown AI stage status should normalize to missing');
    assert(ai.normalizeAIInsightStatus('ready') === 'ready', 'known AI insight status should pass through');
    assert(ai.normalizeAIInsightStatus('unknown') === 'missing', 'unknown AI insight status should normalize to missing');
    assert(ai.AI_PENDING_MIN_VISIBLE_MS === 1200, 'pending minimum visible delay should preserve existing duration');

    const pendingThought = { aiStatus: 'pending', aiPendingSince: 1000 };
    assert(
        ai.getAIStatusPendingDelay(pendingThought, 'ready', { now: 1500, minVisibleMs: 1200 }) === 700,
        'pending status delay should return remaining minimum visible time'
    );
    assert(
        ai.getAIStatusPendingDelay(pendingThought, 'ready', { now: 2300, minVisibleMs: 1200 }) === 0,
        'pending status delay should stop delaying after the minimum visible time'
    );
    assert(
        ai.getAIStatusPendingDelay(pendingThought, 'pending', { now: 1500, minVisibleMs: 1200 }) === 0,
        'pending status updates should never be delayed'
    );

    const statusThought = { aiStatus: 'pending', aiPendingSince: 1000 };
    const appliedStatus = ai.applyAIStatusDetail(statusThought, {
        status: 'ready',
        relationsCount: '3',
        processedAt: '1700000000',
        aiTags: [' Tag ', '#Other', '   '],
        error: null
    }, {
        normalizeTag: value => String(value || '').replace(/^#+/, '').trim(),
        now: 2500
    });
    assert(appliedStatus === 'ready', 'applyAIStatusDetail should return the normalized status');
    assert(statusThought.aiStatus === 'ready' && !statusThought.aiPendingSince, 'ready status should clear pending timestamp');
    assert(statusThought.relationCount === 3, 'applyAIStatusDetail should update relation count');
    assert(statusThought.aiProcessedAt === 1700000000, 'applyAIStatusDetail should update processed timestamp');
    assert(statusThought.aiTags.join(',') === 'Tag,Other', 'applyAIStatusDetail should normalize AI tags');

    ai.applyAIStatusDetail(statusThought, { status: 'pending' }, { now: 3000 });
    assert(statusThought.aiStatus === 'pending' && statusThought.aiPendingSince === 3000, 'pending status should set pending timestamp');

    assert(ai.aiStatusLabel('pending') === 'AI 处理中', 'pending status label should preserve wording');
    assert(ai.aiStatusLabel('ready', 2) === 'AI 已关联 2', 'ready status label should include relation count');
    assert(ai.aiStageLabel('error') === '失败', 'stage label should preserve error wording');

    const button = ai.renderAIStatusButton({
        thoughtId: 'thought-1',
        status: 'ready',
        relationCount: 2,
        errorMessage: '',
        escapeHtml
    });
    assert(button.includes('thought-ai-status ready'), 'status button should include normalized status class');
    assert(button.includes('data-ai-status="thought-1"'), 'status button should include thought id');
    assert(button.includes('thought-ai-count has-count'), 'status button should mark non-zero counts');
    assert(button.includes('>2</span>'), 'status button should render count');

    const emptyButton = ai.renderAIStatusButton({
        thoughtId: 'thought-2',
        status: 'missing',
        relationCount: 0,
        errorMessage: '',
        escapeHtml
    });
    assert(emptyButton.includes('thought-ai-count is-zero'), 'status button should mark zero counts');

    const detail = ai.renderAIStatusDetail({
        detail: {
            status: 'ready',
            relationCount: 1,
            suggestionCount: 2,
            diagnostics: { candidateCount: 3 },
            stages: {
                queued: { status: 'ready' },
                analysis: { status: 'ready', model: 'chat-model' },
                embedding: { status: 'ready', dims: 1536 },
                relations: { status: 'ready', confirmedCount: 1, suggestionCount: 2 }
            }
        },
        escapeHtml
    });
    assert(detail.includes('AI 已关联 1'), 'detail should include status label');
    assert(detail.includes('关联 1 · 建议 2 · 待评估 3'), 'detail should include counts line');
    assert(detail.includes('chat-model'), 'detail should include stage model');
    assert(detail.includes('thought-ai-detail-retry'), 'detail should include manual AI rerun action');
    assert(detail.includes('thought-ai-retry-icon'), 'manual AI rerun action should use the refresh icon');
    assert(detail.includes('1536维'), 'detail should include embedding dimensions');
    assert(detail.includes('thought-ai-insight'), 'detail should include the manual insight section');
    assert(detail.includes('thought-ai-insight-run'), 'detail should include the manual insight run action');

    const insightSection = ai.renderAIInsightSection({
        insight: {
            status: 'ready',
            markdown: '**扩展**：继续拆小验证。',
            model: 'insight-model'
        },
        renderedMarkdownHtml: '<p><strong>扩展</strong>：继续拆小验证。</p>',
        escapeHtml
    });
    assert(insightSection.includes('思考扩展'), 'insight section should include its heading');
    assert(insightSection.includes('thought-ai-insight ready'), 'insight section should expose ready state class');
    assert(insightSection.includes('data-insight-toggle'), 'ready insight should be clickable for expand/collapse');
    assert(insightSection.includes('insight-model'), 'insight section should show the dedicated model label');

    const pendingInsight = ai.renderAIInsightSection({
        insight: { status: 'pending', model: 'insight-model' },
        escapeHtml
    });
    assert(pendingInsight.includes('disabled'), 'pending insight run action should be disabled');
    assert(pendingInsight.includes('正在思考'), 'pending insight should render a waiting state');

    const errorInsight = ai.renderAIInsightSection({
        insight: { status: 'error', error: { message: '<failed>' } },
        escapeHtml
    });
    assert(errorInsight.includes('&lt;failed&gt;'), 'insight error messages should be escaped');

    const errorDetail = ai.renderAIStatusDetail({
        detail: {
            status: 'error',
            error: { stage: 'analysis', message: '<failed>' },
            stages: {}
        },
        escapeHtml
    });
    assert(errorDetail.includes('thought-ai-detail-retry'), 'error detail should include retry action');
    assert(errorDetail.includes('thought-ai-retry-icon'), 'error detail should use the refresh icon');
    assert(errorDetail.includes('&lt;failed&gt;'), 'error detail should escape error messages');

    assert(ai.renderAIStatusLoading().includes('正在读取 AI 状态'), 'loading render should preserve wording');
    assert(ai.renderAIStatusError().includes('AI 状态读取失败'), 'error render should preserve wording');
    assert(ai.renderAIStatusError().includes('thought-ai-retry-icon'), 'AI status fetch error should expose the refresh icon action');

    assert(ai.normalizeAIStatus('stale') === 'stale', 'stale AI status should be preserved');
    assert(ai.aiStatusLabel('stale') === 'AI 待更新', 'stale AI status should explain that a rerun is needed');
    const staleDetail = ai.renderAIStatusDetail({
        detail: {
            status: 'stale',
            relationCount: 1,
            suggestionCount: 0,
            insight: { status: 'ready', markdown: '旧版本 insight' },
            stages: { relations: { status: 'stale' } }
        },
        escapeHtml
    });
    assert(staleDetail.includes('关联与思考扩展基于旧版本'), 'stale detail should explain that derived content is outdated');
    assert(staleDetail.includes('基于旧版本'), 'stale insight should carry an explicit old-version marker');

    console.log('Thought AI status module checks passed');
}

run();
