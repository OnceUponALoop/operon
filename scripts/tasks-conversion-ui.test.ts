import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const ts: typeof import('typescript') = createRequire(path.join(process.cwd(), 'package.json'))('typescript');
import { App, TFile } from 'obsidian';
import { fixture, wiredFixture, DiskAdapter } from './tasks-conversion-service.test';
import { parseTaskLine } from '../src/core/parser';
import { TasksConversionController, tasksConversionCounts } from '../src/ui/tasks-conversion-controller';
import { TasksConversionModal } from '../src/ui/tasks-conversion-modal';
import { createTasksConversionReferenceInventory, tasksConversionCanvasReferences, tasksConversionCardReferences, tasksConversionTableReferences } from '../src/systems/tasks-conversion-references';
import { createExcalidrawMarkdownSource, withExcalidrawMarkdownSources } from '../src/ui/excalidraw-markdown-source';
import { OPERON_SETTINGS_SEARCH_REGISTRY } from '../src/ui/settings/settings-search-registry';

function controller(f = fixture(), settle: (paths: readonly string[]) => Promise<void> = async () => {}) {
 return { f, c: new TasksConversionController({ service: f.service, available: () => true, coordinate: (_paths, _ids, operation) => operation(), settle }) };
}
test('UI scope starts empty with subfolders on; dedupe and scope changes invalidate preview', async () => {
 const { c } = controller(); assert.deepEqual(c.scope, { files: [], folders: [], includeSubfolders: true });
 await c.initialize(); c.updateScope({ files: ['A.md', 'A.md'], folders: [], includeSubfolders: false });
 await c.scan(); assert.equal(c.preview?.selectedKeys.length, 1);
 const id = c.preview!.rows[0].operonId;
 c.select([]); c.select([c.preview!.rows[0].key]); assert.equal(c.preview!.rows[0].operonId, id);
 c.updateScope({ files: ['B.md'], folders: [], includeSubfolders: true }); assert.equal(c.preview, null);
});
test('UI applies exact preview and automatically completes, reporting only selected tasks', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope); await c.scan();
 c.select([c.preview!.rows[0].key]); const preview = c.preview!;
 await c.apply(); assert.equal(c.result?.status, 'committed'); assert.equal(c.blocked, false);
 assert.equal(c.counts.converted, 1); assert.equal(c.counts.skipped, 1);
 for (const change of preview.changes) assert.equal(await f.adapter.read(change.path), change.after);
 c.reset(); assert.equal(c.result, null);
});
test('changed source rejects apply without settling or altering unrelated user task', async () => {
 let settlements = 0; const { f, c } = controller(fixture(), async () => { settlements++; });
 await c.initialize(); c.updateScope(f.scope); await c.scan();
 const saved = '- [ ] User {{operonId:: user001}}'; f.adapter.files.set('A.md', saved);
 await c.apply(); assert.equal(c.result?.status, 'not-applied'); assert.equal(settlements, 0);
 assert.equal(c.counts.converted, 0); assert.equal(await f.adapter.read('A.md'), saved);
 assert.deepEqual(f.adapter.writes, []);
});
test('double apply invokes service once while transaction is busy', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope); await c.scan();
 const apply = c.apply(); await c.apply(); await apply;
 assert.equal(f.adapter.writes.filter(name => name.endsWith('.md')).length, 2);
});
test('index failure exposes retry; read-only retry never calls apply again', async () => {
 let fails = true; const { f, c } = controller(fixture(), async () => { if (fails) throw new Error('Index failed'); });
 await c.initialize(); c.updateScope(f.scope); await c.scan(); await c.apply();
 assert.equal(c.result?.sourcesCommitted, true); assert.equal(c.settlementPending.length, 2);
 const writes = f.adapter.writes.length; fails = false; await c.retrySettlement();
 assert.equal(c.settlementPending.length, 0); assert.equal(f.adapter.writes.length, writes);
});
test('inspection failure after commit still settles and blocks new work until read-only retry', async () => {
 let calls = 0, settlements = 0; const f = fixture(); const inspect = f.service.inspect.bind(f.service);
 f.service.inspect = async () => { if (++calls === 2) throw new Error('Read failed'); return inspect(); };
 const { c } = controller(f, async () => { settlements++; }); await c.initialize(); c.updateScope(f.scope); await c.scan(); await c.apply();
 assert.equal(c.result?.sourcesCommitted, true); assert.equal(settlements, 1); assert.equal(c.inspection, null);
 assert.equal(c.blocked, true); assert.equal(c.counts.converted, 2);
 await c.initialize(); assert.equal(c.blocked, false);
});
test('cleanup retry preserves successful in-session counts after active copy is removed', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope); await c.scan();
 f.adapter.beforeRemove = name => { if (name.endsWith('/resolved.json')) throw new Error('Remove failed'); };
 await c.apply(); assert.equal(c.result?.status, 'cleanup-pending'); assert.equal(c.counts.converted, 2);
 f.adapter.beforeRemove = undefined; await c.resolve('cleanup'); assert.equal(c.blocked, false); assert.equal(c.counts.converted, 2);
 const absent = tasksConversionCounts({ status: 'kept', taskCount: 0, paths: [] }, null, { state: { kind: 'empty' }, files: [], canKeep: false, canUndo: false, canRestore: false });
 assert.equal(absent.available, false);
});
test('new runs clear old progress before inspecting or applying', async () => {
 const { c } = controller(); c.progress = { completedFiles: 10, totalFiles: 10, path: 'old.md' };
 const observed: unknown[] = []; c.onChange = () => { if (c.busy) observed.push(c.progress); };
 await c.initialize(); assert.equal(observed[0], null);
});
test('controller cancellation during apply verifies rollback rather than claiming converted count', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope); await c.scan();
 c.onChange = () => { if (c.phase === 'apply' && c.progress?.completedFiles === 1) c.cancel(); };
 await c.apply(); assert.equal(c.result?.status, 'rolled-back'); assert.equal(c.counts.converted, 0);
 assert.equal((await f.store.load()).kind, 'empty');
});
test('disposed controller prevents further writes, scan and selection', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope); c.dispose(); await c.scan(); await c.apply();
 assert.deepEqual(f.adapter.writes, []); assert.equal(c.preview, null);
});
test('reference collectors parse real task cards and Canvas markers without touching arbitrary IDs or nested examples', () => {
 const card = '```operon\nview: card\ntaskId: task001\n```';
 assert.deepEqual(tasksConversionCardReferences(card), ['task001']);
 assert.deepEqual(tasksConversionCardReferences('````example\n'+card+'\n````'), []);
 assert.deepEqual(tasksConversionCanvasReferences(JSON.stringify({ nodes: [
  { type: 'text', id: 'random1', text: 'taskId: ignore1' },
  { type: 'text', id: 'random2', operonTask: { version: 1, taskId: 'task002' }, text: card },
 ] })), ['task002', 'task001']);
 assert.throws(() => tasksConversionCanvasReferences(JSON.stringify({ nodes: [{ type: 'text', operonTask: { version: 2, taskId: 'task001' } }] })));
});
test('reference inventory is read-only, detects pending sources and includes workflow identities', async () => {
 const files = [new (TFile as unknown as new (name: string) => TFile)('Ref.canvas')];
 let content = JSON.stringify({ nodes: [{ type: 'text', operonTask: { version: 1, taskId: 'task001' } }] });
 let clean = true, revision = 0;
 const app = { vault: { getFiles: () => files, getAbstractFileByPath: () => files[0], read: async () => content } } as unknown as App;
 const inventory = createTasksConversionReferenceInventory(app, {
  workflow: () => { const current = revision; return { externalReferences: ['pin0001'], reservedSeriesIds: ['rs00001'], isCurrent: () => revision === current }; },
  nativeSnapshot: () => ({ references: ['draw001'], isCurrent: () => true }), matches: () => clean, projectTable: (_path, preset) => preset,
 });
 const before = content, first = await inventory(); assert.equal(content, before);
 assert.deepEqual(first.externalReferences, ['pin0001', 'draw001', 'task001']); assert.deepEqual(first.unavailablePaths, []);
 revision++; assert.equal(first.isCurrent(), false);
 clean = false; assert.deepEqual((await inventory()).unavailablePaths, ['Ref.canvas']);
 content = '{invalid'; clean = true; assert.deepEqual((await inventory()).unavailablePaths, ['Ref.canvas']);
});
test('Table references include explicit parent and expanded tasks only', () => {
 const preset = { expandedTaskTreeIds: ['task001'], search: { parent: { parentId: 'task002' } } } as never;
 assert.deepEqual(tasksConversionTableReferences(preset), ['task001', 'task002']);
});
test('Settings entry is searchable render action without a persisted settings key', () => {
 const entry = OPERON_SETTINGS_SEARCH_REGISTRY.find(entry => entry.id === 'automation.tasksEmojiBulkConversion');
 assert.equal(entry?.tabId, 'tasksInlineTasks'); assert.equal(entry?.control, 'render'); assert.equal(entry?.key, undefined);
 assert.ok(entry?.aliases?.includes('tasks emoji'));
});

