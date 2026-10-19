import { Platform } from 'obsidian';
import { BACKGROUND_DIMMING_OPTIONS, normalizeBackgroundDimming } from '../core/background-dimming';

interface Surface {
 element: HTMLElement;
 backdrop: HTMLElement | null;
 originalOpacity: string;
 originalColor: string;
}
interface BackdropState {
 ownerDocument: Document;
 surfaces: Surface[];
 observer: MutationObserver;
 onPageHide: () => void;
}
const states = new Map<Document, BackdropState>();
let baseDimming = 50;
const modalReleases = new WeakMap<HTMLElement, () => void>();
const colorProperty = '--operon-focus-backdrop';

interface DimmingPreference { get: () => number; save: (value: number) => Promise<void> }
let dimmingPreference: DimmingPreference | null = null;
let dimmingSaveQueue: Promise<unknown> = Promise.resolve();
const dimmingListeners = new Set<() => void>();
function notifyDimmingListeners(): void { for (const listener of dimmingListeners) listener(); }

/** Share the existing settings write path between Tweaks and preview controls. */
export function bindDesktopBackdropDimmingPreference(preference: DimmingPreference): () => void {
 dimmingPreference = preference;
 updateDesktopBackdropDimming(preference.get());
 return () => {
  if (dimmingPreference !== preference) return;
  dimmingPreference = null;
  notifyDimmingListeners();
 };
}
export function getDesktopBackdropDimming(): number { return baseDimming; }
export function canSaveDesktopBackdropDimming(): boolean { return dimmingPreference !== null; }
export function subscribeDesktopBackdropDimming(listener: () => void): () => void {
 dimmingListeners.add(listener);
 listener();
 return () => { dimmingListeners.delete(listener); };
}
function requestDimmingChange(resolve: (current: number) => number): Promise<boolean> {
 const preference = dimmingPreference;
 if (!preference) return Promise.resolve(false);
 const run = dimmingSaveQueue.then(async () => {
  if (dimmingPreference !== preference) return true;
  const current = normalizeBackgroundDimming(preference.get());
  const next = normalizeBackgroundDimming(resolve(current));
  try {
   if (next !== current) await preference.save(next);
  } finally {
   if (dimmingPreference === preference) updateDesktopBackdropDimming(preference.get());
  }
  return true;
 });
 dimmingSaveQueue = run.catch(() => undefined);
 return run;
}
export function saveDesktopBackdropDimming(value: number): Promise<boolean> {
 return requestDimmingChange(() => value);
}
export function stepDesktopBackdropDimming(direction: -1 | 1): Promise<boolean> {
 return requestDimmingChange(current => {
  const index = BACKGROUND_DIMMING_OPTIONS.findIndex(value => value === current);
  return BACKGROUND_DIMMING_OPTIONS[Math.max(0, Math.min(BACKGROUND_DIMMING_OPTIONS.length - 1, index + direction))];
 });
}

function restore(surface: Surface): void {
 if (surface.originalColor) surface.element.style.setProperty(colorProperty, surface.originalColor);
 else surface.element.style.removeProperty(colorProperty);
 if (surface.backdrop) {
  if (surface.originalOpacity) surface.backdrop.style.opacity = surface.originalOpacity;
  else surface.backdrop.style.removeProperty('opacity');
 }
}
function refresh(state: BackdropState): void {
 for (const surface of [...state.surfaces]) {
  if (!surface.element.isConnected) {
   state.surfaces.splice(state.surfaces.indexOf(surface), 1);
   restore(surface);
  }
 }
 const top = state.surfaces[state.surfaces.length - 1];
 const alpha = Math.min(90, baseDimming + 5 * (state.surfaces.length - 1)) / 100;
 for (const surface of state.surfaces) {
  const color = surface === top ? `rgba(0, 0, 0, ${alpha})` : 'transparent';
  if (surface.element.style.getPropertyValue(colorProperty) !== color) surface.element.style.setProperty(colorProperty, color);
  // Modal.open assigns its own inline opacity after onOpen; normalize that multiplier too.
  if (surface.backdrop && surface.backdrop.style.opacity !== '') surface.backdrop.style.removeProperty('opacity');
 }
 if (!top) {
  state.observer.disconnect();
  state.ownerDocument.defaultView?.removeEventListener('pagehide', state.onPageHide);
  if (states.get(state.ownerDocument) === state) states.delete(state.ownerDocument);
 }
}

