/**
 * DumbPad 静态资源渲染态 HTML 快照缓存：仅保存只读预渲染结构用于 0ms 首帧呈现，
 * 与本地同步真值（dumbpad_startup_cache_v1）物理隔离，签名严格一致才展示。
 */
export const RENDERED_SNAPSHOT_STORAGE_KEY = 'dumbpad_rendered_html_v1';
export const RENDERED_SNAPSHOT_VERSION = 1;
export const MAX_CACHED_ARTICLES = 3;
export const MAX_SINGLE_HTML_CHARS = 250000;
export const MAX_TOTAL_HTML_CHARS = 450000;

const TRANSIENT_SELECTOR = [
    '.ProseMirror-gapcursor',
    '.tiptap-upload-placeholder',
    '.tiptap-selection-menu',
    'script',
    'iframe',
    'object',
    'embed',
    'style',
    'link',
    'meta',
].join(', ');

const TRANSIENT_CLASSES = [
    'ProseMirror-selectednode',
    'ProseMirror-focused',
    'article-jump-flash',
    'article-jump-target',
    'search-hit-highlight',
    'search-hit-block',
    'is-mermaid-editing',
];

const UNSAFE_URL_RE = /^\s*(?:javascript|vbscript|data:text\/html)/i;

/**
 * 与 index.html 内联脚本逐字节一致的轻量签名函数（长度 + UTF-16 FNV-1a）。
 * 原文改一字即失效并自动回退 #boot-editor，保证绝不渲染过期或错位快照。
 */
export function computeContentSignature(content = '') {
    const str = String(content ?? '');
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return `${str.length}:${(h >>> 0).toString(16)}`;
}

/**
 * 克隆编辑器 DOM 并剥离瞬态选区类、可编辑属性与危险节点，保留空行
 * ProseMirror-trailingBreak（维持段落高度不塌陷）及三态待办勾选状态。
 */
export function serializeEditorRenderedHtml(editorDomRoot) {
    if (!editorDomRoot || typeof editorDomRoot.cloneNode !== 'function') return null;
    const liveInputs = editorDomRoot.querySelectorAll
        ? Array.from(editorDomRoot.querySelectorAll('input[type="checkbox"]'))
        : [];
    const clone = editorDomRoot.cloneNode(true);
    const cloneInputs = clone.querySelectorAll
        ? Array.from(clone.querySelectorAll('input[type="checkbox"]'))
        : [];

    cloneInputs.forEach((input, index) => {
        const liveInput = liveInputs[index];
        const taskLi = input.closest?.('li[data-type="taskItem"]');
        const isChecked = liveInput
            ? Boolean(liveInput.checked)
            : taskLi?.dataset?.checked === 'true';
        const isDoing = !isChecked && (
            Boolean(liveInput?.indeterminate) || taskLi?.dataset?.doing === 'true'
        );
        if (isChecked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
        input.setAttribute('disabled', '');
        if (taskLi) {
            taskLi.dataset.checked = isChecked ? 'true' : 'false';
            taskLi.dataset.doing = isDoing ? 'true' : 'false';
        }
    });

    clone.querySelectorAll?.(TRANSIENT_SELECTOR).forEach((el) => el.remove());

    const elements = clone.querySelectorAll ? Array.from(clone.querySelectorAll('*')) : [];
    for (const el of elements) {
        for (const cls of TRANSIENT_CLASSES) {
            el.classList?.remove(cls);
        }
        if (el.hasAttribute?.('contenteditable')) {
            el.removeAttribute('contenteditable');
        }
        const attrs = el.attributes ? Array.from(el.attributes) : [];
        for (const attr of attrs) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
            } else if ((name === 'href' || name === 'src') && UNSAFE_URL_RE.test(attr.value || '')) {
                el.removeAttribute(attr.name);
            }
        }
    }

    const html = clone.innerHTML || '';
    if (html.length > MAX_SINGLE_HTML_CHARS) return null;
    return html;
}

function readStore(storage) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
        const raw = storage.getItem(RENDERED_SNAPSHOT_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== RENDERED_SNAPSHOT_VERSION || typeof parsed.entries !== 'object') {
            return null;
        }
        return {
            version: RENDERED_SNAPSHOT_VERSION,
            order: Array.isArray(parsed.order) ? parsed.order.filter(Boolean) : [],
            entries: parsed.entries || {},
        };
    } catch (_error) {
        return null;
    }
}

function writeStore(storage, store) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    const totalChars = (target) =>
        Object.values(target.entries).reduce((sum, item) => sum + String(item?.html || '').length, 0);

    while (store.order.length > MAX_CACHED_ARTICLES || totalChars(store) > MAX_TOTAL_HTML_CHARS) {
        const evicted = store.order.pop();
        if (!evicted) break;
        delete store.entries[evicted];
    }

    const attempt = (target) => {
        try {
            storage.setItem(RENDERED_SNAPSHOT_STORAGE_KEY, JSON.stringify(target));
            return true;
        } catch (_error) {
            return false;
        }
    };

    if (attempt(store)) return true;
    while (store.order.length > 1) {
        const evicted = store.order.pop();
        if (evicted) delete store.entries[evicted];
        if (attempt(store)) return true;
    }
    return false;
}

export function saveRenderedSnapshot(notepadId, markdownContent, editorDomRoot, storage = globalThis.localStorage) {
    if (!notepadId || !editorDomRoot) return false;
    const html = serializeEditorRenderedHtml(editorDomRoot);
    if (html === null) return false;
    const sig = computeContentSignature(markdownContent);
    const store = readStore(storage) || { version: RENDERED_SNAPSHOT_VERSION, order: [], entries: {} };
    store.entries[notepadId] = { sig, html, savedAt: Date.now() };
    store.order = [notepadId, ...store.order.filter((id) => id !== notepadId)];
    return writeStore(storage, store);
}

export function loadRenderedSnapshot(notepadId, expectedContent, storage = globalThis.localStorage) {
    if (!notepadId) return null;
    const store = readStore(storage);
    const entry = store?.entries?.[notepadId];
    if (!entry || typeof entry.html !== 'string') return null;
    const expectedSig = computeContentSignature(expectedContent);
    if (entry.sig !== expectedSig) return null;
    return { html: entry.html, sig: entry.sig };
}

export function removeRenderedSnapshot(notepadId, storage = globalThis.localStorage) {
    if (!notepadId) return false;
    const store = readStore(storage);
    if (!store || !store.entries[notepadId]) return false;
    delete store.entries[notepadId];
    store.order = store.order.filter((id) => id !== notepadId);
    return writeStore(storage, store);
}
