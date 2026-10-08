import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { App, TFile, type DataAdapter } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/types/settings';
import type { OperonIndexer } from '../src/indexer/indexer';
import { TaskWriter } from '../src/core/task-writer';
import { parseTaskLine } from '../src/core/parser';
import { tasksConversionProtectedLines, isTasksConversionPath } from '../src/core/tasks-conversion-scope';
import { resolveTasksConversionPaths, type TasksConversionScope } from '../src/core/tasks-conversion-plan';
import { TasksConversionService } from '../src/systems/tasks-conversion-service';
import { createTasksConversionHost, collectTasksConversionIdentities } from '../src/systems/tasks-conversion-obsidian';
import { TasksConversionRecoveryStore } from '../src/storage/tasks-conversion-recovery';
import { sha256HexForStorage } from '../src/storage/storage-sha256';

class ObservedFiles extends Map<string, string> {
	changed?: (file: string) => void;
	set(file: string, content: string) { const result = super.set(file, content); this.changed?.(file); return result; }
	delete(file: string) { const result = super.delete(file); if (result) this.changed?.(file); return result; }
}
export class MemoryAdapter {
	files = new ObservedFiles();
	folders = new Set<string>();
	writes: string[] = [];
	removes: string[] = [];
	beforeWrite?: (file: string, value: string) => void;
	afterWrite?: (file: string, value: string) => void;
	beforeRemove?: (file: string) => void;
	async exists(file: string) { return this.files.has(file) || this.folders.has(file); }
	async read(file: string) { const content = this.files.get(file); if (content === undefined) throw new Error('Missing file'); return content; }
	async write(file: string, value: string) {
		this.writes.push(file); this.beforeWrite?.(file, value); this.files.set(file, value); this.afterWrite?.(file, value);
	}
	async mkdir(file: string) { this.folders.add(file); }
	async remove(file: string) { this.removes.push(file); this.beforeRemove?.(file); this.files.delete(file); }
	async list(folder: string) {
		const direct = (file: string) => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/');
		return { files: [...this.files.keys()].filter(direct), folders: [...this.folders].filter(direct) };
	}
}

export function fixture(notes: Record<string, string> = { 'A.md': '- [ ] A 🆔 A', 'B.md': '- [ ] B ⛔ A' }) {
	const adapter = new MemoryAdapter();
	for (const [file, content] of Object.entries(notes)) adapter.files.set(file, content);
	return wiredFixture(adapter);
}
export function wiredFixture(adapter: MemoryAdapter) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const buffers = new Map<string, string>();
	const references: string[] = [], reservedSeriesIds: string[] = [];
	const listeners = new Set<() => void>();
	adapter.files.changed = name => { if (name.endsWith('.md')) for (const listener of listeners) listener(); };
	const files = new Map<string, TFile>();
	const file = (name: string) => {
		let value = files.get(name);
		if (!value) { value = new (TFile as unknown as new (path: string) => TFile)(name); files.set(name, value); }
		return value;
	};
	const app = { vault: {
		configDir: '.test-config', adapter,
		on: (_event: string, listener: () => void) => { listeners.add(listener); return listener; },
		offref: (listener: () => void) => listeners.delete(listener),
		getMarkdownFiles: () => [...adapter.files.keys()].filter(name => name.endsWith('.md')).map(file),
		getAbstractFileByPath: (name: string) => adapter.files.has(name) ? file(name) : null,
		read: (source: TFile) => adapter.read(source.path),
		process: async (source: TFile, transform: (content: string) => string) => {
			const next = transform(await adapter.read(source.path)); await adapter.write(source.path, next); return next;
		},
	} } as unknown as App;
	const writer = new TaskWriter(app, {} as OperonIndexer, settings.keyMappings, { validatePluginWritePath: async () => true });
	const host = createTasksConversionHost(app, writer, () => settings, {
		matches: (name, content) => !buffers.has(name) || buffers.get(name) === content,
		synchronize: (name, before, after) => {
			if (!buffers.has(name)) return true;
			if (buffers.get(name) !== before) return false;
			buffers.set(name, after); return true;
		},
	}, async () => {
		const snapshot = JSON.stringify([references, reservedSeriesIds]);
		return { externalReferences: [...references], reservedSeriesIds: [...reservedSeriesIds],
			isCurrent: () => snapshot === JSON.stringify([references, reservedSeriesIds]) };
	});
	const store = new TasksConversionRecoveryStore(adapter as unknown as DataAdapter, app.vault.configDir);
	let counter = 0, series = 0;
	const fresh = () => new TasksConversionService(host, store, {
		now: () => '2026-10-08T17:00:00',
		operonId: used => { let id: string; do { id = `a${(++counter).toString(36).padStart(6, '0')}`; } while (used.has(id)); return id; },
		repeatSeriesId: used => { let id: string; do { id = `rs${(++series).toString(36).padStart(5, '0')}`; } while (used.has(id)); return id; },
	});
	const service = fresh();
	const scope: TasksConversionScope = { files: [], folders: ['/'], includeSubfolders: true };
	const preview = async () => service.preview(await service.scan(scope));
	return { adapter, settings, buffers, references, reservedSeriesIds, app, writer, host, store, service, fresh, scope, preview };
}

