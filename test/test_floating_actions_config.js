const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function loadConfigModule(envValue) {
    // 清掉 require 缓存，这样每个用例都能用自己的环境变量重新求值。
    const configPath = path.join(ROOT, 'config', 'index.js');
    delete require.cache[require.resolve(configPath)];
    const previous = process.env.DUMBPAD_HIDDEN_FLOATING_ACTIONS;
    if (envValue === undefined) {
        delete process.env.DUMBPAD_HIDDEN_FLOATING_ACTIONS;
    } else {
        process.env.DUMBPAD_HIDDEN_FLOATING_ACTIONS = envValue;
    }
    try {
        return require(configPath);
    } finally {
        if (previous === undefined) {
            delete process.env.DUMBPAD_HIDDEN_FLOATING_ACTIONS;
        } else {
            process.env.DUMBPAD_HIDDEN_FLOATING_ACTIONS = previous;
        }
    }
}

function loadFloatingActionsModule() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'floating-actions-config.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/^export /gm, '')
        + '\nmodule.exports = { CONFIGURABLE_FLOATING_ACTIONS, ALWAYS_VISIBLE_FLOATING_ACTIONS, applyFloatingActionsVisibility };\n';
    const context = { module: { exports: {} }, exports: {}, Set, Array, String };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function floatingActionsDocument() {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const block = html.match(/<div class="floating-actions"[\s\S]*?<\/div>/);
    assert(block, 'index.html should contain the .floating-actions container');
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${block[0]}</body></html>`);
    return dom.window.document;
}

function assertConfigParsing() {
    const unset = loadConfigModule(undefined);
    assert(
        Array.isArray(unset.HIDDEN_FLOATING_ACTIONS)
            && unset.HIDDEN_FLOATING_ACTIONS.length === 1
            && unset.HIDDEN_FLOATING_ACTIONS[0] === 'toggle-reflections',
        'without the env var the default list should hide only the reflections placeholder, got '
            + JSON.stringify(unset.HIDDEN_FLOATING_ACTIONS)
    );
    assert(
        unset.DEFAULT_HIDDEN_FLOATING_ACTIONS === 'toggle-reflections',
        'the default list should stay exported so docs and tests can reference it'
    );

    const explicit = loadConfigModule(' Clipboard-Import-Trigger, toggle-thoughts ,clipboard-import-trigger,');
    assert(
        JSON.stringify(explicit.HIDDEN_FLOATING_ACTIONS) === JSON.stringify(['clipboard-import-trigger', 'toggle-thoughts']),
        'an explicit value should replace the default and be trimmed, lowercased and de-duplicated, got '
            + JSON.stringify(explicit.HIDDEN_FLOATING_ACTIONS)
    );

    const empty = loadConfigModule('');
    assert(
        Array.isArray(empty.HIDDEN_FLOATING_ACTIONS) && empty.HIDDEN_FLOATING_ACTIONS.length === 0,
        'an explicitly empty value should mean "hide nothing", got '
            + JSON.stringify(empty.HIDDEN_FLOATING_ACTIONS)
    );
}

function assertVisibilityApplies() {
    const {
        CONFIGURABLE_FLOATING_ACTIONS,
        ALWAYS_VISIBLE_FLOATING_ACTIONS,
        applyFloatingActionsVisibility
    } = loadFloatingActionsModule();
    const doc = floatingActionsDocument();

    // 清单与真实标记必须一致，否则配置里的 id 会静默失效。
    const markupIds = [...doc.querySelectorAll('.floating-actions .floating-btn')]
        .map(button => button.id);
    const expectedIds = ['fab-toggle-group', ...CONFIGURABLE_FLOATING_ACTIONS, 'scroll-helper'];
    assert(
        JSON.stringify(markupIds) === JSON.stringify(expectedIds),
        'index.html floating actions must match the manager inventory in order, expected '
            + JSON.stringify(expectedIds) + ' but the markup is ' + JSON.stringify(markupIds)
    );
    for (const id of [...CONFIGURABLE_FLOATING_ACTIONS, ...ALWAYS_VISIBLE_FLOATING_ACTIONS]) {
        assert(markupIds.includes(id), `index.html should keep the floating button #${id} for config toggling`);
    }
    assert(
        doc.getElementById('toggle-reflections').hidden === true,
        'the reflections placeholder should ship hidden so it never flashes before /api/config lands'
    );
    for (const id of CONFIGURABLE_FLOATING_ACTIONS.filter(item => item !== 'toggle-reflections')) {
        assert(doc.getElementById(id).hidden === false, `#${id} should be visible by default in markup`);
    }

    const applied = applyFloatingActionsVisibility(doc, ['Clipboard-Import-Trigger', 'toggle-reflections']);
    assert(
        applied.hidden.includes('clipboard-import-trigger') && applied.shown.includes('toggle-thoughts'),
        'the blacklist should hide the quick-record entry and keep thoughts visible, got '
            + JSON.stringify(applied)
    );
    assert(
        doc.getElementById('clipboard-import-trigger').hidden === true
            && doc.getElementById('toggle-reflections').hidden === true,
        'listed buttons should end up with the hidden attribute set'
    );
    assert(
        doc.querySelector('#clipboard-import-trigger')?.getAttribute('class') === 'floating-btn'
            && doc.querySelectorAll('.floating-actions .floating-btn').length === markupIds.length,
        'hiding must keep the DOM node intact so removing the config entry restores it'
    );

    const restored = applyFloatingActionsVisibility(doc, []);
    assert(
        restored.hidden.length === 0 && restored.shown.length === CONFIGURABLE_FLOATING_ACTIONS.length,
        'an empty blacklist should show every configurable button again, got ' + JSON.stringify(restored)
    );

    const protectedRun = applyFloatingActionsVisibility(doc, ['scroll-helper', 'fab-toggle-group', 'made-up-button']);
    assert(
        doc.getElementById('scroll-helper').hidden === false && doc.getElementById('fab-toggle-group').hidden === false,
        'shell-critical buttons must never be hidden by config'
    );
    const reasons = Object.fromEntries(protectedRun.ignored.map(item => [item.id, item.reason]));
    assert(
        reasons['scroll-helper'] === 'protected'
            && reasons['fab-toggle-group'] === 'protected'
            && reasons['made-up-button'] === 'unknown',
        'ignored entries should report why they were dropped, got ' + JSON.stringify(protectedRun.ignored)
    );
    assert(
        protectedRun.hidden.length === 0,
        'protected or unknown ids must not hide anything, got ' + JSON.stringify(protectedRun.hidden)
    );

    for (const invalid of [undefined, null, 'toggle-thoughts']) {
        const doc2 = floatingActionsDocument();
        const result = applyFloatingActionsVisibility(doc2, invalid);
        assert(
            result.hidden.length === 0 && result.shown.length === 0,
            'a non-list config (missing fetch, offline, string) should be a no-op'
        );
        assert(
            doc2.getElementById('toggle-thoughts').hidden === false
                && doc2.getElementById('toggle-reflections').hidden === true,
            'the no-op path should keep the markup defaults untouched'
        );
    }
}

