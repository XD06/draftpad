const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Issue #4: switching notepads on mobile used to leave the floating action
// button (FAB) permanently hidden. The sidebar close path in selectNotepad only
// removed the `visible` classes and left body.mobile-sidebar-open in place, and
// the CSS that hides the floating actions while the sidebar is open then never
// released the FAB. Guard the centralized teardown so this cannot regress.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

assert(
    source.includes('function closeMobileSidebar()'),
    'A shared closeMobileSidebar() helper should own the mobile sidebar teardown'
);

const helperStart = source.indexOf('function closeMobileSidebar()');
const helperBody = source.slice(helperStart, helperStart + 600);
assert(
    helperBody.includes("document.body.classList.remove('mobile-sidebar-open')") &&
        helperBody.includes("getElementById('sidebar-left')?.classList.remove('visible')") &&
        helperBody.includes("getElementById('sidebar-overlay')?.classList.remove('visible')"),
    'closeMobileSidebar() must clear both the visible classes and body.mobile-sidebar-open'
);

// selectNotepad must delegate to the shared teardown, not the old partial one
// that only removed the `visible` classes and left the body flag behind.
assert(
    /\(full teardown so the FAB reappears\)\s*\n\s*closeMobileSidebar\(\);/.test(source),
    'selectNotepad should call closeMobileSidebar() when hiding the sidebar on selection'
);

console.log('Mobile FAB teardown regression checks passed');
