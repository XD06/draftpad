/**
 * Tiptap 离线 bundle 入口：把 @tiptap/core、starter-kit、tiptap-markdown
 * 与文章编辑器所需的扩展集中打包为 IIFE，挂到 window.DumbPadTiptap。
 * 仅作为 scripts/build-tiptap-bundle.js 的入口，不直接被页面加载。
 */
import * as TiptapCore from '@tiptap/core';
import * as PMState from '@tiptap/pm/state';
import * as PMView from '@tiptap/pm/view';
import * as PMModel from '@tiptap/pm/model';
import * as PMKeymap from '@tiptap/pm/keymap';
import * as PMCommands from '@tiptap/pm/commands';
import * as PMTransform from '@tiptap/pm/transform';
import * as PMSchemaList from '@tiptap/pm/schema-list';
import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
// tiptap-markdown 的 exports 只映射包根，取不到内部工具函数；这里按文件路径
// 直接引用（包内把 src 一起发布了）。
import { getMarkdownSpec as tiptapMarkdownSpec } from '../../node_modules/tiptap-markdown/src/util/extensions.js';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Highlight } from '@tiptap/extension-highlight';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Underline } from '@tiptap/extension-underline';
import { createLowlight, common } from 'lowlight';

export const {
  Editor,
  Extension,
  Node,
  Mark,
  InputRule,
  mergeAttributes,
  findChildren,
  findParentNode,
  getMarkRange,
  callOrReturn,
  generateHTML,
  generateJSON,
} = TiptapCore;

export {
  StarterKit,
  Markdown,
  Image,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  TaskList,
  TaskItem,
  Highlight,
  CodeBlockLowlight,
  Underline,
};

// tiptap-markdown 用 getMarkdownSpec 取得「内核自带」的 markdown 规格
// （taskItem/taskList 等的序列化器与解析钩子都登记在它的内置表里，不在
// Tiptap 扩展自身的 storage 上）。扩展要「只替换一部分」就必须拿到它，
// 否则覆盖 addStorage 会把解析钩子一起丢掉。包内没有导出，只能直接引源码。
export const getMarkdownSpec = tiptapMarkdownSpec;

// 代码块语法高亮走 Tiptap 官方 CodeBlockLowlight（PM Decoration 机制），
// lowlight 实例在 bundle 层共享，编辑器侧只做别名注册。
export const lowlight = createLowlight(common);

export const PM = { state: PMState, model: PMModel, view: PMView, keymap: PMKeymap, commands: PMCommands, transform: PMTransform, schemaList: PMSchemaList };
