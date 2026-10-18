import { bindOperonHoverTooltip, cleanupOperonHoverTooltips } from '../../operon-hover-tooltip';
import { setAccessibleLabelWithoutTooltip } from '../../accessibility-label';
import { t } from '../../../core/i18n';
import { createButton, focusFloatingInput } from '../common';
import { getOwnerWindow } from '../../../core/dom-compat';
import { createCustomFieldPanel, type CustomScalarFieldPickerOptions } from './common';

export interface CustomTextFieldPickerOptions extends CustomScalarFieldPickerOptions<'text'> {
 rankEmptyCandidates?: (candidates: readonly string[]) => string[];
	candidates: string[];
	separateCurrentValue?: boolean;
	editMultilineValue?: (onClose: () => void) => () => void;
}

export function showCustomTextFieldPicker(
	anchor: HTMLElement | DOMRect,
	options: CustomTextFieldPickerOptions,
): () => void {
	let completed = false;
	let transitioning = false;
	let editorClose: (() => void) | undefined;
	const { panel, close } = createCustomFieldPanel(anchor, options, () => {
		cleanupOperonHoverTooltips(panel);
		if (transitioning) return;
		if (!completed) options.onCancel?.();
		options.onClose?.();
	});

	const title = panel.createDiv('operon-floating-title');
	title.textContent = options.label;

	let currentButton: HTMLButtonElement | undefined;
	if (options.separateCurrentValue && options.value) {
		const current = panel.createDiv('operon-custom-text-picker-current');
		current.createDiv({ cls: 'operon-custom-text-picker-current-label', text: t('taskEditor', 'textPickerCurrentValue') });
		currentButton = createButton('', 'operon-custom-field-picker-option operon-custom-text-picker-current-value', current);
		current.appendChild(currentButton);
		currentButton.createSpan({ text: formatCustomTextDisplayValue(options.value) });
		setAccessibleLabelWithoutTooltip(currentButton, options.value);
		bindOperonHoverTooltip(currentButton, { content: options.value, taskColor: null });
	}
	const input = panel.createEl('input');
	input.type = 'text';
	input.className = 'operon-floating-input operon-custom-field-picker-input operon-custom-text-picker-input';
	input.placeholder = options.placeholder ?? options.label;
	input.value = options.separateCurrentValue ? '' : options.value ?? '';
	currentButton?.addEventListener('click', () => {
		if (/[\r\n\u2028\u2029]/u.test(options.value ?? '') && options.editMultilineValue) {
			transitioning = true;
			close();
			editorClose = options.editMultilineValue(() => options.onClose?.());
			return;
		}
		input.value = options.value ?? '';
		activeIndex = 0;
		renderSuggestions();
		focusFloatingInput(input);
		input.select();
	});

	const list = panel.createDiv('operon-custom-field-picker-suggestions operon-custom-text-picker-suggestions');
	const actions = panel.createDiv('operon-floating-actions operon-custom-text-picker-actions');
	const countLabel = actions.createDiv('operon-custom-text-picker-count');
	actions.appendChild(countLabel);
	let matches: string[] = [];
	let activeIndex = options.separateCurrentValue ? -1 : 0;
	let explicitKeyboardSelection = false;

	const commit = (value: string): void => {
		const trimmed = value.trim();
		if (!trimmed) return;
		completed = true;
		options.onCommit(options.canonicalKey, trimmed);
		close();
	};

	const renderSuggestions = (): void => {
		list.replaceChildren();
		const query = input.value.trim().toLocaleLowerCase();
		saveButton.disabled = !!options.separateCurrentValue && !query;
		matches = uniqueCustomTextCandidates(options.candidates)
			.filter(candidate => !query || buildCustomTextSearchText(candidate).includes(query));
		if (!query && options.rankEmptyCandidates) matches = options.rankEmptyCandidates(matches);
		activeIndex = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1);
		countLabel.textContent = t('taskEditor', matches.length === 1 ? 'resultCountOne' : 'resultCountMany', { count: String(matches.length) });

		for (const [index, match] of matches.entries()) {
			const item = createButton(formatCustomTextDisplayValue(match), 'operon-custom-field-picker-option operon-custom-text-picker-option', list);
			if (options.separateCurrentValue) item.classList.add('operon-custom-text-picker-option--search');
			if (index === activeIndex) item.classList.add('is-active');
			item.addEventListener('mousemove', () => setActiveIndex(index));
			item.addEventListener('mousedown', event => {
				event.preventDefault();
				commit(match);
			});
			list.appendChild(item);
		}
	};

	const setActiveIndex = (nextIndex: number): void => {
		if (activeIndex === nextIndex) return;
		const previousItem = list.children[activeIndex] as HTMLElement | undefined;
		activeIndex = nextIndex;
		previousItem?.classList.remove('is-active');
		(list.children[activeIndex] as HTMLElement | undefined)?.classList.add('is-active');
	};

	input.addEventListener('input', () => {
		explicitKeyboardSelection = false;
		if (options.separateCurrentValue) activeIndex = input.value.trim() ? 0 : -1;
		else if (options.rankEmptyCandidates && !input.value.trim()) activeIndex = 0;
		renderSuggestions();
	});
	input.addEventListener('keydown', event => {
		if (event.key === 'ArrowDown') {
			if (matches.length === 0) return;
			event.preventDefault();
			explicitKeyboardSelection = true;
			activeIndex = Math.min(activeIndex + 1, matches.length - 1);
			renderSuggestions();
			return;
		}
		if (event.key === 'ArrowUp') {
			if (matches.length === 0) return;
			event.preventDefault();
			explicitKeyboardSelection = true;
			activeIndex = Math.max(activeIndex - 1, 0);
			renderSuggestions();
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			if (options.separateCurrentValue && !input.value.trim() && !explicitKeyboardSelection) return;
			commit(matches[activeIndex] ?? input.value);
		}
	});

	const buttonWrap = actions.createDiv('operon-custom-text-picker-button-wrap');
	if (options.onRemove && options.canRemove) {
		const clearButton = createButton(t('buttons', 'clear'), 'operon-floating-btn is-secondary', buttonWrap);
		clearButton.addEventListener('click', () => {
			completed = true;
			options.onRemove?.(options.canonicalKey);
			close();
		});
		buttonWrap.appendChild(clearButton);
	}
	const saveButton = createButton(t('buttons', 'save'), 'operon-floating-btn', buttonWrap);
	saveButton.addEventListener('click', () => commit(input.value));
	buttonWrap.appendChild(saveButton);
	panel.appendChild(actions);

	renderSuggestions();
	getOwnerWindow(input).requestAnimationFrame(() => {
		if (transitioning) return;
		focusFloatingInput(input);
		input.select();
	});
	return () => editorClose ? editorClose() : close();
}

