import { prepareCreationTemplate } from '../src/core/task-creation-template';
import { prepareDefaultInlineTemplateTask } from '../src/core/default-inline-template';
import { createTasksConversionReferenceInventory, tasksConversionCardReferences } from '../src/systems/tasks-conversion-references';
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
import { resolveTasksConversionPaths, serializeTasksConversionSettings, tasksConversionSettingsSnapshot, type TasksConversionScope } from '../src/core/tasks-conversion-plan';
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
	const listeners = new Set<(file: TFile) => void>();
	adapter.files.changed = name => { if (name.endsWith('.md')) for (const listener of listeners) listener(file(name)); };
	const files = new Map<string, TFile>();
	const file = (name: string) => {
		let value = files.get(name);
		if (!value) { value = new (TFile as unknown as new (path: string) => TFile)(name); files.set(name, value); }
		return value;
	};
	const app = { vault: {
		configDir: '.test-config', adapter,
		on: (_event: string, listener: (file: TFile) => void) => { listeners.add(listener); return listener; },
		offref: (listener: (file: TFile) => void) => listeners.delete(listener),
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
	}, undefined, () => ({ sources: [...adapter.files].filter(([name]) => name.endsWith('.md')).flatMap(([name, content]) => {
		try { return collectTasksConversionIdentities(name, content, settings.keyMappings); } catch { return collectTasksConversionIdentities(name, content, settings.keyMappings, true); }
	}), externalReferences: [...references], reservedSeriesIds: [...reservedSeriesIds] }));
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

