const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Issue #3 (read side): assets already stored on the server are listed in the
// settings asset manager, but there was no way to reference one in an article
// without re-uploading it (which created a duplicate copy). This guards the
// "insert existing asset" entry point across the editor and the settings panel.
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'hybrid-editor.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// --- Editor: a shared caret-insert primitive both modes go through ----------
assert(
    editorSource.includes('insertArticleMarkdownAtCaret(markdown)'),
    'hybrid-editor should expose a shared insertArticleMarkdownAtCaret(markdown) primitive'
);

const primitiveStart = editorSource.indexOf('insertArticleMarkdownAtCaret(markdown)');
const primitiveBody = editorSource.slice(primitiveStart, primitiveStart + 800);
assert(
    primitiveBody.includes('this.sourceMode && this.sourceTextarea') &&
        primitiveBody.includes('setRangeText(text') &&
        primitiveBody.includes('this.editor?.insertMD?.(text)'),
    'insertArticleMarkdownAtCaret must handle both source-mode and WYSIWYG insertion'
);
assert(
    /insertArticleMarkdownAtCaret\(markdown\)\s*\{[\s\S]*?return true;[\s\S]*?return canInsert;/.test(editorSource),
    'insertArticleMarkdownAtCaret must report whether the insertion was dispatched'
);

// The upload-placeholder path must delegate to the shared primitive so both
// the upload flow and the reference flow stay in sync.
assert(
    /insertArticleUploadPlaceholder\(token\)\s*\{\s*this\.insertArticleMarkdownAtCaret\(token\);\s*\}/.test(editorSource),
    'insertArticleUploadPlaceholder should delegate to insertArticleMarkdownAtCaret'
);

// --- Editor: reference an existing asset -----------------------------------
assert(
    editorSource.includes('insertArticleAssetReference(asset)'),
    'hybrid-editor should expose insertArticleAssetReference(asset)'
);
const refStart = editorSource.indexOf('insertArticleAssetReference(asset)');
const refBody = editorSource.slice(refStart, refStart + 400);
assert(
    refBody.includes("(asset.kind || 'image') === 'image'") &&
        refBody.includes('asset.previewUrl') &&
        refBody.includes('this.buildArticleImageMarkdown(asset)') &&
        refBody.includes('buildArticleFileMarkdown(asset)') &&
        refBody.includes('this.insertArticleMarkdownAtCaret('),
    'insertArticleAssetReference must pick image vs file markdown and insert it at the caret'
);

// --- App: settings asset manager wires up the "insert" action ---------------
assert(
    appSource.includes('const assetItemsById = new Map()'),
    'app.js should cache asset metadata by id for the insert action'
);
assert(
    appSource.includes('assetItemsById.clear()') && appSource.includes('assetItemsById.set(id, item)'),
    'renderAssetItems must populate assetItemsById so the insert action can look assets up'
);
assert(
    appSource.includes('data-asset-action="insert"'),
    'each asset row should render an insert action button'
);

assert(
    appSource.includes('function insertAssetIntoArticle(assetId)'),
    'app.js should define insertAssetIntoArticle(assetId)'
);
const insertStart = appSource.indexOf('function insertAssetIntoArticle(assetId)');
const insertBody = appSource.slice(insertStart, insertStart + 900);
assert(
    insertBody.includes('assetItemsById.get(') &&
        insertBody.includes('editorInstance.insertArticleAssetReference(asset)') &&
        insertBody.includes('hideModal(settingsModal)'),
    'insertAssetIntoArticle must resolve the asset, delegate to the editor, and close settings'
);
assert(
    insertBody.includes("typeof editorInstance.insertArticleAssetReference !== 'function'"),
    'insertAssetIntoArticle must guard on the editor being ready before inserting'
);

// The list click dispatcher must route the insert action to insertAssetIntoArticle.
assert(
    /assetAction === 'insert'\)\s*\{\s*event\.preventDefault\(\);\s*insertAssetIntoArticle\(item\.dataset\.assetId\);/.test(appSource),
    'the asset list click handler should dispatch the insert action'
);

console.log('Asset reference insert regression checks passed');
