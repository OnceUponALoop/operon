import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { App } from 'obsidian';
import { TFile, TFolder, calendarControls } from './test-support/external-calendar-obsidian';
import { ExternalCalendarService } from '../src/systems/external-calendar-service';
import { ExternalCalendarCacheStore } from '../src/storage/external-calendar-cache';
import { ExternalCalendarSource, DEFAULT_SETTINGS, migrateSettings } from '../src/types/settings';
import { localToday } from '../src/core/local-time';
import { externalCalendarSourceIdentity, isVaultCalendarPath } from '../src/core/external-calendar-source';
import { parseExternalCalendarIcsEvents } from '../src/systems/external-calendar-ics';
import { buildExternalCalendarItems } from '../src/systems/external-calendar-query';
import { ExternalCalendarSourceEditModal, canSyncExternalCalendarSourceNow } from '../src/ui/external-calendar-source-edit-modal';
import { FileSuggest } from '../src/ui/file-suggest';
import { validateOperonSettingsBackupGroupsV1 } from '../src/core/settings-backup-group-validation';
import { exportOperonSettingsBackupJsonV1 } from '../src/core/settings-backup-export';
import { preflightOperonSettingsBackupRestoreV1 } from '../src/core/settings-backup-preflight';

const date = localToday().replace(/-/g, '');
const calendar = (events = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//Calendar//EN\r\n${events}END:VCALENDAR\r\n`;
const event = (title = 'Work', extra = '') => `BEGIN:VEVENT\r\nUID:work-event\r\nDTSTART:${date}T100000Z\r\nDTEND:${date}T110000Z\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\n`;
const local = (filePath = 'Calendars/work.ics'): ExternalCalendarSource => ({id:'work',type:'ics',sourceKind:'vault-file',filePath,url:'',name:'Work',color:'#8ecae6',enabled:true,hideCreatedEvents:false,refreshIntervalHours:1});
const remote = (): ExternalCalendarSource => ({id:'remote',type:'ics',url:'webcal://example.invalid/work.ics',name:'Remote',color:'#8ecae6',enabled:true,hideCreatedEvents:false,refreshIntervalHours:1});
const settle = async () => { for(let i=0;i<40;i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }

function harness(t: any, initial: any[] = []) {
 let now=0, sequence=0, ready:()=>void=()=>{}, reads=0, changes=0, writes=0;
 const jobs=new Map<number,{at:number;run:()=>void}>(), handlers=new Map<string,Set<(...args:any[])=>void>>();
 const files=new Map<string,string>([['Calendars/work.ics',calendar(event())]]), cache=new Map(initial.map(v=>[v.sourceId,structuredClone(v)]));
 const originalWindow=(globalThis as any).window,originalRequest=(globalThis as any).__obsidianRequestUrl;
 (globalThis as any).window={setTimeout(run:()=>void,delay:number){const id=++sequence;jobs.set(id,{at:now+delay,run});return id;},clearTimeout(id:number){jobs.delete(id);}};
 (globalThis as any).__obsidianRequestUrl=()=>{throw Error('Unexpected HTTP for vault source');};
 let readOverride:((path:string)=>Promise<string>)|undefined;
 const vault:any={configDir:'.obsidian',getAbstractFileByPath:(path:string)=>files.has(path)?new TFile(path):null,getFiles:()=>[...files.keys()].map(p=>new TFile(p)),getMarkdownFiles:()=>[...files.keys()].filter(p=>p.endsWith('.md')).map(p=>new TFile(p)),read:async(file:TFile)=>{reads++;return readOverride?readOverride(file.path):files.get(file.path)!;},modify(){writes++;throw Error('ICS write forbidden');},create(){writes++;throw Error('ICS write forbidden');},delete(){writes++;throw Error('ICS write forbidden');},on(name:string,cb:(...args:any[])=>void){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name)!.add(cb);return {name,cb};},offref(ref:any){handlers.get(ref.name)?.delete(ref.cb);}};
 const app={vault,workspace:{onLayoutReady(cb:()=>void){ready=cb;}}} as unknown as App;
 const store={getAllSources:()=>[...cache.values()],getSource:(id:string)=>cache.get(id),async removeSourcesExcept(ids:Iterable<string>){const keep=new Set(ids);for(const id of cache.keys())if(!keep.has(id))cache.delete(id);},async upsertSource(value:any){cache.set(value.sourceId,structuredClone(value));}} as unknown as ExternalCalendarCacheStore;
 const service=new ExternalCalendarService(store,()=>changes++,app);
 t.after(async()=>{await service.destroy();assert.equal(writes,0);(globalThis as any).window=originalWindow;(globalThis as any).__obsidianRequestUrl=originalRequest;});
 return {service,app,files,cache,jobs,handlers,counts:()=>({reads,changes,writes}),setReader:(fn?:typeof readOverride)=>{readOverride=fn;},ready:async()=>{ready();await settle();},start:async(sources=[local()])=>{await service.applySettings(sources);ready();await settle();},emit:(name:string,file:TFile|TFolder,oldPath?:string)=>{for(const handler of handlers.get(name)??[])handler(file,oldPath);},async advance(ms:number){const end=now+ms;for(;;){const next=[...jobs.entries()].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;jobs.delete(next[0]);next[1].run();await settle();}now=end;await settle();}};
}

test('legacy URL settings keep their representation and local settings round-trip',()=>{
 const original=remote();assert.deepEqual(migrateSettings({...DEFAULT_SETTINGS,externalCalendars:[original]}).externalCalendars,[original]);
 const source=local();assert.deepEqual(migrateSettings({...DEFAULT_SETTINGS,externalCalendars:[source]}).externalCalendars,[source]);
 const groups={'external-calendars':{codecVersion:1 as const,data:{externalCalendars:[original,source]}}};
 assert.equal(validateOperonSettingsBackupGroupsV1(JSON.parse(JSON.stringify(groups))).ok,true);
 assert.equal(validateOperonSettingsBackupGroupsV1({'external-calendars':{codecVersion:1,data:JSON.parse(JSON.stringify({externalCalendars:[local('../secret.ics')]}))}}).ok,false);
});

test('vault paths reject absolute, hidden, configuration, protocol and escaping paths',()=>{
 for(const path of ['Calendars/work.ics','Calendars/Work.ICS','Takvim/Çalışma.ics'])assert.equal(isVaultCalendarPath(path),true,path);
 for(const path of ['/tmp/work.ics','C:/work.ics','file://work.ics','../work.ics','a/../work.ics','.hidden/work.ics','a/.hidden.ics','.obsidian/work.ics','a//work.ics','a\\work.ics','work.md','a\0.ics'])assert.equal(isVaultCalendarPath(path),false,path);
 assert.equal(isVaultCalendarPath('Config/work.ics','Config'),false);
});

test('starts only after vault readiness; initial local read bypasses a fresh cache',async t=>{
 const h=harness(t);await h.service.applySettings([local()]);assert.equal(h.counts().reads,0);await h.ready();assert.equal(h.counts().reads,1);assert.equal(h.service.getSourceCache('work')?.events[0].title,'Work');
 const saved=h.service.getSourceCache('work')!;await h.service.destroy();
 const next=new ExternalCalendarService({getAllSources:()=>[saved],removeSourcesExcept:async()=>{},upsertSource:async()=>{}} as any,()=>{},h.app);await next.applySettings([local()]);h.files.set('Calendars/work.ics',calendar(event('While closed')));await h.ready();assert.equal(next.getSourceCache('work')?.events[0].title,'While closed');await next.destroy();
});

test('modify events debounce at 500 ms and refresh only matching sources',async t=>{
 const h=harness(t);await h.start();const before=h.counts();h.files.set('Calendars/work.ics',calendar(event('New')));
 for(let i=0;i<6;i++)h.emit('modify',new TFile('Calendars/work.ics'));
 h.emit('modify',new TFile('Notes/other.md'));await h.advance(499);assert.equal(h.counts().reads,before.reads);await h.advance(1);assert.equal(h.counts().reads,before.reads+1);assert.equal(h.service.getSourceCache('work')?.events[0].title,'New');assert.ok(h.counts().changes>before.changes);
});

test('a change during a pending read is read again and the stale result is discarded',async t=>{
 const h=harness(t);await h.start();const gate=deferred<string>();h.setReader(()=>gate.promise);const pending=h.service.syncNow('work');h.files.set('Calendars/work.ics',calendar(event('Latest')));h.emit('modify',new TFile('Calendars/work.ics'));await h.advance(500);h.setReader();gate.resolve(calendar(event('Stale')));await pending;assert.equal(h.service.getSourceCache('work')?.events[0].title,'Latest');
});

for(const body of ['', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n', 'BEGIN:VTODO\r\nSUMMARY:Wrong root\r\nEND:VTODO\r\n'])test(`invalid local content preserves cache and retries once: ${JSON.stringify(body)}`,async t=>{
 const h=harness(t);await h.start();h.files.set('Calendars/work.ics',body);h.emit('modify',new TFile('Calendars/work.ics'));await h.advance(500);assert.ok(h.service.getSourceCache('work')?.lastError);assert.equal(h.service.getSourceCache('work')?.events[0].title,'Work');const count=h.counts().reads;await h.advance(1000);assert.equal(h.counts().reads,count+1);await h.advance(5000);assert.equal(h.counts().reads,count+1);h.files.set('Calendars/work.ics',calendar(event('Recovered')));h.emit('modify',new TFile('Calendars/work.ics'));await h.advance(500);assert.equal(h.service.getSourceCache('work')?.lastError,null);assert.equal(h.service.getSourceCache('work')?.events[0].title,'Recovered');
});

test('a valid empty calendar clears old events',async t=>{const h=harness(t);await h.start();h.files.set('Calendars/work.ics',calendar());await h.service.syncNow('work');assert.deepEqual(h.service.getSourceCache('work')?.events,[]);assert.equal(h.service.getSourceCache('work')?.lastError,null);});

for(const folder of [false,true])test(`delete and recreate at a fixed path recovers (${folder?'folder':'file'})`,async t=>{
 const h=harness(t);await h.start();h.files.delete('Calendars/work.ics');h.emit('delete',folder?new TFolder('Calendars'):new TFile('Calendars/work.ics'));await h.advance(500);assert.ok(h.service.getSourceCache('work')?.lastError);assert.equal(h.service.getSourceCache('work')?.events.length,1);h.files.set('Calendars/work.ics',calendar(event('Returned')));h.emit('create',folder?new TFolder('Calendars'):new TFile('Calendars/work.ics'));await h.advance(500);assert.equal(h.service.getSourceCache('work')?.events[0].title,'Returned');
});

for(const folder of [false,true])test(`rename does not follow the source; rename back recovers (${folder?'folder':'file'})`,async t=>{
 const h=harness(t);const source=local();await h.start([source]);h.files.delete(source.filePath!);h.emit('rename',folder?new TFolder('Elsewhere'):new TFile('Calendars/moved.ics'),folder?'Calendars':source.filePath);await h.advance(500);assert.ok(h.service.getSourceCache('work')?.lastError);assert.equal(source.filePath,'Calendars/work.ics');h.files.set(source.filePath!,calendar(event('Restored')));h.emit('rename',folder?new TFolder('Calendars'):new TFile(source.filePath!),folder?'Elsewhere':'Calendars/moved.ics');await h.advance(500);assert.equal(h.service.getSourceCache('work')?.events[0].title,'Restored');
});

test('periodic refresh and manual refresh still read local files',async t=>{const h=harness(t);await h.start();h.files.set('Calendars/work.ics',calendar(event('Timer')));await h.advance(3600000);assert.equal(h.service.getSourceCache('work')?.events[0].title,'Timer');h.files.set('Calendars/work.ics',calendar(event('Manual')));assert.equal(await h.service.syncNow('work'),'synced');assert.equal(h.service.getSourceCache('work')?.events[0].title,'Manual');});

test('changing path discards cache and rejects an old in-flight result',async t=>{
 const h=harness(t);await h.start();const gate=deferred<string>();h.setReader(()=>gate.promise);const pending=h.service.syncNow('work');h.files.set('Calendars/new.ics',calendar(event('New file')));await h.service.applySettings([local('Calendars/new.ics')]);assert.equal(h.service.getSourceCache('work'),null);h.setReader();gate.resolve(calendar(event('Old file')));await pending;assert.equal(h.service.getSourceCache('work')?.events[0].title,'New file');
});

test('removing a source while reading prevents cache resurrection',async t=>{
 const h=harness(t);await h.start();const gate=deferred<string>();h.setReader(()=>gate.promise);const pending=h.service.syncNow('work');await h.service.applySettings([]);gate.resolve(calendar(event('Late')));await pending;assert.equal(h.service.getSourceCache('work'),null);assert.equal(h.cache.has('work'),false);
});

test('cache identity rejects a different path after restart',async t=>{
 const h=harness(t,[{sourceId:'work',sourceIdentity:externalCalendarSourceIdentity(local('Calendars/old.ics')),events:[{title:'Wrong source'}]}]);await h.service.applySettings([local()]);assert.equal(h.service.getSourceCache('work'),null);await h.ready();assert.equal(h.service.getSourceCache('work')?.events[0].title,'Work');
});

test('disabled sources and destroy cancel listeners, retries and reads',async t=>{
 const h=harness(t);await h.start([{...local(),enabled:false}]);assert.equal(h.counts().reads,0);await h.service.applySettings([local()]);await settle();h.emit('modify',new TFile('Calendars/work.ics'));await h.service.destroy();const reads=h.counts().reads;await h.advance(10000);assert.equal(h.counts().reads,reads);assert.equal(h.jobs.size,0);assert.equal([...h.handlers.values()].every(s=>s.size===0),true);
});

test('URL transport, webcal normalization and HTTP 304 remain intact',async t=>{
 const h=harness(t);const calls:any[]=[];(globalThis as any).__obsidianRequestUrl=async(options:any)=>{calls.push(options);return calls.length===1?{status:200,headers:{etag:'"v1"'},text:calendar(event('Remote'))}:{status:304,headers:{etag:'"v1"'},text:''};};await h.start([remote()]);assert.equal(h.counts().reads,0);assert.equal(calls[0].url,'https://example.invalid/work.ics');await h.advance(3600000);assert.equal(calls[1].headers['If-None-Match'],'"v1"');assert.equal(h.service.getSourceCache('remote')?.events[0].title,'Remote');
});

test('local recurrence, all-day, timezone and expanded ranges reuse existing parsing',()=>{
 const body=calendar('BEGIN:VEVENT\r\nUID:all-day\r\nDTSTART;VALUE=DATE:20261016\r\nDTEND;VALUE=DATE:20261017\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Daily\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:timed\r\nDTSTART:20261016T100000Z\r\nDTEND:20261016T110000Z\r\nSUMMARY:UTC\r\nEND:VEVENT\r\n');
 const parse=(end:string)=>parseExternalCalendarIcsEvents({sourceId:'work',url:'',body,rangeStart:'2026-10-16',rangeEnd:end,requireCalendar:true});
 assert.equal(parse('2026-10-16').length,2);assert.equal(parse('2026-10-19').length,4);const items=buildExternalCalendarItems(parse('2026-10-19'),[local()],'2026-10-16','2026-10-19');assert.equal(items.every(i=>i.isReadOnly&&i.origin==='external'),true);assert.equal(items.filter(i=>i.kind==='allDayScheduled').length,3);
});

test('local render coverage expansion reparses even when content is unchanged',async t=>{const h=harness(t);await h.start();h.service.getCachedEvents('2030-01-01','2030-01-07');await settle();assert.ok(h.service.getSourceCache('work')!.coveredRangeEnd!>='2030-01-07');assert.equal(h.counts().reads,2);});

test('file suggestions filter ICS and preserve Markdown defaults for existing callers',async t=>{
 const h=harness(t);h.files.set('Notes/task.md','');h.files.set('Calendars/Other.ICS',calendar());h.files.set('.private/secret.ics',calendar());const input={} as HTMLInputElement;
 const regular=new FileSuggest(h.app,input,()=>{});assert.deepEqual(regular.getSuggestions('').map(f=>f.path),['Notes/task.md']);const picker=new FileSuggest(h.app,input,()=>{},{files:()=>h.app.vault.getFiles(),filter:f=>isVaultCalendarPath(f.path,h.app.vault.configDir)});assert.deepEqual(picker.getSuggestions('').map(f=>f.path),['Calendars/Other.ICS','Calendars/work.ics']);
});

test('Sync now compares both saved source kind and address',()=>{
 const base={draftUrl:'https://example.invalid/a',savedUrl:'https://example.invalid/a',hasSyncHandler:true};assert.equal(canSyncExternalCalendarSourceNow(base),true);assert.equal(canSyncExternalCalendarSourceNow({...base,draftKind:'vault-file'}),false);const file={...base,draftKind:'vault-file' as const,savedKind:'vault-file' as const,draftPath:'Calendars/work.ics',savedPath:'Calendars/work.ics'};assert.equal(canSyncExternalCalendarSourceNow(file),true);assert.equal(canSyncExternalCalendarSourceNow({...file,draftPath:'Calendars/other.ics'}),false);
});

test('modal changes stay in a draft and Cancel leaves saved source unchanged',async t=>{
 const h=harness(t);const source=remote(),before=structuredClone(source);let saved=0;const modal=new ExternalCalendarSourceEditModal({app:h.app,source,isNew:false,onSave:()=>{saved++;}});modal.onOpen();calendarControls.get('Source').change('vault-file');calendarControls.get('ICS file').change('Calendars/work.ics');modal.onClose();assert.deepEqual(source,before);assert.equal(saved,0);
});

test('modal Save validates local existence and clears URL only on accepted file save',async t=>{
 const h=harness(t);let saved:any;const modal=new ExternalCalendarSourceEditModal({app:h.app,source:remote(),isNew:false,onSave:v=>{saved=v;}});modal.onOpen();calendarControls.get('Source').change('vault-file');calendarControls.get('ICS file').change('Calendars/missing.ics');await (modal as any).handleSaveClick();assert.equal(Boolean(saved),false);calendarControls.get('ICS file').change('Calendars/work.ics');await (modal as any).handleSaveClick();const result=(()=>saved)() as ExternalCalendarSource;assert.equal(result.sourceKind,'vault-file');assert.equal(result.filePath,'Calendars/work.ics');assert.equal(result.url,'');
});

test('missing saved file remains editable and cancellation does not delete existing source',async t=>{
 const h=harness(t);let saved:any,canceled=0;const modal=new ExternalCalendarSourceEditModal({app:h.app,source:local('Calendars/missing.ics'),isNew:false,onSave:v=>{saved=v;},onCancel:()=>{canceled++;}});await (modal as any).handleSaveClick();assert.equal(saved.filePath,'Calendars/missing.ics');assert.equal(canceled,0);
});

test('production vault reader uses only Obsidian APIs and has no source writes',()=>{
 const code=readFileSync('src/systems/external-calendar-service.ts','utf8');assert.doesNotMatch(code, /from ['"](?:node:|fs|electron)|require\(['"](?:fs|electron)/u);assert.doesNotMatch(code,/vault\.(?:modify|create|delete|rename|process|adapter\.write)\(/u);
});


test('backup round-trip preserves absent vault files and masks both source addresses in preview', () => {
 const source = migrateSettings({...structuredClone(DEFAULT_SETTINGS), externalCalendars:[local('Calendars/private.ics'),remote()]});
 const exported = exportOperonSettingsBackupJsonV1({settings:source,source:{pluginVersion:'4.0.1',obsidianVersion:'1.13.0',dataPackageSchemaVersion:2},createdAt:'2026-10-16T12:00:00.000Z'});
 assert.equal(exported.ok,true);if(!exported.ok)return;
 const target = migrateSettings({...structuredClone(DEFAULT_SETTINGS),externalCalendars:[local('Calendars/target-secret.ics')]});
 const preview = preflightOperonSettingsBackupRestoreV1({sourceJson:exported.json,targetSnapshot:{settings:target,dataPackageSchemaVersion:2,settingsVersion:target.settingsVersion,canonicalWritesSuspended:false,canonicalWriteSuspensionReason:null}});
 assert.equal(preview.ok,true);if(!preview.ok)return;
 assert.equal(preview.classification,'ready',JSON.stringify(preview.preview.issues));
 assert.deepEqual(preview.restorePlan?.candidateSettings.externalCalendars,source.externalCalendars);
 const visible=JSON.stringify(preview.preview);
 assert.equal(visible.includes('Calendars/private.ics'),false);
 assert.equal(visible.includes('Calendars/target-secret.ics'),false);
 assert.equal(visible.includes('webcal://example.invalid/work.ics'),false);
});

test('reenabling a local source reads changes made while it was disabled',async t=>{
 const h=harness(t);await h.start();await h.service.applySettings([{...local(),enabled:false}]);h.files.set('Calendars/work.ics',calendar(event('While disabled')));await h.service.applySettings([local()]);await settle();assert.equal(h.service.getSourceCache('work')?.events[0].title,'While disabled');
});

test('URL requests still deduplicate while the same address is in flight',async t=>{
 const h=harness(t),gate=deferred<any>();let calls=0;(globalThis as any).__obsidianRequestUrl=()=>{calls++;return gate.promise;};await h.start([remote()]);const first=h.service.syncNow('remote'),second=h.service.syncNow('remote');gate.resolve({status:200,headers:{},text:calendar(event())});await Promise.all([first,second]);assert.equal(calls,1);
});

test('destroy rejects an in-flight vault result',async t=>{
 const h=harness(t);await h.start();const gate=deferred<string>();h.setReader(()=>gate.promise);const pending=h.service.syncNow('work');const closing=h.service.destroy();gate.resolve(calendar(event('Late')));await Promise.all([pending,closing]);assert.equal(h.cache.get('work').events[0].title,'Work');assert.equal(h.jobs.size,0);
});


test('coverage requested during a local read is applied by the queued read', async t => {
 const h=harness(t);await h.start();const gate=deferred<string>();h.setReader(()=>gate.promise);const pending=h.service.syncNow('work');h.service.getCachedEvents('2030-01-01','2030-01-07');h.setReader();gate.resolve(calendar(event()));await pending;assert.ok(h.service.getSourceCache('work')!.coveredRangeEnd! >= '2030-01-07');
});

test('multiple calendar documents are rejected without clearing the last good events', async t => {
 const h=harness(t);await h.start();h.files.set('Calendars/work.ics',calendar()+calendar());await h.service.syncNow('work');assert.ok(h.service.getSourceCache('work')?.lastError);assert.equal(h.service.getSourceCache('work')?.events[0].title,'Work');
});

test('named timezone content has the same event times for vault and URL parsing', () => {
 const body=calendar('BEGIN:VTIMEZONE\r\nTZID:Test/Fixed\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0200\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:zoned\r\nDTSTART;TZID=Test/Fixed:20261016T120000\r\nDTEND;TZID=Test/Fixed:20261016T130000\r\nSUMMARY:Zoned\r\nEND:VEVENT\r\n');
 const options={sourceId:'work',url:'',body,rangeStart:'2026-10-16',rangeEnd:'2026-10-17'};
 const fileEvents=parseExternalCalendarIcsEvents({...options,requireCalendar:true});
 assert.equal(fileEvents.length,1);assert.deepEqual(fileEvents,parseExternalCalendarIcsEvents(options));
 assert.equal(new Date(fileEvents[0].startDateTime!).toISOString(),'2026-10-16T10:00:00.000Z');
});

// Issue #267: source timezone proof, never a blanket empty-series fallback.
const outlookRule = 'FREQ=YEARLY;UNTIL=20261031T230000Z;INTERVAL=1;BYMONTHDAY=1;BYMONTH=11';
function outlookCalendar(options: { rule?: string; zone?: string; extra?: string; components?: string; start?: string; end?: string } = {}) {
 const zone = options.zone ?? 'X-WR-TIMEZONE:Europe/Madrid';
 return calendar(`${zone}\r\nBEGIN:VEVENT\r\nUID:outlook-holiday\r\nSUMMARY:Outlook holiday\r\nDTSTART;VALUE=DATE:${options.start ?? '20261101'}\r\nDTEND;VALUE=DATE:${options.end ?? '20261102'}\r\nRRULE:${options.rule ?? outlookRule}\r\n${options.extra ?? ''}END:VEVENT\r\n${options.components ?? ''}`);
}
function parseOutlook(body: string, requireCalendar = true, start = '2026-01-01', end = '2027-12-31') {
 return parseExternalCalendarIcsEvents({ sourceId: 'work', url: '', body, rangeStart: start, rangeEnd: end, requireCalendar });
}
function outlookRange(h: ReturnType<typeof harness>) {
 (h.service as any).requestedRangeStart = '2026-01-01';
 (h.service as any).requestedRangeEnd = '2027-12-31';
}
function fixedZone(id: string, offset = '+0100') {
 return `BEGIN:VTIMEZONE\r\nTZID:${id}\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:${offset}\r\nTZOFFSETTO:${offset}\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n`;
}

test('Outlook yearly boundary yields one identical URL/file occurrence and no extra year', () => {
 const body=outlookCalendar(), items=parseOutlook(body);
 assert.deepEqual(items,parseOutlook(body,false));assert.equal(items.length,1);
 assert.equal(items[0].startDate,'2026-11-01');assert.equal(items[0].endDate,'2026-11-01');
 assert.equal(body,outlookCalendar());assert.equal(parseOutlook(body,true,'2027-01-01','2027-12-31').length,0);
 assert.equal(parseOutlook(body,true,'2026-11-02','2026-11-30').length,0);
});

test('Outlook result does not depend on host timezone and respects source summer time', () => {
 const before=process.env.TZ;
 try {for(const tz of ['Europe/Madrid','Europe/Berlin','UTC','America/New_York']) {
  process.env.TZ=tz;
  assert.equal(parseOutlook(outlookCalendar()).length,1,tz);
  const summer=outlookCalendar({start:'20260701',end:'20260702',rule:'FREQ=YEARLY;UNTIL=20260630T220000Z;BYMONTH=7;BYMONTHDAY=1'});
  assert.equal(parseOutlook(summer)[0]?.startDate,'2026-07-01',tz);
 }} finally {if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
});

for(const [name, options] of Object.entries({
 missingZone:{zone:''},unknownZone:{zone:'X-WR-TIMEZONE:Unknown/Zone'},windowsZone:{zone:'X-WR-TIMEZONE:Romance Standard Time'},
 duplicateZone:{zone:'X-WR-TIMEZONE:Europe/Madrid\r\nX-WR-TIMEZONE:Europe/Berlin'},
 earlier:{rule:outlookRule.replace('20261031T230000Z','20261030T230000Z')},
 nonMidnight:{rule:outlookRule.replace('T230000Z','T233000Z')},
 nonUtc:{rule:outlookRule.replace('230000Z','230000')},
 validEarlierDate:{rule:outlookRule.replace('20261031T230000Z','20261031')},
 daily:{rule:outlookRule.replace('YEARLY','DAILY')},interval:{rule:outlookRule.replace('interval=1'.toUpperCase(),'INTERVAL=2')},
 count:{rule:outlookRule+';COUNT=1'},otherBy:{rule:outlookRule+';BYDAY=SU'},
 differentMonth:{rule:outlookRule.replace('BYMONTH=11','BYMONTH=12')},
 multipleDays:{rule:outlookRule.replace('BYMONTHDAY=1','BYMONTHDAY=1,2')},
 secondRule:{extra:'RRULE:'+outlookRule+'\r\n'},
 brokenEmbedded:{components:'BEGIN:VTIMEZONE\r\nTZID:Europe/Madrid\r\nEND:VTIMEZONE\r\n'},
 duplicateEmbedded:{components:fixedZone('Europe/Madrid')+fixedZone('Europe/Madrid')},
 embeddedOverridesIana:{components:fixedZone('Europe/Madrid','+0200')},
})) test(`Outlook compatibility does not guess or widen ${name}`,()=>assert.equal(parseOutlook(outlookCalendar(options)).length,0));

test('matching embedded timezone is used without a global timezone registration', () => {
 assert.equal(parseOutlook(outlookCalendar({zone:'X-WR-TIMEZONE:+01:00'})).length,0);
 assert.equal(parseOutlook(outlookCalendar({zone:'X-WR-TIMEZONE:+0100',components:fixedZone('+0100')})).length,1);
 assert.equal(parseOutlook(outlookCalendar({zone:'X-WR-TIMEZONE:Custom/Institution',components:fixedZone('Custom/Institution')})).length,1);
 assert.equal(parseOutlook(outlookCalendar({zone:'',components:fixedZone('Custom/Institution')})).length,0);
});

test('Outlook normalization preserves EXDATE, RDATE and recurrence exceptions', () => {
 assert.equal(parseOutlook(outlookCalendar({extra:'EXDATE;VALUE=DATE:20261101\r\n'})).length,0);
 const added=parseOutlook(outlookCalendar({extra:'RDATE;VALUE=DATE:20261101,20261103\r\n'}));
 assert.deepEqual(added.map(e=>e.startDate),['2026-11-01','2026-11-03']);
 const exception='BEGIN:VEVENT\r\nUID:outlook-holiday\r\nRECURRENCE-ID;VALUE=DATE:20261101\r\nDTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261104\r\nSUMMARY:Moved holiday\r\nEND:VEVENT\r\n';
 const moved=parseOutlook(outlookCalendar({components:exception}));
 assert.deepEqual(moved,parseOutlook(outlookCalendar({components:exception,rule:outlookRule.replace('20261031T230000Z','20261101')})));
 assert.equal(moved.length,1);assert.equal(moved[0].startDate,'2026-11-02');assert.equal(moved[0].endDate,'2026-11-03');
});

test('valid equality, COUNT, daily, weekly, yearly and timed recurrences retain their results',()=>{
 for(const [rule,count] of [
  ['FREQ=YEARLY;UNTIL=20261101',1],['FREQ=YEARLY;UNTIL=20261101T000000Z',1],
  ['FREQ=YEARLY;UNTIL=20271101',2],['FREQ=YEARLY;COUNT=2',2],
  ['FREQ=DAILY;COUNT=3',3],['FREQ=WEEKLY;COUNT=3',3],
 ] as const) assert.equal(parseOutlook(outlookCalendar({rule})).length,count,rule);
 const timed=outlookCalendar({rule:'FREQ=YEARLY;UNTIL=20271101T100000Z'}).replace('DTSTART;VALUE=DATE:20261101','DTSTART:20261101T100000Z').replace('DTEND;VALUE=DATE:20261102','DTEND:20261101T110000Z');
 assert.equal(parseOutlook(timed).length,2);
});

test('local Outlook source updates through existing file events with no HTTP or writes',async t=>{
 const h=harness(t);outlookRange(h);h.files.set('Calendars/work.ics',outlookCalendar());await h.start();
 assert.equal(h.service.getSourceCache('work')?.events.length,1);
 h.files.set('Calendars/work.ics',outlookCalendar({extra:'EXDATE;VALUE=DATE:20261101\r\n'}));h.emit('modify',new TFile('Calendars/work.ics'));await h.advance(500);
 assert.equal(h.service.getSourceCache('work')?.events.length,0);assert.equal(h.counts().writes,0);
});

test('old empty URL cache survives automatic 304 and recovers with manual full fetch',async t=>{
 const h=harness(t,[{sourceId:'remote',events:[],etag:'"old"',lastModified:'old-date',syncedAt:null,coveredRangeStart:'2026-01-01',coveredRangeEnd:'2027-12-31'}]);outlookRange(h);const calls:any[]=[];
 (globalThis as any).__obsidianRequestUrl=async(o:any)=>{calls.push(o);return calls.length===1?{status:304,headers:{},text:''}:{status:200,headers:{etag:'"new"'},text:outlookCalendar()};};
 await h.start([remote()]);assert.equal(calls[0].headers['If-None-Match'],'"old"');assert.equal(h.service.getSourceCache('remote')?.events.length,0);
 assert.equal(await h.service.syncNow('remote'),'synced');assert.deepEqual(calls[1].headers,{});assert.equal(h.service.getSourceCache('remote')?.events.length,1);
 assert.equal(h.service.getSourceCache('remote')?.etag,'"new"');
});

test('manual request during conditional fetch waits for one coalesced full fetch',async t=>{
 const h=harness(t,[{sourceId:'remote',events:[],etag:'"old"',syncedAt:null,coveredRangeStart:'2026-01-01',coveredRangeEnd:'2027-12-31'}]);outlookRange(h);
 const first=deferred<any>(),second=deferred<any>(),calls:any[]=[];
 (globalThis as any).__obsidianRequestUrl=(o:any)=>{calls.push(o);return calls.length===1?first.promise:second.promise;};
 await h.start([remote()]);let finished=false;
 const a=h.service.syncNow('remote').then(r=>{finished=true;return r;}),b=h.service.syncNow('remote');
 assert.equal(calls.length,1);first.resolve({status:304,headers:{},text:''});await settle();
 assert.equal(calls.length,2);assert.deepEqual(calls[1].headers,{});assert.equal(finished,false);
 const c=h.service.syncNow('remote');second.resolve({status:200,headers:{etag:'"new"'},text:outlookCalendar()});
 assert.deepEqual(await Promise.all([a,b,c]),['synced','synced','synced']);assert.equal(calls.length,2);
});

for(const failure of ['304','network']) test(`manual full fetch preserves cached events on ${failure}`,async t=>{
 const h=harness(t);outlookRange(h);
 (globalThis as any).__obsidianRequestUrl=async()=>({status:200,headers:{etag:'"good"'},text:outlookCalendar()});await h.start([remote()]);
 const before=h.service.getSourceCache('remote')!.events;let calls=0;
 (globalThis as any).__obsidianRequestUrl=async()=>{calls++;if(failure==='network')throw Error('Offline');return {status:304,headers:{},text:''};};
 assert.equal(await h.service.syncNow('remote'),'failed');assert.equal(calls,1);assert.deepEqual(h.service.getSourceCache('remote')?.events,before);assert.ok(h.service.getSourceCache('remote')?.lastError);
});

test('sync all manually omits validators for every URL source',async t=>{
 const h=harness(t);outlookRange(h);const calls:any[]=[];
 (globalThis as any).__obsidianRequestUrl=async(o:any)=>{calls.push(o);return {status:200,headers:{etag:'"v1"'},text:outlookCalendar()};};
 await h.start([remote(),{...remote(),id:'remote2',url:'https://example.invalid/two.ics'}]);calls.length=0;
 assert.deepEqual(await h.service.syncAllNow(),{synced:2,skipped:0,failed:0});assert.equal(calls.length,2);assert.ok(calls.every(c=>Object.keys(c.headers).length===0));
});

for(const action of ['remove','disable','replace','destroy']) test(`queued manual full fetch respects ${action}`,async t=>{
 const h=harness(t,[{sourceId:'remote',events:[],etag:'"old"',syncedAt:null,coveredRangeStart:'2026-01-01',coveredRangeEnd:'2027-12-31'}]);outlookRange(h);
 const gate=deferred<any>();let calls=0;
 (globalThis as any).__obsidianRequestUrl=()=>{calls++;return calls===1?gate.promise:Promise.resolve({status:200,headers:{},text:outlookCalendar().replace('Outlook holiday','New source')});};
 await h.start([remote()]);const pending=h.service.syncNow('remote');
 let closing:Promise<void>|undefined;
 if(action==='destroy') closing=h.service.destroy();
 else await h.service.applySettings(action==='remove'?[]:[{...remote(),...(action==='disable'?{enabled:false}:{url:'https://example.invalid/new.ics'})}]);
 gate.resolve({status:304,headers:{},text:''});assert.equal(await pending,'skipped');await closing;
 if(action==='replace'){assert.equal(h.service.getSourceCache('remote')?.events[0]?.title,'New source');assert.equal(calls,2);}
 else {assert.equal(calls,1);assert.equal(h.service.getSourceCache('remote')?.events.length??0,0);}
});
