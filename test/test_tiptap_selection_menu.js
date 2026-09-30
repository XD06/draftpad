/**
 * Tiptap 选区浮动菜单回归：画线/高亮/批注走框架 mark 命令，
 * 选区落点、代码块/时间标记保护、roundtrip 序列化形态与旧编辑器
 * 对齐（旧 test_hybrid_editor_selection 行为的黑盒重写）。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.DocumentFragment = dom.window.DocumentFragment;
global.MutationObserver = dom.window.MutationObserver;
global.navigator = dom.window.navigator;
global.getSelection = dom.window.getSelection.bind(dom.window);
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.getComputedStyle = dom.window.getComputedStyle;
if (!dom.window.requestAnimationFrame) {
    dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
}
// jsdom 无布局环境：Element.getClientRects 自带但行为不可靠，Range 没有
// getClientRects；Tiptap 内核的 scrollToSelection / posAtCoords 两者都会调。
// 无条件补齐，避免 undo 等命令在测试环境 throw。
dom.window.document.elementFromPoint = function elementFromPoint() { return null; };
global.document.elementFromPoint = dom.window.document.elementFromPoint;
dom.window.Element.prototype.getClientRects = function getClientRects() { return []; };
dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
dom.window.Range.prototype.getBoundingClientRect = function getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
dom.window.Range.prototype.getClientRects = function getClientRects() { return []; };
global.HTMLAnchorElement = dom.window.HTMLAnchorElement;

const bundlePath = path.join(ROOT, 'public', 'vendor', 'tiptap', 'tiptap.bundle.js');
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: 'tiptap.bundle.js' });
if (!global.DumbPadTiptap) {
    console.error('FAIL: tiptap bundle did not expose global DumbPadTiptap');
    process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}`);
        if (detail) console.error(`  ${detail}`);
    }
}

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();

    const menuRoot = () => document.body.querySelector('.tiptap-selection-menu');
    const setValueAndSelect = async (value, from, to) => {
        editor.setValue(value, false);
        const { TextSelection } = global.DumbPadTiptap.PM.state;
        const tr = editor.editor.state.tr.setSelection(
            TextSelection.create(editor.editor.state.doc, from, to)
        );
        editor.editor.view.dispatch(tr);
        await new Promise((resolve) => setTimeout(resolve, 30));
    };

    // 1. 菜单 DOM 随编辑器创建（插件 view 挂载）
    check('menu mounted on editor create', Boolean(menuRoot()), 'menu root missing from document.body');

    // 2. 空选区不显示
    await setValueAndSelect('正文段落', 1, 1);
    check('empty selection hides menu', menuRoot().style.display === 'none');

    // 3. 文本选区显示菜单
    await setValueAndSelect('正文段落', 1, 5);
    check('text selection shows menu', menuRoot().style.display === 'flex');

    // 4. 画线 → draw mark → 序列化为 <span data-draw>
    await setValueAndSelect('正文段落', 1, 5);
    const drawBtn = [...menuRoot().querySelectorAll('button')].find(b => b.textContent === '画线');
    drawBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const drawValue = editor.getValue();
    check('draw mark applied via framework command', drawValue.includes('<span data-draw'), drawValue);

    // 5. 高亮 → mdHighlight mark → <mark>
    await setValueAndSelect('第二段落', 1, 5);
    const markBtn = [...menuRoot().querySelectorAll('button')].find(b => b.textContent === '高亮');
    markBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const markValue = editor.getValue();
    check('highlight mark serializes to <mark>', markValue.includes('<mark>'), markValue);

    // 6. 批注 → annotation mark → span[data-note] + sub 标签
    await setValueAndSelect('第三段落', 1, 5);
    const annoBtn = [...menuRoot().querySelectorAll('button')].find(b => b.textContent === '批注');
    annoBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const inputGroup = menuRoot().querySelector('.menu-input-group');
    check('annotate opens input group', inputGroup.style.display === 'flex');
    const annoInput = inputGroup.querySelector('textarea');
    annoInput.value = '测试批注';
    const saveBtn = inputGroup.querySelector('.save-anno-btn');
    saveBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const annoValue = editor.getValue();
    check('annotation mark serializes to span[data-note]', annoValue.includes('data-note="测试批注"'), annoValue);

    // 7. 菜单动作后撤销历史可用（框架 mark 命令进历史；必须在任何
    // setValue 之前断言——setContent 重置文档会清空撤销历史）
    editor.editor.commands.undo();
    const afterUndo = editor.getValue();
    check('mark actions are undoable', !afterUndo.includes('data-note="测试批注"'), afterUndo);

    // 8. 批注 roundtrip：setValue 后序列化稳定（首轮归一化出 <u> 包装，
    // 第二轮必须幂等，与 test_tiptap_roundtrip 的批注断言同语义）
    editor.setValue(annoValue, false);
    const annoOnce = editor.getValue();
    editor.setValue(annoOnce, false);
    const annoRoundtrip = editor.getValue();
    check('annotation roundtrip idempotent', annoRoundtrip === annoOnce, annoRoundtrip);

    // 8. 代码块内选区不显示菜单（mark 禁区）
    await setValueAndSelect('```js\nconst a = 1;\n```\n\n正文', 10, 15);
    check('code block selection hides menu', menuRoot().style.display === 'none');

    // 9. 时间标记选区不显示菜单（原子节点禁叠加 mark）
    const timeValue = '[[time:create:2026-01-01 00:00:00]] 正文';
    editor.setValue(timeValue, false);
    const timeNode = editor.editor.state.doc.descendants((node) => node.type.name === 'timeMarker');
    // timeMarker 是 inline 原子节点：from=pos, to=pos+1
    let timePos = null;
    editor.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'timeMarker' && timePos === null) { timePos = pos; return false; }
        return true;
    });
    if (timePos !== null) {
        await setValueAndSelect(timeValue, timePos, timePos + 1);
        check('time marker selection hides menu', menuRoot().style.display === 'none');
    } else {
        check('time marker selection hides menu', false, 'timeMarker node not found in doc');
    }

    // 11. 源码模式不显示菜单
    editor.setSourceMode(true);
    await setValueAndSelect('源码段落', 1, 5);
    check('source mode hides menu', menuRoot().style.display === 'none');
    editor.setSourceMode(false);

    // 12. 打字后选区折叠，菜单收起
    await setValueAndSelect('普通段落', 1, 5);
    check('selection before typing shows menu', menuRoot().style.display === 'flex');
    editor.editor.commands.insertContent('字');
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('collapsed selection after typing hides menu', menuRoot().style.display === 'none');

    // 12.5 拖拽选字流程：mousedown 进入拖拽态时选区事务不显示菜单，
    // mouseup（宏任务后）才显示（与旧编辑器「释放鼠标才出现」一致）。
    editor.setValue('拖拽选字段落', false);
    editor.editor.view.dom.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    {
        const { TextSelection } = global.DumbPadTiptap.PM.state;
        editor.editor.view.dispatch(editor.editor.state.tr.setSelection(
            TextSelection.create(editor.editor.state.doc, 1, 5)));
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('dragging selection does not show menu yet', menuRoot().style.display === 'none');
        editor.editor.view.dom.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('menu shows after mouseup', menuRoot().style.display === 'flex');
    }
    // 13. 落标记后选区退出（光标折叠到标记起点）
    await setValueAndSelect('第四段落', 1, 5);
    const drawBtn2 = [...menuRoot().querySelectorAll('button')].find(b => b.textContent === '画线');
    drawBtn2.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('selection collapsed after applying mark', editor.editor.state.selection.empty === true);

    // 14. 点击已标记文字弹「取消」popover
    editor.setValue('plain <mark>标记文字</mark> after', false);
    const markedEl = container.querySelector('mark.md-mark');
    check('marked element rendered', Boolean(markedEl));
    if (markedEl) {
        // PM handleClick 走完整鼠标流程（mousedown → mouseup → click）。
        const mouseOpts = { bubbles: true, cancelable: true, view: dom.window };
        markedEl.dispatchEvent(new dom.window.MouseEvent('mousedown', mouseOpts));
        markedEl.dispatchEvent(new dom.window.MouseEvent('mouseup', mouseOpts));
        markedEl.dispatchEvent(new dom.window.MouseEvent('click', mouseOpts));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const popover = document.body.querySelector('.mark-popover');
        const cancelBtn = [...(popover?.querySelectorAll('button') || [])].find(b => b.textContent === '取消高亮');
        check('cancel popover shows on marked click', Boolean(cancelBtn));
        if (cancelBtn) {
            cancelBtn.click();
            await new Promise((resolve) => setTimeout(resolve, 30));
            check('cancel highlight removes mark', !editor.getValue().includes('<mark>'), editor.getValue());
            // 取消动作可撤销
            editor.editor.commands.undo();
            check('cancel action is undoable', editor.getValue().includes('<mark>'), editor.getValue());
        }
    }

    // 15. 画线的取消 popover
    editor.setValue('plain <span data-draw="true" style="text-decoration:underline blue;text-decoration-thickness:2px;">画线文字</span> after', false);
    const drawEl = container.querySelector('[data-draw]');
    if (drawEl) {
        const mouseOpts = { bubbles: true, cancelable: true, view: dom.window };
        drawEl.dispatchEvent(new dom.window.MouseEvent('mousedown', mouseOpts));
        drawEl.dispatchEvent(new dom.window.MouseEvent('mouseup', mouseOpts));
        drawEl.dispatchEvent(new dom.window.MouseEvent('click', mouseOpts));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const popover = document.body.querySelector('.mark-popover');
        const cancelBtn = [...(popover?.querySelectorAll('button') || [])].find(b => b.textContent === '取消画线');
        check('cancel draw popover shows', Boolean(cancelBtn));
        if (cancelBtn) {
            cancelBtn.click();
            await new Promise((resolve) => setTimeout(resolve, 30));
            check('cancel draw removes mark', !editor.getValue().includes('data-draw'), editor.getValue());
        }
    }

    // 16. 时间标记菜单：点击标记出现「更新/删除」，更新换成当前时间
    editor.setValue('开始 [[time:create:2026-01-01 00:00:00]] 完成', false);
    // prosemirror-history 500ms 内的连续事务会合并成一个撤销步；
    // 等待断开分组，保证 undo 只撤销菜单动作本身。
    await new Promise((resolve) => setTimeout(resolve, 600));
    const markerEl = container.querySelector('.md-time-marker');
    check('time marker rendered', Boolean(markerEl));
    if (markerEl) {
        markerEl.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const timeMenu = document.body.querySelector('.time-marker-menu');
        const updateBtn = [...(timeMenu?.querySelectorAll('button') || [])].find(b => b.textContent.includes('更新'));
        const deleteBtn = [...(timeMenu?.querySelectorAll('button') || [])].find(b => b.textContent.includes('删除'));
        check('time marker menu shows update/delete', Boolean(updateBtn) && Boolean(deleteBtn));
        if (updateBtn) {
            updateBtn.click();
            await new Promise((resolve) => setTimeout(resolve, 30));
            const updated = editor.getValue();
            check('time marker updated to now', /\[\[time:update(@\d+)?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\] 完成/.test(updated), updated);
            editor.editor.commands.undo();
            check('time update undoable', editor.getValue().includes('[[time:create:2026-01-01 00:00:00]]'), editor.getValue());
        }
        // 删除（先重新点击弹出菜单；等待断开 history 分组）
        await new Promise((resolve) => setTimeout(resolve, 600));
        // 更新动作后 PM 重绘节点，必须重新查询当前渲染的标记元素
        // （真实用户点击的始终是最新 DOM）。
        const markerEl2 = container.querySelector('.md-time-marker');
        markerEl2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const timeMenu2 = document.body.querySelector('.time-marker-menu');
        const deleteBtn2 = [...(timeMenu2?.querySelectorAll('button') || [])].find(b => b.textContent.includes('删除'));
        if (deleteBtn2) {
            deleteBtn2.click();
            await new Promise((resolve) => setTimeout(resolve, 30));
            check('time marker deleted', !editor.getValue().includes('[[time:'), editor.getValue());
            editor.editor.commands.undo();
            check('time delete undoable', editor.getValue().includes('[[time:create:2026-01-01 00:00:00]]'), editor.getValue());
        }
    }
    // 17. 批注徽标（显示层）+ 点徽标看批注内容（旧 Vditor 行为）
    const annoSource = '前 <span data-note="测试批注" style="text-decoration:underline wavy #e74c3c;text-decoration-thickness:2.5px;">批注文字</span>后';
    editor.setValue(annoSource, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const annoEl = container.querySelector('.has-annotation');
    const badgeEls = container.querySelectorAll('.has-annotation > .annotation-badge');
    check('annotation renders one bubble badge', badgeEls.length === 1, `found ${badgeEls.length}`);
    // 直接读属性而不是用 [viewBox=…] 选择器：jsdom 的属性名大小写处理与浏览器不同，
    // 选择器会假失败；断言的真实对象是徽标里的 svg 本身。
    const badgeSvg = badgeEls[0]?.querySelector('svg');
    check('badge carries the bubble svg', badgeSvg?.getAttribute('viewBox') === '0 0 24 24'
        && Boolean(badgeSvg?.querySelector('path')), badgeSvg?.outerHTML);
    check('badge is display-only markup (aria-hidden)', badgeEls[0]?.getAttribute('aria-hidden') === 'true');
    check('wavy underline lives on the inner span', /wavy/.test(annoEl?.querySelector(':scope > span')?.getAttribute('style') || ''), annoEl?.outerHTML);
    const annoSerialized = editor.getValue();
    check('badge never leaks into markdown', !/annotation-badge|<svg/.test(annoSerialized), annoSerialized);

    if (badgeEls[0]) {
        const badgeOpts = { bubbles: true, cancelable: true, view: dom.window };
        badgeEls[0].dispatchEvent(new dom.window.MouseEvent('click', badgeOpts));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const annoPopover = document.body.querySelector('.mark-popover');
        check('badge click opens the comment card', annoPopover.style.display === 'block'
            && annoPopover.classList.contains('comment-only-popover'), annoPopover.className);
        check('comment card shows the note text',
            annoPopover.querySelector('.mark-popover-text')?.textContent === '测试批注',
            annoPopover.querySelector('.mark-popover-text')?.textContent);
        check('comment card shows the bubble icon', Boolean(annoPopover.querySelector('.mark-popover-icon-box svg')));
        check('comment card has no action buttons', !annoPopover.querySelector('.mark-popover-actions'), annoPopover.innerHTML);
        // 徽标在 contenteditable 内部，点它必然伴随编辑器 blur：只读卡不能被 blur 收掉。
        editor.editor.view.dom.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('comment card survives editor blur', annoPopover.style.display === 'block', annoPopover.style.display);
        document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: dom.window }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('comment card closes on outside mousedown', annoPopover.style.display === 'none', annoPopover.style.display);

        // 点正文仍是「编辑 / 取消」（原有行为不被徽标抢走）
        annoEl.querySelector('span').dispatchEvent(new dom.window.MouseEvent('click', badgeOpts));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const actionLabels = [...annoPopover.querySelectorAll('button')].map(b => b.textContent).join(',');
        check('body click still shows edit/cancel actions', actionLabels === '编辑,取消', actionLabels);
        check('body click popover is not the read-only card', !annoPopover.classList.contains('comment-only-popover'));
    }

    // 18. 多条批注各自一个徽标
    editor.setValue('<span data-note="甲" style="text-decoration:underline wavy #e74c3c;">一</span>中<span data-note="乙" style="text-decoration:underline wavy #e74c3c;">二</span>', false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('each annotation gets its own badge', container.querySelectorAll('.annotation-badge').length === 2,
        `found ${container.querySelectorAll('.annotation-badge').length}`);

    // 19. 一次画线 / 高亮 == 一个整体。PM 渲染行内 mark 时按 **schema rank 排序取共同
    //     前缀** 决定开闭元素：draw / mdHighlight 用默认 priority 100 时排在 link / bold
    //     之后，一次标记跨链接就被 `<a>` 前后各断一次，序列化再叠加 expelEnclosingWhitespace
    //     把段间空格留在 span 外——刷新后 getMarkRange 只能沿连续段展开，取消一次只去掉
    //     一段。抬到 Link 之上（draw 1090 / mdHighlight 1080，仍低于 annotation 1100）后：
    //     单 span、打字时的取消范围 == 刷新后的取消范围、走真实点击管线取消一次清干净。
    {
        const { getMarkRange } = await import('../public/managers/tiptap-runtime.js');
        const { TextSelection } = global.DumbPadTiptap.PM.state;
        const tip = editor.editor;
        const ranks = Object.keys(tip.state.schema.marks);
        check('mark rank puts annotation outermost, then draw, highlight, above link',
            ranks.indexOf('annotation') < ranks.indexOf('draw')
            && ranks.indexOf('draw') < ranks.indexOf('mdHighlight')
            && ranks.indexOf('mdHighlight') < ranks.indexOf('link'), ranks.join(', '));

        const markWholeParagraph = (name) => {
            const size = tip.state.doc.content.size;
            tip.view.dispatch(tip.state.tr.setSelection(
                TextSelection.create(tip.state.doc, 1, size - 1)));
            tip.chain().setMark(name).run();
        };
        // 与 posRangeForElement 同一算法：每个渲染出的 span → 它的取消范围。
        const cancelRanges = (name, selector) => [...container.querySelectorAll(selector)].map(el => {
            const pos = tip.view.posAtDOM(el, 0);
            const $pos = tip.state.doc.resolve(Math.min(pos + 1, tip.state.doc.content.size));
            const range = getMarkRange($pos, tip.state.schema.marks[name]);
            return range ? `${range.from}-${range.to}` : 'null';
        });

        const onePiece = async ({ title, source, name, selector, expectSegments, expectReloadRanges }) => {
            editor.setValue(source, false);
            markWholeParagraph(name);
            await new Promise((resolve) => setTimeout(resolve, 30));
            const typed = { spans: container.querySelectorAll(selector).length, ranges: cancelRanges(name, selector) };
            const typedValue = editor.getValue();
            editor.setValue(typedValue, false);
            await new Promise((resolve) => setTimeout(resolve, 30));
            const reloaded = { spans: container.querySelectorAll(selector).length, ranges: cancelRanges(name, selector) };
            check(`${title} / ${name}: one whole object while typing`,
                typed.spans === expectSegments, JSON.stringify(typed));
            check(`${title} / ${name}: segments survive reload`,
                reloaded.spans === expectSegments, JSON.stringify(reloaded));
            if (expectReloadRanges) {
                // 已知偏差，与本次抬 priority 无关（改动前后实测值完全相同）：draw 的
                // expelEnclosingWhitespace 会把 run 末尾的空格赶到 span 外，而跨行内代码
                // 时每个 span 都以空格收尾，于是刷新后的取消范围比打字时短一个空格。
                // 钉住实测值，而不是假装它相等。
                check(`${title} / ${name}: reload cancel ranges (enclosing space expelled)`,
                    JSON.stringify(reloaded.ranges) === JSON.stringify(expectReloadRanges),
                    `reloaded ${JSON.stringify(reloaded.ranges)} typed ${JSON.stringify(typed.ranges)}`);
            } else {
                check(`${title} / ${name}: cancel range typing == reload`,
                    JSON.stringify(typed.ranges) === JSON.stringify(reloaded.ranges),
                    `typed ${JSON.stringify(typed.ranges)} vs reloaded ${JSON.stringify(reloaded.ranges)}`);
            }
            check(`${title} / ${name}: reload is idempotent`, editor.getValue() === typedValue, editor.getValue());
            return { typedValue, reloaded };
        };

        await onePiece({ title: 'crossing link', source: '甲 [链接](https://example.com) 丁', name: 'draw', selector: '[data-draw]', expectSegments: 1 });
        await onePiece({ title: 'crossing link', source: '甲 [链接](https://example.com) 丁', name: 'mdHighlight', selector: 'mark.md-mark', expectSegments: 1 });
        await onePiece({ title: 'crossing bold', source: '甲 **粗体** 丁', name: 'draw', selector: '[data-draw]', expectSegments: 1 });
        await onePiece({ title: 'crossing bold', source: '甲 **粗体** 丁', name: 'mdHighlight', selector: 'mark.md-mark', expectSegments: 1 });
        // 已知取舍：行内代码是 code.excluded 的 schema 级禁区（只给 annotation 开了豁免），
        // 跨代码片段仍然分段——代码自己的样式要保留，代价是取消要按段点。这里钉住的是
        // 「分段数在打字与刷新后一致」，不是「变成一段」。
        await onePiece({ title: 'crossing code', source: '甲 `code` 丁', name: 'draw', selector: '[data-draw]', expectSegments: 2, expectReloadRanges: ['1-2', '8-9'] });
        await onePiece({ title: 'crossing code', source: '甲 `code` 丁', name: 'mdHighlight', selector: 'mark.md-mark', expectSegments: 2 });

        // 端到端：刷新后点那个整体 → 取消画线 → 全文再无 data-draw（一次点干净）
        editor.setValue('甲 [链接](https://example.com) 丁', false);
        markWholeParagraph('draw');
        editor.setValue(editor.getValue(), false);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const wholeDrawEl = container.querySelector('[data-draw]');
        check('crossing-link draw renders one span after reload',
            container.querySelectorAll('[data-draw]').length === 1 && Boolean(wholeDrawEl),
            `found ${container.querySelectorAll('[data-draw]').length}`);
        if (wholeDrawEl) {
            const mouseOpts = { bubbles: true, cancelable: true, view: dom.window };
            wholeDrawEl.dispatchEvent(new dom.window.MouseEvent('mousedown', mouseOpts));
            wholeDrawEl.dispatchEvent(new dom.window.MouseEvent('mouseup', mouseOpts));
            wholeDrawEl.dispatchEvent(new dom.window.MouseEvent('click', mouseOpts));
            await new Promise((resolve) => setTimeout(resolve, 30));
            const popover = document.body.querySelector('.mark-popover');
            const cancelBtn = [...(popover?.querySelectorAll('button') || [])].find(b => b.textContent === '取消画线');
            check('one cancel popover for the whole crossing-link draw', Boolean(cancelBtn));
            if (cancelBtn) {
                cancelBtn.click();
                await new Promise((resolve) => setTimeout(resolve, 30));
                check('cancel removes the whole draw in one action',
                    !editor.getValue().includes('data-draw'), editor.getValue());
            }
        }

        // 层次：批注永远在最外层（1100 > 1090），画线跨链接时徽标仍只有一个
        editor.setValue('甲 [链接](https://example.com) 丁', false);
        markWholeParagraph('draw');
        editor.setValue(editor.getValue(), false);
        markWholeParagraph('annotation');
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('annotation stays the outermost mark over draw + link',
            container.querySelectorAll('.has-annotation').length === 1
            && container.querySelectorAll('.annotation-badge').length === 1
            && Boolean(container.querySelector('.has-annotation > span > [data-draw]')),
            container.querySelector('.tiptap')?.innerHTML);

        // 与其他特殊样式共存：mark 组合变化处 DOM 一定分段（`前` / 批注里的 `批注` / `后`
        // 三个 span——这是 PM 的渲染规则，与 rank 无关），但取消范围沿「带该 mark 的相邻
        // 文字」展开会跨过分段，所以三条仍是同一个整体：点任意一段取消，三条一起掉，
        // 批注自身不受影响。
        editor.setValue('前<span data-note="备注" style="text-decoration:underline wavy #e74c3c;">批注</span>后', false);
        markWholeParagraph('draw');
        editor.setValue(editor.getValue(), false);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const drawSegments = [...container.querySelectorAll('[data-draw]')];
        const drawSegmentRanges = new Set(drawSegments.map(el => {
            const pos = tip.view.posAtDOM(el, 0);
            const $pos = tip.state.doc.resolve(Math.min(pos + 1, tip.state.doc.content.size));
            const range = getMarkRange($pos, tip.state.schema.marks.draw);
            return range ? `${range.from}-${range.to}` : 'null';
        }));
        check('draw over an annotation renders as segments but keeps one cancel range',
            drawSegments.length >= 2 && drawSegmentRanges.size === 1,
            `${drawSegments.length} segments, ranges ${JSON.stringify([...drawSegmentRanges])}`);
        const firstSegment = drawSegments[0];
        if (firstSegment) {
            const mouseOpts = { bubbles: true, cancelable: true, view: dom.window };
            firstSegment.dispatchEvent(new dom.window.MouseEvent('mousedown', mouseOpts));
            firstSegment.dispatchEvent(new dom.window.MouseEvent('mouseup', mouseOpts));
            firstSegment.dispatchEvent(new dom.window.MouseEvent('click', mouseOpts));
            await new Promise((resolve) => setTimeout(resolve, 30));
            const mixedPopover = document.body.querySelector('.mark-popover');
            const mixedCancel = [...(mixedPopover?.querySelectorAll('button') || [])].find(b => b.textContent === '取消画线');
            check('a marked segment still offers the draw cancel', Boolean(mixedCancel));
            if (mixedCancel) {
                mixedCancel.click();
                await new Promise((resolve) => setTimeout(resolve, 30));
                const afterMixedCancel = editor.getValue();
                check('cancelling one segment drops the whole draw',
                    !afterMixedCancel.includes('data-draw'), afterMixedCancel);
                check('the underlying annotation survives',
                    afterMixedCancel.includes('data-note="备注"'), afterMixedCancel);
            }
        }
    }

    console.log('');
    if (failures > 0) {
        console.error(`${failures} selection menu checks failed`);
        process.exit(1);
    }
    console.log('tiptap selection menu checks passed');
}

main().catch((error) => {
    console.error('FAIL: unhandled error', error);
    process.exit(1);
});
