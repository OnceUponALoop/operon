import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const temp = await mkdtemp(path.join(tmpdir(), 'operon-table-repeat-'));
after(() => rm(temp, { recursive: true, force: true }));
await build({ stdin: { contents: `
 export { formatTableRepeatValue } from './src/ui/table/table-display';
 export { parseRepeatRule } from './src/core/repeat-rule';
 export { formatRepeatRuleSummaryI18n } from './src/core/repeat-rule-i18n';
 export * from './src/ui/table/table-text-edit-route';
 export * from './src/ui/table/table-column-color';
`, resolveDir: root }, outfile: path.join(temp, 'helpers.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', alias: { obsidian: path.join(root, 'scripts/test-support/obsidian.ts') } });
const helpers = await import(pathToFileURL(path.join(temp, 'helpers.mjs')).href);
const { formatTableRepeatValue, parseRepeatRule, formatRepeatRuleSummaryI18n, isTablePlainTextField, resolveTableTaskTextEditRoute } = helpers;

// Execute the real TypeScript methods with lightweight host adapters; no Obsidian UI is opened.
function compile(file, name, deps = {}, className) {
 const source = read(file), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
 const nodes = className ? ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === className).members : ast.statements;
 const node = nodes.find(n => n.name?.getText(ast) === name);
 assert.ok(node, name);
 const declaration = className ? `class Subject { ${node.getText(ast)} }` : node.getText(ast).replace(/^export\s+/u, '');
 const js = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
 return new Function(...Object.keys(deps), `${js}; return ${className ? `Subject.prototype.${name}` : name};`)(...Object.values(deps));
}
class Element {
 children = []; attrs = {}; dataset = {}; events = {}; cls = ''; textContent = '';
 constructor(options = {}) { this.cls = typeof options === 'string' ? options : options.cls ?? ''; this.textContent = options.text ?? ''; }
 createSpan(options) { const node = new Element(options); this.children.push(node); return node; }
 addClass(cls) { this.cls += ` ${cls}`; }
 setAttribute(key, value) { this.attrs[key] = value; }
 querySelector(selector) { return selector === 'svg' ? this.svg ?? null : null; }
 addEventListener(name, callback) { (this.events[name] ??= []).push(callback); }
 dispatch(name, overrides = {}) { for (const callback of this.events[name] ?? []) callback({ button: 0, detail: 1, target: this, preventDefault() {}, stopPropagation() {}, ...overrides }); }
}
const field = { key: 'repeat', type: 'text', icon: 'repeat' };
const settings = { keyMappings: [], pipelines: [], priorities: [], colorPalette: [{ id: 'red', hex: '#ff0000' }, { id: 'blue', hex: '#0000ff' }], calendarWeekStart: 'monday', calendarSidebarShowWeekNumbers: true };
const raw = 'mode=done|freq=week|interval=1';
const task = { operonId: 'task-1', primary: { filePath: 'Tasks.md', format: 'inline' }, tags: [], fieldValues: { repeat: raw, repeatSeriesId: 'series-1', repeatOccurrenceDate: '2026-10-16', dateDue: '2026-10-16', datetimeRepeatEnd: '2027-01-01' } };
const label = (el, value) => { el.accessibleLabel = value; };
const chipFile = 'src/ui/table/table-cell-chip.ts', viewFile = 'src/ui/table/operon-table-view.ts';
const valueIcon = compile(chipFile, 'renderTableValueIconChipContent', { setIcon: (el, icon) => { el.svg = { icon }; } });
const renderChip = compile(chipFile, 'renderTableCellChipContent', {
 getTableTaskField: () => field, isTableDurationLikeTaskField: () => false, decorateTableDateValueChip() {},
 applyTableCellChipAccent: (el, key, value, options) => { el.accent = helpers.resolveTableColumnCellAccent(options.column, options.accentValue ?? value, options); },
 resolveTableExternalLink: () => null, formatTableRepeatValue, renderTableValueIconChipContent: valueIcon,
 setAccessibleLabelWithoutTooltip: label, bindOperonHoverTooltip: (el, options) => { el.tooltip = options; },
 resolveTableCellChipAccent: (key, value, options) => helpers.resolveTableColumnCellAccent(options.column, options.accentValue ?? value, options),
});
const pickerCalls = [];
const dispatchPicker = compile('src/ui/task-field-picker-dispatch.ts', 'openTaskFieldPicker', {
 showRepeatPicker: (anchor, options) => { pickerCalls.push({ anchor, options }); return () => {}; },
});
const decorate = compile(viewFile, 'decorateEditableTaskCell', {
 resolveTableParentTaskActivation: helpers.resolveTableParentTaskActivation, buildTableEditableCellKey: () => 'task-1:repeat',
 getTableTaskFieldLabel: () => 'Repeat', formatTableRepeatValue, t: () => 'Edit', setAccessibleLabelWithoutTooltip: label,
 getTableTaskField: () => field, resolveTableTaskTextEditRoute, snapshotFloatingRectAnchor: cell => cell,
 getExcludedTablePickerTaskIds: () => [], getTableManualDatePickerOptions: () => undefined,
 normalizeTablePickerPayload: value => value, openTaskFieldPicker: dispatchPicker,
 isCompactTaskMarkdownLinkEventTarget: () => false, getOwnerWindow: () => ({ setTimeout() {} }),
}, 'OperonTableView');
function harness(value = raw) {
 pickerCalls.length = 0;
 const commits = [], cell = new Element();
 const subject = { app: {}, callbacks: { onUpdateTaskFields() {} }, indexer: { getAllTasks: () => [task] }, pendingCellKey: null,
 syncPendingCellState() {}, closeActivePicker() {}, commitTaskCellUpdate: (el, target, key, cellKey, payload) => commits.push(payload),
 openInlineTextPopover() { assert.fail('Repeat must not use text editing'); } };
 const target = { ...task, fieldValues: { ...task.fieldValues, repeat: value } };
 decorate.call(subject, cell, target, 'repeat', value, { settings }, true);
 return { cell, commits, subject, target };
}

