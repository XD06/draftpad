const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const hybrid = fs.readFileSync(path.join(root, 'public', 'hybrid-editor.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');
const thoughts = fs.readFileSync(path.join(root, 'public', 'managers', 'thoughts.js'), 'utf8');
const attachments = fs.readFileSync(path.join(root, 'public', 'managers', 'thought-attachments.js'), 'utf8');
const assetClient = fs.readFileSync(path.join(root, 'public', 'managers', 'asset-api-client.js'), 'utf8');
const articleImageInteractionBlock = hybrid.match(/    bindArticleImageInteractions\(\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    bindArticleImageDragging/);
const articleImageMoveBlock = hybrid.match(/    moveArticleImageToTarget\(drag, dropTarget\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    isLegacyArticleImage/);
const articleImageUploadReplaceBlock = hybrid.match(/    replaceArticleUploadPlaceholder\(token, replacement\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    ensureArticleImageLightbox/);
const renderAfterMutationBlock = hybrid.match(/    renderAfterMutation\(scrollTop = 0\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    focus\(\)/);

function getMethodBody(name, nextMethod) {
    const expression = new RegExp(`    ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\r?\\n    \\}\\r?\\n\\r?\\n    ${nextMethod}`);
    const match = hybrid.match(expression);
    assert(match, `${name} should remain an independently testable editor method`);
    return match[1];
}

assert(
    assetClient.includes("url: '/api/assets/images'") && assetClient.includes('xhr.send(file);'),
    'image client should upload raw image bytes through the progress-aware asset API'
);
assert(assetClient.includes('MAX_IMAGE_ASSET_SIZE = 50 * 1024 * 1024'), 'image client should enforce the 50MB image limit');
assert(hybrid.includes('bindArticleImageInteractions()'), 'hybrid editor should bind image paste and image interactions');
assert(hybrid.includes('queueArticleImageUpload(file)'), 'article paste should upload image files');
assert(articleImageInteractionBlock?.[0].includes('event.stopImmediatePropagation?.()'), 'article paste must stop Vditor from adding a second data-url image');
assert(hybrid.includes('"dumbpad-width=720"'), 'article image markdown should persist a default display width');
assert(hybrid.includes('openArticleImageLightbox(image, assetId)'), 'reading-mode article images should open a full-image view');
assert(articleImageInteractionBlock?.[0].includes("event.target.closest('.vditor-reset img')"), 'legacy base64 article images should remain editable for cleanup');
assert(hybrid.includes('`/api/assets/${assetId}/download`'), 'article image preview should link to original download');
assert(articleImageInteractionBlock?.[0].includes('if (this.isReadingMode) {'), 'reading-mode image clicks should open the lightbox directly');
assert(!articleImageInteractionBlock?.[0].includes("this.container.addEventListener('dblclick'"), 'article image previews should not require double click');
assert(hybrid.includes('data-image-download'), 'article edit menu should provide a direct original-download action');
assert(hybrid.includes('data-image-fullscreen'), 'article edit menu should provide a full-image preview action');
assert(hybrid.includes('const centeredLeft = rect.left + ((rect.width - menuWidth) / 2);'), 'article image menu should be centered on the selected image');
assert(hybrid.includes('this.bindArticleImageDragging();'), 'article image dragging should use the guarded Vditor integration');
assert(styles.includes('user-select: none;') && styles.includes('-webkit-user-drag: none;'), 'article images should avoid browser selection tint while native dragging is disabled');
assert(!hybrid.includes('dumbpad-upload://'), 'article upload placeholders should not use a blocked custom image URL');
assert(
    articleImageMoveBlock?.[0].includes('this.getSafeArticleImageDragValue(root, drag.image)') &&
        articleImageMoveBlock?.[0].includes('moveStandaloneMarkdownBlock({') &&
        articleImageMoveBlock?.[0].includes('this.isSafeArticleImageMove(before, moved.value, drag.image)') &&
        articleImageMoveBlock?.[0].includes('this.commitArticleImageDragValue(moved.value, sourceBlock)') &&
        !articleImageMoveBlock?.[0].includes('html2md') &&
        !articleImageMoveBlock?.[0].includes('editor?.getValue') &&
        !articleImageMoveBlock?.[0].includes('this.setValue(next, true);'),
    'article image moves must reorder the exact source Markdown block without serializing the decorated DOM'
);
assert(
    hybrid.includes('let block = image;') &&
        hybrid.includes('while (block.parentElement && block.parentElement !== root)') &&
        hybrid.includes("image.closest('li, blockquote, td, th')"),
    'only standalone top-level image blocks may be reordered; nested list and table images must remain untouched'
);
assert(
    hybrid.includes('const blocks = Array.from(root?.children || []);') &&
        hybrid.includes("document.elementFromPoint(event.clientX, event.clientY)") &&
        hybrid.includes("caret.classList.add('is-block-drop-caret');"),
    'article image drop targets must snap to top-level blocks and retain the thin block-level drop indicator'
);
assert(
    hybrid.includes("sourceBlock.dispatchEvent(new InputEvent('input'") &&
        hybrid.includes("inputType: 'insertReplacementText'"),
    'a successful image move should enter Vditor through its input and undo pipeline'
);
assert(
    hybrid.includes("event.pointerType === 'mouse' && event.button !== 0") &&
        hybrid.includes("event.pointerType !== 'mouse'") &&
        hybrid.includes('this.lastArticleImageTouchTapAt = Date.now();'),
    'touch image interactions should bypass mouse-button checks and open the edit menu without waiting for a click focus'
);
assert(
    hybrid.includes("Date.now() - (this.lastArticleImageTouchTapAt || 0) < 450"),
    'the synthetic click after a touch tap should not reopen the image menu or focus the editor'
);
assert(
    styles.includes('touch-action: none;') &&
        styles.includes('@media (max-width: 768px)') &&
        styles.includes('height: 100dvh;') &&
        styles.includes('max-height: calc(100dvh - 96px);'),
    'mobile image dragging should suppress browser panning, while the lightbox uses a centered dynamic-viewport layout'
);
assert(articleImageUploadReplaceBlock?.[0].includes('setWysiwygValueAtMarkdownOffset(next, nextCaret, true);'), 'article upload replacement should preserve the established editor update path');
assert(/article-image-lightbox-download" download title="下载原图" aria-label="下载原图">\r?\n\s*<svg/.test(hybrid), 'article image lightbox controls should use icon buttons');
assert(hybrid.includes('deleteArticleImage(image)'), 'article image size menu should provide a delete action');

const getSafeArticleImageDragValue = new Function(
    `return function getSafeArticleImageDragValue(root, image) {${getMethodBody('getSafeArticleImageDragValue', 'findStandaloneArticleImageMarkdown')}}`
)();
const decoratedImageValue = getSafeArticleImageDragValue.call({
    _lastValue: '[[time:create:2026-07-17 15:30:00]]\n\n![image](/api/assets/test/preview)',
    stripDisplayGuards: value => value,
    findStandaloneArticleImageMarkdown: () => '![image](/api/assets/test/preview)'
}, {
    querySelector: () => ({ className: 'md-time-marker' })
}, {});
assert.deepStrictEqual(
    decoratedImageValue,
    {
        value: '[[time:create:2026-07-17 15:30:00]]\n\n![image](/api/assets/test/preview)',
        imageMarkdown: '![image](/api/assets/test/preview)'
    },
    'a rendered /time marker elsewhere in the article must not disable a standalone image move'
);

const moveArticleImageToTarget = new Function(
    'moveStandaloneMarkdownBlock',
    'lexMarkdown',
    `return function moveArticleImageToTarget(drag, dropTarget) {${getMethodBody('moveArticleImageToTarget', 'createArticleMoveSourceIdentity')}}`
)(() => ({ ok: true, value: 'after-with-exact-source' }), () => []);
const imageSourceBlock = { nextElementSibling: { marker: 'origin-next' } };
const imageTargetBlock = { before(block) { this.movedBlock = block; } };
const imageRoot = {
    children: [imageSourceBlock, { marker: 'middle' }, imageTargetBlock],
    contains: () => true
};
const imageMoveState = { committed: null };
assert.strictEqual(moveArticleImageToTarget.call({
    container: { querySelector: () => imageRoot },
    getArticleImageBlock: () => imageSourceBlock,
    getSafeArticleImageDragValue: () => ({ value: 'before', imageMarkdown: 'image-md' }),
    createArticleMoveDropTargetFingerprint: () => ({ index: 2 }),
    isSafeArticleImageMove: (_before, next) => next === 'after-with-exact-source',
    commitArticleImageDragValue: value => { imageMoveState.committed = value; },
    editor: { getValue: () => { throw new Error('decorated DOM must not be serialized directly'); } }
}, { image: {} }, { block: imageTargetBlock, placement: 'before' }), true, 'image movement should commit the exact source-block reorder without serializing the decorated DOM');
assert.strictEqual(imageMoveState.committed, 'after-with-exact-source', 'the exact source-block image move value should be committed');

const commitArticleImageDragValue = new Function(
    'document',
    'window',
    'InputEvent',
    `return function commitArticleImageDragValue(value, sourceBlock) {${getMethodBody('commitArticleImageDragValue', 'isLegacyArticleImage')}}`
)(
    { createRange: () => ({ selectNodeContents() {}, collapse() {} }) },
    { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    function InputEvent(type, options) { return { type, ...options }; }
);
const commitSequence = [];
const commitContext = {
    suppressNextVditorInput: () => commitSequence.push('suppress'),
    buildHeadingIndex() {},
    sourceTextarea: null,
    onInput: () => commitSequence.push('save'),
    dispatch() {},
    renderAfterMutation() {},
    container: { querySelector: () => ({ scrollTop: 0 }) }
};
commitArticleImageDragValue.call(commitContext, 'exact-source-value', {
    dispatchEvent: () => commitSequence.push('dispatch')
});
assert(
    commitSequence.indexOf('suppress') >= 0 && commitSequence.indexOf('suppress') < commitSequence.indexOf('dispatch'),
    'a programmatic block move must suppress DumbPad input serialization before dispatching Vditor\'s undo event'
);
assert.strictEqual(commitContext.preferLastValueUntilInput, true, 'a committed block move should keep getValue pinned to the exact source until the next real edit');

const handleVditorInput = new Function(
    'clearTimeout',
    `return function handleVditorInput() {${getMethodBody('handleVditorInput', 'getValue')}}`
)(() => {});
const vditorInputState = { skipped: true, handled: 0 };
handleVditorInput.call({
    skipNextVditorInput: true,
    skipNextVditorInputTimer: 1,
    isDecorating: false,
    suppressInput: false,
    isComposing: false,
    handleWysiwygInput: () => { vditorInputState.handled += 1; }
});
assert.strictEqual(vditorInputState.handled, 0, 'the delayed Vditor callback created by a block move should be skipped exactly once');

const regularVditorInputState = { handled: 0 };
const regularVditorInputContext = {
    skipNextVditorInput: false,
    preferLastValueUntilInput: true,
    isDecorating: false,
    suppressInput: false,
    isComposing: false,
    handlePendingCodeFenceInput: () => false,
    handleWysiwygInput: () => { regularVditorInputState.handled += 1; }
};
handleVditorInput.call(regularVditorInputContext);
assert.strictEqual(regularVditorInputState.handled, 1, 'the next real Vditor input should continue through the normal save path');
assert.strictEqual(regularVditorInputContext.preferLastValueUntilInput, false, 'a real edit should release the exact-value pin before normal serialization resumes');
assert(
    renderAfterMutationBlock?.[0].includes('this.decorateArticleImages();') &&
        (renderAfterMutationBlock?.[0].match(/this\.decorateArticleImages\(\);/g) || []).length >= 3,
    'Vditor async re-renders after a move should restore image and attachment drag decoration for subsequent moves'
);

const getValue = new Function(
    `return function getValue() {${getMethodBody('getValue', 'setValue')}}`
)();
assert.strictEqual(getValue.call({
    sourceMode: false,
    sourceTextarea: null,
    ready: true,
    preferLastValueUntilInput: true,
    _lastValue: 'exact-source-value',
    pendingValue: '',
    stripDisplayGuards: value => value,
    editor: { getValue: () => { throw new Error('exact block moves must not be reserialized during save checks'); } }
}), 'exact-source-value', 'save checks after a block move should read the exact committed Markdown value');
assert(
    styles.includes('.typora-editor-shell .vditor-tip') &&
        /\.typora-editor-shell \.vditor-tip[\s\S]*?top:\s*72px[\s\S]*?z-index:\s*4300/.test(styles),
    'editor tips should render below the fixed title bar and above the editor surface'
);
assert(thoughts.includes("this.quickAddInput.addEventListener('paste'"), 'Quick Add should accept pasted images');
assert(thoughts.includes("textarea.addEventListener('paste'"), 'Thought edit textarea should accept pasted images');
assert(thoughts.includes('uploadImage: file => this.assetApi.uploadImage(file)'), 'Thought image attachments should use asset storage');
assert(attachments.includes('previewUrl: String(asset?.previewUrl || \'\')'), 'Thought attachment helper should persist preview URLs');
assert(attachments.includes('originalUrl: String(asset?.originalUrl || \'\')'), 'Thought attachment helper should preserve original URLs');

console.log('Image paste integration checks passed');
