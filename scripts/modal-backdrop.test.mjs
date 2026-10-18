import ts from 'typescript';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
 stdin: { contents: "export * from './src/ui/modal-backdrop';export * from './src/core/background-dimming';export {Platform} from 'obsidian';export {migrateSettings,DEFAULT_SETTINGS} from './src/types/settings';export {buildOperonDataPackageFromSettings,composeOperonSettingsFromDataPackage} from './src/storage/operon-data-package';export {OPERON_SETTINGS_SEARCH_REGISTRY} from './src/ui/settings/settings-search-registry';export {exportOperonSettingsBackupJsonV1} from './src/core/settings-backup-export';export {validateOperonSettingsBackupGroupsV1} from './src/core/settings-backup-group-validation';export {buildOperonSettingsBackupSelectedPatchV1} from './src/core/settings-backup-apply';export {getSettingsBackupCompatibilityForKey} from './src/core/settings-backup-compatibility';", resolveDir: root },
 bundle: true, write: false, format: 'esm', platform: 'node',
 plugins: [{ name: 'platform', setup(b) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'platform', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const Platform={isDesktopApp:true};export function normalizePath(p){return p;}export class TFile{}' }));
 } }],
});
const { normalizeBackgroundDimming, BACKGROUND_DIMMING_OPTIONS, applyDesktopModalBackdrop, Platform, migrateSettings, DEFAULT_SETTINGS, buildOperonDataPackageFromSettings, composeOperonSettingsFromDataPackage, OPERON_SETTINGS_SEARCH_REGISTRY, getSettingsBackupCompatibilityForKey, exportOperonSettingsBackupJsonV1, validateOperonSettingsBackupGroupsV1, buildOperonSettingsBackupSelectedPatchV1 } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
function container() {
 const classes = new Set(['modal-container']);
 return { ownerDocument: {}, classes, addClass: c => classes.add(c), removeClass: c => classes.delete(c) };
}

