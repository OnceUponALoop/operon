import { TFile, type App } from 'obsidian';
import { markdownBodyStartLine } from '../core/markdown-body';
import { iterateMarkdownFencedBlocks } from '../core/markdown-fenced-lines';
import { parseTaskCardEmbed } from '../ui/task-card-embed-model';
import { isOperonTableFilePath, parseOperonTableFile } from '../storage/table-file';
import type { TablePreset } from '../types/table';
import type { TasksConversionIdentityInventory } from './tasks-conversion-service';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** Collect actual task-card fences; nested examples and ordinary text are not references. */
export function tasksConversionCardReferences(content: string): string[] {
 const lines = content.split('\n'), start = markdownBodyStartLine(lines);
 if (start === null) throw new Error('Unclosed frontmatter prevents reference verification');
 const body = lines.slice(start).join('\n'), bodyLines = body.split('\n'), ids: string[] = [];
 for (const block of iterateMarkdownFencedBlocks(body)) {
  if (block.info !== 'operon') continue;
  const source = bodyLines.slice(block.contentStartLine, block.contentEndLine)
   .map((line, index) => line.slice(block.contentPrefixes[index].length)).join('\n');
  const parsed = parseTaskCardEmbed(source);
  if ('options' in parsed) ids.push(parsed.options.taskId);
  else if (/^\s*(?:taskId\s*:|view\s*:\s*["']?card\b)/imu.test(source)) throw new Error('Invalid task-card prevents reference verification');
 }
 return ids;
}
export function tasksConversionCanvasReferences(content: string): string[] {
 const root: unknown = JSON.parse(content);
 if (!record(root) || !Array.isArray(root.nodes)) throw new Error('Unsupported Canvas source');
 const ids: string[] = [];
 for (const node of root.nodes) {
  if (!record(node) || node.type !== 'text') continue;
  if (node.operonTask !== undefined) {
   if (!record(node.operonTask) || node.operonTask.version !== 1 || typeof node.operonTask.taskId !== 'string') throw new Error('Unsupported Canvas task reference');
   ids.push(node.operonTask.taskId);
  }
  if (typeof node.text === 'string') ids.push(...tasksConversionCardReferences(node.text));
 }
 return ids;
}
export function tasksConversionTableReferences(preset: TablePreset): string[] {
 return [...(preset.expandedTaskTreeIds ?? []), ...(preset.search.parent?.parentId ? [preset.search.parent.parentId] : [])];
}
export interface TasksConversionWorkflowSnapshot {
 externalReferences: string[]; reservedSeriesIds: string[]; isCurrent(): boolean;
}
export interface TasksConversionReferenceDependencies {
 workflow(): TasksConversionWorkflowSnapshot;
 /** Must check all native buffers without saving, flushing or mounting a view. */
 matches(path: string, content: string): boolean;
 nativeSnapshot(): { references: string[]; unavailablePaths?: string[]; isCurrent(): boolean } | Promise<{ references: string[]; unavailablePaths?: string[]; isCurrent(): boolean }>;
 projectTable(path: string, preset: TablePreset): TablePreset;
}
/** Inert construction; every call captures a fresh read-only inventory. */
export function createTasksConversionReferenceInventory(app: App, deps: TasksConversionReferenceDependencies):
 (signal?: AbortSignal) => Promise<Pick<TasksConversionIdentityInventory, 'externalReferences' | 'reservedSeriesIds' | 'isCurrent' | 'unavailablePaths'>> {
 return async signal => {
  const workflow = deps.workflow(), native = await deps.nativeSnapshot();
  const unavailablePaths = [...(native.unavailablePaths ?? [])];
  const check = () => { if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError'); };
  const files = () => app.vault.getFiles().filter(file => file.extension === 'md' || file.extension === 'canvas' || isOperonTableFilePath(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const initial = files(), paths = initial.map(file => file.path), contents = new Map<string, string>();
  const ids = [...workflow.externalReferences, ...native.references], tables: Array<{ path: string; preset: TablePreset; projected: string }> = [];
  for (const file of initial) {
   check();
   try {
   const content = await app.vault.read(file);
   if (!deps.matches(file.path, content)) throw new Error(`Unsaved or unsupported native source: ${file.path}`);
   contents.set(file.path, content);
   if (file.extension === 'md') ids.push(...tasksConversionCardReferences(content));
   else if (file.extension === 'canvas') ids.push(...tasksConversionCanvasReferences(content));
   else {
    const parsed = parseOperonTableFile(content, file.path);
    if (parsed.status !== 'valid') throw new Error(`Invalid Table source: ${file.path}`);
    const projected = deps.projectTable(file.path, parsed.preset);
    if (JSON.stringify(projected) !== JSON.stringify(parsed.preset)) throw new Error(`Pending Table changes: ${file.path}`);
    tables.push({ path: file.path, preset: parsed.preset, projected: JSON.stringify(projected) });
    ids.push(...tasksConversionTableReferences(projected));
   }
   } catch { unavailablePaths.push(file.path); }
  }
  check();
  return { unavailablePaths, externalReferences: [...new Set(ids)], reservedSeriesIds: [...workflow.reservedSeriesIds],
   isCurrent: () => workflow.isCurrent() && native.isCurrent() && JSON.stringify(paths) === JSON.stringify(files().map(file => file.path))
    && initial.every(file => file instanceof TFile && app.vault.getAbstractFileByPath(file.path) === file)
    && [...contents].every(([path, content]) => deps.matches(path, content))
    && tables.every(({ path, preset, projected }) => projected === JSON.stringify(deps.projectTable(path, preset))) };
 };
}
