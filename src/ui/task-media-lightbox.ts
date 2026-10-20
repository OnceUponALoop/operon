import { getLightboxOwnerLeaf } from './web-lightbox';
import { Platform, type App } from 'obsidian';
import { openAppLightbox, getLightboxOrigin, applyLightboxSizeProfile } from './lightbox';
import { getOwnerWindow } from '../core/dom-compat';
import type { TaskMediaPreviewKind } from '../core/task-media-preview-kind';

export interface TaskMediaPreviewSource {
 kind: Exclude<TaskMediaPreviewKind, 'unknown'>;
 url: string;
 label: string;
}
const TASK_MEDIA_LIGHTBOX_MIN_ZOOM = 1;
const TASK_MEDIA_LIGHTBOX_MAX_ZOOM = 8;
const TASK_MEDIA_LIGHTBOX_DOUBLE_CLICK_ZOOM = 2;

interface TaskMediaElementRenderOptions {
	mode: 'hover' | 'lightbox';
	onError: () => void;
	onReady?: () => void;
}

interface TaskMediaElementRenderResult {
	element: HTMLImageElement | HTMLVideoElement | HTMLIFrameElement;
	cleanup: (() => void) | null;
}

export function renderTaskMediaElement(
	container: HTMLElement,
	source: TaskMediaPreviewSource,
	options: TaskMediaElementRenderOptions,
): TaskMediaElementRenderResult {
	if (source.kind === 'image') {
		const image = container.createEl('img', {
			attr: {
				alt: '',
				decoding: 'async',
				referrerpolicy: 'no-referrer',
				...(options.mode === 'lightbox' ? { draggable: 'false' } : {}),
			},
		});
		image.addEventListener('error', options.onError, { once: true });
		if (options.onReady) image.addEventListener('load', options.onReady, { once: true });
		image.src = source.url;
		return { element: image, cleanup: null };
	}
	if (source.kind === 'video') {
		const video = container.createEl('video', {
			attr: {
				controls: '',
				playsinline: '',
				preload: 'metadata',
			},
		});
		video.addEventListener('error', options.onError, { once: true });
		if (options.onReady) video.addEventListener('loadedmetadata', options.onReady, { once: true });
		video.src = source.url;
		return {
			element: video,
			cleanup: () => {
				video.pause();
				video.removeAttribute('src');
				video.load();
			},
		};
	}

	const frameAttributes: Record<string, string> = {
		title: source.label,
		loading: 'eager',
		referrerpolicy: source.kind === 'youtube' ? 'strict-origin-when-cross-origin' : 'no-referrer',
	};
	if (source.kind === 'youtube') {
		frameAttributes.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share';
		frameAttributes.allowfullscreen = '';
	}
	const frame = container.createEl('iframe', { attr: frameAttributes });
	if (options.onReady) frame.addEventListener('load', options.onReady, { once: true });
	frame.src = source.url;
	return { element: frame, cleanup: () => frame.removeAttribute('src') };
}

export function openTaskMediaLightbox(app: App, anchor: HTMLElement, source: TaskMediaPreviewSource, onOpenInTab?: () => Promise<(() => void) | null>, onOpenToRight?: () => Promise<(() => void) | null>, onOpenBelow?: () => Promise<(() => void) | null>): void {
	openAppLightbox(app, anchor, {
  originLeaf: Platform.isDesktopApp ? getLightboxOrigin(anchor) ?? getLightboxOwnerLeaf(app, anchor.ownerDocument) : undefined,
		title: source.label,
		onOpenInTab,
		onOpenToRight,
		onOpenBelow,
		className: `is-${source.kind}`,
		render: (lightbox, close) => {
			const mediaHost = source.kind === 'image'
				? lightbox
				: lightbox.createDiv(`operon-task-media-lightbox-content is-${source.kind}`);
			const rendered = renderTaskMediaElement(mediaHost, source, { mode: 'lightbox', onError: close });
			applyLightboxSizeProfile(lightbox, source.kind);
			if (source.kind === 'image') {
				bindTaskMediaLightboxZoom(lightbox, rendered.element as HTMLImageElement);
			} else {
				rendered.element.tabIndex = 0;
			}
			return rendered.cleanup;
		},
	});
}

