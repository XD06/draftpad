import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
    APPEARANCE_BUNDLES,
    APPEARANCE_CACHE_KEY,
    APPEARANCE_GROUP_REGISTRY,
    DEFAULT_APPEARANCE,
    MANAGED_APPEARANCE_CSS_VARS,
    applyAppearanceSettings,
    findMatchingBundleId,
    normalizeAppearanceSettings,
    resolveAppearanceCssVars,
    serializeAppearanceKey
} from '../public/managers/appearance-presets.js';
import SettingsManager from '../public/managers/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function runPresetResolutionTests() {
    assert.deepEqual(
        normalizeAppearanceSettings(null),
        DEFAULT_APPEARANCE,
        'null settings normalize to defaults'
    );
    assert.deepEqual(
        normalizeAppearanceSettings({ accent: 'unknown', drawColor: 'teal', highlightColor: 42, calloutStyle: 'nope', headingStyle: 'section', listStyle: 'dash' }),
        {
            accent: 'default',
            drawColor: 'teal',
            highlightColor: 'default',
            annotationColor: 'default',
            calloutStyle: 'default',
            headingStyle: 'section',
            listStyle: 'default'
        },
        'invalid keys fall back to default while preserving valid ones'
    );
    assert.equal(normalizeAppearanceSettings({ headingStyle: 'clean', listStyle: 'dash' }).headingStyle, 'default');
    assert.equal(normalizeAppearanceSettings({ headingStyle: 'clean', listStyle: 'dash' }).listStyle, 'default');

    assert.deepEqual(
        Object.keys(APPEARANCE_GROUP_REGISTRY.calloutStyle),
        ['default', 'tint', 'quote'],
        'calloutStyle preset group must stay strictly 3 options'
    );
    assert.deepEqual(
        Object.keys(APPEARANCE_GROUP_REGISTRY.headingStyle),
        ['default', 'bookmark', 'section', 'underline', 'diamond']
    );
    assert.deepEqual(
        Object.keys(APPEARANCE_GROUP_REGISTRY.listStyle),
        ['default', 'tinted', 'geometric', 'guide']
    );

    assert.deepEqual(
        resolveAppearanceCssVars(DEFAULT_APPEARANCE, 'light'),
        {},
        'default appearance produces zero light-mode CSS overrides'
    );
    assert.deepEqual(
        resolveAppearanceCssVars(DEFAULT_APPEARANCE, 'dark'),
        {},
        'default appearance produces zero dark-mode CSS overrides'
    );

    const blueLight = resolveAppearanceCssVars({ accent: 'blue' }, 'light');
    const blueDark = resolveAppearanceCssVars({ accent: 'blue' }, 'dark');
    assert.equal(blueLight['--primary-color'], '#2563EB');
    assert.equal(blueDark['--primary-color'], '#60A5FA');
    assert.equal(blueLight['--task-checked-color'], '#2563EB');
    assert.equal(blueDark['--task-doing-color'], '#3B82F6');
    assert.notEqual(blueLight['--code-markdown'], blueDark['--code-markdown']);

    const fullCustom = resolveAppearanceCssVars(
        {
            accent: 'sage',
            drawColor: 'rose',
            highlightColor: 'mint',
            annotationColor: 'indigo'
        },
        'light'
    );
    assert.equal(fullCustom['--draw-color'], '#E11D48');
    assert.equal(fullCustom['--thought-draw-color'], '#E11D48');
    assert.equal(fullCustom['--highlight-bg'], 'rgba(52, 211, 153, 0.24)');
    assert.equal(fullCustom['--thought-highlight-color'], 'inherit');
    assert.equal(fullCustom['--annotation-color'], '#4F46E5');
    assert.equal(fullCustom['--annotation-color-hover'], '#6366F1');

    // Bundle matching integrity & uniqueness
    const seenTuples = new Set();
    for (const bundle of APPEARANCE_BUNDLES) {
        const key = serializeAppearanceKey(bundle.appearance);
        assert.equal(seenTuples.has(key), false, `duplicate bundle appearance tuple: ${bundle.id}`);
        seenTuples.add(key);
        assert.equal(findMatchingBundleId(bundle.appearance), bundle.id);
    }
    assert.equal(
        findMatchingBundleId({ accent: 'blue', drawColor: 'rose', highlightColor: 'default', annotationColor: 'default' }),
        'custom'
    );
}