class TestElement {
 tagName: string; children: TestElement[] = []; dataset: Record<string, string> = {}; textContent = ''; disabled = false;
 checked = false; open = false; scrollTop = 0; attrs: Record<string, string> = {}; listeners = new Map<string, Array<() => void>>();
 constructor(tag: string, readonly ownerDocument: { activeElement: TestElement | null }) { this.tagName = tag.toUpperCase(); }
 createEl(tag: string, options: any = {}): any {
  const child = new TestElement(tag, this.ownerDocument); child.textContent = options.text ?? '';
  for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, String(value));
  this.children.push(child); return child;
 }
 createSpan(options: any): any { return this.createEl('span', options); }
 createDiv(options: any = {}): any { return this.createEl('div', options); }
 setText(text: string): void { this.textContent = text; }
 setAttribute(key: string, value: string): void { this.attrs[key] = value; if (key === 'data-focus-key') this.dataset.focusKey = value; }
 addClass(): void {} addEventListener(key: string, fn: () => void): void { this.listeners.set(key, [...(this.listeners.get(key) ?? []), fn]); }
 empty(): void { this.children = []; }
 querySelectorAll(): any[] { return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(child => child.dataset.focusKey); }
 focus(): void { if (!this.disabled) this.ownerDocument.activeElement = this; }
 fire(key: string): void { for (const fn of this.listeners.get(key) ?? []) fn(); }
 get allText(): string { return [this.textContent, ...this.children.map(child => child.allText)].join(' '); }
}
function modalFixture(c: TasksConversionController, app = new App()) {
 const m = new TasksConversionModal(app, c, () => {}), doc = { activeElement: null as TestElement | null };
 const root = new TestElement('div', doc);
 m.contentEl = root as unknown as HTMLElement; m.titleEl = new TestElement('h2', doc) as unknown as HTMLElement;
 return { m, root, doc, button: (key: string) => root.querySelectorAll().find(el => el.dataset.focusKey === key) as TestElement };
}
test('modal preserves keyboard focus through scan, preview, apply and result without normal Undo', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope);
 const { m, root, doc, button } = modalFixture(c); m.onOpen(); await new Promise(resolve => setTimeout(resolve, 0));
 button('Scan').focus(); const scan = c.scan(); assert.equal(doc.activeElement?.dataset.focusKey, 'Cancel'); await scan;
 assert.ok(doc.activeElement?.dataset.focusKey); assert.equal(c.preview?.selectedKeys.length, 2);
 button('Apply').focus(); const apply = c.apply(); assert.equal(doc.activeElement?.dataset.focusKey, 'Cancel'); await apply;
 assert.equal(doc.activeElement?.dataset.focusKey, 'New'); assert.ok(root.allText.includes('Converted: 2'));
 assert.equal(root.allText.includes('Undo'), false); assert.equal(root.allText.includes('Keep result'), false);
});
test('modal uses inert text for HTML-looking source and exposes full file snapshots', async () => {
 const f = fixture({ 'A.md': '- [ ] <img onerror="alert(1)"> 📅 2026-10-10' }), { c } = controller(f);
 await c.initialize(); c.updateScope(f.scope); await c.scan(); const { m, root } = modalFixture(c); m.onOpen(); await new Promise(resolve => setTimeout(resolve, 0));
 assert.ok(root.allText.includes('<img onerror="alert(1)">')); assert.ok(root.allText.includes('Full file preview'));
 assert.ok(!root.children.some(el => el.tagName === 'IMG'));
});
test('busy modal close requests cancellation and keeps transaction visible until result', async () => {
 const { c } = controller(); const { m } = modalFixture(c); c.busy = true; m.close();
 assert.equal(c.available, true); c.busy = false; m.close(); assert.equal(c.available, false);
});

