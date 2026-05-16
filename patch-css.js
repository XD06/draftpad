const fs = require('fs');

let css = fs.readFileSync('public/Assets/styles.css', 'utf8');

// 1. Add mobile sidebar styles
const mobileStyles = `
/* Mobile Sidebars */
@media (max-width: 900px) {
    .sidebar {
        display: none;
        position: fixed;
        top: 5rem;
        left: 0;
        width: 250px;
        height: calc(100vh - 5rem);
        z-index: 100;
        border-radius: 0 12px 12px 0;
    }
    .sidebar-right {
        left: auto;
        right: 0;
        border-radius: 12px 0 0 12px;
    }
    .three-column-layout {
        gap: 0;
    }
}
`;

css += mobileStyles;

// 2. Clean up old mobile styles
css = css.replace(/@media \(max-width: 585px\) \{[\s\S]*?@media \(max-width: 375px\) \{[\s\S]*?\}/, '');

fs.writeFileSync('public/Assets/styles.css', css, 'utf8');
console.log('CSS Refactoring complete');
