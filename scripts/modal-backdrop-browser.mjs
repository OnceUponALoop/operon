import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.OPERON_TEST_PLAYWRIGHT || 'playwright');
const css = readFileSync(path.join(root, 'styles.css'), 'utf8');
const bundle = await build({ stdin: { contents: "export * from './src/ui/modal-backdrop';export * from './src/ui/field-pickers/common';export * from './src/ui/lightbox';export {Platform} from 'obsidian';", resolveDir: root }, bundle:true, write:false, format:'iife', globalName:'Subject', platform:'browser', logLevel:'silent', alias:{obsidian:path.join(root,'scripts/test-support/obsidian.ts')} });
const browser = await chromium.launch({headless:true, ...(process.env.OPERON_TEST_BROWSER ? {executablePath:process.env.OPERON_TEST_BROWSER} : {})});
let scenarios = 0;
try {
 for (const surface of ['creator','finder','editor']) for (const dark of [false,true]) for (const width of [460,1440]) for (const desktop of [false,true]) {
  const page = await browser.newPage({viewport:{width,height:800}});
  try {
   await page.setContent(`<style>
*{box-sizing:border-box}body{margin:0;--layer-modal:50;--layer-popover:30;--layer-menu:65;--radius-m:12px;--background-primary:${dark?'#222':'#fff'};--background-secondary:#777;--text-normal:${dark?'#eee':'#222'};--text-muted:#888;--background-modifier-cover:rgba(30,40,50,.3);--background-modifier-border:#888;--interactive-accent:#a36}
.modal-container{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:var(--layer-modal)}.modal-bg{position:absolute;inset:0;width:100%;height:100%;background:var(--background-modifier-cover);opacity:.6;backdrop-filter:blur(2px)}.modal{position:relative;background:var(--background-primary);padding:16px}.modal-content{overflow:auto}.modal-close-button{position:absolute;right:4px;top:4px}button,input,textarea{min-height:28px} .rows{height:120px}
</style><style>${css}</style><button id="outside">Open</button><div id="owner" class="modal-container operon-task-${surface}-modal-container"><div class="modal-bg"></div><div id="modal" class="modal operon-task-${surface}-modal"><div class="modal-close-button">Existing control</div><div class="modal-content"><div class="${surface==='editor'?'operon-task-editor-shell':''}"><input id="draft" value="Unsaved draft"><button id="picker-anchor">Property/template</button><div class="rows"></div><textarea id="note">Note draft</textarea><button id="cancel">Existing Cancel</button></div></div></div></div>`);
   await page.evaluate(()=>{
    document.win=window;window.activeDocument=document;window.activeWindow=window;
    Object.defineProperty(Node.prototype,'doc',{get(){return this.ownerDocument||document;}});Object.defineProperty(Node.prototype,'win',{get(){return this.doc.defaultView;}});
    Element.prototype.createEl=function(tag,o){const el=document.createElement(tag);if(typeof o==='string')el.className=o;else if(o){if(o.cls)el.className=o.cls;if(o.text)el.textContent=o.text;for(const[k,v]of Object.entries(o.attr||{}))el.setAttribute(k,v);}this.appendChild(el);return el;};
    Element.prototype.createDiv=function(o){return this.createEl('div',o);};Element.prototype.createSpan=function(o){return this.createEl('span',o);};Element.prototype.addClass=function(...n){this.classList.add(...n);};Element.prototype.removeClass=function(...n){this.classList.remove(...n);};Element.prototype.toggleClass=function(n,b){this.classList.toggle(n,b);};Element.prototype.setText=function(t){this.textContent=t;};Element.prototype.setCssStyles=function(s){Object.assign(this.style,s);};Element.prototype.empty=function(){this.replaceChildren();};window.createSpan=o=>document.body.createSpan(o);window.createEl=(t,o)=>document.body.createEl(t,o);
   });
   await page.addScriptTag({content:bundle.outputFiles[0].text});
   const result = await page.evaluate(({desktop,surface})=>{
    Subject.Platform.isDesktopApp=desktop;
    const owner=document.getElementById('owner'),modal=document.getElementById('modal'),draft=document.getElementById('draft'),note=document.getElementById('note'),rows=document.querySelector('.rows');
    const geometry=()=>[...owner.querySelectorAll('*')].filter(e=>!e.classList.contains('modal-bg')).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return[r.x,r.y,r.width,r.height,s.borderRadius,s.overflowX,s.overflowY,s.position,s.transform,s.zIndex];});
    const bg=()=>{const s=getComputedStyle(owner.firstElementChild);return[s.backgroundColor,s.opacity,s.backdropFilter];};
    const before=geometry(),original=bg(),controls=owner.querySelectorAll('button,.modal-close-button').length;
    draft.focus();draft.setSelectionRange(2,5);window.release=Subject.applyDesktopModalBackdrop(owner);
    const after=geometry(),effect=bg();let parity=true;const widths=[];
    for(const height of [0,1400,280]){
     rows.style.height=height+'px';note.hidden=height===0;if(surface==='editor')modal.classList.toggle('operon-task-editor-modal-has-file-body',height>300);
     widths.push(modal.getBoundingClientRect().width);const active=geometry();release();const without=geometry();parity&&=JSON.stringify(active)===JSON.stringify(without);window.release=Subject.applyDesktopModalBackdrop(owner);
    }
    const child=owner.createDiv('modal-container');const childBg=child.createDiv('modal-bg');const childStyle=getComputedStyle(childBg);const childUnchanged=childStyle.opacity==='0.6'&&childStyle.backdropFilter==='blur(2px)';child.remove();
    const frame=document.createElement('iframe');document.body.appendChild(frame);const foreign=frame.contentDocument.createElement('div');frame.contentDocument.body.append(foreign);foreign.addClass=(c)=>foreign.classList.add(c);foreign.removeClass=(c)=>foreign.classList.remove(c);const cleanForeign=Subject.applyDesktopModalBackdrop(foreign);cleanForeign();const isolated=owner.classList.contains('operon-focus-modal')===desktop;frame.remove();
    return{before,after,original,effect,parity,widths,childUnchanged,isolated,controlsUnchanged:controls===owner.querySelectorAll('button,.modal-close-button').length,noRail:owner.querySelectorAll('.operon-task-media-lightbox-control').length===0,selection:[document.activeElement.id,draft.selectionStart,draft.selectionEnd,draft.value]};
   },{desktop,surface});
   if(surface==='editor'&&width===1440)assert.ok(result.widths[1]>result.widths[0],'File Body really expands the modal');
   assert.deepEqual(result.before,result.after);assert.ok(result.parity);assert.ok(result.childUnchanged);assert.ok(result.isolated);assert.ok(result.controlsUnchanged);assert.ok(result.noRail);
   assert.deepEqual(result.effect,desktop?['rgba(0, 0, 0, 0.82)','1','none']:result.original);
   assert.deepEqual(result.selection,['draft',2,5,'Unsaved draft']);
   // Real shared picker and lightbox helpers must still use the existing hosts and focus path.
   await page.evaluate(()=>{
    document.querySelector('.rows').style.height='40px';document.getElementById('note').hidden=false;
    const anchor=document.getElementById('picker-anchor');window.picker=Subject.createFloatingPanel(anchor,'operon-floating-panel',()=>{});picker.panel.id='panel';picker.panel.createEl('input',{attr:{id:'picker-input'}}).focus();
   });
   const picker = await page.evaluate(()=>{const p=document.getElementById('panel'),s=getComputedStyle(p),r=p.getBoundingClientRect();return{owner:document.getElementById('owner').contains(p),focus:document.activeElement.id,visible:s.display!=='none'&&r.width>0};});
   assert.deepEqual(picker,{owner:true,focus:'picker-input',visible:true});
   await page.evaluate(()=>picker.close());
   await page.evaluate(()=>{
    window.modalScope={name:'underlying-modal'};window.scopeStack=[modalScope];window.parentCloses=0;
    window.app={scope:{name:'app'},keymap:{pushScope(s){scopeStack.push(s);},popScope(s){scopeStack.splice(scopeStack.indexOf(s),1);}}};
    // Model the native modal's keymap trap, which runs before document bubble handlers.
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&scopeStack.at(-1)===modalScope){window.parentCloses++;}},true);
   });
   await page.locator('#note').focus();
   await page.evaluate(()=>{window.previewClosed=0;window.closePreview=Subject.openLightbox(document.getElementById('note'),{title:'Preview',className:'is-native',nativeView:true,onDispose(){window.previewClosed++;},render(shell){shell.createDiv('operon-task-media-lightbox-content operon-native-lightbox-host').createEl('button',{text:'Content'});return null;}});});
   assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.operon-task-media-lightbox')).backgroundColor),'rgba(0, 0, 0, 0.82)');
   if(desktop){
    const layers=await page.evaluate(()=>{
     const shell=document.querySelector('.operon-task-media-lightbox'),button=shell.querySelector('.operon-task-media-lightbox-content button'),r=button.getBoundingClientRect();
     return{top:shell.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),z:getComputedStyle(shell).zIndex,scope:scopeStack.length};
    });
    assert.deepEqual(layers,{top:true,z:'50',scope:2});
    await page.locator('.operon-task-media-lightbox-content button').click();
    await page.evaluate(()=>{const anchor=document.querySelector('.operon-task-media-lightbox-content button');window.previewPicker=Subject.createFloatingPanel(anchor,'operon-floating-panel',()=>{});previewPicker.panel.id='preview-picker';previewPicker.panel.createEl('input',{attr:{id:'preview-picker-input'}}).focus();});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#preview-picker').evaluate(el=>!!el.closest('.operon-native-lightbox-host')),true);
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(()=>[!!document.getElementById('preview-picker'),window.previewClosed,window.parentCloses,scopeStack.length]),[false,0,0,2]);
    // A native dialog opened afterwards is above the preview; closing it keeps the preview.
    await page.evaluate(()=>{window.confirmDialog=document.body.createDiv('modal-container');confirmDialog.createDiv('modal-bg');confirmDialog.createDiv('modal').createEl('button',{text:'Confirm',attr:{id:'confirmation'}});window.confirmScope={};app.keymap.pushScope(confirmScope);document.getElementById('confirmation').focus();});
    assert.equal(await page.locator('#confirmation').evaluate(el=>{const r=el.getBoundingClientRect();return el===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);}),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>window.previewClosed),0);
    await page.evaluate(()=>{app.keymap.popScope(confirmScope);confirmDialog.remove();document.querySelector('.operon-task-media-lightbox-content button').focus();});
    // Child native/web/media previews inherit the modal layer and release only their scope.
    for(const kind of ['is-native','is-web','is-image']){
     await page.evaluate(kind=>{const link=document.querySelector('.operon-task-media-lightbox:not([hidden]) .operon-task-media-lightbox-content button');window.closeChild=Subject.openLightbox(link,{title:'Child',className:kind,render(shell){shell.createDiv('operon-task-media-lightbox-content').createEl('button',{text:'Child',attr:{id:'child-content'}});return null;}});},kind);
     assert.deepEqual(await page.locator('#child-content').evaluate(el=>{const r=el.getBoundingClientRect(),shell=el.closest('.operon-task-media-lightbox');return[getComputedStyle(shell).zIndex,shell.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),scopeStack.length];}),['50',true,3]);
     await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>scopeStack.length),2);
    }
   }
   await page.keyboard.press('Escape');
   if(desktop)assert.deepEqual(await page.evaluate(()=>[window.parentCloses,scopeStack.length]),[0,1]);
   assert.deepEqual(await page.evaluate(()=>[window.previewClosed,document.activeElement.id,document.getElementById('note').value]),[1,'note','Note draft']);
   for(const height of [320,900]){
    await page.setViewportSize({width,height});
    assert.equal(await page.evaluate(()=>{const r=document.querySelector('#owner > .modal-bg').getBoundingClientRect();return r.left<=0&&r.top<=0&&r.right>=innerWidth&&r.bottom>=innerHeight;}),true);
   }
   await page.evaluate(()=>{release();release();});
   assert.equal(await page.locator('#owner').evaluate(e=>e.classList.contains('operon-focus-modal')),false);
   scenarios++;
  } finally { await page.close(); }
 }
 console.log(JSON.stringify({ok:true,scenarios}));
} finally { await browser.close(); }
