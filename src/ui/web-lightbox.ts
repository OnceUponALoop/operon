import { Notice, Platform, WorkspaceTabs, type App, type TextFileView, type WorkspaceLeaf } from 'obsidian';
import { NativeLightboxLifecycle } from './native-lightbox-lifecycle';
import { OPERON_TABLE_FILE_VIEW_TYPE } from '../types/table';
import { getOwnerDocument, getOwnerWindow } from '../core/dom-compat';
import { getInternalPlugin, isPluginEnabled } from '../core/obsidian-app';
import { t } from '../core/i18n';
import { openAppLightbox, getLightboxOrigin, disposeAppLightboxes } from './lightbox';
import type { ResolvedLightboxFile } from './lightbox-opening';

export function nativeLightboxViewType(extension: string): string | null {
 return extension === 'md' ? 'markdown' : extension === 'base' ? 'bases' : extension === 'table' ? OPERON_TABLE_FILE_VIEW_TYPE : null;
}

export function disposeWebLightboxes(app: App): void {
 disposeAppLightboxes(app);
}

export function openWebLightbox(app: App, anchor: HTMLElement, url: string): boolean {
 if (!Platform.isDesktopApp || !isPluginEnabled(getInternalPlugin(app, 'webviewer'))) {
  new Notice(t('notifications', 'webViewerUnavailable'));
  return false;
 }
 openNativeLightbox(app, anchor, { url });
 return true;
}

export function openFileLightbox(app: App, anchor: HTMLElement, file: ResolvedLightboxFile): void {
 if (Platform.isDesktopApp) openNativeLightbox(app, anchor, { file });
}

/** Obsidian ephemeral state uses zero-based lines. */
export function lightboxFileState(target: ResolvedLightboxFile): Record<string, unknown> {
 return { ...(target.subpath ? { subpath: target.subpath } : {}),
  ...(Number.isInteger(target.line) && target.line! >= 0 ? { line: target.line, focus: true } : {}) };
}

/** Flush only edited native Markdown, never write merely because a file was viewed. */
export async function flushLightboxMarkdown(app: App, leaf: WorkspaceLeaf): Promise<boolean> {
 if (leaf.view.getViewType() !== 'markdown') return true;
 const view = leaf.view as TextFileView & { saving?: boolean; lastSavedData?: string | null };
 const file = view.file;
 if (!file) return true;
 const unchanged = (text: string) => leaf.view === view && view.file === file && view.getViewData() === text && !view.saving;
 try {
  // Native save() can return early while an autosave is already in flight.
  const deadline = Date.now() + 5000;
  while (view.saving) {
   if (Date.now() >= deadline) throw new Error('Save is still pending');
   await new Promise(resolve => getOwnerWindow(view.containerEl).setTimeout(resolve, 25));
  }
  const text = view.getViewData();
  const baseline = view.lastSavedData === undefined ? view.data : view.lastSavedData;
  if (text === baseline) return true;
  const stored = await app.vault.read(file);
  if (!unchanged(text)) return false;
  if (stored === text) return true;
  if (baseline !== stored) throw new Error('File changed while this view was open');
  await view.save();
  // Edits made while saving must remain visible, with another close available.
  if (view.getViewData() !== text) return false;
  if (await app.vault.read(file) !== text) throw new Error('Save was not confirmed');
  return unchanged(text);
 } catch {
  new Notice('Your changes could not be saved. This view is staying open so you can try again.');
  return false;
 }
}


/** getLeaf('tab') can reuse an existing empty tab. Create in the owner's group instead. */
export function getLightboxOwnerLeaf(app: App, doc: Document): WorkspaceLeaf {
 let origin = app.workspace.getMostRecentLeaf();
 const previousOwner = origin && layoutGuards.get(app)?.leaves.get(origin);
 if (previousOwner) origin = app.workspace.getLeafById((previousOwner as WorkspaceLeaf & {id: string}).id) === previousOwner ? previousOwner : null;
 if (origin?.view.containerEl.ownerDocument !== doc) {
  origin = null;
  app.workspace.iterateAllLeaves(candidate => {
   if (!origin && candidate.view.containerEl.ownerDocument === doc) origin = candidate;
  });
 }
 if (!origin?.parent) throw new Error('No tab group in this window');
 return origin;
}

