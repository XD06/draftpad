/**
 * 悬浮功能按钮的显示配置：服务端 /api/config 下发 hiddenFloatingActions（黑名单），
 * 这里把它落到 DOM 上——只切 hidden 属性，不删除节点、不解绑事件，所以把功能从配置里
 * 去掉就立刻回来，不需要改代码。可配置的按钮清单以本文件为唯一来源：哪些是功能入口、
 * 哪些是壳子必需的，只有持有 DOM 的前端知道，服务端只负责传字符串列表。
 */

/** 允许通过配置隐藏的功能按钮（顺序与 index.html 的 .floating-actions 一致）。 */
export const CONFIGURABLE_FLOATING_ACTIONS = [
    'toggle-article-toc',
    'copy-all',
    'toggle-today-drafts',
    'clipboard-import-trigger',
    'toggle-reflections',
    'toggle-thoughts',
];

/**
 * 不允许隐藏的按钮：fab-toggle-group 是移动端「更多」折叠器，藏掉它整组就展不开了；
 * scroll-helper 是滚到顶/底的主入口。配置里出现这两个 id 会被忽略并回报。
 */
export const ALWAYS_VISIBLE_FLOATING_ACTIONS = [
    'fab-toggle-group',
    'scroll-helper',
];

/**
 * @param {Document} doc 目标 document（测试里传 jsdom 的 document）
 * @param {string[]|undefined|null} hiddenFloatingActions 黑名单；非数组（配置没到 /
 *        拉取失败 / 离线）时什么都不做，保持 index.html 里的初始状态
 * @returns {{hidden: string[], shown: string[], ignored: Array<{id: string, reason: string}>}}
 *          实际隐藏、实际显示、以及被丢弃的条目（供调用方打日志）
 */
export function applyFloatingActionsVisibility(doc, hiddenFloatingActions) {
    const result = { hidden: [], shown: [], ignored: [] };
    if (!Array.isArray(hiddenFloatingActions)) return result;
    const wanted = new Set(hiddenFloatingActions
        .map(id => String(id || '').trim().toLowerCase())
        .filter(Boolean));
    for (const id of wanted) {
        if (ALWAYS_VISIBLE_FLOATING_ACTIONS.includes(id)) result.ignored.push({ id, reason: 'protected' });
        else if (!CONFIGURABLE_FLOATING_ACTIONS.includes(id)) result.ignored.push({ id, reason: 'unknown' });
    }
    for (const id of CONFIGURABLE_FLOATING_ACTIONS) {
        const button = doc.getElementById?.(id);
        if (!button) {
            result.ignored.push({ id, reason: 'missing-in-dom' });
            continue;
        }
        const hide = wanted.has(id);
        button.hidden = hide;
        (hide ? result.hidden : result.shown).push(id);
    }
    return result;
}
