import { isOperonExcludedPath } from '../core/operon-path-exclusions';
import { App, FuzzySuggestModal, TFolder, type FuzzyMatch } from 'obsidian';
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

export class TasksConversionSettings {
 private closed = false;
 private readonly expanded = new Set<string>();
 private readonly unsubscribe: () => void;
 private picker: TasksConversionScopePicker | null = null;
 constructor(private readonly app: App, private readonly contentEl: HTMLElement, readonly controller: TasksConversionController) {
  contentEl.addClass('operon-tasks-conversion-settings');
  this.unsubscribe = controller.subscribe(() => this.render());
  this.render();
  if (!controller.inspection && !controller.busy) void controller.initialize();
 }
 dispose(): void {
  if (this.closed) return;
  this.closed = true; this.unsubscribe(); this.picker?.close(); this.controller.dismissConfirmation(); this.contentEl.empty();
 }
 private button(parent: HTMLElement, key: string, action: () => void | Promise<void>, disabled = false,
  vars?: Record<string, string>, focusKey = key): HTMLButtonElement {
  const button = parent.createEl('button', { text: text(key, vars), attr: { type: 'button', 'data-focus-key': focusKey } });
  button.disabled = disabled;
  button.addEventListener('click', asyncHandler('Tasks conversion UI action failed', async () => { if (!this.closed) await action(); }));
  return button;
 }
 private details(parent: HTMLElement, key: string, label: string): HTMLDetailsElement {
  const details = parent.createEl('details'); details.open = this.expanded.has(key);
  details.createEl('summary', { text: label, attr: { 'data-focus-key': key } });
  details.addEventListener('toggle', () => { if (details.open) this.expanded.add(key); else this.expanded.delete(key); });
  return details;
 }
 private render(): void {
  if (this.closed) return;
  const c = this.controller, doc = this.contentEl.ownerDocument;
  const active = doc.activeElement as HTMLElement | null;
  const focused = active && this.contentEl.contains(active) && active.matches(':focus-visible') ? active.dataset.focusKey : undefined;
  const scroll: Array<{ element: HTMLElement; top: number; left: number }> = [];
  for (let element: HTMLElement | null = this.contentEl; element; element = element.parentElement) {
   scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
  }
  // Keep this mounted surface from collapsing beneath the Settings viewport.
  this.contentEl.setCssProps({ '--operon-conversion-min-height': `${this.contentEl.offsetHeight}px` });
  this.contentEl.empty();
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
  else if (c.result) {
   this.renderResult();
   if (c.inspection && !c.settlementPending.length) this.renderScope();
  }
  else if (c.inspection) { this.renderScope(); if (c.preview) this.renderPreview(); }
  else {
   if (c.result) { this.renderCounts(this.contentEl); if (c.settlementPending.length) this.button(this.contentEl, 'RetryRefresh', () => c.retrySettlement()); }
   this.button(this.contentEl, 'RetryInspect', () => c.initialize());
  }
  this.contentEl.setCssProps({ '--operon-conversion-min-height': '0px' });
  const extra = Math.max(0, ...scroll.map(({ element, top }) => top - Math.max(0, element.scrollHeight - element.clientHeight)));
  if (extra && (c.busy || !c.result)) this.contentEl.setCssProps({ '--operon-conversion-min-height': `${this.contentEl.offsetHeight + extra}px` });
  const controls = Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-focus-key]')).filter(el => !(el as HTMLButtonElement).disabled);
  const target = focused ? controls.find(el => el.dataset.focusKey === focused) : null;
  const fallback = controls.find(el => el.dataset.focusKey === (c.busy ? 'Cancel' : c.confirmation ? 'Dismiss' : c.result && !c.blocked ? 'Scan' : c.preview ? 'Apply' : 'AddFiles'))
   ?? controls.find(el => el.tagName === 'BUTTON' && !(el as HTMLButtonElement).disabled);
  if (focused) (target ?? fallback)?.focus({ preventScroll: true });
  for (const { element, top, left } of scroll) { element.scrollTop = top; element.scrollLeft = left; }
 }
 private renderScope(): void {
  const c = this.controller, section = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-section' });
  const controls = section.createDiv({ cls: 'operon-tasks-conversion-actions' });
  for (const kind of ['files', 'folders'] as const) {
   this.button(controls, kind === 'files' ? 'AddFiles' : 'AddFolders', () => {
    this.picker = scopeSettingsModal(new TasksConversionScopePicker(this.app, kind, path => {
     if (this.closed || c.busy || !c.available || c.blocked) return;
     c.updateScope({ ...c.scope, [kind]: [...c.scope[kind], path] });
    }), true); this.picker.open();
   });
   for (const path of c.scope[kind]) {
    const row = section.createDiv({ cls: 'operon-tasks-conversion-path' });
    const excluded = c.preview && isOperonExcludedPath(path, c.preview.scan.settings);
    row.createSpan({ text: `${path === '/' ? text('VaultRoot') : path}${excluded ? ` · ${text('Excluded')}` : ''}` });
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
  const vars = { count: String(preview.selectedKeys.length), files: String(preview.changes.length) };
  section.createEl('p', { text: text(preview.selectedKeys.length ? 'Summary' : 'Empty', vars), attr: { role: 'status', 'aria-live': 'polite' } });
  this.renderMessages(section, 'issues');
  if (c.confirmation === preview) section.createEl('p', { text: text('Confirm', vars) });
  const actions = section.createDiv({ cls: 'operon-tasks-conversion-actions' });
  if (c.confirmation === preview) {
   this.button(actions, 'Dismiss', () => c.dismissConfirmation());
   this.button(actions, 'ConfirmApply', () => c.confirm(preview)).addClass('mod-cta');
  } else this.button(actions, 'Apply', () => c.requestConfirmation(preview), !preview.selectedKeys.length || !!preview.errors.length || !c.available, vars).addClass('mod-cta');
 }
 private renderMessages(section: HTMLElement, key: string): void {
  const c = this.controller, preview = c.preview;
  if (!preview) return;
  const excluded = preview.scan.files.filter(file => file.error === 'excluded').length;
  if (excluded) section.createEl('p', { text: text('ExcludedSummary', { count: String(excluded) }) });
  const warnings = c.skippedSources.map(path => text('SkippedSource', { path }));
  const information: string[] = [], errors: string[] = [];
  for (const file of preview.scan.files) if (file.error && file.error !== 'excluded') warnings.push(`${file.path} · ${text('SourceUnavailable', { reason: file.error })}`);
  for (const row of preview.rows) {
   const location = `${row.path}:${row.lineNumber + 1}`;
   if (row.error) errors.push(`${location} · ${row.error}`);
   else for (const reason of row.warnings) information.push(`${location} · ${reason}`);
   if (row.status === 'hybrid_unsupported') warnings.push(`${location} · ${text('Hybrid')}`);
  }
  for (const error of preview.errors) if (!preview.rows.some(row => row.error && row.key === error)) errors.push(error);
  for (const [suffix, title, messages] of [
   ['-errors', 'Errors', errors], ['', 'Issues', warnings], ['-notes', 'NoteInformation', information],
  ] as const) {
   if (!messages.length) continue;
   const details = this.details(section, `${key}${suffix}`, text(title, { count: String(messages.length) }));
   for (const message of messages) details.createEl('p', { text: message });
  }
 }
 private renderOutcomeDetails(section: HTMLElement): void {
  const result = this.controller.result;
  if (!result?.message) return;
  const failed = ['not-applied', 'recovery-required', 'cleanup-pending'].includes(result.status);
  section.createEl('p', { text: text(failed ? 'ErrorDetails' : 'Details', { reason: result.message }),
   ...(failed ? { attr: { role: 'alert' } } : {}) });
 }

 private renderResult(): void {
  const c = this.controller, result = c.result!;
  const section = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-section', attr: { role: 'status', 'aria-live': 'polite' } });
  section.createEl('p').createEl('strong', { text: text(result.sourcesCommitted || result.status === 'committed' || result.status === 'kept' ? 'Success' : result.status === 'rolled-back' || result.status === 'restored' ? 'RolledBack' : result.status === 'cancelled' ? 'Cancelled' : 'Stopped') });
  this.renderCounts(section);
  this.renderMessages(section, 'result-issues');
  this.renderOutcomeDetails(section);
  if (c.settlementPending.length) this.button(section, 'RetryRefresh', () => c.retrySettlement());
  if (result.sourceConflicts?.length) this.button(section, 'ReviewUnchanged', () => c.reviewUnchangedSources(), c.blocked);
  if (!c.inspection) this.button(section, 'RetryInspect', () => c.initialize());
 }
 private renderCounts(parent: HTMLElement): void {
  const counts = this.controller.counts;
  if (!counts.available) return;
  parent.createEl('p', { text: text('Counts', { selected: String(counts.selected), converted: String(counts.converted), unknown: String(counts.unknown) }) });
 }
 private renderRecovery(): void {
  const c = this.controller, inspection = c.inspection!;
  const section = this.contentEl.createDiv({ cls: 'operon-tasks-conversion-section' });
  section.createEl('p', { text: text(c.result?.sourcesCommitted ? 'Success' : 'Recovery'), attr: { role: 'status' } });
  this.renderCounts(section);
  this.renderOutcomeDetails(section);
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
