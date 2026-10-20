import { Platform, type App } from 'obsidian';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { collectMarkdownProtectedRanges } from '../core/markdown-protected-ranges';
import { iterateMarkdownLinesOutsideFences } from '../core/markdown-fenced-lines';
import { asHTMLElement } from '../core/dom-compat';
import { parseCompactTaskMarkdown, type CompactTaskMarkdownLink } from './compact-task-markdown-renderer';
import { activateResolvedOpening } from './links-chip-action';
import { resolveTaskTextLink } from './task-text-link-opening';

export interface TaskTextEditorRange { from: number; to: number; sourcePath: string }

/** Resolve only a complete link token in the current buffer, never code or an embed. */
export function taskTextLinkAt(value: string, position: number): CompactTaskMarkdownLink | null {
 const lineNumber = value.slice(0, position).split('\n').length - 1;
 if (![...iterateMarkdownLinesOutsideFences(value, true)].some(([line]) => line === lineNumber)) return null;
 const range = collectMarkdownProtectedRanges(value).find(range => range.from <= position && position < range.to);
 if (!range || value[range.from - 1] === '!') return null;
 const raw = value.slice(range.from, range.to);
 const nodes = parseCompactTaskMarkdown(raw);
 if (nodes.length === 1 && (nodes[0].type === 'wikilink' || nodes[0].type === 'markdown-link')) return nodes[0];
 const url = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : trimBareUrl(raw);
 if (!raw.startsWith('<') && position >= range.from + url.length) return null;
 return /^https?:\/\/[^\s<>]+$/iu.test(url) ? {type: 'markdown-link', destination: url, label: url, external: true} : null;
}

/** Bare URLs exclude prose punctuation; explicit Markdown destinations stay literal. */
function trimBareUrl(value: string): string {
 let result = value;
 for (;;) {
  const previous = result;
  result = result.replace(/[.,;:!?"'’”]+$/u, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
   while (result.endsWith(close) && result.split(close).length > result.split(open).length) result = result.slice(0, -1);
  }
  if (result === previous) return result;
 }
}

/** Explicit host opt-in. Native text input, keyboard commands and hover remain native. */
export function taskTextLinkEditorExtension(app: App, readRange: (view: EditorView, position: number) => TaskTextEditorRange | null): Extension {
 if (!Platform.isDesktopApp) return [];
 return Prec.highest(ViewPlugin.fromClass(class {
  opening = false;
  composing = false;
  gesture: {button: number; x: number; y: number; position: number; selection: EditorView['state']['selection']; doc: EditorView['state']['doc']} | null = null;
  constructor(readonly view: EditorView) {}
  linkAt(position: number) {
   const range = readRange(this.view, position);
   if (!range || position < range.from || position >= range.to) return null;
   const value = this.view.state.doc.sliceString(range.from, range.to);
   const link = taskTextLinkAt(value, position - range.from);
   return link ? {link, source: {value, sourcePath: range.sourcePath}} : null;
  }
  open(event: MouseEvent): boolean {
   const gesture = this.gesture; this.gesture = null;
   event.preventDefault(); event.stopImmediatePropagation();
   if (!gesture || gesture.button !== event.button || event.detail > 1 || event.shiftKey || event.altKey || this.composing || this.view.composing
    || gesture.doc !== this.view.state.doc || Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y) >= 5
    || !this.view.state.selection.main.empty) return true;
   const current = this.linkAt(gesture.position);
   if (!current) return true;
   this.view.dispatch({selection: gesture.selection});
   if (this.opening) return true;
   this.opening = true;
   void activateResolvedOpening(this.view.dom, {app, resolve: () => {
    const latest = this.linkAt(gesture.position);
    return latest && gesture.doc === this.view.state.doc ? resolveTaskTextLink(app,latest.link,latest.source,false) : {kind:'missing'};
   }}, event).finally(()=> {this.opening=false;});
   return true;
  }
  position(event: MouseEvent): number | null {
   const target = asHTMLElement(event.target, this.view.dom);
   if (!target?.closest('a.internal-link, a.external-link, .cm-hmd-internal-link, .cm-link, .cm-url')) return null;
   return this.view.posAtCoords({x: event.clientX, y: event.clientY});
  }
 }, {eventHandlers: {
  mousedown(event) {
   this.gesture = null;
   if (event.button !== 0 && event.button !== 1) return false;
   const position = this.position(event);
   const current = position === null ? null : this.linkAt(position);
   const middle = event.button === 1;
   if (middle) {
    if (!current || current.link.type !== 'markdown-link' || !current.link.external || !/^https?:\/\//iu.test(current.link.destination)) return false;
    // Consume HTTP middle-down even when navigation is vetoed: native paste and
    // autoscroll start here, before auxclick can protect the draft or selection.
    event.preventDefault(); event.stopImmediatePropagation();
   }
   if (event.detail > 1 || event.shiftKey || event.altKey || this.composing || this.view.composing || !this.view.state.selection.main.empty || this.view.state.selection.ranges.length !== 1) return middle;
   if (position === null || !current) return false;
   this.gesture = {button:event.button,x:event.clientX,y:event.clientY,position,selection:this.view.state.selection,doc:this.view.state.doc};
   if (middle) return true;
   // Let CodeMirror place/select text. Only a completed, stationary click navigates.
   event.stopPropagation();
   return false;
  },
  click(event) {
   const position = this.position(event);
   if (event.button !== 0 || event.altKey || event.shiftKey || position === null || !this.linkAt(position)) return false;
   // Rejected link gestures must not fall through to Obsidian's native opener.
   return this.open(event);
  },
  auxclick(event) {
   const position = this.position(event);
   const current = position === null ? null : this.linkAt(position);
   if (event.button !== 1) return false;
   if (this.gesture?.button !== 1 && (!current || current.link.type !== 'markdown-link' || !current.link.external || !/^https?:\/\//iu.test(current.link.destination))) return false;
   return this.open(event);
  },
  dragstart() { this.gesture = null; return false; },
  compositionstart() { this.composing = true; this.gesture = null; return false; },
  compositionend() { this.composing = false; this.gesture = null; return false; },
 }}));
}
