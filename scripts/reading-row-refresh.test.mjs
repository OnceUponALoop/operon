import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(tmpdir(),'operon-reading-row-refresh-'));
try {
 const ast=ts.createSourceFile('row.ts',fs.readFileSync(path.join(root,'src/ui/reading-task-row.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(n=>n.name?.text==='updateReadingInlineTaskRow');assert.ok(fn);
 const output=path.join(dir,'test.mjs');
 await build({stdin:{resolveDir:root,loader:'ts',contents:`
 import {replaceTaskTimeScope,getTimeScopeSignature} from './src/core/time-scope-values';
 const retainedInlineRows=new WeakMap();
 export const counts={builds:0,descriptions:0};
 const prepareReadingTaskChips=(task,callbacks)=>callbacks.entries;
 const rememberInlineTaskDom=()=>{};
 const reconcileInlineTaskDom=(previous,next)=>{previous.display=next.display;};
 const buildReadingTaskRowElement=(task,callbacks,description,options)=>{counts.builds++;return {task,callbacks,display:{description,entries:options.preparedEntries}};};
 ${fn.getText(ast)}
 `},outfile:output,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 const {updateReadingInlineTaskRow:update,counts}=await import(pathToFileURL(output).href);
 let passed=0;const test=(name,fn)=>{fn();passed++;console.log('PASS',name);};
 const setup=()=>{
  let source={operonId:'task001',description:'Before',checkbox:'open',tags:['görev'],fieldValues:{priority:'A'},primary:{filePath:'A.md',format:'inline',lineNumber:1}};
  const callbacks={entries:[{key:'priority',label:'A'}],navigateToTask:()=> 'before'},options={refreshSignature:'context-1'};
  const description=()=>{counts.descriptions++;return source.description;};
  let row=update(null,source,callbacks,description,options);
  return {get row(){return row;},callbacks,options,source,draw(next=source){source=next;row=update(row,source,callbacks,description,options);return row;}};
 };
 test('unchanged refresh creates no description or draft row',()=>{const s=setup(),row=s.row,before={...counts};s.draw();assert.equal(s.row,row);assert.deepEqual(counts,before);});
 test('skipped render adopts the latest callbacks and model',()=>{const s=setup(),row=s.row;s.callbacks.navigateToTask=()=> 'latest';s.draw({...s.source});assert.equal(s.row,row);assert.equal(row.callbacks.navigateToTask(),'latest');assert.notEqual(row.task,s.source);});
 for(const [name,change] of [
  ['description',s=>s.source.description='After'],['checkbox',s=>s.source.checkbox='done'],['field',s=>s.source.fieldValues.priority='B'],['tags',s=>s.source.tags=['日本語']],
  ['source line',s=>s.source.primary.lineNumber=5],['shared settings/index/day context',s=>s.options.refreshSignature='context-2'],
  ['dependency/reminder/repeat/location display',s=>s.callbacks.entries=[{key:'relation',label:'Changed'}]],['pinned',s=>s.callbacks.isTaskPinned=()=>true],
  ['tracker',s=>s.callbacks.isTaskTracking=()=>true],['project serial',s=>s.callbacks.getProjectSerialDisplay=()=>({label:'P',number:2})],['action visibility',s=>s.options.showNoteAction=false],
 ])test('display invalidation: '+name,()=>{const s=setup(),before=counts.builds;change(s);s.draw();assert.equal(counts.builds,before+1);assert.equal(counts.descriptions,counts.builds);});
 test('source removal updates retained field values',()=>{const s=setup();s.draw({...s.source,fieldValues:{}});assert.deepEqual(s.row.task.fieldValues,{});});
 test('new identity/path and read-only mode replace the row',()=>{for(const next of [s=>({...s.source,operonId:'other01'}),s=>({...s.source,primary:{...s.source.primary,filePath:'B.md'}}),s=>{s.options.readOnly=true;return s.source;}]){const s=setup(),row=s.row;s.draw(next(s));assert.notEqual(s.row,row);}});
 test('blocked action rows never retain stale action guards when repaired',()=>{const s=setup();s.options.onBlockedAction=()=>{};s.draw();const blocked=s.row;delete s.options.onBlockedAction;s.draw();assert.notEqual(s.row,blocked);});
 test('existing callers without refresh signature continue rebuilding',()=>{const s=setup();delete s.options.refreshSignature;s.draw();const before=counts.builds;s.draw();assert.equal(counts.builds,before+1);});
 test('custom rendering hooks prevent the early skip',()=>{for(const key of ['beforeTailContent','beforeEditAction']){const s=setup();s.options[key]=()=>{};s.draw();const before=counts.builds;s.draw();assert.equal(counts.builds,before+1);}});
 console.log('Reading row refresh: '+passed+'/'+passed+' passed');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
