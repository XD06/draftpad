/**
 * 源码模式悬浮按钮回归（jsdom）：适配器的 setSourceMode 一直存在，但此前没有
 * UI 入口。这里钉住接入后的关键契约：
 * 1) 悬浮按钮存在、可通过 DUMBPAD_HIDDEN_FLOATING_ACTIONS 隐藏；
 * 2) app.js 的 editor 代理暴露 setSourceMode / isSourceMode；
 * 3) 源码 → 改标题级别 → 切回，渲染与落盘值都正确（用户的核心诉求）；
 * 4) 状态持久化到 localStorage，刷新后恢复；
 * 5) 阅读模式与源码模式互斥、切回后目录重建。
 * 纯 textarea 方案：不做语法高亮/行号，只保证「改得动、存得对、渲染得回来」。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const indexPath = path.join(ROOT, 'public', 'index.html');
const appPath = path.join(ROOT, 'public', 'app.js');

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
    }
}

/* ---------------- 1) 入口与配置（源码级，不需要浏览器环境） ---------------- */

const indexHtml = fs.readFileSync(indexPath, 'utf8');
const appSource = fs.readFileSync(appPath, 'utf8');

check(
    'index.html 有 toggle-source-mode 悬浮按钮',
    /<button id="toggle-source-mode"[^>]*class="floating-btn"/.test(indexHtml),
);
check(
    '按钮在 .floating-actions 容器内',
    /<div class="floating-actions">[\s\S]*id="toggle-source-mode"[\s\S]*<\/div>/.test(indexHtml),
);
check(
    '按钮带 aria-pressed（切换语义）',
    /id="toggle-source-mode"[^>]*aria-pressed="false"/.test(indexHtml),
);
check(
    '按钮带 data-tooltip',
    /id="toggle-source-mode"[^>]*data-tooltip=/.test(indexHtml),
);

// 配置黑名单必须认识它，否则 DUMBPAD_HIDDEN_FLOATING_ACTIONS 无法隐藏。
const floatingConfigSource = fs.readFileSync(
    path.join(ROOT, 'public', 'managers', 'floating-actions-config.js'), 'utf8');
check(
    'CONFIGURABLE_FLOATING_ACTIONS 登记了 toggle-source-mode',
    /CONFIGURABLE_FLOATING_ACTIONS\s*=\s*\[[\s\S]*?'toggle-source-mode'[\s\S]*?\]/.test(floatingConfigSource),
);

/* ---------------- 2) app.js 接线源码断言 ---------------- */