test('combined conversion and native index: 10 files / 100 Tasks remain independent and undo retires records', async () => {
 const { OperonIndexer: Indexer } = await import('../src/indexer/indexer');
 const { getNativePropertyIndex } = await import('../src/indexer/native-property-index');
 const notes = Object.fromEntries(Array.from({length:10},(_,file)=>[`Batch${file}.md`,Array.from({length:10},(_,row)=>`- [ ] Task ${file}-${row} #etiket/çalışma 📅 2026-10-11`).join('\n')]));
 const f=fixture(notes);
 Object.assign(f.app,{metadataCache:{getFileCache:()=>({listItems:[{task:' '}]})}});
 const native=getNativePropertyIndex(f.app);native.configure(f.settings);native.setTypes({});
 const indexer=new Indexer(f.app,{getSettings:()=>f.settings} as never);
 try {
  const preview=await f.preview();assert.equal(preview.selectedKeys.length,100);assert.equal(preview.changes.length,10);
  assert.equal((await f.service.apply(preview)).status,'committed');
  assert.equal(f.adapter.writes.filter(path=>path.endsWith('.md')).length,10);
  for(const file of f.app.vault.getMarkdownFiles())file.stat={mtime:1,ctime:1,size:f.adapter.files.get(file.path)!.length};
  await indexer.fullReindex();const tasks=indexer.getAllTasks();assert.equal(tasks.length,100);
  for(const task of tasks){assert.ok(!task.fieldValues.parentTask);assert.ok(native.getTask(task).available);assert.ok(task.tags.includes('etiket/çalışma'));}
  const repeated=await f.preview();assert.equal(repeated.selectedKeys.length,0);
  const inspection=await f.service.inspect();assert.equal(inspection.state.kind,'active');
  if(inspection.state.kind!=='active')assert.fail('Missing recovery record');
  assert.equal((await f.service.resolve('undo',inspection.state.record.id)).status,'restored');
  await indexer.fullReindex();assert.equal(indexer.getAllTasks().length,0);
  for(const task of tasks)assert.equal(native.getTask(task).available,false);
  for(const [path,content] of Object.entries(notes))assert.equal(f.adapter.files.get(path),content);
  console.log('SETTINGS_CONVERSION_CHAIN',JSON.stringify({files:10,tasks:100,applyWrites:10,undoWrites:f.adapter.writes.filter(path=>path.endsWith('.md')).length-10}));
 }finally{indexer.destroy();}
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
for (const unrelated of ['---\nUnclosed', '---\nTitle: %invalid YAML\n---\nNote', '---\noperonId: { nested: invalid }\n---\nTemplate']) {
	test(`selected conversion never reads unrelated malformed frontmatter: ${unrelated}`, async () => {
		const f = fixture({ 'A.md': '- [ ] Repeat 🔁 every day 📅 2026-10-08', 'Template.md': unrelated });
		const read = f.adapter.read.bind(f.adapter), reads: string[] = [];
		f.buffers.set('Template.md', 'Unsaved unrelated editor');
		f.adapter.read = async name => { reads.push(name); if (name === 'Template.md') throw new Error('Unrelated file must not be read'); return read(name); };
		const scan = await f.service.scan({ files: ['A.md'], folders: [], includeSubfolders: true });
		assert.deepEqual(f.adapter.writes, []);
		const preview = f.service.preview(scan);
		f.adapter.afterWrite = name => { if (name.endsWith('active.json')) f.adapter.files.set('Template.md', `${unrelated}\nUnrelated edit`); };
		assert.equal((await f.service.apply(preview, { finalizeOnSuccess: true })).status, 'committed');
		assert.equal(await read('A.md'), preview.changes[0].after);
		assert.equal(reads.includes('Template.md'), false);
		assert.equal((await f.store.load()).kind, 'empty');
	});
}
test('selected closed frontmatter remains opaque and byte-for-byte unchanged', async () => {
	const header = '---\r\nTitle: %invalid YAML\r\noperonId: { nested: invalid }\r\n---\r\n';
	const f = fixture({ 'A.md': `${header}- [ ] A 📅 2026-10-08\r\n` }), preview = await f.preview();
	assert.equal(preview.operonIds.length, 1);
	assert.ok(preview.changes[0].after.startsWith(header));
	assert.equal((await f.service.apply(preview, { finalizeOnSuccess: true })).status, 'committed');
	assert.equal(await f.adapter.read('A.md'), preview.changes[0].after);
});
test('cancellation rolls back selected files without reading unrelated broken notes', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'B.md': '- [ ] B ⛔ A', 'Template.md': '---\nUnclosed' });
	const read = f.adapter.read.bind(f.adapter);
	f.adapter.read = async name => { if (name === 'Template.md') throw new Error('Unrelated read'); return read(name); };
	const preview = f.service.preview(await f.service.scan({ files: ['A.md', 'B.md'], folders: [], includeSubfolders: true }));
	let allowed = true;
	const result = await f.service.apply(preview, { canCommit: () => allowed, onProgress: progress => { if (progress.phase === 'apply') allowed = false; } });
	assert.equal(result.status, 'rolled-back');
	for (const change of preview.changes) assert.equal(await read(change.path), change.before);
	assert.equal((await f.store.load()).kind, 'empty');
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
for (const modification of ['content', 'same-size', 'missing', 'dirty', 'settings', 'identity', 'series']) {
	test(`preflight ${modification} causes zero writes for the entire selection`, async () => {
		const f = fixture({ 'A.md': '- [ ] A 🆔 A 🔁 every day 📅 2026-10-08', 'B.md': '- [ ] B ⛔ A' }), p = await f.preview();
		if (modification === 'content') f.adapter.files.set('B.md', `${await f.adapter.read('B.md')} edited`);
		if (modification === 'same-size') f.adapter.files.set('B.md', (await f.adapter.read('B.md')).replace('B', 'C'));
		if (modification === 'missing') f.adapter.files.delete('B.md');
		if (modification === 'dirty') f.buffers.set('B.md', 'Unsaved');
		if (modification === 'settings') f.settings.defaultPriority = 'Changed';
		if (modification === 'identity') f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: ${p.operonIds[0]}}}`);
		if (modification === 'series') f.reservedSeriesIds.push(p.repeatSeriesIds[0]);
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

test('RAM index reserves a selected file task identity without parsing its frontmatter for conversion', async () => {
	const f = fixture({ 'A.md': '---\noperonId: a000001\n---\n- [ ] A 🆔 A' }), preview = await f.preview();
	assert.deepEqual(preview.operonIds, ['a000002']);
	assert.equal((await f.service.apply(preview)).status, 'committed');
	assert.ok((await f.adapter.read('A.md')).startsWith('---\noperonId: a000001\n---\n'));
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
test('unrelated file creation during selected source reads does not block conversion', async () => {
	const f = fixture(), p = await f.preview(); const read = f.adapter.read.bind(f.adapter);
	let reads = 0;
	f.adapter.read = async file => { const value = await read(file); if (file === 'B.md' && ++reads === 2) f.adapter.files.set('New.md', '- [ ] Other {{operonId:: zzzzzzz}}'); return value; };
	assert.equal((await f.service.apply(p)).status, 'committed');
	for (const change of p.changes) assert.equal(await read(change.path), change.after);
});
for (const collision of [false, true]) {
	test(`pending RAM index updates settle before selected writes: collision=${collision}`, async () => {
		const f = fixture({ 'A.md': '- [ ] A 📅 2026-10-08' });
		let cached: ReturnType<typeof collectTasksConversionIdentities> = [], pending = false, settlements = 0;
		const host = createTasksConversionHost(f.app, f.writer, () => f.settings, { matches: () => true, synchronize: () => true },
			async (_signal, changed) => { assert.ok(changed, 'Conversion must not request full-vault inventory'); return { externalReferences: [], reservedSeriesIds: [], isCurrent: () => true }; }, undefined,
			() => ({ sources: cached, externalReferences: [], reservedSeriesIds: [] }), async () => {
				settlements++;
				if (pending) { cached = collectTasksConversionIdentities('Other.md', f.adapter.files.get('Other.md')!, f.settings.keyMappings, true); pending = false; }
			});
		const service = new TasksConversionService(host, f.store, { now: () => '2026-10-08T17:00:00', operonId: () => 'lag1234' });
		const preview = service.preview(await service.scan({ files: ['A.md'], folders: [], includeSubfolders: false }));
		f.adapter.afterWrite = name => { if (name.endsWith('active.json')) { f.adapter.files.set('Other.md', `- [ ] Outside {{operonId:: ${collision ? 'lag1234' : 'other01'}}}`); pending = true; } };
		const result = await service.apply(preview, { finalizeOnSuccess: true });
		assert.ok(settlements > 1);
		assert.equal(result.status, collision ? 'rolled-back' : 'committed');
		assert.equal(await f.adapter.read('A.md'), collision ? preview.changes[0].before : preview.changes[0].after);
		assert.equal(f.adapter.writes.filter(name => name.endsWith('.md')).length, collision ? 0 : 1);
		assert.equal((await f.store.load()).kind, 'empty');
	});
}
for (const relationship of [false, true]) {
	test(`rollback CAS settles an outside event without replaying a write: relationship=${relationship}`, async () => {
		const f = fixture({ 'A.md': '- [ ] A 📅 2026-10-08' });
		let cached: ReturnType<typeof collectTasksConversionIdentities> = [], pending = false, allowed = true, calls = 0, injecting = false, injected = false;
		const process = f.app.vault.process.bind(f.app.vault), read = f.adapter.read.bind(f.adapter);
		f.app.vault.process = async (file, transform) => { injecting = ++calls === 2; try { return await process(file, transform); } finally { injecting = false; } };
		f.adapter.read = async name => { const content = await read(name); if (name === 'A.md' && injecting && !injected) {
			injected = true; pending = true;
			f.adapter.files.set('Other.md', `- [ ] Outside {{operonId:: other01}}${relationship ? ' {{blockedBy:: lag1234}}' : ''}`);
		} return content; };
		const host = createTasksConversionHost(f.app, f.writer, () => f.settings, { matches: () => true, synchronize: () => true },
			async (_signal, changed) => { assert.ok(changed, 'Full-vault inventory'); return { externalReferences: [], reservedSeriesIds: [], isCurrent: () => true }; }, undefined, () => ({ sources: cached, externalReferences: [], reservedSeriesIds: [] }),
			async () => { if (pending) { cached = collectTasksConversionIdentities('Other.md', f.adapter.files.get('Other.md')!, f.settings.keyMappings, true); pending = false; } });
		const service = new TasksConversionService(host, f.store, { now: () => '2026-10-08T17:00:00', operonId: () => 'lag1234' });
		const preview = service.preview(await service.scan({ files: ['A.md'], folders: [], includeSubfolders: false }));
		const result = await service.apply(preview, { canCommit: () => allowed, onProgress: progress => { if (progress.phase === 'apply') allowed = false; } });
		assert.equal(result.status, relationship ? 'recovery-required' : 'rolled-back');
		assert.equal(await read('A.md'), relationship ? preview.changes[0].after : preview.changes[0].before);
		assert.equal(f.adapter.writes.filter(name => name === 'A.md').length, relationship ? 1 : 2);
		assert.equal((await f.store.load()).kind, relationship ? 'active' : 'empty');
	});
}
test('backup-time collision in an existing file causes zero note writes', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'Other.md': 'Unrelated' }), p = await f.preview();
	f.adapter.afterWrite = file => { if (file.endsWith('active.json')) f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: ${p.operonIds[0]}}}`); };
	assert.notEqual((await f.service.apply(p)).status, 'committed');
	assert.ok(f.adapter.writes.every(file => !file.endsWith('.md')));
	assert.equal(await f.adapter.read('A.md'), p.changes[0].before);
});
test('indexed ID collision appearing during selected source read prevents all writes', async () => {
	const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'Other.md': 'Unrelated', 'Z.md': 'Last' }), p = await f.preview();
	const read = f.adapter.read.bind(f.adapter);
	f.adapter.read = async file => { const content = await read(file); if (file === 'A.md') f.adapter.files.set('Other.md', `- [ ] Other {{operonId:: ${p.operonIds[0]}}}`); return content; };
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

