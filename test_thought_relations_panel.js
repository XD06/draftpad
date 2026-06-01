const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadRelationsPanel() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-relations-panel.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { buildManualRelationSummary, highlightPlainText, renderManualRelationSearchOptions, renderRelationsList, textSnippetAroundQuery };\n';
    const context = {
        module: { exports: {} },
        exports: {},
        Date,
        Math,
        Set
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
    const {
        buildManualRelationSummary,
        highlightPlainText,
        renderManualRelationSearchOptions,
        renderRelationsList,
        textSnippetAroundQuery
    } = loadRelationsPanel();

    const longText = 'alpha '.repeat(20) + 'needle ' + 'omega '.repeat(20);
    const snippet = textSnippetAroundQuery(longText, 'needle', 48);
    assert(snippet.includes('needle'), 'snippet should keep the query in view');
    assert(snippet.startsWith('...') && snippet.endsWith('...'), 'middle snippets should show ellipses');

    const subtaskSummary = buildManualRelationSummary(
        'Main thought with a title that is intentionally longer than thirty six characters',
        'subtask contains needle and useful context',
        'needle'
    );
    assert(subtaskSummary.includes('... · subtask contains needle'), 'subtask matches should include main prefix and subtask snippet');

    const highlighted = highlightPlainText('<needle> & Needle', 'needle', escapeHtml);
    assert(highlighted.includes('&lt;<mark class="thought-highlight">needle</mark>&gt;'), 'highlight should escape surrounding HTML');
    assert(highlighted.includes('<mark class="thought-highlight">Needle</mark>'), 'highlight should be case-insensitive');

    const html = renderManualRelationSearchOptions({
        thoughts: [
            { id: 'source', text: 'needle source' },
            { id: 'linked', text: 'needle linked' },
            { id: 'target', text: 'main text', subItems: [{ text: 'needle subtask' }] },
            { id: 'plain', text: '<needle plain>' }
        ],
        sourceId: 'source',
        linkedIds: new Set(['linked']),
        query: 'needle',
        escapeHtml
    });
    assert(!html.includes('source'), 'manual relation options should exclude the source thought');
    assert(!html.includes('linked'), 'manual relation options should exclude already linked thoughts');
    assert(html.includes('data-manual-relation-target="target"'), 'manual relation options should include valid targets');
    assert(html.includes('<mark class="thought-highlight">needle</mark> subtask'), 'manual relation options should summarize and highlight matching subtasks');
    assert(html.includes('&lt;<mark class="thought-highlight">needle</mark> plain&gt;'), 'manual relation options should escape and highlight summaries');

    const emptyHtml = renderManualRelationSearchOptions({
        thoughts: [],
        sourceId: 'source',
        linkedIds: new Set(),
        query: 'needle',
        escapeHtml
    });
    assert(emptyHtml.includes('没有可链接结果'), 'empty manual relation search should show the existing empty state');

    const relationsHtml = renderRelationsList([{
        thought: { id: 'target', text: 'AI explained target', createdAt: 1710000000000 },
        score: 0.66,
        confidence: 0.64,
        relationType: 'same_project',
        method: 'manual',
        source: 'manual',
        reasons: ['candidate reason', 'semantic match'],
        signals: { keyword: 0.6, manual: 1 }
    }], escapeHtml);
    assert(relationsHtml.includes('thought-relation-manual-icon'), 'manual relations should render the manual icon badge');
    assert(relationsHtml.includes('alt="nui2"'), 'manual relation icon should use the provided nui2 image alt');
    assert(relationsHtml.includes('candidate reason'), 'manual-confirmed AI suggestions should keep the AI reason detail line');
    assert(!relationsHtml.includes('manual 路 manual'), 'manual relations should not render duplicate manual detail text');
    assert(!relationsHtml.includes('>manual<'), 'manual relations should use the icon instead of visible manual text');

    console.log('Thought relations panel checks passed');
}

run();
