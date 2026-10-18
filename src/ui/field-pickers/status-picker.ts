import { getIcon } from 'obsidian';
import { normalizeTaskIconValue } from '../../core/task-icon-value';
import { Pipeline } from '../../types/pipeline';
import { t } from '../../core/i18n';
import { createButton, createFloatingPanel, requestFloatingInputFocus } from './common';
import {
	buildStatusPickerOptions,
	ensureActiveStatusOptionVisible,
	filterStatusPickerOptions,
} from './status-picker-shared';

interface StatusPickerOptions {
	pipelines: Pipeline[];
	value?: string;
	retainInputFocus?: boolean;
	onSelect: (value: string) => void;
	onClear?: () => void;
	onClose?: () => void;
}

export function showStatusPicker(anchor: HTMLElement | DOMRect, options: StatusPickerOptions): () => void {
	let completed = false;
	const { panel, close } = createFloatingPanel(anchor, 'operon-floating-panel operon-status-picker-panel', () => {
		if (!completed) options.onClose?.();
	}, {
		retainInputFocus: options.retainInputFocus,
	});

	const input = panel.createEl('input');
	input.type = 'text';
	input.className = 'operon-floating-input';
	input.placeholder = t('taskEditor', 'filterStatus');
	input.value = options.value ?? '';
	input.addEventListener('focus', () => input.select(), { once: true });

	const list = panel.createDiv('operon-status-picker-list');

	const actions = panel.createDiv('operon-floating-actions');
	if (options.onClear) {
		const clearButton = createButton(t('buttons', 'clear'), 'operon-floating-btn is-secondary', actions);
		clearButton.addEventListener('click', () => {
			completed = true;
			options.onClear?.();
			close();
		});
		actions.appendChild(clearButton);
	}

	const allStatuses = buildStatusPickerOptions(options.pipelines);
	let matches = allStatuses;
	let activeIndex = 0;

	const selectStatus = (value: string) => {
		completed = true;
		options.onSelect(value);
		close();
	};

	const updateVisibleActiveItem = () => {
		const items = Array.from(list.querySelectorAll<HTMLElement>('.operon-status-dropdown-item'));
		for (const item of items) {
			const itemIndex = Number(item.dataset.statusIndex ?? '-1');
			item.classList.toggle('is-active', itemIndex === activeIndex);
		}
		ensureActiveStatusOptionVisible(list, activeIndex);
	};

	const render = () => {
		list.replaceChildren();
		if (matches.length === 0) return;
		matches.forEach((match, index) => {
			const item = list.createEl('button');
			item.type = 'button';
			item.className = 'operon-status-dropdown-item';
			item.dataset.statusIndex = String(index);
			if (index === activeIndex) item.classList.add('is-active');

			const iconName = normalizeTaskIconValue(match.icon);
			const icon = iconName ? getIcon(iconName) : null;
			if (icon) {
				icon.classList.add('operon-status-picker-icon');
				icon.style.color = match.color;
				icon.setAttribute('aria-hidden', 'true');
				item.appendChild(icon);
			} else {
				const dot = item.createSpan('operon-status-dot');
				dot.style.background = match.color;
			}

			const label = item.createSpan('operon-status-item-name');
			label.textContent = match.value;

			item.addEventListener('mousedown', event => {
				event.preventDefault();
				selectStatus(match.value);
			});

			list.appendChild(item);
		});
		ensureActiveStatusOptionVisible(list, activeIndex);
	};

	const updateMatches = (query: string) => {
		matches = filterStatusPickerOptions(allStatuses, query);
		const selectedIndex = matches.findIndex(status => status.value === options.value);
		activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
		render();
	};

	input.addEventListener('input', () => updateMatches(input.value));
	input.addEventListener('keydown', event => {
		if (matches.length === 0) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			activeIndex = Math.min(activeIndex + 1, matches.length - 1);
			updateVisibleActiveItem();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
			updateVisibleActiveItem();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (matches[activeIndex]) selectStatus(matches[activeIndex].value);
		}
	});
	updateMatches(input.value);
	requestFloatingInputFocus(input);
	return close;
}
