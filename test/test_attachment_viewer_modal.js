/**
 * 方案 A 附件浮层回归：视觉冻结（CSS 变量 / 网格 / 占位隐藏 / 动效曲线）、
 * 三个真实入口接线、真实读接口、三态状态机、ESC / 遮罩关闭与焦点回归、
 * 断网保存 error toast 且不丢输入、保存成功刷新后内容还在、复制失败提示。
 * 纯 Node + jsdom，无新增依赖。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}`);
        if (detail !== undefined) console.error(`  ${JSON.stringify(detail)}`);
    }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    /* ---------------- 1. 静态接线与视觉冻结 ---------------- */
    const index = read('public/index.html');
    const css = read('public/Assets/attachment-viewer-modal.css');
    const modalJs = read('public/managers/attachment-viewer-modal.js');
    const appJs = read('public/app.js');
    const thoughtsJs = read('public/managers/thoughts.js');
    const interactionsJs = read('public/managers/tiptap-image-interactions.js');
    const swJs = read('public/service-worker.js');
    const assetRoutes = read('routes/asset-routes.js');
    const pkg = JSON.parse(read('package.json'));

    check('modal HTML is mounted verbatim', index.includes('id="modal-a"')
        && index.includes('class="modal-container-a"')
        && index.includes('id="render-preview-a"')
        && index.includes('id="textarea-a"')
        && index.includes('id="word-count-a"')
        && index.includes('onclick="handleOverlayClick(event)"'));
    check('demo stylesheet is linked', index.includes('Assets/attachment-viewer-modal.css'));

    // 1:1 冻结：这些值与 demo 逐字相同，是分段器 x 坐标不变的关键
    check('demo CSS variables preserved', css.includes('--primary-color: #E5A100;')
        && css.includes('--radius-lg: 20px;')
        && css.includes('--shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.14);'));
    check('demo animation curve preserved', css.includes('cubic-bezier(0.16, 1, 0.3, 1)'));
    check('three-column header grid preserved',
        css.includes('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);'));
    check('save button keeps its placeholder (visibility hidden)',
        /\.btn-save-amber\.is-hidden\s*\{[^}]*visibility:\s*hidden;/.test(css));
    check('mobile save button drops out of layout (display none)',
        /@media \(max-width: 768px\)[\s\S]*\.btn-save-amber\.is-hidden\s*\{\s*display:\s*none;/.test(css));
    check('scoped demo variables do not clobber app :root', css.includes('.modal-overlay {')
        && !/^\s*:root\s*\{/m.test(css));

    check('data source uses asset-api-client URL getters',
        modalJs.includes('getAssetPreviewUrl') && modalJs.includes('getAssetOriginalUrl')
        && modalJs.includes('getAssetDownloadUrl'));
    check('toast replaced by window.toaster.show', modalJs.includes('window.toaster')
        && /toaster\.show\(text, type, false, 2200\)/.test(modalJs));
    check('markdown rendering reuses managers/preview.js',
        modalJs.includes("from './preview.js'")
        && modalJs.includes('addCopyLangButtonsToCodeBlocks')
        && modalJs.includes('loadAdditionalLanguages')
        && modalJs.includes('new Marked('));
    check('file type metadata reuses managers/file-type-icons.js',
        modalJs.includes('getFileCategory'));
    check('three-state machine preserved',
        modalJs.includes("'有未保存改动...'") && modalJs.includes("'已保存于 ' + new Date().toLocaleTimeString()")
        && modalJs.includes("'就绪'"));
    // 打开新附件时清空的是「上一篇的残留」（发生在读接口之前）；失败分支
    // 之后绝不能再碰 textarea.value，否则用户已敲的内容会被抹掉。
    check('failure keeps the textarea (no clear on error)',
        !/textarea\.value\s*=\s*''/.test(modalJs.slice(modalJs.indexOf('LOAD_ERROR_PLACEHOLDER;'))));
    check('PC header gets a download button; mobile still uses its bottom-bar one',
        index.includes('btn-download-header')
        && (index.match(/onclick="downloadActiveAttachment\(\)"/g) || []).length === 2
        && /\.modal-header-a \.btn-download-header\s*\{\s*display:\s*none;/.test(css));
    check('code blocks use a scoped high-contrast dark theme, not global github.css',
        css.includes('.modal-overlay .preview-content pre code.hljs')
        && css.includes('color: #98c379;')   // Atom One Dark 字符串（浅色主题是 #032f62 深蓝）
        && css.includes('color: #c678dd;')
        && css.includes('color: #abb2bf;'));
    check('opening a new attachment clears stale state and shows a loading placeholder',
        modalJs.includes('LOADING_PLACEHOLDER')
        && modalJs.includes('attachment-preview-placeholder')
        && /state\.currentContent\s*=\s*'';/.test(modalJs)
        && /state\.loading\s*=\s*true;/.test(modalJs)
        && css.includes('.attachment-preview-placeholder'));
    check('saving is blocked while content is not loaded (no empty PUT)',
        /if \(state\.loading \|\| state\.loadingError\)/.test(modalJs));

    check('settings entry wired to the type dispatcher', appJs.includes("data-asset-action=\"view\"")
        && appJs.includes('openAssetPreview(asset, button)'));
    check('Thought entry uses capture-phase delegation (survives every card re-render)',
        thoughtsJs.includes('installThoughtFileAttachmentDelegation')
        && thoughtsJs.includes("document.addEventListener('click'")
        && thoughtsJs.includes("closest('.thought-attachment-file')")
        && !thoughtsJs.includes("querySelectorAll('.thought-attachment-file').forEach")
        && thoughtsJs.includes("'附件预览未就绪，请刷新页面后重试'")
        && fs.readFileSync(path.join(ROOT, 'public/managers/thought-card-renderer.js'), 'utf8').includes('data-att-size')
        && fs.readFileSync(path.join(ROOT, 'public/Assets/attachment-viewer-modal.css'), 'utf8').includes('position: fixed;'));
    check('article chip entry wired', interactionsJs.includes('data-file-view')
        && interactionsJs.includes('window.openAttachmentViewer(describeArticleFileLink(link), link)'));
    check('module installed from app.js', appJs.includes('installAttachmentViewerModal()')
        && appJs.includes("from './managers/attachment-viewer-modal.js'"));

    check('new assets are in service worker CORE_ASSETS',
        swJs.includes('/Assets/attachment-viewer-modal.css')
        && swJs.includes('/managers/attachment-viewer-modal.js'));
    // 用户已明确授权改 routes/：后端改动必须只包含 /content 原地保存端点。
    check('authorized backend change is the /content read+write endpoint',
        assetRoutes.includes("app.get('/api/assets/:id/content'")
        && /app\.put\(\s*'\/api\/assets\/:id\/content'/.test(assetRoutes)
        && assetRoutes.includes('currentVersion')
        && assetRoutes.includes('withAssetContentLock'));
    check('save is a real in-place PUT, not a re-upload',
        modalJs.includes("method: 'PUT'") && modalJs.includes('X-Asset-Base-Version')
        && !modalJs.includes('uploadFile'));
    check('409 handling reuses app.js merge logic',
        modalJs.includes('mergeContents') && modalJs.includes('CONFLICT_MESSAGE')
        && modalJs.includes('response.status === 409'));
    check('localStorage bridge is fully removed',
        !modalJs.includes('localStorage') && !modalJs.includes('OVERLAY_KEY')
        && !index.includes('dumbpad_attachment_overlay_v1'));
    check('settings list drops the button and makes thumb/name the preview entry',
        appJs.includes('settings-asset-preview')
        && appJs.includes('classifyAsset')
        && appJs.includes('openNativeAssetPreview')
        && appJs.includes('ensureThoughtsManager')
        && !appJs.includes('data-asset-action="view">查看 / 编辑')
        && css.includes('.settings-asset-preview-mask')
        && css.includes('.asset-native-overlay'));
    check('settings thumb keeps flex centering (no high-specificity display:block)',
        /\.settings-asset-preview \.settings-asset-thumb-file\s*\{[^}]*display:\s*flex/.test(css)
        && /\.settings-asset-preview img\.settings-asset-thumb\s*\{[^}]*display:\s*block/.test(css)
        && !/\.settings-asset-preview \.settings-asset-thumb\s*\{[^}]*display:\s*block/.test(css));
    check('no new UI / icon / CSS / date dependency',
        !['react', 'vue', 'lucide', 'lucide-static', 'dayjs', 'date-fns', 'moment', 'bootstrap', 'tailwindcss']
            .some((dep) => dep in pkg.dependencies || dep in pkg.devDependencies));

    /* ---------------- 2. jsdom 行为回归 ---------------- */
    const start = index.indexOf('<div class="modal-overlay" id="modal-overlay"');
    const end = index.indexOf('<div id="toast-container"', start);
    const modalHtml = index.slice(start, end);
    const dom = new JSDOM(`<!doctype html><html><body>${modalHtml}<div id="toast-container"></div></body></html>`, {
        url: 'http://localhost/',
        pretendToBeVisual: true,
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.HTMLElement = dom.window.HTMLElement;
    global.getComputedStyle = dom.window.getComputedStyle;
    global.navigator = dom.window.navigator;
    global.File = dom.window.File;
    global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

    const toasts = [];
    window.toaster = {
        show(message, type, isStatic, timeoutMs) {
            toasts.push({ message, type, isStatic, timeoutMs });
            return { parentNode: null };
        },
        hide() {},
    };

    const ASSET_ID = '0123456789abcdef0123456789abcdef';
    const CONTENT_URL = `/api/assets/${ASSET_ID}/content`;
    const ORIGINAL = '# Real attachment\n\n真实正文';
    let serverContent = ORIGINAL;
    let serverVersion = 0;
    const putCalls = [];

    // 模拟 GET/PUT /api/assets/:id/content：服务端只在 baseVersion 匹配时写入。
    window.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        const okJson = (data) => ({
            ok: true, status: 200,
            json: async () => data,
            text: async () => JSON.stringify(data)
        });
        if (url === CONTENT_URL && method === 'GET') {
            return okJson({
                id: ASSET_ID, name: 'context-compaction.md', type: 'text/markdown',
                size: Buffer.byteLength(serverContent),
                contentVersion: serverVersion,
                content: serverContent
            });
        }
        if (url === CONTENT_URL && method === 'PUT') {
            const sentVersion = Number(options.headers['X-Asset-Base-Version']);
            putCalls.push({ body: String(options.body), version: sentVersion });
            if (sentVersion !== serverVersion) {
                return {
                    ok: false, status: 409,
                    json: async () => ({ error: 'conflict', currentVersion: serverVersion })
                };
            }
            if (String(options.body) === serverContent) {
                return okJson({ success: true, unchanged: true, contentVersion: serverVersion, size: serverContent.length });
            }
            serverContent = String(options.body);
            serverVersion += 1;
            return okJson({ success: true, unchanged: false, contentVersion: serverVersion, size: serverContent.length });
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    };

    const { installAttachmentViewerModal, classifyAsset } = await import('../public/managers/attachment-viewer-modal.js');
    check('installAttachmentViewerModal mounts', installAttachmentViewerModal() === true);
    check('asset type dispatch is exact',
        classifyAsset({ name: 'notes.md', type: 'text/markdown' }) === 'text'
        && classifyAsset({ name: 'data.csv', type: 'text/csv' }) === 'text'
        && classifyAsset({ name: 'a.txt', type: 'text/plain' }) === 'text'
        && classifyAsset({ name: 'photo.png', type: 'image/png' }) === 'image'
        && classifyAsset({ name: 'clip.mp4', type: 'video/mp4' }) === 'media'
        && classifyAsset({ name: 'song.mp3', type: 'audio/mpeg' }) === 'media'
        && classifyAsset({ name: 'book.pdf', type: 'application/pdf' }) === 'pdf'
        && classifyAsset({ name: 'doc.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) === 'unsupported'
        && classifyAsset({ name: 'app.exe', type: 'application/octet-stream' }) === 'unsupported'
        && classifyAsset({ name: 'bundle.zip', type: 'application/zip' }) === 'unsupported');
    check('demo inline handler names are exposed',
        ['openAttachmentViewer', 'saveFileContent', 'copyFullContent', 'triggerToast',
            'setModeA', 'handleEditorInput', 'closeModal', 'handleOverlayClick',
            'downloadActiveAttachment'].every((name) => typeof window[name] === 'function'));

    const descriptor = {
        id: ASSET_ID,
        name: 'context-compaction.md',
        type: 'text/markdown',
        size: 30100,
        originalUrl: `/api/assets/${ASSET_ID}/original`,
        downloadUrl: `/api/assets/${ASSET_ID}/download`,
    };
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const overlay = document.getElementById('modal-overlay');
    const textarea = document.getElementById('textarea-a');

    await window.openAttachmentViewer(descriptor, trigger);
    await wait(30);
    check('entry opens the same modal', overlay.classList.contains('open')
        && document.getElementById('modal-a').style.display === 'flex');
    check('real content replaces SAMPLE_MARKDOWN', textarea.value === ORIGINAL, textarea.value);
    check('real size / encoding / category replace hardcoded meta',
        document.getElementById('file-title-a').textContent === 'context-compaction.md'
        && document.querySelector('.modal-header-a .file-tag').textContent === 'MD'
        && document.querySelector('.modal-header-a .file-sub-meta').textContent
            === `${Buffer.byteLength(ORIGINAL)} B · UTF-8`,
        document.querySelector('.modal-header-a .file-sub-meta').textContent);
    check('word count is computed from real content (pure frontend)',
        document.getElementById('word-count-a').textContent === `${ORIGINAL.length} 字 · UTF-8`,
        document.getElementById('word-count-a').textContent);
    check('save state starts at 就绪', document.getElementById('save-status-text-a').textContent === '就绪');

    /* 模式切换：分段器的占位语义必须原样保留（x 坐标不变的根因） */
    const saveBtn = document.getElementById('btn-save-a');
    check('preview hides save button with .is-hidden', saveBtn.classList.contains('is-hidden'));
    window.setModeA('edit');
    check('edit shows save button', !saveBtn.classList.contains('is-hidden'));
    check('edit activates edit pane', document.getElementById('pane-edit-a').classList.contains('active'));
    window.setModeA('preview');
    check('back to preview restores .is-hidden', saveBtn.classList.contains('is-hidden'));

    /* 三态状态机 */
    textarea.value = '用户正在输入的内容';
    window.handleEditorInput();
    check('dirty state', document.getElementById('save-status-text-a').textContent === '有未保存改动...'
        && document.getElementById('status-dot-a').classList.contains('is-dirty'));
    window.setSaveState('saved');
    check('saved state includes HH:MM:SS',
        /^已保存于 /.test(document.getElementById('save-status-text-a').textContent));
    window.setSaveState('idle');
    check('idle state', document.getElementById('save-status-text-a').textContent === '就绪');

    /* ESC 与点遮罩都能关；关闭后焦点回到入口 */
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    check('ESC closes overlay', !overlay.classList.contains('open'));
    check('focus returns to entry after ESC', document.activeElement === trigger,
        document.activeElement?.tagName);
    await window.openAttachmentViewer(descriptor, trigger);
    await wait(20);
    window.handleOverlayClick({ target: overlay });
    check('overlay click closes', !overlay.classList.contains('open'));
    check('focus returns to entry after overlay click', document.activeElement === trigger);

    /* 复制失败必须提示（复用项目逻辑的失败分支） */
    toasts.length = 0;
    await window.copyFullContent();
    check('copy failure shows error toast', toasts.some((t) => t.type === 'error' && t.message === '复制失败'),
        toasts);

    /* 断网保存：error toast + 输入不丢 */
    await window.openAttachmentViewer(descriptor, trigger);
    await wait(20);
    textarea.value = '断网时用户已输入的内容';
    window.handleEditorInput();
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    toasts.length = 0;
    await window.saveFileContent();
    check('offline save shows error toast', toasts.some((t) => t.type === 'error' && /网络已断开/.test(t.message)),
        toasts);
    check('offline save keeps user input', textarea.value === '断网时用户已输入的内容', textarea.value);
    check('offline save keeps dirty state',
        document.getElementById('save-status-text-a').textContent === '有未保存改动...');
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });

    /* 409 冲突：复用 app.js 的冲突 toast，输入不丢、服务端内容不被覆盖 */
    serverContent = '另一台设备写入的远端内容';
    serverVersion = 1;
    textarea.value = '本地未保存的输入';
    window.handleEditorInput();
    toasts.length = 0;
    await window.saveFileContent();
    check('409 shows the app.js conflict toast',
        toasts.some((t) => t.type === 'error' && /内容已在其他设备更新/.test(t.message)), toasts);
    check('409 keeps user input', textarea.value === '本地未保存的输入', textarea.value);
    check('409 keeps dirty state',
        document.getElementById('save-status-text-a').textContent === '有未保存改动...');
    check('409 must not overwrite server content', serverContent === '另一台设备写入的远端内容');

    /* 保存成功 → 同一个资产 id 原地写入 → 刷新后内容还在 */
    await window.openAttachmentViewer(descriptor, trigger);
    await wait(30);
    const EDITED = '用户保存后的真实内容';
    textarea.value = EDITED;
    window.handleEditorInput();
    putCalls.length = 0;
    toasts.length = 0;
    await window.saveFileContent();
    check('successful save shows success toast',
        toasts.some((t) => t.type === 'success' && /成功保存/.test(t.message)), toasts);
    check('successful save enters saved state',
        /^已保存于 /.test(document.getElementById('save-status-text-a').textContent));
    check('save sends baseVersion read from the real interface',
        putCalls.length === 1 && putCalls[0].version === 1 && putCalls[0].body === EDITED, putCalls);
    check('save is in-place: no localStorage bridge',
        window.localStorage.getItem('dumbpad_attachment_overlay_v1') === null);
    check('save writes to the same asset, not a new upload', serverContent === EDITED && serverVersion === 2);

    await window.openAttachmentViewer(descriptor, trigger);
    await wait(30);
    check('content survives a reopen/refresh from the real read interface',
        textarea.value === EDITED, textarea.value);

    /* 下载按钮仍指向同一个资产 id（不再指向某个「新资产」） */
    let downloaded = '';
    const realClick = dom.window.HTMLAnchorElement.prototype.click;
    dom.window.HTMLAnchorElement.prototype.click = function () { downloaded = this.getAttribute('href'); };
    toasts.length = 0;
    window.downloadActiveAttachment();
    check('download uses the unchanged real asset download URL',
        downloaded === `/api/assets/${ASSET_ID}/download`, downloaded);
    dom.window.HTMLAnchorElement.prototype.click = realClick;

    /* unchanged 保存返回 contentVersion 0 时不能误把版本 +1（否则下次保存必 409） */
    serverContent = ORIGINAL;
    serverVersion = 0;
    await window.openAttachmentViewer(descriptor, trigger);
    await wait(30);
    putCalls.length = 0;
    await window.saveFileContent();
    check('byte-identical save keeps version 0',
        putCalls.length === 1 && putCalls[0].version === 0, putCalls);
    textarea.value = '随后一次真实改动';
    window.handleEditorInput();
    putCalls.length = 0;
    await window.saveFileContent();
    check('a later real save is not rejected by a bogus 409',
        putCalls.length === 1 && putCalls[0].version === 0 && serverVersion === 1,
        { putCalls, serverVersion });

    /* ---------------- 3. 连续点开多篇：不闪上一篇 + 加载守卫 ----------------
       用可控延迟的 GET 把「打开 → 读接口返回」这段窗口拉长，量清空是否发生在
       setModeA('preview') 的首次渲染之前（用户实测的「先显示前一篇再跳」）。
       jsdom 不加载 /js/marked/*，正文渲染会降级；这里只量 textarea 与占位，
       真机布局回归负责量 markdown 真正上屏后的内容。 */
    const baseFetch = window.fetch;
    let releaseRead = null;
    let holdRead = false;
    let failRead = false;
    window.fetch = async (url, options = {}) => {
        if ((options.method || 'GET') === 'GET' && url === CONTENT_URL) {
            if (holdRead) await new Promise((resolve) => { releaseRead = resolve; });
            if (failRead) {
                return { ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => '' };
            }
        }
        return baseFetch(url, options);
    };
    const previewPane = document.getElementById('render-preview-a');

    serverContent = '上一篇附件的正文 PREVIOUS-DOC';
    serverVersion = 0;
    await window.openAttachmentViewer(descriptor, trigger);
    await wait(30);
    check('baseline: first document is loaded', textarea.value === '上一篇附件的正文 PREVIOUS-DOC');

    serverContent = '当前篇 NEW-DOC';
    holdRead = true;
    const openingSecond = window.openAttachmentViewer(descriptor, trigger);
    await wait(20);
    check('opening a second document clears the stale textarea immediately',
        textarea.value === '', textarea.value);
    check('loading placeholder replaces the previous document (no stale flash)',
        previewPane.textContent.includes('正在加载附件内容')
        && !previewPane.textContent.includes('PREVIOUS-DOC'), previewPane.textContent);
    check('word count and save state reset while loading',
        document.getElementById('word-count-a').textContent === '0 字 · UTF-8'
        && document.getElementById('save-status-text-a').textContent === '就绪');

    /* 加载中禁止保存：否则会把清空后的空正文写回服务端 */
    putCalls.length = 0;
    toasts.length = 0;
    await window.saveFileContent();
    check('save is blocked while content is loading (no empty PUT)',
        putCalls.length === 0
        && toasts.some((t) => t.type === 'error' && /尚未成功加载/.test(t.message)),
        { putCalls, toasts });

    releaseRead();
    await openingSecond;
    holdRead = false;
    await wait(30);
    check('the current document reaches the textarea after the read resolves',
        textarea.value === '当前篇 NEW-DOC', textarea.value);

    /* 读取失败：error toast + 明确占位 + 用户手打内容不丢 + 不许保存空内容 */
    failRead = true;
    toasts.length = 0;
    await window.openAttachmentViewer(descriptor, trigger);
    await wait(20);
    check('read failure shows an error toast and an explicit placeholder',
        toasts.some((t) => t.type === 'error')
        && previewPane.textContent.includes('附件内容读取失败'),
        { toasts, text: previewPane.textContent });
    textarea.value = '失败后用户手打的内容';
    putCalls.length = 0;
    await window.saveFileContent();
    check('read failure keeps typed textarea content and blocks saving empty content',
        textarea.value === '失败后用户手打的内容' && putCalls.length === 0);
    failRead = false;
    window.fetch = baseFetch;

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exitCode = 1;
    } else {
        console.log('\nattachment viewer modal: all checks passed');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
