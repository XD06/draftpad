const assert = require('assert');
const {
    splitKeywords,
    documentMatches,
    findLineOccurrences,
    sortOccurrences,
    detectBlockType,
    buildSnippet,
    createSectionMapper,
    rankSearchResults
} = require('../server/search/matcher.js');
const { createSearchRegistry } = require('../server/search/registry.js');
const { createNotepadSearchProvider } = require('../server/search/providers/notepad-provider.js');
const { createThoughtSearchProvider, buildThoughtLines } = require('../server/search/providers/thought-provider.js');
const { createTodayDraftSearchProvider, dayWindowKeys, dayLabel } = require('../server/search/providers/today-draft-provider.js');

function localDayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function run(name, fn) {
    try {
        await fn();
        console.log(`  ok - ${name}`);
    } catch (error) {
        console.error(`  FAIL - ${name}`);
        throw error;
    }
}

async function runAll() {
    console.log('[matcher]');

    await run('splitKeywords: 空白分词、小写化、上限 8 个、空查询为空数组', () => {
        assert.deepStrictEqual(splitKeywords('  API   回归 Test '), ['api', '回归', 'test']);
        assert.deepStrictEqual(splitKeywords(''), []);
        assert.deepStrictEqual(splitKeywords('   \t\n '), []);
        assert.strictEqual(splitKeywords('a b c d e f g h i j').length, 8);
    });

    await run('documentMatches: 多关键词 AND，标题/正文/标签任一位置出现即可', () => {
        const doc = { title: '发布清单', content: '检查部署脚本', tags: ['release'] };
        assert.strictEqual(documentMatches(doc, ['发布', '部署']), true, 'keyword split across fields should match');
        assert.strictEqual(documentMatches(doc, ['发布', '缺失词']), false, 'one missing keyword should fail the AND');
        assert.strictEqual(documentMatches(doc, []), true, 'empty keywords trivially match');
    });

    await run('findLineOccurrences: 按行聚合、行内计数、limit/totalMatches/truncated', () => {
        const lines = ['第一行提到苹果', '无命中', '苹果和苹果都在第三行', '苹果在第四行'];
        const { occurrences, totalMatches, truncated } = findLineOccurrences(
            lines.map(text => ({ text })),
            ['苹果'],
            { limit: 2 }
        );
        assert.strictEqual(totalMatches, 3, 'three lines contain the keyword');
        assert.strictEqual(truncated, true, 'capped beyond limit');
        assert.strictEqual(occurrences.length, 2);
        assert.strictEqual(occurrences[0].line, 0);
        assert.strictEqual(occurrences[0].matchCount, 1);
        assert.strictEqual(occurrences[0].hitIndex, 0, 'first hit line carries global hit index 0');
        assert.strictEqual(occurrences[1].line, 2);
        assert.strictEqual(occurrences[1].matchCount, 2, 'two hits on one line count twice');
        assert.strictEqual(occurrences[1].hitIndex, 1, 'hit index counts line 0 first');
        assert.strictEqual(occurrences[1].lineText, '苹果和苹果都在第三行');
        const uncapped = findLineOccurrences(lines.map(text => ({ text })), ['苹果']);
        assert.strictEqual(uncapped.truncated, false);
        assert.strictEqual(uncapped.occurrences.length, 3);
    });

    await run('findLineOccurrences: hitIndex 跨行累计，围栏内行标注 code 且仍可搜索', () => {
        const lines = [
            '## 苹果标题',
            '苹果第一行',
            '```bash',
            '苹果在代码块里',
            '苹果第二次',
            '```',
            '- [ ] 苹果待办项'
        ];
        const { occurrences } = findLineOccurrences(lines.map(text => ({ text })), ['苹果']);
        assert.strictEqual(occurrences.length, 5, 'fenced code lines stay searchable');
        assert.strictEqual(occurrences[0].hitIndex, 0);
        assert.strictEqual(occurrences[0].block.type, 'heading');
        assert.strictEqual(occurrences[0].block.level, 2, 'heading block carries its level');
        assert.strictEqual(occurrences[1].block.type, 'text', 'plain body line carries no badge');
        assert.strictEqual(occurrences[2].block.type, 'code', 'lines inside a fence are labeled code');
        assert.strictEqual(occurrences[2].hitIndex, 2, 'global hit index spans fenced lines');
        assert.strictEqual(occurrences[4].block.type, 'todo', 'todo marker yields the todo badge');
    });

    await run('sortOccurrences: 同时命中更多不同关键词的行优先，其次命中数，最后行序', () => {
        const lines = ['只有优化', '性能的优化，加载优化', '优化在前', '性能优化一起出现'];
        const { occurrences } = findLineOccurrences(lines.map(text => ({ text })), ['性能', '优化']);
        const sorted = sortOccurrences(occurrences);
        assert.strictEqual(sorted[0].line, 1, 'the line containing BOTH keywords with more hits ranks first');
        assert.strictEqual(sorted[0].distinctKeywords, 2);
        assert.strictEqual(sorted[1].line, 3, 'the other both-keywords line follows');
        assert.deepStrictEqual(sorted.slice(2).map(item => item.line), [0, 2], 'single-keyword lines keep document order among ties');
    });

    await run('detectBlockType: 标题级别/待办/列表/引用/普通文本', () => {
        assert.deepStrictEqual(detectBlockType('### 三级'), { type: 'heading', level: 3 });
        assert.deepStrictEqual(detectBlockType('- [x] 已完成'), { type: 'todo' });
        assert.deepStrictEqual(detectBlockType('1. 有序'), { type: 'list' });
        assert.deepStrictEqual(detectBlockType('- 无序'), { type: 'list' });
        assert.deepStrictEqual(detectBlockType('> 引用'), { type: 'quote' });
        assert.deepStrictEqual(detectBlockType('普通段落'), { type: 'text' });
        assert.deepStrictEqual(detectBlockType('print(1)', true), { type: 'code' });
    });

    await run('findLineOccurrences: sectionFor 标注每个命中行', () => {
        const content = ['## 安装', '运行 npm install', '正文'].join('\n');
        const sectionFor = createSectionMapper(content);
        const { occurrences } = findLineOccurrences(
            content.split('\n').map(text => ({ text })),
            ['npm'],
            { sectionFor }
        );
        assert.strictEqual(occurrences[0].section, '安装');
    });

    await run('buildSnippet: 命中窗口与旧字段兼容', () => {
        const text = '前缀占位文字'.repeat(5) + '目标关键词' + '后缀占位文字'.repeat(12);
        const { snippet, snippetStart, snippetPrefixLength } = buildSnippet(text, ['目标关键词']);
        assert(snippet.includes('目标关键词'), 'snippet contains the keyword');
        assert(snippet.startsWith('...'), 'mid-document hit gets a leading ellipsis');
        assert(snippet.endsWith('...'));
        assert.strictEqual(snippetPrefixLength, 3);
        assert(Number.isFinite(snippetStart));
        const head = buildSnippet('短内容', ['不存在的词']);
        assert.strictEqual(head.snippet, '短内容');
    });

    await run('createSectionMapper: 围栏内的 # 不是章节，取最近的围栏外标题', () => {
        const content = [
            '# 真标题',
            '```bash',
            '# 注释，不是章节',
            'npm run target',
            '```',
            '目标词在围栏后',
            '## 第二节',
            '又见目标词'
        ].join('\n');
        const sectionFor = createSectionMapper(content);
        const lines = content.split('\n');
        const hitFence = findLineOccurrences(lines.map(text => ({ text })), ['target'], { sectionFor });
        assert.strictEqual(hitFence.occurrences[0].section, '真标题', 'fenced line maps to the enclosing real heading, never the # comment');
        const hitAfter = findLineOccurrences(lines.map(text => ({ text })), ['目标词'], { sectionFor });
        assert.strictEqual(hitAfter.occurrences[0].section, '真标题');
        assert.strictEqual(hitAfter.occurrences[1].section, '第二节');
        const beforeFirst = findLineOccurrences(['开头目标词', '# 标题', '目标词'].map(text => ({ text })), ['目标词'], { sectionFor: createSectionMapper('开头目标词\n# 标题\n目标词') });
        assert.strictEqual(beforeFirst.occurrences[0].section, null, 'line before the first heading has no section');
        assert.strictEqual(beforeFirst.occurrences[1].section, '标题');
    });

    await run('rankSearchResults: 标题 > 双词同行数 > 命中数 > 更新时间，并截断', () => {
        const ranked = rankSearchResults([
            { matchType: 'content', matchCount: 20, coLineCount: 0, updatedAt: 30 },
            { matchType: 'title', matchCount: 1, coLineCount: 0, updatedAt: 10 },
            { matchType: 'content', matchCount: 2, coLineCount: 2, updatedAt: 5 },
            { matchType: 'content', matchCount: 9, coLineCount: 0, updatedAt: 20 }
        ], 4);
        assert.deepStrictEqual(ranked.map(item => item.updatedAt), [10, 5, 30, 20],
            'title first, then coLineCount desc, then matchCount desc');
        assert.strictEqual(ranked.length, 4);
    });

    console.log('[notepad provider]');

    const corpus = [
        { id: 'n1', type: 'notepad', title: '运维手册', content: '## 步骤\n运行部署脚本\n检查部署结果\n回滚部署', tags: [], updatedAt: 100 },
        { id: 'n2', type: 'notepad', title: '部署 脚本 集合', content: '无关内容', tags: [], updatedAt: 50 },
        { id: 'n3', type: 'notepad', title: '旅行清单', content: '完全不相关', tags: [], updatedAt: 99 },
        { id: 't1', type: 'thought', title: 'thought 不会出现在 notepad 结果', content: '部署', tags: [], updatedAt: 200 }
    ];
    const notepadProvider = createNotepadSearchProvider({ getCorpus: async () => corpus });

    await run('多关键词 AND：单词命中的文档被排除，跨标题/正文命中的保留', async () => {
        const results = await notepadProvider.search(['部署', '回滚']);
        assert.strictEqual(results.length, 1, 'only n1 contains both keywords (n2 lacks 回滚)');
        assert.strictEqual(results[0].id, 'n1');
        assert.strictEqual(results[0].type, 'notepad');
        assert.strictEqual(results[0].matchType, 'content');
        assert.strictEqual(results[0].occurrences.length, 3, '部署脚本 / 部署结果 / 回滚部署 lines');
        assert.strictEqual(results[0].occurrences[0].line, 3, 'the line with BOTH keywords (回滚部署) ranks first');
        assert.strictEqual(results[0].occurrences[0].section, '步骤');
        assert.strictEqual(results[0].matchCount, 3);
        assert.strictEqual(results[0].coLineCount, 1, 'one line contains every keyword');
        const crossField = await notepadProvider.search(['集合', '无关']);
        assert.deepStrictEqual(crossField.map(item => item.id), ['n2'], 'one keyword in title, the other in content still AND-matches');
    });

    await run('标题命中优先且 matchType=title', async () => {
        const results = await notepadProvider.search(['部署', '脚本']);
        assert.deepStrictEqual(results.map(item => item.id), ['n2', 'n1'], 'title-matching n2 ranks first');
        assert.strictEqual(results[0].matchType, 'title');
        assert.strictEqual(results[0].matchCount, 1, 'title hit counts as one match');
        assert.strictEqual(results[1].matchType, 'content');
        const byTitle = await notepadProvider.search(['集合']);
        assert.strictEqual(byTitle[0].matchType, 'title');
    });

    await run('排序：标题命中在前、命中数多在前、新更新在前', async () => {
        const results = await notepadProvider.search(['部署']);
        assert.deepStrictEqual(results.map(item => item.id), ['n2', 'n1'], 'title match n2 first, then n1 with more content hits');
    });

    await run('occurrences 截断：超过 50 行命中时标记 truncated 且 matchCount 是真实总数', async () => {
        const bigContent = Array.from({ length: 60 }, (_, i) => `命中行 ${i} 关键词x`).join('\n');
        const provider = createNotepadSearchProvider({
            getCorpus: async () => [{ id: 'big', type: 'notepad', title: '大文章', content: bigContent, tags: [], updatedAt: 1 }]
        });
        const [result] = await provider.search(['关键词x']);
        assert.strictEqual(result.occurrences.length, 50);
        assert.strictEqual(result.occurrencesTruncated, true);
        assert.strictEqual(result.matchCount, 60, 'matchCount reflects uncapped total');
    });

    console.log('[thought provider]');

    await run('buildThoughtLines: 正文行、子任务行、标签按序组成并标注 context', () => {
        const lines = buildThoughtLines({
            text: '第一行\n第二行',
            subItems: [{ text: '子任务甲' }, { text: '子任务乙' }],
            tags: ['工作', '灵感']
        });
        assert.deepStrictEqual(lines.map(line => line.context), ['正文', '正文', '子任务', '子任务', '标签', '标签']);
        assert.strictEqual(lines[2].text, '子任务甲');
        assert.strictEqual(lines[4].text, '工作');
    });

    const thoughtProvider = createThoughtSearchProvider({
        storage: {
            async searchThoughtsLight({ keywords, limit }) {
                assert.ok(Array.isArray(keywords), 'provider should pass the keyword array through');
                const thoughts = [
                    { id: 'th1', text: '学习部署流程', subItems: [{ text: '写部署笔记' }], tags: ['ops'], createdAt: 1, updatedAt: 100 },
                    { id: 'th2', text: '无关想法', subItems: [{ text: '部署脚本待写' }], tags: [], createdAt: 2, updatedAt: 90 }
                ].filter(thought => keywords.every(keyword => (
                    thought.text.toLowerCase().includes(keyword)
                    || thought.subItems.some(item => item.text.toLowerCase().includes(keyword))
                )));
                return thoughts.slice(0, limit);
            }
        }
    });

    await run('命中标注 context（正文/子任务），关键词跨正文与子任务 AND 命中', async () => {
        const results = await thoughtProvider.search(['部署', '笔记']);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].id, 'th1');
        assert.strictEqual(results[0].type, 'thought');
        const contexts = results[0].occurrences.map(item => item.context);
        assert.deepStrictEqual(contexts, ['子任务', '正文'], 'the subtask line hits BOTH keywords so it ranks first');
        assert.strictEqual(results[0].occurrences[1].lineText, '学习部署流程');
    });

    await run('thought 首行命中记为 title match', async () => {
        const [result] = await thoughtProvider.search(['学习']);
        assert.strictEqual(result.matchType, 'title');
        assert(result.title.startsWith('学习部署流程'));
    });

    console.log('[today draft provider]');

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    await run('dayWindowKeys/dayLabel: 今天/昨天/前天，窗口外无标签', () => {
        assert.strictEqual(dayWindowKeys().size, 3);
        assert.strictEqual(dayLabel(localDayKey(today)), '今天');
        assert.strictEqual(dayLabel(localDayKey(yesterday)), '昨天');
        const beforeYesterday = new Date(today);
        beforeYesterday.setDate(beforeYesterday.getDate() - 2);
        assert.strictEqual(dayLabel(localDayKey(beforeYesterday)), '前天');
        assert.strictEqual(dayLabel(localDayKey(threeDaysAgo)), localDayKey(threeDaysAgo), 'outside window falls back to raw key');
        assert.strictEqual(dayWindowKeys().size, 3);
    });

    const draftProvider = createTodayDraftSearchProvider({
        storage: {
            async readTodayDrafts() {
                return [
                    { id: 'd1', text: '今天要买苹果\n顺便复习部署', completed: false, day: localDayKey(today), version: 1, createdAt: 1, updatedAt: 10 },
                    { id: 'd2', text: '昨天的想法部署', completed: true, day: localDayKey(yesterday), version: 1, createdAt: 2, updatedAt: 20 },
                    { id: 'd3', text: '窗口外的旧草稿部署', completed: false, day: localDayKey(threeDaysAgo), version: 1, createdAt: 3, updatedAt: 30 }
                ];
            }
        }
    });

    await run('窗口过滤：滑出 3 天窗口的草稿不参与搜索', async () => {
        const results = await draftProvider.search(['部署']);
        assert.deepStrictEqual(results.map(item => item.id).sort(), ['d1', 'd2']);
    });

    await run('草稿结果带 day，标题取首个非空行', async () => {
        const [result] = await draftProvider.search(['苹果']);
        assert.strictEqual(result.id, 'd1');
        assert.strictEqual(result.day, localDayKey(today));
        assert.strictEqual(result.title, '今天要买苹果');
        assert.strictEqual(result.occurrences.length, 1);
        assert.strictEqual(result.type, 'today_draft');
    });

    console.log('[registry]');

    await run('空关键词不触发任何 provider', async () => {
        let called = 0;
        const registry = createSearchRegistry({
            providers: [{ type: 'x', scope: 'x', async search() { called += 1; return []; } }]
        });
        const { keywords, results } = await registry.search({ query: '   ' });
        assert.strictEqual(called, 0);
        assert.deepStrictEqual(keywords, []);
        assert.deepStrictEqual(results, []);
    });

    await run('scope 过滤只调用对应 provider；all 调用全部', async () => {
        const calls = [];
        const registry = createSearchRegistry({
            providers: [
                { type: 'notepad', scope: 'notepads', async search(k) { calls.push(['notepad', ...k]); return [{ id: 'n', type: 'notepad' }]; } },
                { type: 'thought', scope: 'thoughts', async search(k) { calls.push(['thought', ...k]); return [{ id: 't', type: 'thought' }]; } }
            ]
        });
        const scoped = await registry.search({ query: '部署', scope: 'thoughts' });
        assert.deepStrictEqual(calls, [['thought', '部署']]);
        assert.deepStrictEqual(scoped.results.map(item => item.type), ['thought']);
        calls.length = 0;
        const all = await registry.search({ query: '部署' });
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(all.results.length, 2);
    });

    await run('provider 抛错降级为空结果并保持其他 provider 可用', async () => {
        const registry = createSearchRegistry({
            providers: [
                { type: 'broken', scope: 'notepads', async search() { throw new Error('storage down'); } },
                { type: 'thought', scope: 'thoughts', async search() { return [{ id: 't', type: 'thought' }]; } }
            ]
        });
        const { results } = await registry.search({ query: '任意' });
        assert.deepStrictEqual(results.map(item => item.type), ['thought'], 'one failing provider must not take search down');
    });

    console.log('Search provider checks passed');
}

runAll().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
