export const MAX_THOUGHT_ATTACHMENT_SIZE = 4 * 1024 * 1024;
export const MAX_THOUGHT_IMAGE_SIZE = 50 * 1024 * 1024;

export function isImageAttachment(attachment) {
    const type = String(attachment?.type || '').toLowerCase();
    const dataUrl = String(attachment?.dataUrl || '').toLowerCase();
    return type.startsWith('image/') || dataUrl.startsWith('data:image/') || Boolean(attachment?.previewUrl);
}

export function getImageAttachments(attachments = []) {
    return Array.isArray(attachments) ? attachments.filter(isImageAttachment) : [];
}

export async function buildAttachmentsFromFiles(fileList, {
    readFileAsDataURL,
    maxFileSize = MAX_THOUGHT_ATTACHMENT_SIZE,
    maxImageSize = MAX_THOUGHT_IMAGE_SIZE,
    uploadImage,
    createId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
} = {}) {
    if (typeof readFileAsDataURL !== 'function') {
        throw new TypeError('readFileAsDataURL is required');
    }

    const attachments = [];
    const rejected = [];
    const files = Array.from(fileList || []);

    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const isImage = String(file?.type || '').toLowerCase().startsWith('image/');
        const limit = isImage ? maxImageSize : maxFileSize;
        if (Number(file?.size || 0) > limit) {
            rejected.push({ file, reason: 'too-large' });
            continue;
        }

        try {
            if (isImage && typeof uploadImage === 'function') {
                const asset = await uploadImage(file);
                attachments.push({
                    id: String(asset?.id || createId(file, index)),
                    assetId: String(asset?.assetId || asset?.id || ''),
                    name: String(asset?.name || file?.name || '图片'),
                    type: String(asset?.type || file?.type || 'image/*'),
                    size: Number(asset?.size || file?.size || 0),
                    previewUrl: String(asset?.previewUrl || ''),
                    originalUrl: String(asset?.originalUrl || ''),
                    downloadUrl: String(asset?.downloadUrl || '')
                });
                continue;
            }
            const dataUrl = await readFileAsDataURL(file);
            attachments.push({
                id: String(createId(file, index)),
                name: String(file?.name || '文件'),
                type: String(file?.type || 'application/octet-stream'),
                size: Number(file?.size || 0),
                dataUrl: String(dataUrl || '')
            });
        } catch (error) {
            rejected.push({ file, reason: 'read-error', error });
        }
    }

    return { attachments, rejected };
}
