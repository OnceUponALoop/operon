import { openTaskMediaLightbox, renderTaskMediaElement, type TaskMediaPreviewSource } from './task-media-lightbox';
import { openLightboxTarget, type LightboxTarget } from './lightbox-opening';
import { getInternalPlugin, isPluginEnabled } from '../core/obsidian-app';
import { isTaskSourceOpenModifierClick } from './task-source-open-modifier';
import { App, Platform, parseLinktext, setIcon, TFile, type HoverParent } from 'obsidian';
import { asHTMLElement, getOwnerBody, getOwnerDocument, getOwnerWindow } from '../core/dom-compat';
import { t } from '../core/i18n';
import {
	classifyExternalTaskMediaPreviewUrl,
	classifyLocalTaskMediaPreview,
} from '../core/task-media-preview-kind';
import { getYoutubeEmbedUrl, parseYoutubeVideoUrl } from '../core/youtube-url';
import { setAccessibleLabelWithoutTooltip } from './accessibility-label';

export const OPERON_COMPACT_CHIP_HOVER_SOURCE = 'operon-compact-chip';
export const OPERON_TASK_TITLE_HOVER_SOURCE = 'operon-task-title';
export const OPERON_TASK_DESCRIPTION_WIKILINK_HOVER_SOURCE = 'operon-task-description-wikilink';
const OPERON_PREVIEW_BINDINGS = Symbol('operon-preview-bindings');
interface CurrentChipPreview {
 resolve: () => LightboxTarget | null;
 activate: (event: MouseEvent) => void;
}
const currentChipPreviews = new WeakMap<HTMLElement, CurrentChipPreview>();
const hoverParents = new WeakMap<HTMLElement, HoverParent>();
const activeTaskMediaPreviews = new WeakMap<Document, () => void>();
const taskMediaPreviewDisposers = new WeakMap<HTMLElement, () => void>();
const TASK_MEDIA_PREVIEW_CLOSE_DELAY_MS = 96;
const TASK_MEDIA_PREVIEW_ANCHOR_GAP_PX = 4;
const TASK_MEDIA_PREVIEW_VIEWPORT_PADDING_PX = 8;

function resolveHoverParent(element: HTMLElement): HoverParent {
	const hoverParentEl = asHTMLElement(element.closest(
		'.workspace-leaf-content, .markdown-preview-view, .markdown-embed, .markdown-source-view, .modal',
	), element) ?? getOwnerBody(element);
	const existing = hoverParents.get(hoverParentEl);
	if (existing) return existing;
	const hoverParent: HoverParent = { hoverPopover: null };
	hoverParents.set(hoverParentEl, hoverParent);
	return hoverParent;
}

function bindHoverLinkPreview(
	app: App,
	element: HTMLElement,
	linktext: string | null,
	sourcePath: string,
	source: string,
	requireModifier: boolean,
): void {
	if (!linktext && !currentChipPreviews.has(element)) return;
	const bindingKey = `${source}::${linktext}`;
	const bindings = (element as HTMLElement & {
		[OPERON_PREVIEW_BINDINGS]?: Set<string>;
	})[OPERON_PREVIEW_BINDINGS] ?? new Set<string>();
	if (bindings.has(bindingKey)) return;
	bindings.add(bindingKey);
	(element as HTMLElement & {
		[OPERON_PREVIEW_BINDINGS]?: Set<string>;
	})[OPERON_PREVIEW_BINDINGS] = bindings;

	let isHovered = false;
	let previewTriggered = false;
	const triggerPreview = (event: MouseEvent): boolean => {
		const provider = currentChipPreviews.get(element);
  if (provider) {
   if (!isTaskSourceOpenModifierClick(event) || !isPluginEnabled(getInternalPlugin(app, 'page-preview'))) return false;
   const target = provider.resolve();
   if (!target || target.kind !== 'local') return false;
   linktext = target.linktext; sourcePath = target.sourcePath;
  } else if (requireModifier && !event.metaKey && !event.ctrlKey) return false;
		(app.workspace as unknown as {
			trigger: (name: string, payload: Record<string, unknown>) => void;
		}).trigger('hover-link', {
			event,
			source,
			targetEl: element,
			linktext,
			sourcePath,
			hoverParent: resolveHoverParent(element),
		});
		return true;
	};

	element.addEventListener('mouseover', (event) => {
		const relatedTarget = event.relatedTarget;
		if (relatedTarget && element.contains(relatedTarget as Node)) return;
		isHovered = true;
		previewTriggered = triggerPreview(event);
	});
	element.addEventListener('mousemove', (event) => {
		if (!isHovered || previewTriggered) return;
		previewTriggered = triggerPreview(event);
	});
	element.addEventListener('mouseout', (event) => {
		const relatedTarget = event.relatedTarget;
		if (relatedTarget && element.contains(relatedTarget as Node)) return;
		isHovered = false;
		previewTriggered = false;
	});
}