function runApplyAndCacheTests() {
    const styleStore = new Map();
    const mockRoot = {
        style: {
            setProperty(name, val) { styleStore.set(name, val); },
            removeProperty(name) { styleStore.delete(name); }
        }
    };
    const localMap = new Map();
    const mockStorage = {
        getItem(k) { return localMap.has(k) ? localMap.get(k) : null; },
        setItem(k, v) { localMap.set(k, String(v)); },
        removeItem(k) { localMap.delete(k); }
    };

    applyAppearanceSettings(
        { accent: 'plum', drawColor: 'teal', highlightColor: 'sky', annotationColor: 'berry' },
        'dark',
        mockRoot,
        { storage: mockStorage, persistCache: true }
    );
    assert.equal(styleStore.get('--primary-color'), '#A78BFA');
    assert.equal(styleStore.get('--draw-color'), '#2DD4BF');
    assert.ok(localMap.has(APPEARANCE_CACHE_KEY), 'non-default persisted settings populate FOUC cache');

    const cached = JSON.parse(localMap.get(APPEARANCE_CACHE_KEY));
    assert.equal(cached.key, 'plum|teal|sky|berry');
    assert.equal(cached.light['--primary-color'], '#7C3AED');
    assert.equal(cached.dark['--primary-color'], '#A78BFA');

    // Revert to default: clears every managed CSS var AND drops the FOUC cache
    applyAppearanceSettings(DEFAULT_APPEARANCE, 'light', mockRoot, { storage: mockStorage, persistCache: true });
    for (const prop of MANAGED_APPEARANCE_CSS_VARS) {
        assert.equal(styleStore.has(prop), false, `default reset must clear inline override ${prop}`);
    }
    assert.equal(localMap.has(APPEARANCE_CACHE_KEY), false, 'default appearance leaves no FOUC cache behind');

    // Step 8: layout style attributes set/cleared cleanly on DOM root
    const attrs = new Map();
    const attrRoot = {
        style: mockRoot.style,
        setAttribute(k, v) { attrs.set(k, String(v)); },
        removeAttribute(k) { attrs.delete(k); },
        getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; }
    };
    applyAppearanceSettings(
        { calloutStyle: 'tint', headingStyle: 'bookmark', listStyle: 'guide' },
        'light',
        attrRoot
    );
    assert.equal(attrRoot.getAttribute('data-callout-style'), 'tint');
    assert.equal(attrRoot.getAttribute('data-heading-style'), 'bookmark');
    assert.equal(attrRoot.getAttribute('data-list-style'), 'guide');

    applyAppearanceSettings(DEFAULT_APPEARANCE, 'light', attrRoot);
    assert.equal(attrRoot.getAttribute('data-callout-style'), null);
    assert.equal(attrRoot.getAttribute('data-heading-style'), null);
    assert.equal(attrRoot.getAttribute('data-list-style'), null);
}

