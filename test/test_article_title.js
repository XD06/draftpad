/**
 * 文章临时标题推导（managers/article-title.js 的 deriveArticleTitle）单测：
 * 最高级标题优先（H1 > H2……同级取第一个）、无标题时首句按句末标点/固定字数
 * 截断、frontmatter 与代码围栏不参与、引用/列表/任务标记剥离。另含接线源码
 * 断言：app.js 的创建命名与输入跟随、styles.css 的编辑卡片满屏规则。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadArticleTitle() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'article-title.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export const /g, 'const ')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { deriveArticleTitle, ARTICLE_TITLE_MAX_CHARS, DEFAULT_NOTEPAD_NAME_RE };\n';
    const context = { module: { exports: {} }, exports: {}, String, Number, Math, Array, RegExp };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

const { deriveArticleTitle, ARTICLE_TITLE_MAX_CHARS, DEFAULT_NOTEPAD_NAME_RE } = loadArticleTitle();

let failed = 0;
let passed = 0;

function check(name, actual, expected) {
    if (Object.is(actual, expected)) {
        passed += 1;
        return;
    }
    failed += 1;
    console.error(`✗ ${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
}

/* ---------------- 最高级标题 ---------------- */

check('H1 优先于先出现的 H2', deriveArticleTitle('## 二级\n# 一级\n正文'), '一级');
check('没有 H1 时取第一个 H2', deriveArticleTitle('## 甲\n正文\n## 乙'), '甲');
check('最高级标题可以出现在文档后部', deriveArticleTitle('### 三\n## 二\n# 一'), '一');
check('同级标题取第一个', deriveArticleTitle('# 首个\n# 次个'), '首个');
check('H6 也可作为最高级', deriveArticleTitle('###### 深层\n正文'), '深层');
check('标题行内修饰被剥离', deriveArticleTitle('# **加粗** 与 `代码` ##'), '加粗 与 代码');
check('标题超长按固定字数截断', deriveArticleTitle('# ' + '长'.repeat(40)), '长'.repeat(30));
check('maxChars 选项生效', deriveArticleTitle('# 标题可以很长很长', { maxChars: 4 }), '标题可以');

/* ---------------- 首句兜底 ---------------- */

check('无标题取第一句（句末标点截断）', deriveArticleTitle('这是第一句。这是第二句。'), '这是第一句。');
check('英文句点同样截断', deriveArticleTitle('Hello world. Rest ignored'), 'Hello world.');
check('无句末标点按固定字数硬截', deriveArticleTitle('一'.repeat(40)), '一'.repeat(30));
check('硬截长度等于 ARTICLE_TITLE_MAX_CHARS', deriveArticleTitle('字'.repeat(ARTICLE_TITLE_MAX_CHARS + 5)).length, ARTICLE_TITLE_MAX_CHARS);
check('列表标记剥离', deriveArticleTitle('- 首个条目内容。后续'), '首个条目内容。');
check('有序列表标记剥离', deriveArticleTitle('1. 第一条。'), '第一条。');
check('任务标记剥离', deriveArticleTitle('- [ ] 待办事项。'), '待办事项。');
check('引用标记剥离', deriveArticleTitle('> 引用的一句话。'), '引用的一句话。');
check('链接只留文字', deriveArticleTitle('[链接文字](http://example.com/a_b) 后续'), '链接文字 后续');
check('词内下划线不被当强调', deriveArticleTitle('snake_case_words 保持原样'), 'snake_case_words 保持原样');
check('跳过分隔线后取正文', deriveArticleTitle('---\n正文第一句。'), '正文第一句。');

/* ---------------- 排除区：frontmatter / 代码围栏 ---------------- */

check('文首 frontmatter 不参与标题', deriveArticleTitle('---\ntitle: 元信息\ntags: [a]\n---\n# 真标题\n正文'), '真标题');
check('frontmatter 后的首句兜底跳过元信息行',
    deriveArticleTitle('---\ntitle: 元信息\n---\n正文第一句。'), '正文第一句。');