test('scope dedupes mixed files/folders and respects direct/subfolder selection', () => {
	const inventory = ['A.md', 'Work/A.md', 'Work/Sub/B.md', 'Work2/C.md'];
	assert.deepEqual(resolveTasksConversionPaths({ files: ['Work/A.md', 'A.md'], folders: ['Work', 'Work'], includeSubfolders: false }, inventory), ['A.md', 'Work/A.md']);
	assert.deepEqual(resolveTasksConversionPaths({ files: [], folders: ['Work'], includeSubfolders: true }, inventory), ['Work/A.md', 'Work/Sub/B.md']);
	assert.deepEqual(resolveTasksConversionPaths({ files: [], folders: ['/'], includeSubfolders: false }, inventory), ['A.md']);
});
for (const invalid of ['../A.md', '/A.md', 'A/../B.md', 'A\\B.md', '.obsidian/A.md', ' A.md', 'A.md\n', 'A//B.md', 'C:A.md', 'A\u007f.md']) {
	test(`rejects unsafe source/recovery path ${JSON.stringify(invalid)}`, () => {
		assert.equal(isTasksConversionPath(invalid), false);
		assert.throws(() => resolveTasksConversionPaths({ files: [invalid], folders: [], includeSubfolders: false }, []));
	});
}
for (const content of [
	'---\nexample: |\n  - [ ] Hidden 📅 2026-10-08\n---\n- [ ] Visible 🆔 A',
	'```md\n- [ ] Hidden 🆔 X\n~~~\n- [ ] Hidden too 🆔 Y\n```\n- [ ] Visible 🆔 A',
	'~~~~\n- [ ] Hidden 🆔 X\n~~~\n- [ ] Hidden too 🆔 Y\n~~~~\n- [ ] Visible 🆔 A',
	'<!--\n- [ ] Hidden 🆔 X\n-->\n- [ ] Visible 🆔 A',
	'%%\n- [ ] Hidden 🆔 X\n%%\n- [ ] Visible 🆔 A',
	'<pre>\n- [ ] Hidden 🆔 X\n</pre>\n- [ ] Visible 🆔 A',
	'<div>\n- [ ] Hidden 🆔 X\n</div>\n- [ ] Visible 🆔 A',
	'<div>\n<div>\n</div>\n- [ ] Hidden 🆔 X\n</div>\n- [ ] Visible 🆔 A',
	'<div data-note="</div>">\n- [ ] Hidden 🆔 X\n</div>\n- [ ] Visible 🆔 A',
	'<div>\n<span title="</div>">\n- [ ] Hidden 🆔 X\n</div>\n- [ ] Visible 🆔 A',
	'<div>\n<span title="\n</div>\n- [ ] Hidden 🆔 X\n">text</span>\n</div>\n- [ ] Visible 🆔 A',
	'<div data-note="\n</div>\n- [ ] Hidden 🆔 X\n">\n</div>\n- [ ] Visible 🆔 A',
	'<div></div><!--\n- [ ] Hidden 🆔 X\n-->\n- [ ] Visible 🆔 A',
	'<div>\n</div>%%\n- [ ] Hidden 🆔 X\n%%\n- [ ] Visible 🆔 A',
	'<!--\n```\n- [ ] Hidden 🆔 X\n-->\n- [ ] Visible 🆔 A',
	'%%\n~~~\n- [ ] Hidden 🆔 X\n%%\n- [ ] Visible 🆔 A',
	'- Parent\n  ```\n  - [ ] Hidden 🆔 X\n- [ ] Visible 🆔 A',
	'    - [ ] Hidden 🆔 X\n\n- [ ] Visible 🆔 A',
]) {
	test(`protects document blocks: ${content.slice(0, 15)}`, async () => {
		const f = fixture({ 'A.md': content }); const preview = await f.preview();
		assert.equal(preview.operonIds.length, 1);
		assert.ok(preview.changes[0].after.includes('Visible'));
		assert.deepEqual(f.adapter.writes, []);
		for (const row of preview.rows.filter(row => !row.selected)) assert.ok(preview.changes[0].after.includes(row.before));
	});
}
for (const opening of ['---\nkey: |', '```md', '<!--', '%%', '<pre>']) {
	test(`unclosed protection fails closed: ${opening}`, () => {
		const lines = `${opening}\n- [ ] Hidden 🆔 X`;
		assert.ok(tasksConversionProtectedLines(lines).has(lines.split('\n').length - 1));
	});
}
test('nested lists remain eligible while list-relative indented code is protected', async () => {
	const content = '- Parent\n    - [ ] Nested 🆔 A\n      - [ ] Deeper 🆔 B\n            - [ ] Code 🆔 C\n- [ ] Root 🆔 D';
	const f = fixture({ 'A.md': content }); const p = await f.preview();
	assert.equal(p.operonIds.length, 3);
	assert.ok(p.rows.find(row => row.before.includes('Code'))?.status === 'protected');
	assert.match(p.changes[0].after, /\n    - \[ \] Nested/u);
});
test('inline code/link comment lookalikes do not mask later tasks', async () => {
	const f = fixture({ 'A.md': '- [ ] Example `%%` [<!--](target) 🆔 A\n- [ ] Real 🆔 B' });
	assert.equal((await f.preview()).operonIds.length, 2);
});
test('normal checkbox, existing Operon and hybrid rows are never selected', async () => {
	const f = fixture({ 'A.md': '- [ ] Plain\n- [>] Custom\n- [ ] Existing {{operonId:: zzzzzzz}}\n- [ ] Hybrid {{operonId:: yyyyyyy}} 🆔 H\n- [ ] Tasks 🆔 A' });
	const p = await f.preview(); assert.equal(p.operonIds.length, 1);
	assert.deepEqual(p.rows.map(row => row.status), ['not_tasks_emoji', 'not_tasks_emoji', 'already_operon', 'hybrid_unsupported', 'eligible']);
});
test('settings exclusions, missing files and dirty buffers are reported without writes', async () => {
	const f = fixture({ 'Skip/A.md': '- [ ] A 🆔 A', 'Templates/B.md': '- [ ] B 🆔 B', 'Dirty.md': '- [ ] D 🆔 D' });
	f.settings.excludedFolders = ['Skip']; f.settings.fileTaskTemplateFolder = 'Templates'; f.buffers.set('Dirty.md', 'Edited');
	const scan = await f.service.scan({ ...f.scope, files: ['Missing.md'] });
	assert.equal(scan.rows.length, 0); assert.equal(scan.files.length, 4);
	assert.ok(scan.files.every(source => !!source.error)); assert.deepEqual(f.adapter.writes, []);
});
test('CRLF, final newline and all non-task content are preserved', async () => {
	const before = '# Header\r\n\r\n- [ ] A 🆔 A\r\nUnrelated `data`\r\n';
	const f = fixture({ 'A.md': before }); const p = await f.preview();
	assert.equal(p.changes[0].after.split('\n').length, before.split('\n').length);
	assert.ok(p.changes[0].after.endsWith('Unrelated `data`\r\n'));
	assert.ok(!p.changes[0].after.replace(/\r\n/gu, '').includes('\n'));
	assert.equal((await f.service.apply(p)).status, 'committed'); assert.equal(await f.adapter.read('A.md'), p.changes[0].after);
});
test('selection recomputes dependencies without reallocating identities, time or repeat IDs', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A 🔁 every day 📅 2026-10-08', 'B.md': '- [ ] B ⛔ A' });
	const scan = await f.service.scan(f.scope), all = f.service.preview(scan);
	const b = all.rows.find(row => row.path === 'B.md')!;
	const onlyB = f.service.preview(scan, [b.key]);
	assert.equal(onlyB.operonIds[0], b.operonId); assert.equal(onlyB.scan.timestamp, all.scan.timestamp);
	assert.match(onlyB.rows.find(row => row.selected)!.after!, /Tasks syntax leftovers/u);
	assert.ok(!onlyB.rows.find(row => row.selected)!.after!.includes('{{blockedBy::'));
	assert.deepEqual(f.service.preview(scan).repeatSeriesIds, all.repeatSeriesIds);
	assert.deepEqual(f.adapter.writes, []);
});
test('independent conversion applies defaults, metadata precedence and no inherited parent', async () => {
	const f = fixture({ 'A.md': '- [ ] Parent {{operonId:: zzzzzzz}} {{priority:: High}}\n  - [ ] Child ⏬ 🆔 A' });
	f.settings.autoParentFileTask = true;
	const p = await f.preview(), row = p.rows.find(row => row.selected)!;
	const task = parseTaskLine(row.after!, row.lineNumber, row.path, f.settings.keyMappings)!;
	assert.ok(!task.fields.some(field => field.key === 'parentTask'));
	assert.notEqual(task.fields.find(field => field.key === 'priority')?.value, 'High');
	assert.equal(task.fields.find(field => field.key === 'datetimeModified')?.value, '2026-10-08T17:00:00');
});
test('preview is immutable and cannot be applied by a foreign service', async () => {
	const f = fixture(), p = await f.preview();
	assert.throws(() => { p.changes[0].after = 'Injected'; });
	assert.throws(() => f.service.preview(p.scan, ['not-a-task']));
	assert.equal((await f.fresh().apply(p)).status, 'not-applied'); assert.deepEqual(f.adapter.writes, []);
});
for (const modification of ['content', 'same-size', 'missing', 'dirty', 'settings', 'identity', 'series', 'inventory']) {
	test(`preflight ${modification} causes zero writes for the entire selection`, async () => {
		const f = fixture({ 'A.md': '- [ ] A 🆔 A 🔁 every day 📅 2026-10-08', 'B.md': '- [ ] B ⛔ A' }), p = await f.preview();
		if (modification === 'content') f.adapter.files.set('B.md', `${await f.adapter.read('B.md')} edited`);
		if (modification === 'same-size') f.adapter.files.set('B.md', (await f.adapter.read('B.md')).replace('B', 'C'));
		if (modification === 'missing') f.adapter.files.delete('B.md');
		if (modification === 'dirty') f.buffers.set('B.md', 'Unsaved');
		if (modification === 'settings') f.settings.defaultPriority = 'Changed';
		if (modification === 'identity') f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: ${p.operonIds[0]}}}`);
		if (modification === 'series') f.reservedSeriesIds.push(p.repeatSeriesIds[0]);
		if (modification === 'inventory') f.adapter.files.set('Other.md', '---\nUnclosed');
		assert.equal((await f.service.apply(p)).status, 'not-applied'); assert.deepEqual(f.adapter.writes, []);
	});
}
test('cancel and empty selection have zero persistent writes', async () => {
	const f = fixture(), p = await f.preview();
	assert.equal((await f.service.apply(p, { canCommit: () => false })).status, 'cancelled');
	assert.equal((await f.service.apply(f.service.preview(p.scan, []))).status, 'not-applied');
	assert.deepEqual(f.adapter.writes, []);
});
test('backup publication and readback precede notes; apply exactly matches preview', async () => {
	const f = fixture(), p = await f.preview();
	f.adapter.beforeWrite = file => { if (file.endsWith('.md')) assert.ok(f.adapter.files.has(`${f.store.directory}/active.json`)); };
	assert.equal((await f.service.apply(p)).status, 'committed');
	assert.equal(f.adapter.writes[0], `${f.store.directory}/active.json`);
	for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.after);
	assert.equal((await f.fresh().inspect()).canUndo, true);
	assert.equal((await f.service.apply(p)).status, 'recovery-required');
});
for (const failure of ['before', 'torn', 'after', 'readback']) {
	test(`backup ${failure} failure never permits an unverified note write`, async () => {
		const f = fixture(), p = await f.preview(), active = `${f.store.directory}/active.json`;
		if (failure === 'before') f.adapter.beforeWrite = file => { if (file === active) throw new Error('No space'); };
		if (failure === 'torn') f.adapter.afterWrite = file => { if (file === active) { f.adapter.files.set(active, '{'); throw new Error('Interrupted'); } };
		if (failure === 'after') f.adapter.afterWrite = file => { if (file === active) throw new Error('Lost ack'); };
		if (failure === 'readback') { const read = f.adapter.read.bind(f.adapter); f.adapter.read = async file => { if (file === active) throw new Error('Read failure'); return read(file); }; }
		const result = await f.service.apply(p);
		if (failure === 'after') assert.equal(result.status, 'committed');
		else { assert.notEqual(result.status, 'committed'); assert.ok(f.adapter.writes.every(file => !file.endsWith('.md'))); }
	});
}
for (const index of [0, 1]) {
	test(`note failure at boundary ${index} restores exact preimages`, async () => {
		const f = fixture(), p = await f.preview();
		f.adapter.beforeWrite = file => { if (file === p.changes[index].path) throw new Error('Disk failure'); };
		assert.equal((await f.service.apply(p)).status, 'rolled-back');
		for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.before);
		assert.equal((await f.store.load()).kind, 'empty');
	});
}
test('lost note acknowledgement is observed without replaying the write', async () => {
	const f = fixture(), p = await f.preview(); f.adapter.afterWrite = file => { if (file === 'A.md') throw new Error('Lost ack'); };
	assert.equal((await f.service.apply(p)).status, 'committed');
	assert.equal(f.adapter.writes.filter(file => file === 'A.md').length, 1);
});
test('mid-apply cancellation rolls back and observers cannot break transaction', async () => {
	const f = fixture(), p = await f.preview(); let allowed = true;
	assert.equal((await f.service.apply(p, { canCommit: () => allowed, onProgress: progress => {
		if (progress.phase === 'apply') allowed = false; throw new Error('UI observer failed');
	} })).status, 'rolled-back');
	for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.before);
});
test('settings changed during backup publication cause safe rollback without note conversion', async () => {
	const f = fixture(), p = await f.preview();
	f.adapter.afterWrite = file => { if (file.endsWith('active.json')) f.settings.defaultPriority = 'Changed'; };
	assert.equal((await f.service.apply(p)).status, 'rolled-back');
	assert.ok(f.adapter.writes.every(file => !file.endsWith('.md')));
});
test('concurrent user content is preserved and uncertain conversion is never replayed', async () => {
	const f = fixture(), p = await f.preview();
	f.adapter.afterWrite = file => { if (file === 'A.md') f.adapter.files.set('A.md', 'User edit'); };
	assert.equal((await f.service.apply(p)).status, 'recovery-required');
	assert.equal(await f.adapter.read('A.md'), 'User edit'); assert.equal(f.adapter.writes.filter(file => file === 'A.md').length, 1);
	assert.equal((await f.fresh().inspect()).canRestore, false);
});
for (const mutation of ['body', 'dirty', 'missing', 'copied', 'reference', 'workflow', 'comment-reference', 'series-workflow']) {
	test(`undo refuses ${mutation} without any note write`, async () => {
		const f = mutation === 'series-workflow' ? fixture({ 'A.md': '- [ ] A 🔁 every day 📅 2026-10-08' }) : fixture();
		const p = await f.preview(); await f.service.apply(p);
		const state = await f.store.load(); assert.equal(state.kind, 'active'); if (state.kind !== 'active') return;
		if (mutation === 'body') f.adapter.files.set('A.md', `${await f.adapter.read('A.md')}\nLater edit`);
		if (mutation === 'dirty') f.buffers.set('B.md', 'Later unsaved edit');
		if (mutation === 'missing') f.adapter.files.delete('B.md');
		if (mutation === 'copied') f.adapter.files.set('Other.md', p.changes[0].after);
		if (mutation === 'reference') f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: zzzzzzz}} {{blockedBy:: ${p.operonIds[0]}}}`);
		if (mutation === 'workflow') f.references.push(p.operonIds[0]);
		if (mutation === 'comment-reference') f.adapter.files.set('Other.md', `<!--\n- [ ] Other {{operonId:: zzzzzzz}} {{related:: ${p.operonIds[0]}}}\n-->`);
		if (mutation === 'series-workflow') f.reservedSeriesIds.push(p.repeatSeriesIds[0]);
		const count = f.adapter.writes.length;
		assert.equal((await f.fresh().inspect()).canUndo, false);
		assert.equal((await f.fresh().resolve('undo', state.record.id)).status, 'recovery-required');
		assert.equal(f.adapter.writes.length, count); assert.equal((await f.store.load()).kind, 'active');
	});
}
test('reload inspection is read-only; conditional undo restores bytes and clears evidence', async () => {
	const f = fixture(), p = await f.preview(); await f.service.apply(p); const count = f.adapter.writes.length;
	const inspection = await f.fresh().inspect(); assert.equal(inspection.canUndo, true); assert.equal(f.adapter.writes.length, count);
	if (inspection.state.kind !== 'active') throw new Error('Missing recovery');
	assert.equal((await f.fresh().resolve('undo', inspection.state.record.id)).status, 'restored');
	for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.before);
	assert.equal((await f.store.load()).kind, 'empty');
	assert.equal((await f.fresh().resolve('undo', inspection.state.record.id)).status, 'not-applied');
});
test('keep retains converted bytes, resolves evidence and permits the next scan', async () => {
	const f = fixture(), p = await f.preview(); await f.service.apply(p);
	const state = await f.store.load(); if (state.kind !== 'active') throw new Error('Missing recovery');
	assert.equal((await f.fresh().resolve('keep', state.record.id)).status, 'kept');
	for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.after);
	assert.equal((await f.store.load()).kind, 'empty'); assert.equal((await f.preview()).operonIds.length, 0);
});
for (const applied of [0, 1, 2]) {
	test(`interrupted session at ${applied} committed files recovers only on explicit request`, async () => {
		const f = fixture(), p = await f.preview();
		await f.store.exclusive(() => f.store.create({ format: 'operon-tasks-conversion', version: 1, id: 'interrupted',
			changes: p.changes, operonIds: p.operonIds, repeatSeriesIds: p.repeatSeriesIds, keyMappings: f.settings.keyMappings, taskCount: p.operonIds.length }));
		for (const change of p.changes.slice(0, applied)) f.adapter.files.set(change.path, change.after);
		const count = f.adapter.writes.length, inspection = await f.fresh().inspect();
		assert.equal(f.adapter.writes.length, count); assert.equal(inspection.canRestore, true);
		assert.equal(inspection.canUndo, applied === 2); assert.equal(inspection.canKeep, applied === 2);
		assert.equal((await f.fresh().resolve('restore', 'interrupted')).status, 'restored');
		for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.before);
	});
}
for (const removeAt of ['active.json', 'resolved.json']) {
	test(`cleanup failure at ${removeAt} remains resumable after reload`, async () => {
		const f = fixture(), p = await f.preview(); await f.service.apply(p); const state = await f.store.load();
		if (state.kind !== 'active') throw new Error('Missing recovery');
		f.adapter.beforeRemove = file => { if (file.endsWith(removeAt)) throw new Error('Removal failed'); };
		assert.equal((await f.service.resolve('keep', state.record.id)).status, 'cleanup-pending');
		assert.equal((await f.fresh().inspect()).state.kind, 'resolved');
		f.adapter.beforeRemove = undefined;
		assert.equal((await f.fresh().resolve('cleanup', state.record.id)).status, 'kept');
		assert.equal((await f.store.load()).kind, 'empty');
	});
}
for (const corrupt of ['invalid-json', 'checksum', 'future', 'unsafe-path', 'unknown-file', 'numeric-id', 'unrelated-edit', 'wrong-id', 'extra-line']) {
	test(`corrupt/unsupported recovery ${corrupt} is preserved with zero writes on load`, async () => {
		const f = fixture(), p = await f.preview(); await f.service.apply(p); const active = `${f.store.directory}/active.json`;
		if (corrupt === 'invalid-json') f.adapter.files.set(active, '{');
		else if (corrupt === 'unknown-file') f.adapter.files.set(`${f.store.directory}/unknown.tmp`, 'Evidence');
		else {
			const parsed = JSON.parse(await f.adapter.read(active));
			if (corrupt === 'checksum') parsed.sha256 = 'bad';
			if (corrupt === 'future') parsed.payload.version = 2;
			if (corrupt === 'unsafe-path') parsed.payload.changes[0].path = '../Escape.md';
			if (corrupt === 'numeric-id') parsed.payload.operonIds[0] = 1234567;
			if (corrupt === 'unrelated-edit') parsed.payload.changes[0].before = 'Unrelated paragraph';
			if (corrupt === 'wrong-id') parsed.payload.operonIds[0] = 'zzzzzzz';
			if (corrupt === 'extra-line') parsed.payload.changes[0].after += '\nUnexpected';
			if (corrupt !== 'checksum') parsed.sha256 = await sha256HexForStorage(JSON.stringify(parsed.payload));
			f.adapter.files.set(active, JSON.stringify(parsed));
		}
		const count = f.adapter.writes.length, before = new Map(f.adapter.files);
		assert.equal((await f.fresh().inspect()).state.kind, 'blocked');
		assert.equal(f.adapter.writes.length, count); assert.deepEqual(new Map(f.adapter.files), before);
		assert.equal((await f.service.apply(p)).status, 'recovery-required');
	});
}
test('multiple service instances serialize apply and cannot replace the open record', async () => {
	const f = fixture(); const first = await f.preview(), other = f.fresh(), second = other.preview(await other.scan(f.scope));
	const results = await Promise.all([f.service.apply(first), other.apply(second)]);
	assert.deepEqual(results.map(result => result.status), ['committed', 'recovery-required']);
	assert.equal(f.adapter.writes.filter(file => file.endsWith('active.json')).length, 1);
});
test('an existing TaskWriter mutation and conversion share the same coordination gate', async () => {
	const f = fixture(), p = await f.preview(), edit = `${p.changes[0].before}\nUser edit`;
	const competing = f.writer.applyExactMarkdownSourceMutation('A.md', p.changes[0].before, edit, undefined, undefined, 'plugin');
	const [mutation, conversion] = await Promise.all([competing, f.service.apply(p)]);
	assert.equal(mutation.outcome, 'committed'); assert.equal(conversion.status, 'not-applied');
	assert.equal(await f.adapter.read('A.md'), edit); assert.equal(await f.adapter.read('B.md'), p.changes[1].before);
	assert.equal((await f.store.load()).kind, 'empty');
});
test('identity inspection includes mapped YAML, duplicate fields and reciprocal references', () => {
	const content = '---\noperonId: zzzzzzz\nblockedBy:\n  - aaaaaaa\n---\n- [ ] Other {{operonId:: bbbbbbb}} {{operonId:: ccccccc}} {{related:: aaaaaaa}}';
	const identities = collectTasksConversionIdentities('A.md', content, []);
	assert.deepEqual(identities[0].references, ['aaaaaaa']);
	assert.deepEqual(identities[1].operonIds, ['bbbbbbb', 'ccccccc']);
});

