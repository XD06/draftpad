/**
 * 混排列表解析回归（DumbPadMixedTaskListGuard）：`- 甲` 与 `- [ ] 乙` 同列表时，
 * markdown-it 输出单个 ul.contains-task-list，tiptap-markdown 原本会整条盖
 * data-type="taskList" 章——普通 li 塞不进 taskList 的 taskItem+ 内容模型，PM 装配
 * 凭空吐出一个空 taskItem（页面上多一个空待办），保存还会把它固化成 `- [ ] ` 源码。
 * 守卫把混排列表的章撤掉：普通项走 bulletList、任务项由 PM 在块边界拆出独立 taskList，
 * 与刷新后重新解析的结果一致。纯任务列表行为必须原样保留。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Range = dom.window.Range;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.getSelection = dom.window.getSelection.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = () => {};
}
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) console.log(`PASS ${name}`);
    else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
};

async function main() {
    const { HybridMarkdownEditor } = await import(pathToFileURL(path.join(ROOT, 'public/tiptap-editor.js')).href);

    const makeEditor = async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const wrapper = new HybridMarkdownEditor(container, {});
        await wrapper.whenReady();
        /** 顶层块清单：列表摊平成 [type, items]，item 记录文本与勾选态。
         * 末尾的空段落是 StarterKit TrailingNode 的既有行为（文档末块非段落时补一个，
         * 对首次 parse 的生效时机有惰性），markdown 序列化里不可见，比较时归一化掉。 */
        const structure = () => {
            const out = [];
            wrapper.editor.state.doc.forEach((node) => {
                if (node.type.name === 'bulletList' || node.type.name === 'orderedList' || node.type.name === 'taskList') {
                    const items = [];
                    node.forEach((item) => {
                        items.push({
                            type: item.type.name,
                            checked: item.type.name === 'taskItem' ? Boolean(item.attrs.checked) : null,
                            text: item.textContent,
                        });
                    });
                    out.push({ list: node.type.name, items });
                } else {
                    out.push({ block: node.type.name, text: node.textContent });
                }
            });
            const last = out[out.length - 1];
            if (last && last.block === 'paragraph' && last.text === '') out.pop();
            return out;
        };
        const findEmptyTaskItems = () => {
            const empty = [];
            wrapper.editor.state.doc.descendants((node) => {
                if ((node.type.name === 'taskItem' || node.type.name === 'listItem')
                    && !node.textContent.trim()) empty.push(node.type.name);
                return true;
            });
            return empty;
        };
        return { wrapper, structure, findEmptyTaskItems };
    };

    /* 1. 用户实际踩到的源码：宽松混排（空行分隔），普通项打头 */
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        const source = '1. 有序列表测试\n\n- 无序列表测试\n\n- [ ] 待办测试';
        wrapper.setValue(source, false);
        check('loose mixed: no phantom empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('loose mixed: ordered, bullet and task lists stay separate', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'orderedList', items: [{ type: 'listItem', checked: null, text: '有序列表测试' }] },
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '无序列表测试' }] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '待办测试' }] },
            ]), structure());
        const out = wrapper.getValue();
        check('loose mixed: serialize matches the source byte for byte', out === source, out);
        wrapper.setValue(out, false);
        check('loose mixed: reload keeps the same structure', JSON.stringify(structure()) === JSON.stringify([
            { list: 'orderedList', items: [{ type: 'listItem', checked: null, text: '有序列表测试' }] },
            { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '无序列表测试' }] },
            { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '待办测试' }] },
        ]), structure());
        check('loose mixed: serialize is idempotent', wrapper.getValue() === source, wrapper.getValue());
    }

    /* 1b. 任务项打头的宽松混排（第二种真实踩到形状）：任务项归位，普通项拆出，
     * 不再出现空圆点（幽灵 listItem），序列化逐字节回源 */
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        const source = '- [ ] 你哈\n\n- 测试列表\n\n- [ ] 测试待办';
        wrapper.setValue(source, false);
        check('task-first loose: no phantom empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('task-first loose: task, bullet, task in source order', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '你哈' }] },
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '测试列表' }] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '测试待办' }] },
            ]), structure());
        const out = wrapper.getValue();
        check('task-first loose: serialize matches the source byte for byte', out === source, out);
        wrapper.setValue(out, false);
        check('task-first loose: reload keeps the same structure', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '你哈' }] },
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '测试列表' }] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '测试待办' }] },
            ]), structure());
        check('task-first loose: serialize is idempotent', wrapper.getValue() === source, wrapper.getValue());
    }

    /* 1c. 用户报告的完整原文（有序列表 + 任务项打头混排），整篇逐字节回源 */
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        const source = '1. 这是一个测试\n2. fehiu1\n\n- [ ] 你哈\n\n- 测试列表\n\n- [ ] 测试待办';
        wrapper.setValue(source, false);
        check('reported article: no phantom empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('reported article: structure stays in source order', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'orderedList', items: [
                    { type: 'listItem', checked: null, text: '这是一个测试' },
                    { type: 'listItem', checked: null, text: 'fehiu1' },
                ] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '你哈' }] },
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '测试列表' }] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '测试待办' }] },
            ]), structure());
        check('reported article: serialize matches the source byte for byte',
            wrapper.getValue() === source, wrapper.getValue());
    }

    /* 1d. 任务项打头 + 交替混排（紧凑）：按连续段拆分，任何交错都不产生幽灵节点 */
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        wrapper.setValue('- [ ] 甲\n- 乙', false);
        check('task-first tight: no phantom empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('task-first tight: task then bullet', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '甲' }] },
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '乙' }] },
            ]), structure());
        const saved = wrapper.getValue();
        check('task-first tight: split lists serialize with a block gap', saved === '- [ ] 甲\n\n- 乙', saved);
    }
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        wrapper.setValue('- [ ] 甲\n- 乙\n- [ ] 丙', false);
        check('alternating: no phantom empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('alternating: three runs split in source order', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '甲' }] },
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '乙' }] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '丙' }] },
            ]), structure());
        check('alternating: serialize keeps every item', wrapper.getValue() === '- [ ] 甲\n\n- 乙\n\n- [ ] 丙',
            wrapper.getValue());
    }

    /* 2. 紧凑混排（无空行）。PM 的列表节点装不下混排项，拆成两个列表后序列化在块间
     * 写一个空行——拆分表示法的固有代价：首次保存后源码多一个空行，之后逐字节幂等，
     * 结构与渲染不变、无数据丢失。 */
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        wrapper.setValue('- 乙\n- [ ] 丙', false);
        check('tight mixed: no phantom empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('tight mixed: bullet item and task item split at the block boundary', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '乙' }] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '丙' }] },
            ]), structure());
        const saved = wrapper.getValue();
        check('tight mixed: split lists serialize with a block gap', saved === '- 乙\n\n- [ ] 丙', saved);
        wrapper.setValue(saved, false);
        check('tight mixed: converge after one save', wrapper.getValue() === saved
            && JSON.stringify(structure()) === JSON.stringify([
                { list: 'bulletList', items: [{ type: 'listItem', checked: null, text: '乙' }] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '丙' }] },
            ]), { md: wrapper.getValue(), structure: structure() });
    }

    /* 3. 纯任务列表：守卫不能碰它（这是最高频的存量路径） */
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        const source = '- [ ] 待办一\n- [x] 已完成';
        wrapper.setValue(source, false);
        check('pure task list: no empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('pure task list: both items parsed with checked state', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'taskList', items: [
                    { type: 'taskItem', checked: false, text: '待办一' },
                    { type: 'taskItem', checked: true, text: '已完成' },
                ] },
            ]), structure());
        check('pure task list: serialize matches the source', wrapper.getValue() === source, wrapper.getValue());
    }

    /* 4. 普通项在前、任务项在后且普通项多条：拆分后各自完整（同用例 2 的空行代价） */
    {
        const { wrapper, structure, findEmptyTaskItems } = await makeEditor();
        wrapper.setValue('- 甲\n- 乙\n- [ ] 丙', false);
        check('multi plain items: no phantom empty item', findEmptyTaskItems().length === 0, findEmptyTaskItems());
        check('multi plain items: split keeps every item', JSON.stringify(structure())
            === JSON.stringify([
                { list: 'bulletList', items: [
                    { type: 'listItem', checked: null, text: '甲' },
                    { type: 'listItem', checked: null, text: '乙' },
                ] },
                { list: 'taskList', items: [{ type: 'taskItem', checked: false, text: '丙' }] },
            ]), structure());
        const saved = wrapper.getValue();
        check('multi plain items: split lists serialize with a block gap', saved === '- 甲\n- 乙\n\n- [ ] 丙', saved);
        // 空行落进列表内部后 markdown-it 把整条列表当宽松列表，第二轮起逐字节稳定
        wrapper.setValue(saved, false);
        const converged = wrapper.getValue();
        check('multi plain items: converges after the second save',
            converged === '- 甲\n\n- 乙\n\n- [ ] 丙', converged);
        wrapper.setValue(converged, false);
        check('multi plain items: stable from there on', wrapper.getValue() === converged, wrapper.getValue());
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll mixed task list checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
