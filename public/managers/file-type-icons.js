/**
 * 文件类型与精致图标引擎：基于文件名扩展名与 MIME 类型识别附件类型，
 * 提供契合主题的无依赖原生 SVG 矢量图标、分类色彩与缩略图卡片渲染。
 * 覆盖 PDF、Word、表格、PPT、代码、压缩包、音视频、文本文档与通用文件。
 */

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const FILE_CATEGORIES = {
    pdf: {
        id: 'pdf',
        name: 'PDF 文档',
        badge: 'PDF',
        color: '#e74c3c',
        darkColor: '#ff6b6b',
    },
    word: {
        id: 'word',
        name: 'Word 文档',
        badge: 'DOC',
        color: '#2980b9',
        darkColor: '#48dbfb',
    },
    sheet: {
        id: 'sheet',
        name: '电子表格',
        badge: 'XLS',
        color: '#27ae60',
        darkColor: '#1dd1a1',
    },
    slide: {
        id: 'slide',
        name: '演示文稿',
        badge: 'PPT',
        color: '#e67e22',
        darkColor: '#f39c12',
    },
    archive: {
        id: 'archive',
        name: '压缩包',
        badge: 'ZIP',
        color: '#8e44ad',
        darkColor: '#a29bfe',
    },
    code: {
        id: 'code',
        name: '代码文件',
        badge: 'CODE',
        color: '#0097e6',
        darkColor: '#0abde3',
    },
    audio: {
        id: 'audio',
        name: '音频文件',
        badge: 'AUDIO',
        color: '#16a085',
        darkColor: '#00d2d3',
    },
    video: {
        id: 'video',
        name: '视频文件',
        badge: 'VIDEO',
        color: '#c0392b',
        darkColor: '#ee5253',
    },
    text: {
        id: 'text',
        name: '文本文档',
        badge: 'TXT',
        color: '#7f8c8d',
        darkColor: '#8395a7',
    },
    image: {
        id: 'image',
        name: '图片',
        badge: 'IMG',
        color: '#e67e22',
        darkColor: '#f39c12',
    },
    file: {
        id: 'file',
        name: '文件附件',
        badge: 'FILE',
        color: 'var(--primary-color, #4a69bd)',
        darkColor: 'var(--primary-color, #54a0ff)',
    },
};

/**
 * 根据文件名和 MIME 类型解析文件类别元数据
 */
export function getFileCategory(filename = '', mimeType = '') {
    const rawName = String(filename || '');
    const ext = (rawName.includes('.') ? rawName.split('.').pop() || '' : '').toLowerCase();
    const mime = String(mimeType || '').toLowerCase();

    // 1. PDF
    if (ext === 'pdf' || mime === 'application/pdf') {
        return { ...FILE_CATEGORIES.pdf, ext: 'pdf' };
    }

    // 2. Word / 办公文档
    if (
        ['doc', 'docx', 'odt', 'rtf', 'wps', 'pages'].includes(ext)
        || mime.includes('wordprocessingml')
        || mime.includes('msword')
        || mime.includes('officedocument.word')
    ) {
        return { ...FILE_CATEGORIES.word, badge: ext === 'doc' ? 'DOC' : 'DOCX', ext };
    }

    // 3. 电子表格
    if (
        ['xls', 'xlsx', 'csv', 'tsv', 'ods', 'numbers'].includes(ext)
        || mime.includes('spreadsheetml')
        || mime.includes('ms-excel')
        || mime === 'text/csv'
    ) {
        return { ...FILE_CATEGORIES.sheet, badge: ext === 'csv' ? 'CSV' : (ext === 'xls' ? 'XLS' : 'XLSX'), ext };
    }

    // 4. 演示文稿
    if (
        ['ppt', 'pptx', 'odp', 'key', 'keynote'].includes(ext)
        || mime.includes('presentationml')
        || mime.includes('ms-powerpoint')
    ) {
        return { ...FILE_CATEGORIES.slide, badge: ext === 'ppt' ? 'PPT' : 'PPTX', ext };
    }

    // 5. 压缩包 / 归档
    if (
        ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst'].includes(ext)
        || mime.includes('zip')
        || mime.includes('compressed')
        || mime.includes('archive')
        || mime.includes('tar')
        || mime.includes('gzip')
    ) {
        return { ...FILE_CATEGORIES.archive, badge: ext.slice(0, 4).toUpperCase() || 'ZIP', ext };
    }

    // 6. 代码 / 脚本 / 配置文件
    if (
        ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'json', 'yaml', 'yml', 'toml',
         'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'sh', 'bash', 'zsh',
         'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'kt', 'kts', 'sql',
         'php', 'rb', 'lua', 'vue', 'swift', 'r', 'dart'].includes(ext)
        || mime.includes('javascript')
        || mime.includes('json')
        || mime.includes('xml')
        || mime.startsWith('text/x-')
    ) {
        const badge = ['js', 'ts', 'py', 'json', 'html', 'css', 'sql', 'go', 'rs', 'c', 'cpp', 'java'].includes(ext)
            ? ext.toUpperCase()
            : '</>';
        return { ...FILE_CATEGORIES.code, badge, ext };
    }

    // 7. 音频
    if (
        ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'opus', 'mid', 'midi'].includes(ext)
        || mime.startsWith('audio/')
    ) {
        return { ...FILE_CATEGORIES.audio, badge: ext.slice(0, 4).toUpperCase() || 'AUD', ext };
    }

    // 8. 视频
    if (
        ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp'].includes(ext)
        || mime.startsWith('video/')
    ) {
        return { ...FILE_CATEGORIES.video, badge: ext.slice(0, 4).toUpperCase() || 'VID', ext };
    }

    // 9. 纯文本 / Markdown
    if (
        ['txt', 'log', 'md', 'markdown', 'text', 'ini', 'conf', 'env'].includes(ext)
        || mime === 'text/plain'
        || mime === 'text/markdown'
    ) {
        return { ...FILE_CATEGORIES.text, badge: ext === 'md' ? 'MD' : 'TXT', ext };
    }

    // 10. 图片
    if (
        ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'].includes(ext)
        || mime.startsWith('image/')
    ) {
        return { ...FILE_CATEGORIES.image, badge: ext.slice(0, 4).toUpperCase() || 'IMG', ext };
    }

    // 通用回退
    const badge = ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
    return { ...FILE_CATEGORIES.file, badge, ext };
}

