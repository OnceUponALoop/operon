import type { KeyMapping } from '../types/settings';
import type { TasksConversionSettings, TasksConversionScope, TasksConversionFactories, TasksConversionScan, TasksConversionPreview } from '../core/tasks-conversion-plan';
import { previewTasksConversion, resolveTasksConversionPaths, scanTasksConversionSources, tasksConversionSettingsSnapshot, serializeTasksConversionSettings } from '../core/tasks-conversion-plan';
import { TasksConversionRecoveryStore, type TasksConversionRecord, type TasksConversionRecoveryState } from '../storage/tasks-conversion-recovery';

export interface TasksConversionIdentity {
	path: string; lineNumber: number; operonIds: string[]; repeatSeriesIds: string[]; references: string[];
}
export interface TasksConversionIdentityInventory {
	sources: TasksConversionIdentity[];
	unavailablePaths: string[];
	/** Include all non-Markdown identities/references (native sources, trackers, pinned/repeat state). */
	externalReferences: string[]; reservedSeriesIds: string[];
	/** Synchronous mutation witness, checked inside TaskWriter's compare-and-set callback. */
	isCurrent(): boolean;
}
export interface TasksConversionIdentityScope {
	paths: readonly string[]; operonIds?: readonly string[]; repeatSeriesIds?: readonly string[];
}
export interface TasksConversionWritePort {
	read(path: string): Promise<string>;
	write(path: string, expected: string, next: string, allowed: () => boolean): Promise<void>;
	identities(mappings: KeyMapping[], signal?: AbortSignal, scope?: TasksConversionIdentityScope): Promise<TasksConversionIdentityInventory>;
}
export interface TasksConversionHost {
	settings(): TasksConversionSettings;
	paths(): string[];
	read(path: string): Promise<string>;
	identities(mappings: KeyMapping[], signal?: AbortSignal, scope?: TasksConversionIdentityScope): Promise<TasksConversionIdentityInventory>;
	exclusive<T>(paths: string[], operation: (port: TasksConversionWritePort) => Promise<T>): Promise<T>;
}
export type TasksConversionOutcome = 'committed' | 'not-applied' | 'cancelled' | 'rolled-back'
	| 'recovery-required' | 'kept' | 'restored' | 'cleanup-pending';
export interface TasksConversionResult {
	status: TasksConversionOutcome; taskCount: number; paths: string[]; message?: string; recordId?: string;
	/** All planned source writes passed final verification, even if evidence cleanup failed. */
	sourcesCommitted?: boolean;
	/** A verified restore touched source files, including a pending evidence cleanup. */
	sourcesTouched?: boolean;
}
export interface TasksConversionScanOptions {
	signal?: AbortSignal;
	onProgress?: (progress: { completedFiles: number; totalFiles: number; path: string }) => void;
}
export interface TasksConversionRunOptions {
	finalizeOnSuccess?: boolean;
	canCommit?: () => boolean;
	onProgress?: (progress: { phase: 'apply' | 'restore'; completedFiles: number; totalFiles: number; path: string }) => void;
}
export interface TasksConversionInspection {
	state: TasksConversionRecoveryState;
	files: Array<{ path: string; state: 'before' | 'after' | 'conflict' }>;
	canUndo: boolean; canRestore: boolean; canKeep: boolean;
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function reserved(inventory: TasksConversionIdentityInventory): Set<string> {
	return new Set([...inventory.externalReferences, ...inventory.sources.flatMap(source => [...source.operonIds, ...source.references])]);
}
function restoreIdentityConflict(inventory: TasksConversionIdentityInventory, record: TasksConversionRecord): boolean {
	const ids = new Set(record.operonIds), series = new Set(record.repeatSeriesIds);
	if (inventory.externalReferences.some(id => ids.has(id) || series.has(id)) || inventory.reservedSeriesIds.some(id => series.has(id))) return true;
	const paths = new Set(record.changes.map(change => change.path));
	const seen = new Set<string>(), seenSeries = new Set<string>();
	for (const source of inventory.sources) {
		const ownsGenerated = source.operonIds.some(id => ids.has(id));
		for (const id of source.operonIds.filter(id => ids.has(id))) {
			if (!paths.has(source.path) || seen.has(id)) return true;
			seen.add(id);
		}
		for (const id of source.repeatSeriesIds.filter(id => series.has(id))) {
			if (!paths.has(source.path) || !ownsGenerated || seenSeries.has(id)) return true;
			seenSeries.add(id);
		}
		if (!ownsGenerated && source.references.some(id => ids.has(id))) return true;
	}
	return false;
}

/** Prepared objects are session-owned; only the exact immutable preview can be applied. */
export class TasksConversionService {
	private readonly scans = new WeakSet<TasksConversionScan>();
	private readonly previews = new WeakSet<TasksConversionPreview>();
	constructor(private readonly host: TasksConversionHost, private readonly recovery: TasksConversionRecoveryStore,
		private readonly factories: TasksConversionFactories = {}) {}

