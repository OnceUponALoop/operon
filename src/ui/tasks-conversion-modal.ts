import { App, Modal, FuzzySuggestModal, TFolder, type FuzzyMatch } from 'obsidian';
import { t } from '../core/i18n';
import { asyncHandler } from '../core/async-action';
import { scopeSettingsModal } from './settings/settings-scope';
import { TasksConversionController } from './tasks-conversion-controller';

const text = (key: string, vars?: Record<string, string>) => t('settings', `tasksBulk${key}`, vars);
class TasksConversionScopePicker extends FuzzySuggestModal<string> {
 constructor(app: App, private readonly kind: 'files' | 'folders', private readonly choose: (path: string) => void) {
  super(app); this.setPlaceholder(text(kind === 'files' ? 'AddFiles' : 'AddFolders'));
 }
 getItems(): string[] {
  return this.kind === 'files' ? this.app.vault.getMarkdownFiles().map(file => file.path).sort()
   : ['/', ...this.app.vault.getAllLoadedFiles().filter(file => file instanceof TFolder && file.path && file.path !== '/').map(file => file.path).sort()];
 }
 getItemText(path: string): string { return path === '/' ? text('VaultRoot') : path; }
 renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void { el.setText(this.getItemText(match.item)); }
 onChooseItem(path: string): void { this.choose(path); }
}

