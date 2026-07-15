const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const hybrid = fs.readFileSync(path.join(root, 'public', 'hybrid-editor.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');
const thoughts = fs.readFileSync(path.join(root, 'public', 'managers', 'thoughts.js'), 'utf8');
const attachments = fs.readFileSync(path.join(root, 'public', 'managers', 'thought-attachments.js'), 'utf8');
const assetClient = fs.readFileSync(path.join(root, 'public', 'managers', 'asset-api-client.js'), 'utf8');
const articleImageInteractionBlock = hybrid.match(/    bindArticleImageInteractions\(\) \{[\s\S]*?\n    \}\n\n    getArticleAssetId/);
const articleImageMoveBlock = hybrid.match(/    moveArticleImageToTarget\(drag, dropTarget\) \{[\s\S]*?\n    \}\n\n    isLegacyArticleImage/);
const articleImageUploadReplaceBlock = hybrid.match(/    replaceArticleUploadPlaceholder\(token, replacement\) \{[\s\S]*?\n    \}\n\n    ensureArticleImageLightbox/);

assert(assetClient.includes("fetch('/api/assets/images'"), 'image client should upload raw image bytes through the asset API');
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
        articleImageMoveBlock?.[0].includes('this.isSafeArticleImageMove(before, next, drag.image)') &&
        articleImageMoveBlock?.[0].includes('this.commitArticleImageDragValue(next, sourceBlock)') &&
        !articleImageMoveBlock?.[0].includes('html2md') &&
        !articleImageMoveBlock?.[0].includes('this.setValue(next, true);'),
    'article image moves must use Vditor DOM serialization only after a source-preservation guard passes'
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
assert(hybrid.includes('article-image-lightbox-download" download title="下载原图" aria-label="下载原图">\n                    <svg'), 'article image lightbox controls should use icon buttons');
assert(hybrid.includes('deleteArticleImage(image)'), 'article image size menu should provide a delete action');
assert(thoughts.includes("this.quickAddInput.addEventListener('paste'"), 'Quick Add should accept pasted images');
assert(thoughts.includes("textarea.addEventListener('paste'"), 'Thought edit textarea should accept pasted images');
assert(thoughts.includes('uploadImage: file => this.assetApi.uploadImage(file)'), 'Thought image attachments should use asset storage');
assert(attachments.includes('previewUrl: String(asset?.previewUrl || \'\')'), 'Thought attachment helper should persist preview URLs');
assert(attachments.includes('originalUrl: String(asset?.originalUrl || \'\')'), 'Thought attachment helper should preserve original URLs');

console.log('Image paste integration checks passed');