export function createOwnedLightboxLeaf(app: App, doc: Document): WorkspaceLeaf {
 return app.workspace.createLeafInParent(getLightboxOwnerLeaf(app, doc).parent, -1);
}

/** Prepare a real tab without changing the selected background tab while loading. */
export async function prepareLightboxTab(app: App, doc: Document, load: (leaf: WorkspaceLeaf) => Promise<void>, placement: 'tab' | 'split' | 'below' = 'tab', origin = getLightboxOwnerLeaf(app, doc)): Promise<() => void> {
 const workspace = app.workspace as NativeWorkspace;
 const id = (origin as WorkspaceLeaf & {id?: string}).id;
 if (!origin.parent || origin.view.containerEl.ownerDocument !== doc || id && app.workspace.getLeafById(id) !== origin) throw new Error('The original tab is no longer available');
 const parent = origin.parent as WorkspaceTabs & {children: WorkspaceLeaf[]; currentTab: number; selectTabIndex: (index: number) => void};
 const selected = parent.children[parent.currentTab];
 const active = workspace.activeLeaf;
 const restore = (selection: WorkspaceLeaf | undefined, focus: WorkspaceLeaf | null): void => {
  const index = selection ? parent.children.indexOf(selection) : -1;
  if (index >= 0) parent.selectTabIndex(index);
  if (focus?.parent) app.workspace.setActiveLeaf(focus, {focus: false});
 };
 const splitParent = parent.parent as unknown as {children: Array<{dimension: number | null; setDimension: (value: number) => void}>};
 const beforeSplit = placement !== 'tab' && Array.isArray(splitParent?.children)
  ? splitParent.children.map(child => ({child, dimension: child.dimension})) : [];
 const destination = placement !== 'tab' ? app.workspace.createLeafBySplit(origin, placement === 'below' ? 'horizontal' : 'vertical', false) : app.workspace.createLeafInParent(parent, -1);
 const afterSplit = beforeSplit.length ? splitParent.children.map(child => ({child, dimension: child.dimension})) : [];
 restore(selected, active);
 try {
  if (destination.view.containerEl.ownerDocument !== doc) throw new Error('Wrong window');
  await load(destination);
  return () => app.workspace.setActiveLeaf(destination, {focus: true});
 } catch (error) {
  const selection = parent.children[parent.currentTab];
  const focus = workspace.activeLeaf;
  const stacked = workspace.lastTabGroupStacked;
  const unchangedSplit = afterSplit.length > 0 && splitParent.children.length === afterSplit.length
   && afterSplit.every((item, index) => splitParent.children[index] === item.child && item.child.dimension === item.dimension);
  const getState = destination.getViewState.bind(destination) as WorkspaceLeaf['getViewState'];
  // A failed provisional tab is not a user-closed tab and must not evict history.
  destination.getViewState = () => ({type: 'empty'});
  try { destination.detach(); }
  finally {
   destination.getViewState = getState;
   if (unchangedSplit && splitParent.children.length === beforeSplit.length
    && beforeSplit.every((item, index) => splitParent.children[index] === item.child)) {
    for (const item of beforeSplit) if (typeof item.dimension === 'number') item.child.setDimension(item.dimension);
   }
   workspace.lastTabGroupStacked = stacked;
   restore(selection === destination ? selected : selection, focus === destination ? active : focus);
  }
  throw error;
 }
}

