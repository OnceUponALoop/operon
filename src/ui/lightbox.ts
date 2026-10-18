import { registerDesktopBackdrop, isDesktopBackdropDescendant } from './modal-backdrop';
import { Notice, Platform, Scope, setIcon, type App, type WorkspaceLeaf } from 'obsidian';
import { asHTMLElement, getOwnerBody, getOwnerDocument, getOwnerWindow, isHTMLElement } from '../core/dom-compat';
import { t } from '../core/i18n';
import { getWindowApp } from '../core/obsidian-app';
import { setAccessibleLabelWithoutTooltip } from './accessibility-label';
import { bindOperonHoverTooltip, cleanupOperonHoverTooltips } from './operon-hover-tooltip';

export interface LightboxOptions {
	title: string;
 originLeaf?: WorkspaceLeaf;
	/** Keep an accessible title without duplicating a content-owned toolbar. */
	showTitle?: boolean;
	className?: string;
	/** Prepare a new tab after saving; return its activation step, or null to keep this view. */
	onOpenInTab?: () => Promise<(() => void) | null>;
 onOpenToRight?: () => Promise<(() => void) | null>;
 onOpenBelow?: () => Promise<(() => void) | null>;
	/** Return false to retain content; asynchronous saves complete before teardown. */
	beforeClose?: () => boolean | Promise<boolean>;
	/** Native views can open host menus outside the modal DOM. */
	nativeView?: boolean;
	/** Also called when a queued opening is cancelled before mounting. */
	onDispose?: () => void;
	/** Render into the existing shell and return content-specific cleanup. */
	render: (lightbox: HTMLElement, close: () => void) => (() => void) | null;
}

let lightboxId = 0;
export type LightboxClose = () => boolean | Promise<boolean>;
const activeLightboxes = new WeakMap<Document, LightboxClose>();
const openingRequests = new WeakMap<Document, object>();

interface LightboxSource {
 panel: HTMLElement;
 owner: Node | null;
 blocked: () => boolean;
 focus: () => void;
 closeClean: () => void;
 holds: number;
}
const sources = new Set<LightboxSource>();
interface LightboxRecord {
 shell: HTMLElement;
 modalOwner?: HTMLElement;
 originLeaf?: WorkspaceLeaf;
 parent?: LightboxRecord;
 source?: LightboxSource;
 close: LightboxClose;
 finish: (focus?: boolean) => boolean;
 prepare: () => boolean | Promise<boolean>;
 transfer: (prepare: () => Promise<(() => void) | null>) => Promise<boolean>;
}
const records = new WeakMap<LightboxClose, LightboxRecord>();

/** Explicit ownership keeps only the initiating edit session alive during preview. */
export function registerLightboxSource(panel: HTMLElement, owner: Node | null, options: Pick<LightboxSource, 'blocked' | 'focus' | 'closeClean'>): { suspended: () => boolean; dispose: () => void } {
 const source: LightboxSource = {panel, owner, ...options, holds: 0};
 sources.add(source);
 return {suspended: () => source.holds > 0, dispose: () => { sources.delete(source); }};
}
function sourceFor(anchor: HTMLElement): LightboxSource | undefined {
 return [...sources].find(source => source.panel.contains(anchor));
}
function recordFor(anchor: HTMLElement): LightboxRecord | undefined {
 const close = activeLightboxes.get(getOwnerDocument(anchor));
 const record = close && records.get(close);
 const source = sourceFor(anchor);
 return record && (record.shell.contains(anchor) || isDesktopBackdropDescendant(anchor, record.shell) || !!source?.owner && record.shell.contains(source.owner)) ? record : undefined;
}
export function getLightboxOrigin(anchor: HTMLElement): WorkspaceLeaf | undefined {
 return recordFor(anchor)?.originLeaf;
}

/** Modifier navigation from a nested surface observes the same draft/save guards. */
export async function transferLightboxOpening(anchor: HTMLElement, prepare: () => Promise<(() => void) | null>): Promise<boolean> {
 const record = recordFor(anchor);
 if (record) return record.transfer(prepare);
 const source = sourceFor(anchor);
 if (source?.blocked()) { notifyDraftTransfer(); return false; }
 if (source) { source.holds++; source.panel.inert = true; }
 try {
  const activate = await prepare();
  if (!activate) return false;
  source?.closeClean();
  activate();
  return true;
 } finally {
  if (source) {source.holds--; if (!source.holds) source.panel.inert = false;}
 }
}

function notifyDraftTransfer(): void {
 new Notice('Finish editing the description or note before opening this preview in a tab or split.');
}

