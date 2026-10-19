import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function extract(file,name,deps={}) {
 const source=readFileSync(`src/ui/${file}.ts`,'utf8');
 const ast=ts.createSourceFile('subject.ts',source,ts.ScriptTarget.Latest,true);
 const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node,name);
 const js=ts.transpileModule(node.getText(ast).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function(...Object.keys(deps),`${js}; return ${name};`)(...Object.values(deps));
}
function fixture(surface,{format='inline',readonly=false}={}) {
 let context,mutable=true,blocked=false;
 const writes=[];
 const task={operonId:'task-a',filePath:'a.md',primary:{filePath:'a.md',format},tags:[],fieldValues:{customText:'old'}};
 let latest={...task,fieldValues:{customText:'fresh'}};
 const callbacks={app:{},getSettings:()=>({keyMappings:[]}),getAllTasks:()=>[latest].filter(Boolean),getTaskById:()=>latest,canMutate:()=>mutable,updateField:(...a)=>writes.push(a)};
 const deps={bindDesktopChipOpening:(_chip,_entry,c)=>{context=c;return true;},getLivePreviewCurrentFieldValues:()=>({...latest.fieldValues,customText:'unsaved editor value'}),getLivePreviewDescriptionEndCursor:()=>17,snapshotLivePreviewAnchor:()=>({left:1,top:2,width:10,height:10})};
 deps.commitKanbanChipPayload=extract('compact-card-chips','commitKanbanChipPayload');
 const chip={},entry={key:'customText'};
 if(surface==='live')extract('live-preview-conceal','attachLivePreviewChipAction',deps)(chip,entry,{},task.fieldValues,null,callbacks,task.tags,task);
 if(surface==='reading')extract('reading-task-row','attachReadingChipAction',deps)(chip,entry,task,callbacks);
 if(surface==='card')extract('compact-card-chips','attachKanbanChipAction',deps)(chip,entry,task,callbacks,[task],()=>blocked,undefined,!readonly);
 if(surface==='overlay')extract('task-wikilink-overlay-chips','attachOverlayChipAction',deps)(chip,entry,callbacks,task);
 return {context,writes,callbacks,setLatest:value=>latest=value,task,block:()=>blocked=true,lock:()=>mutable=false};
}
for(const surface of ['live','reading','card','overlay'])for(const format of ['inline','yaml'])test(`${surface}/${format}: live task context, unchanged writer and no-write close`,()=>{
 const f=fixture(surface,{format});const current=f.context.getTask();assert.equal(current.primary.format,format);
 assert.equal(current.fieldValues.customText,surface==='live'?'unsaved editor value':'fresh');
 const picker=f.context.picker(current);assert.deepEqual(f.writes,[]);
 picker.onCommit({customText:'new',customList:['one','two']});assert.equal(f.writes[0][0],'task-a');assert.equal(f.writes[0][2],'new');assert.equal(f.writes[1][2],'one; two');
 if(surface==='live'){assert.equal(f.writes[0][3],17);assert.equal(picker.retainInputFocus,true);assert.equal(picker.anchor.left,1);}
 f.setLatest(null);assert.equal(f.context.getTask()==null,true);
});
test('card preserves readonly navigation, mutation lease at commit, and interaction blocker',()=>{
 const readonly=fixture('card',{readonly:true});assert.equal(readonly.context.canActivate(),true);assert.equal(readonly.context.picker(readonly.context.getTask()),null);
 const f=fixture('card');const picker=f.context.picker(f.context.getTask());f.lock();picker.onCommit({customText:'new'});assert.deepEqual(f.writes,[]);assert.equal(f.context.picker(f.context.getTask()),null);f.block();assert.equal(f.context.canActivate(),false);
});
test('overlay writer absence denies picker; reading blocked callback continues to reject writes',()=>{
 const overlay=fixture('overlay');delete overlay.callbacks.updateField;assert.equal(overlay.context.picker(overlay.context.getTask()),null);
 const f=fixture('reading');let blocked=0;f.callbacks.updateField=extract('reading-task-row','guardReadingTaskRowActions')(f.callbacks,()=>blocked++).updateField;f.context.picker(f.context.getTask()).onCommit({customText:'new'});assert.equal(blocked,1);assert.deepEqual(f.writes,[]);
});

