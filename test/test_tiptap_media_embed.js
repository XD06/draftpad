/**
 * 嵌入媒体回归（jsdom）：
 * 1) /file 上传落文助手 buildArticleMediaMarkdown 的形态与转义；
 * 2) parseMediaTitle 元数据解析（video/audio/非媒体）；
 * 3) isVideoFile / isAudioFile 分类（mime 优先、扩展名兜底）；
 * 4) setValue 载入：dumbpad-video/audio 占位 img 升级为 articleMedia 节点
 *    （NodeView：原生播放器 + 文件名条 + 下载/删除），getValue 往返逐字节稳定；
 * 5) insertContentAt（/file WYSIWYG 插入路径）同样升级为媒体节点；
 * 6) 不误伤：dumbpad-width 图片、dumbpad-file=1 附件链接、无元数据裸图；
 * 7) 删除按钮经 PM 事务删节点；节点属性变更（撤销/重做）重建展示 DOM。
 * 真实播放（video.play、Range 拖动）由 test/browser/media-embed.js 真机覆盖。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Range = dom.window.Range;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.getSelection = dom.window.getSelection.bind(dom.window);
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
if (!dom.window.requestAnimationFrame) dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = () => {};
}
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public/vendor/tiptap/tiptap.bundle.js'), 'utf8'));

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) console.log(`PASS ${name}`);
    else {
        failures += 1;
        console.error(`FAIL ${name}${detail !== undefined ? `\n  ${JSON.stringify(detail)}` : ''}`);
    }
};

const ASSET_ID = 'a1b2c3d4e5f64718a9b0c1d2e3f4a5b6';
const trimTrailingNewlines = (value) => String(value || '').replace(/\n+$/, '');

async function main() {
    const { HybridMarkdownEditor } = await import('../public/tiptap-editor.js');
    const { buildArticleMediaMarkdown, parseMediaTitle } = await import('../public/managers/article-file-command.js');
    const { isVideoFile, isAudioFile, isImageFile } = await import('../public/managers/asset-api-client.js');

    /* ---------------- 1. 落文助手 ---------------- */

    const videoAsset = {
        name: '片段.mp4',
        size: 12 * 1024 * 1024,
        type: 'video/mp4',
        originalUrl: `/api/assets/${ASSET_ID}/original`,
        downloadUrl: `/api/assets/${ASSET_ID}/download`,
    };
    const videoMd = buildArticleMediaMarkdown(videoAsset, 'video');
    check('video markdown follows the title-metadata precedent', videoMd
        === `![片段.mp4 · 12 MB](/api/assets/${ASSET_ID}/original "dumbpad-video=1;size=12582912;type=video%2Fmp4;name=%E7%89%87%E6%AE%B5.mp4")`,
        videoMd);
    check('video markdown prefers originalUrl over downloadUrl', videoMd.includes(`/api/assets/${ASSET_ID}/original`)
        && !videoMd.includes('/download'), videoMd);

    const audioAsset = { name: '录音.flac', size: 5 * 1024 * 1024, type: 'audio/flac', originalUrl: `/api/assets/${ASSET_ID}/original` };
    const audioMd = buildArticleMediaMarkdown(audioAsset, 'audio');
    check('audio markdown uses the audio prefix', audioMd.includes('"dumbpad-audio=1;size=5242880;type=audio%2Fflac;name=%E5%BD%95%E9%9F%B3.flac"'), audioMd);

    const escapedMd = buildArticleMediaMarkdown({
        name: 'a]b.mp4', size: 1048576, type: 'video/mp4',
        originalUrl: `/api/assets/${ASSET_ID}/original`,
    }, 'video');
    check('markdown label escapes brackets', escapedMd.startsWith('![a\\]b.mp4 · 1.0 MB]('), escapedMd);

    check('media markdown without a URL is empty', buildArticleMediaMarkdown({ name: 'x.mp4' }, 'video') === '');

    /* ---------------- 2. title 元数据解析 ---------------- */

    const parsedVideo = parseMediaTitle('dumbpad-video=1;size=12582912;type=video%2Fmp4;name=%E7%89%87%E6%AE%B5.mp4');
    check('parseMediaTitle decodes a video title', parsedVideo.kind === 'video'
        && parsedVideo.size === 12582912 && parsedVideo.type === 'video/mp4'
        && parsedVideo.name === '片段.mp4', parsedVideo);
    const parsedAudio = parseMediaTitle('dumbpad-audio=1;size=9;type=audio/ogg;name=a.ogg');
    check('parseMediaTitle recognises audio', parsedAudio?.kind === 'audio' && parsedAudio.name === 'a.ogg', parsedAudio);
    check('parseMediaTitle ignores file/image titles',
        parseMediaTitle('dumbpad-file=1;size=1') === null && parseMediaTitle('dumbpad-width=360') === null
        && parseMediaTitle('') === null);

    /* ---------------- 3. 文件分类 ---------------- */

    const file = (name, type) => ({ name, type });
    check('isVideoFile accepts video mime', isVideoFile(file('x.bin', 'video/mp4')));
    check('isVideoFile falls back to extension', isVideoFile(file('clip.mp4', '')) && isVideoFile(file('clip.webm', 'application/octet-stream')));
    check('isVideoFile rejects ordinary files', !isVideoFile(file('a.pdf', 'application/pdf')) && !isVideoFile(file('b.mkv', '')));
    check('isAudioFile accepts audio mime and extensions', isAudioFile(file('x', 'audio/mpeg')) && isAudioFile(file('song.flac', ''))
        && isAudioFile(file('voice.m4a', 'application/octet-stream')));
    check('isAudioFile rejects video', !isAudioFile(file('c.mp4', 'video/mp4')));
    check('isImageFile unchanged', isImageFile(file('d.png', 'image/png')) && !isImageFile(file('e.mp4', 'video/mp4')));

    /* ---------------- 4/5. 编辑器载入与往返 ---------------- */

    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = new HybridMarkdownEditor(container, {});
    await editor.whenReady();
    const view = editor.editor.view;

    const findMedia = () => {
        let found = null;
        editor.editor.state.doc.descendants((node, pos) => {
            if (found) return false;
            if (node.type.name === 'articleMedia') found = { node, pos };
            return true;
        });
        return found;
    };
    const renderedMedia = () => container.querySelector('.dumbpad-article-media');

    editor.setValue(videoMd, false);
    const mediaHit = findMedia();
    check('setValue upgrades dumbpad-video into an articleMedia node', Boolean(mediaHit), editor.getValue());
    check('articleMedia keeps src and title attrs', mediaHit?.node.attrs.src === `/api/assets/${ASSET_ID}/original`
        && mediaHit?.node.attrs.title === 'dumbpad-video=1;size=12582912;type=video%2Fmp4;name=%E7%89%87%E6%AE%B5.mp4',
        mediaHit?.node.attrs);
    check('articleMedia is an inline atom', mediaHit?.node.isInline === true && mediaHit?.node.type.isAtom === true,
        { inline: mediaHit?.node.isInline, atom: mediaHit?.node.type.isAtom });

    const videoDom = renderedMedia();
    check('NodeView renders a native video player with controls', Boolean(videoDom)
        && videoDom.dataset.mediaKind === 'video'
        && videoDom.querySelector('video[controls][preload="metadata"]')?.getAttribute('src') === `/api/assets/${ASSET_ID}/original`,
        videoDom?.outerHTML);
    check('meta row shows decoded name and formatted size', videoDom?.querySelector('.dumbpad-article-media-name')?.textContent === '片段.mp4 · 12 MB',
        videoDom?.querySelector('.dumbpad-article-media-name')?.textContent);
    check('download action points at the download variant', videoDom?.querySelector('.dumbpad-article-media-download')?.getAttribute('href')
        === `/api/assets/${ASSET_ID}/download`);
    check('delete action exists and is a plain button', videoDom?.querySelector('button.dumbpad-article-media-delete') instanceof dom.window.HTMLButtonElement);

    const videoRoundTrip = editor.getValue();
    check('video markdown round-trips byte-stable', trimTrailingNewlines(videoRoundTrip) === videoMd,
        { value: videoRoundTrip, expected: videoMd });
    editor.setValue(videoRoundTrip, false);
    check('second round-trip is a fixpoint', trimTrailingNewlines(editor.getValue()) === trimTrailingNewlines(videoRoundTrip),
        editor.getValue());

    editor.setValue(audioMd, false);
    const audioDom = renderedMedia();
    check('setValue upgrades dumbpad-audio with meta row above the player', audioDom?.dataset.mediaKind === 'audio'
        && audioDom.firstElementChild?.classList.contains('dumbpad-article-media-meta')
        && Boolean(audioDom.querySelector('audio[controls]')),
        audioDom?.outerHTML);
    check('audio markdown round-trips byte-stable', trimTrailingNewlines(editor.getValue()) === audioMd,
        { value: editor.getValue(), expected: audioMd });

    editor.setValue(escapedMd, false);
    check('escaped-bracket name round-trips byte-stable', trimTrailingNewlines(editor.getValue()) === escapedMd,
        { value: editor.getValue(), expected: escapedMd });

    /* ---------------- insertContentAt（/file WYSIWYG 插入路径） ---------------- */

    editor.setValue('前置文字\n', false);
    const TextSelection = globalThis.DumbPadTiptap.PM.state.TextSelection;
    const docSize = editor.editor.state.doc.content.size;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(editor.editor.state.doc, docSize - 1)));
    editor.editor.commands.insertContentAt(editor.editor.state.selection.from, videoMd);
    const inserted = findMedia();
    check('insertContentAt upgrades markdown into a media node', Boolean(inserted), editor.getValue());
    check('insertContentAt keeps surrounding text', editor.editor.state.doc.textContent.includes('前置文字'));
    check('insertContentAt output round-trips', trimTrailingNewlines(editor.getValue()).includes(videoMd),
        editor.getValue());

    /* ---------------- 6. 不误伤 ---------------- */

    editor.setValue(`![图](/api/assets/${ASSET_ID}/preview.webp "dumbpad-width=360")`, false);
    let imageCount = 0;
    editor.editor.state.doc.descendants((node) => {
        if (node.type.name === 'image') imageCount += 1;
        return true;
    });
    check('dumbpad-width images stay images', imageCount === 1 && !findMedia(), { imageCount, media: Boolean(findMedia()) });

    editor.setValue(`[手册.pdf · 1 KB](/api/assets/${ASSET_ID}/download "dumbpad-file=1;size=1024;type=application%2Fpdf;name=%E6%89%8B%E5%86%8C.pdf")`, false);
    let linkCount = 0;
    editor.editor.state.doc.descendants((node) => {
        node.marks.forEach((mark) => { if (mark.type.name === 'link') linkCount += 1; });
        return true;
    });
    check('dumbpad-file links stay attachment chips', linkCount === 1 && !findMedia(), { linkCount, media: Boolean(findMedia()) });

    editor.setValue('![裸图](/api/assets/0123456789abcdef0123456789abcdef/original.png)', false);
    check('bare images without media titles stay images', (() => {
        let names = [];
        editor.editor.state.doc.descendants((node) => { names.push(node.type.name); return true; });
        return names.includes('image') && !names.includes('articleMedia');
    })(), editor.getValue());

    /* ---------------- 7. NodeView 动作 ---------------- */

    editor.setValue(videoMd, false);
    const before = findMedia();
    check('media node present before delete', Boolean(before));
    container.querySelector('button.dumbpad-article-media-delete').click();
    check('delete button removes the node through a PM transaction', !findMedia(), editor.getValue());

    editor.setValue(`前文\n\n${videoMd}\n\n后文`, false);
    const midNode = findMedia();
    const newTitle = 'dumbpad-video=1;size=2097152;type=video%2Fmp4;name=%E7%89%87%E6%AE%B5.mp4';
    view.dispatch(view.state.tr.setNodeMarkup(midNode.pos, undefined, { ...midNode.node.attrs, title: newTitle }));
    check('attribute changes re-render the meta row (undo/redo path)',
        container.querySelector('.dumbpad-article-media-name')?.textContent === '片段.mp4 · 2.0 MB',
        container.querySelector('.dumbpad-article-media-name')?.textContent);
    check('attribute change survives round-trip', trimTrailingNewlines(editor.getValue())
        === `前文\n\n![片段.mp4 · 2.0 MB](/api/assets/${ASSET_ID}/original "${newTitle}")\n\n后文`,
        editor.getValue());

    /* ---------------- 触屏点按媒体不把焦点交给编辑器 ---------------- */
    // 触屏 pointerdown 之后浏览器补发的兼容 mousedown 会被 NodeView 的捕获
    // 监听 preventDefault（阻止 contenteditable 取焦弹软键盘）；桌面鼠标的
    // mousedown 不拦。原生播放控件响应 click / pointer 事件，不受影响。
    editor.setValue(videoMd, false);
    const mediaEl = renderedMedia().querySelector('video');
    const touchPointerDown = dom.window.document.createEvent('MouseEvent');
    touchPointerDown.initEvent('pointerdown', true, true);
    Object.defineProperty(touchPointerDown, 'pointerType', { value: 'touch' });
    mediaEl.dispatchEvent(touchPointerDown);
    const compatMouseDown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    mediaEl.dispatchEvent(compatMouseDown);
    check('touch-synthesized mousedown on media is preventDefaulted (no keyboard)',
        compatMouseDown.defaultPrevented === true);
    // 等过触屏防抖窗口（700ms）再模拟桌面鼠标按下
    await new Promise(resolve => setTimeout(resolve, 750));
    const desktopMouseDown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    mediaEl.dispatchEvent(desktopMouseDown);
    check('desktop mouse mousedown on media is not preventDefaulted',
        desktopMouseDown.defaultPrevented === false);

    console.log(failures ? `\n${failures} check(s) failed` : '\nMedia embed checks passed');
    if (failures) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
