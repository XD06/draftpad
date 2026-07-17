const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadArticleFileCommand() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'article-file-command.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export const /g, 'const ')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { FILE_COMMAND, ARTICLE_FILE_TITLE_PREFIX, formatFileSize, findFileCommandBeforeCursor, findFileCommandInMarkdownBlock, replaceFileCommand, buildArticleFileMarkdown };\n';
    const context = { module: { exports: {} }, exports: {}, String, Number, Math, RegExp, encodeURIComponent };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const {
        FILE_COMMAND,
        ARTICLE_FILE_TITLE_PREFIX,
        formatFileSize,
        findFileCommandBeforeCursor,
        findFileCommandInMarkdownBlock,
        replaceFileCommand,
        buildArticleFileMarkdown
    } = loadArticleFileCommand();

    assert.strictEqual(FILE_COMMAND, '/file');
    const spaced = findFileCommandBeforeCursor('插入 /file', 8, 8);
    assert.strictEqual(spaced.start, 3, 'the command should start at the / character');
    assert.strictEqual(spaced.end, 8, 'the command should end at the caret');
    const inline = findFileCommandBeforeCursor('插入/file内容', 7, 7);
    assert.strictEqual(inline.start, 2, 'the command should work before CJK text without a leading space');
    assert.strictEqual(inline.end, 7, 'the inline command should end at the caret');
    assert.strictEqual(
        findFileCommandBeforeCursor('插入/fileName', 7, 7),
        null,
        'an ASCII identifier suffix must not invoke the command'
    );
    assert.strictEqual(
        findFileCommandBeforeCursor('/file', 4, 5),
        null,
        'a selection must not invoke the command'
    );

    const fencedSource = [
        '开头段落',
        '',
        '```python',
        "print('ok')",
        '```',
        '',
        '/file'
    ].join('\n');
    const commandStart = fencedSource.lastIndexOf('/file');
    const fencedCommand = findFileCommandInMarkdownBlock(
        { raw: '/file', start: commandStart, end: fencedSource.length, type: 'paragraph' },
        '/file'
    );
    assert.strictEqual(fencedCommand?.start, commandStart, 'a /file paragraph after fenced code should keep its exact source start');
    assert.strictEqual(fencedCommand?.end, fencedSource.length, 'a /file paragraph after fenced code should keep its exact source end');
    assert.strictEqual(
        findFileCommandInMarkdownBlock(
            { raw: '```text\n/file\n```', start: 0, end: 17, type: 'code' },
            '/file'
        ),
        null,
        '/file inside a fenced code block must remain ordinary code text'
    );

    const replaced = replaceFileCommand('插入 /file 内容', { start: 3, end: 8 }, '[[上传中]]');
    assert.strictEqual(replaced.value, '插入 [[上传中]] 内容');
    assert.strictEqual(replaced.selectionStart, '插入 [[上传中]]'.length);
    assert.strictEqual(replaceFileCommand('插入 /file', { start: 0, end: 5 }, 'x'), null, 'the range must point at /file');

    assert.strictEqual(formatFileSize(999), '999 B');
    assert.strictEqual(formatFileSize(1536), '1.5 KB');
    assert.strictEqual(formatFileSize(20 * 1024 * 1024), '20 MB');

    const markdown = buildArticleFileMarkdown({
        name: '计划[最终].pdf',
        size: 1258291,
        type: 'application/pdf',
        downloadUrl: '/api/assets/a1/download'
    });
    assert(markdown.includes('📎 计划\\[最终\\].pdf · 1.2 MB'), 'file labels should be safe Markdown text');
    assert(markdown.includes('/api/assets/a1/download'), 'file markdown should retain the download URL');
    assert(markdown.includes(`${ARTICLE_FILE_TITLE_PREFIX};size=1258291;type=application%2Fpdf`), 'file markdown should carry its controlled display marker');
    assert.strictEqual(buildArticleFileMarkdown({ name: 'missing URL' }), '', 'an asset without a download URL cannot produce Markdown');
    console.log('Article file command checks passed');
}

run();
