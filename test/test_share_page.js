const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { marked } = require('marked');
const { JSDOM } = require('jsdom');
const { registerShareRoutes, sanitizeHtml } = require('../routes/share-routes');
const {
    renderSharePage,
    renderShareBody,
    extractFrontmatter,
    parseFrontmatterEntries,
    highlightShareCodeBlocks
} = require('../scripts/share-renderer');

function assertSecurityInvariants(html) {
    assert(!/<script\b[^>]*>\s*alert/i.test(html), 'must strip user script tags');
    assert(!/\bonerror\s*=/i.test(html), 'must strip inline event handlers');
    assert(!/href=["']javascript:/i.test(html), 'must neutralize javascript: links');
}

async function testRendererUnitCases() {
    const notepad = {
        id: 'note-1',
        name: '共享设计验收',
        createdAt: Date.UTC(2026, 0, 1, 8, 0),
        updatedAt: Date.UTC(2026, 0, 2, 14, 30),
        editCount: 7
    };

    const markdown = [
        '# 共享设计验收',
        '',
        '第一段包含 **加粗**、`==代码内字面量==`、==高亮句== 和 [[time:update@2:2026-01-02 14:30:00]]。',
        '',
        '<span data-note="包含 `code` 与 **粗体** 的批注" style="text-decoration:underline wavy #e74c3c;">带<a href="https://example.com">链接</a>和`内联代码`的批注</span><sub data-note-label>（旧标签）</sub>',
        '',
        '<mark note="旧版批注">旧标记内容</mark> 与 ==双等批注=={用户批注: 兼容旧格式}',
        '',
        '<span data-draw="true" style="text-decoration:underline blue;">蓝色划线</span>',
        '',
        '## 任务列表',
        '',
        '- [ ] 未开始任务',
        '- [~] 进行中任务',
        '- [x] 已完成任务',
        '',
        '## 图片与媒体',
        '',
        '![封面图](/api/assets/0123456789abcdef0123456789abcdef/preview "dumbpad-width=360")',
        '',
        '![视频](/api/assets/0123456789abcdef0123456789abcdef/original "dumbpad-video=1;name=demo.mp4;size=2048")',
        '',
        '[下载资料.pdf](/api/assets/0123456789abcdef0123456789abcdef/download "dumbpad-file=1")',
        '',
        '```js',
        'const sample = "==代码围栏里不该高亮==";',
        '```',
        '',
        '```mermaid',
        'flowchart TD',
        '    A[开始] --> B[结束]',
        '```',
        '',
        '| 列一 | 列二 |',
        '| --- | --- |',
        '| A | B |',
        '',
        '<script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a>',
        '<mark><img src="x" onerror="alert(4)">安全高亮</mark>'
    ].join('\n');

    const fullHtml = renderSharePage({ notepad, content: markdown, marked, sanitizeHtml });
    assertSecurityInvariants(fullHtml);

    // Must not link main app stylesheets that contain global resets & overflow locks
    assert(!fullHtml.includes('/Assets/styles.css'), 'share page must not load main app styles.css');
    assert(!fullHtml.includes('/Assets/preview-styles.css'), 'share page must not load #preview-pane scoped css');
    assert(fullHtml.includes('overflow-x: clip'), 'must use overflow-x: clip to preserve sticky left rail');

    const dom = new JSDOM(fullHtml, { runScripts: 'dangerously', url: 'http://127.0.0.1/s/note-1?t=abc' });
    const doc = dom.window.document;

    assert(doc.body.classList.contains('has-toc'), 'document with H2 headings should set has-toc');
    const railLinks = Array.from(doc.querySelectorAll('#rail-nav a'));
    assert.deepStrictEqual(
        railLinks.map((a) => a.textContent.trim()),
        ['任务列表', '图片与媒体'],
        'duplicate leading H1 matching notepad name should be stripped and remaining headings populate TOC'
    );

    // Non-matching leading H1 must be preserved
    const preservedBody = renderShareBody({
        content: '# 另一标题\n\n正文',
        notepadName: '不同名笔记',
        marked,
        sanitizeHtml
    });
    assert(/<h1\b[^>]*>另一标题<\/h1>/.test(preservedBody), 'leading H1 differing from notepad.name must be preserved');

    // Marks & code masking + syntax highlighting invariants
    const codeEls = Array.from(doc.querySelectorAll('#article-body code'));
    assert(codeEls.some((el) => el.textContent === '==代码内字面量=='), 'inline code containing == must not be tokenized');
    const jsCodeEl = doc.querySelector('#article-body .ios-code-card pre code.language-js');
    assert(jsCodeEl, 'fenced js code block should keep language-js class inside .ios-code-card');
    assert(jsCodeEl.classList.contains('hljs'), 'highlighted js block must gain .hljs class');
    assert(jsCodeEl.querySelector('.hljs-keyword')?.textContent === 'const', 'js keyword must be syntax-highlighted');
    assert(jsCodeEl.querySelector('.hljs-string')?.textContent.includes('==代码围栏里不该高亮=='), 'string token inside js fence must retain literal text cleanly');
    assert(
        jsCodeEl.textContent.includes('==代码围栏里不该高亮=='),
        'fenced code block containing == must stay literal'
    );
    assert(fullHtml.includes('html[data-theme="dark"] .markdown-body pre code.hljs .hljs-keyword'), 'share HTML must bundle dark hljs token theme');

    // Lazy extra hljs language (e.g. powershell) + safe escaping inside highlighted HTML
    const extraCodeBody = renderShareBody({
        content: [
            '```powershell',
            'Get-ChildItem -Path "C:\\Temp" | Where-Object { $_.Length -gt 0 }',
            '```',
            '',
            '```html',
            '<div onclick="alert(1)"><script>bad()</script></div>',
            '```',
            '',
            '```plaintext',
            'plain raw text without keyword highlight',
            '```'
        ].join('\n'),
        notepadName: '代码高亮扩展测试',
        marked,
        sanitizeHtml
    });
    assertSecurityInvariants(extraCodeBody);
    const extraDoc = new JSDOM(`<div id="b">${extraCodeBody}</div>`).window.document;
    const psCode = extraDoc.querySelector('pre code.language-powershell');
    assert(psCode && psCode.classList.contains('hljs') && psCode.querySelector('.hljs-built_in, .hljs-string'), 'lazy-loaded powershell language should highlight on SSR share page');
    const htmlCode = extraDoc.querySelector('pre code.language-html');
    assert(htmlCode && htmlCode.classList.contains('hljs') && Array.from(htmlCode.querySelectorAll('.hljs-name')).some((el) => el.textContent === 'script'), 'html code fence should highlight safely');
    assert(htmlCode.textContent.includes('<script>bad()</script>'), 'html code block text must decode cleanly without script execution');
    const rawPreBody = renderShareBody({
        content: '<pre><code onclick="alert(1)"><script>alert(9)</script>ok</code></pre>',
        notepadName: '裸 pre XSS 防护',
        marked,
        sanitizeHtml
    });
    assertSecurityInvariants(rawPreBody);
    assert(!/onclick/i.test(rawPreBody), 'raw HTML <pre><code onclick=...> must still be sanitized');
    const plainCode = extraDoc.querySelector('pre code.language-plaintext');
    assert(plainCode && !plainCode.classList.contains('hljs') && plainCode.querySelectorAll('span').length === 0, 'plaintext fence must stay uncolored');
    assert.strictEqual(highlightShareCodeBlocks('<pre><code class="language-mermaid">graph TD\nA-->B</code></pre>'), '<pre><code class="language-mermaid">graph TD\nA-->B</code></pre>', 'mermaid fence must not be rewritten into hljs spans');
    assert(doc.querySelector('#article-body mark.md-mark'), 'plain ==highlight== / <mark> should render as .md-mark');
    assert(doc.querySelector('#article-body [data-draw]'), 'blue draw underline should preserve data-draw');
    assert(doc.querySelector('#article-body .time-chip.is-update'), '[[time:update...]] should render as time chip');

    // Annotations inside span[data-note] with nested link + backtick code
    const anns = Array.from(doc.querySelectorAll('#article-body .has-annotation'));
    assert.strictEqual(anns.length, 3, 'all 3 annotation syntaxes must render');
    assert(anns[0].querySelector('a[href="https://example.com"]'), 'markdown link inside annotation must render');
    assert(anns[0].querySelector('code'), 'inline backtick code inside annotation must be unmasked cleanly');
    assert(!doc.querySelector('#article-body sub[data-note-label]'), 'serialized sub note label should be absorbed');

    // Annotation click opens clamped popover and second click on body closes it
    anns[0].click();
    const pop = doc.querySelector('.ios-popover');
    assert(pop, 'clicking annotation should open .ios-popover');
    assert(pop.textContent.includes('包含 `code` 与 **粗体** 的批注'), 'popover should display decoded annotation text');
    doc.body.click();
    assert(!doc.querySelector('.ios-popover'), 'clicking outside should close popover');

    // 3-state tasks without raw <input> or literal [~]
    assert.strictEqual(doc.querySelectorAll('#article-body input[type="checkbox"]').length, 0, 'must not expose stripped inputs');
    assert(!doc.getElementById('article-body').textContent.includes('[~]'), 'doing marker [~] must be replaced');
    const checks = Array.from(doc.querySelectorAll('#article-body .task-check'));
    assert.deepStrictEqual(
        checks.map((el) => el.getAttribute('data-task-state')),
        ['todo', 'doing', 'done']
    );

    // Media / Image sizing / File pill
    const imgFig = doc.querySelector('#article-body figure.ios-media-frame img');
    assert(imgFig, 'dumbpad-width=360 image should wrap in figure.ios-media-frame');
    assert.strictEqual(imgFig.getAttribute('data-dumbpad-width'), '360');
    assert(imgFig.getAttribute('style').includes('min(100%, 360px)'), 'image width hint must cap at 100%');
    assert(doc.querySelector('#article-body .dumbpad-share-media video'), 'dumbpad-video=1 should upgrade to video player');
    assert(doc.querySelector('#article-body a.file-pill'), 'dumbpad-file=1 link should gain .file-pill');
    assert.strictEqual(doc.querySelectorAll('#article-body .ios-table-wrap table').length, 1, 'table must be wrapped for mobile scrolling');
    assert(fullHtml.includes('box-decoration-break: clone;') && fullHtml.includes('.markdown-body :not(pre) > code'), 'mobile share styles must wrap long inline code fragments cleanly');

    // Left rail integrates brand, utility actions & metadata (no floating banner)
    assert(!doc.querySelector('.floating-nav'), 'legacy floating-nav banner should be replaced');
    assert(doc.querySelector('#mobile-nav.mobile-topbar'), 'mobile seamless topbar should exist');
    assert(doc.querySelector('.doc-rail .rail-tools #copy-doc-btn'), 'desktop copy action should live inside sticky left rail');
    assert(doc.querySelector('.doc-rail .rail-tools #theme-btn'), 'desktop theme action should live inside sticky left rail');
    const railText = doc.querySelector('.rail-card').textContent;
    assert(railText.includes('7 次'), 'rail metadata should show editCount');

    // Mermaid blocks should upgrade into .ios-mermaid-card with stage, source box & toggles
    const mermaidCard = doc.querySelector('#article-body .ios-mermaid-card');
    assert(mermaidCard, 'mermaid code fence should upgrade to .ios-mermaid-card');
    assert(mermaidCard.querySelector('.ios-mermaid-stage'), 'mermaid card should have diagram stage');
    assert(mermaidCard.querySelector('.ios-mermaid-source pre code.language-mermaid'), 'mermaid card should preserve source block');

    // Theme toggle persistence & dark theme attribute (syncs labels across triggers)
    doc.getElementById('theme-btn').click();
    assert.strictEqual(doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.strictEqual(dom.window.localStorage.getItem('dumbpad_share_theme'), 'dark');
    assert(
        Array.from(doc.querySelectorAll('.js-theme-label')).every((el) => el.textContent === '浅色'),
        'all theme buttons should synchronize label'
    );

    // Document without headings falls back to no-toc mode with sheet header actions
    const noHeadingHtml = renderSharePage({
        notepad: { id: 'note-2', name: '纯段落', editCount: 0 },
        content: '只有一段话。',
        marked,
        sanitizeHtml
    });
    assert(/<body class="no-toc">/.test(noHeadingHtml), 'headingless note must render with no-toc body class');
    assert(noHeadingHtml.includes('class="sheet-header-actions"'), 'headingless mode should include inline header actions');

    // Leading YAML frontmatter extraction, XSS safety, and collapsible card
    const fmMarkdown = [
        '---',
        'name: dumbpad-api',
        'description: Manage DumbPad through its authenticated HTTP API. Never edit storage directly.',
        'tags: [skill, api, <script>alert(1)</script>]',
        '---',
        '',
        '# SKILL.md',
        '',
        '## DumbPad API Agent',
        '',
        '### Sub Operations',
        '',
        '##### Deep Tip',
        '',
        '正文段落。',
        '',
        '---',
        '',
        '文章底部段落。'
    ].join('\n');

    const extracted = extractFrontmatter(fmMarkdown);
    assert(extracted.frontmatterRaw.includes('name: dumbpad-api'), 'extractFrontmatter should extract YAML block');
    assert(!extracted.bodyMarkdown.trim().startsWith('---'), 'extractFrontmatter should strip leading YAML from body');
    const parsedFm = parseFrontmatterEntries(extracted.frontmatterRaw);
    assert.strictEqual(parsedFm.entries.length, 3, 'should parse all 3 top-level YAML keys');
    assert.deepStrictEqual(parsedFm.entries[2].values, ['skill', 'api', '<script>alert(1)</script>']);

    // Edge cases: ---\n---, blank-only frontmatter, unclosed frontmatter, mid-doc hr must NOT become fm-card
    assert.strictEqual(extractFrontmatter('---\n---\n正文').frontmatterRaw, null, 'adjacent --- rules must not become frontmatter');
    assert.strictEqual(extractFrontmatter('---\n   \n---\n正文').frontmatterRaw, null, 'blank-only --- delimiters must not become frontmatter');
    assert.strictEqual(extractFrontmatter('---\ntitle: Unclosed\n正文').frontmatterRaw, null, 'unclosed --- must not become frontmatter');
    assert.strictEqual(extractFrontmatter('# Title\n\n---\n\nBody').frontmatterRaw, null, 'mid-document hr must not become frontmatter');

    const fmPageHtml = renderSharePage({
        notepad: { id: 'note-fm', name: 'SKILL.md', editCount: 1 },
        content: fmMarkdown,
        marked,
        sanitizeHtml
    });
    assertSecurityInvariants(fmPageHtml);
    const fmDom = new JSDOM(fmPageHtml, { runScripts: 'dangerously', url: 'http://127.0.0.1/s/note-fm?t=abc' });
    const fmDoc = fmDom.window.document;
    const fmCard = fmDoc.querySelector('details.fm-card');
    assert(fmCard, 'frontmatter should render as collapsible details.fm-card');
    assert(!fmCard.hasAttribute('open'), 'frontmatter card should be collapsed by default');
    assert(!fmDoc.querySelector('#article-body details.fm-card'), 'frontmatter card must live outside #article-body so正文复制不受污染');
    assert(!fmDoc.querySelector('#article-body > hr:first-child'), 'leading frontmatter --- must not render as <hr> inside body');
    assert.strictEqual(fmDoc.querySelectorAll('#article-body h1').length, 0, 'duplicate leading H1 after frontmatter should still be stripped');
    assert.strictEqual(fmDoc.querySelectorAll('#article-body hr').length, 1, 'mid-document --- divider should still render cleanly');

    const fmTocLinks = Array.from(fmDoc.querySelectorAll('#rail-nav a'));
    assert.deepStrictEqual(
        fmTocLinks.map((a) => a.textContent.trim()),
        ['DumbPad API Agent', 'Sub Operations', 'Deep Tip'],
        'TOC must support H2/H3/H5 headings cleanly without polluted frontmatter Setext H2'
    );
    assert.deepStrictEqual(
        fmTocLinks.map((a) => a.getAttribute('data-depth')),
        ['0', '1', '3'],
        'TOC should normalize relative depth dynamically from document min heading level'
    );
    assert.strictEqual(fmDoc.getElementById('rail-toc-count').textContent, '3 节', 'TOC count should reflect heading count');
    assert.strictEqual(fmDoc.getElementById('toc-popover-count').textContent, '3 节', 'mobile TOC popover count should match');
    assert.strictEqual(fmTocLinks[0].getAttribute('title'), 'DumbPad API Agent', 'TOC links should expose full title tooltip');
    assert(fmTocLinks[0].querySelector('.toc-link-label'), 'TOC link label should use clamping span wrapper');
    assert.deepStrictEqual(
        fmTocLinks.map((a) => a.querySelector('.toc-level-badge')?.getAttribute('data-badge')),
        ['H2', 'H3', 'H5'],
        'TOC items should carry visual level badges via data-badge without polluting textContent'
    );
    const popBadges = Array.from(fmDoc.querySelectorAll('#toc-popover-list a .toc-level-badge')).map((b) => b.getAttribute('data-badge'));
    assert.deepStrictEqual(popBadges, ['H2', 'H3', 'H5'], 'mobile TOC popover links should render level badges too');

    const mixedHtml = renderSharePage({
        notepad: { id: 'note-mixed', name: '混排与换行', editCount: 1 },
        content: [
            '1. 有序列表测试',
            '- [ ] 待办测试',
            '- [ ] 再次测试',
            '- 无序列表',
            '',
            '普通段落测试',
            '代码块测试'
        ].join('\n'),
        marked,
        sanitizeHtml
    });
    assertSecurityInvariants(mixedHtml);
    assert(
        mixedHtml.includes('ol > li:not(.task-item)::marker'),
        'share page CSS must style ordered list markers explicitly'
    );
    assert(
        !/\.markdown-body ul\.task-list[^}]*list-style:\s*none/.test(mixedHtml),
        'share page CSS must not suppress bullets on ul.task-list parent (breaks mixed task+bullet lists)'
    );
    const mixedDoc = new JSDOM(mixedHtml, { runScripts: 'dangerously', url: 'http://127.0.0.1/s/note-mixed?t=abc' }).window.document;
    const mixedLis = Array.from(mixedDoc.querySelectorAll('#article-body ul.task-list > li'));
    assert.strictEqual(mixedLis.length, 3, 'mixed task + bullet items should render in list');
    assert(mixedLis[0].classList.contains('task-item') && mixedLis[0].querySelector('.task-check'));
    assert(mixedLis[1].classList.contains('task-item') && mixedLis[1].querySelector('.task-check'));
    assert(
        !mixedLis[2].classList.contains('task-item') && !mixedLis[2].querySelector('.task-check'),
        'non-task bullet sibling in mixed list must not be treated as task item'
    );
    const bodyPara = mixedDoc.querySelector('#article-body > p');
    assert(bodyPara && /普通段落测试<br\s*\/?>代码块测试/.test(bodyPara.innerHTML), 'single newline inside paragraph must render as <br>');
}

async function testShareRoutesHttp() {
    const secret = 'share-page-test-secret';
    const getShareToken = (id) => crypto.createHmac('sha256', secret).update(`dumbpad-share-v1:${id}`).digest('hex').slice(0, 16);
    const app = express();
    registerShareRoutes(app, {
        storage: {
            readNotepadsMeta: async () => ({
                notepads: [{ id: 'n-ok', name: 'HTTP 验证笔记', createdAt: 1700000000000, updatedAt: 1700000100000, editCount: 2 }]
            }),
            readNoteContent: async () => '## 第一节\n\n- [~] Doing item\n\n正文段落'
        },
        marked,
        baseUrl: 'https://share.example.test',
        getShareToken
    });

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
        const { port } = server.address();
        const base = `http://127.0.0.1:${port}`;
        const token = getShareToken('n-ok');

        const apiRes = await fetch(`${base}/api/share/n-ok`);
        assert.strictEqual(apiRes.status, 200);
        const apiBody = await apiRes.json();
        assert.strictEqual(apiBody.shareUrl, `https://share.example.test/s/n-ok?t=${token}`);

        const badRes = await fetch(`${base}/s/n-ok?t=invalidtoken1234`);
        assert.strictEqual(badRes.status, 403);

        const missingRes = await fetch(`${base}/s/no-such-id?t=${getShareToken('no-such-id')}`);
        assert.strictEqual(missingRes.status, 404);

        const okRes = await fetch(`${base}/s/n-ok?t=${token}`);
        assert.strictEqual(okRes.status, 200);
        assert.strictEqual(okRes.headers.get('cache-control'), 'no-store', 'HTTP share route should send Cache-Control: no-store');
        const pageHtml = await okRes.text();
        assert(pageHtml.includes('class="ios-sheet"'), 'HTTP share route should render B+C sheet layout');
        assert(pageHtml.includes('data-task-state="doing"'), 'HTTP share route should render 3-state doing task');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

(async () => {
    await testRendererUnitCases();
    await testShareRoutesHttp();
    console.log('test_share_page.js passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

