/**
 * 编辑器内「非文本元素」的点按夺焦守卫（Tiptap）。
 *
 * 图片、附件胶囊、嵌入媒体卡片、代码块工具条、mermaid 预览图这些元素都是
 * contenteditable 里的装饰性节点：点它们只是想打开各自的菜单，但浏览器的
 * 默认行为会把焦点交给 contenteditable，并**把上一次的光标滚进视野**——
 * 表现就是「光标在文首、滚到底部点一张图，视线被拽回文首」，移动端还会
 * 顺带弹出软键盘。这里在捕获阶段拦掉 mousedown 的默认行为（不夺焦、不
 * 滚光标），click 照常派发，各元素自己的菜单逻辑不受影响；原生播放器
 * （video/audio）与表单控件必须保留默认行为，否则控件点不动。
 *
 * 触屏路径由各元素自己的 pointerdown 处理（preventDefault 会压掉兼容
 * mousedown，见 tiptap-image-interactions.js），这里主要补桌面鼠标这一档。
 */
import { Extension, PM } from './tiptap-runtime.js';

const { Plugin, PluginKey } = PM.state;

export const pointerFocusGuardKey = new PluginKey('dumbpadPointerFocusGuard');

// 装饰性元素：点它们不进入文字编辑，也不该把光标滚进视野。
const CHROME_SELECTOR = [
    'img',
    'a.dumbpad-article-file',
    '.dumbpad-article-media',
    '.dumbpad-code-header',
    '.dumbpad-code-copy',
    '.dumbpad-mermaid-render',
    '.article-upload-card',
].join(',');

// 必须保留浏览器默认行为的元素：原生媒体控件与表单控件。
const NATIVE_CONTROL_SELECTOR = 'video, audio, input, textarea, select, button';

/** 该事件目标是否属于「点它不该夺焦」的装饰性元素。 */
export function isChromePointerTarget(target) {
    if (!target?.closest) return false;
    if (target.closest(NATIVE_CONTROL_SELECTOR)) return false;
    return Boolean(target.closest(CHROME_SELECTOR));
}

export const TiptapPointerFocusGuard = Extension.create({
    name: 'tiptapPointerFocusGuard',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: pointerFocusGuardKey,
                props: {
                    handleDOMEvents: {
                        mousedown: (view, event) => {
                            if (!view.editable) return false;
                            if (event.button !== 0) return false;
                            if (!isChromePointerTarget(event.target)) return false;
                            // 只拦默认行为（不夺焦/不滚光标），不阻断事件本身：
                            // 各元素的 click 菜单与 PM 自己的鼠标管线照旧。
                            event.preventDefault();
                            return false;
                        },
                    },
                },
            }),
        ];
    },
});
