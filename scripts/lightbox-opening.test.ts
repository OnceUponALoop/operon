import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Platform, TFile } from 'obsidian';
import { lightboxFixture } from './test-support/lightbox-dom';
import { openLightbox } from '../src/ui/lightbox';
import { openLightboxTarget, resolveLightboxFile } from '../src/ui/lightbox-opening';
import { disposeWebLightboxes, flushLightboxMarkdown, openWebLightbox, prepareLightboxTab } from '../src/ui/web-lightbox';
import { getNativeLightboxLeaves } from '../src/ui/native-lightbox-lifecycle';
import { bindTaskMediaChipPreview, cleanupTaskMediaChipPreviews } from '../src/ui/compact-chip-link-preview';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(extension = 'md') {
 const f = lightboxFixture(); const desktop = Platform.isDesktopApp, mac = Platform.isMacOS;
 Platform.isDesktopApp = true; Platform.isMacOS = true;
 const observer = globalThis.ResizeObserver;
 globalThis.ResizeObserver = class { observe() {} disconnect() {} } as any;
 const file = new (TFile as any)(`Folder/Note.${extension}`);
 let stored = 'original', text = stored, saves = 0, detached = 0, created = 0, fail = false;
 let release: (() => void) | null = null, delay = false, hover = 0, tabUrls: string[] = [];
 const root = f.doc.body.createDiv();
 const view: any = { file, data: stored, containerEl: root.createDiv(), getViewType: () => extension === 'web' ? 'webviewer' : extension === 'base' ? 'bases' : extension === 'table' ? 'operon-table-file-view' : 'markdown', onResize() {},
  getEphemeralState:()=>({line:36,scroll:120}), setEphemeralState(){}, getViewData: () => text, setViewData(value:string){text=value;}, clear(){}, async save() { saves++; if (delay) await new Promise<void>(r => release = r); if (fail) throw Error('disk'); stored = text; view.data = text; } };
 const opens: any[] = [];
 const leaf: any = { getViewState:()=>({type:view.getViewType()}), view, containerEl:root, async openFile(file: TFile,state: any) { view.file = file; opens.push(state); }, async setViewState(state:any) { if(state.type==='webviewer')tabUrls.push(state.state.url);else view.file=new (TFile as any)(state.state.file); }, async loadIfDeferred() {}, detach() { detached++; } };
 const group:any={children:[],currentTab:0,selectTabIndex(index:number){this.currentTab=index;}};
 const app: any = { vault: { read: async () => stored, getResourcePath: (file:TFile) => `app:///${file.path}` },
  metadataCache: { getFirstLinkpathDest: (path:string, from:string) => path === 'missing' ? null : path === '' ? new (TFile as any)(from) : path.endsWith('.png') || path.endsWith('.pdf') || path.endsWith('.base') || path.endsWith('.table') ? new (TFile as any)(path) : file },
  internalPlugins: { getEnabledPluginById:()=>({openUrl(url:string){tabUrls.push(url);}}), plugins: { bases: {enabled:true}, 'page-preview': { enabled:true }, webviewer: {enabled:true,instance:{ openUrl(url:string) { tabUrls.push(url); }}}}},
  workspace: { containerEl: f.doc.body, getLayout:()=>({}), getLeafById:()=>null, getLeaf() {created++;return leaf;}, getMostRecentLeaf:()=>({parent:group,getRoot:()=>({}),getContainer:()=>({}),view:{containerEl:f.anchor,getViewType:()=> 'empty'}}), createLeafInParent(parent:any){created++;parent.insertChild?.(-1,leaf);return leaf;}, getLeavesOfType:()=>[], setActiveLeaf(){}, trigger() {hover++;} } };
 return { ...f, app, file, view, leaf, opens, root, stats:()=>({saves,detached,created,hover,tabUrls}),
  edit(value:string){text=value;}, stored(value:string){stored=value;}, fail(){fail=true;}, recover(){fail=false;}, delay(){delay=true;}, release(){release?.();},
  cleanup(){ fail=false; delay=false; disposeWebLightboxes(app); Platform.isDesktopApp=desktop;Platform.isMacOS=mac;globalThis.ResizeObserver=observer; }
 };
}
const local = {kind:'local',linktext:'[[Note#Heading|Alias]]',sourcePath:'Folder/Origin.md',line:36} as const;
const mouse = (extra:any = {}) => ({button:0,detail:1,metaKey:false,ctrlKey:false,preventDefault(){},stopPropagation(){},...extra});

