import type { DataAdapter } from 'obsidian';
import type { KeyMapping } from '../types/settings';
import type { TasksConversionFileChange } from '../core/tasks-conversion-plan';
import { tasksConversionSnapshotsConsistent } from '../core/tasks-conversion-plan';
import { isTasksConversionPath } from '../core/tasks-conversion-scope';
import { isValidOperonId, isValidRepeatSeriesId } from '../core/id-generator';
import { sha256HexForStorage } from './storage-sha256';

export interface TasksConversionRecord {
	format: 'operon-tasks-conversion'; version: 1; id: string;
	changes: TasksConversionFileChange[]; operonIds: string[]; repeatSeriesIds: string[];
	keyMappings: KeyMapping[]; taskCount: number;
}
type Adapter = Pick<DataAdapter, 'exists' | 'read' | 'write' | 'remove' | 'mkdir' | 'list'>;
type Resolution = { id: string; digest: string; decision: 'kept' | 'restored' };
export type TasksConversionRecoveryState =
	| { kind: 'empty' }
	| { kind: 'active'; record: TasksConversionRecord; raw: string; digest: string }
	| { kind: 'resolved'; record: TasksConversionRecord | null; raw: string | null; resolution: Resolution; resolutionRaw: string }
	| { kind: 'blocked'; message: string };
const queues = new WeakMap<Adapter, Map<string, Promise<void>>>();

function recordLike(value: unknown): value is TasksConversionRecord {
	if (!value || typeof value !== 'object') return false;
	const v = value as Partial<TasksConversionRecord>;
	if (v.format !== 'operon-tasks-conversion' || v.version !== 1 || typeof v.id !== 'string'
		|| !/^[a-zA-Z0-9-]{1,100}$/u.test(v.id) || !Array.isArray(v.changes) || !v.changes.length
		|| !Array.isArray(v.operonIds) || !v.operonIds.length || !v.operonIds.every(id => typeof id === 'string' && isValidOperonId(id))
		|| new Set(v.operonIds).size !== v.operonIds.length || v.taskCount !== v.operonIds.length
		|| !Array.isArray(v.repeatSeriesIds) || !v.repeatSeriesIds.every(id => typeof id === 'string' && isValidRepeatSeriesId(id))
		|| new Set(v.repeatSeriesIds).size !== v.repeatSeriesIds.length || !Array.isArray(v.keyMappings)) return false;
	if (!v.keyMappings.every(mapping => mapping && typeof mapping.canonicalKey === 'string'
		&& typeof mapping.visiblePropertyName === 'string' && typeof mapping.enabled === 'boolean'
		&& ['text', 'number', 'date', 'datetime', 'list', 'checkbox'].includes(mapping.type)
		&& ['yes', 'no', 'auto'].includes(mapping.sync) && typeof mapping.isSystem === 'boolean')) return false;
	const paths = new Set<string>();
	for (const change of v.changes) {
		if (!change || typeof change.path !== 'string' || !isTasksConversionPath(change.path) || paths.has(change.path)
			|| typeof change.before !== 'string' || typeof change.after !== 'string' || change.before === change.after) return false;
		paths.add(change.path);
	}
	return tasksConversionSnapshotsConsistent(v as TasksConversionRecord);
}

async function envelope(payload: unknown): Promise<string> {
	return JSON.stringify({ payload, sha256: await sha256HexForStorage(JSON.stringify(payload)) });
}
async function decode(raw: string): Promise<unknown> {
	const value = JSON.parse(raw) as { payload?: unknown; sha256?: unknown };
	if (!value || typeof value.sha256 !== 'string'
		|| value.sha256 !== await sha256HexForStorage(JSON.stringify(value.payload))) throw new Error('Recovery checksum mismatch');
	return value.payload;
}

/** Immutable preimages followed by an immutable resolution marker. No startup mutations. */
export class TasksConversionRecoveryStore {
	readonly directory: string;
	private readonly activePath: string;
	private readonly resolvedPath: string;
	constructor(private readonly adapter: Adapter, configDir: string) {
		if (!configDir || configDir.includes('\\') || Array.from(configDir).some(char => char.charCodeAt(0) < 32)
			|| configDir.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid vault configuration directory');
		this.directory = `${configDir}/plugins/operon/state/tasks-conversion`;
		this.activePath = `${this.directory}/active.json`;
		this.resolvedPath = `${this.directory}/resolved.json`;
	}

	/** Serialize the complete apply/recovery operation, also across service instances. */
	async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		let paths = queues.get(this.adapter);
		if (!paths) { paths = new Map(); queues.set(this.adapter, paths); }
		const previous = paths.get(this.directory) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(operation);
		const pending = run.then(() => undefined, () => undefined);
		paths.set(this.directory, pending);
		try { return await run; } finally { if (paths.get(this.directory) === pending) paths.delete(this.directory); }
	}