function bindTaskMediaLightboxZoom(lightbox: HTMLElement, image: HTMLImageElement): void {
	let zoom = TASK_MEDIA_LIGHTBOX_MIN_ZOOM;
	let panX = 0;
	let panY = 0;
	let dragPointerId: number | null = null;
	let dragX = 0;
	let dragY = 0;

	const clampPan = (): void => {
		if (zoom <= TASK_MEDIA_LIGHTBOX_MIN_ZOOM) {
			panX = 0;
			panY = 0;
			return;
		}
		const ownerWindow = getOwnerWindow(lightbox);
		const style = ownerWindow.getComputedStyle(lightbox);
		const availableWidth = lightbox.clientWidth
			- Number.parseFloat(style.paddingLeft)
			- Number.parseFloat(style.paddingRight);
		const availableHeight = lightbox.clientHeight
			- Number.parseFloat(style.paddingTop)
			- Number.parseFloat(style.paddingBottom);
		const maxPanX = Math.max(0, (image.offsetWidth * zoom - availableWidth) / 2);
		const maxPanY = Math.max(0, (image.offsetHeight * zoom - availableHeight) / 2);
		panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
		panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
	};
	const applyTransform = (): void => {
		clampPan();
		image.style.transform = `translate3d(${Math.round(panX)}px, ${Math.round(panY)}px, 0) scale(${zoom})`;
		lightbox.toggleClass('is-zoomed', zoom > TASK_MEDIA_LIGHTBOX_MIN_ZOOM);
	};
	const setZoom = (nextZoom: number, clientX: number, clientY: number): void => {
		const clampedZoom = Math.max(
			TASK_MEDIA_LIGHTBOX_MIN_ZOOM,
			Math.min(TASK_MEDIA_LIGHTBOX_MAX_ZOOM, nextZoom),
		);
		if (clampedZoom === zoom) return;
		const bounds = lightbox.getBoundingClientRect();
		const centerX = bounds.left + bounds.width / 2;
		const centerY = bounds.top + bounds.height / 2;
		const ratio = clampedZoom / zoom;
		panX = clientX - centerX - (clientX - centerX - panX) * ratio;
		panY = clientY - centerY - (clientY - centerY - panY) * ratio;
		zoom = clampedZoom;
		applyTransform();
	};

	lightbox.addEventListener('wheel', (event) => {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			setZoom(zoom * Math.exp(-event.deltaY * 0.004), event.clientX, event.clientY);
			return;
		}
		if (zoom > TASK_MEDIA_LIGHTBOX_MIN_ZOOM) {
			panX -= event.deltaX;
			panY -= event.deltaY;
			applyTransform();
		}
	}, { passive: false });
	image.addEventListener('dblclick', (event) => {
		event.preventDefault();
		event.stopPropagation();
		setZoom(
			zoom > TASK_MEDIA_LIGHTBOX_MIN_ZOOM
				? TASK_MEDIA_LIGHTBOX_MIN_ZOOM
				: TASK_MEDIA_LIGHTBOX_DOUBLE_CLICK_ZOOM,
			event.clientX,
			event.clientY,
		);
	});
	image.addEventListener('pointerdown', (event) => {
		if (zoom <= TASK_MEDIA_LIGHTBOX_MIN_ZOOM || event.button !== 0) return;
		event.preventDefault();
		dragPointerId = event.pointerId;
		dragX = event.clientX;
		dragY = event.clientY;
		image.setPointerCapture(event.pointerId);
		lightbox.addClass('is-dragging');
	});
	image.addEventListener('pointermove', (event) => {
		if (event.pointerId !== dragPointerId) return;
		panX += event.clientX - dragX;
		panY += event.clientY - dragY;
		dragX = event.clientX;
		dragY = event.clientY;
		applyTransform();
	});
	const endDrag = (event: PointerEvent): void => {
		if (event.pointerId !== dragPointerId) return;
		dragPointerId = null;
		lightbox.removeClass('is-dragging');
		if (image.hasPointerCapture(event.pointerId)) image.releasePointerCapture(event.pointerId);
	};
	image.addEventListener('pointerup', endDrag);
	image.addEventListener('pointercancel', endDrag);
}
