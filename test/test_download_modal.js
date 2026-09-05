const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

assert(index.includes('id="download-modal" class="modal" role="dialog"'), 'download dialog should expose modal semantics');
assert(index.includes('id="download-close"'), 'download dialog should include an explicit close action');
assert(index.includes('class="download-format-grid"'), 'download formats should be grouped independently from modal actions');
assert(index.includes('id="download-md"') && index.includes('id="download-txt"') && index.includes('id="download-zip"'), 'all three download format actions must remain available');
assert(index.includes('id="download-cancel" class="download-modal-cancel"'), 'cancel should remain available as a secondary footer action');
assert(styles.includes('#download-modal .download-format-grid') && styles.includes('repeat(3, minmax(0, 1fr))'), 'desktop download formats should use equal columns');
assert(styles.includes('@media (max-width: 560px)') && styles.includes('#download-modal .download-format-grid'), 'download formats should have a mobile layout');
assert(styles.includes('white-space: nowrap;'), 'format details should not split into a vertical ZIP label');
assert(app.includes('const downloadClose = document.getElementById(\'download-close\');'), 'download close control should be initialized');
assert(app.includes('showModal(downloadModal, downloadClose)'), 'opening the download dialog should focus its close control');
assert(app.includes('downloadZip.addEventListener'), 'archive export should retain its event binding');
assert(app.includes('downloadModal.addEventListener(\'keydown\''), 'download dialog should retain keyboard focus within itself');

console.log('Download modal checks passed');
