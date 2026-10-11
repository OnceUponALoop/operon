import { TFile, type App } from 'obsidian';
import type { IndexedTask } from '../../types/fields';
import type { OperonSettings } from '../../types/settings';
import { nativeEditorPropertyTypes } from '../../core/task-editor-native-properties';
import { encodeVaultPropertyValue, type VaultPropertyValue } from '../../core/vault-property-codec';
import { isWritableRawYamlPropertyName } from '../../core/raw-yaml-property';
import { getNativePropertyIndex, type NativeTaskProperties } from '../../indexer/native-property-index';
import {
 loadTableFilePropertyTypesFromConfig, encodeTableFilePropertyColumnKey, decodeTableFilePropertyColumnKey,
 createVaultFilePropertySnapshot, createCachedTableFilePropertyTypeResolver,
 getTableFilePropertyTypeIcon, normalizeTableFilePropertyValue,
 type TableFilePropertySnapshot, type TableFilePropertyField, type TableFilePropertyCellValue,
} from './table-file-property';

type Settings = Pick<OperonSettings, 'keyMappings' | 'inlinePropertyDefinitions'>;
const rowCells = new WeakMap<NativeTaskProperties, Map<string, TableFilePropertyCellValue>>();
const empty = (): TableFilePropertyCellValue => ({ present: false, rawValue: undefined, normalizedValue: '' });
/** Adapt the shared sparse index; no view-owned source cache or source reads. */
function projectSnapshot(app: App, base: TableFilePropertySnapshot, tasks: readonly IndexedTask[], settings: Settings): TableFilePropertySnapshot {
 const index = getNativePropertyIndex(app);
 const declarations = index.getTypes();
 const types = index.getNativeTypes();
 const candidateTypeResolver = createCachedTableFilePropertyTypeResolver(declarations);
 const fields = new Map<string, TableFilePropertyField>();
 const rows = new Map<string, NativeTaskProperties>();
 const counts = new Map<string, number>();
 for (const task of tasks) counts.set(task.operonId, (counts.get(task.operonId) ?? 0) + 1);
 for (const task of tasks) {
  const row = index.getTask(task);
  rows.set(task.operonId, counts.get(task.operonId) === 1 ? row : { ...row, available: false });
 }
 const add = (name: string, previous?: TableFilePropertyField, sample?: unknown) => {
  const knownType = index.typeFor(name);
  const type = knownType ?? previous?.type ?? candidateTypeResolver.resolve(name, [sample]).tableType;
  const reason = index.reason(name);
  fields.set(name.toLowerCase(), { key: previous?.key ?? encodeTableFilePropertyColumnKey(name)!, label: previous?.label ?? name,
   propertyName: name, type, sourceType: knownType ? candidateTypeResolver.resolve(name, [sample]).sourceType : previous?.sourceType ?? candidateTypeResolver.resolve(name, [sample]).sourceType, group: 'fileProperty',
   readonly: !!reason, readOnlyReason: reason, icon: reason === 'automatic' ? 'shield-alert' : getTableFilePropertyTypeIcon(type),
   aliases: previous?.aliases ?? [name], sourceFileCount: previous?.sourceFileCount ?? 0 });
 };
 for (const field of base.fields) add(field.propertyName, field);
 for (const name of Object.keys(types)) if (isWritableRawYamlPropertyName(name, settings.keyMappings)) add(name, fields.get(name.toLowerCase()));
 for (const row of rows.values()) for (const property of row.properties.values()) {
  if (isWritableRawYamlPropertyName(property.sourceName, settings.keyMappings) && !fields.has(property.sourceName.toLowerCase())) add(property.sourceName, undefined, property.value);
 }
 const getCell = (task: IndexedTask, key: string): TableFilePropertyCellValue => {
  const name = decodeTableFilePropertyColumnKey(key)?.toLowerCase();
  const field = name ? fields.get(name) : undefined;
  if (!name || !field) return empty();
  const row = rows.get(task.operonId);
  const cached = row && rowCells.get(row)?.get(name);
  if (cached) return cached;
  const property = row?.properties.get(name);
  const reason = !row?.available ? 'unavailable' : property?.reason ?? field.readOnlyReason;
  const present = property?.present ?? false;
  const rawValue = property?.value;
  const cell: TableFilePropertyCellValue = { present, rawValue, normalizedValue: normalizeTableFilePropertyValue(rawValue), sourceName: property?.sourceName ?? field.propertyName,
   nativeState: reason ? 'unsupported' : 'ready', readOnlyReason: reason,
   ...(task.primary.format === 'inline' ? { inlineExpected: { present, rawValue: property?.inline?.rawValue } } : {}) };
  if (row) { const cells = rowCells.get(row) ?? new Map<string, TableFilePropertyCellValue>(); cells.set(name, cell); rowCells.set(row, cells); }
  return cell;
 };
 // Data signatures, rather than index generations, suppress redundant sort/search invalidations.
 const signature = JSON.stringify([[...fields.values()], tasks.map(task => [task.operonId, rows.get(task.operonId)?.available, rows.get(task.operonId)?.revision])]);
 return {
  revision: base.revision, signature, fields: [...fields.values()], getCell,
  getCandidates(key) {
   const name = decodeTableFilePropertyColumnKey(key)?.toLowerCase();
   if (!name || !fields.has(name)) return [];
   const vault = createVaultFilePropertySnapshot(app, candidateTypeResolver, { keyMappings: settings.keyMappings, nativeListCandidates: true });
   const values = new Set<string>();
   for (const field of vault.fields) if (field.propertyName.toLowerCase() === name) for (const value of vault.getCandidates(field.key)) values.add(value);
   for (const task of tasks) {
    const cell = getCell(task, key);
    if (!cell.present || cell.nativeState !== 'ready') continue;
    for (const value of Array.isArray(cell.rawValue) ? cell.rawValue : [cell.rawValue]) {
     if (typeof value === 'string' || typeof value === 'number') values.add(fields.get(name)?.type === 'list' ? encodeVaultPropertyValue([value], 'list') : String(value));
    }
   }
   return [...values];
  },
 };
}
/** Await the shared index for non-render consumers and focused integration tests. */
export async function loadTableNativePropertySnapshot(
 app: App, base: TableFilePropertySnapshot, tasks: readonly IndexedTask[], settings: Settings,
 _readSource?: (file: TFile) => Promise<string>, readValues = true,
): Promise<TableFilePropertySnapshot> {
 const index = getNativePropertyIndex(app); index.configure(settings);
 await index.ensure(readValues ? tasks : []);
 return projectSnapshot(app, base, readValues ? tasks : [], settings);
}
interface SurfaceState { key: string; value?: TableFilePropertySnapshot; }
const surfaces = new WeakMap<object, SurfaceState>();
export function getTableNativePropertySnapshot(
 owner: object, app: App, base: TableFilePropertySnapshot, tasks: readonly IndexedTask[], _generation: number,
 settings: Settings, onReady: () => void, readValues = true,
): TableFilePropertySnapshot {
 if (!readValues) { surfaces.delete(owner); return base; }
 const index = getNativePropertyIndex(app); index.configure(settings);
 const key = JSON.stringify([base.signature, index.getRevision(), tasks.map(task => [task.operonId, task.primary])]);
 let state = surfaces.get(owner);
 if (index.isReady(tasks)) {
  if (state?.key === key && state.value) return state.value;
  const value = projectSnapshot(app, base, tasks, settings); surfaces.set(owner, { key, value }); return value;
 }
 if (state?.key !== key || state.value) {
  state = { key }; surfaces.set(owner, state);
  const pending = state;
  void index.ensure(tasks).then(() => { if (index.isActive() && surfaces.get(owner) === pending) { surfaces.delete(owner); onReady(); } });
 }
 return { ...base, signature: base.signature + '|native-loading', loading: true,
  getCell(task, column) { return { ...base.getCell(task, column), nativeState: 'unsupported', readOnlyReason: 'unavailable' }; } };
}