// Native ownership operations need the exact active leaf (not only its view).
// Keep those internal fields in one typed adapter, separate from public view queries.
type NativeWorkspace = Omit<App['workspace'], 'activeLeaf' | 'getLayout'> & {
 activeLeaf: WorkspaceLeaf | null;
 activeTabGroup: WorkspaceTabs | null;
 lastTabGroupStacked?: boolean;
 getLayout: (this: App['workspace']) => Record<string, unknown>;
};
type NativeTabs = WorkspaceTabs & { containerEl: HTMLElement; component: { unload: () => void } };
const isolatedLeaves = new WeakMap<WorkspaceLeaf, { tabs: NativeTabs; release: () => void }>();
const layoutGuards = new WeakMap<App, { leaves: Map<WorkspaceLeaf, WorkspaceLeaf>; original: NativeWorkspace['getLayout']; guarded: NativeWorkspace['getLayout'] }>();

/** Only the active identifier needs projecting: isolated groups never enter the saved tree. */
function retainLayoutOwner(app: App, leaf: WorkspaceLeaf, owner: WorkspaceLeaf): () => void {
 const workspace = app.workspace as NativeWorkspace;
 let guard = layoutGuards.get(app);
 if (!guard) {
  const leaves = new Map<WorkspaceLeaf, WorkspaceLeaf>();
  const original = workspace.getLayout;
  const guarded = () => {
   const layout = original.call(app.workspace) as Record<string, unknown>;
   const active = workspace.activeLeaf;
   const previous = active && leaves.get(active);
   if (!previous) return layout;
   const identity = previous as WorkspaceLeaf & { id: string };
   const projected = { ...layout };
   if (app.workspace.getLeafById(identity.id) === previous) projected.active = identity.id;
   else delete projected.active;
   return projected;
  };
  guard = { leaves, original, guarded };
  layoutGuards.set(app, guard);
  app.workspace.getLayout = guarded;
 }
 guard.leaves.set(leaf, owner);
 return () => {
  guard.leaves.delete(leaf);
  if (!guard.leaves.size) {
   if (app.workspace.getLayout === guard.guarded) app.workspace.getLayout = guard.original;
   layoutGuards.delete(app);
  }
 };
}

/** Native tab operations stay inside an overlay-owned group, never a user's tab group. */
function createIsolatedLightboxLeaf(app: App, doc: Document, host: HTMLElement, owner = getLightboxOwnerLeaf(app, doc)): WorkspaceLeaf {
 const root = owner.getRoot();
 const container = owner.getContainer();
 // Obsidian exports WorkspaceTabs, but does not declare its workspace constructor.
 const Tabs = WorkspaceTabs as unknown as new (workspace: App['workspace']) => NativeTabs;
 const tabs = new Tabs(app.workspace);
 tabs.containerEl.addClass('operon-lightbox-tabs');
 host.appendChild(tabs.containerEl);
 let leaf: WorkspaceLeaf | null = null;
 try {
  // The isolated parent has no root attachment, so creation cannot select a user tab.
  leaf = app.workspace.createLeafInParent(tabs, -1);
  leaf.getRoot = () => root;
  leaf.getContainer = () => container;
  tabs.getRoot = () => root;
  tabs.getContainer = () => container;
  isolatedLeaves.set(leaf, { tabs, release: retainLayoutOwner(app, leaf, owner) });
  return leaf;
 } catch (error) {
  leaf?.detach();
  tabs.component.unload();
  tabs.containerEl.remove();
  throw error;
 }
}

function releaseOwnedLightboxLeaf(leaf: WorkspaceLeaf): void {
 const isolated = isolatedLeaves.get(leaf);
 if (!isolated) return;
 isolated.release();
 isolated.tabs.component.unload();
 isolated.tabs.containerEl.remove();
 isolatedLeaves.delete(leaf);
}

