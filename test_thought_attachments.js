const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadAttachmentHelpers() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'thought-attachments.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export const /g, 'const ')
        .replace(/export async function /g, 'async function ')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { MAX_THOUGHT_ATTACHMENT_SIZE, buildAttachmentsFromFiles, getImageAttachments, isImageAttachment };\n';
    const context = { module: { exports: {} }, exports: {}, Date, Math, Promise, Array, String };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

(async () => {
    const helpers = loadAttachmentHelpers();
    const files = [
        { name: 'cover.png', type: 'image/png', size: 1024 },
        { name: 'too-large.pdf', type: 'application/pdf', size: helpers.MAX_THOUGHT_ATTACHMENT_SIZE + 1 },
        { name: 'broken.jpg', type: 'image/jpeg', size: 2048 }
    ];
    const result = await helpers.buildAttachmentsFromFiles(files, {
        readFileAsDataURL: async file => {
            if (file.name === 'broken.jpg') throw new Error('read failed');
            return `data:${file.type};base64,AAAA`;
        },
        createId: (file, index) => `att-${index}-${file.name}`
    });

    assert.strictEqual(result.attachments.length, 1, 'valid files should survive sibling failures');
    assert.strictEqual(result.attachments[0].id, 'att-0-cover.png');
    assert.strictEqual(result.rejected.length, 2);
    assert.strictEqual(result.rejected[0].reason, 'too-large');
    assert.strictEqual(result.rejected[1].reason, 'read-error');

    const attachments = [
        result.attachments[0],
        { id: 'pdf', name: 'notes.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,AA==' },
        { id: 'legacy-image', name: 'legacy.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' }
    ];
    assert.strictEqual(helpers.isImageAttachment(attachments[0]), true);
    assert.strictEqual(helpers.isImageAttachment(attachments[1]), false);
    assert.deepStrictEqual(Array.from(helpers.getImageAttachments(attachments), item => item.id), ['att-0-cover.png', 'legacy-image']);
    console.log('Thought attachment helper checks passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