test('scan reserves IDs in the actual indexer scope, including comments and indented lines', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'Other.md': '<!--\n- [ ] Hidden {{operonId:: a000001}}\n-->\n    - [ ] Code {{operonId:: a000002}}' });
	const p = await f.preview(); assert.deepEqual(p.operonIds, ['a000003']);
	assert.equal((await f.service.apply(p)).status, 'committed');
});
for (const linked of [false, true]) {
	test(`failed apply preserves a changed unwritten file and safely restores earlier files: linked=${linked}`, async () => {
		const f = fixture(), p = await f.preview();
		const edit = linked ? `- [ ] User {{operonId:: zzzzzzz}} {{related:: ${p.operonIds[0]}}}` : 'User edit';
		const result = await f.service.apply(p, { onProgress: progress => {
			if (progress.phase === 'apply' && progress.path === 'A.md') f.adapter.files.set('B.md', edit);
		} });
		assert.equal(result.status, 'recovery-required'); assert.equal(await f.adapter.read('B.md'), edit);
		assert.equal(await f.adapter.read('A.md'), linked ? p.changes[0].after : p.changes[0].before);
		assert.equal((await f.store.load()).kind, 'active');
	});
}
test('cancelled undo retains recoverable evidence and resumes after reload', async () => {
	const f = fixture(), p = await f.preview(); await f.service.apply(p);
	const state = await f.store.load(); if (state.kind !== 'active') throw new Error('Missing recovery');
	let allowed = true;
	assert.equal((await f.service.resolve('undo', state.record.id, { canCommit: () => allowed,
		onProgress: progress => { if (progress.phase === 'restore') allowed = false; } })).status, 'recovery-required');
	assert.equal(await f.adapter.read('B.md'), p.changes[1].before);
	assert.equal(await f.adapter.read('A.md'), p.changes[0].after);
	assert.equal((await f.fresh().resolve('restore', state.record.id)).status, 'restored');
	for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.before);
});
for (const index of [0, 1]) {
	test(`undo write failure at boundary ${index} can resume without forward replay`, async () => {
		const f = fixture(), p = await f.preview(); await f.service.apply(p);
		const state = await f.store.load(); if (state.kind !== 'active') throw new Error('Missing recovery');
		f.adapter.beforeWrite = file => { if (file === [...p.changes].reverse()[index].path) throw new Error('Restore interrupted'); };
		assert.equal((await f.service.resolve('undo', state.record.id)).status, 'recovery-required');
		f.adapter.beforeWrite = undefined;
		assert.equal((await f.fresh().resolve('restore', state.record.id)).status, 'restored');
		for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.before);
	});
}
for (const failure of ['before', 'torn', 'after']) {
	test(`resolution publication ${failure} preserves either recoverable or terminal evidence`, async () => {
		const f = fixture(), p = await f.preview(); await f.service.apply(p);
		const state = await f.store.load(); if (state.kind !== 'active') throw new Error('Missing recovery');
		f.adapter.beforeWrite = file => { if (failure === 'before' && file.endsWith('resolved.json')) throw new Error('No space'); };
		f.adapter.afterWrite = file => {
			if (!file.endsWith('resolved.json')) return;
			if (failure === 'torn') f.adapter.files.set(file, '{');
			if (failure !== 'before') throw new Error('Lost ack');
		};
		assert.equal((await f.service.resolve('keep', state.record.id)).status, failure === 'after' ? 'kept' : 'recovery-required');
		assert.equal((await f.store.load()).kind, failure === 'after' ? 'empty' : failure === 'torn' ? 'blocked' : 'active');
		for (const change of p.changes) assert.equal(await f.adapter.read(change.path), change.after);
	});
}
test('late unsaved buffer change is preserved and cannot be overwritten by rollback', async () => {
	const f = fixture(), p = await f.preview(); f.buffers.set('A.md', p.changes[0].before);
	f.adapter.afterWrite = file => { if (file === 'A.md') f.buffers.set('A.md', 'Late unsaved user edit'); };
	assert.equal((await f.service.apply(p)).status, 'recovery-required');
	assert.equal(f.buffers.get('A.md'), 'Late unsaved user edit');
	assert.equal(f.adapter.writes.filter(file => file === 'A.md').length, 1);
});
test('identity inventory detects a file appearing during its read snapshot', async () => {
	const f = fixture(), p = await f.preview(); const read = f.adapter.read.bind(f.adapter);
	let reads = 0;
	f.adapter.read = async file => { const value = await read(file); if (file === 'B.md' && ++reads === 2) f.adapter.files.set('New.md', '- [ ] Other {{operonId:: zzzzzzz}}'); return value; };
	assert.equal((await f.service.apply(p)).status, 'not-applied'); assert.deepEqual(f.adapter.writes, []);
});
test('backup-time collision in an existing file causes zero note writes', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'Other.md': 'Unrelated' }), p = await f.preview();
	f.adapter.afterWrite = file => { if (file.endsWith('active.json')) f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: ${p.operonIds[0]}}}`); };
	assert.notEqual((await f.service.apply(p)).status, 'committed');
	assert.ok(f.adapter.writes.every(file => !file.endsWith('.md')));
	assert.equal(await f.adapter.read('A.md'), p.changes[0].before);
});
test('same-path mutation during identity inventory invalidates preflight with zero writes', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'Other.md': 'Unrelated', 'Z.md': 'Last' }), p = await f.preview();
	const read = f.adapter.read.bind(f.adapter);
	f.adapter.read = async file => { const content = await read(file); if (file === 'Z.md') f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: ${p.operonIds[0]}}}`); return content; };
	assert.equal((await f.service.apply(p)).status, 'not-applied'); assert.deepEqual(f.adapter.writes, []);
});
test('undo refuses an external relationship appearing during inventory without note writes', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'Other.md': 'Unrelated', 'Z.md': 'Last' }), p = await f.preview();
	await f.service.apply(p); const state = await f.store.load(); if (state.kind !== 'active') throw new Error('Missing recovery');
	const read = f.adapter.read.bind(f.adapter), count = f.adapter.writes.length;
	f.adapter.read = async file => { const content = await read(file); if (file === 'Z.md') f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: zzzzzzz}} {{related:: ${p.operonIds[0]}}}`); return content; };
	assert.equal((await f.service.resolve('undo', state.record.id)).status, 'recovery-required');
	assert.equal(f.adapter.writes.length, count); assert.equal(await read('A.md'), p.changes[0].after);
});

export class DiskAdapter extends MemoryAdapter {
	constructor(readonly root: string) { super(); }
	private physical(file: string) { const target = path.resolve(this.root, file); if (!target.startsWith(`${this.root}/`)) throw new Error('Fixture path escape'); return target; }
	async exists(file: string) { try { await stat(this.physical(file)); return true; } catch { return false; } }
	async read(file: string) { return readFile(this.physical(file), 'utf8'); }
	async write(file: string, value: string) {
		this.writes.push(file); this.beforeWrite?.(file, value); await writeFile(this.physical(file), value, 'utf8'); this.files.set(file, value); this.afterWrite?.(file, value);
	}
	async mkdir(file: string) { await mkdir(this.physical(file), { recursive: true }); this.folders.add(file); }
	async remove(file: string) { this.removes.push(file); this.beforeRemove?.(file); await rm(this.physical(file)); this.files.delete(file); }
	async list(folder: string) {
		const entries = await readdir(this.physical(folder), { withFileTypes: true });
		return { files: entries.filter(entry => entry.isFile()).map(entry => `${folder}/${entry.name}`), folders: entries.filter(entry => entry.isDirectory()).map(entry => `${folder}/${entry.name}`) };
	}
}
test('real filesystem adapter, production TaskWriter and reload recovery restore sealed synthetic notes', async () => {
	const fixtureBase = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
	const root = await mkdtemp(path.join(fixtureBase, 'operon-conversion-fixture-'));
	const sealed = await mkdtemp(path.join(fixtureBase, 'operon-conversion-sealed-'));
	try {
		const adapter = new DiskAdapter(root);
		const originals = { 'A.md': '# A\r\n- [ ] A 🆔 A\r\n', 'B.md': '- [ ] B ⛔ A\n', 'Unrelated.md': '---\nType: Note\n---\nUntouched\n' };
		const hashes = new Map<string, string>();
		for (const [file, content] of Object.entries(originals)) {
			await adapter.write(file, content); await writeFile(path.join(sealed, file), content, 'utf8'); hashes.set(file, await sha256HexForStorage(content));
		}
		adapter.writes.length = 0;
		const f = wiredFixture(adapter), p = await f.preview();
		assert.equal((await f.service.apply(p)).status, 'committed');
		assert.ok(adapter.writes.every(file => file === 'A.md' || file === 'B.md' || file.startsWith(`${f.store.directory}/`)));
		const inspection = await f.fresh().inspect(); if (inspection.state.kind !== 'active') throw new Error('Missing persisted fixture record');
		assert.equal((await f.fresh().resolve('undo', inspection.state.record.id)).status, 'restored');
		for (const [file, digest] of hashes) {
			assert.equal(await sha256HexForStorage(await adapter.read(file)), digest);
			assert.equal(await adapter.read(file), await readFile(path.join(sealed, file), 'utf8'));
		}
		const count = adapter.writes.length; assert.equal((await f.fresh().inspect()).state.kind, 'empty'); assert.equal(adapter.writes.length, count);
	} finally { await rm(root, { recursive: true, force: true }); await rm(sealed, { recursive: true, force: true }); }
});

for (const boundary of ['resolved-write', 'active-remove', 'resolved-remove'] as const) {
 test(`auto finalization retains committed sources at ${boundary} failure and reload cleanup never replays notes`, async () => {
  const f = fixture(), preview = await f.preview();
  f.adapter.beforeWrite = name => { if (boundary === 'resolved-write' && name.endsWith('/resolved.json')) throw new Error('marker failed'); };
  f.adapter.beforeRemove = name => { if (boundary === 'active-remove' && name.endsWith('/active.json') || boundary === 'resolved-remove' && name.endsWith('/resolved.json')) throw new Error('cleanup failed'); };
  const result = await f.service.apply(preview, { finalizeOnSuccess: true });
  assert.equal(result.sourcesCommitted, true);
  assert.equal(result.status, boundary === 'resolved-write' ? 'recovery-required' : 'cleanup-pending');
  for (const change of preview.changes) assert.equal(await f.adapter.read(change.path), change.after);
  const noteWrites = f.adapter.writes.filter(name => name.endsWith('.md')).length;
  f.adapter.beforeWrite = undefined; f.adapter.beforeRemove = undefined;
  const fresh = f.fresh(), state = (await fresh.inspect()).state;
  assert.notEqual(state.kind, 'empty');
  if (state.kind === 'active') assert.equal((await fresh.resolve('keep', state.record.id)).status, 'kept');
  else if (state.kind === 'resolved') assert.equal((await fresh.resolve('cleanup', state.resolution.id)).status, 'kept');
  else assert.fail('Expected valid retained evidence');
  assert.equal((await fresh.inspect()).state.kind, 'empty');
  assert.equal(f.adapter.writes.filter(name => name.endsWith('.md')).length, noteWrites);
 });
}
test('auto finalization removes pending decision and permits next conversion without undo/keep', async () => {
 const f = fixture(), preview = await f.preview();
 assert.equal((await f.service.apply(preview, { finalizeOnSuccess: true })).status, 'committed');
 assert.equal((await f.fresh().inspect()).state.kind, 'empty');
 f.adapter.files.set('C.md', '- [ ] C 📅 2026-10-10');
 const next = f.service.preview(await f.service.scan({ files: ['C.md'], folders: [], includeSubfolders: true }));
 assert.equal((await f.service.apply(next, { finalizeOnSuccess: true })).status, 'committed');
});
test('late cancel during finalization leaves committed sources intact', async () => {
 const f = fixture(), preview = await f.preview(); let allowed = true;
 f.adapter.beforeWrite = name => { if (name.endsWith('/resolved.json')) allowed = false; };
 const result = await f.service.apply(preview, { finalizeOnSuccess: true, canCommit: () => allowed });
 assert.equal(result.status, 'committed');
 for (const change of preview.changes) assert.equal(await f.adapter.read(change.path), change.after);
});
test('scan progress abort stops before any persistence and observers cannot mutate transaction', async () => {
 const f = fixture(), abort = new AbortController();
 await assert.rejects(f.service.scan(f.scope, { signal: abort.signal, onProgress: () => abort.abort() }), { name: 'AbortError' });
 assert.deepEqual(f.adapter.writes, []);
 assert.equal((await f.store.load()).kind, 'empty');
});