test('production adapter UI flow in synthetic private tmp preserves sealed unrelated content and completes cleanup', async () => {
 const root = await mkdtemp('/private/tmp/operon-stage3-fixture-'), sealed = await mkdtemp('/private/tmp/operon-stage3-sealed-');
 try {
  const adapter = new DiskAdapter(root);
  const notes = { 'A.md': '---\nTitle: synthetic\n---\n- [ ] A 📅 2026-10-10\n', 'Unrelated.md': 'Sealed unrelated content\r\n', 'Ref.canvas': JSON.stringify({ nodes: [{ type: 'text', text: 'not a task' }] }) };
  for (const [file, value] of Object.entries(notes)) { await adapter.write(file, value); await writeFile(path.join(sealed, file), value); }
  adapter.writes = []; const f = wiredFixture(adapter), { c } = controller(f);
  await c.initialize(); c.updateScope({ files: ['A.md'], folders: [], includeSubfolders: true }); await c.scan(); const approved = c.preview!.changes[0].after;
  await c.apply(); assert.equal(c.result?.status, 'committed'); assert.equal(await adapter.read('A.md'), approved);
  for (const file of ['Unrelated.md', 'Ref.canvas']) assert.equal(await adapter.read(file), await readFile(path.join(sealed, file), 'utf8'));
  assert.ok(adapter.writes.every(file => file === 'A.md' || file.startsWith('.test-config/plugins/operon/state/tasks-conversion/')));
  assert.equal((await f.fresh().inspect()).state.kind, 'empty');
 } finally { await rm(root, { recursive: true, force: true }); await rm(sealed, { recursive: true, force: true }); }
});

