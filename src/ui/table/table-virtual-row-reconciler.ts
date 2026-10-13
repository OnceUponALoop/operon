import type { TableTaskTreeRenderItem } from './table-task-tree';
import type { IndexedTask } from '../../types/fields';
import type { TableColumn } from '../../types/table';
import type { TableValueResolver } from './table-value-cache';
import type { TableFilePropertyCellValue } from './table-file-property';
import { TABLE_LINE_NUMBER_COLUMN_KEY, TABLE_TASK_TREE_COLUMN_KEY } from '../../types/table';
import { parseTableTaskListValue } from './table-value-adapter';

interface TaskRowState {
 columns: TableColumn[];
 taskOrdinals: Map<string, number>;
 valueResolver: TableValueResolver;
 getFilePropertyCell: (task: IndexedTask, key: string) => TableFilePropertyCellValue;
 getContextFilePropertyCell: (task: IndexedTask, key: string) => TableFilePropertyCellValue;
}
/** Only visible rows are fingerprinted; source identity and action preconditions are included. */
export function getTableRowRevision(item: TableTaskTreeRenderItem, state: TaskRowState, extras: unknown): unknown {
 if (item.kind !== 'task' && item.kind !== 'parentContext') return state;
 const task = item.task;
 return JSON.stringify([task, extras, item.kind === 'task' ? [item.tree, state.columns.some(column => column.key === TABLE_LINE_NUMBER_COLUMN_KEY) ? state.taskOrdinals.get(item.ordinalKey) : null] : item.occurrenceKey,
  state.columns.map(column => {
   const key = item.kind === 'parentContext' && column.key === TABLE_TASK_TREE_COLUMN_KEY ? 'progress' : column.key;
   return [key, state.valueResolver.getDisplayValue(task, key),
   key === 'progress' || key === 'checkboxProgress' ? state.valueResolver.getProgressTrack(task, key === 'progress' ? 'subtasks' : 'checkboxes') : null,
   (item.kind === 'parentContext' ? state.getContextFilePropertyCell : state.getFilePropertyCell)(task, column.key),
   ['blockedBy', 'blocking', 'parentTask'].includes(column.key) ? parseTableTaskListValue(column.key, state.valueResolver.getRawValue(task, column.key)).map(id => state.valueResolver.taskLookup.getTask(id.trim())) : null]; })]);
}

/** Retained handlers resolve dynamic picker/lookup context at use time, not at row creation. */
export function createTableLiveRowContext<T extends object>(current: () => T | null, retained: () => T | null): T {
 // A row must not retain the large snapshot from the generation in which it was created.
 return new Proxy({} as T, {
  get(_target, key) {
   const latest = current();
   // Candidate lists are global projections, so never offer stale suggestions while pending.
   if (!latest && (key === 'getFilePropertyCandidates' || key === 'getContextFilePropertyCandidates')) return () => [];
   const source = latest ?? retained();
   return source ? Reflect.get(source, key) : undefined;
  },
 });
}


export interface TableVirtualRowDescriptor<TItem> {
	key: string;
	item: TItem;
	index: number;
}

export interface TableVirtualRowCache<TRow> {
	host: object | null;
	renderIdentity: object | null;
	rows: Map<string, TRow>;
	revisions: Map<string, unknown>;
}

export interface TableVirtualRowReconcileStats {
	created: number;
	reused: number;
	removed: number;
	entered: number;
	exited: number;
	reset: boolean;
}

export interface TableVirtualRowReconcileResult<TItem, TRow> {
	entries: Array<TableVirtualRowDescriptor<TItem> & { row: TRow }>;
	stats: TableVirtualRowReconcileStats;
}

interface ReconcileTableVirtualRowsOptions<TItem, TRow> {
	cache: TableVirtualRowCache<TRow>;
	host: object;
	renderIdentity: object;
	items: readonly TItem[];
	startIndex: number;
	endIndex: number;
	forceReset?: boolean;
	resolveKey: (item: TItem) => string;
	/** Opt in to row-level validity across coherent render snapshots. */
	resolveRevision?: (item: TItem) => unknown;
	createRow: (descriptor: TableVirtualRowDescriptor<TItem>) => TRow;
	updateRow?: (row: TRow, descriptor: TableVirtualRowDescriptor<TItem>) => void;
	removeRow: (row: TRow) => void;
}

