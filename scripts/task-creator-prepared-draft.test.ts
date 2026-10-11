import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreparedTaskCreatorDraft, type PreparedTaskCreatorAdapter } from '../src/ui/task-creator-prepared-draft';
import { DEFAULT_SETTINGS, migrateSettings } from '../src/types/settings';
import { createEmptyTaskCreatorDraft } from '../src/ui/task-creator-modal';
import { applyTaskFieldPatchToState } from '../src/core/task-field-patch';
import type { FileTaskTemplateOption } from '../src/core/file-task-templates';
const option = (id='A'): FileTaskTemplateOption => ({id,name:id,path:id,kind:'folder'});
const yaml = (body:string) => `---\n${body}\n---\nBody`;
for (const empty of ['null', '""']) test(`empty template parent ${empty} does not turn preview into routing`, async () => {
 const f = fixture(yaml(`parentTask: ${empty}`), {
  parent: id => ({ fields: { contexts: id }, tags: [], nativeValues: new Map() }),
 });
 await f.ui.select(option(), 'Task');
 f.ui.setPreviewParent('drawing');
 const request = f.ui.submission('inline', 'Task', createEmptyTaskCreatorDraft().inlineCompletionMode);
 assert.equal(f.ui.field('parentTask').value, 'drawing');
 assert.ok(request.routingSnapshot);
 assert.notEqual(request.routingSnapshot.fields.find(field => field.property.canonicalKey === 'parentTask')?.value, 'drawing');
 f.ui.backgroundParent('actual', null, null);
 assert.equal(f.ui.field('parentTask').value, 'actual');
});
test('implicit parent preview stays typed without becoming an explicit routing choice', async () => {
 const f = fixture(yaml('contexts: [template]\npriority: Medium'), {
  parent: id => ({ fields: { contexts: id, priority: 'High' }, tags: [id], nativeValues: new Map() }),
 });
 await f.ui.select(option(), 'Task');
 f.ui.setPreviewParent('drawing');
 assert.equal(f.ui.field('parentTask').value, 'drawing');
 assert.deepEqual(f.ui.field('contexts').value, ['drawing', 'template']);
 const request = f.ui.submission('inline', 'Task', createEmptyTaskCreatorDraft().inlineCompletionMode);
 assert.equal(request.snapshot.fields.find(field => field.property.canonicalKey === 'parentTask')?.value, 'drawing');
 assert.equal(request.routingSnapshot?.fields.find(field => field.property.canonicalKey === 'parentTask')?.state, 'missing');
 assert.deepEqual(request.routingSnapshot?.fields.find(field => field.property.canonicalKey === 'contexts')?.value, ['template']);
 f.ui.backgroundParent('actual', null, null);
 assert.equal(f.ui.field('parentTask').value, 'actual');
 assert.deepEqual(f.ui.field('contexts').value, ['actual', 'template']);
 assert.equal(f.ui.submission('inline', 'Task', createEmptyTaskCreatorDraft().inlineCompletionMode).routingSnapshot, undefined);
});
test('clearing a destination preview removes only preview inheritance and retains user changes', async () => {
 const f = fixture(yaml('contexts: [template]'), {
  parent: id => ({ fields: { contexts: id }, tags: [id], nativeValues: new Map() }),
 });
 await f.ui.select(option(), 'Task');
 f.ui.setPreviewParent('drawing');
 f.ui.applyPayload({ priority: 'High' });
 f.ui.backgroundParent('', null, null);
 assert.equal(f.ui.field('parentTask').state, 'missing');
 assert.deepEqual(f.ui.field('contexts').value, ['template']);
 assert.equal(f.ui.field('priority').value, 'High');
 f.ui.setPreviewParent('drawing');
 f.ui.setPreviewParent(null);
 assert.equal(f.ui.field('parentTask').state, 'missing');
 assert.deepEqual(f.ui.field('contexts').value, ['template']);
});
test('explicit parent selection or removal wins over drawing preview and target inheritance', () => {
 for (const selected of ['manual', 'drawing', '']) {
  const f = fixture('', { parent: id => ({ fields: { contexts: id }, tags: [], nativeValues: new Map() }) });
  f.ui.setPreviewParent('drawing');
  f.ui.applyPayload({ parentTask: selected });
  f.ui.setPreviewParent('other-preview');
  f.ui.backgroundParent('actual', null, null);
  assert.equal(f.ui.field('parentTask').value, selected);
  assert.equal(f.ui.submission('inline', 'Task', createEmptyTaskCreatorDraft().inlineCompletionMode).routingSnapshot, undefined);
 }
});
function fixture(content:string, overrides:Partial<PreparedTaskCreatorAdapter>={}) {
 let reads=0;
 const adapter:PreparedTaskCreatorAdapter={properties:{keyMappings:DEFAULT_SETTINGS.keyMappings,propertyTypes:{Client:'text',Values:'multitext',Count:'number',Checked:'checkbox',Day:'date',Time:'datetime'}},readTemplate:async()=>{reads++;return content;},clock:()=>({now:'2026-10-10T12:34:56'}),parent:()=>null,candidates:()=>[],onSubmit:()=>true,...overrides};
 const settings=structuredClone(DEFAULT_SETTINGS);settings.childTaskInheritanceFields.push('contexts','tags');const ui=new PreparedTaskCreatorDraft(adapter,settings);return {ui,adapter,reads:()=>reads};
}
for(const [key,source,value] of [['Client','hello','hello'],['Client','',null],['Count','0',0],['Checked','false',false],['Day','2026-10-10','2026-10-10'],['Time','2026-10-10T12:34:56','2026-10-10T12:34:56'],['Values','[3,"3",Ali,Ali]',[3,'3','Ali','Ali']],['Values','[]',[]],['Values','[""]',['']]] as const) test(`prepared Creator retains ${key} ${source}`,async()=>{
 const f=fixture(yaml(`${key}: ${source}`));await f.ui.select(option(),'Task');assert.deepEqual(f.ui.field(key).value,value);const legacy=createEmptyTaskCreatorDraft();f.ui.syncLegacy(legacy);assert.equal(key in legacy.fieldValues,false);assert.ok(f.ui.visibleKeys('inline').includes(key));
 const request=f.ui.submission('inline','Task',legacy.inlineCompletionMode);assert.deepEqual(request.snapshot.fields.find(f=>f.property.sourceName===key)?.value,value);
});
test('sources remain independent, tag/context removals and explicit empties survive replacement',async()=>{
 const f=fixture(yaml('contexts: [d,e]\npriority: Low'),{seeds:{surface:[{sourceName:'priority',value:'High'}],user:[{sourceName:'contexts',value:['a']}]}});
 // Incremental UI user additions, not an authoritative whole-field initial replacement.
 let parentContexts='a; b';const g=fixture(yaml('contexts: [d,e]'),{parent:()=>({fields:{contexts:parentContexts},tags:[],nativeValues:new Map()})});g.ui.applyPayload({parentTask:'P'});g.ui.draft.appendMember('contexts','a');await g.ui.select(option(),'Task');assert.deepEqual(g.ui.field('contexts').value,['a','b','d','e']);g.ui.applyPayload({contexts:['a','d','e']});parentContexts='a; b; c';g.ui.refreshParent();assert.deepEqual(g.ui.field('contexts').value,['a','c','d','e']);
 await f.ui.select(option(),'Task');assert.equal(f.ui.field('priority').value,'High');f.ui.applyPayload({priority:''});await f.ui.select(option('B'),'Task');assert.equal(f.ui.field('priority').value,'');
});
test('template inputs exclude template output even when default also exists',async()=>{
 const f=fixture(yaml('note: "{{note}} / suffix"'),{seeds:{defaults:[{sourceName:'note',value:'base'}]}});await f.ui.select(option(),'Task');assert.equal(f.ui.field('note').value,'base / suffix');f.ui.updateInputs('new title');assert.equal(f.ui.field('note').value,'base / suffix');assert.equal(f.reads(),1);
});
test('frozen clock, user field and member changes survive input recalculation and template replacement',async()=>{
 const f=fixture(yaml('Day: "{{date}}"\nClient: "{{taskDescription}}"\nValues: ["{{taskDescription}}", Ali, Ali]'));await f.ui.select(option(),'first');const members=f.ui.field('Values').members;f.ui.draft.editMember('Values',members[1].id,'Changed');f.ui.draft.removeMember('Values',members[2].id);f.ui.draft.setValue('Client','manual');f.ui.updateInputs('second');assert.deepEqual(f.ui.field('Values').value,['second','Changed']);assert.equal(f.ui.field('Client').value,'manual');assert.equal(f.ui.field('Day').value,'2026-10-10');assert.equal(f.reads(),1);await f.ui.select(option('B'),'third');assert.ok((f.ui.field('Values').value as string[]).includes('Changed'));
});
test('native icons reorder with current template; empty/removal and aliases differ',async()=>{
 const f=fixture('',{readTemplate:async path=>yaml(path==='A'?'Client: first\nCount: 0':'Count: 0\nClient: second')});await f.ui.select(option(),'Task');assert.deepEqual(f.ui.visibleKeys('inline').slice(-2),['Client','Count']);await f.ui.select(option('B'),'Task');assert.deepEqual(f.ui.visibleKeys('inline').slice(-2),['Count','Client']);f.ui.draft.clearValue('Client');assert.ok(f.ui.visibleKeys('inline').includes('Client'));f.ui.draft.removeField('Client');assert.ok(!f.ui.visibleKeys('inline').includes('Client'));
});
test('Automatic and conflicting values stay readonly, skipped/deferred values are not usable inline',async()=>{
 const f=fixture(yaml('Unknown: text\nCount: wrong\nNested: {a: 1}\nDynamic: "<% tp.date.now() %>"\nId: "{{operonId}}"'));await f.ui.select(option(),'Task');assert.equal(f.ui.field('Unknown').readOnlyReason,'automatic');assert.equal(f.ui.field('Count').readOnlyReason,'type-conflict');assert.throws(()=>f.ui.draft.setValue('Unknown','edit'));for(const key of ['Nested','Dynamic','Id'])assert.ok(!f.ui.fields('inline').some(field=>field.property.sourceName===key));
});
test('loading/error/clear/close gate submit and ignore late results without writes',async()=>{
 let resolve!:(value:string)=>void;const f=fixture('',{readTemplate:()=>new Promise(r=>resolve=r)});const loading=f.ui.select(option(),'Task');assert.equal(f.ui.canSubmit('inline'),false);assert.throws(()=>f.ui.submission('inline','Task',createEmptyTaskCreatorDraft().inlineCompletionMode));await f.ui.select(null,'Task');resolve(yaml('Client: late'));await loading;assert.equal(f.ui.field('Client').state,'missing');assert.equal(f.ui.canSubmit('inline'),true);assert.equal(f.ui.canSubmit('file'),false);f.ui.close();assert.equal(f.ui.canSubmit('inline'),false);
 const broken=fixture('---\nClient: [broken\n---');await broken.ui.select(option(),'Task');assert.equal(broken.ui.session.snapshot().status,'error');assert.equal(broken.ui.canSubmit('inline'),false);
});
test('submit is isolated from future edits and File/Inline retain selection',async()=>{
 const f=fixture(yaml('Client: initial'));await f.ui.select(option(),'Task');const mode=createEmptyTaskCreatorDraft().inlineCompletionMode;const a=f.ui.submission('inline','Task',mode);const b=f.ui.submission('file','Task',mode);assert.deepEqual(a.snapshot,b.snapshot);assert.deepEqual(a.template,b.template);f.ui.draft.setValue('Client','later');assert.equal(a.snapshot.fields.find(f=>f.property.sourceName==='Client')?.value,'initial');
});
test('preview recurrence applies rules without generating a repeat identity',()=>{
 const result=applyTaskFieldPatchToState({currentFields:{},currentTags:[],payload:{repeat:'every day'},deferRepeatIdentity:true});assert.equal(result.fieldValues.repeatSeriesId,undefined);
});
test('initial user contexts merge with parent/template instead of masking them',async()=>{
 const f=fixture(yaml('contexts: [d,e]'),{seeds:{surface:[{sourceName:'parentTask',value:'P'}],user:[{sourceName:'contexts',value:['a']}]},parent:()=>({fields:{contexts:'a; b'},tags:[],nativeValues:new Map()})});await f.ui.select(option(),'Task');assert.deepEqual(f.ui.field('contexts').value,['a','b','d','e']);
});
test('removing and clearing the parent retires its contributions',()=>{
 const f=fixture('',{parent:()=>({fields:{priority:'High',contexts:'b'},tags:['parent'],nativeValues:new Map()})});f.ui.applyPayload({parentTask:'parent'});assert.ok(f.ui.draft.snapshot().fields.some(field=>field.contributions.some(c=>c.source==='parent')));f.ui.remove('parentTask',false);assert.ok(!f.ui.draft.snapshot().fields.some(field=>field.contributions.some(c=>c.source==='parent')));assert.equal(f.ui.field('parentTask').state,'removed');
});
test('template parent replacement reconciles immediately without parent self-lock',async()=>{
 const f=fixture('',{readTemplate:async id=>yaml(`parentTask: ${id}`),parent:id=>({fields:{priority:id==='A'?'High':'Low'},tags:[],nativeValues:new Map()})});await f.ui.select(option(),'Task');assert.equal(f.ui.field('parentTask').value,'A');assert.equal(f.ui.field('priority').value,'High');await f.ui.select(option('B'),'Task');assert.equal(f.ui.field('parentTask').value,'B');assert.equal(f.ui.field('priority').value,'Low');await f.ui.select(null,'Task');assert.equal(f.ui.field('priority').state,'missing');
});
test('repeat preview cleanup retains companion-field rules while deferring identities',()=>{
 const result=applyTaskFieldPatchToState({currentFields:{repeat:'every day',datetimeRepeatEnd:'2026-10-10T12:00:00'},currentTags:[],payload:{repeat:''},deferRepeatIdentity:true});assert.equal(result.fieldValues.datetimeRepeatEnd,undefined);assert.equal(result.fieldValues.repeatSeriesId,undefined);
});
test('background parent seed participates in common model and respects explicit removal',()=>{
 const f=fixture('');f.ui.backgroundParent('P',{priority:'High'},[]);assert.equal(f.ui.field('parentTask').value,'P');assert.equal(f.ui.field('priority').value,'High');f.ui.updateInputs('Changed');assert.equal(f.ui.field('priority').value,'High');f.ui.remove('parentTask',false);f.ui.backgroundParent('Other',{priority:'Low'},[]);assert.equal(f.ui.field('parentTask').state,'removed');assert.equal(f.ui.field('priority').state,'missing');
});
test('eligible native parent values use typed ready-index data even without a managed string value',async()=>{
 const mapping={canonicalKey:'scores',visiblePropertyName:'Scores',yamlKey:'Scores',type:'list' as const,isSystem:false,sync:'yes' as const,enabled:true,aliases:[],icon:'list'};
 const settings=structuredClone(DEFAULT_SETTINGS);settings.keyMappings.push(mapping);settings.childTaskInheritanceFields=['scores'];
 const f=fixture('',{properties:{keyMappings:settings.keyMappings,propertyTypes:{Scores:'multitext'}},parent:()=>({fields:{},tags:[],nativeValues:new Map([['scores',[3,'3','Ali','Ali']]])})});
 const ui=new PreparedTaskCreatorDraft(f.adapter,settings);ui.applyPayload({parentTask:'P'});assert.deepEqual(ui.field('scores').value,[3,'3','Ali','Ali']);
});