test('retained overlay and Live Preview signatures include exact list identity',()=>{
 const overlay=extract('task-wikilink-overlay-chips','getTaskWikilinkOverlayChipSignature',{
  shouldResolveLocationCompactChips:()=>false,
  buildInlineTaskCompactChipEntries:fields=>[{key:'customList',label:'Alias',rawValue:fields.customList}],
 });
 const task={fieldValues:{customList:'[[B.md|Alias]]'},tags:[],primary:{filePath:'A.md'}};
 const before=overlay(task,{}, {taskWikilinkOverlayCompactChips:[]},[]);
 task.fieldValues.customList='![[B.md|Alias]]';assert.notEqual(overlay(task,{}, {taskWikilinkOverlayCompactChips:[]},[]),before);
 assert.match(readFileSync('src/ui/live-preview-conceal.ts','utf8'),/entry.rawValue \?\? ''/);
});

function extractTable(file,name,deps={},method=false) {
 const source=readFileSync(`src/ui/${file}.ts`,'utf8'),ast=ts.createSourceFile('table.ts',source,ts.ScriptTarget.Latest,true);
 let found;function visit(node){if((method?ts.isMethodDeclaration(node):ts.isFunctionDeclaration(node))&&node.name?.getText(ast)===name)found=node;ts.forEachChild(node,visit);}visit(ast);assert.ok(found,name);
 const body=method?`function ${name}${found.getText(ast).slice(found.getText(ast).indexOf('('))}`:found.getText(ast).replace(/^export /,'');
 const js=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function(...Object.keys(deps),`${js};return ${name};`)(...Object.values(deps));
}
function tableControl() {
 const events=new Map(),attrs={},children=[];
 const cell={events,attrs,children,dataset:{},isConnected:true,tabIndex:-1,classList:{add(){},remove(){}},addClass(){},removeClass(){},setAttribute(k,v){attrs[k]=v;},removeAttribute(k){delete attrs[k];},
  addEventListener(k,fn){events.set(k,fn);},createEl(){const c=tableControl();children.push(c);return c;},createSpan(){return this.createEl();},focus(){}};
 return cell;
}
for(const surface of ['standalone','embedded'])for(const readonly of [false,true])test(`Table ${surface}: Parent cell background keeps picker; links and readonly never start editor writes (${readonly})`,()=>{
 const cell=tableControl(),task={operonId:'task',primary:{filePath:'A.md',format:'yaml'},fieldValues:{parentTask:'parent'},tags:[]};
 const state={pendingCellKey:null,tableCellOpeners:new WeakMap(),callbacks:{onUpdateTaskFields:readonly?undefined:()=>{throw Error('unexpected write');}},indexer:{getTask:()=>({}),getAllTasks:()=>[]},syncPendingCellState(){},closeActivePicker(){}};
 let picker=0;const openers=new WeakMap();
 const deps={Platform:{isDesktopApp:true},resolveTableParentTaskActivation:()=>{throw Error('old desktop Parent route');},buildTableEditableCellKey:()=> 'cell',getTableTaskFieldLabel:()=> 'Parent',t:()=> 'Edit',setAccessibleLabelWithoutTooltip(){},getTableTaskField:()=>({type:'text'}),resolveTableTaskTextEditRoute:()=> 'picker',
  isCompactTaskMarkdownLinkEventTarget:target=>!!target?.link,getOwnerWindow:()=>({setTimeout(){}}),openTaskFieldPicker:()=>{picker++;return ()=>{};},snapshotFloatingRectAnchor:()=>({}),getExcludedTablePickerTaskIds:()=>[],getTableManualDatePickerOptions:()=>undefined,
  canWriteEmbedTable:()=>!readonly,findEmbedTableInstance:()=>state,syncEmbedTablePendingCellState(){},closeEmbedTableActivePicker(){},embedTableCellOpeners:openers};
 const renderState={settings:{}};
 if(surface==='standalone')extractTable('table/operon-table-view','decorateEditableTaskCell',deps,true).call(state,cell,task,'parentTask','Parent',renderState,true);
 else extractTable('embed-table-processor','decorateEmbedTableEditableTaskCell',deps)(cell,task,'parentTask','Parent',renderState,{indexer:state.indexer},true);
 const fire=(name,target=cell)=>cell.events.get(name)?.({button:0,detail:1,key:'Enter',target,preventDefault(){},stopPropagation(){}});
 fire('pointerdown',{link:true});fire('click',{link:true});fire('keydown',{link:true});assert.equal(picker,0);
 fire('pointerdown');fire('click');assert.equal(picker,readonly?0:1);
 fire('keydown');assert.equal(picker,readonly?0:2);
 assert.equal((surface==='standalone'?state.tableCellOpeners:openers).has(cell),!readonly);
});
for(const surface of ['standalone','embedded'])for(const icon of [false,true])test(`Table ${surface}: Source ${icon?'Icon Only':'Detailed'} has one actionable control`,()=>{
 const cell=tableControl(),task={operonId:'task',primary:{filePath:'A.md',format:'yaml'}},bound=[];
 const bind=(control)=>{bound.push(control);return true;};
 const state={callbacks:{onOpenTaskSource:()=>{throw Error('old source route');}},shouldUseIconOnlyColumn:()=>icon,renderIconOnlyCell(){},bindTableValueOpening:bind};
 const deps={Platform:{isDesktopApp:true},formatTableTaskSource:()=> 'A.md',setAccessibleLabelWithoutTooltip(){},t:()=> 'Open',setIcon(){},shouldUseEmbedTableIconOnlyColumn:()=>icon,renderEmbedTableIconOnlyCell(){},bindEmbedTableValueOpening:bind};
 if(surface==='standalone')extractTable('table/operon-table-view','renderSourceCell',deps,true).call(state,cell,task,{},'A.md',{settings:{}});
 else extractTable('embed-table-processor','renderEmbedTableSourceCell',deps)(cell,task,{},'A.md',{settings:{}},{});
 assert.equal(bound.length,1);assert.equal(bound[0],icon?cell:cell.children[0]);assert.equal(cell.events.size,0);
});

