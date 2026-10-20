import type { IndexedTask } from '../types/fields';

export const TASK_INFO_CHIPS = {
	'taskInfo.projectSerial': { label: 'Project Serial', icon: 'fingerprint', visible: true },
	'taskInfo.source': { label: 'Source', icon: 'file-search', visible: false },
} as const;

export type TaskInfoChipKey = keyof typeof TASK_INFO_CHIPS;
export function isTaskInfoChipKey(key: string): key is TaskInfoChipKey {
	return Object.prototype.hasOwnProperty.call(TASK_INFO_CHIPS, key) === true;
}

export function formatTaskInfoSource(task: IndexedTask, compact = false): string {
	const path = task.primary.filePath;
	const name = compact ? path.split('/').pop() ?? path : path;
	const line = task.primary.format === 'inline' ? `:${task.primary.lineNumber + 1}` : '';
	return `${name}${line}`;
}

export function getTaskInfoSourceIcon(task: IndexedTask): string {
	return task.primary.format === 'inline' ? 'text-cursor-input' : 'file-text';
}
