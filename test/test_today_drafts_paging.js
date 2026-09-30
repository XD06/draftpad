/**
 * 当日草稿分页纯函数的回归：页边界怎么切、超长单条怎么独占一页、
 * 「日」与「页」如何拉平成一条左右滑语义一致的时间线。
 */
const assert = require('assert');

async function run() {
    const {
        TODAY_DRAFT_LINE_UNIT,
        findTodayDraftPageByRow,
        flattenTodayDraftPages,
        paginateTodayDraftRows
    } = await import('../public/managers/today-drafts/today-drafts-paging.js');

    assert.strictEqual(TODAY_DRAFT_LINE_UNIT, 44, 'the paging budget is counted in ruled lines');

    // 1. 一页放得下就不切
    {
        const pages = paginateTodayDraftRows([1, 1, 2], 13);
        assert.strictEqual(pages.length, 1);
        assert.deepStrictEqual(pages[0].indexes, [0, 1, 2]);
        assert.strictEqual(pages[0].lines, 4);
        assert.strictEqual(pages[0].overflowLines, 0);
    }

    // 2. 整条搬走，绝不把一条草稿劈成两半
    {
        const pages = paginateTodayDraftRows([1, 1, 2, 1], 3);
        assert.deepStrictEqual(pages.map(page => page.indexes), [[0, 1], [2, 3]], 'a 2-line draft never starts at the last ruled line');
        assert.deepStrictEqual(pages.map(page => page.lines), [2, 3]);
        assert.deepStrictEqual(pages.map(page => page.overflowLines), [0, 0]);
    }

    // 3. 单条比一页还高：独占一页并报告超出行数，调用方据此打开纵向滚动
    {
        const pages = paginateTodayDraftRows([1, 5, 1], 3);
        assert.deepStrictEqual(pages.map(page => page.indexes), [[0], [1], [2]]);
        assert.strictEqual(pages[1].lines, 5);
        assert.strictEqual(pages[1].overflowLines, 2, 'the oversized row reports how far it hangs off the sheet');
        assert.strictEqual(pages[0].overflowLines, 0);
        assert.strictEqual(pages[2].overflowLines, 0);
    }

    // 4. 页码在切分时就得盖上：按天定位草稿（新增跳页、搜索跳转）读的是 pagesByDay，
    //    拉平之前也要能 page.index 直接拿到页码
    {
        const pages = paginateTodayDraftRows([1, 5, 1], 3);
        assert.deepStrictEqual(pages.map(page => page.index), [0, 1, 2], 'each page carries its own index before flattening');
        assert.strictEqual(findTodayDraftPageByRow(pages, 1).index, 1, 'row → page lookup works on a day\'s raw pages');
    }

    // 5. 空的一天仍然是一页，否则这天在翻页序列里直接消失
    {
        const pages = paginateTodayDraftRows([], 13);
        assert.strictEqual(pages.length, 1);
        assert.deepStrictEqual(pages[0].indexes, []);
        assert.strictEqual(pages[0].lines, 0);
    }

    // 6. 量不到纸高时调用方传 Infinity：整日一页，宁可滚也不要按假数据打散
    {
        const pages = paginateTodayDraftRows([1, 1, 1], Number.POSITIVE_INFINITY);
        assert.strictEqual(pages.length, 1);
        assert.deepStrictEqual(pages[0].indexes, [0, 1, 2]);
        assert.strictEqual(pages[0].overflowLines, 0);
    }

    // 7. 脏行数至少算一条纸纹，2.4 行按 3 条预留
    {
        const pages = paginateTodayDraftRows([0, NaN, 2.4], 3);
        assert.deepStrictEqual(pages.map(page => page.indexes), [[0, 1], [2]]);
        assert.deepStrictEqual(pages.map(page => page.lines), [2, 3]);
    }

    // 8. 日与页拉平成一条时间线：页序紧跟所属日
    {
        const pages = flattenTodayDraftPages({
            dayKeys: ['2026-09-28', '2026-09-29', '2026-09-30'],
            pagesByDay: {
                '2026-09-28': paginateTodayDraftRows([1], 13),
                '2026-09-29': [],
                '2026-09-30': paginateTodayDraftRows([9, 9, 9], 10)
            }
        });
        assert.deepStrictEqual(pages.map(page => page.key), [
            '2026-09-28#0',
            '2026-09-29#0',
            '2026-09-30#0',
            '2026-09-30#1',
            '2026-09-30#2'
        ], 'later pages of the same day come after it, so 右滑=更早 / 左滑=更新 never forks');
        assert.deepStrictEqual(pages.map(page => page.pageCount), [1, 1, 3, 3, 3]);
        assert.deepStrictEqual(pages.map(page => page.index), [0, 0, 0, 1, 2]);
        assert.deepStrictEqual(pages[1].indexes, [], 'an empty day still contributes one flippable sheet');
        assert.deepStrictEqual(pages[2].indexes, [0], '今天第一页只装得下第一条');

        assert.strictEqual(findTodayDraftPageByRow(pagesByDayOf(pages, '2026-09-30'), 1).index, 1);
        assert.strictEqual(findTodayDraftPageByRow(pagesByDayOf(pages, '2026-09-30'), 99), null);
        assert.strictEqual(findTodayDraftPageByRow(undefined, 0), null);
    }

    console.log('Today drafts paging checks passed');
}

function pagesByDayOf(pages, day) {
    return pages.filter(page => page.day === day);
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
