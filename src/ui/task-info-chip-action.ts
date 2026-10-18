import { TFile, type App } from 'obsidian';
import type { IndexedTask } from '../types/fields';

/** Resolve the current identity before navigation; never let openLinkText create a missing source. */
export function bindTaskInfoSourceAction(
	chip: HTMLElement,
	open: () => unknown,
	app: App,
	getTask: () => IndexedTask | null | undefined,
): void {
	chip.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
	});
	chip.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
	chip.addEventListener('click', event => {
		event.preventDefault();
		event.stopPropagation();
		const task = getTask();
		if (!task || !(app.vault.getAbstractFileByPath(task.primary.filePath) instanceof TFile)) return;
		open();
	});
}
