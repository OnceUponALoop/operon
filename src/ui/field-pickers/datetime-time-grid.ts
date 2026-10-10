import { OperonSettings } from '../../types/settings';

export interface QuarterHourSlot {
	index: number;
	hour24: number;
	minute: number;
	canonical: string;
	compact: string;
}

export interface TimeMatchResult {
	additionalSlots?: QuarterHourSlot[];
	activeIndex: number | null;
	visibleIndices: number[];
	exact: boolean;
}

export interface ParsedDatetimeValue {
	datePart: string;
	timePart: string;
	slotIndex: number | null;
	isOffGrid: boolean;
	meridiem: 'am' | 'pm';
	isTimeOnly: boolean;
}

type TimeFormat = Pick<OperonSettings, 'timeFormat'>['timeFormat'];

const WINDOW_SIZE = 12;
const TOTAL_SLOTS = 96;
const FULL_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIME_ONLY_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

export const QUARTER_HOUR_SLOTS: QuarterHourSlot[] = Array.from({ length: TOTAL_SLOTS }, (_, index) => {
	const totalMinutes = index * 15;
	const hour24 = Math.floor(totalMinutes / 60);
	const minute = totalMinutes % 60;
	const canonical = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
	return {
		index,
		hour24,
		minute,
		canonical,
		compact: canonical.replace(':', ''),
	};
});

export function getQuarterHourSlots(): QuarterHourSlot[] {
	return QUARTER_HOUR_SLOTS;
}

export function getNextQuarterHourSlotIndex(reference: Date = new Date()): number {
	const totalMinutes = reference.getHours() * 60 + reference.getMinutes();
	const rounded = Math.ceil(totalMinutes / 15) * 15;
	const normalized = rounded >= 24 * 60 ? rounded - 24 * 60 : rounded;
	return Math.floor(normalized / 15) % TOTAL_SLOTS;
}

export function getWrappedSlotIndex(index: number): number {
	const normalized = index % TOTAL_SLOTS;
	return normalized < 0 ? normalized + TOTAL_SLOTS : normalized;
}

export function buildVisibleTimeWindow(activeIndex: number, count = WINDOW_SIZE): number[] {
	const safeCount = Math.max(1, Math.min(TOTAL_SLOTS, count));
	const offset = Math.floor(safeCount / 2);
	return Array.from({ length: safeCount }, (_, index) => getWrappedSlotIndex(activeIndex - offset + index));
}

export function parseStoredDatetimeValue(value: string | undefined | null): ParsedDatetimeValue {
	const trimmed = value?.trim() ?? '';
	if (!trimmed) {
		return {
			datePart: '',
			timePart: '',
			slotIndex: null,
			isOffGrid: false,
			meridiem: 'am',
			isTimeOnly: false,
		};
	}

	const fullMatch = FULL_DATETIME_RE.exec(trimmed);
	if (fullMatch) {
		const [, datePart, hour, minute] = fullMatch;
		const timePart = `${hour}:${minute}`;
		const slotIndex = getSlotIndexForCanonicalTime(timePart);
		return {
			datePart,
			timePart,
			slotIndex,
			isOffGrid: slotIndex === null,
			meridiem: Number(hour) >= 12 ? 'pm' : 'am',
			isTimeOnly: false,
		};
	}

	const timeMatch = TIME_ONLY_RE.exec(trimmed);
	if (timeMatch) {
		const [, hour, minute] = timeMatch;
		const timePart = `${hour}:${minute}`;
		const slotIndex = getSlotIndexForCanonicalTime(timePart);
		return {
			datePart: '',
			timePart,
			slotIndex,
			isOffGrid: slotIndex === null,
			meridiem: Number(hour) >= 12 ? 'pm' : 'am',
			isTimeOnly: true,
		};
	}

	return {
		datePart: '',
		timePart: '',
		slotIndex: null,
		isOffGrid: false,
		meridiem: 'am',
		isTimeOnly: false,
	};
}

