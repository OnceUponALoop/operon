import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=await mkdtemp(path.join(tmpdir(),'operon-top-filter-state-'));
try {
 const out=path.join(dir,'test.mjs');
 await build({stdin:{resolveDir:root,loader:'ts',contents:`
import assert from 'node:assert/strict';
import {Compartment,EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {editorInfoField,editorLivePreviewField} from 'obsidian';
import {DEFAULT_SETTINGS} from './src/types/settings';
import {compactEditorSurfaceScopeExtension} from './src/ui/editor-augmentation-scope';
import {operonIndexRefreshEffect} from './src/ui/live-preview-conceal';
import {operonDynamicFileTaskFilterLivePreviewExtension} from './src/ui/dynamic-file-task-filter';
const settings=structuredClone(DEFAULT_SETTINGS);settings.dynamicFileTaskFilterEnabled=true;settings.dynamicFileTaskFilterPlacement='body-top';
let fileTask={operonId:'root001',description:'File',checkbox:'open',tags:[],fields:[],fieldValues:{operonId:'root001'},primary:{filePath:'A.md',format:'yaml'}};
const deps={app:{metadataCache:{getCache:()=>null}},settings,getSettings:()=>settings,indexer:{getFileTaskByPath:()=>fileTask,getAllTasks:()=>fileTask?[fileTask]:[],getTask:()=>fileTask}};
const extension=operonDynamicFileTaskFilterLivePreviewExtension({getFilePath:()=> 'Fallback.md',getFilterDeps:()=>deps,openDynamicFilterSettings(){}});
const mode=new Compartment(),source=new Compartment(),scope=new Compartment();
const make=doc=>EditorState.create({doc,extensions:[mode.of(editorLivePreviewField),source.of(editorInfoField),scope.of([]),extension]});
const widgets=state=>{const result=[];for(const set of state.facet(EditorView.decorations)){assert.notEqual(typeof set,'function');set.between(0,state.doc.length,(from,to,value)=>result.push({from,to,block:value.spec.block,widget:value.spec.widget}));}return result;};
for(const doc of ['Body','---\\nType: Test\\n---\\nBody','---\\nType: Test\\n...\\nBody','---\\r\\nType: Test\\r\\n---\\r\\nBody']){
 const s=make(doc),w=widgets(s);assert.equal(w.length,1);assert.equal(w[0].block,true);assert.equal(w[0].from,s.doc.toString().indexOf('Body'));assert.equal(w[0].widget.filePath,'A.md');
}
assert.equal(widgets(make(''))[0].from,0);
const yaml='---\\nType: Test\\n---';assert.equal(widgets(make(yaml))[0].from,yaml.length);
let state=make('---\\nType: Test\\n---\\nBody'),prior=widgets(state)[0].from;
state=state.update({changes:{from:4,insert:'Extra: Value\\n'}}).state;assert.equal(widgets(state)[0].from,prior+13);
const unchanged=state.update({}).state;assert.equal(unchanged.facet(EditorView.decorations)[0],state.facet(EditorView.decorations)[0]);
settings.dynamicFileTaskFilterPlacement='body-bottom';state=state.update({effects:operonIndexRefreshEffect.of()}).state;assert.equal(widgets(state).length,0);
settings.dynamicFileTaskFilterPlacement='body-top';state=state.update({effects:operonIndexRefreshEffect.of()}).state;assert.equal(widgets(state).length,1);
settings.dynamicFileTaskFilterEnabled=false;state=state.update({}).state;assert.equal(widgets(state).length,0);settings.dynamicFileTaskFilterEnabled=true;
state=state.update({effects:scope.reconfigure(compactEditorSurfaceScopeExtension)}).state;assert.equal(widgets(state).length,0);
state=state.update({effects:scope.reconfigure([])}).state;assert.equal(widgets(state).length,1);
state=state.update({effects:mode.reconfigure([])}).state;assert.equal(widgets(state).length,0);
state=state.update({effects:mode.reconfigure(editorLivePreviewField)}).state;assert.equal(widgets(state).length,1);
state=state.update({effects:source.reconfigure([])}).state;
state=state.update({effects:source.reconfigure(editorInfoField.init(()=>({file:{path:'B.md'}})))}).state;assert.equal(widgets(state)[0].widget.filePath,'B.md');assert.equal(widgets(make('Body'))[0].widget.filePath,'A.md');
fileTask=null;state=state.update({effects:operonIndexRefreshEffect.of()}).state;assert.equal(widgets(state).length,0);
console.log('Top filter state: direct block, frontmatter, empty body, edits, no-op, placement, mode/scope, file isolation and missing file task passed');
`},outfile:out,bundle:true,format:'esm',platform:'node',logLevel:'silent',alias:{obsidian:path.join(root,'scripts/test-support/obsidian.ts')}});
 await import(pathToFileURL(out).href);
} finally {await rm(dir,{recursive:true,force:true});}