function openNativeLightbox(app: App, anchor: HTMLElement, target: { url: string } | { file: ResolvedLightboxFile }): void {
 const doc = getOwnerDocument(anchor);
 const isFile = 'file' in target;
 const origin = getLightboxOrigin(anchor) ?? getLightboxOwnerLeaf(app, doc);
 let closed = false;
 let ready = false;
 let leaf: WorkspaceLeaf | null = null;
 let host: HTMLElement | null = null;
 let transition: Promise<void> = Promise.resolve();
 let closeRequested = false;
 let lifecycle: NativeLightboxLifecycle | null = null;
 const prepare = async (): Promise<boolean> => {
  if (lifecycle && !await lifecycle.prepare()) {
   new Notice('The last change could not be saved. This view is staying open; review the change before closing.');
   return false;
  }
  return !leaf || await flushLightboxMarkdown(app, leaf);
 };
 const openInWorkspace = async (placement: 'tab' | 'split' | 'below'): Promise<(() => void) | null> => {
    if (!ready || !leaf) return null;
    try {
     const state = leaf.getViewState();
     const ephemeral = leaf.view.getEphemeralState();
     return await prepareLightboxTab(app, doc, async destination => {
     await destination.setViewState({...state, active: false});
     await destination.loadIfDeferred();
     if (destination.view.containerEl.ownerDocument !== doc || destination.view.getViewType() !== state.type) throw new Error('Unavailable target view');
     destination.view.setEphemeralState(ephemeral);
     }, placement, origin);
    } catch {
     new Notice(placement === 'below' ? 'Could not open below the original tab. The lightbox is still open.' : placement === 'split' ? 'Could not open to the right of the original tab. The lightbox is still open.' : 'Could not open a new tab. The lightbox is still open.');
     return null;
    }
 };
 const unavailable = () => new Notice(isFile ? 'Could not open this file in the lightbox. Please try again.' : t('notifications', 'webViewerUnavailable'));
 try {
  openAppLightbox(app, anchor, {
   originLeaf: origin,
   title: isFile ? target.file.file.name : target.url,
   showTitle: false,
   className: isFile ? 'is-native' : 'is-web',
   nativeView: true,
   onOpenInTab: () => openInWorkspace('tab'),
   onOpenToRight: () => openInWorkspace('split'),
   onOpenBelow: () => openInWorkspace('below'),
   onDispose: () => { closed = true; },
   beforeClose: () => {
    if (!ready || !leaf) return true;
    closeRequested = true;
    if (host) host.inert = true;
    return (async () => {
     try {
      await transition.catch(() => undefined);
      return await prepare();
     } catch { unavailable(); return false; }
     finally { closeRequested = false; if (host) host.inert = false; }
    })();
   },
   render: (lightbox, close) => {
    const recentLeaf = app.workspace.getMostRecentLeaf();
    const previousLeaf = recentLeaf?.view.containerEl.ownerDocument === doc ? recentLeaf : null;
    host = lightbox.createDiv(`operon-task-media-lightbox-content ${isFile ? 'operon-native-lightbox-host' : 'operon-web-lightbox-host'}`);
    host.inert = true;
    const activateOwned = (): void => {
     if (ready && !closed && leaf) app.workspace.setActiveLeaf(leaf, { focus: false });
    };
    host.addEventListener('focusin', activateOwned);
    host.addEventListener('pointerdown', activateOwned, true);
    let detachOwned: (() => void) | null = null;
    let restoreMethods: (() => void) | null = null;
    const mount = (): void => {
     if (!closed && ready && leaf) leaf.view.onResize();
    };
    const observer = new ResizeObserver(() => { if (!closed) leaf?.view.onResize(); });
    observer.observe(host);
    const onPageHide = () => close();
    doc.defaultView?.addEventListener('pagehide', onPageHide);
    let initializing: Promise<void> | null = null;
    initializing = (async () => {
     let owned: WorkspaceLeaf | null = null;
     try {
      owned = createIsolatedLightboxLeaf(app, doc, host, origin);
      leaf = owned;
      lifecycle = new NativeLightboxLifecycle(app, owned);
      const originalDetach = owned.detach.bind(owned) as WorkspaceLeaf['detach'];
      const originalSetViewState = owned.setViewState.bind(owned) as WorkspaceLeaf['setViewState'];
      const detachedLeaf = owned;
      let detached = false;
      detachOwned = () => {
       if (detached) return;
       detached = true;
       const workspace = app.workspace as App['workspace'] & { lastTabGroupStacked?: boolean };
       const stacked = workspace.lastTabGroupStacked;
       const getState = detachedLeaf.getViewState.bind(detachedLeaf) as WorkspaceLeaf['getViewState'];
       // Native detach skips closed-tab history for empty views. Keep its normal
       // cleanup without adding this ephemeral leaf or evicting a user's history.
       detachedLeaf.getViewState = () => ({ type: 'empty' });
       try { originalDetach(); }
       finally { detachedLeaf.getViewState = getState; workspace.lastTabGroupStacked = stacked; }
      };
      // Only this owned leaf is guarded; user tabs keep their normal behavior.
      owned.detach = () => close();
      owned.setViewState = (...args) => {
       const run = async (): Promise<void> => {
        if (closed || closeRequested || !owned) return;
        if (host) host.inert = true;
        try {
         if (ready && !await prepare()) return;
         if (closed) return;
         await originalSetViewState(...args);
         lifecycle?.attachCurrentView();
         mount();
        } finally {
         if (host && !closeRequested && ready) host.inert = false;
        }
       };
       transition = transition.then(run, run);
       return transition;
      };
      restoreMethods = () => { if (owned) { owned.detach = originalDetach; owned.setViewState = originalSetViewState; } };
      if (owned.view.containerEl.ownerDocument !== doc) throw new Error('Wrong window');
      if (isFile) await owned.openFile(target.file.file, { active: false, eState: lightboxFileState(target.file) });
      else await owned.setViewState({ type: 'webviewer', active: false, state: { url: target.url, navigate: true } });
      if (closed) return;
      await owned.loadIfDeferred();
      if (closed) return;
      if (owned.view.containerEl.ownerDocument !== doc || owned.view.getViewType() !== (isFile ? nativeLightboxViewType(target.file.file.extension) : 'webviewer')) throw new Error('Unavailable native view');
      // Keep the complete native view tree inside the isolated tab group.
      lifecycle.attachCurrentView();
      ready = true;
      host.inert = false;
      mount();
      if (isFile && target.file.file.extension === 'base') app.workspace.setActiveLeaf(owned, { focus: false });
     } catch {
      if (closed) return;
      close();
      unavailable();
     }
    })();
    return () => {
     closed = true;
     observer.disconnect();
     host?.removeEventListener('focusin', activateOwned);
     host?.removeEventListener('pointerdown', activateOwned, true);
     doc.defaultView?.removeEventListener('pagehide', onPageHide);
     const finishDispose = () => {
      restoreMethods?.();
      const workspace = app.workspace as NativeWorkspace;
      if (workspace.activeLeaf === leaf) {
       const previousStillOpen = previousLeaf && (isolatedLeaves.has(previousLeaf) || app.workspace.getLeavesOfType(previousLeaf.view.getViewType()).includes(previousLeaf));
       const next = previousStillOpen ? previousLeaf : app.workspace.getMostRecentLeaf();
       if (next) app.workspace.setActiveLeaf(next, { focus: false });
       else {
        // Native setActiveLeaf(null) is a no-op. Clear only this orphaned owned
        // context; the next native layout pass chooses a remaining/empty leaf.
        workspace.activeLeaf = null;
        app.workspace.activeEditor = null;
        workspace.activeTabGroup = null;
       }
      }
      try { detachOwned?.(); }
      finally {
       if (leaf) releaseOwnedLightboxLeaf(leaf);
       lifecycle?.dispose();
       leaf = null;
      }
     };
     // A native open may replace its view after an await. Do not destroy the
     // leaf before that initialization settles, or the late view can leak.
     if (!ready && initializing !== null) void initializing.then(finishDispose, finishDispose);
     else finishDispose();
    };
   },
  });
 } catch { unavailable(); }
}
