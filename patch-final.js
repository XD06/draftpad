const fs = require('fs');

let appJs = fs.readFileSync('public/app.js', 'utf8');

// 1. Fix applySettings
appJs = appJs.replace(
    /function applySettings\(currentSettings\) \{[\s\S]*?const previewMode = currentSettings\.defaultMarkdownPreviewMode \|\| 'off';[\s\S]*?previewManager\.toggleMarkdownPreview\(false, previewMode, false\);[\s\S]*?\};/,
    `function applySettings(currentSettings) {
        if (!currentSettings) return;
        const previewMode = currentSettings.defaultMarkdownPreviewMode || 'off';
        if (previewManager.toggleMarkdownPreview) {
            previewManager.toggleMarkdownPreview(false, previewMode, false);
        }
    };`
);

fs.writeFileSync('public/app.js', appJs, 'utf8');
console.log('Final app.js fix complete');