export function bindCompactChipLinkPreview(
	app: App,
	element: HTMLElement,
	linktext: string | null,
	sourcePath: string,
): void {
	if (!currentChipPreviews.has(element)) bindHoverLinkPreview(app, element, linktext, sourcePath, OPERON_COMPACT_CHIP_HOVER_SOURCE, true);
}


/** Scoped chip routing owns one preview binding; legacy callers keep their static target. */
export function bindCurrentChipPreview(app: App, element: HTMLElement, resolve: () => LightboxTarget | null, media: boolean, activate: (event: MouseEvent) => void): void {
 currentChipPreviews.set(element, { resolve, activate });
 if (media) {
  // The provider is resolved on hover, including after a rename or field update.
  bindTaskMediaPreview(app, element, { kind: 'image', url: '', label: '' }, { sourcePath: '' });
 } else bindHoverLinkPreview(app, element, null, '', OPERON_COMPACT_CHIP_HOVER_SOURCE, true);
}

export interface TaskMediaChipPreviewTarget {
	localLinkTarget?: string | null;
	externalUrl?: string | null;
	label?: string | null;
	sourcePath: string;
}

/**
 * Media fields intentionally preview on direct hover. Other Operon links keep
 * the host-standard modifier-hover contract.
 */
export function bindTaskMediaChipPreview(
	app: App,
	element: HTMLElement,
	target: TaskMediaChipPreviewTarget,
): void {
	if (currentChipPreviews.has(element)) return;
	const source = target.externalUrl
		? resolveExternalTaskMediaPreviewSource(target.externalUrl, target.label)
		: resolveLocalTaskMediaPreviewSource(app, target.localLinkTarget, target.sourcePath, target.label);
	if (source) bindTaskMediaPreview(app, element, source, target);
}

function resolveLocalTaskMediaPreviewSource(
	app: App,
	linkTarget: string | null | undefined,
	sourcePath: string,
	label?: string | null,
): TaskMediaPreviewSource | null {
	if (!linkTarget) return null;
	const parsedLink = parseLinktext(linkTarget);
	const file = app.metadataCache.getFirstLinkpathDest(parsedLink.path, sourcePath);
	if (!(file instanceof TFile)) return null;
	const kind = classifyLocalTaskMediaPreview(file.extension);
	if (kind === 'unknown') return null;
	const pdfPage = kind === 'pdf' && /^#page=\d+$/u.test(parsedLink.subpath)
		? parsedLink.subpath
		: '';
	return {
		kind,
		url: `${app.vault.getResourcePath(file)}${pdfPage}`,
		label: label?.trim() || linkTarget,
	};
}

export function resolveExternalTaskMediaPreviewSource(url: string, label?: string | null): TaskMediaPreviewSource | null {
	const previewLabel = label?.trim() || url;
	const youtubeReference = parseYoutubeVideoUrl(url);
	if (youtubeReference) {
		return { kind: 'youtube', url: getYoutubeEmbedUrl(youtubeReference), label: previewLabel };
	}
	const kind = classifyExternalTaskMediaPreviewUrl(url);
	return kind === 'unknown' ? null : { kind, url, label: previewLabel };
}

export function bindTaskTitleLinkPreview(
	app: App,
	element: HTMLElement,
	filePath: string | null,
	hoverSourcePath?: string,
): void {
	bindHoverLinkPreview(
		app,
		element,
		filePath,
		hoverSourcePath ?? filePath ?? '',
		OPERON_TASK_TITLE_HOVER_SOURCE,
		true,
	);
}

