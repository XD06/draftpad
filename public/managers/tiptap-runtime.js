/**
 * Tiptap 运行时转发模块：把预打包 IIFE（window.DumbPadTiptap）暴露的 API
 * 以 ESM 形式提供给本仓库前端模块。必须在动态 import 本文件之前加载
 * /vendor/tiptap/tiptap.bundle.js（scripts/build-tiptap-bundle.js 产物）。
 */
const runtime = globalThis.DumbPadTiptap;

if (!runtime) {
    throw new Error('Tiptap bundle is not loaded. Load /vendor/tiptap/tiptap.bundle.js before importing tiptap-runtime.js');
}

export const Editor = runtime.Editor;
export const Extension = runtime.Extension;
export const Node = runtime.Node;
export const Mark = runtime.Mark;
export const InputRule = runtime.InputRule;
export const mergeAttributes = runtime.mergeAttributes;
export const findChildren = runtime.findChildren;
export const findParentNode = runtime.findParentNode;
export const getMarkRange = runtime.getMarkRange;
export const StarterKit = runtime.StarterKit;
export const Markdown = runtime.Markdown;
export const Image = runtime.Image;
export const Table = runtime.Table;
export const TableRow = runtime.TableRow;
export const TableCell = runtime.TableCell;
export const TableHeader = runtime.TableHeader;
export const TaskList = runtime.TaskList;
export const TaskItem = runtime.TaskItem;
export const CodeBlockLowlight = runtime.CodeBlockLowlight;
export const lowlight = runtime.lowlight;
export const PM = runtime.PM;
export default runtime;