function assertWiring() {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert(
        appSource.includes("from './managers/floating-actions-config.js'"),
        'app.js should import the floating actions visibility manager'
    );
    const loadStart = appSource.indexOf('async function loadAppConfig(');
    assert(loadStart >= 0, 'loadAppConfig should still exist');
    const loadSource = appSource.slice(loadStart, appSource.indexOf('\n    }', loadStart));
    assert(
        loadSource.includes('applyFloatingActionsVisibility(document, config.hiddenFloatingActions)'),
        'loadAppConfig should apply the blacklist from /api/config'
    );
    assert(
        loadSource.includes('floatingActionsVisibility.ignored'),
        'loadAppConfig should surface dropped entries instead of swallowing them'
    );

    assert(
        appSource.includes("getElementById('toggle-reflections')") && appSource.includes('反思功能开发中'),
        'the reflections placeholder should be wired to a "coming soon" toast'
    );

    const styles = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'styles.css'), 'utf8');
    assert(
        /\.floating-btn\[hidden\]\s*\{[^}]*display:\s*none/.test(styles),
        'styles.css must override .floating-btn display:flex for the hidden attribute to work'
    );

    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert(
        serverSource.includes('HIDDEN_FLOATING_ACTIONS') && serverSource.includes('hiddenFloatingActions: HIDDEN_FLOATING_ACTIONS'),
        'server.js should pass the parsed blacklist into the auth routes config payload'
    );

    const swSource = fs.readFileSync(path.join(ROOT, 'public', 'service-worker.js'), 'utf8');
    assert(
        swSource.includes('/managers/floating-actions-config.js'),
        'the new public module must be in the service worker CORE_ASSETS for offline PWA starts'
    );
}

try {
    assertConfigParsing();
    assertVisibilityApplies();
    assertWiring();
    console.log('floating actions config checks passed');
} catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
}