export class TasksConversionModal extends Modal {
 private closed = false;
 private readonly expanded = new Set<string>();
 constructor(app: App, readonly controller: TasksConversionController, private readonly closedCallback: () => void) {
  super(app); this.modalEl.addClass('operon-tasks-conversion-modal');
  scopeSettingsModal(this, true);
  this.controller.onChange = () => this.render();
 }
 onOpen(): void {
  this.titleEl.setText(text('Title')); this.render();
  void this.controller.initialize();
 }
 close(): void {
  if (this.controller.busy) { this.controller.cancel(); return; }
  super.close();
 }
 shutdown(): void { this.controller.dispose(); super.close(); }
 onClose(): void {
  if (this.closed) return;
  this.closed = true; this.controller.dispose(); this.contentEl.empty(); this.closedCallback();
 }
 private button(parent: HTMLElement, key: string, action: () => void | Promise<void>, disabled = false,
  vars?: Record<string, string>, focusKey = key): HTMLButtonElement {
  const button = parent.createEl('button', { text: text(key, vars), attr: { type: 'button', 'data-focus-key': focusKey } });
  button.disabled = disabled;
  button.addEventListener('click', asyncHandler('Tasks conversion UI action failed', async () => { await action(); }));
  return button;
 }
 private details(parent: HTMLElement, key: string, label: string): HTMLDetailsElement {
  const details = parent.createEl('details'); details.open = this.expanded.has(key);
  details.createEl('summary', { text: label, attr: { 'data-focus-key': key } });
  details.addEventListener('toggle', () => { if (details.open) this.expanded.add(key); else this.expanded.delete(key); });
  return details;
 }
 private code(parent: HTMLElement, value: string): void { parent.createEl('pre', { text: value, cls: 'operon-tasks-conversion-source' }); }
 private render(): void {
  if (this.closed) return;
  const c = this.controller, doc = this.contentEl.ownerDocument;
  const focused = (doc.activeElement as HTMLElement | null)?.dataset?.focusKey;
  const scroll = this.contentEl.scrollTop;
  this.contentEl.empty();
  this.contentEl.createEl('p', { text: text('Help'), cls: 'setting-item-description' });
  if (c.error) this.contentEl.createEl('p', { text: c.error === 'settlement-pending' ? text('SettlementPending') : text('Error', { reason: c.error }), attr: { role: 'alert' } });
  if (c.busy) {
   const progress = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-progress', attr: { role: 'status', 'aria-live': 'polite' } });
   const label = text('Working', { phase: text(c.phase === 'apply' ? 'Applying' : c.phase === 'restore' ? 'Restoring' : c.phase === 'scan' ? 'Scanning' : c.phase === 'settle' ? 'Refreshing' : 'Checking') });
   progress.createEl('p', { text: label });
   const bar = progress.createEl('progress', { attr: { 'aria-label': label } });
   if (c.progress) { bar.max = Math.max(1, c.progress.totalFiles); bar.value = c.progress.completedFiles;
    progress.createEl('p', { text: `${c.progress.completedFiles} / ${c.progress.totalFiles} · ${c.progress.path}` }); }
   this.button(progress, 'Cancel', () => c.cancel());
  } else if (c.blocked && c.inspection) this.renderRecovery();
  else if (c.result) this.renderResult();
  else if (c.inspection) { this.renderScope(); if (c.preview) this.renderPreview(); }
  else {
   if (c.result) { this.renderCounts(this.contentEl); if (c.settlementPending.length) this.button(this.contentEl, 'RetryRefresh', () => c.retrySettlement()); }
   this.button(this.contentEl, 'RetryInspect', () => c.initialize());
  }
  if (!c.busy) this.button(this.contentEl, 'Close', () => this.close());
  this.contentEl.scrollTop = scroll;
  const controls = Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-focus-key]')).filter(el => !(el as HTMLButtonElement).disabled);
  const target = focused ? controls.find(el => el.dataset.focusKey === focused) : null;
  const fallback = controls.find(el => el.dataset.focusKey === (c.busy ? 'Cancel' : c.result && !c.blocked ? 'New' : 'AddFiles'))
   ?? controls.find(el => el.tagName === 'BUTTON' && !(el as HTMLButtonElement).disabled);
  if (focused || c.busy) (target ?? fallback)?.focus({ preventScroll: true });
 }
 private renderScope(): void {
  const c = this.controller, section = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-section' });
  const controls = section.createDiv({ cls: 'operon-tasks-conversion-actions' });
  for (const kind of ['files', 'folders'] as const) {
   this.button(controls, kind === 'files' ? 'AddFiles' : 'AddFolders', () => {
    scopeSettingsModal(new TasksConversionScopePicker(this.app, kind, path => {
     if (c.busy || !c.available || c.blocked) return;
     c.updateScope({ ...c.scope, [kind]: [...c.scope[kind], path] });
    }), true).open();
   });
   for (const path of c.scope[kind]) {
    const row = section.createDiv({ cls: 'operon-tasks-conversion-path' });
    row.createSpan( { text: path === '/' ? text('VaultRoot') : path });
    this.button(row, 'Remove', () => c.updateScope({ ...c.scope, [kind]: c.scope[kind].filter(value => value !== path) }), false, undefined, `${kind}:${path}`);
   }
  }
  const label = section.createEl('label', { cls: 'operon-tasks-conversion-check' });
  const toggle = label.createEl('input', { attr: { type: 'checkbox', 'data-focus-key': 'subfolders' } });
  toggle.checked = c.scope.includeSubfolders; label.createSpan( { text: text('Subfolders') });
  toggle.addEventListener('change', () => c.updateScope({ ...c.scope, includeSubfolders: toggle.checked }));
  this.button(controls, 'Scan', () => c.scan(), !c.scope.files.length && !c.scope.folders.length);
 }
 private renderPreview(): void {
  const c = this.controller, preview = c.preview!;
  const section = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-section' });
  section.createEl('p', { text: text('Selection', { selected: String(preview.selectedKeys.length), eligible: String(preview.rows.filter(row => row.status === 'eligible').length) }), attr: { role: 'status' } });
  if (!preview.rows.some(row => row.status === 'eligible')) section.createEl('p', { text: text('Empty') });
  const actions = section.createDiv({ cls: 'operon-tasks-conversion-actions' });
  this.button(actions, 'SelectAll', () => c.select(preview.rows.filter(row => row.status === 'eligible').map(row => row.key)));
  this.button(actions, 'SelectNone', () => c.select([]));
  for (const file of preview.scan.files) {
   const rows = preview.rows.filter(row => row.path === file.path);
   const group = this.details(section, file.path, file.path);
   if (file.error) { group.createEl('p', { text: file.error === 'excluded' ? text('Excluded') : text('SourceUnavailable', { reason: file.error }) }); continue; }
   const fileActions = group.createDiv({ cls: 'operon-tasks-conversion-actions' });
   const keys = new Set(rows.filter(row => row.status === 'eligible').map(row => row.key));
   this.button(fileActions, 'SelectAll', () => c.select([...new Set([...preview.selectedKeys, ...keys])]), !keys.size, undefined, `all:${file.path}`);
   this.button(fileActions, 'SelectNone', () => c.select(preview.selectedKeys.filter(key => !keys.has(key))), !keys.size, undefined, `none:${file.path}`);
   for (const row of rows) {
    const task = group.createDiv({ cls: 'operon-tasks-conversion-task' });
    const label = task.createEl('label', { cls: 'operon-tasks-conversion-check' });
    const checkbox = label.createEl('input', { attr: { type: 'checkbox', 'data-focus-key': row.key } });
    checkbox.disabled = row.status !== 'eligible'; checkbox.checked = row.selected;
    label.createSpan( { text: text('Line', { line: String(row.lineNumber + 1) }) });
    checkbox.addEventListener('change', () => c.select(checkbox.checked ? [...preview.selectedKeys, row.key] : preview.selectedKeys.filter(key => key !== row.key)));
    this.code(task, row.before);
    if (row.after) this.code(task, row.after);
    if (row.status !== 'eligible') task.createEl('p', { text: text(row.status === 'protected' ? 'Protected' : row.status === 'already_operon' ? 'AlreadyOperon' : row.status === 'hybrid_unsupported' ? 'Hybrid' : 'NotEmoji'), cls: 'setting-item-description' });
    if (row.error) task.createEl('p', { text: text('Error', { reason: row.error }), attr: { role: 'alert' } });
    for (const warning of row.warnings) task.createEl('p', { text: text('Warning', { reason: warning }), cls: 'setting-item-description' });
   }
   if (file.content !== undefined) {
    const full = this.details(group, `full:${file.path}`, text('FullPreview'));
    full.createEl('p', { text: text('Before') }); this.code(full, file.content);
    full.createEl('p', { text: text('After') }); this.code(full, preview.changes.find(change => change.path === file.path)?.after ?? file.content);
   }
  }
  this.button(actions, 'Apply', () => c.apply(), !preview.selectedKeys.length || !!preview.errors.length || !c.available, { count: String(preview.selectedKeys.length) }).addClass('mod-cta');
 }
 private renderResult(): void {
  const c = this.controller, result = c.result!;
  const section = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-section', attr: { role: 'status', 'aria-live': 'polite' } });
  section.createEl('p', { text: text(result.sourcesCommitted || result.status === 'committed' || result.status === 'kept' ? 'Success' : result.status === 'rolled-back' || result.status === 'restored' ? 'RolledBack' : result.status === 'cancelled' ? 'Cancelled' : 'Stopped') });
  this.renderCounts(section);
  if (result.message) section.createEl('p', { text: text('Details', { reason: result.message }) });
  for (const path of result.paths) section.createEl('p', { text: path });
  if (c.settlementPending.length) this.button(section, 'RetryRefresh', () => c.retrySettlement());
  if (!c.inspection) this.button(section, 'RetryInspect', () => c.initialize());
  this.button(section, 'New', () => c.reset(), c.blocked || !!c.settlementPending.length);
 }
 private renderCounts(parent: HTMLElement): void {
  const counts = this.controller.counts;
  if (!counts.available) return;
  parent.createEl('p', { text: text('Counts', { selected: String(counts.selected), converted: String(counts.converted), skipped: String(counts.skipped), unknown: String(counts.unknown) }) });
 }
 private renderRecovery(): void {
  const c = this.controller, inspection = c.inspection!;
  const section = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-section' });
  section.createEl('p', { text: text(c.result?.sourcesCommitted ? 'Success' : 'Recovery'), attr: { role: 'status' } });
  this.renderCounts(section);
  if (inspection.state.kind === 'blocked') section.createEl('p', { text: text('Error', { reason: inspection.state.message }), attr: { role: 'alert' } });
  else if (inspection.state.kind === 'resolved') {
   section.createEl('p', { text: text('CleanupPending') });
   this.button(section, 'RetryCleanup', () => c.resolve('cleanup'));
  } else if (inspection.state.kind === 'active') {
   for (const file of inspection.files) section.createEl('p', { text: `${file.path} · ${text(file.state === 'before' ? 'Before' : file.state === 'after' ? 'After' : 'Conflict')}` });
   if (c.result?.sourcesCommitted) {
    section.createEl('p', { text: text('CleanupPending') });
    this.button(section, 'RetryCleanup', () => c.resolve('keep'), !inspection.canKeep);
   } else {
    this.button(section, 'Restore', () => c.resolve('restore'), !inspection.canRestore);
    this.button(section, 'FinishRecovery', () => c.resolve('keep'), !inspection.canKeep);
   }
  }
  section.createEl('p', { text: text('Evidence', { path: `${this.app.vault.configDir}/plugins/operon/state/tasks-conversion` }), cls: 'setting-item-description' });
  if (c.settlementPending.length) this.button(section, 'RetryRefresh', () => c.retrySettlement());
  this.button(section, 'RetryInspect', () => c.initialize());
 }
}
