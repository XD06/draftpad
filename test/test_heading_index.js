const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'public', 'managers', 'heading-index.js');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/export function /g, 'function ')
    + '\nmodule.exports = { buildMarkdownHeadingIndex, computeReadingProgress };\n';
const context = { module: { exports: {} }, exports: {}, Map, String, Array, Number, Math };
vm.runInNewContext(source, context, { filename: sourcePath });
const { buildMarkdownHeadingIndex, computeReadingProgress } = context.module.exports;

const empty = buildMarkdownHeadingIndex('');
assert.strictEqual(empty.toc.length, 0, 'empty Markdown should have no headings');
assert.strictEqual(empty.headingLineBySlug.size, 0, 'empty Markdown should have no heading map entries');

const basic = buildMarkdownHeadingIndex('intro\n# Title\nbody\n### Deep');
assert.deepStrictEqual(JSON.parse(JSON.stringify(basic.toc)), [
    { id: 'title', text: 'Title', level: 1, line: 1 },
    { id: 'deep', text: 'Deep', level: 3, line: 3 }
]);
assert.strictEqual(basic.headingLineBySlug.get('deep'), 3);
assert.strictEqual(basic.headingIds[1], 'title');

const decorated = buildMarkdownHeadingIndex('## **Hello** `World` ~~Now~~ ###');
assert.deepStrictEqual(JSON.parse(JSON.stringify(decorated.toc[0])), {
    id: 'hello-world-now',
    text: 'Hello World Now',
    level: 2,
    line: 0
});

const duplicates = buildMarkdownHeadingIndex('# API 设计\n# API 设计\n# API-设计');
assert.deepStrictEqual(Array.from(duplicates.toc, item => item.id), ['api-设计', 'api-设计-1', 'api-设计-2']);

const symbols = buildMarkdownHeadingIndex('# !!!\n# ???\n# 中文 标题！');
assert.deepStrictEqual(Array.from(symbols.toc, item => item.id), ['section', 'section-1', '中文-标题']);

const invalid = buildMarkdownHeadingIndex('Heading\n===\n # indented\n> # quote\n- # list\n####### too deep\n#valid');
assert.strictEqual(invalid.toc.length, 0, 'non-ATX headings should remain outside the index');

const crlf = buildMarkdownHeadingIndex('# Alpha #\r\n###### Zeta ######\r\n');
assert.deepStrictEqual(Array.from(crlf.toc, item => [item.text, item.line]), [['Alpha', 0], ['Zeta', 1]]);

const fenced = buildMarkdownHeadingIndex('```md\n# Inside fence\n```\n# Outside');
assert.deepStrictEqual(Array.from(fenced.toc, item => item.text), ['Outside'], 'headings inside fenced code blocks are not real headings');

const fencedTilde = buildMarkdownHeadingIndex('~~~\n## 示例文本\n~~~\n\n### Real');
assert.deepStrictEqual(Array.from(fencedTilde.toc, item => item.text), ['Real'], 'tilde fences are skipped too');

const unterminated = buildMarkdownHeadingIndex('```js\nconst a = "# not a heading";\n');
assert.strictEqual(unterminated.toc.length, 0, 'unterminated fence swallows the rest');

assert.strictEqual(computeReadingProgress({ scrollTop: 0, scrollHeight: 600, clientHeight: 600 }), null, 'single-screen notes hide progress');
assert.strictEqual(computeReadingProgress({ scrollTop: 0, scrollHeight: 620, clientHeight: 600 }), null, 'sub-threshold scroll delta hides progress');
assert.strictEqual(computeReadingProgress({ scrollTop: 0, scrollHeight: 1600, clientHeight: 600 }), 0);
assert.strictEqual(computeReadingProgress({ scrollTop: 500, scrollHeight: 1600, clientHeight: 600 }), 50);
assert.strictEqual(computeReadingProgress({ scrollTop: 1200, scrollHeight: 1600, clientHeight: 600 }), 100, 'overscroll clamps to 100');
assert.strictEqual(computeReadingProgress({ scrollTop: -30, scrollHeight: 1600, clientHeight: 600 }), 0, 'negative bounce clamps to 0');

console.log('Heading index checks passed');