	async load(): Promise<TasksConversionRecoveryState> {
		try {
			if (!await this.adapter.exists(this.directory)) return { kind: 'empty' };
			const inventory = await this.adapter.list(this.directory);
			if (inventory.folders.length || inventory.files.some(path => path !== this.activePath && path !== this.resolvedPath)) {
				return { kind: 'blocked', message: 'Unowned Tasks conversion recovery files' };
			}
			const raw = await this.read(this.activePath), resolutionRaw = await this.read(this.resolvedPath);
			if (raw === null && resolutionRaw === null) return { kind: 'empty' };
			const candidate = raw === null ? null : await decode(raw);
			if (candidate !== null && !recordLike(candidate)) throw new Error('Invalid or unsupported Tasks conversion record');
			const record = candidate;
			if (resolutionRaw !== null) {
				const resolution = await decode(resolutionRaw) as Resolution;
				if (!resolution || typeof resolution.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/u.test(resolution.id)
					|| typeof resolution.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(resolution.digest)
					|| !['kept', 'restored'].includes(resolution.decision)
					|| record && (resolution.id !== record.id || resolution.digest !== await sha256HexForStorage(raw!))) {
					throw new Error('Invalid Tasks conversion resolution marker');
				}
				return { kind: 'resolved', record, raw, resolution, resolutionRaw };
			}
			if (!record || raw === null) throw new Error('Recovery preimage is missing');
			return { kind: 'active', record, raw, digest: await sha256HexForStorage(raw) };
		} catch (error) { return { kind: 'blocked', message: error instanceof Error ? error.message : 'Recovery is unreadable' }; }
	}

	async create(record: TasksConversionRecord): Promise<void> {
		if (!recordLike(record) || (await this.load()).kind !== 'empty') throw new Error('Tasks recovery is not available');
		const segments = this.directory.split('/');
		for (let i = 1; i <= segments.length; i++) {
			const path = segments.slice(0, i).join('/');
			if (!await this.adapter.exists(path)) await this.adapter.mkdir(path);
		}
		await this.createVerified(this.activePath, await envelope(record));
	}

	async resolve(active: Extract<TasksConversionRecoveryState, { kind: 'active' }>, decision: Resolution['decision']): Promise<void> {
		if (await this.read(this.activePath) !== active.raw) throw new Error('Recovery record changed');
		await this.createVerified(this.resolvedPath, await envelope({ id: active.record.id, digest: active.digest, decision }));
	}

	async cleanup(): Promise<void> {
		const state = await this.load();
		if (state.kind === 'empty') return;
		if (state.kind !== 'resolved') throw new Error('Unresolved Tasks recovery cannot be removed');
		if (state.raw !== null) await this.removeVerified(this.activePath, state.raw);
		await this.removeVerified(this.resolvedPath, state.resolutionRaw);
		if ((await this.load()).kind !== 'empty') throw new Error('Tasks recovery cleanup is incomplete');
	}

	private async read(path: string): Promise<string | null> {
		return await this.adapter.exists(path) ? await this.adapter.read(path) : null;
	}
	private async createVerified(path: string, raw: string): Promise<void> {
		if (await this.adapter.exists(path)) throw new Error('Recovery publication already exists');
		// Never overwrite an earlier record or replay a write after a lost acknowledgement.
		try { await this.adapter.write(path, raw); } catch { /* Observe once below. */ }
		if (await this.read(path) !== raw) throw new Error('Recovery publication was not verified');
	}
	private async removeVerified(path: string, raw: string): Promise<void> {
		if (await this.read(path) !== raw) throw new Error('Recovery cleanup source changed');
		try { await this.adapter.remove(path); } catch { /* Observe rather than replay. */ }
		if (await this.adapter.exists(path)) throw new Error('Recovery cleanup failed');
	}
}
