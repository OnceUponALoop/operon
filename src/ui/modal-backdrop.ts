import { Platform } from 'obsidian';

/** Style the existing modal backdrop without changing its events or geometry. */
export function applyDesktopModalBackdrop(containerEl: HTMLElement): () => void {
	if (!Platform.isDesktopApp) return () => {};
	containerEl.addClass('operon-focus-modal');
	let released = false;
	return () => {
		if (released) return;
		released = true;
		containerEl.removeClass('operon-focus-modal');
	};
}
