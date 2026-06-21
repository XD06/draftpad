const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadTextFormatting() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-text-formatting.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/import \{ renderTimeMarkers \} from '.\/time-command\.js';\s*/, `function renderTimeMarkers(escaped = '', className = 'time-marker') {
    return String(escaped || '').replace(/\\[\\[time:(?:(create|update):)?(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})\\]\\]/g, (match, kindValue, stamp) => {
        const kind = kindValue === 'update' ? 'update' : 'create';
        return \`<time class="\${className} is-\${kind}" data-time-marker="true" data-time-kind="\${kind}" data-time-source="\${match}" data-time-stamp="\${stamp}"><span class="time-marker-label">\${kind === 'update' ? '更新' : '创建'}</span><span class="time-marker-stamp">\${stamp}</span></time>\`;
    });
}
`)
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { applyThoughtTextStyle, escapeHtml, escapeRegExp, formatThoughtText, linkifyText };\n';
    const context = {
        module: { exports: {} },
        exports: {}
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const { applyThoughtTextStyle, escapeHtml, escapeRegExp, formatThoughtText, linkifyText } = loadTextFormatting();

    assert(escapeHtml(null) === '', 'escapeHtml should match DOM escaping for nullish values');
    assert(escapeHtml('<tag attr="x">&') === '&lt;tag attr=&quot;x&quot;&gt;&amp;', 'escapeHtml should escape HTML-sensitive characters');
    assert(escapeRegExp('a+b*(c)') === 'a\\+b\\*\\(c\\)', 'escapeRegExp should escape regex metacharacters');

    const linked = linkifyText('Visit www.example.com/path, then https://example.org/a(b).');
    assert(
        linked.includes('<a href="https://www.example.com/path" target="_blank" rel="noopener noreferrer" class="thought-link">www.example.com/path</a>,'),
        'linkifyText should link www URLs and preserve trailing comma'
    );
    assert(
        linked.includes('<a href="https://example.org/a(b)" target="_blank" rel="noopener noreferrer" class="thought-link">https://example.org/a(b)</a>.'),
        'linkifyText should keep balanced closing parentheses inside URLs and preserve trailing period'
    );

    const escapedLink = linkifyText('https://example.com/?a=1&b=<x>');
    assert(escapedLink.includes('a=1&amp;b=&lt;x&gt</a>;'), 'linkifyText should preserve the existing escape-before-link behavior for escaped angle brackets');
    assert(linkifyText('') === '', 'linkifyText should keep empty text empty');
    assert(
        formatThoughtText('==重点== <span data-draw>画线</span> <mark>标记</mark>').includes('<mark class="thought-inline-highlight">重点</mark>'),
        'formatThoughtText should render ==highlight== markers'
    );
    assert(
        formatThoughtText('记录 [[time:2026-06-21 09:08:07]]').includes('<time class="thought-time-marker is-create" data-time-marker="true"'),
        'formatThoughtText should render time markers'
    );
    assert(
        formatThoughtText('记录 [[time:update:2026-06-21 09:08:07]]').includes('<time class="thought-time-marker is-update" data-time-marker="true"'),
        'formatThoughtText should render update time markers'
    );
    assert(
        formatThoughtText('<span data-draw>画线</span>').includes('<span class="thought-draw-line">画线</span>'),
        'formatThoughtText should render draw-line markers'
    );
    assert(
        formatThoughtText('<span data-note="测试">功能</span><sub data-note-label>（测试）</sub>').includes('<span class="thought-note-line" title="测试">功能</span>'),
        'formatThoughtText should render note markers with tooltip'
    );
    assert(
        applyThoughtTextStyle('先做重点再复盘', '重点', 'highlight') === '先做<mark>重点</mark>再复盘',
        'applyThoughtTextStyle should wrap selected text in a highlight marker'
    );
    assert(
        applyThoughtTextStyle('先做重点再复盘', '重点', 'draw') === '先做<span data-draw>重点</span>再复盘',
        'applyThoughtTextStyle should wrap selected text in a draw marker'
    );
    assert(
        applyThoughtTextStyle('先做<mark>重点</mark>再复盘', '重点', 'clear') === '先做重点再复盘',
        'applyThoughtTextStyle should clear existing thought style markers'
    );
    assert(
        applyThoughtTextStyle('先做<mark>重点</mark>再<span data-draw>复盘</span>', '重点', 'clear') === '先做重点再<span data-draw>复盘</span>',
        'applyThoughtTextStyle should only clear the selected style marker'
    );

    console.log('Thought text formatting checks passed');
}

run();
