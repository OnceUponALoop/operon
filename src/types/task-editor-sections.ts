/** Stable identities are independent of user-facing section names. */
export const TASK_EDITOR_SECTION_IDS = [
 'description', 'notes', 'stats', 'commands', 'overview', 'planning',
 'activity', 'connections', 'additional', 'sessions',
] as const;
export type TaskEditorSectionId = typeof TASK_EDITOR_SECTION_IDS[number];
export interface TaskEditorSection { id: TaskEditorSectionId; name: string; enabled?: boolean }

export function normalizeTaskEditorSections(value: unknown): TaskEditorSection[] {
 const result: TaskEditorSection[] = [];
 const seen = new Set<string>();
 for (const item of Array.isArray(value) ? value : []) {
  if (!item || typeof item !== 'object') continue;
  const { id, name, enabled } = item as Record<string, unknown>;
  if (typeof id !== 'string' || !TASK_EDITOR_SECTION_IDS.some(key => key === id) || seen.has(id)) continue;
  seen.add(id);
  result.push({ ...(id !== 'description' && enabled === false ? { enabled: false } : {}), id: id as TaskEditorSectionId, name: typeof name === 'string' ? name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) : '' });
 }
 for (const id of TASK_EDITOR_SECTION_IDS) if (!seen.has(id)) result.push({ id, name: '' });
 return result;
}
