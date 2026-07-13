const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function run() {
    const appSource = read(path.join('public', 'app.js'));
    const hybridSource = read(path.join('public', 'hybrid-editor.js'));
    const themeCss = read(path.join('public', 'Assets', 'ios-theme.css'));

    assert(
        appSource.includes('function applyCurrentNotepadTitle()') &&
            appSource.includes('const currentNotepad = currentNotepads.find(notepad => notepad.id === currentNotepadId);') &&
            appSource.includes('setHeaderTitle(name);'),
        'Header title should use the selected notepad name through one synchronization path'
    );
    assert(
        !appSource.includes('applyReadingModeTitle') &&
            !appSource.includes('setHeaderTitle(_siteTitle);'),
        'Editor mode changes must not replace the selected notepad name with the site title'
    );
    assert(
        (appSource.match(/applyCurrentNotepadTitle\(\);/g) || []).length >= 8,
        'Selection, cache, rename, mode and config paths should synchronize the header title'
    );

    const taskStyleStart = themeCss.indexOf('/* Markdown task lists keep Vditor');
    const taskStyleEnd = themeCss.indexOf('/* Desktop editor tools', taskStyleStart);
    const taskStyles = themeCss.slice(taskStyleStart, taskStyleEnd);
    assert(taskStyleStart >= 0 && taskStyleEnd > taskStyleStart, 'Task list theme block should exist');
    assert(
        taskStyles.includes('li.vditor-task > input[type="checkbox"]') &&
            taskStyles.includes('--task-checked-color: color-mix(in srgb, var(--primary-color) 72%, #ffd84a);') &&
            taskStyles.includes('background: var(--task-checked-color);') &&
            taskStyles.includes('color: #ffffff;'),
        'Task checkboxes should use a brighter gold fill with a white checkmark'
    );
    assert(
        !/#(?:007aff|0a84ff|2563eb|60a5fa)/i.test(taskStyles) &&
            !/rgb\(\s*0\s*,\s*122\s*,\s*255\s*\)/i.test(taskStyles),
        'Task checkbox styles must not introduce blue accents'
    );
    assert(
        !hybridSource.includes('handleWysiwygTask') && !hybridSource.includes('bindTaskList'),
        'Task behavior should remain owned by Vditor instead of custom hybrid-editor handlers'
    );

    console.log('Notepad title and task style checks passed');
}

run();
