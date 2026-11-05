/**
 * 即时草稿行操作菜单与文章编辑器选区菜单统一回归。
 *
 * ① 菜单根节点复用 .selection-menu.typora-selection-menu 基类、图标走全局
 *    .sm-sprite，不再自带一份 .tdam-sprite；草稿专属的四个图标收编进共享清单；
 * ② 定位翻转与尖角对齐共享的 sm-below / --sm-tail-x；
 * ③ jsdom 里真的开一次菜单，钉住 DOM 结构、可访问名称、危险动作分隔线与关态。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const menuSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'today-drafts', 'today-draft-action-menu.js'), 'utf8');
const iconsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'selection-menu-icons.js'), 'utf8');
const todayCss = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'today-drafts.css'), 'utf8');
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

function checkSource() {
    check('menu root reuses the shared iOS icon bar base classes',
        menuSource.includes("root.className = 'selection-menu typora-selection-menu today-draft-action-menu'"));
    check('menu imports the shared sprite helpers',
        menuSource.includes("import { createSelectionMenuIcon, ensureSelectionMenuSprite } from '../selection-menu-icons.js'") &&
        menuSource.includes('ensureSelectionMenuSprite(doc)') &&
        menuSource.includes('createSelectionMenuIcon(action.icon, doc)'));
    check('menu wraps actions in a labelled toolbar group',
        menuSource.includes("bar.className = 'menu-btn-group'") &&
        menuSource.includes("bar.setAttribute('role', 'toolbar')") &&
        menuSource.includes("bar.setAttribute('aria-orientation', 'horizontal')"));
    check('divider and hidden labels use the shared class names',
        menuSource.includes("split.className = 'sm-split'") && menuSource.includes("label.className = 'sm-label'"));
    check('no private sprite or tdam icon ids remain',
        !menuSource.includes('const SPRITE_HTML') && !menuSource.includes('<symbol id="tdam-') &&
        !menuSource.includes('tdam-idea') && !menuSource.includes('tdam-note'));

    const actionsStart = menuSource.indexOf('export const DRAFT_MENU_ACTIONS');
    const actionsEnd = menuSource.indexOf('export class InstantDraftActionMenu');
    const actionsBlock = menuSource.slice(actionsStart, actionsEnd);
    for (const [action, icon] of Object.entries({
        copy: 'sm-copy', thought: 'sm-thought', article: 'sm-article',
        today: 'sm-drafts', plan: 'sm-plan', delete: 'sm-trash'
    })) {
        check(`action ${action} points at shared sprite icon ${icon}`,
            actionsBlock.includes(`${action}: { icon: '${icon}'`));
    }
    check('every action icon belongs to the sm- sprite',
        (actionsBlock.match(/icon: '([^']+)'/g) || []).length === 6 &&
        !/icon: 'tdam-/.test(actionsBlock));

    for (const icon of ['sm-thought', 'sm-drafts', 'sm-article', 'sm-plan']) {
        check(`shared sprite owns ${icon}`, iconsSource.includes(`id: '${icon}'`));
    }
    check('shared sprite still owns the two icons the draft menu reuses',
        iconsSource.includes("id: 'sm-copy'") && iconsSource.includes("id: 'sm-trash'"));
    // 图标源唯一：四个视图型图标必须逐字取自 floating-actions，菜单不再自带私有图形。
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    for (const [iconId, fabId] of [
        ['sm-thought', 'toggle-thoughts'],
        ['sm-drafts', 'toggle-today-drafts'],
        ['sm-plan', 'toggle-plan'],
        ['sm-copy', 'copy-all']
    ]) {
        const start = indexHtml.indexOf(`<button id="${fabId}"`);
        const block = indexHtml.slice(start, indexHtml.indexOf('</button>', start));
        const paths = [...block.matchAll(/<path d="([^"]+)"/g)].map(match => match[1]);
        const at = iconsSource.indexOf(`id: '${iconId}'`);
        const entry = iconsSource.slice(at, iconsSource.indexOf('    },', at));
        check(`${iconId} is byte-identical to floating-actions #${fabId}`,
            paths.length > 0 && paths.every(d => entry.includes(`'${d}'`)));
    }
    check('Thought uses the lightbulb, not the old flower glyph',
        !iconsSource.includes('M515.96 625.88'));
    check('article uses the user-provided document glyph, not a plus',
        iconsSource.includes("id: 'sm-article'") && !iconsSource.includes("id: 'sm-plus'") &&
        iconsSource.includes('M690.2 149.3H333.8') && iconsSource.includes('M682.5 333.2h-341'));

    check('menu flips with sm-below and keeps the shared tail aligned',
        menuSource.includes("this.root.classList.toggle('sm-below', below)") &&
        menuSource.includes("this.root.style.setProperty('--sm-tail-x'"));
    check('position measures the root capsule, not the button group',
        menuSource.includes('const menuWidth = this.root.offsetWidth') &&
        menuSource.includes('const menuHeight = this.root.offsetHeight'));

    check('shared icon bar CSS lives in styles.css',
        stylesCss.includes('.selection-menu.typora-selection-menu .sm-ic') &&
        stylesCss.includes('.selection-menu.typora-selection-menu.sm-below::after') &&
        stylesCss.includes('.selection-menu.typora-selection-menu .sm-split'));
    check('today-drafts.css only keeps local overrides',
        todayCss.includes('.selection-menu.typora-selection-menu.today-draft-action-menu[hidden]') &&
        todayCss.includes('position: fixed') &&
        todayCss.includes('button.tdam--danger[data-tdam-action="delete"]') &&
        !todayCss.includes('.tdam__bar') && !todayCss.includes('.tdam__tail') &&
        !todayCss.includes('@keyframes tdam-pop') && !todayCss.includes('--tdam-radius'));
    check('the lightbulb keeps the 22px optical compensation from floating-actions',
        todayCss.includes('button[data-tdam-action="thought"] .sm-ic') &&
        todayCss.includes('width: 22px'));
}

async function checkDom() {
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const { InstantDraftActionMenu, DRAFT_MENU_ACTIONS } = await import(
        '../public/managers/today-drafts/today-draft-action-menu.js'
    );

    const menu = new InstantDraftActionMenu({ host: dom.window.document.body });
    menu.ensureRoot();
    check('root starts hidden and carries the three base classes',
        menu.root.hidden === true &&
        ['selection-menu', 'typora-selection-menu', 'today-draft-action-menu']
            .every(cls => menu.root.classList.contains(cls)));
    check('only one global sprite is mounted',
        dom.window.document.body.querySelectorAll('.sm-sprite').length === 1);

    const anchor = dom.window.document.createElement('div');
    anchor.getBoundingClientRect = () => ({ left: 100, width: 200, top: 20, bottom: 60, height: 40, right: 300 });
    let selected = null;
    check('open() returns true for a non-empty action list',
        menu.open({ anchorEl: anchor, actionIds: ['copy', 'thought', 'article', 'plan', 'delete'], onSelect: id => { selected = id; } }) === true);
    check('open() reveals the menu', menu.root.hidden === false && menu.isOpen === true);

    const buttons = [...menu.bar.querySelectorAll('button[data-tdam-action]')];
    check('today menu renders the five actions in order',
        buttons.map(button => button.dataset.tdamAction).join(',') === 'copy,thought,article,plan,delete');
    check('the danger action is preceded by a shared split',
        menu.bar.querySelectorAll('.sm-split').length === 1 &&
        menu.bar.querySelector('.sm-split').nextElementSibling?.dataset.tdamAction === 'delete');
    check('the danger button carries the local danger marker',
        menu.bar.querySelector('[data-tdam-action="delete"]').classList.contains('tdam--danger'));
    check('the button group is a labelled horizontal toolbar',
        menu.bar.getAttribute('role') === 'toolbar' && menu.bar.getAttribute('aria-orientation') === 'horizontal');

    let iconsOk = true;
    let labelsOk = true;
    for (const button of buttons) {
        const icon = button.querySelector('svg.sm-ic use');
        const expected = DRAFT_MENU_ACTIONS[button.dataset.tdamAction].icon;
        if (!icon || icon.getAttribute('href') !== `#${expected}` ||
            icon.getAttributeNS('http://www.w3.org/1999/xlink', 'href') !== `#${expected}`) iconsOk = false;
        const label = button.querySelector('span.sm-label');
        if (!label || label.textContent !== button.getAttribute('aria-label') || label.textContent !== button.title) labelsOk = false;
    }
    check('every action uses the shared sprite icon with dual href/xlink:href', iconsOk);
    check('every action keeps a visually hidden label matching its accessible name', labelsOk);

    // 上方放不下（rect.top=20 < 菜单高度 + margin）→ 翻到下方并写尖角变量。
    check('near-top anchor flips to sm-below and sets --sm-tail-x',
        menu.root.classList.contains('sm-below') &&
        /^\d+px$/.test(menu.root.style.getPropertyValue('--sm-tail-x')));
    anchor.getBoundingClientRect = () => ({ left: 100, width: 200, top: 400, bottom: 440, height: 40, right: 300 });
    menu.reanchor(anchor);
    check('lower anchor keeps the menu above (no sm-below)', !menu.root.classList.contains('sm-below'));

    menu.bar.querySelector('[data-tdam-action="copy"]').click();
    check('clicking an action closes the menu and dispatches the id',
        selected === 'copy' && menu.isOpen === false && menu.root.hidden === true && menu.bar.childElementCount === 0);

    check('reopening does not mount a second sprite',
        menu.open({ anchorEl: anchor, actionIds: ['today', 'copy', 'thought', 'article'] }) === true &&
        dom.window.document.body.querySelectorAll('.sm-sprite').length === 1);
    check('historical menu drops the danger action and its split',
        [...menu.bar.querySelectorAll('button[data-tdam-action]')].map(button => button.dataset.tdamAction).join(',') === 'today,copy,thought,article' &&
        menu.bar.querySelectorAll('.sm-split').length === 0);
    check('historical 加入今日 uses the instant-drafts view icon',
        menu.bar.querySelector('[data-tdam-action="today"] use').getAttribute('href') === '#sm-drafts');
    menu.close();
    check('close() hides the menu', menu.root.hidden === true);
}

async function main() {
    checkSource();
    await checkDom();
    if (failures) {
        console.error(`Instant drafts action menu unification: ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('Instant drafts action menu unification checks passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
