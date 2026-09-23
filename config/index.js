/**
 * Configuration module for DumbPad
 * Centralizes environment variable access and configuration settings
 */

const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || false;
const TRUSTED_PROXY_IPS = process.env.TRUSTED_PROXY_IPS || '';

// 悬浮功能按钮的隐藏名单（黑名单）：列出的按钮不显示，但 DOM 与事件绑定原样保留，
// 改回配置就能放出来，不需要动代码。当前默认收起「快速记录（剪贴板）」入口，
// 让「反思」按钮显示出来（反思页面还没实现，点击只会提示开发中）。
// 显式设置 DUMBPAD_HIDDEN_FLOATING_ACTIONS 会整体替换默认值；设置成空字符串表示
// 「什么都不隐藏」（两个按钮都显示）。
const DEFAULT_HIDDEN_FLOATING_ACTIONS = 'clipboard-import-trigger';

/**
 * 只做语法层面的解析（拆分 / 去空白 / 转小写 / 去重）。按钮 id 是否合法不在这里判断：
 * 哪些是功能入口、哪些是壳子必需的按钮只有前端知道（见
 * public/managers/floating-actions-config.js 的清单），服务端不重复维护一份。
 */
function parseHiddenFloatingActions(value) {
    const raw = value === undefined || value === null
        ? DEFAULT_HIDDEN_FLOATING_ACTIONS
        : String(value);
    return [...new Set(raw
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean))];
}

const HIDDEN_FLOATING_ACTIONS = parseHiddenFloatingActions(process.env.DUMBPAD_HIDDEN_FLOATING_ACTIONS);

module.exports = {
    TRUST_PROXY,
    TRUSTED_PROXY_IPS,
    DEFAULT_HIDDEN_FLOATING_ACTIONS,
    parseHiddenFloatingActions,
    HIDDEN_FLOATING_ACTIONS,
};
