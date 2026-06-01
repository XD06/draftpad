const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadThoughtTagsModule() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-tags.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        .replace(/export class /g, 'class ')
        + `
module.exports = {
    normalizeTag,
    ThoughtTagRegistry,
    renderThoughtTagFilters,
    renderAISuggestedTags,
    renderQuickAddTagChoices,
    renderQuickAddTagSuggestions
};
`;
    const context = {
        module: { exports: {} },
        exports: {},
        console
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function createMemoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        dump(key) {
            return store.get(key);
        }
    };
}

function run() {
    const {
        normalizeTag,
        ThoughtTagRegistry,
        renderThoughtTagFilters,
        renderAISuggestedTags,
        renderQuickAddTagChoices,
        renderQuickAddTagSuggestions
    } = loadThoughtTagsModule();

    assert(normalizeTag('##  Project   Alpha  ') === 'Project Alpha', 'normalizeTag should trim marker and collapse spaces');
    assert(normalizeTag('x'.repeat(40)).length === 24, 'normalizeTag should cap tag length');

    const storage = createMemoryStorage({
        dumbpad_thought_tags: JSON.stringify([' Beta ', '#alpha'])
    });
    const registry = new ThoughtTagRegistry({ storage });

    assert.deepEqual(registry.savedTags, ['alpha', 'Beta'], 'registry should load, normalize, and sort saved tags');
    assert(registry.saveTag('alpha') === 'alpha', 'saveTag should return normalized duplicate tags');
    assert.deepEqual(registry.savedTags, ['alpha', 'Beta'], 'saveTag should not duplicate tags case-insensitively');
    assert(registry.saveTag('Gamma') === 'Gamma', 'saveTag should return new normalized tags');
    assert(JSON.parse(storage.dump('dumbpad_thought_tags')).includes('Gamma'), 'saveTag should persist new tags');

    const thoughts = [
        { tags: ['zeta', '#Alpha'] },
        { tags: ['beta', '', null] },
        { tags: ['zeta'] }
    ];
    assert.deepEqual(registry.getAllTags(thoughts), ['Alpha', 'beta', 'zeta'], 'getAllTags should collect unique thought tags');
    assert(registry.isTagUsed(thoughts, 'ALPHA') === true, 'isTagUsed should match case-insensitively');
    assert(registry.isTagUsed(thoughts, 'missing') === false, 'isTagUsed should reject unused tags');

    registry.syncFromThoughts(thoughts);
    assert(registry.savedTags.some(tag => tag === 'zeta'), 'syncFromThoughts should persist unseen thought tags');

    const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const filters = renderThoughtTagFilters({ tags: ['Alpha', 'Beta'], activeTag: 'beta', escapeHtml });
    assert(filters.includes('data-tag-filter="Beta"'), 'tag filter render should include tag values');
    assert(filters.includes('active'), 'tag filter render should mark active tag');
    assert(filters.includes('thoughts-tag-filter-input'), 'tag filter render should include create/filter input');

    const choices = renderQuickAddTagChoices({ tags: ['Alpha'], selectedTags: ['alpha'], escapeHtml });
    assert(choices.includes('quick-add-tag-chip selected'), 'quick add choices should mark selected tags');

    const emptyChoices = renderQuickAddTagChoices({ tags: [], selectedTags: [], escapeHtml });
    assert(emptyChoices.includes('No saved tags'), 'quick add choices should keep empty-state wording');

    const suggestions = renderQuickAddTagSuggestions({ suggestions: ['Alpha'], escapeHtml });
    assert(suggestions.includes('data-quick-tag-suggestion="Alpha"'), 'quick add suggestions should render options');

    const aiTags = renderAISuggestedTags({
        thought: { aiTags: [' Alpha ', '#Beta', '<unsafe>', 'Gamma', 'Delta', 'Extra'] },
        userTags: ['alpha'],
        escapeHtml
    });
    assert(!aiTags.includes('+#Alpha'), 'AI tag suggestions should hide tags already present on the thought');
    assert(aiTags.includes('data-ai-tag="Beta"'), 'AI tag suggestions should normalize hash-prefixed tags');
    assert(aiTags.includes('data-ai-tag="&lt;unsafe&gt;"'), 'AI tag suggestions should escape tag values');
    assert(!aiTags.includes('Extra'), 'AI tag suggestions should cap visible suggestions at four');

    const emptyAITags = renderAISuggestedTags({
        thought: { aiTags: ['Alpha'] },
        userTags: ['alpha'],
        escapeHtml
    });
    assert(emptyAITags === '', 'AI tag suggestions should render nothing when no new suggestions remain');

    console.log('Thought tag module checks passed');
}

run();