export function openLightbox(anchor: HTMLElement, options: LightboxOptions): LightboxClose {
	const ownerDocument = getOwnerDocument(anchor);
	const previouslyFocused = asHTMLElement(ownerDocument.activeElement, anchor);
	const request = {};
	openingRequests.set(ownerDocument, request);
	const previous = activeLightboxes.get(ownerDocument);
 const parent = Platform.isDesktopApp ? recordFor(anchor) : undefined;
 const source = Platform.isDesktopApp ? sourceFor(anchor) : undefined;
 const modalOwner = Platform.isDesktopApp ? parent?.modalOwner
  ?? anchor.closest<HTMLElement>('.operon-focus-modal')
  ?? asHTMLElement(source?.owner, anchor)?.closest<HTMLElement>('.operon-focus-modal')
  ?? undefined : undefined;
	if (previous && !parent) {
		const result = previous();
		if (result instanceof Promise) {
			let cancelled = false;
			let opened: LightboxClose | null = null;
			void result.then(closed => {
				if (closed && !cancelled && openingRequests.get(ownerDocument) === request) opened = openLightbox(anchor, options);
				else if (!cancelled) options.onDispose?.();
			});
			return () => { if (opened) return opened(); if (!cancelled) options.onDispose?.(); cancelled = true; return true; };
		}
		if (!result) { options.onDispose?.(); return () => true; }
	}
	const nativeOverlays = '.menu, .suggestion-container, .hover-popover, .modal-container';
	const existingOverlays = new Set<Element>(options.nativeView ? Array.from(ownerDocument.querySelectorAll(nativeOverlays)) : []);
	const hasNativeOverlay = (): boolean => !!options.nativeView && Array.from(ownerDocument.querySelectorAll(nativeOverlays))
		.some(el => !existingOverlays.has(el) && el !== lightbox && !lightbox.contains(el));
	const lightbox = getOwnerBody(anchor).createDiv('operon-task-media-lightbox');
 const releaseBackdrop = registerDesktopBackdrop(lightbox);
	if (options.className) lightbox.addClass(options.className);
 if (modalOwner) lightbox.addClass('is-modal-owned');
	if (Platform.isDesktopApp) lightbox.addClass('has-content-controls');
	lightbox.setAttribute('role', 'dialog');
	lightbox.setAttribute('aria-modal', 'true');
	lightbox.tabIndex = -1;
	const title = lightbox.createDiv({ cls: 'operon-task-media-lightbox-title', text: options.title });
	title.hidden = options.showTitle === false;
	title.id = `operon-task-media-lightbox-title-${++lightboxId}`;
	lightbox.setAttribute('aria-labelledby', title.id);

	const closeButton = lightbox.createEl('button', {
		cls: 'operon-task-media-lightbox-close operon-task-media-lightbox-control',
		attr: { type: 'button' },
	});
	setIcon(closeButton, 'x');
	setAccessibleLabelWithoutTooltip(closeButton, t('buttons', 'close'));
 const tabButton = options.onOpenInTab && Platform.isDesktopApp ? lightbox.createEl('button', {
  cls: 'operon-task-media-lightbox-tab operon-task-media-lightbox-control', attr: {type: 'button'},
 }) : null;
 if (tabButton) {
  setIcon(tabButton, 'external-link');
  setAccessibleLabelWithoutTooltip(tabButton, 'Open in new tab');
  bindOperonHoverTooltip(tabButton, {content: 'Open in new tab', taskColor: null});
 }
 const splitButton = options.onOpenToRight && Platform.isDesktopApp ? lightbox.createEl('button', {cls: 'operon-task-media-lightbox-split operon-task-media-lightbox-control', attr: {type:'button'}}) : null;
 if (splitButton) {
  setIcon(splitButton, 'columns-2');
  setAccessibleLabelWithoutTooltip(splitButton, 'Open to the right');
  bindOperonHoverTooltip(splitButton, {content: 'Open to the right', taskColor: null});
 }
 const belowButton = options.onOpenBelow && Platform.isDesktopApp ? lightbox.createEl('button', {cls: 'operon-task-media-lightbox-split-below operon-task-media-lightbox-control', attr: {type:'button'}}) : null;
 if (belowButton) {
  setIcon(belowButton, 'rows-2');
  setAccessibleLabelWithoutTooltip(belowButton, 'Open below');
  bindOperonHoverTooltip(belowButton, {content: 'Open below', taskColor: null});
 }
 bindOperonHoverTooltip(closeButton, {content: t('buttons', 'close'), taskColor: null});
 let disposePosition: (() => void) | null = null;
 // A child preview must not inherit the underlying modal's Escape or Tab trap.
 const modalApp = modalOwner ? getWindowApp(getOwnerWindow(anchor)) : undefined;
 const modalScope = modalApp?.keymap ? new Scope(modalApp.scope) : null;
 let modalScopeActive = false;


	let isClosed = false;
	let contentCleanup: (() => void) | null = null;
	let closing: Promise<boolean> | null = null;
	const finishClose = (restoreFocus = true): boolean => {
		if (isClosed) return true;
		isClosed = true;
  disposePosition?.();
  cleanupOperonHoverTooltips(closeButton);
  if (tabButton) cleanupOperonHoverTooltips(tabButton);
  if (splitButton) cleanupOperonHoverTooltips(splitButton);
  if (belowButton) cleanupOperonHoverTooltips(belowButton);
		ownerDocument.removeEventListener('keydown', closeOnKeydown);
		ownerDocument.defaultView?.removeEventListener('pagehide', onPageHide);
		ownerDocument.removeEventListener('focusin', keepFocusInside, true);
		const cleanup = contentCleanup;
		contentCleanup = null;
		try {
			cleanup?.();
		} finally {
   if (modalScopeActive && modalScope) {
    modalScopeActive = false;
    modalApp?.keymap.popScope(modalScope);
   }
			releaseBackdrop();
			lightbox.remove();
			options.onDispose?.();
			if (activeLightboxes.get(ownerDocument) === close) {
				if (parent) {
     activeLightboxes.set(ownerDocument, parent.close);
     parent.shell.hidden = false; parent.shell.inert = false;
    } else activeLightboxes.delete(ownerDocument);
			}
			const focusTarget = previouslyFocused?.isConnected
				? previouslyFocused
				: anchor.isConnected ? anchor : null;
			if (source) {
    source.holds = Math.max(0, source.holds - 1);
    if (!source.holds && source.panel.isConnected) { source.panel.hidden = false; source.panel.inert = false; }
   }
   if (restoreFocus) {
    if (source?.panel.isConnected) source.focus();
    else focusTarget?.focus({ preventScroll: true });
   }
		}
		return true;
	};
 const lock = (locked: boolean): void => {
  lightbox.inert = locked; closeButton.disabled = locked;
  if (tabButton) tabButton.disabled = locked;
  if (splitButton) splitButton.disabled = locked;
  if (belowButton) belowButton.disabled = locked;
 };
 const requestClose = (): boolean | Promise<boolean> => {
  if (isClosed) return true;
  if (closing) return closing;
  if (activeLightboxes.get(ownerDocument) !== close) return false;
  const allowed = options.beforeClose?.() ?? true;
  if (!(allowed instanceof Promise)) return allowed ? finishClose() : false;
  lock(true);
  closing = allowed.then(ok => ok ? finishClose() : false).finally(() => {closing = null; if (!isClosed) lock(false);});
  return closing;
 };
 const close: LightboxClose = () => requestClose();
 const transfer = (prepare: () => Promise<(() => void) | null>): Promise<boolean> => {
  if (closing) return closing;
  if (isClosed || activeLightboxes.get(ownerDocument) !== close) return Promise.resolve(false);
  const chain: LightboxRecord[] = [];
  for (let current: LightboxRecord | undefined = record; current; current = current.parent) chain.push(current);
  const owners = [...sources].filter(candidate => chain.some(item => item.source === candidate || item.shell.contains(candidate.panel) || !!candidate.owner && item.shell.contains(candidate.owner)));
  if (owners.some(candidate => candidate.blocked())) {
   notifyDraftTransfer();
   return Promise.resolve(false);
  }
  lock(true);
  for (const candidate of owners) {candidate.holds++; candidate.panel.inert = true;}
  closing = (async () => {
   for (const item of chain) if (!await item.prepare()) return false;
   if (owners.some(candidate => candidate.blocked())) return false;
   const activate = await prepare();
   if (!activate) return false;
   for (const candidate of owners) candidate.closeClean();
   for (const item of chain) item.finish(false);
   activate();
   return true;
  })().catch(() => {new Notice('Could not open this preview. The lightbox is still open.'); return false;})
   .finally(() => {
    for (const candidate of owners) {candidate.holds--; if (!candidate.holds && candidate.panel.isConnected) candidate.panel.inert = false;}
    closing = null; if (!isClosed) lock(false);
   });
  return closing;
 };
 const record: LightboxRecord = {shell: lightbox, modalOwner, originLeaf: parent?.originLeaf ?? options.originLeaf, parent, source, close, finish: finishClose, prepare: () => options.beforeClose?.() ?? true, transfer};
 records.set(close, record);
 if (parent) {parent.shell.hidden = true; parent.shell.inert = true;}
 if (source) {source.holds++; source.panel.hidden = true; source.panel.inert = true;}

	const onPageHide = (): void => {
  void (async () => {
   for (let current: LightboxRecord | undefined = record; current; current = current.parent) if (!await current.close()) break;
  })();
 };
	const closeOnKeydown = (event: KeyboardEvent): void => {
		if (activeLightboxes.get(ownerDocument) === close && event.key === 'Escape' && !event.isComposing && Reflect.get(event, 'keyCode') !== 229 && !event.defaultPrevented && !hasNativeOverlay()) {
			event.preventDefault();
			event.stopPropagation();
			void close();
		}
	};
	const keepFocusInside = (event: FocusEvent): void => {
		if (activeLightboxes.get(ownerDocument) !== close || !isHTMLElement(event.target, lightbox) || lightbox.contains(event.target) || hasNativeOverlay()) return;
		closeButton.focus({ preventScroll: true });
	};
	lightbox.addEventListener('click', (event) => {
		if (event.target === lightbox) void close();
	});
	closeButton.addEventListener('click', () => { void close(); });
 tabButton?.addEventListener('click', () => { if (options.onOpenInTab) void transfer(options.onOpenInTab); });
 splitButton?.addEventListener('click', () => { if (options.onOpenToRight) void transfer(options.onOpenToRight); });
 belowButton?.addEventListener('click', () => { if (options.onOpenBelow) void transfer(options.onOpenBelow); });

	ownerDocument.addEventListener('keydown', closeOnKeydown);
	ownerDocument.defaultView?.addEventListener('pagehide', onPageHide);
	ownerDocument.addEventListener('focusin', keepFocusInside, true);
	activeLightboxes.set(ownerDocument, close);
	try {
  if (modalScope && modalApp) {
   modalApp.keymap.pushScope(modalScope);
   modalScopeActive = true;
  }
		const cleanup = options.render(lightbox, () => { void close(); });
		if (isClosed) cleanup?.();
		else contentCleanup = cleanup;
	} catch (error) {
		finishClose();
		throw error;
	}
 if (!isClosed && Platform.isDesktopApp) disposePosition = positionLightboxControls(lightbox);
	if (!isClosed) closeButton.focus({ preventScroll: true });
	return close;
}


