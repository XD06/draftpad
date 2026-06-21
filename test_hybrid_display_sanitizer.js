const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadSanitizer() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'hybrid-display-sanitizer.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { stripHybridDisplayArtifacts };\n';
    const context = {
        module: { exports: {} },
        exports: {}
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const { stripHybridDisplayArtifacts } = loadSanitizer();

    const renderedAnnotation = '<span class="has-annotation" data-comment="测试"><span style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">功能</span><span class="annotation-badge"><svg width="12" height="12"><path d="M21 15"></path></svg></span><sub style="display:none;color:#e74c3c;">（测试）</sub></span>';
    const sanitizedAnnotation = stripHybridDisplayArtifacts(renderedAnnotation);
    assert(!sanitizedAnnotation.includes('<svg'), 'rendered annotation badge SVG should not be saved');
    assert(!sanitizedAnnotation.includes('annotation-badge'), 'rendered annotation badge wrapper should not be saved');
    assert(
        sanitizedAnnotation === '<span data-note="测试" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">功能</span><sub data-note-label style="color:#e74c3c;font-size:0.65em;margin-left:2px;">（测试）</sub>',
        'rendered annotation should normalize back to source annotation markup'
    );

    assert(
        stripHybridDisplayArtifacts('<mark class="md-mark">重点</mark>') === '<mark>重点</mark>',
        'rendered mark class should normalize back to source mark markup'
    );
    assert(
        stripHybridDisplayArtifacts('\u200B<span data-draw>画线</span>') === '<span data-draw>画线</span>',
        'display guard zero-width marker should be removed before saving'
    );
    assert(
        stripHybridDisplayArtifacts('<time class="md-time-marker is-update" data-time-marker="true" data-time-kind="update" data-time-source="[[time:update:2026-06-21 09:08:07]]" data-time-stamp="2026-06-21 09:08:07"><span class="time-marker-label">更新</span><span class="time-marker-stamp">2026-06-21 09:08:07</span></time>') === '[[time:update:2026-06-21 09:08:07]]',
        'rendered time marker should normalize back to source marker text'
    );

    console.log('Hybrid display sanitizer checks passed');
}

run();
