/**
 * Thought 操作反馈 + 选区工具条统一回归。
 *
 * ① 每个写操作的成功路径都要走统一的 notifyThoughtAction（失败路径仍由
 *    outbox / 各操作自己的 error toast 负责，不在本测试范围）；
 * ② 选区工具条复用文章编辑器 iOS 风格图标条的基类、图标精灵与 sm-below
 *    翻转，不再自带一套「胶囊 + 内联描边 SVG」。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const thoughtsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
const thoughtsCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'thoughts.css'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'styles.css'), 'utf8');

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
}

/** 取「某方法签名 → 下一个标记」之间的源码，确认提示确实落在那个方法体内。 */
function methodBody(startMarker, endMarker) {
    const start = thoughtsSource.indexOf(startMarker);
    assert(start >= 0, `missing method: ${startMarker}`);
    const end = thoughtsSource.indexOf(endMarker, start + startMarker.length);
    assert(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
    return thoughtsSource.slice(start, end);
}

function checkToastWiring() {
    // 统一出口：只有一个，且真的把消息交给 toaster（不 static、带自动消失时长）。
    check('a single notifyThoughtAction helper is defined',
        (thoughtsSource.match(/notifyThoughtAction\(message, type = 'success', timeoutMs = 1600\)/g) || []).length === 1);
    check('the helper forwards to toaster.show',
        /notifyThoughtAction\(message, type = 'success', timeoutMs = 1600\) \{\s*this\.app\?\.toaster\?\.show\?\.\(message, type, false, timeoutMs\);/.test(thoughtsSource));

    const operations = [
        ['async submitQuickAdd() {', 'initQuickAddTagEvents() {', '创建（Quick Add）'],
        ['async toggleComplete(id) {', 'async togglePin(id) {', '完成切换'],
        ['async togglePin(id) {', 'async deleteThought(id) {', '置顶切换'],
        ['async confirmAndDeleteThought(id, { skipConfirm = false } = {}) {', 'scheduleRender() {', '删除'],
        ['async appendThoughtAttachments(thought, additions) {', 'ensureAttachmentLightbox() {', '追加附件'],
        ['async applySelectedThoughtStyle(style) {', 'async applySelectedSubtaskStyle(', '选区样式（正文）'],
        ['async applySelectedSubtaskStyle(thought, subId, selectedText, style) {', 'bindThoughtInlineStyleClearing(', '选区样式（子任务）'],
        ['async applyThoughtTimeAction(action) {', 'bindThoughtSwipeDelete(', '时间标记更新/删除'],
        ['copyTextWithFeedback(button, text) {', 'renderAISuggestedTags(', '复制'],
        ['async acceptAITag(thoughtId, rawTag) {', 'async removeThoughtTag(', '接受标签'],
        ['async removeThoughtTag(thoughtId, rawTag) {', 'isTagUsed(rawTag) {', '移除标签'],
        ['async retryAIProcessing(thoughtId) {', 'async toggleRelationsPanel(', 'AI 重试'],
        ['async createManualRelation(card, thought, targetId, relationType = \'manual\') {', 'async ignoreSuggestedRelation(', '新建关联'],
        ['async ignoreSuggestedRelation(card, sourceId, targetId) {', 'jumpToRelationTarget(', '忽略推荐关联'],
        ['async deleteRelation(card, sourceId, targetId) {', 'renderTagFilters() {', '删除关联'],
        ['enterEditMode(card, thought) {', 'exitEditMode(card) {', '编辑保存'],
        ['async quickAddSubtask(card, thought) {', 'ensureSubtaskList(card) {', '新增子任务'],
        ['async commitInlineSubtaskEdit({ input, textSpan, thought, subId, originalText }) {', 'async toggleSubtask(id, subId) {', '编辑子任务'],
        ['async toggleSubtask(id, subId) {', 'refreshThoughtSubtaskView(thought) {', '切换子任务'],
        ['async deleteSubtaskBySwipe(row, thought, subId) {', '_parseLegacyText(text) {', '滑删子任务'],
    ];
    for (const [start, end, label] of operations) {
        const body = methodBody(start, end);
        check(`${label} 的成功路径发出轻提示`, body.includes('notifyThoughtAction('), body.slice(0, 200));
    }

    // 文案：与文章编辑器选区菜单的「已高亮 / 已画线 / 已删除时间标记」同一句式。
    for (const message of [
        '已添加 Thought', '已移入垃圾桶', '已标记完成', '已取消完成', '已置顶', '已取消置顶',
        '已保存修改', '已添加附件', '已复制', '已添加标签', '已移除标签',
        '已重新提交 AI 处理', '已添加关联', '已忽略推荐关联', '已删除关联',
        '已高亮', '已画线', '已清除样式', '已更新为当前时间', '已删除时间标记',
        '已添加子任务', '已保存子任务', '已更新子任务', '已删除子任务',
    ]) {
        check(`成功文案存在：${message}`, thoughtsSource.includes(`'${message}'`));
    }
}

function checkSharedToolbarSource() {
    check('toolbar reuses the iOS icon bar base classes',
        thoughtsSource.includes("toolbar.className = 'selection-menu typora-selection-menu thought-selection-toolbar'"));
    check('toolbar ensures the shared icon sprite exists',
        thoughtsSource.includes('ensureSelectionMenuSprite(document)') &&
        thoughtsSource.includes("import { ensureSelectionMenuSprite } from './selection-menu-icons.js'"));
    check('toolbar wraps actions in a labelled toolbar group',
        thoughtsSource.includes('class="menu-btn-group" role="toolbar" aria-label="文字样式"'));
    for (const iconId of ['sm-highlight', 'sm-draw', 'sm-copy', 'sm-trash']) {
        check(`toolbar uses shared sprite icon ${iconId}`,
            thoughtsSource.includes(`<use href="#${iconId}" xlink:href="#${iconId}">`));
    }
    check('old inline lucide SVGs are gone from the toolbar',
        !thoughtsSource.includes("data-thought-style=\"highlight\" title=\"高亮\" aria-label=\"高亮\"><svg viewBox=\"0 0 24 24\""));
    check('toolbar flips with sm-below and keeps the tail aligned',
        thoughtsSource.includes("toolbar.classList.toggle('sm-below'") &&
        thoughtsSource.includes("toolbar.style.setProperty('--sm-tail-x'"));
    check('shared icon bar CSS is provided by styles.css',
        stylesCss.includes('.selection-menu.typora-selection-menu.sm-below::after') &&
        stylesCss.includes('.selection-menu.typora-selection-menu .sm-ic'));
    // 工具条自己的 CSS 块里不应再出现「胶囊 / 内联 SVG 尺寸」那套旧材质。
    const toolbarCssStart = thoughtsCss.indexOf('/* Thought 卡片选区工具条');
    const toolbarCssEnd = thoughtsCss.indexOf('.thought-inline-highlight', toolbarCssStart);
    const toolbarCss = toolbarCssStart >= 0 && toolbarCssEnd > toolbarCssStart
        ? thoughtsCss.slice(toolbarCssStart, toolbarCssEnd)
        : '';
    check('thoughts.css keeps only Thought-specific overrides',
        toolbarCss !== '' &&
        !toolbarCss.includes('.thought-selection-toolbar button svg') &&
        !toolbarCss.includes('border-radius: 999px') &&
        !toolbarCss.includes('backdrop-filter'));
    // 模式显隐选择器必须补足前缀，否则共享 button 规则 (0,3,1) 会压过 display:none。
    check('mode visibility selectors outrank the shared button rule',
        thoughtsCss.includes('.selection-menu.typora-selection-menu.thought-selection-toolbar[data-mode="format"] [data-thought-style="clear"]') &&
        thoughtsCss.includes('.selection-menu.typora-selection-menu.thought-selection-toolbar[data-mode="clear"] [data-thought-style="highlight"]'));
    check('existing mode-visibility assertions still hold',
        thoughtsCss.includes('.thought-selection-toolbar[data-mode="format"] [data-thought-style="clear"]') &&
        thoughtsCss.includes('.thought-selection-toolbar[data-mode="clear"] [data-thought-style="highlight"]'));
}

async function checkToolbarDom() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.getSelection = dom.window.getSelection.bind(dom.window);
    globalThis.requestAnimationFrame = () => 0;
    globalThis.CSS = dom.window.CSS || { escape: value => String(value) };
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

    const { ThoughtsManager } = await import('../public/managers/thoughts.js');
    const manager = Object.create(ThoughtsManager.prototype);
    manager.thoughtSelectionToolbar = null;
    manager.activeThoughtSelection = null;

    const toolbar = manager.ensureThoughtSelectionToolbar();
    check('toolbar carries all three class families',
        ['selection-menu', 'typora-selection-menu', 'thought-selection-toolbar']
            .every(name => toolbar.classList.contains(name)));
    check('toolbar starts hidden', toolbar.hidden === true);
    check('exactly one icon sprite is mounted',
        document.body.querySelectorAll('.sm-sprite').length === 1);
    const buttons = [...toolbar.querySelectorAll('button[data-thought-style]')];
    check('four style actions are rendered', buttons.length === 4);
    const expectedIcons = { highlight: 'sm-highlight', draw: 'sm-draw', copy: 'sm-copy', clear: 'sm-trash' };
    check('every action uses the shared sprite icons', buttons.every(button =>
        button.querySelector(`.sm-ic use[href="#${expectedIcons[button.dataset.thoughtStyle]}"]`) !== null));
    check('action labels stay in the accessibility tree',
        buttons.every(button => button.querySelector('.sm-label')?.textContent === button.getAttribute('aria-label')));
    check('copy keeps its icon-swap hook',
        toolbar.querySelector('[data-thought-style="copy"]').dataset.copyIcon === 'true');

    const nearTop = { left: 100, right: 200, top: 20, bottom: 40, width: 100, height: 20 };
    manager.showThoughtSelectionToolbar(nearTop, { mode: 'format' });
    check('toolbar is shown and flips below when there is no room above',
        toolbar.hidden === false && toolbar.classList.contains('sm-below'));
    check('tail stays pointing at the selection centre',
        toolbar.style.getPropertyValue('--sm-tail-x') !== '');
    check('toolbar is positioned in document coordinates',
        toolbar.style.left !== '' && toolbar.style.top !== '');

    const lower = { left: 100, right: 200, top: 400, bottom: 420, width: 100, height: 20 };
    manager.showThoughtSelectionToolbar(lower, { mode: 'clear' });
    check('toolbar stays above the selection when there is room',
        toolbar.dataset.mode === 'clear' && !toolbar.classList.contains('sm-below'));

    manager.hideThoughtSelectionToolbar();
    check('toolbar hides again', toolbar.hidden === true);
}

async function main() {
    checkToastWiring();
    checkSharedToolbarSource();
    await checkToolbarDom();
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log('\nThought feedback and selection toolbar checks passed.');
}

main().catch((error) => {
    console.error('FAILED', error);
    process.exitCode = 1;
});
