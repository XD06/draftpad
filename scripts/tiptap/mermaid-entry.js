/**
 * Mermaid 离线 bundle 入口：把 mermaid v11 打包为独立 IIFE 挂到
 * window.DumbPadMermaid，仅当文章包含 mermaid 代码块时才被加载。
 * 仅作为 scripts/build-tiptap-bundle.js 的入口，不直接被页面加载。
 */
import mermaid from 'mermaid';

export default mermaid;
