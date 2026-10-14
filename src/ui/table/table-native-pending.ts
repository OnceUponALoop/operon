/** Retained pixels are not a current query result. Only verified rows stay actionable. */
interface PendingTable {
 presetId: string;
 root: HTMLElement;
 status: HTMLElement;
 renderState: object;
 locked: Map<HTMLElement, boolean>;
}
const pendingTables = new WeakMap<HTMLElement, PendingTable>();

export function getPendingTableRenderState<T extends object>(container: HTMLElement): T | null {
 return (pendingTables.get(container)?.renderState as T | undefined) ?? null;
}

export function clearTableNativePending(container: HTMLElement): void {
 const pending = pendingTables.get(container);
 if (!pending) return;
 for (const [element, inert] of pending.locked) {
  element.inert = inert;
  element.removeAttribute('aria-busy');
  element.removeAttribute('data-operon-pending-label');
  element.classList.remove('operon-table-row-pending');
 }
 pending.root.removeAttribute('aria-busy');
 pending.status.remove();
 container.classList.remove('operon-table-native-pending-host');
 pendingTables.delete(container);
}

/** Same-preset DOM may survive a pending source, but never supplies a query/export snapshot. */
export function retainTableNativePending(
 container: HTMLElement, presetId: string, renderedPresetId: string | undefined, label: string,
 verifiedRowKeys?: ReadonlySet<string>, renderState?: object | null,
): boolean {
 const root = container.querySelector<HTMLElement>('.operon-table-root');
 const previous = pendingTables.get(container);
 const state = renderState ?? previous?.renderState;
 const samePreset = renderedPresetId === presetId || previous?.presetId === presetId;
 clearTableNativePending(container);
 if (!root || !samePreset || !state) return false;
 const status = container.createDiv({ cls: 'operon-table-native-pending-status' });
 status.setAttribute('role', 'status');
 status.setAttribute('aria-live', 'polite');
 status.textContent = label;
 const locked = new Map<HTMLElement, boolean>();
 // Non-row controls depend on the complete query: export, grouping, summaries and Gantt.
 for (const element of Array.from(root.querySelectorAll<HTMLElement>('.operon-table-row, .operon-table-group-row, .operon-table-summary-row, .operon-table-toolbar, .operon-table-header, .operon-table-gantt-timeline-pane, .operon-table-gantt-divider'))) {
  if (element.classList.contains('operon-table-row') && verifiedRowKeys?.has(element.dataset.operonVirtualRowKey ?? element.dataset.operonId ?? '')) continue;
  locked.set(element, element.inert);
  element.inert = true;
  element.setAttribute('aria-busy', 'true');
  if (element.classList.contains('operon-table-row')) {
   element.classList.add('operon-table-row-pending');
   element.dataset.operonPendingLabel = label;
  }
 }
 root.setAttribute('aria-busy', 'true');
 pendingTables.set(container, { presetId, root, status, renderState: state, locked });
 container.classList.add('operon-table-native-pending-host');
 return true;
}