export function bindTaskDescriptionWikilinkPreview(
	app: App,
	element: HTMLElement,
	linktext: string | null,
	sourcePath: string,
): void {
	bindHoverLinkPreview(app, element, linktext, sourcePath, OPERON_TASK_DESCRIPTION_WIKILINK_HOVER_SOURCE, true);
}

/** Release only hover media owned by a removed card; an open Lightbox has its own lifecycle. */
export function cleanupTaskMediaChipPreviews(root: HTMLElement): void {
 taskMediaPreviewDisposers.get(root)?.();
 for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) taskMediaPreviewDisposers.get(element)?.();
}

function bindTaskMediaPreview(app: App, element: HTMLElement, source: TaskMediaPreviewSource, target: TaskMediaChipPreviewTarget): void {
	taskMediaPreviewDisposers.get(element)?.();
	let previewEl: HTMLElement | null = null;
	let previewCleanup: (() => void) | null = null;
	let closeTimer: number | null = null;
	const ownerDocument = getOwnerDocument(element);
	const ownerWindow = getOwnerWindow(element);

	const cancelScheduledClose = (): void => {
		if (closeTimer === null) return;
		ownerWindow.clearTimeout(closeTimer);
		closeTimer = null;
	};
	const close = (): void => {
		cancelScheduledClose();
		previewCleanup?.();
		previewCleanup = null;
		previewEl?.remove();
		previewEl = null;
		if (activeTaskMediaPreviews.get(ownerDocument) === close) {
			activeTaskMediaPreviews.delete(ownerDocument);
		}
	};
	const scheduleClose = (): void => {
		cancelScheduledClose();
		closeTimer = ownerWindow.setTimeout(close, TASK_MEDIA_PREVIEW_CLOSE_DELAY_MS);
	};
	const open = (): void => {
		cancelScheduledClose();
		if (previewEl?.isConnected) return;
		activeTaskMediaPreviews.get(ownerDocument)?.();

		previewEl = getOwnerBody(element).createDiv('operon-task-media-hover-preview');
		previewEl.addClass(`is-${source.kind}`);
		previewCleanup = renderTaskMediaPreviewContent(app, element, previewEl, source, target, close);
		previewEl.addEventListener('mouseenter', cancelScheduledClose);
		previewEl.addEventListener('mouseleave', scheduleClose);
		positionTaskMediaPreview(element, previewEl);
		activeTaskMediaPreviews.set(ownerDocument, close);
	};

	let corePreview = false;
	const hover = (event: MouseEvent): void => {
  const provider = currentChipPreviews.get(element);
  if (provider) {
   const current = provider.resolve();
   if (!current) { close(); return; }
   const nextTarget: TaskMediaChipPreviewTarget = current.kind === 'web'
    ? { externalUrl: current.url, sourcePath: '' }
    : { localLinkTarget: current.linktext, sourcePath: current.sourcePath, label: current.label };
   const nextSource = nextTarget.externalUrl ? resolveExternalTaskMediaPreviewSource(nextTarget.externalUrl, nextTarget.label)
    : resolveLocalTaskMediaPreviewSource(app, nextTarget.localLinkTarget, nextTarget.sourcePath, nextTarget.label);
   if (!nextSource) { close(); return; }
   if (source.url !== nextSource.url) { close(); corePreview = false; }
   source = nextSource; target = nextTarget;
  }
		const useCore = Platform.isDesktopApp && !!target.localLinkTarget
			&& isTaskSourceOpenModifierClick(event)
			&& isPluginEnabled(getInternalPlugin(app, 'page-preview'));
		if (useCore) {
			close();
			if (!corePreview) app.workspace.trigger('hover-link', {
				event, source: OPERON_COMPACT_CHIP_HOVER_SOURCE, targetEl: element,
				linktext: target.localLinkTarget, sourcePath: target.sourcePath,
				hoverParent: resolveHoverParent(element),
			});
			corePreview = true;
		} else if (!corePreview) open();
	};
	const leave = (): void => { corePreview = false; scheduleClose(); };
	element.addEventListener('mouseenter', hover);
	element.addEventListener('mousemove', hover);
	element.addEventListener('mouseleave', leave);
	element.addEventListener('focusout', scheduleClose);
	taskMediaPreviewDisposers.set(element, () => {
		element.removeEventListener('mouseenter', hover);
		element.removeEventListener('mousemove', hover);
		element.removeEventListener('mouseleave', leave);
		element.removeEventListener('focusout', scheduleClose);
		close();
		taskMediaPreviewDisposers.delete(element);
	});
}

