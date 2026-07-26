const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, 'public', 'managers', 'heading-index.js');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/export function /g, 'function ')
    + '\nmodule.exports = { buildMarkdownHeadingIndex };\n';
const context = { module: { exports: {} }, exports: {}, Map, String, Array };
vm.runInNewContext(source, context, { filename: sourcePath });
const { buildMarkdownHeadingIndex } = context.module.exports;

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
assert.deepStrictEqual(Array.from(fenced.toc, item => item.text), ['Inside fence', 'Outside'], 'preserve existing fence scanning semantics');

console.log('Heading index checks passed');
