import { serializeTaskListValue } from '../core/subtask-inheritance';
import { TaskCreationDraft, type CreationDraftFieldSnapshot, type CreationDraftSnapshot } from '../core/task-creation-draft';
import { CreationDraftProperties, creationDraftParentFields, type CreationDraftFieldInput, type CreationDraftPropertyContext } from '../core/task-creation-draft-properties';
import { CreationTemplateSession, type CreationTemplateSessionSnapshot } from '../core/task-creation-template-session';
import type { CreationTemplateClock, CreationTemplateInputs } from '../core/task-creation-template';
import type { FileTaskTemplateOption } from '../core/file-task-templates';
import type { VaultPropertyValue } from '../core/vault-property-codec';
import type { OperonSettings } from '../types/settings';
import type { TaskCreatorDraft, TaskCreatorCreateType } from './task-creator-modal';

/** Internal, opt-in boundary. No normal entry point supplies this until writers consume the snapshot. */
export interface PreparedTaskCreatorAdapter {
 properties: CreationDraftPropertyContext;
 seeds?: { surface?: readonly CreationDraftFieldInput[]; defaults?: readonly CreationDraftFieldInput[]; user?: readonly CreationDraftFieldInput[] };
 readTemplate: (path: string) => Promise<string>;
 clock: () => CreationTemplateClock;
 /** Synchronous projection of the ready shared index; must not read sources. */
 parent: (id: string) => { fields: Record<string, string> | null; tags: readonly string[] | null; nativeValues: ReadonlyMap<string, VaultPropertyValue> } | null;
 candidates: (sourceName: string) => readonly string[];
 onSubmit: (request: PreparedTaskCreatorSubmission) => boolean | PreparedCreatorResult | Promise<boolean | PreparedCreatorResult>;
}
export interface PreparedCreatorResult { outcome: 'committed' | 'preview' | 'failed' | 'uncertain'; message?: string }
export interface PreparedTaskCreatorSubmission {
 createType: TaskCreatorCreateType;
 description: string;
 inlineCompletionMode: TaskCreatorDraft['inlineCompletionMode'];
 snapshot: CreationDraftSnapshot;
 /** Implicit drawing preview must not become an explicit destination choice. */
 routingSnapshot?: CreationDraftSnapshot;
 template: CreationTemplateSessionSnapshot;
 templateOption?: FileTaskTemplateOption | null;
}

