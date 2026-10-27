/**
 * Tiptap TaskItem NodeView：复刻官方 DOM（li[data-type=taskItem] > label >
 * input + span、div 内容区）。change 处理不走官方节点的闭包 getPos（真实
 * 应用中其返回值不可靠导致勾选静默丢失），改用 PM view.posAtDOM 从节点
 * 自身 DOM 反查文档位置后 setNodeMarkup。经扩展 addNodeView 挂载，
 * Tiptap 对象参数签名：({ node, view, getPos, decorations, innerDecorations })。
 *
 * 三态（未完成 / 进行中 / 已完成）：`checked` 仍是布尔（写进 markdown 的唯一
 * 状态），`doing` 是节点属性（由解析期的 `- [~] ` 盖章），DOM 上只体现为
 * input 的 `indeterminate` —— 它是运行时状态、不进 markdown，归属只由
 * nodeView 管理。复选框语义与内核保持一致（勾 = 已完成、取消勾 = 未完成），
 * 不把勾选改成三态循环：那样会让「取消勾选」在浏览器里行为反直觉。
 */
export function buildTaskItemNodeView() {
    return ({ node, view }) => {
        const listItem = document.createElement('li');
        const checkboxWrapper = document.createElement('label');
        const checkboxStyler = document.createElement('span');
        const checkbox = document.createElement('input');
        const content = document.createElement('div');

        /** 三态归一化：DOM 上只有 checked / indeterminate 两个布尔。 */
        const syncState = (targetNode) => {
            const checked = Boolean(targetNode?.attrs?.checked);
            const doing = targetNode?.attrs?.doing === true;
            checkbox.checked = checked;
            checkbox.indeterminate = doing && !checked;
            listItem.dataset.checked = checked;
            listItem.dataset.doing = doing && !checked ? 'true' : 'false';
        };

        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', `Task item checkbox for ${node.textContent || 'empty task item'}`);
        checkboxWrapper.contentEditable = 'false';
        checkbox.addEventListener('mousedown', (event) => event.preventDefault());
        checkbox.addEventListener('change', () => {
            // 节点视图可能因文档重建导致位置闭包失效，从当前 DOM 反查
            // taskItem 的活文档位置再 setNodeMarkup，保证勾选写入文档。
            const $pos = view.state.doc.resolve(view.posAtDOM(listItem, 0));
            let taskItemPos = -1;
            for (let depth = $pos.depth; depth > 0; depth -= 1) {
                if ($pos.node(depth).type.name === 'taskItem') {
                    taskItemPos = $pos.before(depth);
                    break;
                }
            }
            if (taskItemPos < 0) return;
            const currentNode = view.state.doc.nodeAt(taskItemPos);
            if (!currentNode || currentNode.type.name !== 'taskItem') return;
            // 与内核复选框正交：勾上 = 已完成；从已完成 / 进行中取消勾 = 回未完成
            // （浏览器把 indeterminate 的勾去掉后是未勾选，不去猜「回进行中」）。
            view.dispatch(view.state.tr.setNodeMarkup(taskItemPos, null, {
                ...currentNode.attrs,
                checked: checkbox.checked,
                doing: false,
            }));
        });

        syncState(node);
        checkboxWrapper.append(checkbox, checkboxStyler);
        listItem.append(checkboxWrapper, content);

        return {
            dom: listItem,
            contentDOM: content,
            update(updatedNode) {
                if (updatedNode.type.name !== 'taskItem') return false;
                node = updatedNode;
                syncState(updatedNode);
                checkbox.setAttribute('aria-label', `Task item checkbox for ${updatedNode.textContent || 'empty task item'}`);
                return true;
            },
            ignoreMutation(mutation) {
                // label/checkbox 的勾选视觉由本节点视图管理
                return mutation.type === 'selection' || mutation.target === checkbox || mutation.type === 'attributes' && mutation.target === checkbox;
            },
        };
    };
}