export function getSlotIndexForCanonicalTime(value: string | undefined | null): number | null {
	const trimmed = value?.trim() ?? '';
	const match = /^(\d{2}):(\d{2})$/.exec(trimmed);
	if (!match) return null;
	const hour24 = Number(match[1]);
	const minute = Number(match[2]);
	if (hour24 < 0 || hour24 > 23) return null;
	if (minute !== 0 && minute !== 15 && minute !== 30 && minute !== 45) return null;
	return Math.floor((hour24 * 60 + minute) / 15);
}

export function buildCanonicalDatetime(datePart: string, canonicalTime: string): string {
	if (canonicalTime === '24:00') {
		const shiftedDatePart = shiftDatePartByDays(datePart, 1);
		return shiftedDatePart ? `${shiftedDatePart}T00:00:00` : '';
	}
	return `${datePart}T${canonicalTime}:00`;
}

export function formatMaskedTimeValue(digits: string): string {
	const safeDigits = digits.replace(/\D/g, '').slice(0, 4);
	const chars = ['_', '_', ':', '_', '_'];
	if (safeDigits[0]) chars[0] = safeDigits[0];
	if (safeDigits[1]) chars[1] = safeDigits[1];
	if (safeDigits[2]) chars[3] = safeDigits[2];
	if (safeDigits[3]) chars[4] = safeDigits[3];
	return chars.join('');
}