/** Internal table mutation bridge; no public Runtime mutation or DTO is extended. */
export async function writeTableNativeProperty(
 app: App, writer: import('../../core/task-writer').TaskWriter,
 task: IndexedTask, request: import('./table-file-property-editor').TableFilePropertyUpdateRequest,
 settings: Settings, modifiedTimestamp: string,
): Promise<import('./table-file-property-editor').TableFilePropertyUpdateResult> {
 if (!request.nativeType || request.sourceFormat !== task.primary.format) return 'unsupported';
 const declarations = await loadTableFilePropertyTypesFromConfig(app);
 const types = nativeEditorPropertyTypes(declarations, settings.keyMappings, settings.inlinePropertyDefinitions);
 const name = Object.keys(types).find(key => key.toLowerCase() === request.propertyName.toLowerCase());
 if (!name || types[name] !== request.nativeType || !isWritableRawYamlPropertyName(name, settings.keyMappings)) return 'unsupported';
 if (request.mutation.kind === 'set') {
  try { encodeVaultPropertyValue(request.mutation.value as VaultPropertyValue, request.nativeType); } catch { return 'unsupported'; }
 }
 const options: import('../../core/task-writer').TaskWriteOptions = { reindex: 'none', mode: 'merge' };
 if (task.primary.format === 'inline') {
  if (!request.inlineExpected) return 'unsupported';
  options.inlinePropertyDraft = [{ sourceName: request.propertyName, type: request.nativeType,
   expected: request.inlineExpected, mutation: request.mutation.kind === 'delete' ? { kind: 'remove' }
    : { kind: 'set', value: request.mutation.value as VaultPropertyValue } }];
 } else if (task.primary.format === 'yaml') {
  options.filePropertyDraft = { changes: [{ propertyName: request.propertyName, expected: request.expected,
   value: request.mutation.kind === 'set' ? request.mutation.value : null, remove: request.mutation.kind === 'delete', nativeType: request.nativeType }] };
 } else return 'unsupported';
 return await writer.writeTaskFields(task.operonId, { datetimeModified: modifiedTimestamp }, options) ? 'updated' : 'conflict';
}
