import { TFile, setIcon, type App } from 'obsidian';
import type { OperonSettings } from '../types/settings';
import { TASK_INFO_CHIPS } from '../core/task-info-chips';
import { createOwnerElement } from '../core/dom-compat';
import { t } from '../core/i18n';
import { bindResolvedChipOpening, resolveChipOpening } from './links-chip-action';
import { bindOperonHoverTooltip } from './operon-hover-tooltip';
import { setAccessibleLabelWithoutTooltip } from './accessibility-label';
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

/** Desktop Source actions share the chip resolver, current Inline line and native preview lifecycle. */
export function createTaskSourceActionButton(options: {
 app: App;
 owner: Node;
 getSettings: () => OperonSettings;
 getTask: () => IndexedTask | null | undefined;
 taskColor: string | null;
 className: string;
 canActivate?: () => boolean;
}): HTMLButtonElement {
 const button = createOwnerElement(options.owner, 'button');
 button.type = 'button';
 button.className = `${options.className} operon-task-source-action`;
 setIcon(button, TASK_INFO_CHIPS['taskInfo.source'].icon);
 const label = t('settings', 'contextualMenuActionJumpToSource');
 setAccessibleLabelWithoutTooltip(button, label);
 bindOperonHoverTooltip(button, { content: label, taskColor: options.taskColor });
 if (options.taskColor) {
  button.style.setProperty('--operon-live-hover-border', options.taskColor);
  button.style.setProperty('--operon-task-chip-hover-accent', options.taskColor);
 }
 const context = { app: options.app, getSettings: options.getSettings, getTask: options.getTask,
  getTaskById: () => undefined, getAllTasks: () => [], picker: () => null };
 bindResolvedChipOpening(button, { ...context, stopPointerDown: true,
  canActivate: options.canActivate,
  resolve: () => resolveChipOpening({ key: 'taskInfo.source' }, context),
 });
 return button;
}