async function mainHarness(names: string[]) {
 const source = await readFile(path.join(process.cwd(), 'main.ts'), 'utf8');
 const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
 let cls: import('typescript').ClassDeclaration | undefined;
 ast.forEachChild(node => { if (ts.isClassDeclaration(node)) cls = node; });
 assert.ok(cls);
 const methods = cls!.members.filter(member => ts.isMethodDeclaration(member) && names.includes(member.name.getText(ast)));
 assert.equal(methods.length, names.length);
 const script = ts.transpileModule('class Harness { '+methods.map(method => method.getText(ast)).join('\n')+' }; return Harness;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
 const Harness = new Function('TFile', 'readExcalidrawTaskView', script)(TFile, (_app: unknown, view: unknown) => view);
 const h = new Harness();
 h.tasksConversionOwnedSources = new Map(); h.tasksConversionSettledSources = new Map(); h.tasksConversionNativePaths = new Set(); h.tasksConversionDrawingScenes = new Map();
 return { h, ast, cls: cls! };
}
test('real main normalization guard skips only owned exact contents; external user edits still normalize', async () => {
 const { h } = await mainHarness(['normalizeWorkflowStateAfterRawEdit']);
 const file = new (TFile as unknown as new (name: string) => TFile)('A.md'); let content = 'after', calls = 0;
 h.app = { vault: { getAbstractFileByPath: () => file, read: async () => content } };
 h.workflowNormalizationInProgress = new Set(); h.workflowNormalizationPending = new Set(); h.workflowNormalizationWaiters = new Map(); h.workflowNormalizationRenameTargets = new Map(); h.indexer = { scheduleReindex: () => {} };
 h.normalizeWorkflowStateAfterRawEditPass = async () => { calls++; };
 h.tasksConversionOwnedSources.set('A.md', { before: 'before', after: 'after', written: true });
 await h.normalizeWorkflowStateAfterRawEdit('A.md'); assert.equal(calls, 0);
 content = 'user edited'; await h.normalizeWorkflowStateAfterRawEdit('A.md'); assert.equal(calls, 1);
 h.tasksConversionOwnedSources.clear(); h.tasksConversionSettledSources.set('A.md', 'after'); content = 'after';
 await h.normalizeWorkflowStateAfterRawEdit('A.md'); assert.equal(calls, 1);
 content = 'later user edit'; await h.normalizeWorkflowStateAfterRawEdit('A.md'); assert.equal(calls, 2);
 assert.equal(h.tasksConversionSettledSources.has('A.md'), false);
});
test('real main raw-edit reconciliation does not suppress unrelated changed contents', async () => {
 const { h } = await mainHarness(['reconcileTaskSourceModify']);
 const file = new (TFile as unknown as new (name: string) => TFile)('A.md'); let content = 'after', normalizations = 0;
 const options: unknown[] = []; h.app = { vault: { getAbstractFileByPath: () => file, read: async () => content } };
 h.indexer = { forceReindexFilePathAfterMutation: async (_path: string, opt: unknown) => options.push(opt) };
 h.normalizeWorkflowStateAfterRawEdit = async () => { normalizations++; };
 h.tasksConversionOwnedSources.set('A.md', { before: 'before', after: 'after', written: true });
 await h.reconcileTaskSourceModify('A.md', 'deferred'); assert.deepEqual(options[0], { notify: false }); assert.equal(normalizations, 0);
 content = 'external'; await h.reconcileTaskSourceModify('A.md', 'deferred'); assert.equal(normalizations, 1); assert.equal(options[1], undefined);
});
test('real main native buffer guard rejects dirty scene/header but admits its own synchronization lease', async () => {
 const { h } = await mainHarness(['tasksConversionBuffersMatch', 'tasksConversionSceneSignature', 'captureTasksConversionDrawingScenes']);
 const file = new (TFile as unknown as new (name: string) => TFile)('D.excalidraw.md');
 let elements: unknown[] = [{ id: 'one', type: 'text', text: 'saved' }], saved = elements;
 const view: any = { file, data: 'disk', lastSavedData: 'disk', preparedSaveText: 'disk', isSynchronizing: false,
  saveCoordinator: { isSaveInProgress: false }, excalidrawAPI: { getSceneElements: () => elements },
  plugin: { ea: { getAPI: () => ({ getSceneFromFile: async () => ({ elements: saved }), destroy: () => {} }) } } };
 h.app = { workspace: { getLeavesOfType: (kind: string) => kind === 'excalidraw' ? [{ view }] : [] } }; h.taskEditorDeleteOpenViewsMatch = () => true;
 assert.deepEqual(await h.captureTasksConversionDrawingScenes(), []); assert.equal(h.tasksConversionBuffersMatch(file.path, 'disk'), true);
 view.isSynchronizing = true; assert.equal(h.tasksConversionBuffersMatch(file.path, 'disk'), false);
 h.tasksConversionNativePaths.add(file.path); assert.equal(h.tasksConversionBuffersMatch(file.path, 'disk'), true);
 view.data = 'dirty header'; assert.equal(h.tasksConversionBuffersMatch(file.path, 'disk'), false); view.data = 'disk';
 elements = [{ id: 'one', type: 'text', text: 'unsaved' }];
 assert.deepEqual(await h.captureTasksConversionDrawingScenes(), [file.path]); assert.equal(h.tasksConversionBuffersMatch(file.path, 'disk'), false);
 assert.equal(view.data, 'disk'); assert.equal(view.preparedSaveText, 'disk');
});
test('selected conversion does not read an unrelated open drawing scene', async () => {
 const { h } = await mainHarness(['captureTasksConversionDrawingScenes']);
 const file = new (TFile as unknown as new (name: string) => TFile)('Unrelated.excalidraw.md');
 let reads = 0;
 const view = { file, plugin: { ea: { getAPI: () => { reads++; throw new Error('Unrelated scene'); } } } };
 h.app = { workspace: { getLeavesOfType: () => [{ view }] } };
 assert.deepEqual(await h.captureTasksConversionDrawingScenes(['Selected.md']), []); assert.equal(reads, 0);
});
test('legacy filter fences without task cards never make identity inventory unavailable', () => {
 assert.deepEqual(tasksConversionCardReferences('```operon\nfilter: My tasks\nview: table\n```'), []);
 assert.throws(() => tasksConversionCardReferences('```operon\nview: card\ntaskId: invalid!\n```'));
});

for (const failure of ['settlement', 'inspection'] as const) test(`modal focuses enabled retry after ${failure} failure`, async () => {
 let inspections = 0; const f = fixture(), inspect = f.service.inspect.bind(f.service);
 f.service.inspect = async () => { if (failure === 'inspection' && ++inspections === 3) throw new Error('Read failed'); return inspect(); };
 const { c } = controller(f, async () => { if (failure === 'settlement') throw new Error('Index failed'); });
 await c.initialize(); c.updateScope(f.scope); await c.scan();
 const { m, doc, button } = modalFixture(c); m.onOpen(); await new Promise(resolve => setTimeout(resolve, 0));
 button('Apply').focus(); await c.apply();
 assert.equal(doc.activeElement?.disabled, false);
 assert.equal(doc.activeElement?.dataset.focusKey, failure === 'settlement' ? 'RetryRefresh' : 'RetryInspect');
});
test('verified restore with cleanup failure still settles once and never repeats notes on cleanup retry', async () => {
 const f = fixture(), preview = await f.preview(); await f.service.apply(preview);
 let settlements = 0; const { c } = controller(f, async () => { settlements++; }); await c.initialize();
 f.adapter.beforeRemove = file => { if (file.endsWith('/active.json')) throw new Error('Cleanup failed'); };
 await c.resolve('restore'); assert.equal(c.result?.status, 'cleanup-pending'); assert.equal(settlements, 1);
 for (const change of preview.changes) assert.equal(await f.adapter.read(change.path), change.before);
 const writes = f.adapter.writes.length; f.adapter.beforeRemove = undefined; await c.resolve('cleanup');
 assert.equal(f.adapter.writes.length, writes); assert.equal(settlements, 1);
});
test('real main delta guard preserves unrelated checkbox and source edits while suppressing conversion-only progress', async () => {
 const { h } = await mainHarness(['filterTasksConversionIndexedChanges']);
 const file = new (TFile as unknown as new (name: string) => TFile)('A.md'); let content = 'after';
 h.app = { vault: { getAbstractFileByPath: () => file, read: async () => content } };
 h.tasksConversionGeneratedIds = new Set(['new0001']); h.tasksConversionOwnedSources.set(file.path, { before: 'before', after: 'after', written: true });
 const parent: any = { operonId: 'parent1', fieldValues: {}, description: 'Parent', tags: [], checkbox: 'open', primary: { filePath: file.path }, progress: 0 };
 const derived = { before: parent, after: { ...parent, progress: 1 } };
 const child = { before: { ...parent, operonId: 'child01' }, after: { ...parent, operonId: 'child01', checkbox: 'done' } };
 const generated = { before: null, after: { ...parent, operonId: 'new0001' } };
 assert.deepEqual(await h.filterTasksConversionIndexedChanges([derived, child, generated]), [child]);
 content = 'independent user edit'; assert.deepEqual(await h.filterTasksConversionIndexedChanges([derived, child]), [derived, child]);
});
for (const boundary of ['lease', 'read'] as const) test(`native ${boundary} wait cannot adopt a late dirty Markdown buffer`, async () => {
 const file = new (TFile as unknown as new (name: string) => TFile)('D.excalidraw.md');
 const disk = '- [ ] Task 🆔 A\n%%\n# Excalidraw Data\nopaque\n%%';
 let release!: () => void, entered!: () => void, writes = 0;
 const held = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
 const view: any = { file, data: disk, preparedSaveText: disk, lastSavedData: disk, isSynchronizing: false, plugin: {},
  isSameFileEditingActive: () => false, saveCoordinator: { isSaveInProgress: false }, excalidrawAPI: { getAppState: () => ({ viewModeEnabled: false }) },
  acquireSynchronization: async () => { if (boundary === 'lease') { entered(); await held; } view.isSynchronizing = true; return true; },
  withPersistenceWriteLease: async (_path: string, operation: () => Promise<unknown>) => operation() };
 const app = { workspace: { getLeavesOfType: () => [{ view }] }, vault: { getAbstractFileByPath: () => file,
  read: async () => { if (boundary === 'read') { entered(); await held; } return disk; } } } as unknown as App;
 const writer = { hasMarkdownSource: () => false, isMarkdownSourceOwner: () => false, withMarkdownSources: async (_sources: unknown, operation: () => Promise<unknown>) => operation() } as any;
 const operation = withExcalidrawMarkdownSources(app, writer, [file.path], () => true, () => true, async () => { writes++; }, [], (_path, source) => {
  if (view.data !== source || view.preparedSaveText !== source || view.lastSavedData !== source) throw new Error('Unsaved source');
 });
 await waiting; view.data = 'late edit'; view.preparedSaveText = 'late prepared edit'; release();
 await assert.rejects(operation, /Unsaved source/); assert.equal(writes, 0); assert.equal(view.data, 'late edit');
 assert.equal(view.preparedSaveText, 'late prepared edit'); assert.equal(view.isSynchronizing, false);
});

for (const uncertain of [false, true]) test(`native ${uncertain ? 'uncertain' : 'acknowledged'} write preserves late dirty buffers through reconciliation`, async () => {
 const file = new (TFile as unknown as new (name: string) => TFile)('D.excalidraw.md');
 const before = '- [ ] A 🆔 A\n%%\n# Excalidraw Data\nopaque\n%%', after = before.replace('A 🆔 A', 'A {{operonId:: task001}}');
 let disk = before, release!: () => void, entered!: () => void, writes = 0;
 const held = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
 const view: any = { file, data: before, preparedSaveText: before, lastSavedData: before, isSynchronizing: false, plugin: {},
  isSameFileEditingActive: () => false, saveCoordinator: { isSaveInProgress: false }, excalidrawAPI: { getAppState: () => ({ viewModeEnabled: false }) },
  acquireSynchronization: async () => { view.isSynchronizing = true; return true; }, withPersistenceWriteLease: async (_path: string, operation: () => Promise<unknown>) => operation() };
 const app = { workspace: { getLeavesOfType: () => [{ view }] }, vault: { getAbstractFileByPath: () => file, read: async () => disk,
  process: async (_file: unknown, update: (content: string) => string) => { disk = update(disk); writes++; entered(); await held; if (uncertain) throw new Error('Unknown acknowledgement'); return disk; } } } as unknown as App;
 const source = createExcalidrawMarkdownSource(app, view, () => true, { beforeAdopt: (expected, content) => {
  if (![expected, content].includes(view.data) || ![expected, content].includes(view.preparedSaveText)) throw new Error('Unsaved source');
 } });
 const operation = source.runExclusive(async () => { await source.read(); await source.write(before, after); });
 await waiting; view.data = 'late edit'; view.preparedSaveText = 'late prepared edit'; release();
 await assert.rejects(operation); assert.equal(disk, after); assert.equal(writes, 1);
 assert.equal(view.data, 'late edit'); assert.equal(view.preparedSaveText, 'late prepared edit');
 await assert.rejects(view.withPersistenceWriteLease(file.path, async () => { writes++; }));
 assert.equal(writes, 1); assert.equal(view.data, 'late edit'); assert.equal(view.preparedSaveText, 'late prepared edit'); source.dispose();
});

test('retained native recovery adoption guard never leaks synchronization ownership', async () => {
 const { h } = await mainHarness(['assertTasksConversionAdoption']);
 let matches = false, checks = 0;
 h.tasksConversionBuffersMatch = (path: string) => { checks++; assert.equal(h.tasksConversionNativePaths.has(path), true); return matches; };
 assert.throws(() => h.assertTasksConversionAdoption('D.md', 'before', 'after'), /Unsaved source/);
 assert.equal(h.tasksConversionNativePaths.size, 0); assert.equal(checks, 2);
 matches = true; h.assertTasksConversionAdoption('D.md', 'before', 'after'); assert.equal(h.tasksConversionNativePaths.size, 0);
 h.tasksConversionNativePaths.add('D.md'); h.assertTasksConversionAdoption('D.md', 'before', 'after'); assert.equal(h.tasksConversionNativePaths.has('D.md'), true);
});

for (const scenario of ['scan-cancel', 'dirty-buffer', 'changed-source', 'concurrent-write', 'external-reference', 'write-failure', 'reload-recovery', 'marker-failure', 'cleanup-failure'] as const) {
 test(`real adapter UI safety: ${scenario}`, async () => {
  const root = await mkdtemp('/private/tmp/operon-stage3-boundary-'), sealed = await mkdtemp('/private/tmp/operon-stage3-preimage-');
  try {
   const adapter = new DiskAdapter(root), originals = { 'A.md': '- [ ] A 🆔 A\r\n', 'B.md': '- [ ] B ⛔ A\n', 'Unrelated.md': '---\nType: Note\n---\nSealed bytes\r\n' };
   for (const [file, content] of Object.entries(originals)) { await adapter.write(file, content); await writeFile(path.join(sealed, file), content); }
   const f = wiredFixture(adapter), { c } = controller(f); adapter.writes = []; await c.initialize(); c.updateScope(f.scope);
   if (scenario === 'scan-cancel') {
    c.onChange = () => { if (c.phase === 'scan' && c.progress) c.cancel(); }; await c.scan(); assert.equal(c.preview, null); assert.deepEqual(adapter.writes, []);
   } else {
    await c.scan(); const preview = c.preview!;
    if (scenario === 'dirty-buffer') f.buffers.set('A.md', 'Unsaved user edit');
    if (scenario === 'changed-source') { await adapter.write('A.md', 'Saved user edit'); adapter.writes = []; }
    if (scenario === 'external-reference') { await adapter.write('Outside.md', `- [ ] Outside {{operonId:: other01}} {{blockedBy:: ${preview.operonIds[0]}}}`); adapter.writes = []; }
    if (scenario === 'write-failure' || scenario === 'reload-recovery') adapter.beforeWrite = (file, value) => {
     if (file === 'B.md' || scenario === 'reload-recovery' && file === 'A.md' && value === originals['A.md']) throw new Error('Injected note failure');
    };
    if (scenario === 'marker-failure') adapter.beforeWrite = file => { if (file.endsWith('/resolved.json')) throw new Error('Marker failure'); };
    if (scenario === 'cleanup-failure') adapter.beforeRemove = file => { if (file.endsWith('/resolved.json')) throw new Error('Cleanup failure'); };
    if (scenario === 'concurrent-write') {
     const mutation = f.writer.applyExactMarkdownSourceMutation('A.md', originals['A.md'], 'Concurrent user edit', undefined, undefined, 'plugin');
     await c.apply(); assert.equal((await mutation).outcome, 'committed'); assert.equal(await adapter.read('A.md'), 'Concurrent user edit');
    } else await c.apply();
    if (['dirty-buffer', 'changed-source', 'external-reference', 'concurrent-write'].includes(scenario)) {
     assert.equal(c.result?.status, 'not-applied'); assert.equal(c.counts.converted, 0);
     if (scenario !== 'concurrent-write') assert.deepEqual(adapter.writes, []);
     if (scenario === 'dirty-buffer') assert.equal(f.buffers.get('A.md'), 'Unsaved user edit');
     if (scenario === 'changed-source') assert.equal(await adapter.read('A.md'), 'Saved user edit');
    } else if (scenario === 'write-failure') {
     assert.equal(c.result?.status, 'rolled-back'); assert.equal(c.counts.converted, 0);
     for (const file of ['A.md', 'B.md']) assert.equal(await adapter.read(file), await readFile(path.join(sealed, file), 'utf8'));
    } else {
     assert.equal(c.result?.status, scenario === 'reload-recovery' || scenario === 'marker-failure' ? 'recovery-required' : 'cleanup-pending');
     adapter.beforeWrite = undefined; adapter.beforeRemove = undefined;
     const reloaded = new TasksConversionController({ service: f.fresh(), available: () => true, coordinate: (_paths, _ids, operation) => operation(), settle: async () => {} });
     const writes = adapter.writes.length; await reloaded.initialize(); assert.equal(adapter.writes.length, writes);
     if (scenario === 'reload-recovery') {
      assert.equal(reloaded.inspection?.canRestore, true); await reloaded.resolve('restore'); assert.equal(reloaded.counts.converted, 0);
      for (const file of ['A.md', 'B.md']) assert.equal(await adapter.read(file), await readFile(path.join(sealed, file), 'utf8'));
     } else {
      const noteWrites = adapter.writes.filter(file => file.endsWith('.md')).length;
      await reloaded.resolve(scenario === 'marker-failure' ? 'keep' : 'cleanup');
      assert.equal(adapter.writes.filter(file => file.endsWith('.md')).length, noteWrites);
      for (const change of preview.changes) assert.equal(await adapter.read(change.path), change.after);
     }
     assert.equal(reloaded.blocked, false);
    }
   }
   assert.equal(await adapter.read('Unrelated.md'), await readFile(path.join(sealed, 'Unrelated.md'), 'utf8'));
   assert.ok(adapter.writes.every(file => ['A.md', 'B.md'].includes(file) || file.startsWith('.test-config/plugins/operon/state/tasks-conversion/')));
  } finally { await rm(root, { recursive: true, force: true }); await rm(sealed, { recursive: true, force: true }); }
 });
}

test('known committed marker failure offers only close-record retry and never restore', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope); await c.scan();
 f.adapter.beforeWrite = file => { if (file.endsWith('/resolved.json')) throw new Error('Close marker failed'); };
 await c.apply(); assert.equal(c.result?.sourcesCommitted, true); assert.equal(c.inspection?.state.kind, 'active');
 const { m, button } = modalFixture(c, f.app);
 await new Promise<void>(resolve => { const render = c.onChange; c.onChange = () => { render(); if (!c.busy) resolve(); }; m.onOpen(); });
 assert.ok(button('RetryCleanup')); assert.equal(button('Restore'), undefined); assert.equal(button('FinishRecovery'), undefined);
 const writes = f.adapter.writes.filter(file => file.endsWith('.md')).length;
 await c.resolve('restore'); assert.equal(f.adapter.writes.filter(file => file.endsWith('.md')).length, writes);
 await c.resolve('keep'); assert.equal(c.result?.sourcesCommitted, true); assert.ok(button('RetryCleanup')); assert.equal(button('Restore'), undefined);
 await c.resolve('keep'); assert.equal(c.result?.sourcesCommitted, true); assert.ok(button('RetryCleanup')); assert.equal(button('Restore'), undefined);
 f.adapter.beforeWrite = undefined;
 await c.resolve('keep'); assert.equal(c.blocked, false); assert.equal(f.adapter.writes.filter(file => file.endsWith('.md')).length, writes);
});

