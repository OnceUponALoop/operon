import { collectTasksConversionIdentities } from './tasks-conversion-obsidian';
import type { KeyMapping } from '../types/settings';
import { TFile, parseYaml, type App } from 'obsidian';
import { getManagedYamlAliases } from '../core/yaml-fields';
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
 nativeSnapshot(ids?: readonly string[]): { references: string[]; unavailablePaths?: string[]; isCurrent(): boolean } | Promise<{ references: string[]; unavailablePaths?: string[]; isCurrent(): boolean }>;
 projectTable(path: string, preset: TablePreset): TablePreset;
 keyMappings?(): KeyMapping[];
 markdownBuffers?(): Array<{ path: string; content: string }>;
 drawingReferences?(file: TFile, content: string): Promise<string[] | null>;
}
/** Inert construction; every call captures a fresh read-only inventory. */
export function createTasksConversionReferenceInventory(app: App, deps: TasksConversionReferenceDependencies):
 (signal?: AbortSignal, changed?: { paths: readonly string[]; ids: readonly string[]; ownedPaths?: readonly string[] }) => Promise<Pick<TasksConversionIdentityInventory, 'externalReferences' | 'reservedSeriesIds' | 'isCurrent' | 'unavailablePaths'>> {
 return async (signal, changed) => {
  if (changed) return changedTasksConversionReferences(app, deps, changed, signal);
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

/** Automatic rollback checks only transaction-touched files and current open buffers. */
async function changedTasksConversionReferences(app: App, deps: TasksConversionReferenceDependencies,
 scope: { paths: readonly string[]; ids: readonly string[]; ownedPaths?: readonly string[] }, signal?: AbortSignal): Promise<Pick<TasksConversionIdentityInventory, 'externalReferences' | 'reservedSeriesIds' | 'isCurrent' | 'unavailablePaths'>> {
 const targets = new Set(scope.ids), references = new Set<string>(), unavailable = new Set<string>();
 const relevant = (ids: readonly string[]) => ids.filter(id => targets.has(id));
 const mentions = (content: string) => scope.ids.some(id => content.includes(id));
 const collect = (path: string, content: string): string[] => {
  if (!mentions(content)) return [];
  try {
   if (path.endsWith('.canvas')) return relevant(tasksConversionCanvasReferences(content));
   if (isOperonTableFilePath(path)) {
    const parsed = parseOperonTableFile(content, path);
    if (parsed.status !== 'valid') throw new Error('Invalid referenced Table');
    return relevant(tasksConversionTableReferences(deps.projectTable(path, parsed.preset)));
   }
   const mappings = deps.keyMappings?.() ?? [], lines = content.split('\n'), body = markdownBodyStartLine(lines);
   const header = lines.slice(0, body ?? lines.length).join('\n');
   const aliases = ['operonId', 'parentTask', 'blocking', 'blockedBy', 'related'].flatMap(key => getManagedYamlAliases(key, mappings));
   let relevantYaml = false;
   if (mentions(header)) {
    try {
     const yaml: unknown = parseYaml(lines.slice(1, body === null ? undefined : body - 1).join('\n'));
     relevantYaml = record(yaml) && aliases.some(alias => Object.prototype.hasOwnProperty.call(yaml, alias));
    } catch {
     // A malformed template is irrelevant unless it may contain a managed relationship.
     if (aliases.some(alias => header.includes(alias))) throw new Error('Unverifiable referenced frontmatter');
    }
   }
   const inline = collectTasksConversionIdentities(path, content, mappings, !relevantYaml).flatMap(source => [...source.operonIds, ...source.references]);
   const cards = /(?:`{3,}|~{3,})[ \t]*operon\b/u.test(content) ? tasksConversionCardReferences(content) : [];
   return relevant([...inline, ...cards]);
  } catch { unavailable.add(path); return []; }
 };
 const buffers = () => (deps.markdownBuffers?.() ?? []).filter(buffer => !scope.ownedPaths?.includes(buffer.path) && mentions(buffer.content));
 const initialBuffers = buffers();
 for (const buffer of initialBuffers) for (const id of collect(buffer.path, buffer.content)) references.add(id);
 const native = await deps.nativeSnapshot(scope.ids), workflow = deps.workflow();
 for (const id of relevant([...native.references, ...workflow.externalReferences])) references.add(id);
 for (const path of native.unavailablePaths ?? []) unavailable.add(path);
 for (const path of new Set(scope.paths)) {
  if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || !(path.endsWith('.md') || path.endsWith('.canvas') || isOperonTableFilePath(path))) continue;
  try {
   const content = await app.vault.read(file);
   for (const id of collect(path, content)) references.add(id);
   const drawing = await deps.drawingReferences?.(file, content);
   if (drawing) for (const id of relevant(drawing)) references.add(id);
  } catch { unavailable.add(path); }
 }
 const signature = JSON.stringify(initialBuffers), workflowRefs = JSON.stringify(relevant(workflow.externalReferences));
 return { externalReferences: [...references], reservedSeriesIds: workflow.reservedSeriesIds, unavailablePaths: [...unavailable],
  isCurrent: () => native.isCurrent() && JSON.stringify(buffers()) === signature
   && JSON.stringify(relevant(deps.workflow().externalReferences)) === workflowRefs };
}
