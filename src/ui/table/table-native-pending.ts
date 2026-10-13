/** Keep the last rendered table visible, but never expose it as a current query result. */
interface PendingTable {
 presetId: string;
 root: HTMLElement;
 status: HTMLElement;
 wasInert: boolean;
 busy: string | null;
}
const pendingTables = new WeakMap<HTMLElement, PendingTable>();

export function clearTableNativePending(container: HTMLElement): void {
 const pending = pendingTables.get(container);
 if (!pending) return;
 pending.root.inert = pending.wasInert;
 if (pending.busy === null) pending.root.removeAttribute('aria-busy');
 else pending.root.setAttribute('aria-busy', pending.busy);
 pending.root.classList.remove('operon-table-native-pending');
 pending.status.remove();
 container.classList.remove('operon-table-native-pending-host');
 pendingTables.delete(container);
}

/** Only the same preset may retain its DOM; first loads still use the loading surface. */
export function retainTableNativePending(
 container: HTMLElement, presetId: string, renderedPresetId: string | undefined, label: string,
): boolean {
 const root = container.querySelector<HTMLElement>('.operon-table-root');
 const pending = pendingTables.get(container);
 if (pending && pending.root === root && pending.presetId === presetId) return true;
 clearTableNativePending(container);
 if (!root || renderedPresetId !== presetId) return false;
 const status = container.createDiv({ cls: 'operon-table-native-pending-status' });
 status.setAttribute('role', 'status');
 status.setAttribute('aria-live', 'polite');
 status.textContent = label;
 pendingTables.set(container, { presetId, root, status, wasInert: root.inert, busy: root.getAttribute('aria-busy') });
 root.inert = true;
 root.setAttribute('aria-busy', 'true');
 root.classList.add('operon-table-native-pending');
 container.classList.add('operon-table-native-pending-host');
 return true;
}
