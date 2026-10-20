import { IndexedTask } from '../types/fields';

export type SubtaskActionKind = 'inline' | 'file';

export interface SubtaskActionHandlers {
	inline: () => void | Promise<void>;
	file: () => void | Promise<void>;
}

export function resolveSubtaskActionKind(
	task: Pick<IndexedTask, 'primary'> | null | undefined,
): SubtaskActionKind {
	return task?.primary.format === 'yaml' ? 'file' : 'inline';
}

/** Chip shortcuts preserve the parent-kind default and offer Inline for File parents. */
export function resolveSubtaskChipKinds(
	task: Pick<IndexedTask, 'primary'> | null | undefined,
): SubtaskActionKind[] {
	return resolveSubtaskActionKind(task) === 'file' ? ['file', 'inline'] : ['inline'];
}

export async function dispatchSubtaskActionByParentKind(
	task: Pick<IndexedTask, 'primary'> | null | undefined,
	handlers: SubtaskActionHandlers,
): Promise<SubtaskActionKind> {
	const kind = resolveSubtaskActionKind(task);
	if (kind === 'file') {
		await handlers.file();
		return kind;
	}
	await handlers.inline();
	return kind;
}

export function resolveSubtaskActionLabelKey(
	task: Pick<IndexedTask, 'primary'> | null | undefined,
): 'addInlineSubtask' | 'addFileSubtask' {
	return resolveSubtaskActionLabelKeyForKind(resolveSubtaskActionKind(task));
}

export function resolveSubtaskActionIcon(
	task: Pick<IndexedTask, 'primary'> | null | undefined,
): 'list-plus' | 'file-plus-corner' {
	return resolveSubtaskActionIconForKind(resolveSubtaskActionKind(task));
}

export function resolveSubtaskActionLabelKeyForKind(
	kind: SubtaskActionKind,
): 'addInlineSubtask' | 'addFileSubtask' {
	return kind === 'file' ? 'addFileSubtask' : 'addInlineSubtask';
}

export function resolveSubtaskActionIconForKind(
	kind: SubtaskActionKind,
): 'list-plus' | 'file-plus-corner' {
	return kind === 'file' ? 'file-plus-corner' : 'list-plus';
}