for (const value of ['mode=schedule|freq=day|interval=1', raw, 'mode=schedule|freq=week|interval=2|days=mo,we,fr', 'mode=schedule|freq=month|interval=1|monthdays=1,15']) {
 test(`summary matches Task Editor: ${value}`, () => {
  const rule = parseRepeatRule(value); assert.ok(rule);
  assert.equal(formatTableRepeatValue(value), formatRepeatRuleSummaryI18n(rule));
  assert.notEqual(formatTableRepeatValue(value), value);
 });
}
test('empty and unsupported rules retain safe display fallback', () => {
 assert.equal(formatTableRepeatValue('  '), ''); assert.equal(formatTableRepeatValue(' unsupported rule '), 'unsupported rule');
});
test('repeat uses picker and color eligibility while other text remains plain', () => {
 assert.equal(isTablePlainTextField(field), false);
 for (const value of ['', raw, 'unsupported rule']) assert.equal(resolveTableTaskTextEditRoute(field, value), 'picker');
 assert.equal(helpers.isTableFieldColorModeEligible(field), true);
 const custom = { key: 'customText', type: 'text' };
 assert.equal(isTablePlainTextField(custom), true); assert.equal(resolveTableTaskTextEditRoute(custom, 'hello'), 'popover');
 assert.equal(helpers.isTableFieldColorModeEligible(custom), false);
});
test('detailed chip renders repeat icon, readable text, accessible name and tooltip', () => {
 const chip = new Element(); renderChip(chip, 'repeat', raw, { settings, column: { key: 'repeat', colorMode: 'noColor' } });
 assert.equal(chip.children[0].svg.icon, 'repeat'); assert.equal(chip.children[1].textContent, formatTableRepeatValue(raw));
 assert.match(chip.children[1].cls, /operon-table-cell-chip-label/u);
 assert.equal(chip.accessibleLabel, formatTableRepeatValue(raw)); assert.equal(chip.tooltip.content, chip.accessibleLabel);
 assert.equal(chip.accent, null); assert.deepEqual(chip.events, {});
});
test('random color uses serialized rule and normal Table color resolver', () => {
 const column = { key: 'repeat', colorMode: 'randomColors' }, chip = new Element();
 renderChip(chip, 'repeat', raw, { settings, column, accentValue: raw });
 assert.equal(chip.accent, helpers.resolveTableColumnCellAccent(column, raw, { settings }));
 assert.ok(chip.accent); assert.equal(chip.tooltip.taskColor, chip.accent);
});
test('pointerdown plus click opens once and forwards original recurrence context', () => {
 const { cell, target } = harness(); cell.dispatch('pointerdown'); cell.dispatch('click');
 assert.equal(pickerCalls.length, 1);
 const options = pickerCalls[0].options;
 assert.equal(options.value, raw); assert.equal(options.repeatSeriesId, target.fieldValues.repeatSeriesId);
 assert.equal(options.repeatOccurrenceDate, target.fieldValues.repeatOccurrenceDate);
 assert.equal(options.repeatEnd, target.fieldValues.datetimeRepeatEnd); assert.equal(options.dateDue, target.fieldValues.dateDue);
 assert.equal(options.taskFormat, 'inline'); assert.equal(cell.accessibleLabel.includes(formatTableRepeatValue(raw)), true);
});
test('keyboard and empty/unsupported values open Repeat picker', () => {
 for (const value of ['', raw, 'unsupported rule']) for (const key of ['Enter', ' ']) {
  const { cell } = harness(value); cell.dispatch('keydown', { key }); assert.equal(pickerCalls.length, 1); assert.equal(pickerCalls[0].options.value, value);
 }
});
test('pending commits block picker activation', () => {
 const { cell, subject } = harness(); subject.pendingCellKey = 'pending';
 cell.dispatch('pointerdown'); cell.dispatch('click'); cell.dispatch('keydown', { key: 'Enter' }); assert.equal(pickerCalls.length, 0);
});
test('Save and Clear preserve existing mutation payloads; close does not write', () => {
 const { cell, commits } = harness(); cell.dispatch('click'); const options = pickerCalls[0].options;
 options.onCancel?.(); options.onClose?.(); assert.deepEqual(commits, []);
 options.onSave({ repeat: 'mode=schedule|freq=day|interval=2', datetimeRepeatEnd: '', repeatOccurrenceDate: '2026-10-17' });
 assert.deepEqual(commits[0], { repeat: 'mode=schedule|freq=day|interval=2', datetimeRepeatEnd: '', repeatOccurrenceDate: '2026-10-17' });
 options.onClear(); assert.deepEqual(commits[1], { repeat: '', datetimeRepeatEnd: '', repeatSeriesId: '', repeatOccurrenceDate: '' });
});
test('standalone detailed render reuses shared chips; empty stays blank', () => {
 const render = compile(viewFile, 'renderValueCell', {
 isTableFilePropertyColumnKey: () => false, isTableProgressColumnKey: () => false, PROJECT_SERIAL_TABLE_FIELD_KEY: 'projectSerial',
 isTablePlainTextField, getTableTaskField: () => field,
 renderTableCellChips: (cell, key, value, options) => { cell.chips = { key, value, options }; },
 }, 'OperonTableView');
 for (const rootClass of ['operon-table-root']) for (const value of [raw, '']) {
  const cell = new Element(rootClass), subject = { isEditableTaskCell: () => true, decorateEditableTaskCell() {}, shouldUseIconOnlyColumn: () => false };
  render.call(subject, cell, task, { key: 'repeat' }, value, { settings, valueResolver: {} }, false);
  if (!value) assert.equal(cell.chips, undefined);
  else { assert.equal(cell.chips.value, raw); assert.match(cell.chips.options.chipClassName, /operon-table-editable-chip/u); assert.match(cell.chips.options.chipClassName, /operon-table-cell-chip/u); }
 }
});

