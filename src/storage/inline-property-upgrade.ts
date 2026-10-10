import type { DataAdapter } from 'obsidian';
import { sha256HexForStorage } from './storage-sha256';

/** Immutable preimage before the first explicit schema-3 Save. Never restores over newer data. */
export async function prepareInlinePropertyUpgradeBackup(
 adapter: Pick<DataAdapter, 'exists' | 'read' | 'write'> & Partial<Pick<DataAdapter, 'mkdir'>>,
 pluginDir: string, source: string,
): Promise<string> {
 const directory = pluginDir + '/backups/inline-properties';
 for (const path of [pluginDir + '/backups', directory]) {
  if (!await adapter.exists(path)) {
   if (!adapter.mkdir) throw new Error('Property upgrade backup directory unavailable');
   await adapter.mkdir(path);
  }
 }
 const path = directory + '/schema-2-' + await sha256HexForStorage(source) + '.json';
 if (!await adapter.exists(path)) {
  try { await adapter.write(path, source); }
  catch (error) {
   if (!await adapter.exists(path) || await adapter.read(path) !== source) throw error;
  }
 }
 if (await adapter.read(path) !== source) throw new Error('Property upgrade backup verification failed');
 return path;
}