function runDomAndSettingsManagerTests() {
    const indexHtml = fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8');
    const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = dom.window;

    // 1. Every bundle and preset in the registry must have a matching button in index.html
    for (const bundle of APPEARANCE_BUNDLES) {
        const card = dom.window.document.querySelector(`[data-appearance-bundle="${bundle.id}"]`);
        assert.ok(card, `index.html missing bundle card for ${bundle.id}`);
    }
    for (const [group, presetMap] of Object.entries(APPEARANCE_GROUP_REGISTRY)) {
        for (const id of Object.keys(presetMap)) {
            const btn = dom.window.document.querySelector(
                `[data-appearance-group="${group}"][data-appearance-value="${id}"]`
            );
            assert.ok(btn, `index.html missing appearance swatch button for ${group}:${id}`);
        }
    }
    const typographyDetails = dom.window.document.getElementById('settings-appearance-typography-details');
    assert.ok(typographyDetails, 'index.html should render collapsible typography appearance details');
    assert.equal(typographyDetails.hasAttribute('open'), false, 'typography swatches should be collapsed by default');
    const customDetails = dom.window.document.getElementById('settings-appearance-custom-details');
    assert.ok(customDetails, 'index.html should render collapsible custom appearance details');
    assert.equal(customDetails.hasAttribute('open'), false, 'custom single-color swatches should be collapsed by default');

    // 2. Verify SettingsManager backwards-compatible load, bundle click, live swatch tweak, save, reset
    const persisted = {
        dumbpad_settings: {
            saveStatusMessageInterval: 500,
            disablePrintExpand: true
        }
    };
    const storageManager = {
        load(key) { return persisted[key] ? structuredClone(persisted[key]) : null; },
        save(key, val) { persisted[key] = structuredClone(val); }
    };
    const applyCalls = [];
    const manager = new SettingsManager(storageManager, (settings, opts = {}) => {
        applyCalls.push({ settings: structuredClone(settings), opts });
        applyAppearanceSettings(settings.appearance, 'light', dom.window.document.documentElement);
    });

    // Hydrated native selection-menu icons must be mounted inside appearance section
    assert.ok(dom.window.document.querySelector('svg.sm-sprite #sm-draw'), 'global sm-sprite must include #sm-draw');
    for (const iconId of ['sm-draw', 'sm-highlight', 'sm-annotate']) {
        const useEl = dom.window.document.querySelector(`[data-sm-icon="${iconId}"] svg.sm-ic use`);
        assert.ok(useEl, `settings appearance row must hydrate native icon ${iconId}`);
        assert.equal(useEl.getAttribute('href'), `#${iconId}`);
    }

    const loaded = manager.loadSettings();
    assert.equal(loaded.saveStatusMessageInterval, 500);
    assert.equal(loaded.disablePrintExpand, true);
    assert.deepEqual(loaded.appearance, DEFAULT_APPEARANCE);

    // Click curated bundle -> applies all 4 tokens together & highlights bundle
    const calmBtn = dom.window.document.querySelector('[data-appearance-bundle="calm-study"]');
    calmBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(calmBtn.classList.contains('is-active'), true);
    assert.equal(
        dom.window.document.querySelector('[data-appearance-bundle-status]')?.textContent,
        '海盐研读'
    );
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--primary-color'), '#2563EB');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--draw-color'), '#1D4ED8');

    // Tweaking single swatch inside advanced switches bundle badge to 自定义微调
    const roseBtn = dom.window.document.querySelector('[data-appearance-group="drawColor"][data-appearance-value="rose"]');
    roseBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(calmBtn.classList.contains('is-active'), false);
    assert.equal(
        dom.window.document.querySelector('[data-appearance-bundle-status]')?.textContent,
        '自定义微调'
    );

    // Click sea-salt blue + reset drawColor back to cobalt -> re-matches calm-study
    const cobaltBtn = dom.window.document.querySelector('[data-appearance-group="drawColor"][data-appearance-value="cobalt"]');
    cobaltBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(calmBtn.classList.contains('is-active'), true);

    // Step 8: selecting layout styles applies data-* attrs, updates labels, and survives color bundle switch
    const tintBtn = dom.window.document.querySelector('[data-appearance-group="calloutStyle"][data-appearance-value="tint"]');
    const bookmarkBtn = dom.window.document.querySelector('[data-appearance-group="headingStyle"][data-appearance-value="bookmark"]');
    const guideBtn = dom.window.document.querySelector('[data-appearance-group="listStyle"][data-appearance-value="guide"]');
    tintBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    bookmarkBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    guideBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    assert.equal(dom.window.document.documentElement.getAttribute('data-callout-style'), 'tint');
    assert.equal(dom.window.document.documentElement.getAttribute('data-heading-style'), 'bookmark');
    assert.equal(dom.window.document.documentElement.getAttribute('data-list-style'), 'guide');
    assert.equal(
        dom.window.document.querySelector('[data-appearance-active-label="calloutStyle"]')?.textContent,
        '纸面圆徽风'
    );
    assert.equal(
        dom.window.document.querySelector('[data-appearance-active-label="headingStyle"]')?.textContent,
        '书签色楔'
    );
    assert.equal(
        dom.window.document.querySelector('[data-appearance-active-label="listStyle"]')?.textContent,
        '嵌套引导线'
    );

    const warmPaperBtn = dom.window.document.querySelector('[data-appearance-bundle="warm-paper"]');
    warmPaperBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(dom.window.document.documentElement.getAttribute('data-callout-style'), 'tint');
    assert.equal(dom.window.document.documentElement.getAttribute('data-heading-style'), 'bookmark');
    assert.equal(dom.window.document.documentElement.getAttribute('data-list-style'), 'guide');

    // Re-apply calm-study to keep accent color check happy before save
    calmBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    assert.equal(
        dom.window.document.querySelector('[data-appearance-active-label="accent"]')?.textContent,
        '海盐蓝'
    );
    assert.deepEqual(
        persisted.dumbpad_settings.appearance,
        undefined,
        'clicking bundle/swatch previews immediately without overwriting saved storage'
    );

    // Save writes normalized appearance and persists
    const saved = manager.saveSettings();
    assert.equal(saved.appearance.accent, 'blue');
    assert.equal(saved.appearance.calloutStyle, 'tint');
    assert.equal(saved.appearance.headingStyle, 'bookmark');
    assert.equal(saved.appearance.listStyle, 'guide');
    assert.equal(persisted.dumbpad_settings.appearance.accent, 'blue');
    assert.equal(persisted.dumbpad_settings.appearance.calloutStyle, 'tint');
    assert.equal(applyCalls.at(-1).opts.persistCache, true);

    // Reset restores Amber Gold defaults and clears inline CSS vars + layout attributes
    const reset = manager.saveSettings(true);
    manager.loadSettings();
    assert.deepEqual(reset.appearance, DEFAULT_APPEARANCE);
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--primary-color'), '');
    assert.equal(dom.window.document.documentElement.getAttribute('data-callout-style'), null);
    assert.equal(dom.window.document.documentElement.getAttribute('data-heading-style'), null);
    assert.equal(dom.window.document.documentElement.getAttribute('data-list-style'), null);
    assert.equal(
        dom.window.document.querySelector('[data-appearance-bundle-status]')?.textContent,
        '琥珀经典'
    );
    assert.equal(
        dom.window.document.querySelector('[data-appearance-active-label="accent"]')?.textContent,
        '琥珀金'
    );

    // 3. Verify index.html <head> FOUC script consumes dumbpad_appearance_vars_v1 + layout styles safely
    const headScriptMatch = indexHtml.match(/<script>\s*\(function \(\) \{ \/\/ Initialize theme immediately[\s\S]*?\}\)\(\);\s*<\/script>/);
    assert.ok(headScriptMatch, 'index.html should keep inline theme + appearance init script');

    const foucDom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' });
    foucDom.window.matchMedia = () => ({ matches: false });
    const appCfg = {
        accent: 'plum',
        drawColor: 'cobalt',
        highlightColor: 'default',
        annotationColor: 'default',
        calloutStyle: 'quote',
        headingStyle: 'section',
        listStyle: 'geometric'
    };
    foucDom.window.localStorage.setItem('dumbpad_theme', JSON.stringify('dark'));
    foucDom.window.localStorage.setItem('dumbpad_settings', JSON.stringify({ appearance: appCfg }));
    foucDom.window.localStorage.setItem(
        APPEARANCE_CACHE_KEY,
        JSON.stringify({
            key: serializeAppearanceKey(appCfg),
            light: resolveAppearanceCssVars(appCfg, 'light'),
            dark: resolveAppearanceCssVars(appCfg, 'dark')
        })
    );
    const fn = vm.runInNewContext(
        `(function(window, document, localStorage){ ${headScriptMatch[0].replace(/^<script>|<\/script>$/g, '')} })`,
        {
            JSON,
            Object,
            String
        }
    );
    fn(foucDom.window, foucDom.window.document, foucDom.window.localStorage);

    assert.equal(foucDom.window.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(
        foucDom.window.document.documentElement.style.getPropertyValue('--primary-color'),
        '#A78BFA',
        'head FOUC initializer applies cached dark accent pre-paint'
    );
    assert.equal(
        foucDom.window.document.documentElement.style.getPropertyValue('--draw-color'),
        '#38BDF8',
        'head FOUC initializer applies cached dark draw color pre-paint'
    );
    assert.equal(foucDom.window.document.documentElement.getAttribute('data-callout-style'), 'quote');
    assert.equal(foucDom.window.document.documentElement.getAttribute('data-heading-style'), 'section');
    assert.equal(foucDom.window.document.documentElement.getAttribute('data-list-style'), 'geometric');

    delete global.document;
    delete global.window;
}

runPresetResolutionTests();
runApplyAndCacheTests();
runDomAndSettingsManagerTests();
console.log('Appearance presets & settings tab tests passed.');