test('embedded detailed cells use shared bordered chips and preserve blank cells', () => {
 const render = compile('src/ui/embed-table-processor.ts', 'renderEmbedTableCell', {
  applyTableColumnGeometryClass() {}, isTableAdminColumn: () => false, applyTableColumnAlignmentClass() {},
  resolveTableParentContextContentColumn: column => column, TABLE_TASK_TREE_COLUMN_KEY: '__tree',
  isTableFilePropertyColumnKey: () => false, isTableProgressColumnKey: () => false, PROJECT_SERIAL_TABLE_FIELD_KEY: 'projectSerial',
  isEditableTableTaskFieldKey: () => true, decorateEmbedTableEditableTaskCell() {}, shouldUseEmbedTableIconOnlyColumn: () => false,
  isTablePlainTextField, getTableTaskField: () => field,
  renderTableCellChips: (cell, key, value, options) => { cell.chips = { key, value, options }; },
 });
 for (const value of [raw, '']) {
  const cell = new Element();
  render({ createDiv: () => cell }, {}, task, { key: 'repeat' }, { settings, columnGeometry: { entries: [{}] }, valueResolver: { getDisplayValue: () => value } }, 0, {}, 1, false);
  if (!value) assert.equal(cell.chips, undefined);
  else { assert.equal(cell.chips.value, raw); assert.match(cell.chips.options.chipClassName, /operon-table-editable-chip/u); assert.match(cell.chips.options.chipClassName, /operon-table-cell-chip/u); }
 }
});
test('icon-only passes readable tooltip/accessibility and enables shared accent path', () => {
 let captured;
 const dependencies = {
 getTableTaskFieldLabel: () => 'Repeat', resolveTableLocationCellVisual: () => null, getTableTaskField: () => field,
 formatTableRepeatValue, TABLE_TASK_DATA_TYPE_COLUMN_KEY: '__dataType', formatTableCompactDuration: () => null,
 isTablePlainTextField, isTableTaskMediaField: () => false,
 renderTableIconOnlyCell: (cell, options) => { captured = options; return new Element(); },
 resolveTableIconOnlyCellIcon: (key, value, fallback) => fallback, resolveTableValueCellIcon: (key, value, settings, fallback) => fallback,
 resolveTableIconOnlyCellAccent: () => '#123456', bindTableCompactAssigneeImage() {},
 };
 for (const embedded of [false, true]) {
 const render = embedded ? compile('src/ui/embed-table-processor.ts', 'renderEmbedTableIconOnlyCell', dependencies) : compile(viewFile, 'renderIconOnlyCell', dependencies, 'OperonTableView');
 render.call({ callbacks: {} }, new Element(), task, { key: 'repeat' }, raw, { settings, valueResolver: { getRawValue: () => raw } }, {});
 assert.equal(captured.icon, 'repeat'); assert.equal(captured.content, formatTableRepeatValue(raw));
 assert.equal(captured.ariaLabel, `Repeat: ${formatTableRepeatValue(raw)}`); assert.equal(captured.color, '#123456');
 assert.equal(captured.contentEl, undefined);
 }
});
test('shared CSS provides borders, ellipsis and row/cell hover without repeat-specific overrides', () => {
 const css = read('styles.css');
 assert.match(css, /\.operon-table-cell-chip-label\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/u);
 assert.ok(css.includes('.operon-table-root.operon-table-embed .operon-table-cell-chip'));
 assert.ok(css.includes('.operon-table-cell.is-editable:hover .operon-table-field-accent-chip'));
 assert.ok(css.includes('.is-operon-table-refresh-hover'));
 assert.doesNotMatch(css, /\.operon-table-repeat-chip/u);
});

