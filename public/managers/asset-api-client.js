export const MAX_IMAGE_ASSET_SIZE = 50 * 1024 * 1024;

function safeName(file) {
    return String(file?.name || 'image').trim() || 'image';
}

export function isImageFile(file) {
    return String(file?.type || '').toLowerCase().startsWith('image/');
}

export function getAssetPreviewUrl(attachment = {}) {
    return String(attachment.previewUrl || attachment.dataUrl || '');
}

export function getAssetOriginalUrl(attachment = {}) {
    return String(attachment.originalUrl || attachment.dataUrl || '');
}

export function getAssetDownloadUrl(attachment = {}) {
    return String(attachment.downloadUrl || attachment.originalUrl || attachment.dataUrl || '');
}

export class AssetApiClient {
    async uploadImage(file) {
        if (!isImageFile(file)) throw new TypeError('Only image files can be uploaded');
        if (Number(file.size || 0) > MAX_IMAGE_ASSET_SIZE) {
            throw new Error('图片超过 50MB 限制');
        }

        const response = await fetch('/api/assets/images', {
            method: 'POST',
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'X-Asset-Name': encodeURIComponent(safeName(file))
            },
            body: file
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data?.error || '图片上传失败');
            error.status = response.status;
            throw error;
        }
        return data;
    }
}