export function uniqueCustomTextCandidates(candidates: readonly string[]): string[] {
	const seen = new Set<string>();
	return candidates.filter(value => {
		const key = value.toLocaleLowerCase();
		if (!value.trim() || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function formatCustomTextDisplayValue(value: string): string {
	const trimmed = value.trim();
	return parseCustomTextWikiLink(trimmed)?.displayValue ?? trimmed;
}

function buildCustomTextSearchText(value: string): string {
	return `${formatCustomTextDisplayValue(value)} ${value}`.toLocaleLowerCase();
}

interface CustomTextWikiLinkValue {
	displayValue: string;
}

function parseCustomTextWikiLink(value: string): CustomTextWikiLinkValue | null {
	const trimmed = value.trim();
	const match = /^!?\[\[([^\]]+)\]\]$/u.exec(trimmed);
	if (!match) return null;
	const body = match[1]?.trim() ?? '';
	if (!body) return null;
	const pipeIndex = body.indexOf('|');
	if (pipeIndex < 0) {
		return {
			displayValue: formatCustomTextWikiLinkTargetLabel(body) || trimmed,
		};
	}

	const linkTarget = body.slice(0, pipeIndex).trim();
	if (!linkTarget) return null;
	const alias = body.slice(pipeIndex + 1).trim();
	return {
		displayValue: alias || formatCustomTextWikiLinkTargetLabel(linkTarget) || trimmed,
	};
}

function formatCustomTextWikiLinkTargetLabel(linkTarget: string): string {
	const lastSegment = linkTarget.split('/').pop()?.trim() ?? linkTarget.trim();
	return lastSegment.replace(/\.md$/i, '');
}
