const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const hybrid = fs.readFileSync(path.join(root, 'public', 'hybrid-editor.js'), 'utf8');
const assetClient = fs.readFileSync(path.join(root, 'public', 'managers', 'asset-api-client.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');

assert(assetClient.includes("fetch('/api/assets/files'"), 'ordinary article files should use the dedicated asset endpoint');
assert(assetClient.includes('MAX_FILE_ASSET_SIZE = 20 * 1024 * 1024'), 'the client should enforce the 20 MiB default before upload');
assert(assetClient.includes('ARTICLE_FILE_ACCEPT'), 'the native picker should use an explicit safe file allow-list');
assert(hybrid.includes("from './managers/article-file-command.js'"), 'hybrid editor should use the tested /file command helpers');
assert(hybrid.includes("input.type = 'file'") && hybrid.includes('input.multiple = true') && hybrid.includes('input.accept = ARTICLE_FILE_ACCEPT'), 'the article picker should be native and support ordered multi-select');
assert(hybrid.includes("input.addEventListener('cancel'"), 'cancelling the native picker should release the pending /file command');
assert(hybrid.includes('handleSourceFileCommand(event)') && hybrid.includes('handleWysiwygFileCommand(event)'), 'both source and WYSIWYG modes should recognise /file');
assert(hybrid.includes("this.sourceTextarea.addEventListener('keydown', this.sourceCommandKeydownHandler)"), 'source mode should own its /file keyboard handling directly on the textarea');
assert(hybrid.includes('if (this.handleSourceFileCommand(event)) return;') && hybrid.includes('handleTimeCommandKeydown(event);'), 'the source textarea should run /file before /time');
assert(hybrid.includes('if (this.sourceMode) return;'), 'the outer editor key handler must leave source-mode events to the textarea');
assert(hybrid.includes('if (this.handleWysiwygFileCommand(event)) return;'), 'the WYSIWYG /file handler should run before regular Enter handling');
assert(hybrid.includes('replaceArticleFileCommandWithPlaceholders(commandRange, tokens)') && hybrid.includes("tokens.join('\\n\\n')"), 'multi-select should atomically replace /file at its original Markdown position');
assert(hybrid.includes('this.queueArticleAssetUpload(file, { token: tokens[index], alreadyInserted: true });'), 'each selected file should reuse its own placeholder and upload task');
assert(hybrid.includes('isImage ? this.assetApi.uploadImage(file) : this.assetApi.uploadFile(file)'), 'images and ordinary files should use their separate safe upload paths');
assert(hybrid.includes('buildArticleFileMarkdown(asset)'), 'ordinary files should become portable Markdown download links');
assert(hybrid.includes("link.classList.add('dumbpad-article-file')") && hybrid.includes("link.setAttribute('download', '')"), 'marked file links should render as downloadable attachment cards');
assert(hybrid.includes("target.closest('.vditor-reset a.dumbpad-article-file')"), 'reading mode should allow attachment card clicks');
assert(styles.includes('.article-file-command-input') && styles.includes('.vditor-reset a.dumbpad-article-file'), 'the hidden picker and attachment card need isolated styles');

console.log('Article file command integration checks passed');