/** UI adapter only: resolution and merging belong exclusively to Stage 1/2. */
export class PreparedTaskCreatorDraft {
 readonly draft: TaskCreationDraft;
 readonly session: CreationTemplateSession;
 readonly hasUserChanges: () => boolean;
 private readonly catalog: CreationDraftProperties;
 private closed = false;
 private parentReady = true;
 private backgroundParentId = '';
 private previewParentId = '';
 private readonly backgroundParents = new Map<string, { fields: Record<string,string> | null; tags: readonly string[] | null }>();
 constructor(readonly adapter: PreparedTaskCreatorAdapter, private readonly settings: OperonSettings) {
  this.catalog = new CreationDraftProperties(adapter.properties);
  this.draft = new TaskCreationDraft(adapter.properties);
  this.session = new CreationTemplateSession(this.draft, adapter.properties, settings.pipelines, adapter.readTemplate);
  this.draft.replaceSource('default', 'defaults', adapter.seeds?.defaults ?? []);
  this.draft.replaceSource('surface', 'surface', adapter.seeds?.surface ?? []);
  for (const field of adapter.seeds?.user ?? []) {
   const property = this.catalog.resolve(field.sourceName);
   const read = this.catalog.read(property, field.value);
   if (read.value === undefined || read.readOnlyReason) throw new Error('Invalid Creator user seed');
   if (property.merge === 'set' && Array.isArray(read.value) && read.value.length) {
    for (const value of read.value) this.draft.appendMember(field.sourceName, value);
   } else this.draft.setValue(field.sourceName, read.value);
  }
  this.refreshParent();
  this.hasUserChanges = this.draft.createUserChangeCheck();
 }
 field(key: string): CreationDraftFieldSnapshot { return this.draft.getField(key); }
 key(field: CreationDraftFieldSnapshot): string { return field.property.canonicalKey ?? field.property.sourceName; }
 fields(mode: TaskCreatorCreateType): CreationDraftFieldSnapshot[] {
  const template = this.session.snapshot();
  const skipped = new Set(template.status === 'ready' ? template.diagnostics.filter(item => item.inline === 'skip' || item.inline === 'deferred').map(item => this.catalog.resolve(item.sourceName).id) : []);
  const fields = this.draft.snapshot().fields.filter(field => field.state !== 'missing' && field.state !== 'removed');
  return mode === 'file' ? fields : fields.filter(field => !skipped.has(field.property.id) || field.userModified || field.contributions.some(item => item.source !== 'template'));
 }
 visibleKeys(mode: TaskCreatorCreateType): string[] {
  const fields = this.fields(mode);
  const present = new Set(fields.map(field => this.key(field)));
  const keys = (this.settings.taskCreatorToolbar ?? []).filter(item => item.visible || present.has(item.key)).map(item => item.key);
  for (const mapping of this.settings.keyMappings) if (present.has(mapping.canonicalKey) && !keys.includes(mapping.canonicalKey)) keys.push(mapping.canonicalKey);
  // Resolve ordering from the current contribution, not the draft's historical property insertion order.
  const template = this.session.snapshot();
  const native = fields.filter(field => !field.property.canonicalKey);
  const order = template.status === 'ready' ? template.fields.map(field => this.catalog.resolve(field.sourceName).id) : [];
  native.sort((a,b) => (order.indexOf(a.property.id) < 0 ? Infinity : order.indexOf(a.property.id)) - (order.indexOf(b.property.id) < 0 ? Infinity : order.indexOf(b.property.id)));
  return [...new Set([...keys, ...native.map(field => this.key(field))])];
 }
 /** Only managed values are mirrored for existing dedicated pickers. Native data remains typed. */
 syncLegacy(target: TaskCreatorDraft, snapshot: CreationDraftSnapshot = this.draft.snapshot()): void {
  const fields: Record<string,string> = {};
  target.tags = []; target.subtaskIds = []; target.note = '';
  for (const field of snapshot.fields) {
   const key = field.property.canonicalKey;
   if (!key || field.state === 'missing' || field.state === 'removed' || field.value === undefined || field.property.interpretation === 'native') continue;
   const value = field.value;
   if (key === 'tags') target.tags = Array.isArray(value) ? value.map(String) : [];
   else if (key === 'subtasks') target.subtaskIds = Array.isArray(value) ? value.map(String) : [];
   else if (key === 'note') target.note = typeof value === 'string' ? value : '';
   else fields[key] = Array.isArray(value) ? serializeTaskListValue(value.map(String)) : value === null ? '' : String(value);
  }
  target.fieldValues = fields;
  target.taskIcon = fields.taskIcon ?? ''; target.taskColor = fields.taskColor ?? '';
 }
 applyPayload(payload: Record<string,string | string[]>, baseline?: CreationDraftFieldSnapshot): void {
  if (this.closed) return;
  if (Object.prototype.hasOwnProperty.call(payload, 'repeat')) { this.draft.setRepeatValues(payload); return; }
  for (const [name, value] of Object.entries(payload)) {
   const property = this.catalog.resolve(name);
   const read = this.catalog.read(property, value);
   if (read.readOnlyReason || read.value === undefined) throw new Error('Invalid Creator picker value');
   if (property.merge === 'set' && Array.isArray(read.value)) {
    const previous = baseline?.property.id === property.id ? baseline.members : this.field(name).members;
    const current = this.field(name).members;
    for (const member of previous) if (!read.value.includes(member.value) && current.some(item => item.id === member.id)) this.draft.removeMember(name, member.id);
    for (const item of read.value) if (!previous.some(member => member.value === item)) this.draft.appendMember(name, item);
    if (!read.value.length && (!baseline || current.every(member => previous.some(item => item.id === member.id)))) this.draft.clearValue(name);
   } else this.draft.setValue(name, read.value);
  }
  if ('parentTask' in payload) this.refreshParent();
 }
 backgroundParent(id: string, fields: Record<string,string> | null, tags: readonly string[] | null): void {
  if (this.closed) return;
  this.backgroundParents.set(id, structuredClone({ fields, tags }));
  const selected = this.field('parentTask');
  if (selected.state !== 'missing' && !this.hasPreviewParent()) return;
  this.previewParentId = '';
  this.backgroundParentId = id;
  this.refreshParent();
 }
 setPreviewParent(id: string | null): void {
  if (this.closed) return;
  this.previewParentId = id ?? '';
  this.refreshParent();
 }
 private hasPreviewParent(): boolean {
  const selected = this.field('parentTask');
  return !!this.previewParentId && !this.backgroundParentId && !selected.userModified
   && selected.value === this.previewParentId && !selected.contributions.some(item =>
    item.source !== 'parent' && typeof item.value === 'string' && item.value.trim());
 }
 routingSnapshot(): CreationDraftSnapshot {
  return this.draft.snapshot(this.hasPreviewParent() ? 'parent' : undefined);
 }
 remove(key: string, clear: boolean): void {
  if (clear) this.draft.clearValue(key); else this.draft.removeField(key);
  if (key === 'parentTask') this.refreshParent();
 }
 refreshParent(): void {
  const selected = this.field('parentTask');
  const id = selected.userModified ? selected.value : selected.contributions.find(item => item.source !== 'parent' && typeof item.value === 'string' && item.value.trim())?.value ?? (this.backgroundParentId || this.previewParentId);
  const ready = typeof id === 'string' && id ? this.adapter.parent(id) : null;
  this.parentReady = !id || !!ready || (typeof id === 'string' && this.backgroundParents.has(id));
  const parent = ready ?? (typeof id === 'string' ? this.backgroundParents.get(id) : null);
  this.draft.replaceSource('parent', typeof id === 'string' ? id : '', creationDraftParentFields(typeof id === 'string' ? id : null, parent?.fields ?? null, parent?.tags ?? null, this.settings, ready?.nativeValues));
 }
 inputs(description: string): CreationTemplateInputs {
  const text = (key: string): string => {
   const field = this.field(key);
   // Template output must never feed its own placeholders on the next keystroke.
   const sources = field.contributions.filter(item => item.source !== 'template');
   const value = field.userModified ? field.value : (sources.find(item => item.value !== null && item.value !== '' && item.value !== undefined) ?? sources[0])?.value;
   return typeof value === 'string' ? value : '';
  };
  return { title: description, taskDescription: description, note: text('note'), dateStarted: text('dateStarted'), dateScheduled: text('dateScheduled'), dateDue: text('dateDue'), status: text('status'), priority: text('priority') };
 }
 updateInputs(description: string): void { if (!this.closed) { this.session.updateInputs(this.inputs(description)); this.refreshParent(); } }
 async select(option: FileTaskTemplateOption | null, description: string): Promise<void> {
  if (!this.closed) { await this.session.select(option, this.adapter.clock(), this.inputs(description)); if (!this.closed) this.refreshParent(); }
 }
 canSubmit(mode: TaskCreatorCreateType): boolean {
  const state = this.session.snapshot().status;
  return !this.closed && this.parentReady && state !== 'loading' && state !== 'error' && (mode === 'inline' || state === 'ready');
 }
 submission(mode: TaskCreatorCreateType, description: string, inlineCompletionMode: TaskCreatorDraft['inlineCompletionMode']): PreparedTaskCreatorSubmission {
  if (!this.canSubmit(mode)) throw new Error('Template is not ready');
  return structuredClone({ createType: mode, description, inlineCompletionMode, snapshot: this.draft.snapshot(), ...(this.hasPreviewParent() ? { routingSnapshot: this.routingSnapshot() } : {}), template: this.session.snapshot(), templateOption: this.session.selectedOption() });
 }
 close(): void { this.closed = true; this.session.cancel(); }
}