test('resolve alias, source-relative references, heading, block, same-file and zero-based line without creating files', async () => {
 const f=fixture();try {
  let args:any[]=[];f.app.metadataCache.getFirstLinkpathDest=(...values:any[])=>{args=values;return f.file;};
  assert.deepEqual(resolveLightboxFile(f.app,local),{file:f.file,subpath:'#Heading',line:36});
  assert.deepEqual(args,['Note','Folder/Origin.md']);
  assert.equal(resolveLightboxFile(f.app,{...local,linktext:'[[../Note#^block|label]]'})?.subpath,'#^block');
  await openLightboxTarget(f.app,f.anchor,local,'tab');
  assert.deepEqual(f.opens[0].eState,{subpath:'#Heading',line:36,focus:true});
  assert.equal(f.stats().saves,0);
 } finally {f.cleanup();}
});
test('missing and disabled Base and mobile targets have zero side effects',async()=>{
 const f=fixture();try{
  f.app.internalPlugins.plugins.bases.enabled=false;
  for(const [linktext,result] of [['missing','missing'],['x.base','unavailable']]) assert.equal(await openLightboxTarget(f.app,f.anchor,{...local,linktext}),result);
  Platform.isDesktopApp=false;assert.equal(await openLightboxTarget(f.app,f.anchor,local),'unsupported');
  assert.equal(f.stats().created,0);assert.equal(f.stats().saves,0);
 }finally{f.cleanup();}
});
test('native host owns its leaf root and preserves state; unchanged close performs no save',async()=>{
 const f=fixture();try{
  await openLightboxTarget(f.app,f.anchor,local);await tick();
  assert.notEqual(f.root.parent,f.doc.body);assert.equal(f.view.containerEl.parent,f.root);assert.deepEqual(f.opens[0].eState,{subpath:'#Heading',line:36,focus:true});
  assert.equal(f.opens[0].active,false);
  disposeWebLightboxes(f.app);await tick();assert.equal(f.stats().detached,1);assert.equal(f.stats().saves,0);
 }finally{f.cleanup();}
});
test('pending Markdown save gates replacement and repeated close, saving once',async()=>{
 const f=fixture();try{
  await openLightboxTarget(f.app,f.anchor,local);await tick();f.edit('edited');f.delay();
  let mounted=0;const close=openLightbox(f.anchor,{title:'next',render:()=>{mounted++;return null;}});
  disposeWebLightboxes(f.app);await tick();assert.equal(mounted,0);assert.equal(f.stats().detached,0);assert.equal(f.stats().saves,1);
  f.release();await tick();assert.equal(mounted,1);assert.equal(f.stats().detached,1);close();
 }finally{f.cleanup();}
});
test('failed save retains native content and refuses replacement',async()=>{
 const f=fixture();try{
  await openLightboxTarget(f.app,f.anchor,local);await tick();f.edit('unsaved');f.fail();let mounted=0;
  openLightbox(f.anchor,{title:'next',render:()=>{mounted++;return null;}});await tick();
  assert.equal(mounted,0);assert.equal(f.stats().detached,0);assert.equal(f.view.getViewData(),'unsaved');
 }finally{f.cleanup();await tick();}
});
test('concurrent disk change is not overwritten; native autosave is awaited',async()=>{
 const f=fixture();try{
  f.edit('mine');f.stored('external');assert.equal(await flushLightboxMarkdown(f.app,f.leaf),false);assert.equal(f.stats().saves,0);
  f.stored('original');f.view.saving=true;
  const result=flushLightboxMarkdown(f.app,f.leaf);await tick();assert.equal(f.stats().saves,0);
  f.view.saving=false;assert.equal(await result,true);assert.equal(f.stats().saves,1);
 }finally{f.cleanup();}
});
test('Escape is left to child interactions; new native overlays can receive focus',()=>{
 const f=fixture();let root:any;try{
  const overlays:any[]=[];f.doc.querySelectorAll=()=>overlays;
  const close=openLightbox(f.anchor,{title:'native',nativeView:true,render:el=>{root=el;return null;}});
  f.emit('keydown',{key:'Escape',defaultPrevented:true});assert.equal(root.isConnected,true);
  const menu=f.doc.body.createDiv();overlays.push(menu);menu.focus();f.emit('focusin',{target:menu});assert.equal(f.doc.activeElement,menu);
  f.emit('keydown',{key:'Escape',defaultPrevented:false});assert.equal(root.isConnected,true);
  overlays.pop();f.emit('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(root.isConnected,false);close();
 }finally{f.cleanup();}
});
test('PDF page is retained for lightbox and native tab',async()=>{
 const f=fixture();try{
  const target={...local,linktext:'Report.pdf#page=3'};
  await openLightboxTarget(f.app,f.anchor,target);
  const shell=f.doc.body.children.at(-1);const frame=shell.querySelectorAll().find((el:any)=>el.tagName==='IFRAME');
  assert.equal(frame.src,'app:///Report.pdf#page=3');
  f.emit('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});
  await openLightboxTarget(f.app,f.anchor,target,'tab');assert.equal(f.opens[0].eState.subpath,'#page=3');
 }finally{f.cleanup();}
});
test('local media modifier-hover switches from quick preview to Page Preview once; disabled plugin keeps quick preview',()=>{
 const f=fixture();try{
  bindTaskMediaChipPreview(f.app,f.anchor,{localLinkTarget:'pic.png',sourcePath:'Note.md'});
  const anchor=f.anchor as any;anchor.events.get('mouseenter')(mouse());const quick=f.doc.body.children.at(-1);assert.ok(quick.classes.has('operon-task-media-hover-preview'));
  anchor.events.get('mousemove')(mouse({metaKey:true}));assert.equal(quick.isConnected,false);assert.equal(f.stats().hover,1);
  anchor.events.get('mousemove')(mouse({metaKey:true}));assert.equal(f.stats().hover,1);
  cleanupTaskMediaChipPreviews(f.anchor);
  f.app.internalPlugins.plugins['page-preview'].enabled=false;
  bindTaskMediaChipPreview(f.app,f.anchor,{localLinkTarget:'pic.png',sourcePath:'Note.md'});anchor.events.get('mouseenter')(mouse({metaKey:true}));
  assert.ok(f.doc.body.children.at(-1).classes.has('operon-task-media-hover-preview'));assert.equal(f.stats().hover,1);
 }finally{cleanupTaskMediaChipPreviews(f.anchor);f.cleanup();}
});
test('desktop preview image and toolbar use single activation and original remote URL; mobile retains double click',async()=>{
 const f=fixture();try{
  bindTaskMediaChipPreview(f.app,f.anchor,{externalUrl:'https://example.com/pic.png',sourcePath:''});
  (f.anchor as any).events.get('mouseenter')(mouse({metaKey:true}));assert.equal(f.stats().hover,0);
  let quick=f.doc.body.children.at(-1), image=quick.children.find((el:any)=>el.tagName==='IMG');
  assert.ok(image.events.has('click'));assert.equal(image.events.has('dblclick'),false);
  image.events.get('click')(mouse({metaKey:true}));await tick();assert.deepEqual(f.stats().tabUrls,['https://example.com/pic.png']);
  cleanupTaskMediaChipPreviews(f.anchor);Platform.isDesktopApp=false;
  bindTaskMediaChipPreview(f.app,f.anchor,{externalUrl:'https://example.com/pic.png',sourcePath:''});(f.anchor as any).events.get('mouseenter')(mouse());
  quick=f.doc.body.children.at(-1);image=quick.children.find((el:any)=>el.tagName==='IMG');assert.ok(image.events.has('dblclick'));assert.equal(image.events.has('click'),false);
 }finally{cleanupTaskMediaChipPreviews(f.anchor);f.cleanup();}
});


test('native navigation is blocked after save failure',async()=>{
 const f=fixture();try{
  await openLightboxTarget(f.app,f.anchor,local);await tick();const original=f.view.file;
  f.edit('unsaved');f.fail();await f.leaf.setViewState({type:'markdown',state:{file:'Other.md'}});
  assert.equal(f.view.file,original);assert.equal(f.stats().detached,0);
 }finally{f.cleanup();await tick();}
});
test('edits during final save verification keep content open',async()=>{
 const f=fixture();try{
  let reads=0;const read=f.app.vault.read;
  f.app.vault.read=async()=>{const result=await read();if(++reads===2)f.edit('newer edit');return result;};
  f.edit('first edit');assert.equal(await flushLightboxMarkdown(f.app,f.leaf),false);
  assert.equal(f.view.getViewData(),'newer edit');assert.equal(f.stats().detached,0);
 }finally{f.cleanup();}
});
test('latest queued replacement wins and cancelled openings never mount',async()=>{
 const f=fixture();try{
  let release:(value:boolean)=>void=()=>{};let disposed=0;const mounted:string[]=[];
  openLightbox(f.anchor,{title:'first',beforeClose:()=>new Promise(r=>release=r),render:()=>null});
  openLightbox(f.anchor,{title:'second',onDispose:()=>disposed++,render:()=>{mounted.push('second');return null;}});
  const cancel=openLightbox(f.anchor,{title:'third',render:()=>{mounted.push('third');return null;}});cancel();
  release(true);await tick();assert.deepEqual(mounted,[]);assert.equal(disposed,1);
 }finally{f.cleanup();}
});
test('HTTP URLs never create files; disabled viewer and unsafe schemes stay unavailable',async()=>{
 const f=fixture();try{
  f.app.internalPlugins.getEnabledPluginById=()=>null;f.app.internalPlugins.plugins.webviewer.enabled=false;
  assert.equal(await openLightboxTarget(f.app,f.anchor,{kind:'web',url:'https://example.com'},'tab'),'unavailable');
  assert.equal(await openLightboxTarget(f.app,f.anchor,{kind:'web',url:'javascript:alert(1)'}),'unsupported');
  assert.equal(f.stats().created,0);assert.equal(f.stats().saves,0);
 }finally{f.cleanup();}
});


test('local media preserves its display alias and plugin unload removes media content',async()=>{
 const f=fixture();try{
  await openLightboxTarget(f.app,f.anchor,{...local,linktext:'pic.png',label:'My cover'});
  const shell=f.doc.body.children.at(-1);assert.equal(shell.children[0].textContent,'My cover');
  disposeWebLightboxes(f.app);assert.equal(shell.isConnected,false);
 }finally{f.cleanup();}
});
test('native navigation remounts replacement content while native tab root stays in place',async()=>{
 const f=fixture();try{
  await openLightboxTarget(f.app,f.anchor,local);await tick();
  const originalHost=f.view.containerEl.parent;
  f.root.appendChild(f.view.containerEl);
  await f.leaf.setViewState({type:'markdown',state:{file:'Other.md'}});
  assert.equal(f.view.containerEl.parent,originalHost);assert.notEqual(f.root.parent,f.doc.body);
 }finally{f.cleanup();await tick();}
});


test('native host interaction activates only its owned leaf after background focus changes',async()=>{
 const f=fixture();try{
  let active:any=null;f.app.workspace.setActiveLeaf=(leaf:any)=>{active=leaf;};
  await openLightboxTarget(f.app,f.anchor,local);await tick();
  const host=f.root.parent!.parent!.parent!;
  host.events.get('pointerdown')();assert.equal(active,f.leaf);
  active=null;host.events.get('focusin')();assert.equal(active,f.leaf);
  disposeWebLightboxes(f.app);await tick();assert.equal(host.events.has('pointerdown'),false);
 }finally{f.cleanup();}
});

for(const extension of ['base','table']) test(`native ${extension} uses owned view and same target in new tab`,async()=>{
 const f=fixture(extension);try{
  const target={...local,linktext:`[[Folder/Note.${extension}#My view|Alias]]`};
  assert.equal(await openLightboxTarget(f.app,f.anchor,target),'opened');await tick();
  assert.equal(f.opens[0].eState.subpath,'#My view');assert.equal(f.stats().saves,0);
  disposeWebLightboxes(f.app);await tick();assert.equal(f.stats().detached,1);
  await openLightboxTarget(f.app,f.anchor,target,'tab');assert.equal(f.opens.length,2);
  assert.equal(f.opens[1].eState.subpath,'#My view');
 }finally{f.cleanup();await tick();}
});
test('unavailable native Base view does not keep a raw text fallback or alter user tabs',async()=>{
 const f=fixture('base');try{
  f.view.getViewType=()=> 'markdown';
  await openLightboxTarget(f.app,f.anchor,{...local,linktext:'Note.base'});await tick();
  assert.equal(f.stats().detached,1);assert.equal(f.stats().saves,0);
 }finally{f.cleanup();await tick();}
});

test('failed native navigation does not poison later safe closure',async()=>{
 const f=fixture();try{f.leaf.setViewState=async()=>{throw Error('load');};await openLightboxTarget(f.app,f.anchor,local);await tick();await assert.rejects(f.leaf.setViewState({state:{file:'Missing.md'}}));disposeWebLightboxes(f.app);await tick();assert.equal(f.stats().detached,1);}finally{f.cleanup();await tick();}
});
test('IME Escape is left to native composition',()=>{
 const f=lightboxFixture();let closed=0;const close=openLightbox(f.anchor,{title:'Native',nativeView:true,onDispose:()=>closed++,render:()=>null});
 f.emit('keydown',{key:'Escape',isComposing:true});f.emit('keydown',{key:'Escape',keyCode:229});assert.equal(closed,0);close();assert.equal(closed,1);
});


// Model the native workspace side effects, not only the lightbox DOM.
function isolatedTabFixture(extension = 'md', stacked = false) {
 const f = fixture(extension), root = { id: 'root' }, container = { doc: f.doc };
 const owner: any = { id: 'user-a', parent: null, view: { containerEl: f.anchor, getViewType:()=> 'markdown' }, getRoot:()=>owner.parent?root:owner, getContainer:()=>owner.parent?container:{doc:'main-fallback'} };
 const other: any = { ...owner, id: 'user-b', pinned: true, getRoot:()=>other.parent?root:other, getContainer:()=>other.parent?container:{doc:'main-fallback'} };
 const userTabs: any = { id: 'user-tabs', children: [owner, other], currentTab: 0, scrollLeft: 141, stacked, selectTabIndex(index: number) { this.currentTab = index; } };
 owner.parent = userTabs; other.parent = userTabs;
 let registered = [owner, other];
 const history = Array.from({ length: 10 }, (_, index) => ({ id: `closed-${index}` }));
 const workspace: any = f.app.workspace;
 Object.assign(workspace, {
  activeLeaf: owner, lastTabGroupStacked: stacked, undoHistory: history,
  getMostRecentLeaf:()=>registered[0] ?? null,
  getLeavesOfType:()=>registered,
  getLeafById:(id:string)=>registered.find(leaf=>leaf.id===id) ?? null,
  getLayout:()=>({ main:{ tabs:userTabs.children.map((leaf:any)=>({id:leaf.id,pinned:!!leaf.pinned})), selected:userTabs.currentTab, scroll:userTabs.scrollLeft, stacked:userTabs.stacked }, active:workspace.activeLeaf?.id }),
  setActiveLeaf(leaf:any) {
   if (!leaf || leaf.getRoot() !== root) return;
   workspace.activeLeaf = leaf;
   if (leaf) leaf.parent.selectTabIndex(leaf.parent.children.indexOf(leaf));
  },
  createLeafInParent(parent:any) {
   parent.insertChild(-1,f.leaf); workspace.setActiveLeaf(f.leaf); return f.leaf;
  },
 });
 Object.assign(f.leaf, {
  id: 'ephemeral', getRoot:()=>f.leaf.parent?.getRoot(), getContainer:()=>container,
  getViewState:()=>({type:f.view.getViewType()}),
  detach() {
   if (f.leaf.getViewState().type !== 'empty') { history.unshift({id:f.leaf.id}); history.length=10; }
   f.leaf.parent?.removeChild(f.leaf);
  },
 });
 if (extension==='web') f.leaf.setViewState=async()=>{};
 const layout = workspace.getLayout(), getLayout = workspace.getLayout;
 const open = async()=> { if(extension==='web') openWebLightbox(f.app,f.anchor,'https://example.com'); else await openLightboxTarget(f.app,f.anchor,{...local,linktext:`Note.${extension}`}); await tick(); };
 const host = ()=>f.root.parent!.parent!.parent!;
 return {...f,workspace,owner,userTabs,history,layout,getLayout,open,host,removeOwner(){owner.parent=null;registered=[other];userTabs.children=[other];},removeAll(){owner.parent=null;other.parent=null;registered=[];userTabs.children=[];}};
}
for (const extension of ['md','base','table','web']) for (const stacked of [false,true]) {
 test(`${extension} isolated native view preserves normal/stacked tabs, layout and full closed-tab history (${stacked})`,async()=>{
  const f=isolatedTabFixture(extension,stacked), history=JSON.stringify(f.history);
  try {
   assert.deepEqual(getNativeLightboxLeaves(f.app),[]);
   await f.open();
   assert.deepEqual(getNativeLightboxLeaves(f.app),[f.leaf]);
   assert.deepEqual(getNativeLightboxLeaves({} as any),[]);
   const tabs=f.leaf.parent;
   assert.equal(f.host().inert,false);
   assert.notEqual(tabs,f.userTabs);assert.equal(tabs.parent,null);
   assert.equal(f.root.parent,tabs.tabsContainerEl);
   assert.deepEqual(f.workspace.getLayout(),f.layout);
   f.host().events.get('pointerdown')();
   assert.equal(f.workspace.activeLeaf,f.leaf);
   assert.deepEqual(f.workspace.getLayout(),f.layout);
   assert.deepEqual(f.userTabs.children.map((leaf:any)=>leaf.id),['user-a','user-b']);
   assert.equal(f.userTabs.currentTab,0);assert.equal(f.userTabs.scrollLeft,141);
   await f.leaf.setViewState({type:f.view.getViewType(),state:{file:'Other.md'}});
   assert.deepEqual(f.workspace.getLayout(),f.layout);
   disposeWebLightboxes(f.app);await tick();
   assert.deepEqual(getNativeLightboxLeaves(f.app),[]);
   assert.equal(f.workspace.getLayout,f.getLayout);
   assert.equal(f.workspace.activeLeaf,f.owner);
   assert.deepEqual(f.workspace.getLayout(),f.layout);
   assert.equal(f.workspace.lastTabGroupStacked,stacked);
   assert.equal(JSON.stringify(f.history),history);
   assert.equal(tabs.component.unloaded,true);
   tabs.recomputeChildrenDimensions();assert.equal(tabs.containerEl.isConnected,false);
  }finally{f.cleanup();await tick();}
 });
}
test('failed native save retains isolated view and layout projection until successful close',async()=>{
 const f=isolatedTabFixture();
 try {
  await f.open();f.host().events.get('focusin')();f.edit('edited');f.fail();
  disposeWebLightboxes(f.app);await tick();
  assert.equal(f.workspace.activeLeaf,f.leaf);assert.notEqual(f.workspace.getLayout,f.getLayout);
  assert.deepEqual(f.workspace.getLayout(),f.layout);assert.equal(f.view.getViewData(),'edited');
  assert.deepEqual(getNativeLightboxLeaves(f.app),[f.leaf]);
  f.recover();disposeWebLightboxes(f.app);await tick();
  assert.deepEqual(getNativeLightboxLeaves(f.app),[]);
  assert.equal(f.workspace.getLayout,f.getLayout);assert.equal(f.workspace.activeLeaf,f.owner);
 }finally{f.cleanup();await tick();}
});
test('removed owner is not serialized or restored and explicit background selection is respected',async()=>{
 const f=isolatedTabFixture();
 try {
  await f.open();f.host().events.get('focusin')();const nativeRoot=f.leaf.getRoot(), nativeContainer=f.leaf.getContainer();f.removeOwner();
  assert.equal(f.leaf.getRoot(),nativeRoot);assert.equal(f.leaf.getContainer(),nativeContainer);
  assert.equal('active' in f.workspace.getLayout(),false);
  const remaining=f.userTabs.children[0]; f.workspace.setActiveLeaf(remaining);
  disposeWebLightboxes(f.app);await tick();assert.equal(f.workspace.activeLeaf,remaining);
 }finally{f.cleanup();await tick();}
});

test('two owner documents share layout protection until the last native lightbox closes',async()=>{
 const a=isolatedTabFixture(), b=isolatedTabFixture();
 const workspace=a.workspace, owners=[a.owner,b.owner];
 b.owner.id='popout-owner';b.leaf.id='popout-ephemeral';
 let next=a, recent=a.owner;
 workspace.getMostRecentLeaf=()=>recent;
 workspace.getLeavesOfType=()=>owners;
 workspace.getLeafById=(id:string)=>owners.find(owner=>owner.id===id)??null;
 workspace.iterateAllLeaves=(fn:any)=>owners.forEach(fn);
 workspace.createLeafInParent=(parent:any)=>{parent.insertChild(-1,next.leaf);workspace.setActiveLeaf(next.leaf);return next.leaf;};
 workspace.setActiveLeaf=(leaf:any)=>{
  if(leaf&&!owners.some(owner=>owner.getRoot()===leaf.getRoot()))return;
  workspace.activeLeaf=leaf;if(leaf)leaf.parent.selectTabIndex(leaf.parent.children.indexOf(leaf));
 };
 let closeReplacement=()=>{};
 try {
  await a.open();a.host().events.get('focusin')();
  next=b;recent=b.owner;
  await openLightboxTarget(a.app,b.anchor,local);await tick();b.host().events.get('focusin')();
  assert.equal(workspace.activeLeaf,b.leaf);assert.equal(workspace.getLayout().active,b.owner.id);
  closeReplacement=openLightbox(a.anchor,{title:'replacement',render:()=>null});await tick();
  assert.equal(workspace.activeLeaf,b.leaf);assert.notEqual(workspace.getLayout,a.getLayout);
  assert.equal(workspace.getLayout().active,b.owner.id);
  disposeWebLightboxes(a.app);await tick();
  assert.equal(workspace.getLayout,a.getLayout);assert.equal(workspace.activeLeaf,b.owner);
 }finally{closeReplacement();a.cleanup();b.cleanup();await tick();}
});

test('closing an orphaned native lightbox clears its active context without a phantom tab',async()=>{
 const f=isolatedTabFixture();
 try {
  await f.open();f.host().events.get('focusin')();f.removeAll();
  disposeWebLightboxes(f.app);await tick();
  assert.equal(f.workspace.activeLeaf,null);assert.equal(f.workspace.activeEditor,null);
  assert.equal(f.workspace.getLayout,f.getLayout);assert.equal(f.workspace.getLayout().active,undefined);
 }finally{f.cleanup();await tick();}
});
test('native view initialization finishing after close is disposed once without history or layout residue',async()=>{
 const f=isolatedTabFixture();let release=()=>{},closed=0;const oldDetach=f.leaf.detach;
 f.leaf.openFile=async()=>{await new Promise<void>(resolve=>release=resolve);f.leaf.view={...f.view,containerEl:f.root.createDiv()};};
 f.leaf.detach=()=>{closed++;oldDetach();};
 try {
  await openLightboxTarget(f.app,f.anchor,local);
  const tabs=f.leaf.parent;
  assert.equal(f.host().inert,true);
  disposeWebLightboxes(f.app);await tick();assert.equal(closed,0);
  release();await tick();assert.equal(closed,1);assert.equal(tabs.component.unloaded,true);
  assert.equal(f.workspace.getLayout,f.getLayout);assert.deepEqual(f.workspace.getLayout(),f.layout);
  disposeWebLightboxes(f.app);await tick();assert.equal(closed,1);
 }finally{release();f.cleanup();await tick();}
});

// A real destination models native selection/history effects independently of the isolated host.
function installDestination(f: ReturnType<typeof isolatedTabFixture>, reject = false) {
 let calls = 0, received: any, ephemeral: any;
 const destination: any = {id:'new-tab', parent:null, getRoot:()=>f.owner.getRoot(),
  view:{containerEl:f.doc.body.createDiv(), getViewType:()=>received?.type ?? 'markdown', setEphemeralState(value:any){ephemeral=value;}},
  getViewState:()=>received ?? {type:'markdown'},
  async setViewState(state:any){calls++;received=state;if(reject)throw Error('load failed');},
  async openFile(file:any,state:any){calls++;received={type:file.extension==='pdf'?'pdf':'image',file,state};if(reject)throw Error('load failed');},
  async loadIfDeferred(){},
  detach(){if(destination.getViewState().type!=='empty'){f.history.unshift({id:'failed'});f.history.length=10;}const index=f.userTabs.children.indexOf(destination);if(index>=0)f.userTabs.children.splice(index,1);destination.parent=null;f.userTabs.currentTab=0;},
 };
 f.workspace.createLeafInParent=(parent:any)=>{assert.equal(parent,f.userTabs);destination.parent=parent;parent.children.push(destination);f.workspace.setActiveLeaf(destination);return destination;};
 return {destination,stats:()=>({calls,received,ephemeral})};
}
function clickTab(f: ReturnType<typeof isolatedTabFixture>, name = 'tab') {
 const shell=f.doc.body.children.findLast((el:any)=>el.classes.has('operon-task-media-lightbox')&&el.isConnected);
 shell.children.find((el:any)=>el.classes.has(`operon-task-media-lightbox-${name}`)).events.get('click')();
 return shell;
}
for(const extension of ['md','base','table','web']) test(`${extension} new-tab control transfers current state after saving and focuses only after closing`,async()=>{
 const f=isolatedTabFixture(extension);
 try {
  await f.open();f.host().events.get('focusin')();
  const state={type:f.view.getViewType(),state:extension==='web'?{url:'https://example.com/navigated'}:{file:'Moved/Current.'+extension,mode:'source',view:'Current'}};
  f.leaf.getViewState=()=>state;
  const d=installDestination(f);const history=JSON.stringify(f.history);
  if(extension==='md'){f.edit('edited');f.delay();}
  const shell=clickTab(f);clickTab(f);await tick();
  if(extension==='md'){assert.equal(d.stats().calls,0);assert.equal(f.stats().saves,1);assert.equal(shell.isConnected,true);f.release();await tick();}
  assert.deepEqual(d.stats().received,{...state,active:false});assert.deepEqual(d.stats().ephemeral,{line:36,scroll:120});
  assert.equal(d.stats().calls,1);assert.equal(shell.isConnected,false);assert.equal(f.workspace.activeLeaf,d.destination);
  assert.equal(f.userTabs.children.length,3);assert.equal(JSON.stringify(f.history),history);
 }finally{f.cleanup();await tick();}
});
test('failed new-tab load retains lightbox, middle selected background tab, active context and full history',async()=>{
 const f=isolatedTabFixture();
 try {
  const before={...f.owner,id:'first',parent:f.userTabs};f.userTabs.children.unshift(before);f.userTabs.currentTab=1;
  await f.open();f.host().events.get('focusin')();const history=JSON.stringify(f.history),layout=f.workspace.getLayout();
  installDestination(f,true);const shell=clickTab(f);await tick();
  assert.equal(shell.isConnected,true);assert.equal(shell.inert,false);assert.equal(f.workspace.activeLeaf,f.leaf);
  assert.equal(f.userTabs.currentTab,1);assert.deepEqual(f.workspace.getLayout(),layout);assert.equal(JSON.stringify(f.history),history);
 }finally{f.cleanup();await tick();}
});
for(const control of ['tab','split','split-below'])test(`failed save blocks ${control} creation and retains editable native content`,async()=>{
 const f=isolatedTabFixture();
 try{await f.open();f.edit('unsaved');f.fail();const d=installSplitDestination(f);const shell=clickTab(f,control);await tick();assert.equal(d.stats().calls,0);assert.equal(f.userTabs.children.length,2);assert.equal(shell.isConnected,true);assert.equal(shell.inert,false);assert.equal(f.view.getViewData(),'unsaved');}
 finally{f.recover();f.cleanup();await tick();}
});
for(const remote of [false,true]) for(const placement of ['tab','split','below'])test(`media ${placement} control retains original URL or PDF page (${remote})`,async()=>{
 const f=isolatedTabFixture();
 try{
  const d=installSplitDestination(f);
  const target=remote?{kind:'web' as const,url:'https://example.com/watch?v=original',media:{kind:'video' as const,url:'https://example.com/embed/derived',label:'Clip'}}:{...local,linktext:'Report.pdf#page=3'};
  await openLightboxTarget(f.app,f.anchor,target);
  for(const el of f.doc.body.querySelectorAll())if(el.tagName==='VIDEO'){el.pause=()=>{};el.load=()=>{};}
  const shell=clickTab(f,placement==='below'?'split-below':placement);await tick();
  assert.equal(shell.isConnected,false);assert.equal(f.workspace.activeLeaf,d.destination);
  if(placement!=='tab')assert.deepEqual(d.origin(),{origin:f.owner,direction:placement==='below'?'horizontal':'vertical',before:false});
  if(remote)assert.equal(d.stats().received.state.url,target.url);
  else assert.equal(d.stats().received.state.eState.subpath,'#page=3');
 }finally{f.cleanup();await tick();}
});

function installSplitDestination(f: ReturnType<typeof isolatedTabFixture>, reject = false) {
 const d=installDestination(f,reject);const target=d.destination;
 const split:any={children:[],selectTabIndex(){},currentTab:0};let received:any;
 f.workspace.createLeafBySplit=(origin:any,direction:string,before:boolean)=>{
  received={origin,direction,before};target.parent=split;split.children=[target];return target;
 };
 return {...d,split,origin:()=>received};
}
for(const extension of ['md','base','table','web'])for(const below of [false,true])test(`${extension} ${below?'below':'right'} split uses captured origin, current state and focus after successful cleanup`,async()=>{
 const f=isolatedTabFixture(extension);
 try{
  await f.open();const d=installSplitDestination(f),other=f.userTabs.children[1];
  f.workspace.getMostRecentLeaf=()=>other;
  const shell=f.doc.body.children.findLast((el:any)=>el.classes.has('operon-task-media-lightbox')&&el.isConnected);
  shell.children.find((el:any)=>el.classes.has(below?'operon-task-media-lightbox-split-below':'operon-task-media-lightbox-split')).events.get('click')();await tick();
  assert.deepEqual(d.origin(),{origin:f.owner,direction:below?'horizontal':'vertical',before:false});
  assert.equal(shell.isConnected,false);assert.equal(f.workspace.activeLeaf,d.destination);
  assert.deepEqual(d.stats().ephemeral,{line:36,scroll:120});assert.equal(f.userTabs.children.length,2);
 }finally{f.cleanup();await tick();}
});
for(const below of [false,true])test(`removed original leaf prevents ${below?'below':'right'} split without creating a target or closing preview`,async()=>{
 const f=isolatedTabFixture();try{
  await f.open();const d=installSplitDestination(f);f.removeOwner();
  const shell=f.doc.body.children.findLast((el:any)=>el.classes.has('operon-task-media-lightbox')&&el.isConnected);
  shell.children.find((el:any)=>el.classes.has(below?'operon-task-media-lightbox-split-below':'operon-task-media-lightbox-split')).events.get('click')();await tick();
  assert.equal(d.origin(),undefined);assert.equal(shell.isConnected,true);
 }finally{f.cleanup();await tick();}
});
for(const placement of ['split','below'] as const)for(const interveningResize of [false,true])test(`failed provisional ${placement} restores unequal geometry only without intervening layout changes (${interveningResize})`,async()=>{
 const f=isolatedTabFixture();try{
  const group:any=f.userTabs,sibling:any={dimension:40,setDimension(value:number){this.dimension=value;}};
  group.dimension=60;group.setDimension=(value:number)=>group.dimension=value;
  const split:any={children:[group,sibling]};group.parent=split;
  const added:any={dimension:30,setDimension(value:number){this.dimension=value;}};
  const destination:any={view:{containerEl:f.anchor},getViewState:()=>({type:'markdown'}),detach(){split.children=split.children.filter((child:any)=>child!==added);const total=split.children.reduce((sum:number,child:any)=>sum+child.dimension,0);for(const child of split.children)child.setDimension(100*child.dimension/total);}};
  f.workspace.createLeafBySplit=()=>{group.setDimension(30);split.children.splice(1,0,added);return destination;};
  await assert.rejects(prepareLightboxTab(f.app,f.doc,async()=>{if(interveningResize){group.setDimension(20);sibling.setDimension(50);}throw Error('load');},placement,f.owner));
  assert.deepEqual(split.children,[group,sibling]);
  if(!interveningResize)assert.deepEqual([group.dimension,sibling.dimension],[60,40]);
  else assert.ok(Math.abs(group.dimension-100*20/70)<0.001);
 }finally{f.cleanup();await tick();}
});

for (const enabled of [true,false]) test(`explicit external mode bypasses Web Viewer (${enabled}) and uses the owner window`,async()=>{
 const f=fixture();try{
  const opened:any[]=[];f.doc.defaultView.open=(...args:any[])=>{opened.push(args);return null;};
  f.app.internalPlugins.plugins.webviewer.enabled=enabled;
  f.app.internalPlugins.getEnabledPluginById=()=>{throw Error('External opening must not inspect Web Viewer');};
  for(const url of ['https://example.com/work?id=42#comment','http://example.com/work']) {
   assert.equal(await openLightboxTarget(f.app,f.anchor,{kind:'web',url},'external'),'opened');
   assert.deepEqual(opened.at(-1),[url,'_external','noopener']);
  }
  assert.equal(f.stats().created,0);assert.equal(f.stats().saves,0);assert.deepEqual(f.stats().tabUrls,[]);
 }finally{f.cleanup();}
});
test('external mode rejects local files, media, mobile and unsupported schemes without side effects',async()=>{
 const f=fixture();try{
  const opened:any[]=[];f.doc.defaultView.open=(...args:any[])=>opened.push(args);
  for(const url of ['javascript:alert(1)','file:///etc/hosts','mailto:a@example.com','obsidian://open','data:text/html,x','not a url'])
   assert.equal(await openLightboxTarget(f.app,f.anchor,{kind:'web',url},'external'),'unsupported');
  assert.equal(await openLightboxTarget(f.app,f.anchor,local,'external'),'unsupported');
  assert.equal(await openLightboxTarget(f.app,f.anchor,{kind:'web',url:'https://example.com/a.png',media:{kind:'image',url:'https://example.com/a.png',label:'Image'}},'external'),'unsupported');
  Platform.isDesktopApp=false;
  assert.equal(await openLightboxTarget(f.app,f.anchor,{kind:'web',url:'https://example.com'},'external'),'unsupported');
  assert.deepEqual(opened,[]);assert.equal(f.stats().created,0);assert.equal(f.stats().saves,0);
 }finally{f.cleanup();}
});
test('opening externally preserves an existing native preview and does not flush its unsaved edit',async()=>{
 const f=fixture();try{
  await openLightboxTarget(f.app,f.anchor,local);await tick();f.edit('unsaved native draft');
  const before=f.stats();const shell=f.doc.body.children.at(-1);const opened:any[]=[];
  f.doc.defaultView.open=(...args:any[])=>opened.push(args);
  await openLightboxTarget(f.app,f.anchor,{kind:'web',url:'https://example.com/'},'external');
  assert.deepEqual(f.stats(),before);assert.equal(shell.isConnected,true);assert.equal(opened.length,1);
 }finally{f.cleanup();}
});