/** Apply a published preference to every open owner document, including auxiliary windows. */
export function updateDesktopBackdropDimming(value: unknown): void {
 baseDimming = normalizeBackgroundDimming(value);
 for (const state of states.values()) refresh(state);
 notifyDimmingListeners();
}
export function disposeDesktopBackdrops(): void {
 for (const state of states.values()) {
  state.observer.disconnect();
  state.ownerDocument.defaultView?.removeEventListener('pagehide', state.onPageHide);
  for (const surface of state.surfaces) restore(surface);
  state.surfaces.length = 0;
 }
 states.clear();
 dimmingPreference = null;
 dimmingSaveQueue = Promise.resolve();
 baseDimming = 50;
 notifyDimmingListeners();
 dimmingListeners.clear();
}

/** Each existing shell supplies its own backdrop; no new overlay or event handling is added. */
export function registerDesktopBackdrop(element: HTMLElement, modal = false): () => void {
 if (!Platform.isDesktopApp) return () => {};
 const doc = element.ownerDocument;
 const Observer = doc.defaultView?.MutationObserver;
 if (!Observer) return () => {};
 let state = states.get(doc);
 if (!state) {
  const created: BackdropState = { ownerDocument: doc, surfaces: [], onPageHide: () => {
   for (const surface of created.surfaces) restore(surface);
   created.surfaces.length = 0;
   refresh(created);
  }, observer: new Observer(records => {
   // Ignore ordinary editor rendering; only owner removal and native backdrop opacity matter.
   if (records.some(record => record.type === 'attributes'
    ? created.surfaces.some(surface => surface.backdrop === record.target)
    : record.removedNodes.length > 0 && created.surfaces.some(surface => !surface.element.isConnected))) refresh(created);
  }) };
  created.observer.observe(doc.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['style']});
  doc.defaultView?.addEventListener('pagehide', created.onPageHide);
  states.set(doc, created);
  state = created;
 }
 const existing = state.surfaces.find(surface => surface.element === element);
 if (existing) return () => {};
 const backdrop = modal ? element.querySelector<HTMLElement>(':scope > .modal-bg') : null;
 const surface: Surface = {element, backdrop, originalOpacity: backdrop?.style.opacity ?? '', originalColor: element.style.getPropertyValue(colorProperty)};
 state.surfaces.push(surface);
 refresh(state);
 let released = false;
 return () => {
  if (released) return;
  released = true;
  const index = state.surfaces.indexOf(surface);
  if (index < 0) return;
  state.surfaces.splice(index, 1);
  restore(surface);
  refresh(state);
 };
}

/** Style the existing modal backdrop without changing its events or geometry. */
export function applyDesktopModalBackdrop(containerEl: HTMLElement): () => void {
 if (!Platform.isDesktopApp) return () => {};
 modalReleases.get(containerEl)?.();
 containerEl.addClass('operon-focus-modal');
 const release = registerDesktopBackdrop(containerEl, true);
 let released = false;
 const cleanup = () => {
  if (released) return;
  released = true;
  release();
  containerEl.removeClass('operon-focus-modal');
  modalReleases.delete(containerEl);
 };
 modalReleases.set(containerEl, cleanup);
 return cleanup;
}

/** A modal opened over a preview remains part of that preview's ownership chain. */
export function isDesktopBackdropDescendant(anchor: HTMLElement, ancestor: HTMLElement): boolean {
 const surfaces = states.get(anchor.ownerDocument)?.surfaces;
 if (!surfaces) return false;
 const ancestorIndex = surfaces.findIndex(surface => surface.element === ancestor);
 return ancestorIndex >= 0 && surfaces.some((surface, index) => index > ancestorIndex && surface.element.contains(anchor));
}
