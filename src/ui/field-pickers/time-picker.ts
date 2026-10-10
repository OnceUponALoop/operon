import { App } from 'obsidian';
import { t } from '../../core/i18n';
import { getAppLocale } from '../../core/obsidian-app';
import { OperonSettings } from '../../types/settings';
import { createButton, createFloatingPanel, focusFloatingInput, resolvePickerApp, scrollChildIntoView } from './common';
import {
	getNextQuarterHourSlotIndex,
	getQuarterHourSlots,
	getTimeDigitsFromCanonicalTime,
	moveTimeSuggestion,
	isValidTimePrefix,
	resolveTimeInput,
	matchQuarterHourSlots,
	parseStoredDatetimeValue,
	QuarterHourSlot,
	remapSlotIndexForMeridiem,
	resolveMeridiem,
	tryResolveSlotIndexFromDigits,
} from './datetime-time-grid';

export interface TimePickerOptions {
	app?: App;
	settings: Pick<OperonSettings, 'timeFormat'>;
	value?: string;
	onSelect: (value: string) => void;
	onCancel?: () => void;
	onClose?: () => void;
}

const EDITABLE_CARET_POSITIONS = [0, 1, 3, 4];

export function showTimePicker(anchor: HTMLElement | DOMRect, options: TimePickerOptions): () => void {
	let completed = false;
	const app = resolvePickerApp(anchor, options.app);
	const timeFormat = options.settings.timeFormat;
	let slots = getQuarterHourSlots();
	const initial = parseStoredDatetimeValue(options.value);
	const { panel, close } = createFloatingPanel(anchor, 'operon-floating-panel operon-time-picker-panel', () => {
		if (!completed) options.onCancel?.();
		options.onClose?.();
	});

	const topRow = panel.createDiv('operon-datetime-picker-top-row');
	const topTimeWrap = topRow.createDiv('operon-datetime-picker-top-time');
	const timeInput = topTimeWrap.createEl('input', {
		type: 'text',
		cls: 'operon-floating-input operon-datetime-picker-time-input',
	});
	timeInput.placeholder = t('taskEditor', 'datetimeTimePlaceholder');

	let meridiemButtons: { am: HTMLButtonElement; pm: HTMLButtonElement } | null = null;
	if (timeFormat === '12h') {
		const meridiemToggle = topTimeWrap.createDiv('operon-datetime-picker-meridiem');
		meridiemButtons = {
			am: createButton(t('taskEditor', 'datetimeAm'), 'operon-datetime-picker-meridiem-btn', meridiemToggle),
			pm: createButton(t('taskEditor', 'datetimePm'), 'operon-datetime-picker-meridiem-btn', meridiemToggle),
		};
		meridiemToggle.append(meridiemButtons.am, meridiemButtons.pm);
	}

	const timeResults = topTimeWrap.createDiv('operon-datetime-picker-time-results');
	timeResults.addClass('is-open');

	const actions = panel.createDiv('operon-floating-actions');
	const applyButton = createButton(t('buttons', 'apply'), 'operon-floating-btn', actions);
	actions.appendChild(applyButton);

	let currentMeridiem: 'am' | 'pm' = initial.timePart ? initial.meridiem : 'am';
	let timeBuffer = (initial.timePart
		? getTimeDigitsFromCanonicalTime(initial.timePart, timeFormat, currentMeridiem)
		: '').padEnd(4, '_').slice(0, 4);
	let activeTimeIndex: number | null = initial.slotIndex ?? getNextQuarterHourSlotIndex();
	let visibleTimeIndices: number[] = [];

	const commit = (value: string) => {
		completed = true;
		options.onSelect(value);
		close();
	};

	const formatTimeLabel = (slot: QuarterHourSlot): string => {
		const baseDate = new Date(2026, 0, 1, slot.hour24, slot.minute, 0, 0);
		return new Intl.DateTimeFormat(getAppLocale(app), {
			hour: 'numeric',
			minute: '2-digit',
			hour12: timeFormat === '12h',
		}).format(baseDate);
	};

	const syncTimeInputValue = () => {
		timeInput.value = `${timeBuffer[0] ?? '_'}${timeBuffer[1] ?? '_'}:${timeBuffer[2] ?? '_'}${timeBuffer[3] ?? '_'}`;
	};

	const getMatchingDigits = (bufferValue = timeBuffer, lastBufferIndex = bufferValue.length - 1): string => {
		let digits = '';
		for (let index = 0; index <= Math.min(lastBufferIndex, bufferValue.length - 1); index += 1) {
			const char = bufferValue[index];
			if (!/\d/.test(char)) break;
			digits += char;
		}
		return digits;
	};

	const setTimeCaret = (requested: number) => {
		const position = EDITABLE_CARET_POSITIONS.includes(requested)
			? requested
			: EDITABLE_CARET_POSITIONS.find(pos => pos >= requested) ?? EDITABLE_CARET_POSITIONS[EDITABLE_CARET_POSITIONS.length - 1];
		window.setTimeout(() => timeInput.setSelectionRange(position, position), 0);
	};

	const getEditableIndexFromCaret = (caret: number): number => {
		if (caret <= 0) return 0;
		if (caret === 1) return 1;
		if (caret <= 3) return 2;
		return 3;
	};

	const refreshApplyState = () => {
		applyButton.disabled = !resolveTimeInput(timeBuffer, timeFormat, currentMeridiem);
	};

	const scrollActiveTimeIntoView = () => {
		const active = timeResults.querySelector<HTMLElement>('.operon-datetime-picker-time-item.is-active');
		scrollChildIntoView(timeResults, active);
	};

	const refreshMeridiemUi = () => {
		if (!meridiemButtons) return;
		meridiemButtons.am.classList.toggle('is-active', currentMeridiem === 'am');
		meridiemButtons.pm.classList.toggle('is-active', currentMeridiem === 'pm');
	};

	const renderTimeResults = () => {
		timeResults.replaceChildren();
		for (const index of visibleTimeIndices) {
			const slot = slots[index];
			const button = timeResults.createEl('button');
			button.type = 'button';
			button.className = 'operon-field-menu-item operon-datetime-picker-time-item';
			if (index === activeTimeIndex) button.classList.add('is-active');
			button.textContent = formatTimeLabel(slot);
			button.addEventListener('mousemove', () => {
				if (activeTimeIndex === index) return;
				timeResults.querySelector('.is-active')?.classList.remove('is-active');
				activeTimeIndex = index;
				button.classList.add('is-active');
			});
			button.addEventListener('mousedown', event => {
				event.preventDefault();
				activeTimeIndex = index;
				timeBuffer = getTimeDigitsFromCanonicalTime(slot.canonical, timeFormat, currentMeridiem).padEnd(4, '_').slice(0, 4);
				syncTimeInputValue();
				refreshTimeMatches();
				commit(slot.canonical);
			});
			timeResults.appendChild(button);
		}
		refreshApplyState();
		scrollActiveTimeIntoView();
	};

	const refreshTimeMatches = () => {
		const match = matchQuarterHourSlots({
			digits: getMatchingDigits(),
			anchorIndex: activeTimeIndex ?? getNextQuarterHourSlotIndex(),
			timeFormat,
			meridiem: currentMeridiem,
		});
		slots = match.additionalSlots ? [...getQuarterHourSlots(), ...match.additionalSlots] : getQuarterHourSlots();
		activeTimeIndex = match.activeIndex;
		visibleTimeIndices = match.visibleIndices;
		refreshMeridiemUi();
		renderTimeResults();
	};

	const moveActiveTime = (delta: number) => {
		activeTimeIndex = moveTimeSuggestion(visibleTimeIndices, activeTimeIndex, delta);
		if (activeTimeIndex === null) return;
		currentMeridiem = resolveMeridiem(slots[activeTimeIndex].hour24);
		timeBuffer = getTimeDigitsFromCanonicalTime(slots[activeTimeIndex].canonical, timeFormat, currentMeridiem).padEnd(4, '_').slice(0, 4);
		syncTimeInputValue();
		refreshMeridiemUi();
		renderTimeResults();
	};

	const updateTimeFromDigitInput = (nextBuffer: string, caretPosition: number) => {
		timeBuffer = nextBuffer
			.replace(/[^\d_]/g, '')
			.padEnd(4, '_')
			.slice(0, 4);
		syncTimeInputValue();
		const exactIndex = tryResolveSlotIndexFromDigits(getMatchingDigits(), timeFormat, currentMeridiem);
		if (exactIndex !== null) activeTimeIndex = exactIndex;
		refreshTimeMatches();
		setTimeCaret(caretPosition);
	};

	const acceptTimeDigit = (digit: string, editableIndex: number): void => {
		const digits = timeBuffer.split('');
		const start = timeInput.selectionStart ?? 0;
		const end = timeInput.selectionEnd ?? start;
		for (let index = 0; index < 4; index++) {
			if (EDITABLE_CARET_POSITIONS[index] >= start && EDITABLE_CARET_POSITIONS[index] < end) digits[index] = '_';
		}
		if (digits.slice(0, editableIndex).some(char => !/\d/.test(char))) return;
		digits[editableIndex] = digit;
		if (!isValidTimePrefix(digits.slice(0, editableIndex + 1).join(''), timeFormat, false)) return;
		// Clear an invalid suffix when changing the hour, but never round the minute.
		const full = digits.join('');
		if (!full.includes('_') && !isValidTimePrefix(full, timeFormat, false)) {
			for (let index = editableIndex + 1; index < 4; index++) digits[index] = '_';
		}
		updateTimeFromDigitInput(digits.join(''), EDITABLE_CARET_POSITIONS[Math.min(3, editableIndex + 1)]);
	};

	// Native input events cover paste and keyboards that do not emit digit keydowns.
	timeInput.addEventListener('input', () => {
		const digits = timeInput.value.trim().replace(':', '');
		updateTimeFromDigitInput(/^[\d_]{0,4}$/.test(digits) ? digits : '____', timeInput.selectionStart ?? 0);
	});

	const setMeridiem = (next: 'am' | 'pm') => {
		if (currentMeridiem === next) return;
		currentMeridiem = next;
		if (activeTimeIndex !== null && activeTimeIndex < getQuarterHourSlots().length) {
			activeTimeIndex = remapSlotIndexForMeridiem(activeTimeIndex, next);
		}
		if (getMatchingDigits().length === 4) {
			const exactIndex = tryResolveSlotIndexFromDigits(getMatchingDigits(), timeFormat, currentMeridiem);
			if (exactIndex !== null) activeTimeIndex = exactIndex;
		}
		refreshTimeMatches();
	};

	meridiemButtons?.am.addEventListener('click', () => setMeridiem('am'));
	meridiemButtons?.pm.addEventListener('click', () => setMeridiem('pm'));

	timeInput.addEventListener('focus', () => {
		refreshTimeMatches();
	});

	timeInput.addEventListener('keydown', event => {
		if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveActiveTime(1);
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveActiveTime(-1);
			return;
		}
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			const current = timeInput.selectionStart ?? 0;
			const editableIndex = getEditableIndexFromCaret(current);
			const nextEditable = event.key === 'ArrowLeft'
				? Math.max(0, editableIndex - 1)
				: Math.min(3, editableIndex + 1);
			setTimeCaret(EDITABLE_CARET_POSITIONS[nextEditable]);
			return;
		}
		if (event.key === 'Backspace' || event.key === 'Delete') {
			event.preventDefault();
			const current = timeInput.selectionStart ?? 0;
			const editableIndex = getEditableIndexFromCaret(current);
			const removeIndex = event.key === 'Backspace'
				? Math.max(0, editableIndex - (current === 0 ? 0 : 1))
				: editableIndex;
			const digits = timeBuffer.split('');
			digits[removeIndex] = '_';
			updateTimeFromDigitInput(digits.join(''), EDITABLE_CARET_POSITIONS[Math.max(0, removeIndex)]);
			return;
		}
		if (/^\d$/.test(event.key)) {
			event.preventDefault();
			const current = timeInput.selectionStart ?? 0;
			const editableIndex = getEditableIndexFromCaret(current);
			acceptTimeDigit(event.key, editableIndex);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			const time = resolveTimeInput(timeBuffer, timeFormat, currentMeridiem);
			if (time) commit(time);
		}
	});

	applyButton.addEventListener('click', () => {
		const time = resolveTimeInput(timeBuffer, timeFormat, currentMeridiem);
		if (time) commit(time);
	});

	if (!initial.timePart) {
		const defaultSlot = slots[activeTimeIndex ?? getNextQuarterHourSlotIndex()];
		currentMeridiem = resolveMeridiem(defaultSlot.hour24);
		timeBuffer = '____';
	}

	syncTimeInputValue();
	refreshTimeMatches();
	window.requestAnimationFrame(() => {
		focusFloatingInput(timeInput);
		setTimeCaret(0);
	});

	return close;
}
