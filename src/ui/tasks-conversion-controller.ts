import type { TasksConversionScope, TasksConversionPreview, TasksConversionFileChange } from '../core/tasks-conversion-plan';
import type { TasksConversionService, TasksConversionInspection, TasksConversionResult } from '../systems/tasks-conversion-service';

export interface TasksConversionUiIntegration { open(): void; available(): boolean }
export interface TasksConversionControllerDependencies {
 service: Pick<TasksConversionService, 'scan' | 'preview' | 'apply' | 'inspect' | 'resolve'>;
 available(): boolean;
 /** Guard index automation before writes and until exact post-write settlement. */
 coordinate<T>(paths: readonly string[], ids: readonly string[], operation: () => Promise<T>, changes?: readonly TasksConversionFileChange[]): Promise<T>;
 settle(paths: readonly string[]): Promise<void>;
}
export interface TasksConversionCounts { available: boolean; selected: number; converted: number; skipped: number; unknown: number }
export function tasksConversionCounts(result: TasksConversionResult | null, preview: TasksConversionPreview | null,
 inspection: TasksConversionInspection | null): TasksConversionCounts {
 const state = inspection?.state;
 const record = state && (state.kind === 'active' || state.kind === 'resolved') ? state.record : null;
 const selected = record?.taskCount ?? (result?.taskCount ? result.taskCount : preview?.selectedKeys.length ?? 0);
 const available = !!record || !!preview || !!result?.taskCount;
 const skipped = preview ? preview.rows.length - preview.selectedKeys.length : 0;
 if (result?.sourcesCommitted || result?.status === 'committed' || result?.status === 'kept') return { available, selected, converted: selected, skipped, unknown: 0 };
 if (state?.kind === 'resolved' && state.resolution.decision === 'kept') return { available, selected, converted: selected, skipped, unknown: 0 };
 if (result?.sourcesTouched) return { available, selected, converted: 0, skipped, unknown: 0 };
 let converted = 0, unknown = 0;
 if (record && inspection) {
  for (const change of record.changes) {
   const before = change.before.split('\n');
   const count = change.after.split('\n').filter((line, index) => line !== before[index]).length;
   const file = inspection.files.find(file => file.path === change.path);
   if (file?.state === 'after') converted += count;
   else if (state?.kind === 'active' && file?.state !== 'before') unknown += count;
  }
 } else if (result?.status === 'recovery-required') unknown = selected;
 return { available, selected, converted, skipped, unknown };
}