function renderTaskMediaPreviewContent(
	app: App,
	anchor: HTMLElement,
	preview: HTMLElement,
	source: TaskMediaPreviewSource,
	target: TaskMediaChipPreviewTarget,
	close: () => void,
): (() => void) | null {
	renderTaskMediaPreviewToolbar(app, anchor, preview, source, target);
	const rendered = renderTaskMediaElement(preview, source, {
		mode: 'hover',
		onError: close,
		onReady: () => {
			if (preview.isConnected) positionTaskMediaPreview(anchor, preview);
		},
	});
	if (source.kind === 'image') {
		const image = rendered.element as HTMLImageElement;
		image.addEventListener(Platform.isDesktopApp ? 'click' : 'dblclick', (event) => {
			event.preventDefault();
			event.stopPropagation();
			activateTaskMediaPreview(app, anchor, source, target, event);
		});
	}
	return rendered.cleanup;
}

function renderTaskMediaPreviewToolbar(
	app: App,
	anchor: HTMLElement,
	preview: HTMLElement,
	source: TaskMediaPreviewSource,
	target: TaskMediaChipPreviewTarget,
): void {
	const toolbar = preview.createEl('button', {
		cls: 'operon-task-media-hover-toolbar',
		attr: { type: 'button' },
	});
	setAccessibleLabelWithoutTooltip(toolbar, `${t('buttons', 'open')}: ${source.label}`);
	setIcon(toolbar.createSpan('operon-task-media-hover-open-icon'), 'zoom-in');
	toolbar.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		activateTaskMediaPreview(app, anchor, source, target, event);
	});
	toolbar.createSpan({ cls: 'operon-task-media-hover-title', text: source.label });
}

function positionTaskMediaPreview(anchor: HTMLElement, preview: HTMLElement): void {
	const ownerWindow = getOwnerWindow(anchor);
	const anchorRect = anchor.getBoundingClientRect();
	const previewRect = preview.getBoundingClientRect();
	const maxLeft = Math.max(
		TASK_MEDIA_PREVIEW_VIEWPORT_PADDING_PX,
		ownerWindow.innerWidth - previewRect.width - TASK_MEDIA_PREVIEW_VIEWPORT_PADDING_PX,
	);
	const left = Math.min(
		Math.max(anchorRect.left, TASK_MEDIA_PREVIEW_VIEWPORT_PADDING_PX),
		maxLeft,
	);
	const belowTop = anchorRect.bottom + TASK_MEDIA_PREVIEW_ANCHOR_GAP_PX;
	const aboveTop = anchorRect.top - previewRect.height - TASK_MEDIA_PREVIEW_ANCHOR_GAP_PX;
	const top = belowTop + previewRect.height <= ownerWindow.innerHeight - TASK_MEDIA_PREVIEW_VIEWPORT_PADDING_PX
		? belowTop
		: Math.max(TASK_MEDIA_PREVIEW_VIEWPORT_PADDING_PX, aboveTop);
	preview.style.left = `${Math.round(left)}px`;
	preview.style.top = `${Math.round(top)}px`;
}

function activateTaskMediaPreview(app: App, anchor: HTMLElement, source: TaskMediaPreviewSource, target: TaskMediaChipPreviewTarget, event: MouseEvent): void {
 if (Platform.isDesktopApp && (event.button !== 0 || event.detail > 1)) return;
 activeTaskMediaPreviews.get(getOwnerDocument(anchor))?.();
 if (!Platform.isDesktopApp) { openTaskMediaLightbox(app, anchor, source); return; }
 const current = currentChipPreviews.get(anchor);
 if (current) { current.activate(event); return; }
 const destination: LightboxTarget = target.externalUrl
  ? { kind: 'web', url: target.externalUrl, media: source }
  : { kind: 'local', linktext: target.localLinkTarget ?? '', sourcePath: target.sourcePath, label: source.label };
 void openLightboxTarget(app, anchor, destination, event.detail !== 0 && isTaskSourceOpenModifierClick(event) ? 'tab' : 'lightbox');
}
