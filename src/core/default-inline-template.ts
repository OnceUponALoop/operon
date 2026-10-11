import { TaskCreationDraft } from './task-creation-draft';
import { CreationDraftProperties, type CreationDraftFieldInput, type CreationDraftPropertyContext } from './task-creation-draft-properties';
import { prepareCreationTemplate, type PreparedCreationTemplate } from './task-creation-template';
import { prepareCreationCommit, type PreparedCreationContent } from './task-creation-commit';
import { readParsedInlinePropertyProjection } from './inline-property-source';
import { parseTaskLine } from './parser';
import { serializeTask } from './serializer';
import type { ParsedTask } from '../types/fields';
import type { NormalizeTaskFieldPatchOptions } from './task-field-patch';

/** Plugin authoring only. Callers load a template once per operation and retain source guards. */
export function prepareDefaultInlineTemplateTask(input: {
 template: PreparedCreationTemplate;
 properties: CreationDraftPropertyContext;
 task: ParsedTask;
 source: ParsedTask | null;
 parent: readonly CreationDraftFieldInput[];
 surface?: readonly CreationDraftFieldInput[];
 defaults?: readonly CreationDraftFieldInput[];
 explicit?: readonly string[];
 now: string;
 repeat?: NormalizeTaskFieldPatchOptions;
}): PreparedCreationContent {
 const { task, properties } = input;
 const operonId=task.operonId ?? task.fields.find(field=>field.key==='operonId')?.value;
 if (!operonId) throw new Error('New task identity missing');
 const catalog = new CreationDraftProperties(properties), draft = new TaskCreationDraft(properties);
 const sourceFields = input.source?.fields ?? [];
 const seen=new Set<string>();
 for(const field of sourceFields) {
  const id=catalog.resolve(field.sourceKey || field.key).id;
  if(seen.has(id)) throw new Error('Duplicate source property');
  seen.add(id);
 }
 const explicit = new Set([...sourceFields.map(field => field.key), ...input.explicit ?? []]);
 const inheritedIds=new Set(input.parent.map(field=>catalog.resolve(field.sourceName).id));
 const fields:CreationDraftFieldInput[] = task.fields.filter(field=>!inheritedIds.has(catalog.resolve(field.sourceKey||field.key).id)).map(field => ({sourceName:field.sourceKey || field.key,value:field.value}));
 for(const field of input.defaults??[]) if(!fields.some(item=>catalog.resolve(item.sourceName).id===catalog.resolve(field.sourceName).id)) fields.push(field);
 // Existing workflow normalization supplies fallback values, never higher-priority template overrides.
 draft.replaceSource('default','defaults',fields.filter(field => !explicit.has(catalog.resolve(field.sourceName).canonicalKey ?? field.sourceName)));
 draft.replaceSource('parent','parent',input.parent);
 draft.replaceSource('surface','surface',input.surface ?? []);
 const retained = sourceFields.filter(field => {
  const property=catalog.resolve(field.sourceKey || field.key);
  return property.interpretation==='native' && !!property.readOnlyReason && property.readOnlyReason!=='type-conflict' && property.readOnlyReason!=='unavailable';
 });
 for (const key of explicit) {
  if(key==='tags') continue;
  const original = sourceFields.find(field=>field.key===key);
  const field = input.explicit?.includes(key) ? task.fields.find(field=>field.key===key) : original;
  if (!field) { draft.removeField(key); continue; }
  if (retained.includes(field)) continue;
  const property=catalog.resolve(field.sourceKey || field.key);
  if (property.merge==='system') continue;
  const raw = property.interpretation==='native' && property.type
   ? readParsedInlinePropertyProjection({...task,fields:[field]}, {[property.sourceName]:property.type}, [...properties.keyMappings],properties.inlineDefinitions).properties[0]?.value
   : field.value;
  const read=catalog.read(property,raw);
  if (read.value===undefined || read.readOnlyReason) throw new Error('Source property cannot be verified');
  if(property.merge==='set' && input.explicit?.includes(key) && Array.isArray(read.value) && original) {
   const prior=catalog.read(property,original.value).value;
   if(Array.isArray(prior)) for(const value of prior)draft.appendMember(property.sourceName,value);
   for(const member of draft.getField(property.sourceName).members)if(!read.value.includes(member.value))draft.removeMember(property.sourceName,member.id);
  }
  if (Array.isArray(read.value) && read.value.length && (property.merge==='set' || property.merge==='sequence')) {
   for (const value of read.value) draft.appendMember(property.sourceName,value);
  } else draft.setValue(property.sourceName,read.value);
 }
 const explicitTags=input.explicit?.includes('tags');
 const tags=explicitTags?task.tags:input.source?.tags ?? [];
 if(explicitTags) {
  for(const tag of input.source?.tags??[])draft.appendMember('tags',tag);
  for(const member of draft.getField('tags').members)if(!tags.includes(String(member.value)))draft.removeMember('tags',member.id);
  if(!tags.length)draft.clearValue('tags');
 }
 for (const tag of tags) draft.appendMember('tags',tag);
 if (!explicitTags && !tags.length && task.tags.length) draft.replaceSource('default','defaults',[...fields.filter(field=>!explicit.has(catalog.resolve(field.sourceName).canonicalKey ?? field.sourceName)),{sourceName:'tags',value:task.tags}]);
 const text=(key:string):string=> {const value=draft.getField(key).value;return typeof value==='string'?value:'';};
 const template=prepareCreationTemplate({content:input.template.rawContent,sourceId:input.template.sourceId,revision:input.template.revision,
  clock:input.template.clock,properties,inputs:{title:task.description,taskDescription:task.description,note:text('note'),status:text('status'),priority:text('priority'),dateStarted:text('dateStarted'),dateScheduled:text('dateScheduled'),dateDue:text('dateDue')}});
 if (template.status!=='ready') throw new Error('Template is invalid');
 draft.replaceSource('template',template.sourceId,template.fields);
 const output=prepareCreationCommit({createType:'inline',description:task.description,snapshot:draft.snapshot(),template},properties,
  {operonId,now:input.now,checkbox:task.checkbox},input.repeat);
 const parsed=parseTaskLine(output.inlineLine,task.lineNumber,task.filePath,[...properties.keyMappings]);
 if(!parsed) throw new Error('Prepared task could not be parsed');
 parsed.rawLine=task.rawLine;parsed.checkboxRange=task.checkboxRange;parsed.timePrefix=task.timePrefix;
 parsed.fields.push(...retained);
 output.inlineLine=serializeTask(parsed,[...properties.keyMappings]);
 return output;
}
