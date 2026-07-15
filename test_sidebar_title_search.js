const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const sidebar = fs.readFileSync(path.join(root, 'public', 'sidebar.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');

assert(html.includes('id="directory-search-toggle"'), 'directory header should expose a search toggle');
assert(html.includes('id="directory-search-input"'), 'directory search should have an accessible text input');
assert(html.includes('class="directory-search-field"'), 'directory search controls should render as one compact field');
assert(styles.includes('.directory-search-field'), 'directory search field should have dedicated compact styling');
assert(sidebar.includes("String(pad?.name || '').toLocaleLowerCase().includes(query)"), 'directory search must filter only by Notepad name');
assert(sidebar.includes("const isCollapsed = query ? false"), 'matching directory groups should expand while searching');
assert(app.includes('function setupDirectoryTitleSearch()'), 'app should initialize directory title search once');
assert(app.includes('directorySearchQuery = input.value.trim();'), 'search input should update the local render query');
assert(app.includes('renderSidebar(currentNotepads, selectedId, selectNotepad, deleteNotepadById, renameNotepadById, toggleNotepadPin, directorySearchQuery)'), 'sidebar rerenders should retain the active title query');

console.log('Directory title search checks passed');
