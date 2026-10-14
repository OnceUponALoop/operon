import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(tmpdir(),'operon-dynamic-layout-'));
try {
 const ast=ts.createSourceFile('dynamic.ts',fs.readFileSync(path.join(root,'src/ui/dynamic-file-task-filter.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 const start=ast.statements.findIndex(n=>n.name?.text==='applyDynamicFileTaskFilterHostPlacement');
 const declarations=ast.statements.slice(start).filter(n=>ts.isFunctionDeclaration(n)&&!['getDynamicFileTaskFilterTemplate','getDynamicSubtasksFilterTemplate'].includes(n.name.text)).map(n=>n.getText(ast)).join('\n');
 const output=path.join(dir,'test.mjs');
 await build({stdin:{resolveDir:root,loader:'ts',contents:`
 const ViewPlugin={fromClass:C=>C},editorLivePreviewField={},editorInfoField={},operonIndexRefreshEffect={};
 const StateField={define:s=>s},StateEffect={define:()=>({of:value=>({value})})},WidgetType=class{},Decoration={},EditorView={},operonEditorSurfaceScopeFacet={};
 const DYNAMIC_FILE_TASK_FILTER_HOST_CLASS='host',DYNAMIC_FILE_TASK_FILTER_PLACEMENT_CLASSES=['host--body-top','host--body-bottom'];
 const isPlainCheckboxPopoverEditorElement=()=>false,allowsOperonDocumentAugmentations=()=>true;
 const createOwnerElement=(_owner,tag)=>new Node(tag);
 const getOwnerWindow=()=>({});
 const createFilterSurfaceInstance=el=>({el});
 const destroyFilterSurfaceInstance=()=>{metrics.destroyed++;};
 const resolveDynamicFileTaskFilterContext=(_path,deps)=>deps.getSettings().enabled?{}:null;
 const renderDynamicFileTaskFilterSurface=(i,path,deps)=>{metrics.renders++;i.path=path;return deps.getSettings().enabled;};
 let phase='',timers=new Map(),serial=0;
 const window={setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout(id){timers.delete(id);}};
 export const metrics={renders:0,destroyed:0,moves:0,reads:0,writes:0,requests:0,dispatches:0};
 export class Node {
  children=[];parentNode=null;isConnected=true;rect={left:0,right:400,width:400,height:20,bottom:100};
  classes=new Set();style={values:new Map(),getPropertyValue:n=>this.style.values.get(n)??'',setProperty:(n,v)=>{metrics.writes++;if(phase==='read')throw Error('write during measure read');this.style.values.set(n,v);},removeProperty:n=>{metrics.writes++;this.style.values.delete(n);}};
  classList={contains:n=>this.classes.has(n),add:(...names)=>names.forEach(n=>this.classes.add(n)),remove:(...names)=>names.forEach(n=>this.classes.delete(n))};
  set className(v){this.classes=new Set(v.split(' '));}get className(){return [...this.classes].join(' ');}
  get parentElement(){return this.parentNode;}get nextSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]??null;}get firstChild(){return this.children[0]??null;}
  instanceOf(){return true;}setAttribute(){}remove(){if(this.parentNode)this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}
  insertBefore(n,ref){if(n===ref)return;metrics.moves++;n.remove();const at=ref?this.children.indexOf(ref):this.children.length;if(at<0)throw Error('bad insert');this.children.splice(at,0,n);n.parentNode=this;return n;}
  appendChild(n){return this.insertBefore(n,null);}
  matches(s){return s==='*'||s.startsWith('.')&&this.classes.has(s.slice(1));}
  closest(s){for(let n=this;n;n=n.parentNode)if(n.matches(s))return n;return null;}
  querySelectorAll(s){const parts=s.split(' '),last=parts.pop();return this.children.flatMap(c=>[...(c.matches(last)&&(!parts.length||c.parentNode?.closest(parts.join(' ')))?[c]:[]),...c.querySelectorAll(s)]);}
  querySelector(s){for(const candidate of s.split(', ')){const found=this.querySelectorAll(candidate)[0];if(found)return found;}return null;}
  getBoundingClientRect(){metrics.reads++;if(phase!=='read')throw Error('layout read outside requestMeasure');return this.rect;}
 }
 const HTMLElement=Node;
 ${declarations}
 export function setup(placement='body-top'){
  Object.keys(metrics).forEach(k=>metrics[k]=0);timers.clear();
  const source=new Node(),dom=source.appendChild(new Node()),sizer=dom.appendChild(new Node()),contentContainer=sizer.appendChild(new Node()),content=contentContainer.appendChild(new Node()),line=content.appendChild(new Node());
  source.className='markdown-source-view';sizer.className='cm-sizer';contentContainer.className='cm-contentContainer';content.className='cm-content';line.className='cm-line';contentContainer.rect.bottom=300;line.rect.bottom=100;
  const settings={enabled:true,dynamicFileTaskFilterPlacement:placement};let file='A.md',live=true;
  const requests=new Map(),state={facet:()=> 'document',field:f=>f===editorLivePreviewField?live:f===editorInfoField?undefined:{filePath:file,height:20}},view={dom,state,dispatch(){metrics.dispatches++;},requestMeasure(r){metrics.requests++;requests.set(r.key,r);}};
  const callbacks={getFilePath:()=>file,getFilterDeps:()=>({getSettings:()=>settings}),openDynamicFilterSettings(){}};
  const C=operonDynamicFileTaskFilterLivePreviewExtension(callbacks),plugin=new C[1](view);
  const flush=()=>{for(let i=0;timers.size&&i<5;i++){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());}const pending=[...requests.values()];requests.clear();phase='read';const reads=pending.map(r=>r.read());phase='write';pending.forEach((r,i)=>r.write(reads[i]));phase='';};
  const update=changes=>plugin.update({view,state,transactions:[],docChanged:false,viewportChanged:false,geometryChanged:false,focusChanged:false,...changes});
  flush();return {plugin,view,sizer,contentContainer,content,line,settings,requests,flush,update,get host(){return plugin.hostEl;},setFile:p=>file=p,setLive:value=>live=value};
 }
 `},outfile:output,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 const {setup,metrics,Node}=await import(pathToFileURL(output).href);
 let count=0;const test=(name,fn)=>{fn();count++;console.log('PASS',name);};
 test('top viewport refresh does not render, move, measure or write styles',()=>{const s=setup(),before={...metrics};s.update({viewportChanged:true});s.flush();assert.deepEqual(metrics,before);s.plugin.destroy();});
 test('geometry refresh reads but does not repeat unchanged CSS or placement writes',()=>{const s=setup(),before={...metrics};s.update({geometryChanged:true});s.flush();assert.ok(metrics.reads>before.reads);assert.equal(metrics.writes,before.writes);assert.equal(metrics.moves,before.moves);assert.equal(metrics.renders,before.renders);s.plugin.destroy();});
 test('top resize leaves width to the block CSS without rendering content',()=>{const s=setup(),before={...metrics};s.line.rect.width=250;s.line.rect.right=250;s.update({geometryChanged:true});s.flush();assert.equal(s.host.style.getPropertyValue('--operon-dynamic-file-task-filter-width'),'');assert.equal(metrics.renders,before.renders);assert.equal(metrics.writes,before.writes);s.plugin.destroy();});
 test('bottom viewport recalculates virtual gap and preserves live theme spacing',()=>{const s=setup('body-bottom'),before={...metrics};assert.equal(s.host.style.getPropertyValue('--operon-dynamic-file-task-filter-margin-top'),'calc(var(--operon-dynamic-file-task-filter-spacing, 8px) - 200px)');s.line.rect.bottom=200;s.update({viewportChanged:true});s.flush();assert.equal(s.host.style.getPropertyValue('--operon-dynamic-file-task-filter-margin-top'),'calc(var(--operon-dynamic-file-task-filter-spacing, 8px) - 100px)');assert.equal(metrics.renders,before.renders);assert.equal(metrics.moves,before.moves);s.plugin.destroy();});
 test('bottom measurement includes tall descendants and clears zero gap',()=>{const s=setup('body-bottom'),chip=s.line.appendChild(new Node());chip.rect.bottom=280;s.update({geometryChanged:true});s.flush();assert.match(s.host.style.getPropertyValue('--operon-dynamic-file-task-filter-margin-top'),/20px/);chip.rect.bottom=320;s.update({geometryChanged:true});s.flush();assert.equal(s.host.style.getPropertyValue('--operon-dynamic-file-task-filter-margin-top'),'');s.plugin.destroy();});
 test('burst updates keep one request and retain pending content invalidation',()=>{const s=setup(),before=metrics.renders;s.update({docChanged:true});s.update({viewportChanged:true});s.flush();assert.equal(metrics.renders,before+1);s.plugin.destroy();});
 test('destroy cancels timers and invalidates queued measurements',()=>{const s=setup();s.update({docChanged:true});s.plugin.destroy();const before={...metrics};s.flush();assert.deepEqual(metrics,before);});
 test('queued measurement cannot write after destroy',()=>{const s=setup();s.plugin.measureFrame(s.view,s.sizer,s.host,'body-top');assert.equal(s.requests.size,1);s.plugin.destroy();const before={...metrics};s.flush();assert.deepEqual(metrics,before);});
 test('mode exit and disabled feature destroy; returning recreates',()=>{const s=setup();s.setLive(false);s.update({});s.flush();assert.equal(s.host,null);s.setLive(true);s.update({});s.flush();assert.ok(s.host);s.settings.enabled=false;s.update({docChanged:true});s.flush();assert.equal(s.host,null);s.plugin.destroy();});
 test('file switch resets the surface instance',()=>{const s=setup(),before=s.plugin.instance;s.setFile('B.md');s.update({});s.flush();assert.notEqual(s.plugin.instance,before);assert.equal(s.plugin.instance.path,'B.md');s.plugin.destroy();});
 test('placement changes preserve host and remove obsolete offset',()=>{const s=setup('body-bottom'),host=s.host;s.settings.dynamicFileTaskFilterPlacement='body-top';s.update({});s.flush();assert.equal(s.host,host);assert.equal(host.style.getPropertyValue('--operon-dynamic-file-task-filter-margin-top'),'');assert.ok(host.classList.contains('operon-dynamic-file-task-filter-host--block'));s.plugin.destroy();});
 test('detached top host survives viewport refresh without re-render',()=>{const s=setup(),host=s.host,before={...metrics};host.isConnected=false;s.update({viewportChanged:true});s.flush();assert.equal(s.host,host);assert.deepEqual(metrics,before);s.plugin.destroy();});
 test('fallback remount uses field context without dispatch during rendering',()=>{const s=setup();s.setFile('B.md');const field=s.view.state.field;s.view.state.field=f=>{const value=field(f);return value&&typeof value==='object'?{...value,filePath:'A.md'}:value;};const before=metrics.dispatches;s.plugin.mountTop(s.view,'A.md');assert.equal(metrics.dispatches,before);assert.equal(s.plugin.instance.path,'A.md');s.plugin.destroy();});
 console.log('Dynamic filter layout: '+count+'/'+count+' passed');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
