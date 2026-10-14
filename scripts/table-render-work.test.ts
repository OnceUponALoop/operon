import { buildTableFieldLayoutSignature } from '../src/ui/table/table-signature';
import assert from 'node:assert/strict';
import type { TableTaskTreeRenderItem } from '../src/ui/table/table-task-tree';
import { createTableVirtualRowCache, reconcileTableVirtualRows, createTableLiveRowContext, getTableRowRevision } from '../src/ui/table/table-virtual-row-reconciler';

/** Operation-count guards: independent of machine speed and timer precision. */
export function testTableRenderWork(): void {
	{
  const fields = [{ key: 'note.Flag', label: 'Flag', type: 'checkbox' as const, group: 'fileProperty' as const,
   icon: 'square', readonly: false, aliases: ['Flag'], sourceFileCount: 0 }];
  const before = buildTableFieldLayoutSignature(fields);
  const presentFields = [{ ...fields[0], sourceFileCount: 1, aliases: ['Flag', 'note.Flag'] }];
  assert.equal(buildTableFieldLayoutSignature(presentFields), before);
  assert.notEqual(buildTableFieldLayoutSignature([{ ...fields[0], type: 'text' }]), before);
 }
	// A coherent generation change is not itself a reason to rebuild stable rows.
	{
		const cache = createTableVirtualRowCache<{ revision: string }>();
		const host = {};
		let items = [{ id: 'a', revision: '0' }, { id: 'b', revision: '0' }];
		const render = () => reconcileTableVirtualRows({ cache, host, renderIdentity: {}, items,
			startIndex: 0, endIndex: items.length, resolveKey: item => item.id, resolveRevision: item => item.revision,
			createRow: ({ item }) => ({ revision: item.revision }), removeRow: () => undefined });
		const first = render();
		items = [{ id: 'b', revision: '0' }, { id: 'a', revision: '1' }];
		const next = render();
		assert.equal(next.stats.created, 1);
		assert.equal(next.stats.reused, 1);
		assert.equal(next.stats.reset, false);
		assert.equal(next.entries[0].row, first.entries[1].row, 'sorting moves stable DOM instead of replacing it');
		assert.notEqual(next.entries[1].row, first.entries[0].row);
		items = [];
		render();
		assert.equal(cache.revisions.size, 0, 'removed source identities do not accumulate');
		const initial = { getFilePropertyCandidates: () => ['old'], source: 'before' };
		let current: typeof initial | null = initial;
		let retained: typeof initial | null = initial;
		const context = createTableLiveRowContext(() => current, () => retained);
		current = { getFilePropertyCandidates: () => ['new'], source: 'after' };
		assert.deepEqual(context.getFilePropertyCandidates(), ['new']);
		assert.equal(context.source, 'after', 'retained handlers resolve current context');
		current = null;
		assert.deepEqual(context.getFilePropertyCandidates(), [], 'pending data cannot leak as picker candidates');
		retained = { ...initial, source: 'last-painted' };
		assert.equal(context.source, 'last-painted', 'fallback resolves the single surface-owned snapshot');
		retained = null;assert.equal(context.source, undefined, 'closed surfaces retain no initial snapshot');
	}

	// A rounded percentage alone is insufficient: zero of one and zero of two render differently.
	{
		let total = 1;
		const state = { columns: [{ key: 'progress' }], taskOrdinals: new Map(),
			valueResolver: { getDisplayValue: () => '0%', getProgressTrack: () => ({ completed: 0, total }), taskLookup: { getTask: () => null } },
			getFilePropertyCell: () => ({}), getContextFilePropertyCell: () => ({}) } as unknown as Parameters<typeof getTableRowRevision>[1];
		const item = { kind: 'task', task: { operonId: 'parent' }, ordinalKey: 'parent' } as Extract<TableTaskTreeRenderItem, { kind: 'task' }>;
		const before = getTableRowRevision(item, state, null);total = 2;
		assert.notEqual(getTableRowRevision(item, state, null), before);
		state.columns = [{ key: '__taskTree', kind: 'task' }];
		const parent = { kind: 'parentContext', task: item.task, occurrenceKey: 'context' } as TableTaskTreeRenderItem;
		const contextBefore = getTableRowRevision(parent, state, null);total = 3;
		assert.notEqual(getTableRowRevision(parent, state, null), contextBefore, 'parent context resolves its progress content');
	}

	for (const columnCount of [10, 20, 30]) {
		let tasks = Array.from({ length: 10_000 }, (_, id) => ({ id: String(id), source: `task-${id}.md`, revision: 0 }));
		type Task = typeof tasks[number];
		type Row = { task: Task; cells: number };
		const cache = createTableVirtualRowCache<Row>();
		const host = {};
		let identity = {};
		let rowBuilds = 0;
		let cellBuilds = 0;
		let removed = 0;
		const render = (start: number, forceReset = false) => reconcileTableVirtualRows({
			cache, host, renderIdentity: identity, items: tasks,
			startIndex: start, endIndex: start + 40, forceReset,
			resolveKey: task => task.id,
			createRow: ({ item }) => {
				rowBuilds += 1;
				cellBuilds += columnCount;
				return { task: item, cells: columnCount };
			},
			removeRow: () => { removed += 1; },
		});
		const initial = render(0);
		assert.equal(rowBuilds, 40);
		assert.equal(cellBuilds, 40 * columnCount);
		assert.equal(initial.stats.created, rowBuilds, 'row factory calls match logical additions');
		const scroll = render(20);
		assert.equal(rowBuilds, 60, 'only twenty entering rows are built');
		assert.equal(cellBuilds, 60 * columnCount);
		assert.equal(removed, 20);
		for (let i = 0; i < 20; i++) assert.equal(scroll.entries[i]?.row, initial.entries[i + 20]?.row);
		const unchanged = render(20);
		assert.equal(rowBuilds, 60, 'an unchanged scroll window does no construction');
		assert.equal(unchanged.stats.created, 0);
		assert.equal(unchanged.stats.reused, 40);
		const jump = render(400);
		assert.equal(rowBuilds, 100);
		assert.equal(jump.stats.created, 40);
		assert.equal(jump.stats.removed, 40);
		assert.equal(cache.rows.size, 40, 'the cache stays bounded to the visible range');

		// A save/reindex uses the historical rebuild path, with current source objects.
		tasks = tasks.map(task => ({ ...task, revision: task.revision + 1, source: `new-${task.id}.md` }));
		identity = {};
		const saved = render(400);
		assert.equal(rowBuilds, 140, 'refresh builds one row per displayed task, with no comparison rows');
		assert.equal(cellBuilds, 140 * columnCount);
		assert.equal(saved.stats.reused, 0);
		for (let i = 0; i < 40; i++) {
			assert.equal(saved.entries[i]?.row.task, tasks[i + 400], 'rebuilt rows receive the latest indexed task');
			assert.notEqual(saved.entries[i]?.row, jump.entries[i]?.row);
		}
		const forced = render(400, true);
		assert.equal(rowBuilds, 180);
		assert.equal(forced.stats.created, 40);
		assert.equal(forced.stats.removed, 40);
	}
}
