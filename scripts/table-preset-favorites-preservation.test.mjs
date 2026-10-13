import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import ts from 'typescript';

// Run the actual Plugin/storage bridges against the real parser and registry.
async function methods(file, names) {
 const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
 const members = source.statements.filter(ts.isClassDeclaration).flatMap(c => [...c.members]);
 return names.map(name => {
  const method = members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === name);
  assert.ok(method, name);
  return method.getText(source);
 }).join('\n');
}
const input = `
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTablePreset, cloneTablePreset } from './src/types/table';
import { clonePresetFavorites, removePresetFavorite } from './src/core/preset-favorites';
import { discoverOperonTableFiles, serializeOperonTableFile, getOperonTableFilePathKey } from './src/storage/table-file';
import { reconcileTablePresetFileAuthority, mergeTablePresetRegistryOrder, resolveTablePresetDefaultAfterRegistrySync } from './src/storage/table-preset-manifest';
import { buildTablePresetAuthorityDataPackage } from './src/storage/table-preset-authority-package';
import { TablePresetRegistry } from './src/storage/table-preset-registry';
import { DEFAULT_SETTINGS } from './src/types/settings';
import { buildOperonDataPackageFromSettings, composeOperonSettingsFromDataPackage } from './src/storage/operon-data-package';
class Storage {
 ${await methods('src/storage/operon-storage.ts', ['reconcileTablePresetFileAuthority'])}
 async enqueueSettingsTransaction(operation) { return operation(); }
 hydratePackageBackedSettingStores() {}
 markTablePresetDegraded() {}
}
class TFile { constructor(public path:string) {} }
class Notice { constructor(message) {} }
const t = (_group, key) => key;
const window = {setTimeout:()=>0};
class Plugin {
 ${await methods('main.ts', ['reconcileCanonicalTablePresetFileAuthority', 'syncTablePresetProjectionFromRegistry', 'getTablePresetsForSurfaces', 'deleteFileBackedTablePresetAndRefresh'])}
}
function setup() {
 const presets = ['b','a'].map(id=>({...createDefaultTablePreset(),id:'tp_'+id,name:'Synthetic '+id}));
 const files = new Map(presets.map(p=>['Tables/'+p.id+'.table',serializeOperonTableFile(p)]));
 const originalFiles = new Map(files);
 const storage:any = new Storage();
 storage.settings={...structuredClone(DEFAULT_SETTINGS),tablePresets:presets,tablePresetOrderIds:['tp_b','tp_a'],tablePresetFileBindings:[...files.keys()].map((path,i)=>({id:presets[i].id,path})),tablePresetFileInitialized:true,tableDefaultPresetId:'tp_b',presetFavorites:{table:['tp_b','tp_a'],calendar:['cp_keep'],kanban:['kp_keep'],filter:['filter_keep']}};
 let saved=buildOperonDataPackageFromSettings(storage.settings);
 saved.settings.untouched='settings';saved.views.untouched='views';saved.ui.untouched='ui';
 let failSave=false;
 storage.dataPackageStore={updateDataPackageCas:async cb=>{if(failSave) throw Error('save failed');saved=JSON.parse(JSON.stringify(cb(saved)));}};
 const faults = {empty:false,failPaths:new Set(),invalid:false,duplicate:false};
 const vault={getFiles:()=>faults.empty?[]:[...files.keys()].map(path=>new TFile(path)),getAbstractFileByPath:path=>files.has(path)?new TFile(path):null,read:async file=>{
  if(faults.failPaths.has(file.path)) throw Error('temporary read failure');
  if(faults.invalid&&file.path.endsWith('tp_b.table')) return '{';
  if(faults.duplicate&&file.path.endsWith('tp_a.table')) return files.get('Tables/tp_b.table');
  return files.get(file.path);
 }};
 const plugin:any=new Plugin();
 Object.assign(plugin,{settings:storage.settings,storage,app:{vault}});
 plugin.tablePresetRegistry=new TablePresetRegistry({loadFileBindings:()=>storage.settings.tablePresetFileBindings,listTableFiles:vault.getFiles,readTableFile:vault.read,applyPatch:p=>p,writeTableFile:()=>{throw Error('unexpected Table write');}});
 const scan=()=>plugin.reconcileCanonicalTablePresetFileAuthority();
 const favorites=clonePresetFavorites(storage.settings.presetFavorites);
 return {plugin,storage,files,originalFiles,faults,scan,favorites,saved:()=>saved,saveFavorites:()=>{saved.ui.presetFavorites={version:1,...clonePresetFavorites(storage.settings.presetFavorites)};},failSave:()=>{failSave=true;}};
}
function assertPreferences(f) {
 assert.deepEqual(f.storage.settings.tablePresetOrderIds,['tp_b','tp_a']);
 assert.equal(f.storage.settings.tableDefaultPresetId,'tp_b');
 assert.deepEqual(f.storage.settings.presetFavorites,f.favorites);
 assert.deepEqual(f.saved().ui.presetFavorites,{version:1,...f.favorites});
 assert.equal(f.saved().settings.untouched,'settings');assert.equal(f.saved().views.untouched,'views');assert.equal(f.saved().ui.untouched,'ui');
 assert.deepEqual(f.files,f.originalFiles);
}
for(const scenario of ['all-read-fail','partial-read-fail','empty-inventory','partial-json','duplicate-id']) {
 test(scenario+' preserves preferences through repeated scans and recovery',async()=>{
  const f=setup();await f.scan();
  if(scenario==='all-read-fail')f.faults.failPaths=new Set(f.files.keys());
  if(scenario==='partial-read-fail')f.faults.failPaths.add('Tables/tp_b.table');
  if(scenario==='empty-inventory')f.faults.empty=true;
  if(scenario==='partial-json')f.faults.invalid=true;
  if(scenario==='duplicate-id')f.faults.duplicate=true;
  for(let i=0;i<2;i++) {await f.scan();assertPreferences(f);assert.notEqual(f.plugin.tablePresetRegistry.get('tp_b').status,'available');}
  // Simulate a fresh settings session from the persisted manifest/favorites.
  Object.assign(f.storage.settings,composeOperonSettingsFromDataPackage(JSON.parse(JSON.stringify(f.saved())),DEFAULT_SETTINGS));
  f.faults.empty=false;f.faults.invalid=false;f.faults.duplicate=false;f.faults.failPaths.clear();
  await f.scan();assertPreferences(f);assert.equal(f.storage.settings.tablePresets.length,2);
  for(const id of ['tp_b','tp_a'])assert.equal(f.plugin.tablePresetRegistry.get(id).status,'available');
 });
}
test('temporary replacement id does not claim an already bound file path',async()=>{
 const f=setup();await f.scan();
 f.files.set('Tables/tp_b.table',serializeOperonTableFile({...createDefaultTablePreset(),id:'tp_replacement',name:'Replacement'}));
 await f.scan();
 assert.deepEqual(f.storage.settings.tablePresetOrderIds,['tp_b','tp_a']);
 assert.equal(f.storage.settings.tablePresetFileBindings.length,2);
 assert.equal(f.plugin.tablePresetRegistry.get('tp_b').status,'conflict');
 f.files.set('Tables/tp_b.table',f.originalFiles.get('Tables/tp_b.table'));await f.scan();
 assertPreferences(f);assert.equal(f.plugin.tablePresetRegistry.get('tp_b').status,'available');
});
for(const failure of [false,true])test('concurrent favorite choice survives reconciliation '+(failure?'failure':'success'),async()=>{
 const f=setup();await f.scan();
 const persist=f.storage.dataPackageStore.updateDataPackageCas;
 f.storage.dataPackageStore.updateDataPackageCas=async cb=>{
  f.storage.settings.presetFavorites.table=['tp_a'];
  f.saveFavorites();
  if(failure)throw Error('save failed');
  return persist(cb);
 };
 if(failure)await assert.rejects(f.scan(),/save failed/);else await f.scan();
 assert.deepEqual(f.storage.settings.presetFavorites.table,['tp_a']);
 assert.deepEqual(f.saved().ui.presetFavorites.table,['tp_a']);
});
test('renamed files regain their binding without losing favorite or order',async()=>{
 const f=setup();await f.scan();const value=f.files.get('Tables/tp_b.table');f.files.delete('Tables/tp_b.table');
 await f.scan();assert.equal(f.storage.settings.tablePresetFileBindings[0].path,'Tables/tp_b.table');
 f.files.set('Elsewhere/Renamed.table',value);await f.scan();
 assert.equal(f.storage.settings.tablePresetFileBindings[0].path,'Elsewhere/Renamed.table');
 assert.deepEqual(f.storage.settings.presetFavorites,f.favorites);assert.equal(f.storage.settings.tableDefaultPresetId,'tp_b');
});
test('storage failure rolls back projection and preserves favorites',async()=>{
 const f=setup();await f.scan();const before=structuredClone(f.storage.settings);const saved=structuredClone(f.saved());
 f.failSave();f.faults.empty=true;await assert.rejects(f.scan(),/save failed/);
 assert.deepEqual(f.storage.settings,before);assert.deepEqual(f.saved(),saved);
});
test('explicit confirmed deletion still removes only the requested favorite and binding',async()=>{
 const f=setup();await f.scan();const h=f.plugin;
 h.confirmDeleteFileBackedTablePreset=async()=>true;
 h.getTableWorkspaceLeavesForPreset=()=>[];h.enqueueTablePresetMutation=async op=>op();
 h.snapshotTablePresetSettings=()=>structuredClone(h.settings);h.resolveEffectiveTablePresetId=()=> 'tp_a';
 h.expectedTableFileDeletes=new Map();h.refreshTablePresetRegistry=f.scan;
 h.closeTableFileLeavesForPath=()=>{};h.transitionDeletedTableWorkspaceLeaves=async()=>{};h.refreshTablePresetSurfaces=()=>{};
 h.app.fileManager={trashFile:async file=>{f.files.delete(file.path);}};
 f.storage.saveSettings=async()=>{f.saveFavorites();};
 await h.deleteFileBackedTablePresetAndRefresh('tp_b');
 assert.deepEqual(h.settings.tablePresetOrderIds,['tp_a']);assert.equal(h.settings.tableDefaultPresetId,'tp_a');
 assert.deepEqual(h.settings.presetFavorites,{...f.favorites,table:['tp_a']});assert.equal(f.files.size,1);
 await f.scan();assert.deepEqual(f.saved().ui.presetFavorites.table,['tp_a']);
});
`;
const root=process.cwd();
const dir=await mkdtemp(path.join(tmpdir(),'operon-favorites-regression-'));
try {
 const outfile=path.join(dir,'test.cjs');
 await build({stdin:{contents:input,loader:'ts',resolveDir:root},bundle:true,format:'cjs',platform:'node',outfile,logLevel:'silent'});
 const result=spawnSync(process.execPath,['--test',outfile],{stdio:'inherit'});
 if(result.status!==0)process.exitCode=result.status??1;
} finally {await rm(dir,{recursive:true,force:true});}
