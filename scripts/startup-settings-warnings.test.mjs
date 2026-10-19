import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=await build({stdin:{contents:"export {SettingsWritesSuspendedError} from './src/storage/operon-data-package-store';",resolveDir:root},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {SettingsWritesSuspendedError}=await import('data:text/javascript;base64,'+Buffer.from(runtime.outputFiles[0].text).toString('base64'));
const source=readFileSync(path.join(root,'main.ts'),'utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['initializeTablePresetRegistry','reloadCanonicalSettingsFromStorage','performCanonicalSettingsRefresh','refreshTablePresetRegistry'];
const methods=[];
function visit(node){if(ts.isMethodDeclaration(node)&&names.includes(node.name.getText(ast)))methods.push(node.getText(ast));ts.forEachChild(node,visit);}
visit(ast);assert.equal(methods.length,names.length);
const compiled=ts.transpileModule('class Probe{'+methods.join('\n')+'}\nreturn Probe;',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
function fixture({blocked=false,refreshError,realRefresh=false,fileError}={}){
 const warnings=[],notices=[],calls=[],marks=[];
 const snapshot={entries:new Map(),fileDiagnostics:[]};
 const state={blocked,health:'ready'};
 class MigrationError extends Error{code='invalid-file';}
 class File{}
 const globals={SettingsWritesSuspendedError,console:{warn:(...args)=>warnings.push(args)},Notice:class{constructor(message){notices.push(message);}},t:(_section,key)=>key,
  TablePresetRegistry:class{getSnapshot(){return snapshot;}async refresh(){calls.push(['registry-read']);}},TablePresetFileConflictResolver:class{},
  TFile:File,TFolder:class{},isOperonTableFilePath:()=>false,applyTablePresetPatch:()=>{},
  getOperonTableFilePathKey:value=>value.toLowerCase(),hasLocalePackIntentChanged:()=>false,
  migrateOperonTableFilesToV3:async()=>{calls.push(['migrate-v3']);if(fileError)throw fileError==='native'?new MigrationError('broken Table'):new Error('unrelated failure');return {status:'not-needed'};},
  migrateOperonTableFilesToV5:async()=>{calls.push(['migrate-v5']);return {status:'not-needed'};},
  TableFileV3MigrationError:MigrationError,TableFileV5MigrationError:MigrationError,
  inspectTableFileV3MigrationRecoveryEvidence:async()=>({affectedPaths:['Broken.table'],backupRootPath:null}),
  inspectTableFileV5MigrationRecoveryEvidence:async()=>({affectedPaths:['Broken.table'],backupRootPath:null})};
 const Probe=new Function(...Object.keys(globals),compiled)(...Object.values(globals));
 const probe=new Probe();
 probe.settings={language:'en',languagePackSubscriptions:[],tablePresetFileBindings:[],tablePresetFileInitialized:true,tablePresetOrderIds:[]};
 probe.storage={canPersistSettings:()=>!state.blocked,canRunTablePresetFileRecovery:()=>!state.blocked&&state.health!=='degraded',
  getTablePresetRecoveryDiagnostics:()=>({health:state.health}),markTablePresetDegraded:(...args)=>{marks.push(args);state.health='degraded';},recordTablePresetFileRepairs:()=>{},setTablePresetProtectedIds:()=>{},markTablePresetReadyAfterRescan:()=>{},
  reloadCanonicalSettingsPackage:async()=>{calls.push(['reload']);return {changed:false,diagnostics:{invalidDomains:[],pipelineTaxonomy:{backupFailed:false,issues:[]}}};}};
 probe.app={vault:{adapter:{},configDir:'.obsidian',getFiles:()=>[],getAbstractFileByPath:()=>null,read:async()=>'',on:()=>({}),offref:()=>{},process:()=>{}},fileManager:{}};
 probe.tablePresetRegistry=new globals.TablePresetRegistry();
 probe.tablePresetRegistrySubscriptions=new Map();probe.register=()=>{};probe.registerTablePresetFileWatchers=()=>calls.push(['watchers']);
 if(!realRefresh)probe.refreshTablePresetRegistry=async options=>{calls.push(['refresh',options]);if(refreshError&&options.persistBindings){state.blocked=refreshError==='paused';throw refreshError==='paused'?new SettingsWritesSuspendedError('test pause'):new Error('unrelated refresh failure');}};
 probe.reconcileCanonicalTablePresetFileAuthority=async()=>calls.push(['authority']);
 probe.ensureCanonicalTablePresetBootstrap=async()=>calls.push(['bootstrap']);
 probe.syncTablePresetProjectionFromRegistry=()=>false;probe.reconcileBoundTableFileNames=async()=>{calls.push(['rename']);return false;};
 probe.getTablePresetRegistryEntrySignature=entry=>JSON.stringify(entry);probe.syncTablePresetRegistrySubscriptions=()=>new Set();probe.handleSettingsChanged=()=>calls.push(['publish']);probe.synchronizeLanguagePacksAfterLayout=async()=>{};
 probe.refreshCanonicalSettingsSingleFlight=()=>probe.performCanonicalSettingsRefresh();
 return {probe,calls,marks,warnings,notices,state,snapshot};
}

test('known settings pause reads Tables without migrations, saves, or false degradation',async()=>{
 const f=fixture({blocked:true});await f.probe.initializeTablePresetRegistry();
 assert.deepEqual(f.calls,[['refresh',{adoptUnbound:false,persistBindings:false,reconcileFileNames:false}],['watchers']]);
 assert.deepEqual(f.marks,[]);assert.deepEqual(f.warnings,[]);
});
test('writable startup retains migrations, normal authority and bootstrap',async()=>{
 const f=fixture();await f.probe.initializeTablePresetRegistry();
 assert.ok(f.calls.some(([name])=>name==='migrate-v3'));assert.ok(f.calls.some(([name])=>name==='migrate-v5'));
 assert.ok(f.calls.some(([name])=>name==='bootstrap'));assert.deepEqual(f.marks,[]);
});
test('pause beginning during startup refresh stays a settings issue with a read-only fallback',async()=>{
 const f=fixture({refreshError:'paused'});await f.probe.initializeTablePresetRegistry();
 assert.deepEqual(f.marks,[]);assert.deepEqual(f.warnings,[]);
 assert.ok(f.calls.some(([name,options])=>name==='refresh'&&options.persistBindings===false));
 assert.ok(!f.calls.some(([name])=>name==='authority'||name==='bootstrap'));
});
for(const fileError of ['native','unexpected'])test(`${fileError} Table failure is still reported once with evidence`,async()=>{
 const f=fixture({fileError});await f.probe.initializeTablePresetRegistry();
 assert.ok(f.marks.some(([code])=>code==='table-file-invalid'));
 assert.equal(f.warnings.length,1);assert.match(f.warnings[0][0],/Table recovery was isolated/);
 assert.deepEqual(f.marks[0][2].affectedPaths,['Broken.table']);
});
test('background refresh continues read recovery without Table writes while paused',async()=>{
 const f=fixture({blocked:true});for(let i=0;i<6;i++)await f.probe.reloadCanonicalSettingsFromStorage('background');
 assert.equal(f.calls.filter(([name])=>name==='reload').length,6);
 assert.ok(!f.calls.some(([name])=>name==='refresh'||name==='bootstrap'));assert.deepEqual(f.warnings,[]);assert.deepEqual(f.notices,[]);
 f.state.blocked=false;await f.probe.reloadCanonicalSettingsFromStorage('background');
 assert.ok(f.calls.some(([name,options])=>name==='refresh'&&options.persistBindings===true));
});
test('repeated typed pause errors do not become reload failures; explicit reload still gives feedback',async()=>{
 const f=fixture({blocked:true});f.probe.refreshCanonicalSettingsSingleFlight=async()=>{throw new SettingsWritesSuspendedError('pause');};
 for(let i=0;i<6;i++)await f.probe.reloadCanonicalSettingsFromStorage('background');
 assert.deepEqual(f.warnings,[]);assert.deepEqual(f.notices,[]);
 await f.probe.reloadCanonicalSettingsFromStorage('manual');assert.deepEqual(f.notices,['settingsWriteProtected']);
});
test('an unrelated reload failure remains visible even during a settings pause',async()=>{
 const f=fixture({blocked:true});f.probe.refreshCanonicalSettingsSingleFlight=async()=>{throw new Error('different failure');};
 await f.probe.reloadCanonicalSettingsFromStorage('background');assert.equal(f.warnings.length,1);assert.match(f.warnings[0][0],/reload failed/);
});
test('scheduled registry refresh uses read-only options during settings pause',async()=>{
 const f=fixture({blocked:true,realRefresh:true});await f.probe.refreshTablePresetRegistry({adoptUnbound:true,persistBindings:true});
 assert.deepEqual(f.calls,[['registry-read']]);assert.deepEqual(f.marks,[]);
});
for(const [kind,entry,diagnostic] of [
 ['invalid',null,{code:'invalid-json'}],['missing',{id:'missing',status:'missing'},null],['conflict',{id:'same',status:'conflict'},null]
])test(`real ${kind} file evidence remains visible in read-only registry`,async()=>{
 const f=fixture({blocked:true,realRefresh:true});if(entry)f.snapshot.entries.set(entry.id,entry);if(diagnostic)f.snapshot.fileDiagnostics.push(diagnostic);
 await f.probe.refreshTablePresetRegistry({adoptUnbound:true,persistBindings:true});
 assert.equal(f.marks.length,1);assert.match(f.marks[0][0],new RegExp(kind==='invalid'?'invalid':kind==='missing'?'missing':'duplicate'));
 assert.ok(!f.calls.some(([name])=>name==='authority'||name==='rename'));
});