test('desktop owns only the supplied container; detached cleanup and repeated cleanup are safe', () => {
 const a = container(), b = container();
 const closeA = applyDesktopModalBackdrop(a), closeB = applyDesktopModalBackdrop(b);
 assert.ok(a.classes.has('operon-focus-modal'));
 closeA(); assert.equal(a.classes.has('operon-focus-modal'), false); assert.ok(b.classes.has('operon-focus-modal'));
 const reopened = applyDesktopModalBackdrop(a);
 closeA(); assert.ok(a.classes.has('operon-focus-modal'), 'late old cleanup cannot affect reopened owner');
 reopened(); closeB(); assert.deepEqual([...a.classes], ['modal-container']); assert.deepEqual([...b.classes], ['modal-container']);
});
test('mobile is a no-op including close, with no DOM operations', () => {
 Platform.isDesktopApp = false;
 try { const close = applyDesktopModalBackdrop({}); close(); close(); } finally { Platform.isDesktopApp = true; }
});
for (const name of ['creator', 'finder', 'editor']) test(`${name} modal installs and releases the effect only at native open/close`, () => {
 const source = readFileSync(path.join(root, `src/ui/task-${name}-modal.ts`), 'utf8');
 assert.equal(source.match(/applyDesktopModalBackdrop\(this.containerEl\)/g)?.length, 1);
 const open = source.slice(source.indexOf('onOpen(): void'), source.indexOf('onClose(): void'));
 assert.match(open, /this.backdropCleanup\?\.\(\);\s*this.backdropCleanup = applyDesktopModalBackdrop\(this.containerEl\)/);
 assert.match(source, /onClose\(\): void \{\s*this.backdropCleanup\?\.\(\);\s*this.backdropCleanup = null;/);
});
test('non-modal Editor content never opts in', () => {
 const source = readFileSync(path.join(root, 'src/ui/task-editor-content.ts'), 'utf8');
 assert.doesNotMatch(source, /applyDesktopModalBackdrop|operon-focus-modal/);
});

for (const value of [50,60,70,80,90]) test(`dimming ${value} survives real normalization and canonical package round-trip`, () => {
 const settings=migrateSettings({...DEFAULT_SETTINGS,workspaceTweaksBackgroundDimming:value});
 const pack=buildOperonDataPackageFromSettings(settings);
 assert.equal(pack.ui.workspaceTweaks.workspaceTweaksBackgroundDimming,value);
 assert.equal(composeOperonSettingsFromDataPackage(JSON.parse(JSON.stringify(pack)),DEFAULT_SETTINGS).workspaceTweaksBackgroundDimming,value);
 assert.equal(getSettingsBackupCompatibilityForKey('workspaceTweaksBackgroundDimming').support,'portable');
});
test('old and invalid preferences use 70 without mutating their input',()=>{
 for(const value of [undefined,null,'80',55,100,NaN]) {
  const raw={...DEFAULT_SETTINGS,workspaceTweaksBackgroundDimming:value};
  assert.equal(migrateSettings(raw).workspaceTweaksBackgroundDimming,70);
  assert.ok(Object.is(raw.workspaceTweaksBackgroundDimming,value));
 }
 const raw={...DEFAULT_SETTINGS}; delete raw.workspaceTweaksBackgroundDimming;
 assert.equal(migrateSettings(raw).workspaceTweaksBackgroundDimming,70);
});
test('dimming is searchable in Tweaks with one dropdown definition',()=>{
 const entries=OPERON_SETTINGS_SEARCH_REGISTRY.filter(e=>e.key==='workspaceTweaksBackgroundDimming');
 assert.equal(entries.length,1);assert.equal(entries[0].control,'dropdown');
 assert.ok(JSON.stringify(entries[0]).includes('interfaceTweaks'));
 for(const word of ['lightbox','opacity','backdrop','modal'])assert.ok(JSON.stringify(entries[0]).includes(word));
});

test('real portable export decode and selected restore patch preserve dimming',()=>{
 const settings=migrateSettings({...DEFAULT_SETTINGS,workspaceTweaksBackgroundDimming:80});
 const exported=exportOperonSettingsBackupJsonV1({settings,source:{pluginVersion:'4.0.1',obsidianVersion:'1.14.4',dataPackageSchemaVersion:3},createdAt:'2026-10-19T12:00:00.000Z'});
 assert.ok(exported.ok,JSON.stringify(exported));
 const decoded=validateOperonSettingsBackupGroupsV1(exported.backup.body.groups);
 assert.ok(decoded.ok,JSON.stringify(decoded));
 assert.equal(decoded.payloads.general.workspaceTweaksBackgroundDimming,80);
 const patch=buildOperonSettingsBackupSelectedPatchV1({selectedGroups:['general'],candidateSettings:{...DEFAULT_SETTINGS,...decoded.payloads.general}});
 assert.equal(patch.workspaceTweaksBackgroundDimming,80);
 assert.equal(migrateSettings({...settings,workspaceTweaksBackgroundDimming:DEFAULT_SETTINGS.workspaceTweaksBackgroundDimming}).workspaceTweaksBackgroundDimming,70);
});

// Compile the actual Settings methods, without constructing the whole Obsidian settings window.
function settingsProbe() {
 const source=readFileSync(path.join(root,'src/ui/settings-tab.ts'),'utf8');
 const ast=ts.createSourceFile('settings-tab.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const methods=[];
 function visit(node){
  if(ts.isMethodDeclaration(node)&&['setControlValue','getSettingsSearchDropdownOptions'].includes(node.name.getText(ast)))methods.push(node.getText(ast));
  ts.forEachChild(node,visit);
 }
 visit(ast);assert.equal(methods.length,2);
 const js=ts.transpileModule(`class Probe {${methods.join('\n')}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const Probe=new Function('normalizeBackgroundDimming','BACKGROUND_DIMMING_OPTIONS','isTaskCardSetting','t',`${js};return Probe;`)(normalizeBackgroundDimming,BACKGROUND_DIMMING_OPTIONS,()=>false,(_category,key)=>key==='workspaceTweaksBackgroundDimmingDefault'?'70% — Default':key);
 const probe=new Probe();
 probe.settings={workspaceTweaksBackgroundDimming:70};
 probe.findSettingsSearchEntryByKey=key=>OPERON_SETTINGS_SEARCH_REGISTRY.find(e=>e.key===key);
 probe.normalizeSettingsSearchControlValue=(_entry,value)=>value;
 probe.updateNativeSettingsDefinitions=()=>{probe.redraws++;};probe.redraws=0;
 probe.applySettingsSearchAfterSaveEffects=()=>{probe.published++;};probe.published=0;
 return probe;
}
test('actual Settings dropdown and setter save numeric choice then publish; failures restore prior choice',async()=>{
 const probe=settingsProbe();
 assert.deepEqual(Object.entries(probe.getSettingsSearchDropdownOptions('workspaceTweaksBackgroundDimming')),[['50','50%'],['60','60%'],['70','70% — Default'],['80','80%'],['90','90%']]);
 let writes=0;probe.saveSettings=async()=>{writes++;assert.equal(probe.published,0);};
 await probe.setControlValue('workspaceTweaksBackgroundDimming','80');
 assert.equal(writes,1);assert.equal(probe.settings.workspaceTweaksBackgroundDimming,80);assert.equal(probe.published,1);
 probe.saveSettings=async()=>{throw Error('storage rejected');};
 await assert.rejects(probe.setControlValue('workspaceTweaksBackgroundDimming','90'),/storage rejected/);
 assert.equal(probe.settings.workspaceTweaksBackgroundDimming,80);assert.equal(probe.published,1);assert.equal(probe.redraws,1);
});

test('only the standalone Subtasks modal joins dimming, not the file filter or Editor popover', () => {
 const source = readFileSync(path.join(root, 'src/ui/subtasks-filter-modal.ts'), 'utf8');
 assert.equal(source.match(/applyDesktopModalBackdrop\(this.containerEl\)/g)?.length, 1);
 assert.match(source, /this.options.fileTaskPath \? null : applyDesktopModalBackdrop\(this.containerEl\)/);
 assert.match(source, /onClose\(\): void \{\s*this.backdropCleanup\?\.\(\);\s*this.backdropCleanup = null;/);
 assert.doesNotMatch(source.slice(source.indexOf('export function showSubtasksFilterPopover')), /applyDesktopModalBackdrop|registerDesktopBackdrop/);
 assert.doesNotMatch(readFileSync(path.join(root,'src/ui/dynamic-file-task-filter.ts'),'utf8'), /applyDesktopModalBackdrop|registerDesktopBackdrop/);
});
