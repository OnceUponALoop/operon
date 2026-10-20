import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'operon-creator-repeat-'));
after(() => rm(temporary, { recursive: true, force: true }));
await build({ stdin: { contents: `
 export { TaskCreatorModal, createEmptyTaskCreatorDraft } from './src/ui/task-creator-modal';
 export { DEFAULT_SETTINGS } from './src/types/settings';
 export { normalizeInlineCompletionMode } from './src/storage/repeat-series-store';
 export { prepareCreationCommit } from './src/core/task-creation-commit';
 export { CreationDraftProperties } from './src/core/task-creation-draft-properties';
 export { App, parseYaml } from 'obsidian';
`, resolveDir: root }, outfile: path.join(temporary, 'helpers.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
 alias: { obsidian: path.join(root, 'scripts/test-support/obsidian-native-yaml.ts') },
 banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
const h = await import(pathToFileURL(path.join(temporary, 'helpers.mjs')).href);

// Execute production routing methods; replace only the floating picker/host boundary.
function compile(file, name, dependencies, className) {
 const source = readFileSync(path.join(root, file), 'utf8');
 const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
 const nodes = className ? ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === className).members : ast.statements;
 const node = nodes.find(n => n.name?.getText(ast) === name);
 assert.ok(node, name);
 const declaration = className ? `class Subject { ${node.getText(ast)} }` : node.getText(ast).replace(/^export\s+/u, '');
 const js = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
 return new Function(...Object.keys(dependencies), `${js}; return ${className ? `Subject.prototype.${name}` : name};`)(...Object.values(dependencies));
}
const properties = { keyMappings: h.DEFAULT_SETTINGS.keyMappings, propertyTypes: {} };
const schedule = 'mode=schedule|freq=week|interval=1|days=mo';
const count = 'mode=count|freq=day|interval=1|count=3';
const reference = '2026-11-02';
async function fixture(mode, template = '') {
 const settings = structuredClone(h.DEFAULT_SETTINGS);
 const modal = new h.TaskCreatorModal(new h.App(), {
  settings, allTasks: [], initialDraft: h.createEmptyTaskCreatorDraft(), initialCreateType: mode,
  preparedAdapter: { properties, readTemplate: async () => `---\n${template}\n---\nBody`, clock: () => ({ now: '2026-10-17T12:00:00' }), parent: () => null, candidates: () => [], onSubmit: () => true },
  onSubmitInline: () => true, onSubmitFile: () => true,
 });
 await modal.prepared.select({ id: 'A', name: 'A', path: 'A.md', kind: 'folder' }, 'Task');
 modal.contentEl.toggleClass = () => {};
 modal.renderFieldButtons = () => {}; modal.renderSubmitControls = () => {}; modal.applyThemeColor = () => {};
 modal.refreshPreparedDraft();
 const anchor = { addClass() {}, removeClass() {} };
 modal.fieldButtonMap.set('repeat', anchor);
 let picker;
 const dispatch = compile('src/ui/task-field-picker-dispatch.ts', 'openTaskFieldPicker', {
  showRepeatPicker: (_anchor, options) => {
   picker = { options, closed: false };
   const current = picker;
   return () => { if (current.closed) return; current.closed = true; options.onClose?.(); };
  },
 });
 modal.openFieldPicker = compile('src/ui/task-creator-modal.ts', 'openFieldPicker', {
  openTaskFieldPicker: dispatch, normalizeInlineCompletionMode: h.normalizeInlineCompletionMode,
  window: { setTimeout() {} },
 }, 'TaskCreatorModal');
 return {
  modal,
  open() { modal.openFieldPicker('repeat'); return picker; },
  save(payload) { const current = this.open(); current.options.onSave({ inlineCompletionMode: 'keep-completed', ...payload }); assert.equal(current.closed, true); },
  commit() { return h.prepareCreationCommit(modal.prepared.submission(mode, 'Task', modal.draft.inlineCompletionMode), properties, { operonId: 'task034', now: '2026-10-17T12:00:00' }); },
 };
}
for (const mode of ['inline', 'file']) {
 test(`${mode}: Save updates immediately and persists the explicit reference date`, async () => {
  const f = await fixture(mode);
  f.save({ repeat: schedule, datetimeRepeatEnd: '', repeatOccurrenceDate: reference });
  assert.equal(f.modal.draft.fieldValues.repeat, schedule);
  assert.equal(f.modal.draft.fieldValues.repeatOccurrenceDate, reference);
  assert.equal(f.open().options.repeatOccurrenceDate, reference);
  const output = f.commit();
  assert.equal(output.fieldValues.repeatOccurrenceDate, reference);
  assert.ok(output.fieldValues.repeatSeriesId);
  assert.ok(output.inlineLine.includes(reference));
  assert.equal(h.parseYaml(output.fileContent().split('---')[1]).repeatOccurrenceDate, reference);
  assert.equal(f.modal.getVisibleToolbarFieldOrder().includes('repeatOccurrenceDate'), false);
 });
 test(`${mode}: Count keeps its anchor and derived end through other edits and final serialization`, async () => {
  const f = await fixture(mode);
  f.save({ repeat: count, datetimeRepeatEnd: '2026-11-04T23:59:59', repeatOccurrenceDate: reference });
  for (const patch of [{ estimate: '1800' }, { dateScheduled: '2026-12-20' }, { priority: 'High' }]) {
   f.modal.applyPayloadToDraft(patch);
   assert.equal(f.modal.draft.fieldValues.datetimeRepeatEnd, '2026-11-04T23:59:59');
   assert.equal(f.modal.draft.fieldValues.repeatOccurrenceDate, reference);
  }
  f.save({ repeat: count, datetimeRepeatEnd: '2026-11-12T23:59:59', repeatOccurrenceDate: '2026-11-10' });
  const output = f.commit();
  assert.equal(output.fieldValues.repeat, count);
  assert.equal(output.fieldValues.repeatOccurrenceDate, '2026-11-10');
  assert.equal(output.fieldValues.datetimeRepeatEnd, '2026-11-12T23:59:59');
 });
 test(`${mode}: Clear removes the whole recurrence immediately without generating identity`, async () => {
  const f = await fixture(mode);
  f.save({ repeat: count, datetimeRepeatEnd: '2026-11-04T23:59:59', repeatOccurrenceDate: reference });
  const picker = f.open(); picker.options.onClear(); assert.equal(picker.closed, true);
  assert.equal(f.modal.draft.fieldValues.repeat, '');
  assert.equal(f.modal.draft.fieldValues.datetimeRepeatEnd, '');
  assert.equal(f.modal.draft.fieldValues.repeatOccurrenceDate, '');
  f.modal.applyPayloadToDraft({ estimate: '3600' });
  const output = f.commit();
  assert.ok(!output.fieldValues.repeat); assert.ok(!output.fieldValues.repeatSeriesId); assert.ok(!output.fieldValues.repeatOccurrenceDate);
  assert.equal(h.parseYaml(output.fileContent().split('---')[1]).repeatOccurrenceDate, undefined);
 });
 test(`${mode}: Cancel and outside close leave both draft and completion choice unchanged`, async () => {
  const f = await fixture(mode);
  f.save({ repeat: schedule, datetimeRepeatEnd: '', repeatOccurrenceDate: reference });
  const before = structuredClone(f.modal.draft);
  const snapshot = f.modal.prepared.draft.snapshot();
  for (const action of ['onCancel', 'onClose']) { const picker = f.open(); picker.options[action](); assert.equal(picker.closed, true); }
  assert.deepEqual(f.modal.prepared.draft.snapshot(), snapshot); assert.deepEqual(f.modal.draft, before);
 });
 test(`${mode}: When done without reference retains existing supported behavior`, async () => {
  const f = await fixture(mode);
  for (const end of ['', '2026-12-31T23:59:59']) {
   f.save({ repeat: 'mode=done|freq=day|interval=1', datetimeRepeatEnd: end, inlineCompletionMode: 'replace-completed' });
   assert.equal(f.modal.draft.fieldValues.datetimeRepeatEnd, end);
   assert.equal(f.modal.draft.fieldValues.repeatOccurrenceDate, undefined);
   assert.equal(f.modal.draft.inlineCompletionMode, 'replace-completed');
   assert.equal(f.commit().fieldValues.repeatOccurrenceDate, undefined);
  }
 });
 test(`${mode}: rejected Save is atomic, Cancel closes, and later edits cannot expose a partial change`, async () => {
  const f = await fixture(mode);
  f.save({ repeat: schedule, datetimeRepeatEnd: '', repeatOccurrenceDate: reference });
  const before = f.modal.prepared.draft.snapshot(); const legacy = structuredClone(f.modal.draft);
  const picker = f.open();
  assert.throws(() => picker.options.onSave({ repeat: 'mode=done|freq=day|interval=1', datetimeRepeatEnd: '', repeatOccurrenceDate: '2026-02-30', inlineCompletionMode: 'replace-completed' }));
  assert.deepEqual(f.modal.prepared.draft.snapshot(), before); assert.deepEqual(f.modal.draft, legacy);
  picker.options.onCancel(); assert.equal(picker.closed, true);
  f.modal.applyPayloadToDraft({ estimate: '1800' }); assert.equal(f.modal.draft.fieldValues.repeat, schedule);
  assert.equal(f.modal.draft.fieldValues.repeatOccurrenceDate, reference);
 });
 test(`${mode}: template identities stay excluded while explicit picker reference survives template reapplication`, async () => {
  const f = await fixture(mode, `repeat: ${schedule}\nrepeatOccurrenceDate: 2001-01-01\nrepeatSeriesId: old-series`);
  assert.equal(f.modal.draft.fieldValues.repeatOccurrenceDate, undefined);
  assert.equal(f.modal.draft.fieldValues.repeatSeriesId, undefined);
  assert.equal(f.commit().fieldValues.repeatOccurrenceDate, undefined);
  f.save({ repeat: schedule, datetimeRepeatEnd: '', repeatOccurrenceDate: reference });
  await f.modal.prepared.select({ id: 'B', name: 'B', path: 'B.md', kind: 'folder' }, 'Task');
  f.modal.refreshPreparedDraft();
  const output = f.commit(); assert.notEqual(output.fieldValues.repeatSeriesId, 'old-series');
  assert.equal(output.fieldValues.repeatOccurrenceDate, reference);
  const yaml = h.parseYaml(output.fileContent('---\nrepeatOccurrenceDate: 1999-01-01\nrepeatSeriesId: stale\n---\nBody').split('---')[1]);
  assert.equal(yaml.repeatOccurrenceDate, reference); assert.notEqual(yaml.repeatSeriesId, 'stale');
 });
 test(`${mode}: system fields remain forbidden outside the dedicated Repeat edit`, async () => {
  const f = await fixture(mode); const catalog = new h.CreationDraftProperties(properties);
  for (const key of ['repeatOccurrenceDate', 'repeatSeriesId']) {
   assert.equal(catalog.resolve(key).merge, 'system');
   assert.throws(() => f.modal.prepared.draft.setValue(key, key === 'repeatOccurrenceDate' ? reference : 'stale'));
  }
  const before = f.modal.prepared.draft.snapshot();
  assert.throws(() => f.modal.prepared.applyPayload({ repeat: schedule, repeatSeriesId: 'stale' }));
  assert.deepEqual(f.modal.prepared.draft.snapshot(), before);
 });
}
