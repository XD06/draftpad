const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const hybrid = fs.readFileSync(path.join(root, 'public', 'hybrid-editor.js'), 'utf8');
const assetClient = fs.readFileSync(path.join(root, 'public', 'managers', 'asset-api-client.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');
const articleFileInteractionBlock = hybrid.match(/    bindArticleFileInteractions\(\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    bindMermaidPasteNormalization/);

function getMethodBody(name, nextMethod) {
    const expression = new RegExp(`    ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\r?\\n    \\}\\r?\\n\\r?\\n    ${nextMethod}`);
    const match = hybrid.match(expression);
    assert(match, `${name} should remain an independently testable editor method`);
    return match[1];
}

assert(assetClient.includes("url: '/api/assets/files'") && assetClient.includes('new XMLHttpRequest()'), 'ordinary article files should use the dedicated asset endpoint with upload progress support');
assert(
    assetClient.includes('HARD_MAX_FILE_ASSET_SIZE = 100 * 1024 * 1024') &&
        hybrid.includes('setAssetMaxFileBytes(value)') &&
        hybrid.includes('this.assetApi.setMaxFileBytes(value)'),
    'the editor should enforce the server-provided file limit with a 100 MiB client ceiling'
);
assert(assetClient.includes('ARTICLE_FILE_ACCEPT'), 'the native picker should use an explicit safe file allow-list');
assert(hybrid.includes("from './managers/article-file-command.js'"), 'hybrid editor should use the tested /file command helpers');
assert(hybrid.includes("input.type = 'file'") && hybrid.includes('input.multiple = true') && hybrid.includes('input.accept = ARTICLE_FILE_ACCEPT'), 'the article picker should be native and support ordered multi-select');
assert(hybrid.includes("input.addEventListener('cancel'"), 'cancelling the native picker should release the pending /file command');
assert(hybrid.includes('handleSourceFileCommand(event)') && hybrid.includes('handleWysiwygFileCommand(event)'), 'both source and WYSIWYG modes should recognise /file');
assert(
    hybrid.includes('findFileCommandInMarkdownBlock') &&
        hybrid.includes('splitTopLevelMarkdownBlocks') &&
        hybrid.includes('getCurrentWysiwygBlockCommandContext(root, range)'),
    'WYSIWYG /file should resolve through the exact top-level Markdown block instead of a whole-document DOM offset'
);
const wysiwygFileHandler = getMethodBody('handleWysiwygFileCommand', 'handleWysiwygTimeCommand');
assert(
    !wysiwygFileHandler.includes('getCurrentWysiwygMarkdownOffset()'),
    'WYSIWYG /file must not depend on whole-document html2md caret mapping when fenced code is present'
);
assert(hybrid.includes("this.sourceTextarea.addEventListener('keydown', this.sourceCommandKeydownHandler)"), 'source mode should own its /file keyboard handling directly on the textarea');
assert(hybrid.includes('if (this.handleSourceFileCommand(event)) return;') && hybrid.includes('handleTimeCommandKeydown(event);'), 'the source textarea should run /file before /time');
assert(hybrid.includes('if (this.sourceMode) return;'), 'the outer editor key handler must leave source-mode events to the textarea');
assert(hybrid.includes('if (this.handleWysiwygFileCommand(event)) return;'), 'the WYSIWYG /file handler should run before regular Enter handling');
assert(hybrid.includes('replaceArticleFileCommandWithPlaceholders(commandRange, tokens)') && hybrid.includes("tokens.join('\\n\\n')"), 'multi-select should atomically replace /file at its original Markdown position');
assert(hybrid.includes('this.queueArticleAssetUpload(file, { token: tokens[index], alreadyInserted: true });'), 'each selected file should reuse its own placeholder and upload task');
assert(
    hybrid.includes('isImage ? this.assetApi.uploadImage(file, uploadOptions) : this.assetApi.uploadFile(file, uploadOptions)'),
    'images and ordinary files should use their separate safe upload paths with the same progress contract'
);
assert(
    hybrid.includes('this.articleUploadStates = new Map()') &&
        hybrid.includes('onProgress: progress => this.updateArticleUploadState(token, progress)') &&
        hybrid.includes('decorateArticleUploadPlaceholders') &&
        hybrid.includes('protectedAncestor !== root') &&
        styles.includes('.article-upload-card') &&
        styles.includes('.article-upload-progress-fill'),
    'article uploads should show per-file byte progress without rewriting the Markdown on each update'
);
assert(hybrid.includes('buildArticleFileMarkdown(asset)'), 'ordinary files should become portable Markdown download links');
assert(hybrid.includes("link.classList.add('dumbpad-article-file')") && hybrid.includes("link.setAttribute('download', '')"), 'marked file links should render as downloadable attachment cards');
assert(hybrid.includes("target.closest('.vditor-reset a.dumbpad-article-file')"), 'reading mode should allow attachment card clicks');
assert(styles.includes('.article-file-command-input') && styles.includes('.vditor-reset a.dumbpad-article-file'), 'the hidden picker and attachment card need isolated styles');
assert(hybrid.includes('this.bindArticleFileInteractions();'), 'ordinary article files should use guarded editor interactions instead of browser-native drag and drop');
assert(
    articleFileInteractionBlock?.[0].includes("event.target.closest('.vditor-reset a.dumbpad-article-file')") &&
        articleFileInteractionBlock?.[0].includes("event.preventDefault();"),
    'ordinary attachment drag starts should be intercepted before contenteditable can copy the link'
);
assert(
        articleFileInteractionBlock?.[0].includes('this.bindArticleFileDragging();') &&
        hybrid.includes('getArticleFileBlock(link, root)') &&
        hybrid.includes('moveArticleFileToTarget(drag, dropTarget)') &&
        hybrid.includes('isSafeArticleFileMove(before, moved.value, drag.file)'),
    'a standalone attachment should use guarded pointer movement and reject a result that is not a true Markdown move'
);
assert(
    hybrid.includes('ensureArticleFileMenu()') &&
        hybrid.includes('data-file-download') &&
        hybrid.includes('data-file-delete') &&
        hybrid.includes('deleteArticleFile(link)') &&
        hybrid.includes("menu.setAttribute('aria-label', '附件操作')"),
    'editing an attachment should expose accessible icon-only download and delete actions'
);
assert(
    styles.includes('.article-file-menu') &&
        styles.includes('.article-file-download') &&
        styles.includes('.article-file-delete'),
    'attachment action controls should have dedicated menu styles instead of borrowing text-button styling'
);
assert(
    /this\.container\.addEventListener\('click', event => \{[\s\S]*?this\.openArticleFileMenu\(link\);[\s\S]*?\}, true\);/.test(articleFileInteractionBlock?.[0] || '') &&
        articleFileInteractionBlock?.[0].includes('event.preventDefault();') &&
        articleFileInteractionBlock?.[0].includes('event.stopImmediatePropagation?.();'),
    'attachment card clicks must intercept Vditor before it opens the download link'
);
assert(
    articleFileInteractionBlock?.[0].includes("this.container.addEventListener('pointerup', finishPointerDrag);") &&
        articleFileInteractionBlock?.[0].includes("this.container.addEventListener('pointercancel', finishPointerDrag);") &&
        !articleFileInteractionBlock?.[0].includes("this.container.addEventListener('pointerup', finishPointerDrag, true);") &&
        articleFileInteractionBlock?.[0].includes("if (event.pointerType !== 'mouse') event.preventDefault();"),
    'attachment pointer input should follow the proven image drag event semantics instead of competing capture-phase handlers'
);
assert(
    !/this\.container\.addEventListener\('pointermove', event => \{[\s\S]*?\}, true\);/.test(articleFileInteractionBlock?.[0] || ''),
    'attachment pointer movement should not stop Vditor and the existing image drag controller in the capture phase'
);
assert(
    hybrid.includes('scheduleArticleAssetMoveRetry({') &&
        hybrid.includes("kind: 'file'") &&
        hybrid.includes("kind: 'image'") &&
        hybrid.includes('resolveArticleMoveDropTarget(root, targetFingerprint)'),
    'a stale legacy-article DOM should get one guarded re-render retry instead of immediately rejecting an otherwise safe asset move'
);

const getArticleFileBlock = new Function('link', 'root', getMethodBody('getArticleFileBlock', 'startArticleFileDragAutoScroll'));
const dragRoot = { marker: 'root' };
const dragLink = {
    textContent: '📎 roadmap.txt',
    closest: () => null
};
const dragBlock = {
    parentElement: dragRoot,
    textContent: '\u200B📎 roadmap.txt',
    querySelectorAll: selector => selector === 'a.dumbpad-article-file' ? [dragLink] : [],
    matches: () => false
};
dragLink.parentElement = dragBlock;
assert.strictEqual(
    getArticleFileBlock(dragLink, dragRoot),
    dragBlock,
    'a Vditor zero-width guard must not make a standalone attachment ineligible for dragging'
);

const deleteArticleFile = new Function(
    'document',
    `return function deleteArticleFile(link) {${getMethodBody('deleteArticleFile', 'bindTimeCommand')}}`
)({ createTextNode: value => ({ nodeType: 3, nodeValue: value }) });
const deletedBlock = {
    textContent: '📎 roadmap.txt',
    removed: false,
    remove() { this.removed = true; }
};
const deletedLink = {
    isConnected: true,
    closest: () => deletedBlock,
    replaceWith(node) { this.replacement = node; }
};
const deleteState = { hidden: false, notified: false, focused: false, caret: null };
deleteArticleFile.call({
    hideArticleFileMenu() { deleteState.hidden = true; },
    notifyEditorValueChanged() { deleteState.notified = true; },
    editor: { focus() { deleteState.focused = true; } },
    placeCaretInTextNode(node) { deleteState.caret = node; }
}, deletedLink);
assert.strictEqual(deletedLink.replacement?.nodeValue, '\u200B', 'deleting an attachment should leave an editable zero-width caret guard in its original block');
assert.strictEqual(deletedBlock.removed, false, 'deleting a standalone attachment should preserve its editable block instead of collapsing selection to the editor start');
assert.strictEqual(deleteState.caret, deletedLink.replacement, 'deleting an attachment should restore the caret at the retained guard');
assert(deleteState.hidden && deleteState.notified && deleteState.focused, 'deleting an attachment should preserve existing menu, save, and focus behavior');

const getSafeArticleFileDragValue = new Function(
    `return function getSafeArticleFileDragValue(root, link) {${getMethodBody('getSafeArticleFileDragValue', 'findStandaloneArticleFileMarkdown')}}`
)();
const decoratedFileValue = getSafeArticleFileDragValue.call({
    _lastValue: '[[time:create:2026-07-17 15:30:00]]\n\n[file](/api/assets/test/download "dumbpad-file=1")',
    stripDisplayGuards: value => value,
    findStandaloneArticleFileMarkdown: () => '[file](/api/assets/test/download "dumbpad-file=1")'
}, {
    querySelector: () => ({ className: 'md-time-marker' })
}, {});
assert.deepStrictEqual(
    decoratedFileValue,
    {
        value: '[[time:create:2026-07-17 15:30:00]]\n\n[file](/api/assets/test/download "dumbpad-file=1")',
        fileMarkdown: '[file](/api/assets/test/download "dumbpad-file=1")'
    },
    'a rendered /time marker elsewhere in the article must not disable a standalone attachment move'
);

const moveArticleFileToTarget = new Function(
    'moveStandaloneMarkdownBlock',
    'lexMarkdown',
    `return function moveArticleFileToTarget(drag, dropTarget) {${getMethodBody('moveArticleFileToTarget', 'getSafeArticleFileDragValue')}}`
)(() => ({ ok: true, value: 'after-with-exact-source' }), () => []);
const fileSourceBlock = { nextElementSibling: { marker: 'origin-next' } };
const fileTargetBlock = { before(block) { this.movedBlock = block; } };
const fileRoot = {
    children: [fileSourceBlock, { marker: 'middle' }, fileTargetBlock],
    contains: () => true
};
const fileMoveState = { committed: null };
assert.strictEqual(moveArticleFileToTarget.call({
    container: { querySelector: () => fileRoot },
    getArticleFileBlock: () => fileSourceBlock,
    getSafeArticleFileDragValue: () => ({ value: 'before', fileMarkdown: 'file-md' }),
    createArticleMoveDropTargetFingerprint: () => ({ index: 2 }),
    isSafeArticleFileMove: (_before, next) => next === 'after-with-exact-source',
    commitArticleImageDragValue: value => { fileMoveState.committed = value; },
    editor: { getValue: () => { throw new Error('decorated DOM must not be serialized directly'); } }
}, { file: {} }, { block: fileTargetBlock, placement: 'before' }), true, 'attachment movement should commit the exact source-block reorder without serializing the decorated DOM');
assert.strictEqual(fileMoveState.committed, 'after-with-exact-source', 'the exact source-block attachment move value should be committed');

console.log('Article file command integration checks passed');