test('Table native List renderer preserves typed members and item-specific picker index',()=>{
 const cell=tableControl(),bound=[],edited=[];
 const deps={decorateTableDateValueChip(){},applyTableColumnCellAccent(){},decorateTableListValueChip(){},encodeVaultPropertyValue:value=>String(value[0]),formatTableCellListChipDisplayValue:value=>value};
 const render=extractTable('table/table-file-property-editor','renderTableFilePropertyValue',deps);
 render({cell,field:{type:'list'},label:'Native',cellValue:{rawValue:[42,'[[B.md|Alias]]','plain'],normalizedValue:'',nativeState:'ready'},column:{displayMode:'detailed'},editable:true,
  bindOpening:(chip,member,index)=>{bound.push({chip,member,index});return true;},onEditListMember:index=>edited.push(index)});
 assert.deepEqual(bound.map(({member,index})=>[member,index]),[['[[B.md|Alias]]',1],['plain',2]]);
 const number=cell.children[0].children[0];number.events.get('click')({stopPropagation(){}});assert.deepEqual(edited,[0]);
 assert.equal(bound[0].chip.events.has('click'),false); // the binder owns this, no second editing handler
});
test('Table Markdown renderer opt-in delegates once and never installs its legacy opening alongside it',()=>{
 const parent=tableControl();let delegated=0,legacy=0;
 const deps={createOwnerElement:()=>tableControl(),canActivateLink:()=>true,bindTaskDescriptionWikilinkPreview:()=>legacy++};
 parent.appendChild=child=>parent.children.push(child);
 const append=extract('compact-task-markdown-renderer','appendLink',deps);
 append(parent,{type:'wikilink',target:'B.md',label:'Alias'},{mode:'interactive',bindLink:(_anchor,node)=>{delegated++;assert.equal(node.target,'B.md');}});
 assert.equal(delegated,1);assert.equal(legacy,0);assert.equal(parent.children[0].events.size,0);
});

