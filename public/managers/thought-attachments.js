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
    uploadFile,
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
                    // Attachment instance id stays local: two identical images
                    // dedupe to one asset, and reusing the asset id here made
                    // "remove one attachment" delete every copy of it.
                    id: String(createId(file, index)),
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
            // Non-image files go to the file asset store as well: an inline
            // base64 payload (up to 4MB → ~5.3MB) would otherwise be carried by
            // every Thought list/jump response and grow the collection forever.
            // Upload failure (offline, unsupported type, 413) falls back to the
            // inline form, which the outbox replays once the device is online.
            if (!isImage && typeof uploadFile === 'function') {
                try {
                    const asset = await uploadFile(file);
                    if (asset?.id) {
                        attachments.push({
                            // Same rule as images: the instance id is local, the
                            // asset id is shared by hash dedupe.
                            id: String(createId(file, index)),
                            assetId: String(asset.assetId || asset.id || ''),
                            name: String(asset.name || file?.name || '文件'),
                            type: String(asset.type || file?.type || 'application/octet-stream'),
                            size: Number(asset.size || file?.size || 0),
                            kind: 'file',
                            previewUrl: String(asset.previewUrl || ''),
                            originalUrl: String(asset.originalUrl || ''),
                            downloadUrl: String(asset.downloadUrl || '')
                        });
                        continue;
                    }
                } catch (_error) {
                    // fall through to the inline path
                }
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
