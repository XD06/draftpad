const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadThoughtEditor() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-editor.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { appendLocalSubItem, applyLocalSubItemTextEdit, cleanSubItems, getEditableThoughtParts, migrateAndToggleLegacySubItem, parseLegacyText, renderSubtaskAddRow, renderSubtaskEditRow, renderSubtaskInlineAddRow, sortSubItems, toggleLocalSubItemCompletion };\n';
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

function run() {
    const {
        cleanSubItems,
        getEditableThoughtParts,
        appendLocalSubItem,
        applyLocalSubItemTextEdit,
        migrateAndToggleLegacySubItem,
        parseLegacyText,
        renderSubtaskAddRow,
        renderSubtaskEditRow,
        renderSubtaskInlineAddRow,
        sortSubItems,
        toggleLocalSubItemCompletion
    } = loadThoughtEditor();

    const parsed = parseLegacyText('Body\n- [ ] first\n- [x] done');
    assert(parsed.bodyText === 'Body', 'legacy parser should keep non-checkbox body text');
    assert(parsed.subItems.length === 2 && parsed.subItems[1].completed === true, 'legacy parser should preserve checkbox completion');

    const legacyEditable = getEditableThoughtParts({ text: 'Body\n- [ ] first', subItems: [] });
    assert(legacyEditable.bodyText === 'Body', 'editable parts should split legacy checkbox text');
    assert(legacyEditable.subtasks[0].id === 'legacy_1', 'editable parts should preserve legacy subtask ids before save');

    const structuredSubtask = { id: 'sub-1', text: 'structured', completed: false };
    const structuredEditable = getEditableThoughtParts({
        text: 'Body\n- [ ] should stay body because structured subtasks exist',
        subItems: [structuredSubtask]
    });
    assert(structuredEditable.bodyText.includes('should stay body'), 'structured subtasks should prevent legacy reparsing');
    structuredEditable.subtasks[0].text = 'changed';
    assert(structuredSubtask.text === 'structured', 'editable subtasks should be cloned before mutation');

    const rowHtml = renderSubtaskEditRow({ text: '<danger> & task', completed: true }, escapeHtml);
    assert(rowHtml.includes('class="subtask-check" checked'), 'edit row should reflect completed subtasks');
    assert(rowHtml.includes('value="&lt;danger&gt; &amp; task"'), 'edit row should escape input values');
    assert(renderSubtaskAddRow().includes('subtask-add-btn'), 'add row should expose the existing add button class');
    assert(renderSubtaskInlineAddRow().includes('placeholder="新增子任务..."'), 'inline add row should preserve the quick-add placeholder');
    assert(renderSubtaskInlineAddRow().includes('class="subtask-check" disabled'), 'inline add row should preserve disabled checkbox');

    const cleaned = cleanSubItems([
        { id: 'new_1', text: ' keep ', completed: true },
        { id: 'sub-2', text: 'stay', completed: false },
        { id: 'empty', text: '   ', completed: false }
    ]);
    assert(cleaned.length === 2, 'cleanSubItems should drop empty subtasks');
    assert(cleaned[0].text === 'keep' && cleaned[0].completed === true, 'cleanSubItems should trim text and preserve completion');
    assert(cleaned[1].id === 'sub-2', 'cleanSubItems should preserve real subtask ids');

    const sorted = sortSubItems([
        { text: 'done', completed: true },
        { text: 'open', completed: false }
    ]);
    assert(sorted[0].text === 'open', 'sortSubItems should keep open subtasks before completed ones');

    const localThought = { text: 'Body', subItems: [] };
    const appended = appendLocalSubItem(localThought, ' new subtask ');
    assert(appended.text === 'new subtask' && localThought.subItems.length === 1, 'appendLocalSubItem should append a trimmed local subtask');

    const updateResult = applyLocalSubItemTextEdit(localThought, appended.id, ' renamed ');
    assert(updateResult.action === 'update' && localThought.subItems[0].text === 'renamed', 'applyLocalSubItemTextEdit should update existing subtask text');

    const deleteResult = applyLocalSubItemTextEdit(localThought, appended.id, '   ');
    assert(deleteResult.action === 'delete' && localThought.subItems.length === 0, 'applyLocalSubItemTextEdit should delete empty subtasks');

    const toggleThought = { subItems: [{ id: 'sub-1', text: 'toggle', completed: false }] };
    assert(toggleLocalSubItemCompletion(toggleThought, 'sub-1') === true, 'toggleLocalSubItemCompletion should report changed subtasks');
    assert(toggleThought.subItems[0].completed === true, 'toggleLocalSubItemCompletion should toggle completion locally');
    assert(toggleLocalSubItemCompletion(toggleThought, 'missing') === false, 'toggleLocalSubItemCompletion should ignore missing subtasks');

    const legacyThought = { text: 'Body\n- [ ] first\n- [x] done' };
    assert(migrateAndToggleLegacySubItem(legacyThought, 'legacy_1') === true, 'migrateAndToggleLegacySubItem should migrate matching legacy subtasks');
    assert(legacyThought.text === 'Body', 'migrateAndToggleLegacySubItem should move legacy body text into thought text');
    assert(legacyThought.subItems.length === 2 && legacyThought.subItems[0].completed === true, 'migrateAndToggleLegacySubItem should toggle before assigning real ids');

    console.log('Thought editor checks passed');
}

run();
