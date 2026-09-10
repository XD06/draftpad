/**
 * Tiptap TaskItem NodeView：复刻官方 DOM（li[data-type=taskItem] > label >
 * input + span、div 内容区）。change 处理不走官方节点的闭包 getPos（真实
 * 应用中其返回值不可靠导致勾选静默丢失），改用 PM view.posAtDOM 从节点
 * 自身 DOM 反查文档位置后 setNodeMarkup。经扩展 addNodeView 挂载，
 * Tiptap 对象参数签名：({ node, view, getPos, decorations, innerDecorations })。
 */
export function buildTaskItemNodeView() {
    return ({ node, view }) => {
        const listItem = document.createElement('li');
        const checkboxWrapper = document.createElement('label');
        const checkboxStyler = document.createElement('span');
        const checkbox = document.createElement('input');
        const content = document.createElement('div');

        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', `Task item checkbox for ${node.textContent || 'empty task item'}`);
        checkboxWrapper.contentEditable = 'false';
        checkbox.addEventListener('mousedown', (event) => event.preventDefault());
        checkbox.addEventListener('change', (event) => {
            const checked = event.target.checked;
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
            view.dispatch(view.state.tr.setNodeMarkup(taskItemPos, null, {
                ...currentNode.attrs,
                checked,
            }));
        });

        listItem.dataset.checked = Boolean(node.attrs.checked);
        checkbox.checked = Boolean(node.attrs.checked);
        checkboxWrapper.append(checkbox, checkboxStyler);
        listItem.append(checkboxWrapper, content);

        return {
            dom: listItem,
            contentDOM: content,
            update(updatedNode) {
                if (updatedNode.type.name !== 'taskItem') return false;
                node = updatedNode;
                listItem.dataset.checked = Boolean(updatedNode.attrs.checked);
                checkbox.checked = Boolean(updatedNode.attrs.checked);
                return true;
            },
            ignoreMutation(mutation) {
                // label/checkbox 的勾选视觉由本节点视图管理
                return mutation.type === 'selection' || mutation.target === checkbox || mutation.type === 'attributes' && mutation.target === checkbox;
            },
        };
    };
}
