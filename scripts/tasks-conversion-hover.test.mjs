import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';

export async function runTasksConversionHoverTests(root) {
 const source = await readFile(path.join(root, 'src/ui/live-preview-classic-task-convert.ts'), 'utf8');
 const ast = ts.createSourceFile('hover.ts', source, ts.ScriptTarget.Latest, true);
 const names = ['ClassicTaskConvertWidget', 'operonLivePreviewClassicTaskConvertExtension'];
 const production = names.map(name => {
  const node = ast.statements.find(node => node.name?.text === name); assert.ok(node, name); return node.getText(ast);
 }).join('\n');
 const temp = await mkdtemp(path.join(tmpdir(), 'operon-conversion-hover-'));
 try {
  const outfile = path.join(temp, 'hover.mjs');
  await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {tasksConversionProtectedLines} from './src/core/tasks-conversion-scope';
import {classifyClassicTaskConversionLine} from './src/core/classic-task-conversion';
import {DEFAULT_SETTINGS} from './src/types/settings';
class WidgetType {}
class RangeSetBuilder { rows=[]; add(from,to,value){this.rows.push({from,to,value});} finish(){return this.rows;} }
const Decoration={none:[],line:value=>value,widget:value=>value};
const ViewPlugin={fromClass:klass=>klass};
const isPlainCheckboxPopoverEditorElement=()=>false,allowsOperonDocumentAugmentations=()=>true;
const editorLivePreviewField={},setIcon=()=>{},setAccessibleLabelWithoutTooltip=()=>{},bindOperonHoverTooltip=()=>{},t=()=>'';
const createOwnerElement=()=>({listeners:{},setAttribute(){},addEventListener(name,action){this.listeners[name]=action;}});
${production}
const task='- [ ] Visible 📅 2026-10-09';
const viewFor=content=>({dom:{},state:{doc:EditorState.create({doc:content}).doc,field:()=>true}});
let called=0;
const callbacks={getFilePath:()=> 'A.md',getSettings:()=>({...DEFAULT_SETTINGS,inlineTaskShowTasksEmojiConvertIcon:true,inlineTaskShowPlainCheckboxConvertIcon:true}),convertTasksEmojiLine:()=>called++,upgradePlainCheckboxLine:()=>called++};
const Plugin=operonLivePreviewClassicTaskConvertExtension(callbacks);
const documents=[['<!--',task,'-->'],['%%',task,'%%'],['---',task,'---'],['    '+task],['~~~md',task,'~~~'],['~~~md','~~~ shorter',task],['\x60\x60\x60\x60md','\x60\x60\x60',task,'\x60\x60\x60\x60']];
for(const lines of documents){const plugin=new Plugin(viewFor(lines.join('\\n')));assert.equal(plugin.decorations.length,0);}
const nested=new Plugin(viewFor('- [ ] Parent\\n    '+task));assert.ok(nested.decorations.some(row=>row.value.widget));
const view=viewFor(task),plugin=new Plugin(view),widget=plugin.decorations.find(row=>row.value.widget).value.widget;
const button=widget.toDOM(view),event={preventDefault(){},stopPropagation(){}};
button.listeners.click(event);assert.equal(called,1);
view.state=viewFor('<!--\\n'+task+'\\n-->').state;
button.listeners.click(event);button.listeners.keydown({...event,key:'Enter'});assert.equal(called,1);
console.log('Tasks conversion hover: 11 production behavior checks passed.');
` }, outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', alias: { obsidian: path.join(root, 'scripts/test-support/obsidian.ts') } });
  await import(pathToFileURL(outfile).href);
 } finally { await rm(temp, { recursive: true, force: true }); }
}
