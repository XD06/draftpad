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
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Highlight } from '@tiptap/extension-highlight';

export const {
  Editor,
  Extension,
  Node,
  Mark,
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
};

export const PM = { state: PMState, model: PMModel, view: PMView, keymap: PMKeymap, commands: PMCommands, transform: PMTransform, schemaList: PMSchemaList };