test('verified success is not inherited by a different recovery record inspected in the same UI session', async () => {
 const { f, c } = controller(); await c.initialize(); c.updateScope(f.scope); await c.scan();
 f.adapter.beforeWrite = file => { if (file.endsWith('/resolved.json')) throw new Error('Close failed'); };
 await c.apply(); const original = await f.store.load(); assert.equal(original.kind, 'active');
 if (original.kind !== 'active') throw new Error('Missing fixture record');
 f.adapter.beforeWrite = undefined; await f.store.resolve(original, 'kept'); await f.store.cleanup();
 await f.store.create({ ...structuredClone(original.record), id: crypto.randomUUID() });
 await c.initialize(); assert.equal(c.result, null); assert.equal(c.preview, null);
 const { m, button } = modalFixture(c, f.app);
 await new Promise<void>(resolve => { const render = c.onChange; c.onChange = () => { render(); if (!c.busy) resolve(); }; m.onOpen(); });
 assert.ok(button('Restore')); assert.equal(button('RetryCleanup'), undefined);
});


test('large mixed-file selection retains independent defaults, stable identity, focus and exact apply snapshots', async () => {
 const notes = Object.fromEntries(Array.from({ length: 24 }, (_, file) => {
  const end = file % 2 ? '\r\n' : '\n';
  const lines = ['---', 'Title: Synthetic fixture', '---', '- [ ] Existing {{operonId:: zzzzzzz}} {{priority:: Low}}',
   ...Array.from({ length: 12 }, (_, row) => `  - [ ] Task ${file}-${row} 📅 2026-10-10${row % 2 ? ' ⏬' : ''}`),
   '```md', '- [ ] Protected 📅 2026-10-10', '```', '- [ ] Ordinary checkbox'];
  return [`Folder/File-${String(file).padStart(2, '0')}.md`, lines.join(end) + end];
 }));
 const { f, c } = controller(fixture(notes)); f.settings.defaultPriority = 'High';
 await c.initialize(); c.updateScope(f.scope); await c.scan();
 const all = c.preview!, selected = all.rows.filter(row => row.status === 'eligible' && row.lineNumber % 3 === 0).map(row => row.key);
 const { m, button, doc } = modalFixture(c);
 await new Promise<void>(resolve => { const render = c.onChange; c.onChange = () => { render(); if (!c.busy) resolve(); }; m.onOpen(); });
 button('SelectNone').focus(); c.select([]); assert.equal(doc.activeElement?.dataset.focusKey, 'SelectNone');
 c.select(selected); const approved = c.preview!;
 assert.equal(approved.operonIds.length, 96); assert.equal(approved.scan.timestamp, all.scan.timestamp);
 for (const row of approved.rows.filter(row => row.selected)) {
  assert.equal(row.operonId, all.rows.find(original => original.key === row.key)!.operonId);
  const task = parseTaskLine(row.after!, row.lineNumber, row.path, f.settings.keyMappings)!;
  assert.equal(task.fields.some(field => field.key === 'parentTask'), false);
  if (row.lineNumber % 2 === 0) assert.equal(task.fields.find(field => field.key === 'priority')?.value, 'High');
 }
 c.select(all.selectedKeys); c.select(selected); assert.deepEqual(c.preview!.changes, approved.changes);
 await c.apply(); assert.equal(c.result?.status, 'committed'); assert.equal(c.counts.converted, 96);
 for (const change of approved.changes) assert.equal(await f.adapter.read(change.path), change.after);
 assert.equal(doc.activeElement?.dataset.focusKey, 'New'); assert.equal((await f.store.load()).kind, 'empty');
});
