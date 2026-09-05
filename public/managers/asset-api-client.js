export const MAX_IMAGE_ASSET_SIZE = 50 * 1024 * 1024;
export const MAX_FILE_ASSET_SIZE = 20 * 1024 * 1024;
export const HARD_MAX_FILE_ASSET_SIZE = 100 * 1024 * 1024;
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

function normalizeMaxFileBytes(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return MAX_FILE_ASSET_SIZE;
    return Math.min(parsed, HARD_MAX_FILE_ASSET_SIZE);
}

function formatLimitMegabytes(bytes) {
    const value = Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function uploadAsset({ url, file, headers = {}, errorMessage, onProgress }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));

        const report = state => {
            if (typeof onProgress === 'function') onProgress(state);
        };
        xhr.upload.addEventListener('progress', event => {
            if (!event.lengthComputable || !event.total) return;
            const percent = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
            report({ phase: 'uploading', loaded: event.loaded, total: event.total, percent });
            if (event.loaded >= event.total) {
                report({ phase: 'processing', loaded: event.total, total: event.total, percent: 100 });
            }
        });
        xhr.addEventListener('load', () => {
            let data = {};
            try {
                data = JSON.parse(xhr.responseText || '{}');
            } catch {
                data = {};
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data);
                return;
            }
            const error = new Error(data?.error || errorMessage);
            error.status = xhr.status;
            reject(error);
        });
        xhr.addEventListener('error', () => reject(new Error(`${errorMessage}：网络连接中断`)));
        xhr.addEventListener('abort', () => reject(new Error(`${errorMessage}：上传已取消`)));
        xhr.send(file);
    });
}

export class AssetApiClient {
    constructor({ maxFileBytes = MAX_FILE_ASSET_SIZE } = {}) {
        this.maxFileBytes = normalizeMaxFileBytes(maxFileBytes);
    }

    setMaxFileBytes(value) {
        this.maxFileBytes = normalizeMaxFileBytes(value);
        return this.maxFileBytes;
    }

    async uploadImage(file, { onProgress } = {}) {
        if (!isImageFile(file)) throw new TypeError('Only image files can be uploaded');
        if (Number(file.size || 0) > MAX_IMAGE_ASSET_SIZE) {
            throw new Error('图片超过 50MB 限制');
        }

        return uploadAsset({
            url: '/api/assets/images',
            file,
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'X-Asset-Name': encodeURIComponent(safeName(file))
            },
            errorMessage: '图片上传失败',
            onProgress
        });
    }

    async uploadFile(file, { onProgress } = {}) {
        if (!file || typeof file !== 'object') throw new TypeError('A file is required');
        if (Number(file.size || 0) > this.maxFileBytes) {
            throw new Error(`文件超过 ${formatLimitMegabytes(this.maxFileBytes)}MB 限制`);
        }

        return uploadAsset({
            url: '/api/assets/files',
            file,
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Asset-Name': encodeURIComponent(safeName(file)),
                'X-Asset-Type': String(file.type || 'application/octet-stream')
            },
            errorMessage: '文件上传失败',
            onProgress
        });
    }

    async listAssets() {
        const response = await fetch('/api/assets', {
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || '无法加载附件列表');
        return Array.isArray(data.assets) ? data.assets : [];
    }

    async deleteAsset(id) {
        const assetId = String(id || '').trim();
        if (!assetId) throw new TypeError('An asset id is required');
        const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, {
            method: 'DELETE',
            credentials: 'same-origin'
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.error || '删除附件失败');
        }
        return true;
    }

    async deleteAssets(ids) {
        const list = Array.from(new Set(
            (Array.isArray(ids) ? ids : []).map(id => String(id || '').trim())
        )).filter(Boolean);
        if (list.length === 0) throw new TypeError('At least one asset id is required');
        const response = await fetch('/api/assets/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ ids: list })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || '批量删除附件失败');
        return {
            deleted: Array.isArray(data.deleted) ? data.deleted : [],
            missing: Array.isArray(data.missing) ? data.missing : []
        };
    }
}
