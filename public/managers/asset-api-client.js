export const MAX_IMAGE_ASSET_SIZE = 50 * 1024 * 1024;
export const MAX_FILE_ASSET_SIZE = 20 * 1024 * 1024;
export const ARTICLE_FILE_ACCEPT = 'image/*,.pdf,.txt,.md,.markdown,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.mp3,.m4a,.wav,.ogg,.flac,.mp4,.mov,.webm,.zip,.rar,.7z';

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

    async uploadFile(file) {
        if (!file || typeof file !== 'object') throw new TypeError('A file is required');
        if (Number(file.size || 0) > MAX_FILE_ASSET_SIZE) {
            throw new Error('文件超过 20MB 限制');
        }

        const response = await fetch('/api/assets/files', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Asset-Name': encodeURIComponent(safeName(file)),
                'X-Asset-Type': String(file.type || 'application/octet-stream')
            },
            body: file
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data?.error || '文件上传失败');
            error.status = response.status;
            throw error;
        }
        return data;
    }
}
