import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(tmpdir(),'operon-reading-filter-'));
try {
 const ast=ts.createSourceFile('main.ts',fs.readFileSync(path.join(root,'main.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='OperonPlugin');
 const names=['pruneDisconnectedDynamicFileTaskFilterReadingHosts','refreshDynamicFileTaskFilterReadingMount','getReadingPreviewContentRoot','removeDynamicFileTaskFilterHosts','destroyDynamicFileTaskFilterReadingHost','insertDynamicFileTaskFilterReadingHost','removeAllDynamicFileTaskFilterReadingHosts','scheduleDynamicFileTaskFilterReadingMount','clearDynamicFileTaskFilterReadingTimers','getDynamicFileTaskFilterMarkdownViews','isDynamicFileTaskFilterDocumentEditor'];
 const methods=names.map(name=>cls.members.find(n=>n.name?.getText(ast)===name).getText(ast)).join('\n');
 const embedded=ts.createSourceFile('embedded.ts',fs.readFileSync(path.join(root,'src/ui/embedded-markdown-source-editor.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 const fileBodyGuard=embedded.statements.find(n=>n.name?.text==='isEmbeddedMarkdownFileBodyEditor').getText(embedded);
 const output=path.join(dir,'test.mjs');
 await build({stdin:{resolveDir:root,loader:'ts',contents:`
 export const metrics={created:0,destroyed:0,moves:0};
 export const embeddedMarkdownSourceEditorRecords=new WeakMap();
 ${fileBodyGuard}
 const getEditorViewFromEditor=editor=>editor.cm;
 const getNativeLightboxLeaves=app=>app.ownedLeaves;

 const DYNAMIC_FILE_TASK_FILTER_HOST_CLASS='host';
 const applyDynamicFileTaskFilterHostPlacement=()=>{};
 const createFilterSurfaceInstance=el=>{metrics.created++;return {el,searchQuery:'',expandedTaskIds:new Set(),visibleTaskLimit:50};};
 const destroyFilterSurfaceInstance=i=>{metrics.destroyed++;i.observer?.disconnect();};
 const renderDynamicFileTaskFilterSurface=(i,path,deps)=>{i.path=path;return deps.enabled;};
 const cleanupOperonRenderRoot=()=>{};
 const asHTMLElement=x=>x;
 const timers=new Map();let timerId=0;
 const setWindowTimeout=fn=>{timers.set(++timerId,fn);return timerId;};
 const clearWindowTimeout=id=>timers.delete(id);
 export const flush=()=>{const calls=[...timers.values()];timers.clear();calls.forEach(fn=>fn());};
 export class Node {
  children=[];parentNode=null;connected=true;className='';ownerDocument={win:{createDiv:()=>new Node()}};
  get parentElement(){return this.parentNode;}get isConnected(){return this.connected&&(!this.parentNode||this.parentNode.isConnected);}
  get nextSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]??null;}
  hasClass(c){return this.className.split(' ').includes(c);}
  contains(n){return this===n||this.children.some(c=>c.contains(n));}
  remove(){if(this.parentNode)this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}
  insertBefore(n,ref){if(n===ref)return;metrics.moves++;n.remove();const at=ref?this.children.indexOf(ref):this.children.length;assertIndex(at);this.children.splice(at,0,n);n.parentNode=this;}
  querySelector(s){return this.querySelectorAll(s)[0]??null;}
  querySelectorAll(s){return this.children.flatMap(c=>[...(s.split(', ').some(sel=>c.hasClass(sel.slice(1)))?[c]:[]),...c.querySelectorAll(s)]);}
 }
 function assertIndex(n){if(n<0)throw Error('bad reference');}
 export class MarkdownView {file={path:'A.md'};editor={cm:{}};mode='preview';containerEl=new Node();getMode(){return this.mode;}}
 export class Harness {
  dynamicFileTaskFilterReadingHosts=new Set();dynamicFileTaskFilterReadingInstances=new WeakMap();dynamicFileTaskFilterReadingOwners=new WeakMap();dynamicFileTaskFilterReadingTimers=new Map();
  views=[];app={ownedLeaves:[],workspace:{getLeavesOfType:()=>this.views.map(view=>({view}))}};settings={dynamicFileTaskFilterPlacement:'body-top'};embedFilterDeps={enabled:true};
  openDynamicFileTaskFilterSettings(){}
  ${methods}
 }
 `},outfile:output,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 const {Harness,MarkdownView,Node,metrics,flush,embeddedMarkdownSourceEditorRecords}=await import(pathToFileURL(output).href);
 let count=0;const test=(name,fn)=>{fn();count++;console.log('PASS',name);};
 const setup=()=>{const h=new Harness(),view=new MarkdownView();h.views=[view];h.refreshDynamicFileTaskFilterReadingMount('A.md');const host=[...h.dynamicFileTaskFilterReadingHosts][0];return {h,view,host,instance:h.dynamicFileTaskFilterReadingInstances.get(host)};};
 test('unchanged refresh preserves instance, search, expansion, pagination and host position',()=>{
  const {h,host,instance}=setup();instance.searchQuery='query';instance.expandedTaskIds.add('child');instance.visibleTaskLimit=150;const before={...metrics};
  h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.equal(h.dynamicFileTaskFilterReadingInstances.get(host),instance);assert.equal(instance.searchQuery,'query');assert.ok(instance.expandedTaskIds.has('child'));assert.equal(instance.visibleTaskLimit,150);assert.deepEqual(metrics,before);
 });
 test('separate panels get separate instances',()=>{const {h,instance}=setup();h.views.push(new MarkdownView());h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.equal(h.dynamicFileTaskFilterReadingHosts.size,2);assert.ok([...h.dynamicFileTaskFilterReadingHosts].some(el=>h.dynamicFileTaskFilterReadingInstances.get(el)!==instance));});
 for(const reason of ['file','root','mode','closed','detached'])test('owner cleanup: '+reason,()=>{
  const {h,view,host,instance}=setup();let disconnected=0;instance.observer={disconnect(){disconnected++;}};
  if(reason==='file')view.file.path='B.md';if(reason==='root')view.containerEl=new Node();if(reason==='mode')view.mode='source';if(reason==='closed')h.views=[];if(reason==='detached')view.containerEl.connected=false;
  h.pruneDisconnectedDynamicFileTaskFilterReadingHosts();assert.equal(h.dynamicFileTaskFilterReadingHosts.has(host),false);assert.equal(disconnected,1);
  if(reason==='file'){h.refreshDynamicFileTaskFilterReadingMount('B.md');const next=[...h.dynamicFileTaskFilterReadingHosts][0];assert.notEqual(next,host);assert.equal(h.dynamicFileTaskFilterReadingInstances.get(next).searchQuery,'');}
 });
 test('disabled or missing file task removes surface and can later recreate it',()=>{const {h,host}=setup();h.embedFilterDeps.enabled=false;h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.equal(h.dynamicFileTaskFilterReadingHosts.size,0);h.embedFilterDeps.enabled=true;h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.notEqual([...h.dynamicFileTaskFilterReadingHosts][0],host);});
 test('placement moves the same host once and is idempotent',()=>{const {h,view,host,instance}=setup();const body=new Node(),pusher=new Node();pusher.className='markdown-preview-pusher';view.containerEl.insertBefore(body,null);view.containerEl.insertBefore(pusher,null);h.settings.dynamicFileTaskFilterPlacement='body-bottom';h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.equal(host.nextSibling,pusher);assert.equal(h.dynamicFileTaskFilterReadingInstances.get(host),instance);const moves=metrics.moves;h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.equal(metrics.moves,moves);h.settings.dynamicFileTaskFilterPlacement='body-top';h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.equal(host.nextSibling,body);});
 test('delayed mount cannot recreate a closed view; unload cancels timers',()=>{const {h}=setup();h.scheduleDynamicFileTaskFilterReadingMount('A.md');h.views=[];flush();assert.equal(h.dynamicFileTaskFilterReadingHosts.size,0);h.scheduleDynamicFileTaskFilterReadingMount('A.md');h.clearDynamicFileTaskFilterReadingTimers();h.removeAllDynamicFileTaskFilterReadingHosts();flush();assert.equal(h.dynamicFileTaskFilterReadingHosts.size,0);});

 test('filter ownership accepts full file views but not table cells or short editors',()=>{
  const h=new Harness(),normal=new MarkdownView(),lightbox=new MarkdownView();
  h.views=[normal];h.app.ownedLeaves=[{view:lightbox}];
  assert.equal(h.isDynamicFileTaskFilterDocumentEditor(normal.editor.cm),true);
  assert.equal(h.isDynamicFileTaskFilterDocumentEditor(lightbox.editor.cm),true);
  assert.equal(h.isDynamicFileTaskFilterDocumentEditor({dom:{isConnected:true}}),false);
  for(const [fileBody,filePath,connected,expected] of [[true,'A.md',true,true],[false,'A.md',true,false],[true,'',true,false],[true,'A.md',false,false]]){
   const editor={dom:{isConnected:connected}};
   embeddedMarkdownSourceEditorRecords.set(editor,{fileBody,filePath});
   assert.equal(h.isDynamicFileTaskFilterDocumentEditor(editor),expected);
   embeddedMarkdownSourceEditorRecords.delete(editor);
   assert.equal(h.isDynamicFileTaskFilterDocumentEditor(editor),false);
  }
 });
 test('normal and isolated Reading views retain independent instances and deduplicate ownership',()=>{
  const h=new Harness(),normal=new MarkdownView(),lightbox=new MarkdownView();
  h.views=[normal];h.app.ownedLeaves=[{view:lightbox},{view:normal}];
  h.refreshDynamicFileTaskFilterReadingMount('A.md');
  assert.equal(h.dynamicFileTaskFilterReadingHosts.size,2);
  const normalHost=[...h.dynamicFileTaskFilterReadingHosts].find(host=>h.dynamicFileTaskFilterReadingOwners.get(host).view===normal);
  const childHost=[...h.dynamicFileTaskFilterReadingHosts].find(host=>h.dynamicFileTaskFilterReadingOwners.get(host).view===lightbox);
  const child=h.dynamicFileTaskFilterReadingInstances.get(childHost);child.searchQuery='child draft';
  h.refreshDynamicFileTaskFilterReadingMount('A.md');
  assert.equal(h.dynamicFileTaskFilterReadingInstances.get(childHost),child);assert.equal(child.searchQuery,'child draft');
  assert.notEqual(h.dynamicFileTaskFilterReadingInstances.get(normalHost),child);
  h.app.ownedLeaves=[];h.pruneDisconnectedDynamicFileTaskFilterReadingHosts();
  assert.equal(h.dynamicFileTaskFilterReadingHosts.size,1);assert.ok(h.dynamicFileTaskFilterReadingHosts.has(normalHost));
 });
 test('isolated Reading owner changes mode/file and queued close cannot recreate it',()=>{
  const h=new Harness(),lightbox=new MarkdownView();h.app.ownedLeaves=[{view:lightbox}];
  h.refreshDynamicFileTaskFilterReadingMount('A.md');assert.equal(h.dynamicFileTaskFilterReadingHosts.size,1);
  lightbox.mode='source';h.pruneDisconnectedDynamicFileTaskFilterReadingHosts();assert.equal(h.dynamicFileTaskFilterReadingHosts.size,0);
  lightbox.mode='preview';lightbox.file.path='B.md';h.refreshDynamicFileTaskFilterReadingMount('B.md');
  const host=[...h.dynamicFileTaskFilterReadingHosts][0];assert.equal(h.dynamicFileTaskFilterReadingOwners.get(host).filePath,'B.md');
  h.scheduleDynamicFileTaskFilterReadingMount('B.md');h.app.ownedLeaves=[];flush();assert.equal(h.dynamicFileTaskFilterReadingHosts.size,0);
 });
 console.log('Reading filter lifecycle: '+count+'/'+count+' passed');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
