/**
 * Mermaid 运行时加载与渲染助手（Tiptap 编辑器专用）。
 * 三件事集中在这里：1) bundle 只在文章里真的出现 ```mermaid 时才注入 <script>，
 * 失败后清掉 promise 允许重试；2) 每次渲染前按当前主题 initialize，并保证 mermaid
 * 渲染失败时留在 <body> 里的临时节点被清掉；3) 只返回 svg 字符串——插到哪儿、
 * 什么时候插由调用方（代码块 NodeView）决定，文档与存储里永远只有源码。
 */

const MERMAID_BUNDLE_SRC = '/vendor/tiptap/tiptap-mermaid.bundle.js';

let runtimePromise = null;
let renderSeq = 0;

export function loadMermaidRuntime() {
    if (globalThis.DumbPadMermaid) return Promise.resolve(globalThis.DumbPadMermaid);
    if (!runtimePromise) {
        runtimePromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = MERMAID_BUNDLE_SRC;
            script.async = true;
            script.onload = () => {
                if (globalThis.DumbPadMermaid) resolve(globalThis.DumbPadMermaid);
                else reject(new Error('Mermaid bundle loaded without DumbPadMermaid global.'));
            };
            script.onerror = () => {
                script.remove();
                runtimePromise = null;
                reject(new Error('Mermaid runtime failed to load.'));
            };
            document.head.appendChild(script);
        });
    }
    return runtimePromise;
}

export function isDarkTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

async function resolveRuntime() {
    const runtime = await loadMermaidRuntime();
    const mermaid = runtime && (runtime.default || runtime);
    if (!mermaid || typeof mermaid.render !== 'function') {
        throw new Error('Mermaid runtime is missing render().');
    }
    return mermaid;
}

/**
 * 把 mermaid 源码渲染成 svg 字符串。语法错误会 reject（调用方保留源码不丢内容），
 * 无论成功失败都清掉 mermaid 自己塞进 body 的临时测量节点。
 */
export async function renderMermaidSvg(source) {
    const mermaid = await resolveRuntime();
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDarkTheme() ? 'dark' : 'default',
    });
    const renderId = `dumbpad-mermaid-${(renderSeq += 1)}`;
    try {
        const result = await mermaid.render(renderId, String(source ?? ''));
        const svg = result && (result.svg || result.svgCode);
        if (typeof svg !== 'string' || !svg.trim()) throw new Error('Mermaid render returned no svg.');
        return svg;
    } finally {
        document.getElementById(renderId)?.remove();
    }
}
