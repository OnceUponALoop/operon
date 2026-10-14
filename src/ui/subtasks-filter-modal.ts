import { App, Modal, Platform } from 'obsidian';
import { createFloatingPanel, closeFloatingPanelsForRoot, requestFloatingInputFocus } from './field-pickers/common';
import { t } from '../core/i18n';
import { setAccessibleLabelWithoutTooltip } from './accessibility-label';
import type { FilterSet } from '../types/settings';
import type { EmbedFilterDeps, FilterSurfaceInstance } from './embed-filter-processor';
import {
	createFilterSurfaceInstance,
	destroyFilterSurfaceInstance,
} from './embed-filter-processor';
import { renderSubtasksFilterSurface, renderDynamicFileTaskFilterSurface } from './dynamic-file-task-filter';

const SUBTASKS_FILTER_MODAL_OPEN_BODY_CLASS = 'operon-subtasks-filter-modal-open';

export interface SubtasksFilterModalOptions {
	parentTaskId: string;
	fileTaskPath?: () => string;
	title?: string;
	deps: EmbedFilterDeps;
	onEditFilter?: (template: FilterSet) => void;
	onClose?: () => void;
}

export class SubtasksFilterModal extends Modal {
	private readonly options: SubtasksFilterModalOptions;
	private instance: FilterSurfaceInstance | null = null;
	private rootEl: HTMLElement | null = null;
	private readonly resizeHandler = (): void => {
		this.updateMobileViewportHeight();
	};

	constructor(app: App, options: SubtasksFilterModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.containerEl.addClass('operon-subtasks-filter-modal-container');
		this.modalEl.addClass('operon-subtasks-filter-modal');
		this.containerEl.ownerDocument.body.classList.add(SUBTASKS_FILTER_MODAL_OPEN_BODY_CLASS);
		if (Platform.isPhone) {
			this.containerEl.addClass('operon-subtasks-filter-modal-container-mobile');
			this.modalEl.addClass('operon-subtasks-filter-modal-mobile');
			window.addEventListener('resize', this.resizeHandler);
			window.visualViewport?.addEventListener('resize', this.resizeHandler);
			window.visualViewport?.addEventListener('scroll', this.resizeHandler);
			this.updateMobileViewportHeight();
		}
		this.titleEl.addClass('operon-subtasks-filter-title');
		this.titleEl.setText(this.options.title ?? t('filterSets', 'dynamicSubtasksFilterTitle'));

		this.contentEl.empty();
		this.rootEl = this.contentEl.createDiv('operon-subtasks-filter');
		this.instance = createFilterSurfaceInstance(this.rootEl);
		this.refresh();
	}

	onClose(): void {
		window.removeEventListener('resize', this.resizeHandler);
		window.visualViewport?.removeEventListener('resize', this.resizeHandler);
		window.visualViewport?.removeEventListener('scroll', this.resizeHandler);
		this.containerEl.ownerDocument.body.classList.remove(SUBTASKS_FILTER_MODAL_OPEN_BODY_CLASS);
		this.containerEl.style.removeProperty('--operon-subtasks-filter-mobile-viewport-height');
		if (this.instance) {
			destroyFilterSurfaceInstance(this.instance);
			this.instance = null;
		}
		this.rootEl = null;
		this.options.onClose?.();
	}

	refresh(): void {
		if (!this.instance) return;
		const rendered = this.options.fileTaskPath ? renderDynamicFileTaskFilterSurface(this.instance, this.options.fileTaskPath(), this.options.deps, this.options.onEditFilter) : renderSubtasksFilterSurface(
			this.instance,
			this.options.parentTaskId,
			this.options.deps,
			this.options.onEditFilter,
		);
		if (!rendered) {
			this.close();
		}
	}

	private updateMobileViewportHeight(): void {
		if (!Platform.isPhone) return;
		const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
		if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
			this.containerEl.style.setProperty('--operon-subtasks-filter-mobile-viewport-height', `${Math.round(viewportHeight)}px`);
		}
	}
}

/** Show the existing dynamic filter in the Task Editor's owned floating host. */
export function showSubtasksFilterPopover(anchor: HTMLElement, options: SubtasksFilterModalOptions): () => void {
	let instance: FilterSurfaceInstance | null = null;
	let unsubscribe: (() => void) | null = null;
	let closed = false;
	let restoreFocus = false;
	const { panel, close } = createFloatingPanel(anchor, 'operon-floating-panel operon-subtasks-filter-popover', () => {
		closed = true;
		unsubscribe?.();
		unsubscribe = null;
		closeFloatingPanelsForRoot(panel);
		if (instance) destroyFilterSurfaceInstance(instance);
		instance = null;
		if (restoreFocus && anchor.isConnected) requestFloatingInputFocus(anchor);
		options.onClose?.();
	}, {
		closeOnWindowResize: false,
		shouldClose: reason => { restoreFocus = reason === 'escape'; return true; },
		outsideClickExclusions: () => Array.from(panel.parentElement?.querySelectorAll<HTMLElement>('.operon-floating-panel') ?? []).filter(candidate => candidate !== panel),
	});
	panel.tabIndex = -1;
	panel.setAttribute('role', 'dialog');
	setAccessibleLabelWithoutTooltip(panel, t('filterSets', 'dynamicSubtasksFilterTitle'));
	instance = createFilterSurfaceInstance(panel.createDiv('operon-subtasks-filter'));
	const refresh = () => {
		if (closed || !instance) return;
		if (!renderSubtasksFilterSurface(instance, options.parentTaskId, options.deps, options.onEditFilter)) close();
	};
	try {
		refresh();
		if (!closed) {
			unsubscribe = options.deps.indexer.subscribeIndexUpdates(refresh);
			requestFloatingInputFocus(panel);
		}
	} catch (error) {
		close();
		throw error;
	}
	return close;
}