/**
 * 生成对应类别的精致 SVG 矢量图形（24x24 视口，纯矢量无依赖）
 */
export function getFileIconSvg(categoryOrName, mimeType = '', { size = 22, className = '' } = {}) {
    const cat = (typeof categoryOrName === 'object' && categoryOrName?.id)
        ? categoryOrName
        : getFileCategory(categoryOrName, mimeType);

    const base = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>';
    let inner = '';

    switch (cat.id) {
        case 'pdf':
            // 经典折角文档 + PDF 标志性书签带与字母形态
            inner = '<path d="M9 13v5M9 13h1.8a1.6 1.6 0 0 1 0 3.2H9M13.5 13h1.5a2 2 0 0 1 0 4h-1.5v-4z"/>';
            break;
        case 'word':
            // 文档段落横线
            inner = '<line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>';
            break;
        case 'sheet':
            // 电子表格网格
            inner = '<rect x="8" y="12" width="8" height="6" rx="0.5"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="8" y1="15" x2="16" y2="15"/>';
            break;
        case 'slide':
            // 演示文稿幻灯片/图表
            inner = '<circle cx="12" cy="15" r="3"/><line x1="12" y1="12" x2="12" y2="15"/><line x1="12" y1="15" x2="14" y2="15"/>';
            break;
        case 'archive':
            // 压缩包拉链与卡扣
            inner = '<line x1="12" y1="11" x2="12" y2="12"/><line x1="10" y1="12" x2="12" y2="12"/><line x1="12" y1="14" x2="14" y2="14"/><rect x="10.5" y="17" width="3" height="3" rx="0.5"/>';
            break;
        case 'code':
            // 代码括号 </ >
            inner = '<polyline points="10 13 8 15 10 17"/><polyline points="14 13 16 15 14 17"/>';
            break;
        case 'audio':
            // 音频音符
            inner = '<circle cx="10" cy="16" r="2"/><circle cx="15" cy="15" r="2"/><path d="M12 16v-4l5-1v4"/>';
            break;
        case 'video':
            // 视频播放三角
            inner = '<polygon points="10 12 16 15 10 18 10 12" fill="currentColor" stroke="none"/>';
            break;
        case 'image':
            // 图像山水/太阳
            inner = '<circle cx="10" cy="13" r="1.5"/><path d="m18 18-4-4-5 5"/>';
            break;
        case 'text':
            // 文本行
            inner = '<line x1="16" y1="13" x2="8" y2="13"/><line x1="13" y1="17" x2="8" y2="17"/>';
            break;
        default:
            // 通用折角文件
            inner = '<line x1="12" y1="13" x2="12" y2="17"/><line x1="10" y1="15" x2="14" y2="15"/>';
            break;
    }

    const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${classAttr}>${base}${inner}</svg>`;
}

/**
 * 渲染附件管理列表项（settings-asset-item）的缩略图 HTML
 */
export function renderAssetThumbHtml(item = {}) {
    const isImage = (item.kind || 'image') === 'image' && item.previewUrl;
    if (isImage) {
        return `<img class="settings-asset-thumb" src="${escapeHtml(item.previewUrl)}" alt="" loading="lazy" />`;
    }

    const name = item.name || '未命名附件';
    const type = item.type || '';
    const cat = getFileCategory(name, type);
    const svg = getFileIconSvg(cat, '', { size: 22, className: 'settings-asset-icon-svg' });

    return `
        <div class="settings-asset-thumb settings-asset-thumb-file" data-file-category="${escapeHtml(cat.id)}" style="--file-theme: ${cat.color};" aria-label="${escapeHtml(cat.name)}" title="${escapeHtml(cat.name)}">
            ${svg}
            <span class="settings-asset-thumb-badge">${escapeHtml(cat.badge)}</span>
        </div>
    `.trim();
}