check('围栏内的 # 行不是标题',
    deriveArticleTitle('```js\n# 不是标题\nconsole.log(1);\n```\n真正的正文。'), '真正的正文。');
check('围栏内容不进首句兜底',
    deriveArticleTitle('```\n围栏里的话不会成为标题。\n```\n围栏外的第一句。'), '围栏外的第一句。');
check('围栏之后的标题仍然生效',
    deriveArticleTitle('```\n代码\n```\n## 围栏后标题'), '围栏后标题');

/* ---------------- 边界 ---------------- */

check('空内容返回空串', deriveArticleTitle(''), '');
check('纯空白返回空串', deriveArticleTitle('\n\n   \n'), '');
check('只有 frontmatter 返回空串', deriveArticleTitle('---\na: 1\n---\n'), '');
check('CRLF 换行正常解析', deriveArticleTitle('# 标题\r\n正文\r\n'), '标题');
check('占位名正则匹配 createNotepad 默认名', DEFAULT_NOTEPAD_NAME_RE.test('Notepad 12'), true);
check('占位名正则不匹配手工名', DEFAULT_NOTEPAD_NAME_RE.test('金融投资书籍'), false);
check('占位名正则不匹配派生名', DEFAULT_NOTEPAD_NAME_RE.test('Notepad 已重命名'), false);

/* ---------------- 接线源码断言 ---------------- */

function expectSource(condition, name) {
    if (condition) { passed += 1; return; }
    failed += 1;
    console.error(`✗ ${name}`);
}

const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(ROOT, 'public/Assets/styles.css'), 'utf8');

expectSource(appSource.includes("from './managers/article-title.js'"), 'app.js 引入 article-title 模块');
expectSource(appSource.includes('deriveArticleTitle(initialContent)'), 'createNotepad 带内容建文时按内容命名');
expectSource(/scheduleAutoTitle\(targetNotepadId,\s*content\)[\s\S]{0,200}cacheDirtyNote\(targetNotepadId,\s*content/
    .test(appSource), 'debouncedSave 在 cacheDirtyNote 覆盖缓存前判定标题跟随资格');
expectSource(appSource.includes('autoTitleNames.delete(id)'), '手动重命名后退出标题跟随');
expectSource(appSource.includes('history.replaceState'), '自动重命名用 replaceState 同步 URL，不刷历史栈');
expectSource(appSource.includes('AUTO_TITLE_DEBOUNCE_MS'), '标题跟随有独立防抖窗口');

const tiptapRuleAt = stylesSource.indexOf('.typora-editor-shell .tiptap {');
expectSource(tiptapRuleAt > -1, 'styles.css 仍有 .tiptap 卡片规则');
const tiptapBlockEnd = stylesSource.indexOf('}', tiptapRuleAt);
const tiptapBlock = stylesSource.slice(tiptapRuleAt, tiptapBlockEnd);
expectSource(tiptapBlock.includes('min-height: calc(100% - 64px)'), '桌面：卡片 min-height 占满滚动容器一屏（扣除 64px 顶部让位）');
expectSource(!tiptapBlock.includes('min-height: 60vh'), '旧的 60vh 小块编辑区已移除');
expectSource(/min-height:\s*calc\(100vh - 135px\)/.test(stylesSource), '移动端：卡片按视口单位占满一屏（140 - 5px 余量）');
const iosSource = fs.readFileSync(path.join(ROOT, 'public/Assets/ios-theme.css'), 'utf8');
const wysiwygPadAt = iosSource.indexOf('padding-bottom: 64px;');
expectSource(wysiwygPadAt > -1, '桌面：滚动容器底部留白 64px，与卡片顶部 64px margin 对齐（贴底）');
const tiptapMinAt = stylesSource.indexOf('min-height: calc(100% - 64px)');
expectSource(tiptapMinAt > -1 && wysiwygPadAt > -1, '满屏卡片几何依赖上下各 64px 留白对齐');

console.log(`\narticle-title: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