export function getTimeDigitsFromCanonicalTime(
	value: string,
	timeFormat: TimeFormat,
	meridiem: 'am' | 'pm',
): string {
	const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) return '';
	const hour24 = Number(match[1]);
	const minute = Number(match[2]);
	if (timeFormat === '24h') {
		return `${String(hour24).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
	}
	const hour12 = toDisplayHour12(hour24, meridiem);
	return `${String(hour12).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

/** Validate typed clock digits independently of the quarter-hour suggestions. */
export function isValidTimePrefix(digits: string, timeFormat: TimeFormat, allowEndOfDay = false): boolean {
	if (!/^\d{0,4}$/.test(digits)) return false;
	const maxHour = timeFormat === '12h' ? 12 : allowEndOfDay ? 24 : 23;
	if (digits.length === 1) return Number(digits) <= Math.floor(maxHour / 10);
	if (digits.length < 2) return true;
	const hour = Number(digits.slice(0, 2));
	if (hour > maxHour || (timeFormat === '12h' && hour === 0)) return false;
	if (hour === 24) return /^0*$/.test(digits.slice(2));
	return digits.length < 3 || Number(digits[2]) <= 5;
}

export function resolveTimeInput(digits: string, timeFormat: TimeFormat, meridiem: 'am' | 'pm'): string | null {
	if (digits.length !== 4 || !isValidTimePrefix(digits, timeFormat)) return null;
	const hour = Number(digits.slice(0, 2));
	return `${String(timeFormat === '12h' ? toCanonicalHour24(hour, meridiem) : hour).padStart(2, '0')}:${digits.slice(2)}`;
}

export function matchQuarterHourSlots(options: {
	digits: string;
	anchorIndex: number;
	timeFormat: TimeFormat;
	meridiem: 'am' | 'pm';
}): TimeMatchResult {
	const digits = options.digits.replace(/\D/g, '').slice(0, 4);
	const anchorIndex = getWrappedSlotIndex(options.anchorIndex);
	if (!digits) {
		return {
			activeIndex: anchorIndex,
			visibleIndices: QUARTER_HOUR_SLOTS.map(slot => slot.index),
			exact: false,
		};
	}

	// Once the minute tens digit is entered, offer only its ten-minute range.
	if (digits.length >= 3 && isValidTimePrefix(digits, options.timeFormat)) {
		const exactTime = resolveTimeInput(digits, options.timeFormat, options.meridiem);
		const quarterIndex = exactTime ? getSlotIndexForCanonicalTime(exactTime) : null;
		if (quarterIndex !== null) return { activeIndex: quarterIndex, visibleIndices: [quarterIndex], exact: true };
		const additionalSlots = Array.from({ length: digits.length === 3 ? 10 : 1 }, (_, offset) => {
			const canonical = exactTime ?? resolveTimeInput(`${digits}${offset}`, options.timeFormat, options.meridiem)!;
			const [hour24, minute] = canonical.split(':').map(Number);
			return { index: TOTAL_SLOTS + offset, hour24, minute, canonical, compact: canonical.replace(':', '') };
		});
		return {
			additionalSlots,
			activeIndex: exactTime ? TOTAL_SLOTS : null,
			visibleIndices: additionalSlots.map(slot => slot.index),
			exact: !!exactTime,
		};
	}
	const matching = QUARTER_HOUR_SLOTS.filter(slot => getDisplayCompact(slot, options.timeFormat, options.meridiem).startsWith(digits));
	if (matching.length === 0) return { activeIndex: null, visibleIndices: [], exact: false };

	const activeIndex = matching[0].index;
	const exact = digits.length === 4 && getDisplayCompact(QUARTER_HOUR_SLOTS[activeIndex], options.timeFormat, options.meridiem) === digits;
	return {
		activeIndex,
		visibleIndices: matching.map(slot => slot.index),
		exact,
	};
}

export function getDisplayCompact(slot: QuarterHourSlot, timeFormat: TimeFormat, meridiem: 'am' | 'pm'): string {
	if (timeFormat === '24h') return slot.compact;
	if (resolveMeridiem(slot.hour24) !== meridiem) return '';
	const hour12 = toDisplayHour12(slot.hour24, meridiem);
	return `${String(hour12).padStart(2, '0')}${String(slot.minute).padStart(2, '0')}`;
}

export function resolveMeridiem(hour24: number): 'am' | 'pm' {
	return hour24 >= 12 ? 'pm' : 'am';
}

export function remapSlotIndexForMeridiem(
	slotIndex: number,
	meridiem: 'am' | 'pm',
): number {
	const slot = QUARTER_HOUR_SLOTS[getWrappedSlotIndex(slotIndex)];
	const hour12 = slot.hour24 % 12 === 0 ? 12 : slot.hour24 % 12;
	const hour24 = toCanonicalHour24(hour12, meridiem);
	return getWrappedSlotIndex(Math.floor((hour24 * 60 + slot.minute) / 15));
}

export function tryResolveSlotIndexFromDigits(
	digits: string,
	timeFormat: TimeFormat,
	meridiem: 'am' | 'pm',
): number | null {
	const match = matchQuarterHourSlots({
		digits,
		anchorIndex: 0,
		timeFormat,
		meridiem,
	});
	return match.exact ? match.activeIndex : null;
}

export function toCanonicalHour24(hour: number, meridiem: 'am' | 'pm'): number {
	const normalized = hour % 12;
	return meridiem === 'pm' ? normalized + 12 : normalized;
}

function toDisplayHour12(hour24: number, meridiem: 'am' | 'pm'): number {
	const resolved = resolveMeridiem(hour24);
	if (resolved !== meridiem) {
		const normalized = hour24 % 12 === 0 ? 12 : hour24 % 12;
		return normalized;
	}
	return hour24 % 12 === 0 ? 12 : hour24 % 12;
}

function shiftDatePartByDays(datePart: string, deltaDays: number): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart.trim());
	if (!match) return '';
	const shifted = new Date(
		Number.parseInt(match[1], 10),
		Number.parseInt(match[2], 10) - 1,
		Number.parseInt(match[3], 10) + deltaDays,
		12,
		0,
		0,
		0,
	);
	return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}


/** Move only within the currently rendered suggestions, keeping list boundaries. */
export function moveTimeSuggestion(indices: readonly number[], active: number | null, delta: number): number | null {
 if (!indices.length) return null;
 const position = active === null ? -1 : indices.indexOf(active);
 if (position < 0) return indices[delta > 0 ? 0 : indices.length - 1];
 return indices[(position + delta + indices.length) % indices.length];
}
