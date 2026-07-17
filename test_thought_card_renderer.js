const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadCardRenderer() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-card-renderer.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { renderThoughtCard };\n';
    const context = {
        module: { exports: {} },
        exports: {},
        Date,
        Math
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

function helpers() {
    return {
        parseLegacyText(text) {
            const subItems = [];
            const body = [];
            for (const line of String(text || '').split('\n')) {
                const match = line.match(/^- \[([ x])\] (.*)$/);
                if (match) {
                    subItems.push({ id: `legacy_${subItems.length}`, text: match[2], completed: match[1] === 'x' });
                } else {
                    body.push(line);
                }
            }
            return { bodyText: body.join('\n').trim(), subItems };
        },
        sortSubItems(items) {
            return [...items].sort((a, b) => Number(a.completed) - Number(b.completed));
        },
        linkify(text) {
            return escapeHtml(text);
        },
        highlightSearch(html, query) {
            return String(html).replace(new RegExp(query, 'gi'), match => `<mark>${match}</mark>`);
        },
        escapeHtml,
        renderAISuggestedTags() {
            return '<div class="thought-ai-tags"><button type="button" class="thought-ai-tag-suggestion" data-ai-tag="AI">+#AI</button></div>';
        },
        renderAIStatus(_thought, status, relationCount) {
            return `<button class="thought-ai-status ${status}"><span class="thought-ai-count ${relationCount > 0 ? 'has-count' : 'is-zero'}">${relationCount}</span></button>`;
        },
        normalizeAIStatus(status) {
            return ['pending', 'ready', 'empty', 'error', 'missing'].includes(status) ? status : 'missing';
        }
    };
}

function run() {
    const { renderThoughtCard } = loadCardRenderer();
    const rendered = renderThoughtCard({
        thought: {
            id: 'thought-1',
            text: 'Alpha body\n- [ ] first\n- [x] done\n- [ ] second\n- [ ] third\n- [ ] fourth',
            tags: ['project'],
            relationCount: 2,
            aiStatus: 'ready',
            createdAt: 1700000000000
        },
        query: 'first',
        ...helpers()
    });

    assert(rendered.bodyText === 'Alpha body', 'legacy checkbox text should be separated from body text');
    assert(rendered.isLong === true, 'cards with more than three subtasks should be expandable');
    assert(rendered.html.includes('thought-card-header'), 'card render should include header');
    assert(rendered.html.includes('thought-tag-wrap'), 'card render should include user tags');
    assert(rendered.html.includes('thought-ai-tag-suggestion'), 'card render should include AI tag suggestions');
    assert(rendered.html.includes('thought-ai-count has-count'), 'card render should include AI count badge');
    assert(rendered.html.includes('relations-count has-count'), 'card render should include relation count badge');
    assert(rendered.html.includes('subtasks-summary-row'), 'card render should include collapsed subtask summary');
    assert(rendered.html.includes('<mark>first</mark>'), 'card render should preserve search highlighting in subtasks');
    assert(rendered.html.includes('thought-attachment-add-footer'), 'card footer should include a browse-mode attachment control');
    assert(rendered.html.includes('<button type="button" class="thought-dot"'), 'completion control should be a native button so it does not compete with card gestures');
    assert(rendered.html.includes('aria-pressed="false"'), 'incomplete thoughts should expose their completion state to assistive technology');
    assert(!rendered.html.includes('thought-agent-recall-btn'), 'agent recall should not occupy the compact card footer');

    const empty = renderThoughtCard({
        thought: {
            id: 'thought-2',
            text: 'Short body',
            tags: [],
            relationCount: 0,
            aiStatus: 'missing',
            createdAt: 1700000000000
        },
        query: '',
        ...helpers()
    });

    assert(empty.isLong === false, 'short cards without subtasks should not be expandable');
    assert(empty.html.includes('subtask-add-footer'), 'cards without subtasks should expose footer add-subtask action');
    assert(empty.html.includes('relations-count is-zero'), 'zero relation count should keep zero badge class');

    const completed = renderThoughtCard({
        thought: {
            id: 'thought-completed',
            text: 'Completed body',
            completed: true,
            createdAt: 1700000000000
        },
        query: '',
        ...helpers()
    });
    assert(completed.html.includes('aria-pressed="true"'), 'completed thoughts should expose their completion state to assistive technology');

    const withAttachments = renderThoughtCard({
        thought: {
            id: 'thought-3',
            text: 'Has attachments',
            tags: [],
            attachments: [
                { id: 'image-1', name: 'photo.png', type: 'image/png', size: 1200, dataUrl: 'data:image/png;base64,AA==' },
                { id: 'file-1', name: 'notes.pdf', type: 'application/pdf', size: 2048, dataUrl: 'data:application/pdf;base64,AA==' }
            ],
            createdAt: 1700000000000
        },
        query: '',
        ...helpers()
    });
    assert(withAttachments.html.includes('thought-attachments'), 'card should render attachment collection');
    assert(withAttachments.html.includes('thought-attachment-preview'), 'images should render as preview buttons');
    assert(withAttachments.html.includes('data-preview-att="image-1"'), 'preview buttons should expose attachment ids');
    assert(!withAttachments.html.includes('thought-attachment-add-inline'), 'attachment collections should not duplicate the footer append control');

    console.log('Thought card renderer checks passed');
}

run();