function extractMainSourceAction(deps) {
 const source=readFileSync('main.ts','utf8'),ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
 const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='OperonPlugin');
 const method=cls.members.find(n=>n.name?.getText(ast)==='handleContextualMenuAction');
 const js=ts.transpileModule(`class Harness {${method.getText(ast)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function(...Object.keys(deps),`${js};return Harness.prototype.handleContextualMenuAction;`)(...Object.values(deps));
}
for(const desktop of [true,false])test(`context menu Source routes ${desktop?'desktop through shared preview':'mobile through existing navigation'} without mutations`,async()=>{
 const anchor={ownerDocument:{name:'secondary'}},body={},calls=[],platform={isDesktopApp:desktop};
 let task={operonId:'task',primary:{filePath:'A.md',format:'inline'},fieldValues:{}};
 const handler=extractMainSourceAction({Platform:platform,Notice:class{constructor(){throw Error('navigation must remain allowed');}},getActiveDocument:()=>({body}),
  executeContextualMenuAction:async(context,action,deps)=>{assert.equal(action,'jumpToSource');await deps.jumpToSource(context.taskId);},
  resolveChipOpening:(entry,context)=>{assert.equal(entry.key,'taskInfo.source');return context.getTask();},
  activateResolvedOpening:async(actual,context,event)=>{assert.equal(actual,anchor);assert.equal(event,undefined);assert.equal(context.resolve(),task);const latest={...task,primary:{filePath:'Moved.md',format:'inline'}};task=latest;assert.equal(context.resolve(),latest);calls.push('lightbox');},
 });
 const host={app:{},settings:{},indexer:{getTask:()=>task,getAllTasks:()=>[task]},navigateToTask:current=>{assert.equal(current,task);calls.push('native');}};
 await handler.call(host,'task','jumpToSource',{taskId:'task'},{actionAnchor:anchor,canMutate:()=>false});
 assert.deepEqual(calls,[desktop?'lightbox':'native']);
 task=null;await handler.call(host,'task','jumpToSource',{taskId:'task'},{actionAnchor:anchor});assert.equal(calls.length,1);
});
for(const actionId of ['jumpToSource','openEditor'])for(const origin of ['trigger','host'])test(`context menu ${actionId} retains ${origin==='trigger'?'trigger':'custom host'} ownership after closing`,()=>{
 let click,invocation;const source={isConnected:true,ownerDocument:{name:'secondary'}};
 const label={textContent:'Open Source'},button={dataset:{},createSpan(){},getBoundingClientRect:()=>({left:4}),querySelector:()=>label,addEventListener:(name,fn)=>{if(name==='click')click=fn;}};
 const menu={children:[],querySelectorAll:()=>[],insertBefore:child=>menu.children.push(child)};
 const controller={activeTrigger:origin==='trigger'?source:null,options:{getHost:()=>source},hide(){this.activeTrigger=null;button.isConnected=false;}};
 const update=extractTable('contextual-hover-menu','updateActions',{getOwnerDocument:()=>({win:{createEl:()=>button}}),getOwnerBody:()=>({}),setIcon(){},setAccessibleLabelWithoutTooltip(){}},true);
 update.call(controller,menu,{taskId:'task',actions:[{id:actionId,icon:'arrow-up-right',label:'Open Source'}],onAction:(_id,_action,_context,value)=>{invocation=value;}});
 click({preventDefault(){},stopPropagation(){}});
 assert.equal(invocation.actionAnchor,actionId==='jumpToSource'?source:button);assert.equal(button.isConnected,false);
});
test('Open Source retains the saved context-menu action identity and localized labels',()=>{
 const english=JSON.parse(readFileSync('i18n/locales/en.json','utf8'));
 const turkish=JSON.parse(readFileSync('i18n/locales/tr.json','utf8'));
 assert.equal(english.settings.contextualMenuActionJumpToSource,'Open Source');assert.equal(turkish.settings.contextualMenuActionJumpToSource,'Kaynağı aç');
 assert.match(readFileSync('src/core/contextual-menu-engine.ts','utf8'),/id: 'jumpToSource',\s+labelKey: 'contextualMenuActionJumpToSource'/);
});
