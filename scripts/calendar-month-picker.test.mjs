import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const temp=await mkdtemp(path.join(tmpdir(),'operon-month-picker-'));
after(()=>rm(temp,{recursive:true,force:true}));
await build({entryPoints:[path.join(root,'src/ui/calendar/calendar-month-picker.ts')],outfile:path.join(temp,'subject.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent',alias:{obsidian:path.join(root,'scripts/test-support/obsidian.ts')},banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}});
const {calendarNavigationLabels,calendarMonthTarget}=await import(pathToFileURL(path.join(temp,'subject.mjs')).href);
const source=readFileSync(path.join(root,'src/ui/calendar/calendar-view.ts'),'utf8');
const ast=ts.createSourceFile('view.ts',source,ts.ScriptTarget.Latest,true);
const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.members.some(m=>m.name?.getText(ast)==='renderCalendarDateNavigation'));
function method(name,deps={}){const node=cls.members.find(m=>m.name?.getText(ast)===name);assert.ok(node);const js=ts.transpileModule(`class Subject {${node.getText(ast)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(deps),`${js};return Subject.prototype.${name};`)(...Object.values(deps));}
class Element {
 constructor(text=''){this.textContent=text;this.children=[];this.attrs={};this.events={};this.isConnected=true;this.classList={toggle(){}};}
 createDiv(){const e=new Element();this.children.push(e);return e;}
 createEl(_tag,o){const e=new Element(o.text);e.attrs=o.attr||{};this.children.push(e);return e;}
 insertBefore(e,b){this.children.splice(this.children.indexOf(e),1);this.children.splice(this.children.indexOf(b),0,e);}
 addEventListener(name,fn){this.events[name]=fn;}
 setAttribute(k,v){this.attrs[k]=v;}
 focus(){}
 click(){this.events.click?.({preventDefault(){},stopPropagation(){}});}
}
const formats=[['YYYY-MM-DD',['2026','October 8']],['DD/MM/YYYY',['8 October','2026']],['MM/DD/YYYY',['October 8','2026']]];
for(const [format,texts] of formats)for(const sidebar of [true,false])test(`${sidebar?'sidebar':'toolbar'} ${format}: DOM order, today and year routes`,()=>{
 let picker,selected,today=0,closed=0;
 const state={anchorDate:'2026-10-08',presetId:'keep'};
 const ctx={getSettings:()=>({dateDisplayFormat:format}),ensureState:()=>state,handleTodayButtonClick:()=>today++,updateLeafState:v=>selected=v,closeActivePresetPicker(){this.activeMonthPickerClose?.();this.activeMonthPickerClose=null;this.activeMonthPickerAnchor=null;}};
 const render=method('renderCalendarDateNavigation',{calendarNavigationLabels,getAppLocale:()=> 'en-US',t:(_group,key)=>key==='mobileGoToToday'?'Go to today':'Choose',bindOperonHoverTooltip(el,options){el.tooltip=options.content;},showCalendarMonthPicker(_anchor,opts){picker=opts;return()=>{closed++;opts.onClose();};}});
 const root=new Element();render.call(ctx,root,state,{},sidebar);const buttons=root.children[0].children;
 assert.deepEqual(buttons.map(b=>b.textContent),texts);
 const year=buttons.find(b=>b.textContent==='2026'),date=buttons.find(b=>b!==year);
 assert.equal(date.tooltip,'Go to today');date.click();assert.equal(today,1);year.click();assert.equal(picker.dateKey,state.anchorDate);assert.equal(year.attrs['aria-expanded'],'true');
 year.click();assert.equal(closed,1);assert.equal(selected,undefined);
 year.click();picker.onSelect('2027-02-08');assert.deepEqual(selected,{anchorDate:'2027-02-08'});
});
for(const [from,year,month,to]of [['2026-01-31',2026,1,'2026-02-28'],['2024-01-31',2024,1,'2024-02-29'],['2024-02-29',2025,1,'2025-02-28'],['2026-12-08',2027,0,'2027-01-08'],['2026-10-08',2026,9,'2026-10-08']])test(`month target ${from} to ${to}`,()=>assert.equal(calendarMonthTarget(from,year,month),to));
for(const locale of ['en-US','de-DE','tr-TR'])test(`localized month with explicit day-first order ${locale}`,()=>{
 const label=calendarNavigationLabels('2026-10-08','DD/MM/YYYY',locale);assert.equal(label.date,`8 ${new Intl.DateTimeFormat(locale,{month:'long'}).format(new Date(2026,9,8))}`);assert.equal(label.yearFirst,false);
});
test('today preserves existing return-to-today and time-grid scroll behavior',async()=>{
 const calls=[];const ctx={updateLeafState:async s=>calls.push(s),isTimeGridCompatibleSurface:()=>true,scheduleInitialScroll:(...args)=>calls.push(args),renderGeneration:4};
 await method('handleTodayButtonClick',{localToday:()=> '2026-10-17'}).call(ctx,{anchorDate:'2026-10-08',presetId:'keep'},{});
 assert.equal(calls[0].anchorDate,'2026-10-17');assert.equal(calls[0].presetId,'keep');assert.equal(calls[1][3],true);
});
