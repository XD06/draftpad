/**
 * Parsed document reuse exercises the real bundled editor and Markdown parser.
 * Checks exact content invalidation, immutable snapshots and bounded retention.
 * Cached loads must preserve serialization, source mode and undo semantics.
 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'MutationObserver', 'KeyboardEvent']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
}
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.getSelection = dom.window.getSelection.bind(dom.window);
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
dom.window.Element.prototype.scrollIntoView = () => {};
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const inputs = [];
    const wrapper = new HybridMarkdownEditor(container, { input: value => inputs.push(value) });
    try {
        await wrapper.whenReady();
        const parser = wrapper.editor.storage.markdown.parser;
        const parse = parser.parse.bind(parser);
        let parses = 0;
        parser.parse = (content, ...args) => {
            if (typeof content === 'string') parses += 1;
            return parse(content, ...args);
        };
        const articles = ['a', 'b', 'c', 'd'].map(id => `# Article ${id}\n\n正文 **加粗**\n换行\n\n- [ ] 任务\n- [x] 完成`);
        const expected = new Map();
        for (const content of articles) {
            wrapper.setValue(content, false);
            expected.set(content, wrapper.getValue());
        }
        const coldParses = parses;
        for (const index of [0, 1, 2, 3, 0, 2, 1, 0]) {
            const content = articles[index];
            wrapper.setValue(content, false);
            assert.equal(wrapper.getValue(), expected.get(content));
            assert.equal(wrapper.editor.can().undo(), false, 'cached article loads cannot become undo steps');
        }
        assert.equal(parses, coldParses, 'returning to four loaded articles must skip Markdown parsing');
        assert.deepEqual(inputs, [], 'silent cached loads must not mark notes dirty');

        wrapper.editor.commands.insertContent('本地编辑');
        assert(wrapper.getValue().includes('本地编辑'));
        wrapper.setValue(articles[1], false);
        wrapper.setValue(articles[0], false);
        assert.equal(wrapper.getValue(), expected.get(articles[0]), 'editing must not mutate an older immutable snapshot');
        for (let i = 0; i < 4; i += 1) wrapper.editor.commands.undo();
        assert.equal(wrapper.getValue(), expected.get(articles[0]), 'cached switches must not undo into another article');
        const updated = articles[0] + '\n\n远端新正文';
        const beforeUpdate = parses;
        wrapper.setValue(updated, false);
        assert.equal(parses, beforeUpdate + 1, 'changed content must parse afresh');
        assert(wrapper.getValue().includes('远端新正文'));

        const decorated = '---\ntitle: cache\n---\n\n# 标题\n\n==前 `code` 后==\n\n> 引用';
        wrapper.setValue(decorated, false);
        const normalized = wrapper.getValue();
        wrapper.setValue(articles[0], false);
        wrapper.setValue(decorated, false);
        assert.equal(wrapper.getValue(), normalized, 'frontmatter and normalized decoration marks survive cache reuse');
        wrapper.setSourceMode(true);
        wrapper.getSourceTextarea().value = '# 源码修改\n\n新正文';
        wrapper.setSourceMode(false);
        assert.equal(wrapper.getValue(), '# 源码修改\n\n新正文');

        wrapper.setValue(articles[0], false);
        for (let i = 0; i < 12; i += 1) wrapper.setValue(`# eviction ${i}`, false);
        const beforeEviction = parses;
        wrapper.setValue(articles[0], false);
        assert.equal(parses, beforeEviction + 1, 'old parsed documents must be evicted');
        assert(wrapper._parsedDocuments.size <= 8);
        const large = '大'.repeat(510000);
        wrapper.setValue(large, false);
        wrapper.setValue(articles[0], false);
        const beforeLarge = parses;
        wrapper.setValue(large, false);
        assert.equal(parses, beforeLarge + 1, 'oversized documents must not be retained');
        assert(wrapper._parsedDocumentSize <= 1000000);
        console.log('PASS parsed document cache: reuse, invalidation, edits, undo, source mode, normalization and bounds');
    } finally {
        wrapper.editor.destroy();
        dom.window.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
