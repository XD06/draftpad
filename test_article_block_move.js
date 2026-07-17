const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { lexer } = require('marked');

const source = fs.readFileSync(path.join(__dirname, 'public', 'managers', 'article-block-move.js'), 'utf8');
const executable = source
    .replace(/export function /g, 'function ')
    + '\nmodule.exports = { splitTopLevelMarkdownBlocks, moveStandaloneMarkdownBlock };\n';
const moduleShim = { exports: {} };
new Function('module', 'exports', executable)(moduleShim, moduleShim.exports);
const { splitTopLevelMarkdownBlocks, moveStandaloneMarkdownBlock } = moduleShim.exports;

function withoutMovedBlock(value, markdown) {
    return value.replace(markdown, '').replace(/\n{3,}/g, '\n\n').trim();
}

const image = '![image.png](/api/assets/image-id/preview "dumbpad-width=720")';
const sourceMarkdown = [
    '开头段落',
    '',
    image,
    '',
    '### 标题',
    '',
    '- 列表一',
    '- 列表二',
    '',
    '时间 [[time:create:2026-07-17 15:30:00]]',
    ''
].join('\n');

const parsed = splitTopLevelMarkdownBlocks(sourceMarkdown, lexer);
assert.strictEqual(parsed.blocks.length, 5, 'top-level Markdown blocks should match the five editor blocks');
assert.strictEqual(parsed.value, sourceMarkdown, 'block parsing must preserve every source character');

const movedUp = moveStandaloneMarkdownBlock({
    value: sourceMarkdown,
    markdown: image,
    sourceIndex: 1,
    targetIndex: 0,
    placement: 'before',
    lexer
});
assert.strictEqual(movedUp.ok, true, 'a standalone image should move before the first paragraph');
assert.strictEqual(movedUp.value, [
    image,
    '',
    '开头段落',
    '',
    '### 标题',
    '',
    '- 列表一',
    '- 列表二',
    '',
    '时间 [[time:create:2026-07-17 15:30:00]]',
    ''
].join('\n'), 'moving an image upward must preserve the exact heading, list, time marker, and whitespace text');

const movedAfterList = moveStandaloneMarkdownBlock({
    value: sourceMarkdown,
    markdown: image,
    sourceIndex: 1,
    targetIndex: 3,
    placement: 'after',
    lexer
});
assert.strictEqual(movedAfterList.ok, true, 'a standalone image should move after a list block');
assert.strictEqual(withoutMovedBlock(movedAfterList.value, image), withoutMovedBlock(sourceMarkdown, image), 'moving a block must not rewrite unrelated Markdown');
assert(movedAfterList.value.indexOf(image) > movedAfterList.value.indexOf('- 列表二'), 'the moved image should land after the list');
assert(movedAfterList.value.indexOf(image) < movedAfterList.value.indexOf('时间 [['), 'the moved image should remain before the following time-marker paragraph');

const file = '[📎 说明.txt · 1 KB](/api/assets/file-id/download "dumbpad-file=1;size=1024;type=text/plain")';
const fileAtEnd = `${sourceMarkdown}\n${file}`;
const movedFileUp = moveStandaloneMarkdownBlock({
    value: fileAtEnd,
    markdown: file,
    sourceIndex: 5,
    targetIndex: 2,
    placement: 'before',
    lexer
});
assert.strictEqual(movedFileUp.ok, true, 'an attachment at the article end should remain movable');
assert.strictEqual(withoutMovedBlock(movedFileUp.value, file), withoutMovedBlock(fileAtEnd, file), 'moving an attachment must preserve all unrelated source bytes');

const mismatch = moveStandaloneMarkdownBlock({
    value: sourceMarkdown,
    markdown: image,
    sourceIndex: 1,
    targetIndex: 99,
    placement: 'after',
    lexer
});
assert.strictEqual(mismatch.ok, false, 'a DOM/Markdown block mismatch should fail closed');

console.log('Article block move checks passed');
