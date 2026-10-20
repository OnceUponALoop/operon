import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const root = new URL('../src/ui/', import.meta.url);
function load(file, deps) {
 const source=readFileSync(new URL(file+'.ts',root),'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm,'');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};new Function('exports',...Object.keys(deps),js)(exports,...Object.values(deps));return exports;
}
class El {
 constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.value='';this.disabled=false;this.classes=new Set();this.classList={add:x=>this.classes.add(x),remove:x=>this.classes.delete(x)};}
 createEl(tag,opts){const el=new El(tag);if(typeof opts==='string')el.className=opts;else if(opts){el.className=opts.cls;el.textContent=opts.text;}this.children.push(el);return el;}
 createDiv(opts){return this.createEl('div',opts);} createSpan(opts){return this.createEl('span',opts);}
 appendChild(el){this.children=this.children.filter(x=>x!==el);this.children.push(el);}
 replaceChildren(){this.children=[];}
 addEventListener(key,fn){(this.events[key]??=[]).push(fn);}
 fire(key,extra={}){if(this.disabled&&key==='click')return;for(const fn of this.events[key]??[])fn({preventDefault(){},...extra});}
 select(){this.selected=true;}
 all(){return [this,...this.children.flatMap(x=>x.all())];}
}
function setup(overrides={}) {
 const panel=new El();const writes=[];let cancelled=0,closed=0,cleaned=0,editorOpened=0,editorClosed=0,editorOnClose;
 let closePanel;
 const module=load('field-pickers/custom/custom-text-field-picker',{
 t:(_ns,key)=>key,createButton:(text,cls,host)=>{const e=new El('button');e.className=cls;e.textContent=text;return e;},
 focusFloatingInput:e=>{e.focused=true;},getOwnerWindow:()=>({requestAnimationFrame:fn=>fn()}),
 setAccessibleLabelWithoutTooltip:(e,label)=>{e.accessibleLabel=label;},bindOperonHoverTooltip:(e,opts)=>{e.tooltip=opts.content;},cleanupOperonHoverTooltips:()=>{cleaned++;},
 createCustomFieldPanel:(_a,_o,cb)=>{let done=false;closePanel=()=>{if(!done){done=true;cb();}};return{panel,close:closePanel};},
 });
 const close=module.showCustomTextFieldPicker({}, {canonicalKey:'type',type:'text',label:'Type',value:'Project',candidates:['Project','Periodic','Log'],separateCurrentValue:true,onCommit:(...args)=>writes.push(args),canRemove:true,onRemove:key=>writes.push([key,'']),onCancel:()=>cancelled++,onClose:()=>closed++,editMultilineValue:cb=>{editorOpened++;editorOnClose=cb;return()=>{editorClosed++;cb();};},...overrides});
 const input=panel.all().find(e=>e.tag==='input');
 const button=text=>panel.all().find(e=>e.tag==='button'&&e.textContent===text);
 const current=panel.all().find(e=>e.className?.includes('current-value'));
 const options=()=>panel.all().filter(e=>e.className?.includes('picker-option')&&!e.className?.includes('current-value'));
 return {panel,input,button,current,options,writes,close,closePanel,get state(){return{cancelled,closed,cleaned,editorOpened,editorClosed};},finishEditor:()=>editorOnClose(),type:value=>{input.value=value;input.fire('input');}};
}
test('empty focused search displays all suggestions and separate current value',()=>{const f=setup();assert.equal(f.input.value,'');assert.equal(f.input.focused,true);assert.equal(f.options().length,3);assert.ok(f.options().every(e=>e.classes.has('operon-custom-text-picker-option--search')));assert.equal(f.current.accessibleLabel,'Project');assert.equal(f.current.tooltip,'Project');assert.ok(f.options().every(e=>!e.classes.has('is-active')));assert.equal(f.button('save').disabled,true);});
test('empty Enter and Save do not write',()=>{const f=setup();f.input.fire('keydown',{key:'Enter'});f.button('save').fire('click');assert.deepEqual(f.writes,[]);});
test('hover alone does not authorize empty Enter',()=>{const f=setup();f.options()[1].fire('mousemove');f.input.fire('keydown',{key:'Enter'});assert.deepEqual(f.writes,[]);});
test('arrow then empty Enter explicitly selects a suggestion',()=>{const f=setup();f.input.fire('keydown',{key:'ArrowDown'});f.input.fire('keydown',{key:'Enter'});assert.deepEqual(f.writes,[['type','Project']]);assert.equal(f.state.cancelled,0);assert.equal(f.state.closed,1);});
test('typed query keeps existing Enter choice behavior',()=>{const f=setup();f.type('Per');f.input.fire('keydown',{key:'Enter'});assert.deepEqual(f.writes,[['type','Periodic']]);});
test('new typed value saves once',()=>{const f=setup();f.type('New');assert.equal(f.button('save').disabled,false);f.button('save').fire('click');assert.deepEqual(f.writes,[['type','New']]);});
test('suggestion pointer saves original value',()=>{const f=setup({candidates:['[[Folder/Note|Alias]]']});f.options()[0].fire('mousedown');assert.deepEqual(f.writes,[['type','[[Folder/Note|Alias]]']]);});
for(const value of ['Project','https://example.com/raw?x=1','[[Folder/Note|Alias]]'])test('current value restores raw input: '+value,()=>{const f=setup({value});f.current.fire('click');assert.equal(f.input.value,value);assert.equal(f.input.selected,true);assert.deepEqual(f.writes,[]);});
test('Clear remains the only empty write',()=>{const f=setup();f.button('clear').fire('click');assert.deepEqual(f.writes,[['type','']]);assert.equal(f.state.cancelled,0);});
test('picker external close cancels without write',()=>{const f=setup();f.type('Uncommitted');f.closePanel();assert.deepEqual(f.writes,[]);assert.equal(f.state.cancelled,1);assert.equal(f.state.closed,1);assert.equal(f.state.cleaned,1);});
test('multiline handoff suppresses picker Cancel and Close until editor finishes',()=>{const f=setup({value:'first\r\nsecond'});f.current.fire('click');assert.deepEqual(f.writes,[]);assert.equal(f.input.value,'');assert.deepEqual(f.state,{cancelled:0,closed:0,cleaned:1,editorOpened:1,editorClosed:0});f.close();assert.equal(f.state.closed,1);assert.equal(f.state.editorClosed,1);});
test('default off preserves special text picker preload',()=>{const f=setup({separateCurrentValue:false});assert.equal(f.input.value,'Project');assert.equal(f.current,undefined);assert.equal(f.options().length,1);});
test('empty stored value has no current-value control',()=>{const f=setup({value:''});assert.equal(f.current,undefined);assert.equal(f.options().length,3);});
test('empty ranking is preserved',()=>{const f=setup({rankEmptyCandidates:items=>[...items].reverse()});assert.equal(f.options()[0].textContent,'Log');});
test('clearing typed search resets implicit selection',()=>{const f=setup();f.type('Pro');f.type('');f.input.fire('keydown',{key:'Enter'});assert.deepEqual(f.writes,[]);});
test('custom Table text routes to picker while ordinary text retains route',()=>{const m=load('table/table-text-edit-route',{});assert.equal(m.resolveTableTaskTextEditRoute({key:'custom',type:'text',group:'custom'},'value'),'picker');assert.equal(m.resolveTableTaskTextEditRoute({key:'taskType',type:'text',group:'task'},'value'),'picker');assert.equal(m.resolveTableTaskTextEditRoute({key:'other',type:'text'},'value'),'popover');});
function extract(file,name,deps) {
 const source=readFileSync(new URL(file+'.ts',root),'utf8');const ast=ts.createSourceFile('test.ts',source,ts.ScriptTarget.Latest,true);
 const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node,name);
 const js=ts.transpileModule(node.getText(ast).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function(...Object.keys(deps),js+`;return ${name};`)(...Object.values(deps));
}
for(const key of ['taskType','taskImage'])test('managed opt-in scope '+key,()=>{
 let captured;
 const open=extract('task-field-picker-dispatch','openManagedTaskDataFieldPicker',{
 getManagedTaskDataFieldPicker:()=>({canonicalKey:key,type:'text',label:'Type'}),normalizeCustomFieldRawValue:v=>v.trim(),collectManagedTaskDataFieldValueCandidates:()=>[],createEmptyQueryRanker:()=>()=>[],showCustomTextFieldPicker:(_a,opts)=>{captured=opts;return()=>{};},openCurrentTextValueEditor:()=>()=>{},
 });
 open({canonicalKey:key,settings:{keyMappings:[]},currentFieldValues:{[key]:'  first\nsecond  '},allTasks:[]});
 assert.equal(captured.separateCurrentValue,key==='taskType');if(key==='taskType')assert.equal(captured.value,'  first\nsecond  ');
});
test('custom Text opts in and preserves original source',()=>{
 let captured;
 const open=extract('task-field-picker-dispatch','openCustomTaskFieldPicker',{getCustomFieldMapping:()=>({canonicalKey:'client',type:'text'}),isProjectedCustomFieldType:()=>true,getCustomFieldLabel:()=> 'Client',normalizeCustomFieldRawValue:v=>v.trim(),createEmptyQueryRanker:()=>()=>[],collectCustomFieldValueCandidates:()=>[],showCustomTextFieldPicker:(_a,opts)=>{captured=opts;return()=>{};}});
 open({canonicalKey:'client',settings:{keyMappings:[]},currentFieldValues:{client:'\nraw\n'},allTasks:[]});assert.equal(captured.value,'\nraw\n');assert.equal(captured.separateCurrentValue,true);
});
test('Vault Text ignores legacy direct route and hands raw multiline to existing editor',()=>{
 let picker,editor;const writes=[];
 const open=extract('table/table-file-property-editor','openTableFilePropertyPicker',{toRawYamlPropertyExpectation:()=>({}),showCustomTextFieldPicker:(_a,opts)=>{picker=opts;return()=>{};},showTextFieldPopover:opts=>{editor=opts;return()=>{};},buildTableFilePropertyTextMutation:value=>({kind:'set',value})});
 open({field:{key:'Details',type:'text'},cellValue:{present:true,rawValue:'first\n[[Note|alias]]',normalizedValue:'first\\u000Aencoded'},candidates:[],textEditRoute:'popover',onMutation:x=>writes.push(x),sourcePath:'a.md'});
 assert.equal(picker.separateCurrentValue,true);assert.equal(picker.value,'first\n[[Note|alias]]');assert.equal(editor,undefined);picker.editMultilineValue(()=>{});assert.equal(editor.initialValue,picker.value);assert.equal(editor.editor.textPolicy,'task-note');assert.deepEqual(writes,[]);editor.onCommit('first\nchanged');assert.deepEqual(writes,[{kind:'set',value:'first\nchanged'}]);
});
test('multiline dispatcher delegates Table ownership rather than writing through picker',()=>{
 let value;const close=()=>{};
 const open=extract('task-field-picker-dispatch','openCurrentTextValueEditor',{showTextFieldPopover:()=>{throw Error('must reuse Table editor');}});
 assert.equal(open({onEditMultilineText:v=>{value=v;return close;}},'Client','first\nsecond',()=>{}),close);assert.equal(value,'first\nsecond');
});
test('both Table surfaces retain guarded multiline editor and focus restoration',()=>{
 for(const file of ['table/operon-table-view','embed-table-processor']){const source=readFileSync(new URL(file+'.ts',root),'utf8');assert.match(source,/onEditMultilineText: rawValue/);assert.match(source,/rawValue, fieldLabel, cellKey, key, true, true/);assert.match(source,/textPolicy: preserveLineBreaks \? 'task-note' : 'single-line'/);assert.match(source,/success === false && closeTextPopover && owned/);assert.match(source,/if \(cell.isConnected\) cell.focus\(\)/);}
});
