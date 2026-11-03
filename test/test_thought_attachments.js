const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

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

    // 非图片文件优先上传到 asset store；上传失败（离线/不支持/413）回退内联，
    // 否则附件加不上。内联形态是过去让列表/跳转载荷膨胀到 MB 级的原因。
    const uploaded = [];
    const fileResult = await helpers.buildAttachmentsFromFiles(
        [
            { name: 'report.pdf', type: 'application/pdf', size: 2048 },
            { name: 'offline.zip', type: 'application/zip', size: 2048 }
        ],
        {
            readFileAsDataURL: async file => `data:${file.type};base64,AAAA`,
            uploadFile: async file => {
                if (file.name === 'offline.zip') throw new Error('network down');
                uploaded.push(file.name);
                return {
                    id: 'asset-1',
                    assetId: 'asset-1',
                    name: 'report.pdf',
                    type: 'application/pdf',
                    size: 2048,
                    originalUrl: '/api/assets/asset-1/original',
                    downloadUrl: '/api/assets/asset-1/download'
                };
            },
            createId: (file, index) => `att-${index}-${file.name}`
        }
    );
    assert.strictEqual(fileResult.rejected.length, 0, 'both files survive');
    assert.deepStrictEqual(uploaded, ['report.pdf'], 'the uploadable file goes through the asset store');
    const pdfAttachment = fileResult.attachments[0];
    assert.strictEqual(pdfAttachment.assetId, 'asset-1');
    assert.strictEqual(pdfAttachment.id, 'att-0-report.pdf', 'the attachment instance id stays local, not the shared asset id');
    assert.notStrictEqual(pdfAttachment.id, pdfAttachment.assetId, 'instance id and asset id are independent');
    assert.strictEqual(pdfAttachment.dataUrl, undefined, 'an uploaded file carries no inline payload');
    assert.strictEqual(pdfAttachment.kind, 'file');
    assert.strictEqual(pdfAttachment.originalUrl, '/api/assets/asset-1/original');
    assert.strictEqual(pdfAttachment.downloadUrl, '/api/assets/asset-1/download');
    const zipAttachment = fileResult.attachments[1];
    assert.strictEqual(zipAttachment.dataUrl, 'data:application/zip;base64,AAAA', 'a failed upload falls back to inline');

    const thoughtsSource = fs.readFileSync(path.join(ROOT, 'public', 'managers', 'thoughts.js'), 'utf8');
    assert(
        thoughtsSource.includes('uploadFile: file => this.assetApi.uploadFile(file)'),
        'Thought attachments must wire the file upload path'
    );
    console.log('Thought attachment helper checks passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