test('review: stale set picker preserves unseen parent values and applies only its own removals',()=>{
 let contexts='a';const f=fixture('',{seeds:{surface:[{sourceName:'parentTask',value:'P'}]},parent:()=>({fields:{contexts},tags:[],nativeValues:new Map()})});
 const baseline=f.ui.field('contexts');contexts='a; b';f.ui.refreshParent();
 f.ui.applyPayload({contexts:['a','c']},baseline);assert.deepEqual(f.ui.field('contexts').value,['c','a','b']);
 f.ui.refreshParent();assert.deepEqual(f.ui.field('contexts').value,['c','a','b']);
 f.ui.applyPayload({contexts:[]},baseline);assert.deepEqual(f.ui.field('contexts').value,['c','b']);
 f.ui.draft.clearValue('contexts');f.ui.refreshParent();assert.deepEqual(f.ui.field('contexts').value,[]);
});

test('inline default settings preserve unavailable IDs, roundtrip in schema 2/3, and default to None', async()=>{
 const {buildOperonDataPackageFromSettings,composeOperonSettingsFromDataPackage}=await import('../src/storage/operon-data-package');
 const {ALL_OPERON_SETTINGS_BACKUP_KEYS,SETTINGS_BACKUP_COMPATIBILITY_BY_KEY}=await import('../src/core/settings-backup-compatibility');
 assert.equal(migrateSettings({}).defaultInlineTaskTemplateId,null);
 assert.equal(migrateSettings({defaultInlineTaskTemplateId:'  '}).defaultInlineTaskTemplateId,null);
 const id='builtin-minimal-file-task-template:unavailable';
 const settings=migrateSettings({...DEFAULT_SETTINGS,defaultInlineTaskTemplateId:id});assert.equal(settings.defaultInlineTaskTemplateId,id);
 const pkg=buildOperonDataPackageFromSettings(settings);assert.equal(pkg.ui.taskCreationProfile.defaultInlineTaskTemplateId,id);
 for(const schemaVersion of [2,3] as const){const loaded=composeOperonSettingsFromDataPackage({...pkg,schemaVersion},DEFAULT_SETTINGS);assert.equal(loaded.defaultInlineTaskTemplateId,id);}
 assert.ok(ALL_OPERON_SETTINGS_BACKUP_KEYS.includes('defaultInlineTaskTemplateId'));
 assert.ok(SETTINGS_BACKUP_COMPATIBILITY_BY_KEY.defaultInlineTaskTemplateId);
});
test('unavailable template invalidates old read and preserves user fields',async()=>{
 let finish!:(text:string)=>void;const f=fixture('',{readTemplate:()=>new Promise(r=>finish=r)});
 f.ui.draft.setValue('Client','manual');const pending=f.ui.select(option(),'Task');f.ui.session.selectUnavailable('missing');finish(yaml('Count: 3'));await pending;
 assert.equal(f.ui.session.snapshot().status,'error');assert.equal(f.ui.canSubmit('inline'),false);assert.equal(f.ui.field('Client').value,'manual');assert.equal(f.ui.field('Count').state,'missing');
 await f.ui.select(null,'Task');assert.equal(f.ui.canSubmit('inline'),true);
});
