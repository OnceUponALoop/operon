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
import {compactEditorSurfaceScopeExtension,operonEditorSurfaceScopeFacet} from './src/ui/editor-augmentation-scope';
import {operonIndexRefreshEffect} from './src/ui/live-preview-conceal';
import {operonDynamicFileTaskFilterLivePreviewExtension} from './src/ui/dynamic-file-task-filter';
const settings=structuredClone(DEFAULT_SETTINGS);settings.dynamicFileTaskFilterEnabled=true;settings.dynamicFileTaskFilterPlacement='body-top';
let fileTask={operonId:'root001',description:'File',checkbox:'open',tags:[],fields:[],fieldValues:{operonId:'root001'},primary:{filePath:'A.md',format:'yaml'}};
const deps={app:{metadataCache:{getCache:()=>null}},settings,getSettings:()=>settings,indexer:{getFileTaskByPath:()=>fileTask,getAllTasks:()=>fileTask?[fileTask]:[],getTask:()=>fileTask}};
let documentEditor=true;
const extension=operonDynamicFileTaskFilterLivePreviewExtension({isDocumentEditor:()=>documentEditor,getFilePath:()=> 'Fallback.md',getFilterDeps:()=>deps,openDynamicFilterSettings(){}});
const mode=new Compartment(),source=new Compartment(),scope=new Compartment();
const pending=new Map();let timer=0;
globalThis.window={setTimeout(fn){pending.set(++timer,fn);return timer;},clearTimeout(id){pending.delete(id);}};
const raw=doc=>EditorState.create({doc,extensions:[mode.of(editorLivePreviewField),source.of(editorInfoField),scope.of([]),extension]});
const qualify=initial=>{let state=initial;const view={get state(){return state;},dom:{isConnected:true,closest:()=>null},dispatch(tr){state=state.update(tr).state;}};const plugin=extension[1].create(view);const first=pending.values().next().value;pending.clear();if(first)first();plugin.destroy();pending.clear();return state;};
const make=doc=>qualify(raw(doc));
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
// Native table cells share the file context and Live Preview mode, but are not the owning editor.
documentEditor=false;assert.equal(widgets(qualify(raw('Cell content'))).length,0);
console.log('PASS native Markdown table cell rejects the document filter');
// Full file views remain eligible, including File Body and isolated native lightboxes.
documentEditor=true;assert.equal(widgets(make('File Body')).length,1);
console.log('PASS Task Editor file body accepts the document filter');
assert.equal(widgets(make('Lightbox file')).length,1);
console.log('PASS isolated lightbox file accepts the document filter');
// Compact short-field editors remain excluded even with a valid file context.
assert.equal(widgets(qualify(raw('Short field').update({effects:scope.reconfigure(compactEditorSurfaceScopeExtension)}).state)).length,0);
console.log('PASS short-field editor rejects the document filter');
// The default scope remains document: inline task extensions are not globally disabled.
assert.equal(raw('Body').facet(operonEditorSurfaceScopeFacet),'document');
documentEditor=true;assert.equal(widgets(make('Body')).length,1);
fileTask=null;state=state.update({effects:operonIndexRefreshEffect.of()}).state;assert.equal(widgets(state).length,0);
console.log('Top filter state: direct block, frontmatter, empty body, edits, no-op, placement, mode/scope, file isolation and missing file task passed');
`},outfile:out,bundle:true,format:'esm',platform:'node',logLevel:'silent',alias:{obsidian:path.join(root,'scripts/test-support/obsidian.ts')}});
 await import(pathToFileURL(out).href);
} finally {await rm(dir,{recursive:true,force:true});}
