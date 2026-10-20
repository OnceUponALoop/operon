import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const ast = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
function find(node, predicate) {
 if (predicate(node)) return node;
 return ts.forEachChild(node, child => find(child, predicate));
}
function compile(text, deps = {}, result = '') {
 const js = ts.transpileModule(text, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return new Function(...Object.keys(deps), `${js}\n${result}`)(...Object.values(deps));
}
const core = {};
compile(read('src/core/subtask-action.ts'), {exports:core});
function fn(file, name, deps) {
 const tree = ast(file), node = find(tree, n => ts.isFunctionDeclaration(n) && n.name?.text === name);
 assert.ok(node, name);
 return compile(node.getText(tree).replace(/^export /,''), deps, `return ${name};`);
}
class El {
 constructor(tag='button') { this.tag=tag;this.children=[];this.events={};this.attrs={};this.style={setProperty(){}};this.classList={add(){},toggle(){}};this.outerHTML='<button></button>'; }
 appendChild(el) { this.children=this.children.filter(x=>x!==el);this.children.push(el); }
 setCssProps() {}
 setAttribute(k,v) { this.attrs[k]=v; }
 addEventListener(k,cb) { this.events[k]=cb; }
 getBoundingClientRect() { return {left:3,top:4}; }
 fire(k) { const e={preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};this.events[k]?.(e);return e; }
}
const common={...core,t:(_s,k)=>k,setIcon:(el,v)=>el.icon=v,setAccessibleLabelWithoutTooltip:(el,v)=>el.label=v,bindOperonHoverTooltip(){},bindLivePreviewChipHoverState(){},identifyInlineTaskPart:(el,k)=>el.key=k,createOwnerElement:(_p,tag)=>new El(tag),stopEvent:e=>{e.preventDefault();e.stopPropagation();}};
function render(surface, format, enabled=true, terminal=false) {
 const task={operonId:'parent',primary:{format},fieldValues:{},checkbox:terminal?'done':'open'};
 const calls=[],parent=new El('div'),settings={inlineTaskShowSubtaskAction:enabled,taskWikilinkOverlayShowSubtaskAction:enabled};
 const callbacks={requestSubtask:(...args)=>calls.push(args),getSettings:()=>settings};
 const file={live:'live-preview-conceal',reading:'reading-task-row',liveOverlay:'live-preview-task-wikilink-overlay',readingOverlay:'reading-task-wikilink-overlay'}[surface];
 const tree=ast(`src/ui/${file}.ts`);
 const node=find(tree,n=>ts.isIfStatement(n)&&n.expression.getText(tree).includes('requestSubtask')&&n.expression.getText(tree).includes('isTerminal'));
 assert.ok(node,surface);
 const deps={...common,task,callbacks,settings,isTerminal:terminal,operonId:task.operonId,showSubtaskAction:enabled,taskColor:'#123456',actions:parent,row:parent,wrap:parent,wrapper:parent,resolved:{task},visuals:{hoverColor:'#123456'},el:()=>new El(),createActionButton:(_c,_color,label,configure,click)=>{const b=new El();b.label=label;configure(b);b.addEventListener('click',click);return b;}};
 const self={task,indexedTask:task,callbacks,visuals:deps.visuals};
 compile(`function render(){${node.getText(tree)}};render.call(self);`,{...deps,self});
 return {buttons:parent.children,calls};
}
for(const surface of ['live','reading','liveOverlay','readingOverlay'])for(const format of ['yaml','inline'])test(`${surface}: ${format} buttons route once with distinct identity and labels`,()=>{
 const f=render(surface,format),file=format==='yaml';
 assert.deepEqual(f.buttons.map(b=>b.icon),file?['file-plus-corner','list-plus']:['list-plus']);
 assert.deepEqual(f.buttons.map(b=>b.label),file?['addFileSubtask','addInlineSubtask']:['addInlineSubtask']);
 assert.equal(new Set(f.buttons.map(b=>b.key)).size,f.buttons.length);
 f.buttons.forEach(b=>b.fire('click'));
 assert.deepEqual(f.calls,file?[['parent',undefined],['parent','inline']]:[['parent','inline']]);
 if(surface==='live'||surface==='liveOverlay')for(const b of f.buttons){const e=b.fire('mousedown');assert.ok(e.prevented&&e.stopped);}
});
for(const surface of ['live','reading','liveOverlay','readingOverlay'])test(`${surface}: disabled profile and terminal task suppress both buttons`,()=>{
 assert.equal(render(surface,'yaml',false).buttons.length,0);
 assert.equal(render(surface,'yaml',true,true).buttons.length,0);
});
const cardFile='src/ui/compact-card-chips.ts';
const build=fn(cardFile,'buildKanbanTaskActionChips',common);
for(const profileName of ['kanban','taskCard'])for(const format of ['yaml','inline'])test(`${profileName}: ${format} preserves action guards and requested kind`,()=>{
 const task={operonId:'parent',primary:{format},fieldValues:{},checkbox:'open'},calls=[];
 let mutable=true,targetReadOnly=false;
 const callbacks={onAction:(...args)=>calls.push(args),canMutate:()=>mutable};
 const profile={subtask:true};
 const actions=build(task,callbacks,{},profile,false);
 assert.equal(actions.length,format==='yaml'?2:1);
 assert.equal(build(task,callbacks,{}, {subtask:false},false).length,0);
 assert.equal(build({...task,checkbox:'done'},callbacks,{},profile,false).length,0);
 assert.equal(build(task,{}, {},profile,false).length,0);
 const create=fn(cardFile,'createKanbanTaskActionChipElement',{...common,isKanbanActionButtonElement:b=>b.tag==='button',buildKanbanTaskActionContext:()=>({surface:profileName}),createCompactTaskMarkdownTooltipContent(){}});
 for(const action of actions){
  const options={classPrefix:profileName,isTargetReadOnly:()=>targetReadOnly};
  const b=create(action,task,callbacks,new El(),null,false,false,options);
  assert.ok(b.fire('pointerdown').stopped);const drag=b.fire('dragstart');assert.ok(drag.prevented&&drag.stopped);
  mutable=false;b.fire('click');mutable=true;targetReadOnly=true;b.fire('click');targetReadOnly=false;
  const before=calls.length;b.fire('click');assert.equal(calls.length,before+1);
  assert.equal(calls.at(-1)[0],'parent');assert.equal(calls.at(-1)[1],'createSubtask');assert.equal(calls.at(-1)[3].requestedSubtaskKind,action.requestedSubtaskKind);
  const ro=create(action,task,callbacks,new El(),null,true,false,options);ro.fire('click');assert.equal(calls.length,before+1);assert.equal(ro.attrs['aria-disabled'],'true');
 }
 assert.deepEqual(calls.map(c=>c[3].requestedSubtaskKind),format==='yaml'?[undefined,'inline']:['inline']);
});
const mainTree=ast('main.ts');
function mainMethod(name,deps={}) {
 const node=find(mainTree,n=>ts.isMethodDeclaration(n)&&n.name?.getText(mainTree)===name);assert.ok(node,name);
 return compile(`class Subject { ${node.getText(mainTree)} }`,{...core,...deps},`return Subject.prototype.${name};`);
}
for(const format of ['yaml','inline'])for(const kind of [undefined,'inline'])test(`Creator route ${format}/${kind??'default'} preserves parent and commit guards`,async()=>{
 const indexed={primary:{format},fieldValues:{taskType:'old'}},parent={description:'parent',fields:[{key:'taskType',value:'current'}],tags:['tag']};
 const opened=[],canCommit=()=>false,acceptFile=()=>false;
 const self={redirectDuplicateOperonIdAction:()=>false,indexer:{getTask:()=>indexed},loadEditableParsedTask:async()=>parent,openFileSubtaskCreatorFromParent:(...a)=>opened.push(['file',...a]),openInlineSubtaskCreatorFromParent:(...a)=>opened.push(['inline',...a])};
 self.handleSubtaskRequest=mainMethod('handleSubtaskRequest');
 await mainMethod('requestSubtaskForParentId').call(self,'parent',canCommit,acceptFile,kind);
 assert.equal(opened.length,1);assert.equal(opened[0][0],format==='yaml'&&!kind?'file':'inline');
 const request=opened[0][1];assert.equal(request.canCommit,canCommit);assert.equal(request.acceptFile,acceptFile);assert.equal(request.parentOperonId,'parent');assert.deepEqual(request.parentTags,['tag']);assert.equal(request.parentFieldValues.taskType,'current');assert.equal(opened[0][2],parent);
});
test('duplicate or missing parent does not open Creator',async()=>{
 let opened=0;
 const method=mainMethod('requestSubtaskForParentId',{Notice:class {},t:()=>''});
 for(const duplicate of [true,false])await method.call({redirectDuplicateOperonIdAction:()=>duplicate,indexer:{getTask:()=>undefined},handleSubtaskRequest:()=>opened++},'missing');
 assert.equal(opened,0);
});
test('all five main callback adapters forward explicit kind',()=>{
 const adapters=[];function visit(n){if(ts.isPropertyAssignment(n)&&n.name.getText(mainTree)==='requestSubtask')adapters.push(n.initializer);ts.forEachChild(n,visit);}visit(mainTree);
 assert.equal(adapters.length,5);
 for(const node of adapters){const calls=[];const self={requestSubtaskForParentId:(...args)=>calls.push(args)};const callback=compile(`function bind(){return ${node.getText(mainTree)}}`,{},'return bind;').call(self);callback('parent','inline');assert.deepEqual(calls,[['parent',undefined,undefined,'inline']]);}
});
test('reading read-only gate, contextual source restrictions and profile adapters remain intact',()=>{
 assert.match(read('src/ui/reading-task-row.ts'),/const showSubtaskAction = !readOnly &&/);
 assert.match(read('main.ts'),/requestSubtaskForParentId\(id, invocation\?\.canMutate, context.surface === 'excalidrawTask' \? file => !this.isExcalidrawTaskSource\(file\) : undefined, invocation\?\.requestedSubtaskKind\)/);
 for(const [file,key] of [['src/ui/kanban/kanban-task-chips.ts','kanbanTaskShowSubtaskAction'],['src/ui/task-card-controls.ts','taskCardShowSubtaskAction']])assert.ok(read(file).includes(key));
});