/** Owns one memory-only selection and one explicit mutation at a time. */
export class TasksConversionController {
 scope: TasksConversionScope = { files: [], folders: [], includeSubfolders: true };
 preview: TasksConversionPreview | null = null;
 inspection: TasksConversionInspection | null = null;
 result: TasksConversionResult | null = null;
 busy = false;
 phase: 'inspect' | 'scan' | 'apply' | 'restore' | 'cleanup' | 'settle' | null = null;
 progress: { completedFiles: number; totalFiles: number; path: string } | null = null;
 error: string | null = null;
 settlementPending: string[] = [];
 private abort: AbortController | null = null;
 private cancelled = false;
 private disposed = false;
 private verifiedCounts: TasksConversionCounts | null = null;
 onChange: () => void = () => {};
 constructor(private readonly deps: TasksConversionControllerDependencies) {}
 get available(): boolean { return !this.disposed && this.deps.available(); }
 get blocked(): boolean { return !this.inspection || this.inspection.state.kind !== 'empty'; }
 get counts(): TasksConversionCounts {
  const counts = tasksConversionCounts(this.result, this.preview, this.inspection);
  return counts.available ? counts : this.verifiedCounts ?? counts;
 }
 updateScope(scope: TasksConversionScope): void {
  if (this.busy || this.blocked) return;
  this.scope = { files: [...new Set(scope.files)].sort(), folders: [...new Set(scope.folders)].sort(), includeSubfolders: scope.includeSubfolders };
  this.preview = null; this.result = null; this.error = null; this.emit();
 }
 select(keys: readonly string[]): void {
  if (this.busy || this.blocked || this.result || !this.preview) return;
  this.preview = this.deps.service.preview(this.preview.scan, keys); this.emit();
 }
 cancel(): void { if (this.cancelled) return; this.cancelled = true; this.abort?.abort(); this.emit(); }
 dispose(): void { this.disposed = true; this.cancel(); this.onChange = () => {}; }
 async initialize(): Promise<void> {
  await this.run('inspect', async () => {
   this.inspection = await this.deps.service.inspect();
   const state = this.inspection.state, id = state.kind === 'active' ? state.record.id : state.kind === 'resolved' ? state.resolution.id : null;
   if (id && this.result?.recordId && this.result.recordId !== id) { this.result = null; this.preview = null; this.verifiedCounts = null; }
  });
 }
 async scan(): Promise<void> {
  if (this.blocked || (!this.scope.files.length && !this.scope.folders.length)) return;
  await this.run('scan', async () => {
   this.result = null; this.preview = null;
   const scan = await this.deps.service.scan(this.scope, { signal: this.abort!.signal, onProgress: progress => { this.progress = progress; this.emit(); } });
   if (!this.cancelled && this.available) this.preview = this.deps.service.preview(scan);
  });
 }
 async apply(): Promise<void> {
  const preview = this.preview;
  if (this.blocked || this.result || !preview || !preview.selectedKeys.length || preview.errors.length) return;
  await this.run('apply', async () => {
   await this.deps.coordinate(preview.changes.map(change => change.path), preview.operonIds, async () => {
    this.result = await this.deps.service.apply(preview, { finalizeOnSuccess: true,
     canCommit: () => this.available && !this.cancelled,
     onProgress: progress => { this.phase = progress.phase; this.progress = progress; this.emit(); } });
    await this.inspectAndSettle(this.result.paths);
   }, preview.changes);
  });
 }
 async resolve(action: 'restore' | 'keep' | 'cleanup'): Promise<void> {
  const inspection = this.inspection;
  if (!inspection) return;
  const state = inspection.state;
  const id = state.kind === 'active' ? state.record.id : state.kind === 'resolved' ? state.resolution.id : null;
  if (action === 'restore' && this.result?.sourcesCommitted && this.result.recordId === id) return;
  if (!id || (action === 'restore' && !inspection.canRestore) || (action === 'keep' && !inspection.canKeep)
   || (action === 'cleanup' && state.kind !== 'resolved')) return;
  await this.run(action === 'restore' ? 'restore' : 'cleanup', async () => {
   const record = state.kind === 'active' || state.kind === 'resolved' ? state.record : null;
   await this.deps.coordinate(record?.changes.map(change => change.path) ?? [], record?.operonIds ?? [], async () => {
    this.verifiedCounts = this.counts;
    const committed = this.result?.sourcesCommitted && this.result.recordId === id;
    const result = await this.deps.service.resolve(action, id, { canCommit: () => this.available && !this.cancelled,
     onProgress: progress => { this.progress = progress; this.emit(); } });
    this.result = committed && result.recordId === id ? { ...result, sourcesCommitted: true } : result;
    await this.inspectAndSettle(this.result.paths, action !== 'cleanup');
   }, record?.changes);
  });
 }
 async retrySettlement(): Promise<void> {
  if (!this.settlementPending.length) return;
  await this.run('settle', async () => {
   await this.deps.coordinate(this.settlementPending, this.preview?.operonIds ?? [], () => this.settle(this.settlementPending));
  });
 }
 reset(): void {
  if (this.busy || this.blocked || this.settlementPending.length) return;
  this.preview = null; this.result = null; this.verifiedCounts = null; this.error = null; this.progress = null; this.emit();
 }
 private async inspectAndSettle(paths: readonly string[], refresh = true): Promise<void> {
  const written = refresh && (!!this.result?.sourcesTouched || !!this.result?.sourcesCommitted || !!this.result && ['committed', 'rolled-back', 'restored', 'kept', 'recovery-required'].includes(this.result.status));
  if (written) this.settlementPending = [...paths];
  try { this.inspection = await this.deps.service.inspect(); }
  catch (error) {
   this.inspection = null;
   this.error = error instanceof Error ? error.message : 'Recovery inspection failed';
  }
  // Read-only refresh remains available even if recovery inspection fails after commit.
  if (written) await this.settle(paths);
  if (this.result?.sourcesCommitted || this.result?.sourcesTouched) this.verifiedCounts = this.counts;
 }
 private async settle(paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  this.settlementPending = [...paths]; this.phase = 'settle'; this.progress = null; this.emit();
  try { await this.deps.settle(paths); this.settlementPending = []; }
  catch { this.error = 'settlement-pending'; }
 }
 private async run(phase: NonNullable<TasksConversionController['phase']>, operation: () => Promise<void>): Promise<void> {
  if (this.busy || !this.available) return;
  this.busy = true; this.phase = phase; this.progress = null; this.cancelled = false; this.abort = new AbortController(); this.error = null; this.emit();
  try { await operation(); }
  catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) this.error = error instanceof Error ? error.message : 'Operation failed'; }
  finally { this.busy = false; this.phase = null; this.abort = null; this.emit(); }
 }
 private emit(): void { if (!this.disposed) this.onChange(); }
}