test('real storage conversion reads only its selected file and preserves sealed malformed templates', async () => {
	const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'operon-conversion-scope-')), sealed = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'operon-conversion-scope-sealed-'));
	try {
		const adapter = new DiskAdapter(root);
		const originals = { 'Selected.md': '---\r\nTitle: %opaque YAML\r\n---\r\n- [ ] Repeat 🔁 every day 📅 2026-10-08\r\n',
			'Template.md': '---\noperonId: { invalid: identity }\n---\n<% templater %>\n', 'Broken.md': '---\nUnclosed frontmatter' };
		for (const [name, content] of Object.entries(originals)) { await adapter.write(name, content); await writeFile(path.join(sealed, name), content); }
		const f = wiredFixture(adapter), read = adapter.read.bind(adapter), reads: string[] = [];
		adapter.writes = [];
		adapter.read = async name => { reads.push(name); if (name === 'Template.md' || name === 'Broken.md') throw new Error('Unselected source read'); return read(name); };
		f.buffers.set('Template.md', 'Unsaved unrelated template');
		const preview = f.service.preview(await f.service.scan({ files: ['Selected.md'], folders: [], includeSubfolders: true }));
		assert.equal(adapter.writes.length, 0);
		assert.equal((await f.service.apply(preview, { finalizeOnSuccess: true })).status, 'committed');
		assert.equal(await read('Selected.md'), preview.changes[0].after);
		assert.ok(adapter.writes.every(name => name === 'Selected.md' || name.startsWith(`${f.store.directory}/`)));
		for (const name of ['Template.md', 'Broken.md']) { assert.equal(reads.includes(name), false); assert.equal(await read(name), await readFile(path.join(sealed, name), 'utf8')); }
		assert.equal((await f.fresh().inspect()).state.kind, 'empty');
		const writes = adapter.writes.length;
		const second = f.service.preview(await f.service.scan({ files: ['Selected.md'], folders: [], includeSubfolders: true }));
		assert.equal(second.operonIds.length, 0); assert.equal((await f.service.apply(second)).status, 'not-applied');
		assert.equal(adapter.writes.length, writes);
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


test('settings serialization preserves snapshot semantics independent of top-level insertion order', () => {
 const settings = structuredClone(DEFAULT_SETTINGS);
 const reversed = Object.fromEntries(Object.entries(settings).reverse()) as typeof settings;
 assert.equal(serializeTasksConversionSettings(reversed), JSON.stringify(tasksConversionSettingsSnapshot(settings)));
 settings.defaultPriority = 'Changed';
 assert.notEqual(serializeTasksConversionSettings(settings), serializeTasksConversionSettings(reversed));
});
for (const key of ['priorities', 'pipelines', 'defaultPipelineName', 'defaultPriority', 'keyMappings', 'excludedFolders', 'fileTaskTemplateFolder', 'defaultInlineTaskTemplateId'] as const) {
 test(`fresh settings serialization rejects changed ${key} without persistent writes`, async () => {
  const f = fixture(), preview = await f.preview();
  const value = f.settings[key];
  Object.assign(f.settings, { [key]: Array.isArray(value) ? [...value, value[0] ?? 'Changed'] : `${value} Changed` });
  assert.equal((await f.service.apply(preview)).status, 'not-applied'); assert.deepEqual(f.adapter.writes, []);
 });
}
test('current settings are checked inside the exact source writer guard', async () => {
 const f = fixture(), preview = await f.preview(), process = f.app.vault.process.bind(f.app.vault);
 f.app.vault.process = async (file, transform) => {
  f.settings.defaultPriority = 'Changed'; return process(file, transform);
 };
 assert.equal((await f.service.apply(preview)).status, 'rolled-back');
 assert.ok(f.adapter.writes.every(file => !file.endsWith('.md')));
 for (const change of preview.changes) assert.equal(await f.adapter.read(change.path), change.before);
});
for (const boundary of [0, 1]) {
 test(`settings change after source ${boundary} is caught before completion and restores exact sources`, async () => {
  const f = fixture(), preview = await f.preview(); let changed = false;
  f.adapter.afterWrite = (file, content) => {
   if (!changed && file === preview.changes[boundary].path && content === preview.changes[boundary].after) {
    changed = true; f.settings.defaultPriority = 'Changed';
   }
  };
  assert.equal((await f.service.apply(preview)).status, 'rolled-back'); assert.equal(changed, true);
  for (const change of preview.changes) assert.equal(await f.adapter.read(change.path), change.before);
  assert.equal((await f.store.load()).kind, 'empty');
 });
}
test('unrelated setting edits preserve the approved conversion output', async () => {
 const f = fixture(), preview = await f.preview(); f.settings.autoParentFileTask = !f.settings.autoParentFileTask;
 assert.equal((await f.service.apply(preview, { finalizeOnSuccess: true })).status, 'committed');
 for (const change of preview.changes) assert.equal(await f.adapter.read(change.path), change.after);
});

test('automatic rollback retains a newly referenced task and its recovery evidence', async () => {
 const f = fixture({ 'A.md': '- [ ] A 📅 2026-10-09' }); let allowed = true;
 const host = createTasksConversionHost(f.app, f.writer, () => f.settings, { matches: () => true, synchronize: () => true },
  async () => ({ externalReferences: [...f.adapter.files.values()].flatMap(tasksConversionCardReferences), reservedSeriesIds: [], isCurrent: () => true }), undefined,
  () => ({ sources: [...f.adapter.files].filter(([path]) => path.endsWith('.md')).flatMap(([path, content]) => collectTasksConversionIdentities(path, content, f.settings.keyMappings)), externalReferences: [], reservedSeriesIds: [] }));
 const service = new TasksConversionService(host, f.store, { operonId: () => 'card001' });
 const p = service.preview(await service.scan(f.scope));
 const result = await service.apply(p, { canCommit: () => allowed, onProgress: progress => {
  if (progress.phase === 'apply') { f.adapter.files.set('Dashboard.md', '```operon\nview: card\ntaskId: card001\n```'); allowed = false; }
 } });
 assert.equal(result.status, 'recovery-required'); assert.equal(await f.adapter.read('A.md'), p.changes[0].after);
 assert.equal((await f.store.load()).kind, 'active');
});

for (const outcome of ['cancel', 'write-error', 'success'] as const) test(`real storage ${outcome} preserves transaction-created external references`, async () => {
 const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'operon-reference-boundary-'));
 try {
  const adapter = new DiskAdapter(root);
  await adapter.write('A.md', '- [ ] A 📅 2026-10-09'); await adapter.write('B.md', '- [ ] B 📅 2026-10-09');
  await adapter.write('Other.md', 'Untouched'); adapter.writes = [];
  const f = wiredFixture(adapter); let allowed = true, next = 0;
  const inventory = createTasksConversionReferenceInventory(f.app, {
   workflow: () => ({ externalReferences: [], reservedSeriesIds: [], isCurrent: () => true }),
   nativeSnapshot: () => ({ references: [], isCurrent: () => true }), matches: () => true, projectTable: (_path, preset) => preset,
   markdownBuffers: () => [...f.buffers].map(([path, content]) => ({ path, content })), keyMappings: () => f.settings.keyMappings,
  });
  const host = createTasksConversionHost(f.app, f.writer, () => f.settings, { matches: () => true, synchronize: () => true }, inventory, undefined,
   () => ({ sources: [], externalReferences: [], reservedSeriesIds: [] }));
  const fresh = () => new TasksConversionService(host, f.store, { operonId: () => `ref000${++next}` });
  const service = fresh(), preview = service.preview(await service.scan({ files: ['A.md', 'B.md'], folders: [], includeSubfolders: true }));
  const originalProcess = f.app.vault.process.bind(f.app.vault);
  f.app.vault.process = async (file, transform) => {
   if (file.path === 'B.md' && outcome === 'write-error') throw new Error('Injected second write failure');
   const result = await originalProcess(file, transform);
   if (file.path === 'A.md') {
    await adapter.write('Dashboard.md', '``` operon\nview: card\ntaskId: '+preview.operonIds[0]+'\n```');
    if (outcome === 'cancel') allowed = false;
   }
   return result;
  };
  const result = await service.apply(preview, { canCommit: () => allowed, finalizeOnSuccess: true });
  assert.equal(result.status, outcome === 'success' ? 'committed' : 'recovery-required');
  assert.equal(await adapter.read('A.md'), preview.changes[0].after);
  assert.equal(await adapter.read('Other.md'), 'Untouched');
  assert.ok(adapter.writes.every(name => ['A.md', 'B.md', 'Dashboard.md'].includes(name) || name.startsWith(f.store.directory+'/')));
  const reloaded = await new TasksConversionRecoveryStore(adapter as unknown as DataAdapter, f.app.vault.configDir).load();
  assert.equal(reloaded.kind, outcome === 'success' ? 'empty' : 'active');
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('a valid new relationship at the forward write boundary does not cancel conversion', async () => {
 const f = fixture({ 'A.md': '- [ ] A 📅 2026-10-09' }), preview = await f.preview();
 const process = f.app.vault.process.bind(f.app.vault); let injected = false;
 f.app.vault.process = async (file, transform) => {
  if (!injected) { injected = true; f.references.push(preview.operonIds[0]); }
  return process(file, transform);
 };
 assert.equal((await f.service.apply(preview, { finalizeOnSuccess: true })).status, 'committed');
 assert.equal(await f.adapter.read('A.md'), preview.changes[0].after);
 assert.equal((await f.store.load()).kind, 'empty');
});

for (const duplicate of [false, true]) test(`forward CAS distinguishes a new relationship from identity duplication: ${duplicate}`, async () => {
 const f = fixture({ 'A.md': '- [ ] A 📅 2026-10-09' }), preview = await f.preview();
 const process = f.app.vault.process.bind(f.app.vault); let injected = false;
 f.app.vault.process = async (file, transform) => {
  if (!injected) {
   injected = true;
   f.adapter.files.set('Other.md', `- [ ] Outside {{operonId:: ${duplicate ? preview.operonIds[0] : 'other01'}}} {{related:: ${preview.operonIds[0]}}}`);
  }
  return process(file, transform);
 };
 const result = await f.service.apply(preview, { finalizeOnSuccess: true });
 assert.equal(result.status, duplicate ? 'rolled-back' : 'committed');
 assert.equal(await f.adapter.read('A.md'), duplicate ? preview.changes[0].before : preview.changes[0].after);
 assert.equal(f.adapter.writes.filter(name => name === 'A.md').length, duplicate ? 0 : 1);
});


test('scan excludes template and excluded subfolders before identity and content reads', async () => {
 const f = fixture({ 'A.md': '- [ ] A 🆔 A', 'Skip/Deep/B.md': '- [ ] B 🆔 B', 'Templates/C.md': '- [ ] C 🆔 C', 'Templates2/D.md': '- [ ] D 🆔 D' });
 f.settings.excludedFolders = ['Skip']; f.settings.fileTaskTemplateFolder = 'Templates';
 f.buffers.set('Templates/C.md', 'Unsaved template');
 const reads: string[] = [], identityPaths: string[][] = [], progress: string[] = [], totals: number[] = [];
 const read = f.adapter.read.bind(f.adapter), identities = f.host.identities.bind(f.host);
 f.adapter.read = async name => { reads.push(name); return read(name); };
 f.host.identities = async (keys, signal, scope) => { identityPaths.push([...(scope?.paths ?? [])]); return identities(keys, signal, scope); };
 const scan = await f.service.scan({ ...f.scope, files: ['Templates/C.md'], folders: ['/', 'Templates', 'Skip'] }, { onProgress: value => { progress.push(value.path); totals.push(value.totalFiles); } });
 assert.deepEqual(identityPaths, [['A.md', 'Templates2/D.md']]);
 assert.ok(reads.every(name => name === 'A.md' || name === 'Templates2/D.md'));
 assert.deepEqual(progress, ['A.md', 'Templates2/D.md']); assert.deepEqual(totals, [2, 2]);
 assert.deepEqual(scan.files.map(file => file.path), ['A.md', 'Skip/Deep/B.md', 'Templates/C.md', 'Templates2/D.md']);
 assert.deepEqual(scan.files.filter(file => file.error).map(file => file.error), ['excluded', 'excluded']);
 const preview = f.service.preview(scan); assert.equal(preview.selectedKeys.length, 2); assert.equal(preview.changes.length, 2);
 assert.deepEqual(f.adapter.writes, []);
});

test('explicit excluded scope with no eligible paths performs no file reads', async () => {
 const f = fixture({ 'Templates/Sub/A.md': '- [ ] A 🆔 A' }); f.settings.fileTaskTemplateFolder = 'Templates';
 let reads = 0; f.adapter.read = async () => { reads++; throw new Error('excluded content must not be read'); };
 const scan = await f.service.scan({ files: ['Templates/Sub/A.md'], folders: ['Templates'], includeSubfolders: true });
 assert.equal(reads, 0); assert.equal(scan.files.length, 1); assert.equal(scan.files[0].error, 'excluded');
 assert.equal(f.service.preview(scan).selectedKeys.length, 0); assert.deepEqual(f.adapter.writes, []);
});

function inlineTemplateFixture(line: string, frontmatter: string) {
 const f = fixture({ 'A.md': line });
 f.settings.defaultInlineTaskTemplateId = 'test-template';
 let content = `---\n${frontmatter}\n---\nBody must never be copied`;
 let metadataCurrent = true;
 const properties = { keyMappings: f.settings.keyMappings, propertyTypes: { Client: 'text' as const }, inlineDefinitions: { version: 1 as const, entries: [] } };
 const inputs = { title: '', taskDescription: '', note: '', status: '', priority: '', dateStarted: '', dateScheduled: '', dateDue: '' };
 const definitions: string[] = [];
 f.host.loadInlineTemplate = async () => {
  const before = content;
  const template = prepareCreationTemplate({ content, sourceId: 'test-template', revision: 1, clock: { now: '2026-10-08T17:00:00' }, inputs, properties });
  if (template.status !== 'ready') throw new Error('Template invalid');
  return {
   current: () => metadataCurrent,
   verify: async () => metadataCurrent && content === before,
   prepare: (task, explicit, now) => {
    const output = prepareDefaultInlineTemplateTask({ template, properties, task, source: { ...task, fields: [], tags: [...task.tags] }, parent: [], explicit, now });
    const parsed = parseTaskLine(output.inlineLine, task.lineNumber, task.filePath, f.settings.keyMappings);
    assert.ok(parsed); Object.assign(task, parsed);
    return { definitions: output.definitions, warnings: output.skipped.map(item => item.sourceName) };
   },
   prepareDefinitions: async (items, allowed) => { assert.ok(allowed()); definitions.push(...items.map(item => item.sourceName)); },
  };
 };
 return { ...f, definitions, changeTemplate: () => { content += '\nChanged'; }, changeMetadata: () => { metadataCurrent = false; } };
}
test('bulk template matches command precedence: emoji values win, template fills properties, body and parent excluded', async () => {
 const f = inlineTemplateFixture('- [ ] Task ⏫ 📅 2026-11-01 #source', 'priority: Low\ndateDue: 2026-12-01\nClient: Acme\nparentTask: zzzzzzz');
 const preview = await f.preview();
 const line = preview.rows.find(row => row.selected)!.after!;
 const task = parseTaskLine(line, 0, 'A.md', f.settings.keyMappings)!;
 assert.equal(task.fields.find(field => field.key === 'priority')?.value, 'A');
 assert.equal(task.fields.find(field => field.key === 'dateDue')?.value, '2026-11-01');
 assert.match(line, /Client:: Acme/);
 assert.ok(task.tags.includes('source'));
 assert.ok(!line.includes('parentTask')); assert.ok(!line.includes('Body must never'));
 assert.deepEqual(f.adapter.writes, []); assert.deepEqual([...f.definitions], []);
 assert.equal((await f.service.apply(preview)).status, 'committed');
 assert.ok(f.definitions.includes('Client'));
 const active = await f.service.inspect(); assert.ok(active.canUndo);
 assert.equal(active.state.kind, 'active');
 if (active.state.kind !== 'active') throw new Error('Missing recovery record');
 assert.equal((await f.service.resolve('undo', active.state.record.id)).status, 'restored');
 assert.equal(await f.adapter.read('A.md'), '- [ ] Task ⏫ 📅 2026-11-01 #source');
});
test('template recurrence reserves stable unique series across previews and records only actual recurrence', async () => {
 const f = inlineTemplateFixture('- [ ] One 🆔 a\n- [ ] Two 🆔 b', 'repeat: mode=schedule|freq=day|interval=1');
 const scan = await f.service.scan(f.scope), a = f.service.preview(scan), b = f.service.preview(scan);
 assert.equal(a.repeatSeriesIds.length, 2); assert.equal(new Set(a.repeatSeriesIds).size, 2);
 assert.deepEqual(a.repeatSeriesIds, b.repeatSeriesIds);
 assert.equal((await f.service.apply(b)).status, 'committed');
 assert.ok((await f.service.inspect()).canUndo);
 const plain = inlineTemplateFixture('- [ ] Plain 🆔 a', 'priority: Low');
 assert.deepEqual((await plain.preview()).repeatSeriesIds, []);
 const invalid = inlineTemplateFixture('- [ ] Invalid 🆔 a', 'repeat: nonsense');
 const invalidPreview = await invalid.preview();
 assert.deepEqual(invalidPreview.repeatSeriesIds, []);
 assert.ok(!invalidPreview.rows[0].after!.includes('repeatSeriesId'));
});
for (const change of ['template', 'metadata', 'selection'] as const) test(`changed ${change} rejects stale template preview before any writes`, async () => {
 const f = inlineTemplateFixture('- [ ] Task 🆔 a', 'priority: Low'), preview = await f.preview();
 if (change === 'template') f.changeTemplate();
 else if (change === 'metadata') f.changeMetadata();
 else f.settings.defaultInlineTaskTemplateId = null;
 assert.equal((await f.service.apply(preview)).status, 'not-applied');
 assert.deepEqual(f.adapter.writes, []); assert.deepEqual([...f.definitions], []);
});
test('template change during a source write restores conversion sources', async () => {
 const f = inlineTemplateFixture('- [ ] Task 🆔 a', 'priority: Low'), preview = await f.preview();
 f.adapter.afterWrite = name => { if (name === 'A.md') f.changeTemplate(); };
 assert.equal((await f.service.apply(preview)).status, 'rolled-back');
 assert.equal(await f.adapter.read('A.md'), '- [ ] Task 🆔 a');
});
test('selected unavailable template fails scan with no writes', async () => {
 const f = fixture(); f.settings.defaultInlineTaskTemplateId = 'missing';
 await assert.rejects(f.preview(), /template unavailable/); assert.deepEqual(f.adapter.writes, []);
});

for (const line of ['- [ ] Task 🔁 every week 📅 2026-11-01', '- [x] Task ✅ 2026-10-09', '- [-] Task ❌ 2026-10-09', '- [ ] Task ⏳ 2026-11-01']) {
 test(`template preserves explicit emoji recurrence and workflow: ${line}`, async () => {
  const original = await fixture({ 'A.md': line }).preview();
  const f = inlineTemplateFixture(line, 'repeat: mode=schedule|freq=day|interval=1\ndateDue: 2026-12-01');
  const preview = await f.preview();
  const before = parseTaskLine(original.rows[0].after!, 0, 'A.md', f.settings.keyMappings)!;
  const after = parseTaskLine(preview.rows[0].after!, 0, 'A.md', f.settings.keyMappings)!;
  assert.equal(after.checkbox, before.checkbox);
  for (const key of ['repeat', 'dateDue', 'dateScheduled', 'dateCompleted', 'dateCancelled', 'status']) {
   const value = before.fields.find(field => field.key === key)?.value;
   if (value) assert.equal(after.fields.find(field => field.key === key)?.value, value, key);
  }
 });
}