const appLightboxes = new WeakMap<App, Set<LightboxClose>>();

/** Track all content types, including queued openings, for plugin unload. */
export function openAppLightbox(app: App, anchor: HTMLElement, options: LightboxOptions): LightboxClose {
 let disposed = false;
 let close: LightboxClose | undefined;
 close = openLightbox(anchor, { ...options, onDispose: () => {
  if (disposed) return;
  disposed = true;
  if (close) appLightboxes.get(app)?.delete(close);
  options.onDispose?.();
 } });
 if (!disposed) {
  let active = appLightboxes.get(app);
  if (!active) { active = new Set(); appLightboxes.set(app, active); }
  active.add(close);
 }
 return close;
}

export function disposeAppLightboxes(app: App): void {
 for (const close of [...(appLightboxes.get(app) ?? [])].reverse()) {
  const result = close();
  if (result instanceof Promise) {void result.then(closed => {if (closed) disposeAppLightboxes(app);}); break;}
  if (!result) break;
 }
}

/** Keep the action rail beside the content, with an inside-edge fallback on narrow screens. */
function positionLightboxControls(lightbox: HTMLElement): (() => void) | null {
 const content = lightbox.querySelector<HTMLElement>(':scope > .operon-task-media-lightbox-content, :scope > img');
 const win = lightbox.ownerDocument.defaultView;
 if (!content || !win) return null;
 const controlCount = lightbox.querySelectorAll('.operon-task-media-lightbox-control').length;
 const railHeight = (controlCount - 1) * 44 + 36;
 const position = (): void => {
  const rect = content.getBoundingClientRect();
  const width = win.innerWidth, height = win.innerHeight;
  const left = rect.right + 8 + 36 <= width - 8 ? rect.right + 8 : rect.right - 44;
  lightbox.style.setProperty('--operon-lightbox-control-left', `${Math.max(8, Math.min(width - 44, left))}px`);
  lightbox.style.setProperty('--operon-lightbox-control-top', `${Math.max(8, Math.min(height - railHeight - 8, rect.top + 8))}px`);
  const radius = win.getComputedStyle(content).borderTopRightRadius;
  lightbox.style.setProperty('--operon-lightbox-control-radius', Number.parseFloat(radius) > 0 ? radius : '12px');
 };
 const observer = new win.ResizeObserver(position);
 observer.observe(content);
 win.addEventListener('resize', position);
 content.addEventListener('load', position, true);
 position();
 return () => { observer.disconnect(); win.removeEventListener('resize', position); content.removeEventListener('load', position, true); };
}