	async scan(scope: TasksConversionScope, options: TasksConversionScanOptions = {}): Promise<TasksConversionScan> {
		const check = () => { if (options.signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError'); };
		check();
		const settings = tasksConversionSettingsSnapshot(this.host.settings());
		const paths = resolveTasksConversionPaths(scope, this.host.paths());
		const inventory = await this.host.identities(settings.keyMappings, options.signal, { paths });
		check();
		const sources = [];
		for (const [index, path] of paths.entries()) {
			check();
			try { sources.push({ path, content: await this.host.read(path) }); }
			catch (error) { sources.push({ path, error: error instanceof Error ? error.message : 'Source unreadable' }); }
			check();
			try { options.onProgress?.({ completedFiles: index + 1, totalFiles: paths.length, path }); } catch { /* Observers do not own scan state. */ }
		}
		const scan = freeze(scanTasksConversionSources(scope, sources, settings, reserved(inventory),
			new Set([...inventory.reservedSeriesIds, ...inventory.sources.flatMap(source => source.repeatSeriesIds)]), this.factories));
		this.scans.add(scan); return scan;
	}

	preview(scan: TasksConversionScan, selectedKeys?: readonly string[]): TasksConversionPreview {
		if (!this.scans.has(scan)) throw new Error('Tasks conversion scan belongs to another session');
		const preview = freeze(previewTasksConversion(scan, selectedKeys));
		this.previews.add(preview); return preview;
	}

	async apply(preview: TasksConversionPreview, options: TasksConversionRunOptions = {}): Promise<TasksConversionResult> {
		if (!this.previews.has(preview)) return this.result('not-applied', null, 'Preview belongs to another session');
		if (preview.errors.length || !preview.changes.length) return this.result('not-applied', null, 'Selection is empty or has errors');
		return this.recovery.exclusive(async () => {
			if ((await this.recovery.load()).kind !== 'empty') return this.result('recovery-required', null, 'Resolve the previous conversion first');
			const record: TasksConversionRecord = { format: 'operon-tasks-conversion', version: 1, id: crypto.randomUUID(),
				changes: structuredClone(preview.changes), operonIds: [...preview.operonIds], repeatSeriesIds: [...preview.repeatSeriesIds],
				keyMappings: structuredClone(preview.scan.settings.keyMappings), taskCount: preview.operonIds.length };
			return this.host.exclusive(record.changes.map(change => change.path), async port => {
				const attempted = new Set<string>();
				const scope = { paths: record.changes.map(change => change.path), operonIds: record.operonIds, repeatSeriesIds: record.repeatSeriesIds };
				try {
					const expectedSettings = serializeTasksConversionSettings(preview.scan.settings);
					const settingsMatch = () => serializeTasksConversionSettings(this.host.settings()) === expectedSettings;
					const allowed = () => options.canCommit?.() !== false && settingsMatch();
					if (options.canCommit?.() === false) return this.result('cancelled', record);
					if (!settingsMatch()) {
						return this.result('not-applied', record, 'Conversion settings changed; scan again');
					}
					for (const change of record.changes) if (await port.read(change.path) !== change.before) {
						return this.result('not-applied', record, `Source changed: ${change.path}`);
					}
					const inventory = await port.identities(record.keyMappings, undefined, scope), used = reserved(inventory);
					if (!inventory.isCurrent() || inventory.unavailablePaths.length) return this.result('not-applied', record, 'Identity inventory is incomplete or changed');
					const usedSeries = new Set([...inventory.reservedSeriesIds, ...inventory.sources.flatMap(source => source.repeatSeriesIds)]);
					if (record.operonIds.some(id => used.has(id)) || record.repeatSeriesIds.some(id => usedSeries.has(id))) {
						return this.result('not-applied', record, 'Allocated identity is no longer available');
					}
					if (options.canCommit?.() === false) return this.result('cancelled', record);
					await this.recovery.create(record);
					const active = await this.recovery.load();
					if (active.kind !== 'active' || active.record.id !== record.id) return this.result('recovery-required', record, 'Backup could not be verified');
					for (const [index, change] of record.changes.entries()) {
						if (!allowed()) return this.restore(active, port, options, false, attempted);
						const fresh = await port.identities(record.keyMappings, undefined, scope);
						if (!fresh.isCurrent() || fresh.unavailablePaths.length || restoreIdentityConflict(fresh, record)
							|| fresh.sources.some(source => !attempted.has(source.path) && source.operonIds.some(id => record.operonIds.includes(id)))) {
							return this.restore(active, port, options, false, attempted);
						}
						try {
							attempted.add(change.path);
							await port.write(change.path, change.before, change.after, () => allowed() && fresh.isCurrent());
						} catch {
							// Classify all files, including an unreadable write, without replaying it.
							return this.restore(active, port, options, false, attempted);
						}
						if (await port.read(change.path) !== change.after) return this.restore(active, port, options, false, attempted);
						this.progress(options, 'apply', index + 1, record, change.path);
					}
					if (!allowed()) return this.restore(active, port, options, false, attempted);
					for (const change of record.changes) if (await port.read(change.path) !== change.after) return this.restore(active, port, options, false, attempted);
					const finalInventory = await port.identities(record.keyMappings, undefined, scope);
					if (!finalInventory.isCurrent() || finalInventory.unavailablePaths.length || restoreIdentityConflict(finalInventory, record)) {
						return this.restore(active, port, options, false, attempted);
					}
					// Completion is part of the explicit Apply action. Cleanup never replays source writes.
					if (options.finalizeOnSuccess) {
						const result = await this.finish(active, 'kept', 'committed');
						return { ...result, sourcesCommitted: true };
					}
					return { ...this.result('committed', record), sourcesCommitted: true };
				} catch (error) {
					const state = await this.recovery.load();
					if (state.kind === 'active' && state.record.id === record.id && attempted.size) {
						try { return await this.restore(state, port, options, false, attempted); } catch { /* Preserve uncertain evidence. */ }
					}
					return this.result(state.kind === 'empty' ? 'not-applied' : 'recovery-required', record,
						error instanceof Error ? error.message : 'Conversion failed');
				}
			});
		});
	}

	async inspect(): Promise<TasksConversionInspection> {
		return this.recovery.exclusive(async () => {
			const state = freeze(await this.recovery.load());
			if (state.kind !== 'active') return { state, files: [], canUndo: false, canRestore: false, canKeep: false };
			return this.host.exclusive(state.record.changes.map(change => change.path), async port => {
				const files = await this.classify(state.record, port);
				let safe = false;
				try { const inventory = await port.identities(state.record.keyMappings); safe = inventory.isCurrent() && !inventory.unavailablePaths.length && !restoreIdentityConflict(inventory, state.record); } catch { /* Fail closed. */ }
				return { state, files, canUndo: safe && files.every(file => file.state === 'after'),
					canRestore: safe && files.every(file => file.state !== 'conflict'), canKeep: files.every(file => file.state === 'after') };
			});
		});
	}

	async resolve(action: 'undo' | 'restore' | 'keep' | 'cleanup', expectedId: string, options: TasksConversionRunOptions = {}): Promise<TasksConversionResult> {
		return this.recovery.exclusive(async () => {
			const state = await this.recovery.load();
			if (state.kind === 'empty') return this.result('not-applied', null, 'No active conversion');
			if (state.kind === 'blocked') return this.result('recovery-required', null, state.message);
			const id = state.kind === 'active' ? state.record.id : state.resolution.id;
			if (id !== expectedId) return this.result('not-applied', null, 'Recovery identity changed');
			if (state.kind === 'resolved') {
				if (action !== 'cleanup') return this.result('cleanup-pending', state.record, 'Only cleanup remains');
				try { await this.recovery.cleanup(); return { ...this.result(state.resolution.decision, state.record), recordId: id }; }
				catch { return { ...this.result('cleanup-pending', state.record), recordId: id }; }
			}
			if (action === 'cleanup') return this.result('not-applied', state.record, 'Conversion is unresolved');
			return this.host.exclusive(state.record.changes.map(change => change.path), async port => {
				try {
					if (options.canCommit?.() === false) return this.result('cancelled', state.record);
					const files = await this.classify(state.record, port);
					if (files.some(file => file.state === 'conflict') || (action !== 'restore' && files.some(file => file.state !== 'after'))) {
						return this.result('recovery-required', state.record, 'Recovery source changed');
					}
					if (action === 'keep') return this.finish(state, 'kept');
					return this.restore(state, port, options, true);
				} catch (error) { return this.result('recovery-required', state.record, error instanceof Error ? error.message : 'Recovery failed'); }
			});
		});
	}

	private async restore(active: Extract<TasksConversionRecoveryState, { kind: 'active' }>, port: TasksConversionWritePort,
		options: TasksConversionRunOptions, explicit = false, attempted?: ReadonlySet<string>): Promise<TasksConversionResult> {
		const record = active.record;
		const files = await this.classify(record, port);
		const scope = explicit ? undefined : { paths: record.changes.map(change => change.path), operonIds: record.operonIds, repeatSeriesIds: record.repeatSeriesIds };
		const inventory = await port.identities(record.keyMappings, undefined, scope);
		const candidates = attempted ? record.changes.filter(change => attempted.has(change.path)
			&& files.some(file => file.path === change.path && file.state === 'after')) : record.changes;
		const candidatePaths = new Set(candidates.map(change => change.path));
		const owned = inventory.sources.filter(source => candidatePaths.has(source.path));
		const targets = attempted ? { ...record, changes: candidates,
			operonIds: record.operonIds.filter(id => owned.some(source => source.operonIds.includes(id))),
			repeatSeriesIds: record.repeatSeriesIds.filter(id => owned.some(source => source.repeatSeriesIds.includes(id))) } : record;
		if ((!attempted && files.some(file => file.state === 'conflict')) || !inventory.isCurrent() || inventory.unavailablePaths.length || restoreIdentityConflict(inventory, targets)) {
			return this.result('recovery-required', record, 'Conditional restore is unsafe');
		}
		const reversed = [...candidates].reverse();
		for (const [index, change] of reversed.entries()) {
			if (explicit && options.canCommit?.() === false) return this.result('recovery-required', record, 'Restore interrupted');
			const current = await port.read(change.path);
			if (current !== change.before) {
				if (current !== change.after) return this.result('recovery-required', record, 'Restore source changed');
				const fresh = await port.identities(record.keyMappings, undefined, scope);
				if (!fresh.isCurrent() || fresh.unavailablePaths.length || restoreIdentityConflict(fresh, targets)) return this.result('recovery-required', record, 'Restore identity changed');
				try { await port.write(change.path, change.after, change.before, () => fresh.isCurrent() && (!explicit || options.canCommit?.() !== false)); }
				catch { if (await port.read(change.path) !== change.before) return this.result('recovery-required', record, 'Restore write could not be verified'); }
			}
			if (await port.read(change.path) !== change.before) return this.result('recovery-required', record, 'Restore verification failed');
			this.progress(options, 'restore', index + 1, record, change.path);
		}
		for (const change of record.changes) if (await port.read(change.path) !== change.before) return this.result('recovery-required', record, 'Restored source changed');
		return { ...await this.finish(active, 'restored', explicit ? 'restored' : 'rolled-back'), sourcesTouched: true };
	}
	private async classify(record: TasksConversionRecord, port: Pick<TasksConversionWritePort, 'read'>): Promise<TasksConversionInspection['files']> {
		const files: TasksConversionInspection['files'] = [];
		for (const change of record.changes) {
			try {
				const current = await port.read(change.path);
				files.push({ path: change.path, state: current === change.before ? 'before' : current === change.after ? 'after' : 'conflict' });
			} catch { files.push({ path: change.path, state: 'conflict' }); }
		}
		return files;
	}
	private async finish(active: Extract<TasksConversionRecoveryState, { kind: 'active' }>, decision: 'kept' | 'restored', status: TasksConversionOutcome = decision): Promise<TasksConversionResult> {
		try { await this.recovery.resolve(active, decision); await this.recovery.cleanup(); return this.result(status, active.record); }
		catch {
			try { const state = await this.recovery.load(); return this.result(state.kind === 'resolved' ? 'cleanup-pending' : 'recovery-required', active.record, 'Recovery evidence retained'); }
			catch { return this.result('recovery-required', active.record, 'Recovery evidence retained'); }
		}
	}
	private result(status: TasksConversionOutcome, record: TasksConversionRecord | null, message?: string): TasksConversionResult {
		return { status, taskCount: record?.taskCount ?? 0, paths: record?.changes.map(change => change.path) ?? [], ...(record ? { recordId: record.id } : {}), ...(message ? { message } : {}) };
	}
	private progress(options: TasksConversionRunOptions, phase: 'apply' | 'restore', completedFiles: number, record: TasksConversionRecord, path: string): void {
		try { options.onProgress?.({ phase, completedFiles, totalFiles: record.changes.length, path }); } catch { /* Observers do not own the transaction. */ }
	}
}
