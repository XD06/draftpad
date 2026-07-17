const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadState() {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'thought-agent-state.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { getAgentSourceLabel, isAgentRunActive, isAgentRunTerminal, isAgentSourceStale };\n';
    const context = { module: { exports: {} }, exports: {}, Set, Number, String, Date, Object, Array, Math };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function loadPanel(state) {
    const sourcePath = path.join(__dirname, 'public', 'managers', 'thought-agent-panel.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/import \{[\s\S]*?\} from '\.\/thought-agent-state\.js';/, 'const { getAgentSourceLabel, isAgentRunActive, isAgentRunTerminal, isAgentSourceStale } = deps;')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { escapeAgentHtml, renderThoughtAgentPanel };\n';
    const context = { module: { exports: {} }, exports: {}, deps: state, String, Number, Array, Object };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const { renderThoughtAgentPanel } = loadPanel(loadState());
    const html = renderThoughtAgentPanel({
        thought: { id: 't1', version: 4 },
        state: {
            thoughtId: 't1',
            status: 'completed',
            text: '<img src=x onerror=alert(1)>',
            sourceSnapshot: { kind: 'thought', id: 't1', version: 3 },
            citations: [{ citationId: 'src-1', sourceRef: { kind: 'thought', id: 'other', label: '<b>原始 Thought</b>', version: 2 } }]
        }
    });
    assert(html.includes('找回相关内容'));
    assert(html.includes('基于编辑前的内容'), 'stale runs should be visibly marked');
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'model output must be HTML escaped');
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'model output must not create live DOM');
    assert(html.includes('&lt;b&gt;原始 Thought&lt;/b&gt;'), 'citation labels must be escaped');
    assert(html.includes('data-agent-citation="src-1"'), 'citations must expose a bounded click target');

    const thoughtsSource = fs.readFileSync(path.join(__dirname, 'public', 'managers', 'thoughts.js'), 'utf8');
    assert(thoughtsSource.includes("e.target.closest('[data-agent-toggle]')"), 'AI detail should delegate the related-content recovery toggle');
    assert(thoughtsSource.includes("querySelector('[data-agent-panel-host]')"), 'agent output should mount inside the AI detail host');
    assert(thoughtsSource.includes("panel.dataset.agentEventsBound = 'true'"), 'reopening the embedded panel must not duplicate its action handlers');
    assert(thoughtsSource.includes('this.closeThoughtAgentPanel(card, thought);\n        existing?.remove();'), 'closing AI detail should also clear the embedded recovery panel state');
    console.log('Thought agent panel checks passed');
}

run();
