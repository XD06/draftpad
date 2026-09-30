/**
 * 今日草稿的分页纯函数：把「一页纸能放多少条 44px 行」和「每条草稿实际占几行」
 * 切成页边界，并拉平成一条可左右翻的页序列。
 * 不碰 DOM —— jsdom 量不到高度，所以切分规则在这里单测钉死，行数由 manager 在真实布局里量出来后喂进来。
 */

export const TODAY_DRAFT_LINE_UNIT = 44;

const EMPTY_PAGE = Object.freeze({ index: 0, indexes: [], lines: 0, overflowLines: 0 });

// 整条草稿不跨页：放不下就整体挪到下一页。单条本身超过一页时它独占一页，
// overflowLines 非零即告诉调用方「这一页需要纵向滚动兜底」。
// index 在这里就盖上：按天定位草稿（新增后跳页、搜索跳转）拿的是 pagesByDay，
// 拉平后的序列只再补 day/key/pageCount，两处页码必须是同一个来源。
export function paginateTodayDraftRows(lineCounts, pageLines) {
    const budget = Math.max(1, Math.floor(Number(pageLines) || 1));
    const counts = Array.isArray(lineCounts) ? lineCounts : [];
    const pages = [];
    let indexes = [];
    let lines = 0;
    const flush = () => {
        pages.push({ index: pages.length, indexes, lines, overflowLines: Math.max(0, lines - budget) });
        indexes = [];
        lines = 0;
    };
    counts.forEach((rawLines, index) => {
        const take = Math.max(1, Math.ceil(Number(rawLines) || 1));
        if (indexes.length > 0 && lines + take > budget) flush();
        indexes.push(index);
        lines += take;
    });
    if (indexes.length > 0 || pages.length === 0) flush();
    return pages;
}

// 「日」和「页」拉平成一条时间线：同一天里靠后的页装的是更晚的草稿，
// 所以「右滑=更早、左滑=更新」在跨日与跨页两种边界上语义一致，翻页手势不用分叉。
export function flattenTodayDraftPages({ dayKeys = [], pagesByDay = {} } = {}) {
    const list = [];
    for (const day of dayKeys) {
        const pages = Array.isArray(pagesByDay[day]) && pagesByDay[day].length ? pagesByDay[day] : [EMPTY_PAGE];
        pages.forEach(page => {
            list.push({
                ...page,
                day,
                key: `${day}#${page.index}`,
                pageCount: pages.length
            });
        });
    }
    return list;
}

// 某条草稿（按它在当天序列里的下标）落在哪一页。
export function findTodayDraftPageByRow(pages, rowIndex) {
    return (Array.isArray(pages) ? pages : []).find(page => page.indexes.includes(rowIndex)) || null;
}