export function createTableVirtualRowCache<TRow>(): TableVirtualRowCache<TRow> {
	return {
		host: null,
		renderIdentity: null,
		rows: new Map<string, TRow>(),
		revisions: new Map<string, unknown>(),
	};
}

export function resolveTableVirtualRowKey(item: TableTaskTreeRenderItem): string {
	if (item.kind === 'task') return `task:${item.ordinalKey}`;
	if (item.kind === 'parentContext') return `parentContext:${item.occurrenceKey}`;
	if (item.kind === 'group') return `group:${item.groupKey}`;
	if (item.kind === 'groupSummary') return `groupSummary:${item.groupKey}`;
	return 'summary:total';
}

export function clearTableVirtualRowCache<TRow>(
	cache: TableVirtualRowCache<TRow>,
	removeRow: (row: TRow) => void,
): number {
	let removed = 0;
	for (const row of cache.rows.values()) {
		removeRow(row);
		removed += 1;
	}
	cache.rows.clear();
	cache.revisions.clear();
	cache.host = null;
	cache.renderIdentity = null;
	return removed;
}

export function reconcileTableVirtualRows<TItem, TRow>(
	options: ReconcileTableVirtualRowsOptions<TItem, TRow>,
): TableVirtualRowReconcileResult<TItem, TRow> {
	const startIndex = Math.max(0, Math.min(options.items.length, Math.floor(options.startIndex)));
	const endIndex = Math.max(startIndex, Math.min(options.items.length, Math.ceil(options.endIndex)));
	const descriptors: TableVirtualRowDescriptor<TItem>[] = [];
	for (let index = startIndex; index < endIndex; index += 1) {
		const item = options.items[index];
		if (item === undefined) continue;
		descriptors.push({ key: options.resolveKey(item), item, index });
	}
	const desiredKeys = new Set(descriptors.map(descriptor => descriptor.key));
	const hostChanged = options.cache.host !== null && options.cache.host !== options.host;
	const identityChanged = options.cache.renderIdentity !== null
		&& options.cache.renderIdentity !== options.renderIdentity;
	const reset = options.forceReset === true || hostChanged || (identityChanged && !options.resolveRevision);
	let removed = 0;
	let exited = 0;
	if (reset) {
		exited = options.cache.rows.size;
		removed = clearTableVirtualRowCache(options.cache, options.removeRow);
	} else {
		for (const [key, row] of options.cache.rows) {
			if (desiredKeys.has(key)) continue;
			options.removeRow(row);
			options.cache.rows.delete(key);
			options.cache.revisions.delete(key);
			removed += 1;
			exited += 1;
		}
	}
	options.cache.host = options.host;
	options.cache.renderIdentity = options.renderIdentity;

	let created = 0;
	let reused = 0;
	let entered = 0;
	const entries: Array<TableVirtualRowDescriptor<TItem> & { row: TRow }> = [];
	for (const descriptor of descriptors) {
		let row = options.cache.rows.get(descriptor.key);
		const revision = options.resolveRevision?.(descriptor.item);
		if (row !== undefined && options.resolveRevision && options.cache.revisions.get(descriptor.key) !== revision) {
			options.removeRow(row);
			options.cache.rows.delete(descriptor.key);
			removed += 1;
			row = undefined;
		}
		options.cache.revisions.set(descriptor.key, revision);
		if (row === undefined) {
			row = options.createRow(descriptor);
			options.cache.rows.set(descriptor.key, row);
			created += 1;
			entered += 1;
		} else {
			reused += 1;
		}
		options.updateRow?.(row, descriptor);
		entries.push({ ...descriptor, row });
	}
	return {
		entries,
		stats: { created, reused, removed, entered, exited, reset },
	};
}

export function orderTableVirtualRowElements(container: HTMLElement, elements: readonly HTMLElement[]): void {
	let cursor = container.firstElementChild;
	for (const element of elements) {
		if (element === cursor) {
			cursor = cursor.nextElementSibling;
			continue;
		}
		container.insertBefore(element, cursor);
	}
}
