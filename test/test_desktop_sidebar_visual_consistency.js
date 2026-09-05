const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'Assets', 'ios-theme.css'),
    'utf8'
);

const blockStart = css.indexOf('/* Desktop directory and recents intentionally share one visual language.');
const blockEnd = css.indexOf('/* Desktop reading rhythm:', blockStart);
const sidebarStyles = css.slice(blockStart, blockEnd);

assert(blockStart >= 0 && blockEnd > blockStart, 'desktop sidebar consistency block should exist');

const requiredSharedSelectors = [
    '.sidebar-left,\n    body:not(.thoughts-mode) .sidebar-right',
    '.sidebar-left .sidebar-header,\n    body:not(.thoughts-mode) .sidebar-right .sidebar-header',
    '.sidebar-left .sidebar-header h3,\n    body:not(.thoughts-mode) .sidebar-right .sidebar-header h3',
    '.sidebar-left .directory-tree,\n    body:not(.thoughts-mode) .sidebar-right .recent-files-list',
    '.sidebar-left .sidebar-item-wrapper,\n    body:not(.thoughts-mode) .sidebar-right .sidebar-item-wrapper',
    '.sidebar-left .sidebar-item-wrapper.active,\n    body:not(.thoughts-mode) .sidebar-right .sidebar-item-wrapper.active'
];

for (const selector of requiredSharedSelectors) {
    assert(sidebarStyles.includes(selector), `desktop sidebars should share ${selector}`);
}

const headerSelector = 'body:not(.thoughts-mode) .sidebar-left .sidebar-header,\n    body:not(.thoughts-mode) .sidebar-right .sidebar-header {';
const headerStart = sidebarStyles.indexOf(headerSelector);
const headerBlock = sidebarStyles.slice(headerStart, sidebarStyles.indexOf('}', headerStart));
assert(headerStart >= 0, 'shared desktop sidebar header rule should exist');
assert(
    /padding-right:\s*18px;/.test(headerBlock) &&
        /padding-bottom:\s*8px;/.test(headerBlock) &&
        /padding-left:\s*18px;/.test(headerBlock) &&
        !/\bpadding\s*:/.test(headerBlock),
    'shared sidebar headers must preserve the fixed-header top inset instead of resetting it with padding shorthand'
);

assert(
    !sidebarStyles.includes('sidebar-item-wrapper.active::before'),
    'directory selection should not add a side-only marker'
);
assert(
    sidebarStyles.includes('background: rgba(var(--primary-rgb), 0.12);') &&
        sidebarStyles.includes('gap: 4px;') &&
        sidebarStyles.includes('padding: 8px 10px 16px;'),
    'shared desktop sidebars should retain aligned selection color, row gap, and list padding'
);

console.log('Desktop sidebar visual consistency checks passed');