test('embedded Table opens Repeat picker with pending guard and commits through its existing adapter', () => {
 pickerCalls.length = 0;
 const cell = new Element(), instance = { pendingCellKey: null }, commits = [];
 const deps = { app: {}, indexer: { getAllTasks: () => [task] } };
 const decorateEmbed = compile('src/ui/embed-table-processor.ts', 'decorateEmbedTableEditableTaskCell', {
  canWriteEmbedTable: () => true, resolveTableParentTaskActivation: helpers.resolveTableParentTaskActivation,
  findEmbedTableInstance: () => instance, buildTableEditableCellKey: () => 'task-1:repeat',
  getTableTaskFieldLabel: () => 'Repeat', formatTableRepeatValue, t: () => 'Edit', setAccessibleLabelWithoutTooltip: label,
  syncEmbedTablePendingCellState() {}, getTableTaskField: () => field, resolveTableTaskTextEditRoute,
  closeEmbedTableActivePicker() {}, openTaskFieldPicker: dispatchPicker, snapshotFloatingRectAnchor: value => value,
  getExcludedTablePickerTaskIds: () => [], getTableManualDatePickerOptions: () => undefined, normalizeTablePickerPayload: value => value,
  commitEmbedTableCellUpdate: (instance, deps, cell, task, key, cellKey, payload) => commits.push(payload),
  isCompactTaskMarkdownLinkEventTarget: () => false, getOwnerWindow: () => ({ setTimeout() {} }),
 });
 decorateEmbed(cell, task, 'repeat', raw, { settings }, deps, true);
 cell.dispatch('pointerdown'); cell.dispatch('click'); assert.equal(pickerCalls.length, 1);
 assert.equal(cell.accessibleLabel.includes(formatTableRepeatValue(raw)), true);
 assert.equal(pickerCalls[0].options.value, raw);
 pickerCalls[0].options.onSave({ repeat: raw, datetimeRepeatEnd: '' }); assert.deepEqual(commits, [{ repeat: raw, datetimeRepeatEnd: '' }]);
 pickerCalls[0].options.onClose(); assert.equal(instance.activePickerClose, null);
 instance.pendingCellKey = 'pending'; cell.dispatch('keydown', { key: 'Enter' }); assert.equal(pickerCalls.length, 1);
 instance.pendingCellKey = null; cell.dispatch('keydown', { key: ' ' }); assert.equal(pickerCalls.length, 2);
});
