const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const styles = fs.readFileSync(path.join(root, 'public', 'Assets', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const readingFont = path.join(root, 'font', 'SourceHanSerifSC-Regular-subset.woff2');

assert(fs.existsSync(readingFont), 'the reading font subset must be present');
assert(fs.statSync(readingFont).size < 1024 * 1024, 'the reading font subset should remain under 1 MiB');
assert(styles.includes('SourceHanSerifSC-Regular-subset.woff2') && styles.includes('format("woff2")'), 'styles should use the WOFF2 reading font subset');
assert(!styles.includes('LXGWWenKai-Regular.ttf'), 'styles should not reference the former 24 MiB reading font');
assert(app.includes('STARTUP_NOTE_PREFETCH_LIMIT = 3'), 'startup note prefetch should be capped');
assert(app.includes('slice(0, STARTUP_NOTE_PREFETCH_LIMIT)'), 'startup note prefetch should only request the capped set');
assert(server.includes("const compression = require('compression');"), 'server should load response compression middleware');
assert(server.includes('app.use(compression({ threshold: 1024 }));'), 'server should enable response compression before static routes');

console.log('Startup performance regression checks passed');