const proxyStart = appSource.indexOf('const editor = {');
const proxyEnd = appSource.indexOf('\n    };', proxyStart);
const proxySource = appSource.slice(proxyStart, proxyEnd);
check('editor 代理暴露 setSourceMode', /setSourceMode:\s*\(enabled\)\s*=>/.test(proxySource));
check('editor 代理暴露 isSourceMode', /get isSourceMode\(\)/.test(proxySource));
check(
    '源码模式状态持久化到独立 key',
    appSource.includes("SOURCE_MODE_KEY = 'dumbpad_source_mode'"),
);
check(
    '进源码模式前退出阅读模式（互斥）',
    /if \(active && isReadingMode\)[\s\S]{0,200}?isReadingMode = false;/.test(appSource),
);
check(
    '切回渲染后重建目录（源码模式里没有渲染 DOM）',
    /if \(!active\) \{[\s\S]{0,300}?updateToC\(\);/.test(appSource),
);
check(
    '恢复时机挂在编辑器就绪之后',
    /whenReady\(\)\.then\(\(\) => \{[\s\S]{0,600}?restoreSourceModeIfRequested\(\)/.test(appSource),
);
check(
    '恢复函数定义在使用点之前（ensureEditor 可能更早调用）',
    appSource.indexOf('function restoreSourceModeIfRequested()') < appSource.indexOf('restoreSourceModeIfRequested();'),
);
check(
    '恢复路径不用 .catch 吞错（失败要能在控制台看见）',
    !/restoreSourceModeIfRequested\(\);[\s\S]{0,80}?\}\)\s*\.catch\(/.test(appSource),
);

/* ---------------- 3) 真实编辑器往返（jsdom + 真实 bundle） ---------------- */

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'MutationObserver', 'KeyboardEvent', 'localStorage']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
}
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.getSelection = dom.window.getSelection.bind(dom.window);
global.requestAnimationFrame = dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
dom.window.Element.prototype.scrollIntoView = () => {};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const inputs = [];
    const editor = new HybridMarkdownEditor(container, { input: value => inputs.push(value) });
    try {
        await editor.whenReady();

        const article = '# 一级标题\n\n正文段落\n\n## 原有二级\n\n- 列表项';
        editor.setValue(article, false);
        check('初始渲染为 h1', container.querySelector('.tiptap h1')?.textContent === '一级标题');

        // 键盘开合的视线归位依赖 visualViewport；jsdom 没有，造一个 EventTarget。
        // 必须在首次 setSourceMode 之前定义：适配器在创建 textarea 时注册监听。
        const fakeViewport = new dom.window.EventTarget();
        Object.defineProperty(dom.window, 'visualViewport', { value: fakeViewport, configurable: true });

        // 用户核心场景：# → ##（此前只能删掉重打）
        editor.setSourceMode(true);
        const textarea = editor.getSourceTextarea();
        check('源码模式显示 Markdown 原文', textarea.value === article, textarea.value);
        // 显隐由 .is-source-mode 类驱动（styles.css 负责落到 computed display）。
        // 这里不能断言行内 style：行内样式赢不过 `.typora-editor-shell
        // .vditor-wysiwyg { display: block !important }`，那正是「点了没反应」的
        // 根因；真机的 computed display 由 test/browser/source-mode.js 量。
        check('源码模式给容器挂上 is-source-mode', container.classList.contains('is-source-mode'));
        check('源码模式不再写行内 display', textarea.style.display === '' && editor.scroller.style.display === '');
        check('isSourceMode 反映状态', editor.sourceMode === true);

        textarea.value = article.replace('# 一级标题', '## 一级标题');
        textarea.dispatchEvent(new dom.window.Event('input'));
        check('源码编辑触发了变更上报', inputs.length === 1 && inputs[0].startsWith('## 一级标题'), inputs);

        editor.setSourceMode(false);
        const headings = [...container.querySelectorAll('.tiptap h1, .tiptap h2')]
            .map(el => `${el.tagName}:${el.textContent}`);
        check(
            '切回后 h1 变 h2，原有 h2 保留',
            headings.includes('H2:一级标题') && headings.includes('H2:原有二级') && !headings.includes('H1:一级标题'),
            headings,
        );
        check('切回后列表仍正常渲染', Boolean(container.querySelector('.tiptap li')));
        check('切回后渲染区恢复', editor.scroller.style.display === '');
        check('切回后落盘值为新源码', editor.getValue().startsWith('## 一级标题'), editor.getValue());

        // 幂等：再进再出，内容不变
        const settled = editor.getValue();
        editor.setSourceMode(true);
        check('二次进入源码内容与渲染值一致', editor.getSourceTextarea().value === settled);
        editor.setSourceMode(false);
        check('二次切回内容不变', editor.getValue() === settled, { settled, now: editor.getValue() });

        // 键盘开/收的视线归位：源码模式 + textarea 聚焦时按光标带状归位（真机：
        // 浏览器对「内容等高 textarea」的键盘滚动对准元素盒 = 文档顶，视线飞顶、
        // 光标留原地）。三个门槛：聚焦才管、失焦不抢（键盘因点到别处而收，落点
        // 是用户自己选的）、渲染模式不触发。
        let viewportScrollCalls = 0;
        const realScrollIntoView = editor.scrollTextareaSelectionIntoView.bind(editor);
        editor.scrollTextareaSelectionIntoView = (ta) => { viewportScrollCalls += 1; return realScrollIntoView(ta); };
        try {
            editor.setSourceMode(true);
            const viewportTextarea = editor.getSourceTextarea();
            viewportTextarea.focus();
            fakeViewport.dispatchEvent(new dom.window.Event('resize'));
            await new Promise(resolve => setTimeout(resolve, 380));
            check('源码模式键盘开合（textarea 聚焦）触发视线归位', viewportScrollCalls === 1, viewportScrollCalls);
            viewportTextarea.blur();
            fakeViewport.dispatchEvent(new dom.window.Event('resize'));
            await new Promise(resolve => setTimeout(resolve, 380));
            check('textarea 失焦时键盘收起不抢视线', viewportScrollCalls === 1, viewportScrollCalls);
            editor.setSourceMode(false);
            fakeViewport.dispatchEvent(new dom.window.Event('resize'));
            await new Promise(resolve => setTimeout(resolve, 380));
            check('渲染模式下 vv resize 不触发源码归位', viewportScrollCalls === 1, viewportScrollCalls);
        } finally {
            delete editor.scrollTextareaSelectionIntoView;
            // 还原焦点与光标记录：本块是全文件唯一聚焦编辑面的段落，切回渲染的
            // 光标恢复会顺带聚焦 PM 编辑器；不还原的话，后面「换正文后光标记录
            // 作废」的既有断言会读到本块残留的焦点与记录（selectionUpdate 重记）。
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            editor._trackedCaret = null;
        }

        /* 整页滚动（移动端 ios-theme）下的带状归位几何。承重不变式：
         * document.scrollingElement 的 getBoundingClientRect().top 本身就等于
         * −scrollTop（它跟着文档一起滚），所以「容器顶缘在视口里的位置」必须是 0——
         * 拿它的 rect 当偏移基准会把 scrollTop 加错两遍，量出的光标文档位偏高
         * 正好一个 scrollTop，于是「光标明明在可见带内」也判成出带，一次归位把
         * 视线甩到文末（真机 Android PWA 的「视线与光标不统一」；桌面走内滚容器
         * rect 是常量，公式在桌面恰好成立，所以此前只有真机复现）。
         * jsdom 没有布局，用假滚动容器复现那层几何；渲染侧孪生函数
         * scrollEditorCaretIntoView 早就有这条 isPageScroll 分支，此处只是补齐对称。 */
        const fakePage = {
            scrollTop: 17166,
            clientHeight: 844,
            scrollHeight: 21723,
            getBoundingClientRect: () => ({ top: -fakePage.scrollTop }),
        };
        Object.defineProperty(document, 'scrollingElement', { value: fakePage, configurable: true });
        const bandTextarea = editor.getSourceTextarea();
        try {
            // jsdom 无布局：measureTextareaCaretTop 恒为 0，于是 textarea 的 rect.top
            // 就是「光标行距视口顶的像素」，正好对应真机量到的三种位置。
            const band = (scrollTop, caretViewportY) => {
                fakePage.scrollTop = scrollTop;
                bandTextarea.getBoundingClientRect = () => ({ top: caretViewportY });
                editor.scrollTextareaSelectionIntoView(bandTextarea);
                return fakePage.scrollTop;
            };
            // 真机探针实测：S=17166、H=844、光标行在视口 338px 处（带内）。
            // 错误实现会写成 S+caretDocY−0.7H ≈ 34079（浏览器钳到文末）。
            const inBand = band(17166, 338);
            check('整页滚动：光标在可见带内时视线不动（带状语义成立）',
                Math.abs(inBand - 17166) < 0.5, inBand);
            // 光标在视口下方（1182px）：出带下侧落 40%（真机反馈 70% 时「光标贴屏底、
            // 要手动再滑一点」）——= caretDocY − 0.4H，而不是文末。
            const below = band(16322, 1182);
            check('整页滚动：光标在下方出带时轻推到 40%（不甩到文末）',
                Math.abs(below - (16322 + 1182 - 844 * 0.4)) < 0.5, below);
            // 光标在视口上方（−338px）：应落到 30% 处 = caretDocY − 0.3H。
            const above = band(17842, -338);
            check('整页滚动：光标在上方出带时轻推到 30%',
                Math.abs(above - (17842 - 338 - 844 * 0.3)) < 0.5, above);
            // 深滚动到底也必须是 no-op：旧实现在这里必然把 scrollTop 再写大一次。
            const atBottom = band(20879, 338);
            check('整页滚动：贴底带内同样是 no-op', Math.abs(atBottom - 20879) < 0.5, atBottom);
        } finally {
            delete bandTextarea.getBoundingClientRect;   // 还原原型实现
            delete document.scrollingElement;            // 还原 jsdom 的 getter
        }

        // 源码模式里切文章：textarea 必须跟着换成新正文，否则点一下切回渲染
        // 会把上一篇的原文写进当前文章（用户报的「跳到上上次切换的文章」）。
        editor.setSourceMode(true);
        editor.setValue('# 文章甲\n\n甲的正文', false);
        check('源码模式中载入新文章会刷新 textarea', editor.getSourceTextarea().value === '# 文章甲\n\n甲的正文', editor.getSourceTextarea().value);
        editor.setValue('# 文章乙\n\n乙的正文', false);
        check('连续切文 textarea 始终是最新一篇', editor.getSourceTextarea().value.startsWith('# 文章乙'), editor.getSourceTextarea().value);
        editor.setSourceMode(false);
        check('切回后渲染的是当前文章而非上一篇', container.querySelector('.tiptap h1')?.textContent === '文章乙',
            container.querySelector('.tiptap h1')?.textContent);
        check('切回后落盘值也是当前文章', editor.getValue().startsWith('# 文章乙'), editor.getValue());

        // 空文档
        editor.setValue('', false);
        editor.setSourceMode(true);
        check('空文档源码为空', editor.getSourceTextarea().value === '');
        editor.getSourceTextarea().value = '# 新写的';
        editor.getSourceTextarea().dispatchEvent(new dom.window.Event('input'));
        editor.setSourceMode(false);
        check('空文档里写入后正确渲染', container.querySelector('.tiptap h1')?.textContent === '新写的');

        // 重复调用不炸
        editor.setSourceMode(false);
        check('重复关闭源码模式是安全的', editor.getValue() === '# 新写的');

        /* ---------------- 4) 光标映射（Markdown 偏移 ↔ PM 位置） ----------------
         * 源码/渲染两个编辑面的光标唯一公共坐标系就是 Markdown 偏移。
         * 映射错了不会报错，只会「切过去光标跑到别处」——所以必须钉住往返。 */
        const caretDoc = [
            '# 一级标题',
            '',
            '正文段落一二三，带**加粗**和`行内代码`。',
            '',
            '## 二级',
            '',
            '- 列表甲',
            '- 列表乙',
            '',
            '1. 有序一',
            '2. 有序二',
            '',
            '> 引用第一行',
            '> 引用第二行',
            '',
            '```js',
            'const a = 1;',
            '```',
            '',
            '| 列 | 二 |',
            '| --- | --- |',
            '| 甲 | 乙 |',
            '',
            '最后一段。',
        ].join('\n');
        editor.setValue(caretDoc, false);
        const fullMd = editor.getValue();
        check('映射用全文非空', fullMd.length > 50, fullMd.length);

        // 关键不变式：**偏移 → 位置 → 偏移** 精确还原。
        // 注意 serializePrefixLength 单调但**不满射**：`# `、`- ` 这类语法标记和
        // 块间空行在任何 PM 位置都会产出，所以落在标记中间的偏移没有精确对应
        // 位置（映射取「前缀长度 >= 目标的最小位置」，贴到块文字开头）。因此
        // 遍历位置（位置产出的偏移必然可表示），而不是遍历 0..len 的每个偏移。
        // 只取**文本节点边界**：那才是能放光标的位置。顶层块边界（pos 0 之类）
        // 放不进 TextSelection，而 `# ` 这种行首标记的中间偏移本来就没有对应位置
        // （映射会贴到块文字开头），所以不能遍历 0..len 的每个偏移。
        const textPositions = new Set();
        editor.editor.state.doc.descendants((node, pos) => {
            if (node.isText) {
                textPositions.add(pos);
                textPositions.add(pos + node.nodeSize);
            }
        });
        const positions = [...textPositions].sort((left, right) => left - right);
        check('夹具里有足够的文本边界', positions.length > 20, positions.length);
        let monotonic = true;
        let mismatched = null;
        let previousLength = -1;
        for (const pos of positions) {
            const length = editor.serializePrefixLength(pos);
            if (length === null) continue;   // 表格内部切不出前缀：跳过
            if (length < previousLength) monotonic = false;
            const roundTrip = editor.serializePrefixLength(editor.mapMarkdownOffsetToPos(length));
            if (roundTrip !== length && mismatched === null) {
                mismatched = { pos, length, roundTrip };
            }
            previousLength = length;
        }
        check('serializePrefixLength 随位置单调不减', monotonic);
        check('偏移→位置→偏移 往返精确（每个文本边界）', mismatched === null, mismatched);

        // 表格这类「切不开」的位置必须返回 null 而不是抛错（真测踩过：整篇切换崩）。
        const everyPosition = new Set([0, editor.editor.state.doc.content.size]);
        editor.editor.state.doc.descendants((node, pos) => {
            everyPosition.add(pos);
            everyPosition.add(pos + node.nodeSize);
        });
        check('表格内部位置返回 null 而不是抛错',
            [...everyPosition].some(pos => editor.serializePrefixLength(pos) === null));

        // 边界与越界钳制
        check('偏移 0 落到文档第一个内容位', editor.mapMarkdownOffsetToPos(0) === 1,
            editor.mapMarkdownOffsetToPos(0));
        const lastPos = editor.editor.state.doc.content.size;
        check('越界偏移钳到文档末尾',
            editor.mapMarkdownOffsetToPos(fullMd.length + 500) === lastPos,
            { got: editor.mapMarkdownOffsetToPos(fullMd.length + 500), want: lastPos });

        /* 前缀空间 == textarea 空间（真机「切换后光标跑到下一行」的钉）。
         * serializePrefixLength 必须与 getValue() 走同一条出口链：textarea 装的是
         * fenceToFrontmatter + normalizeAmbiguousEmptyListMarkers 变换后的文本，
         * 原始序列化器里 frontmatter 是 ```dumbpad-frontmatter 围栏形态，两者在
         * 文首差 19 字符（围栏语言名长度）；偏移若用原始空间算、放到变换后的
         * textarea 上，光标整体偏后一两行。探针实测差 +19 → 本条钉死差 0。 */
        const fmDoc = '---\ntitle: 草稿\ntags: [a]\n---\n\n# 标题\n\n这是正文第一段，目标文字在这里。\n\n结尾段。';
        editor.setValue(fmDoc, false);
        const fmText = editor.getValue();
        check('frontmatter 文章的全文前缀长度等于 textarea 长度',
            editor.serializePrefixLength(editor.editor.state.doc.content.size) === fmText.length,
            { prefix: editor.serializePrefixLength(editor.editor.state.doc.content.size), textarea: fmText.length });
        // 真机链路方向：渲染光标（PM 位置）→ 偏移 → 应用到 textarea 必须命中同一段
        // 文字。用反向（偏移→位置→偏移）测会撞上「映射不满射」的既有设计——中段
        // 偏移没有精确对应位置，取 >= 目标的最小文本边界，那是另一条不变式的事。
        const fmWordStart = fmText.indexOf('目标文字');
        let fmCaretPos = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (fmCaretPos !== null || !node.isText) return true;
            if (/目标文字/.test(node.text || '')) {
                fmCaretPos = pos + (node.text || '').indexOf('目标文字');
            }
            return true;
        });
        editor._trackedCaret = { mode: 'wysiwyg', pos: fmCaretPos };
        const fmOffset = editor.getCaretMarkdownOffset();
        check('渲染光标→偏移→textarea 落点命中目标文字（不差行）',
            fmText.slice(fmOffset, fmOffset + 4) === '目标文字',
            { offset: fmOffset, landed: JSON.stringify(fmText.slice(fmOffset, fmOffset + 8)) });
        editor._trackedCaret = null;

        /* 前缀空间统一的第三格：渲染光标落在 frontmatter 的 YAML 行**里面**再切
         * 源码。出口链不做转换时这类偏移留在 raw 空间（+19），落点直接跳出
         * frontmatter 块（真机「光标跑下一行」的窄域同族）。注意**不需要**开栏
         * 即时转换的额外分支——内核序列化器给截断的代码块照样补闭合围栏
         * （CodeFenceInputShortcut 依赖的同一条契约），「成对才转」的
         * fenceToFrontmatter 对切片位置统一生效；反向验证：去掉出口链本条 FAIL，
         * 开栏转换版与简单链版行为等价，叠上去是多余复杂度。 */
        let yamlCaretPos = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (yamlCaretPos !== null || !node.isText) return true;
            if ((node.text || '').includes('草稿')) {
                yamlCaretPos = pos + (node.text || '').indexOf('草稿');
            }
            return true;
        });
        check('夹具里有 frontmatter 的 YAML 文字', yamlCaretPos !== null, yamlCaretPos);
        editor._trackedCaret = { mode: 'wysiwyg', pos: yamlCaretPos };
        const yamlOffset = editor.getCaretMarkdownOffset();
        const fmBlockEnd = fmText.indexOf('\n---', 4) + 5;   // 闭合围栏的末尾
        check('渲染光标在 frontmatter YAML 内→偏移落在 frontmatter 块内（前缀与 textarea 同空间）',
            yamlOffset >= 4 && yamlOffset <= fmBlockEnd,
            { offset: yamlOffset, fmBlockEnd, landed: JSON.stringify(fmText.slice(Math.max(0, yamlOffset - 6), yamlOffset + 8)) });
        editor._trackedCaret = null;

        // 还原后续段落期望的文档（「内容未变的载入保留光标记录」以 caretDoc 为基准）。
        editor.setValue(caretDoc, false);


        // 光标可信性：只记「用户真的放过光标」的位置，且**换文章必须作废**——
        // PM 位置是文档内绝对偏移，带着 A 文的位置去映射 B 文会跳到不相干的一段。
        editor._trackedCaret = { mode: 'wysiwyg', pos: 8 };
        const trackedOffset = editor.getCaretMarkdownOffset();
        check('有记录时可取光标偏移', typeof trackedOffset === 'number', trackedOffset);
        editor.setValue(caretDoc, false);
        check('内容未变的载入保留光标记录', editor._trackedCaret !== null);
        editor._trackedCaret = { mode: 'wysiwyg', pos: 8 };
        editor.setValue(caretDoc + '\n\n追加一段。', false);
        check('换正文后光标记录作废', editor._trackedCaret === null, editor._trackedCaret);
        check('无记录时光标不可信（退回按比例落位）', editor.getCaretMarkdownOffset() === null,
            editor.getCaretMarkdownOffset());
    } finally {
        editor.editor.destroy();
        dom.window.close();
    }

    console.log('');
    if (failures > 0) {
        console.error(`${failures} source-mode check(s) failed`);
        process.exit(1);
    }
    console.log('source mode button checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
