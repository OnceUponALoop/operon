import { requestUrl } from 'obsidian';
import ICAL from 'ical.js';
import { toLocalDate, toLocalDatetime } from '../core/local-time';
import {
	ExternalCalendarCachedEvent,
	ExternalCalendarSourceCache,
} from '../storage/external-calendar-cache';

export interface ExternalCalendarFetchResult {
	status: 'success' | 'notModified';
	etag: string | null;
	lastModified: string | null;
	body: string | null;
}

export interface ExternalCalendarParseOptions {
	sourceId: string;
	url: string;
	body: string;
	rangeStart: string;
	rangeEnd: string;
	requireCalendar?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_OCCURRENCES_PER_EVENT = 5000;
const MAX_OCCURRENCE_SCANS_PER_EVENT = 100000;
type IcalComponentInput = ConstructorParameters<typeof ICAL.Component>[0];
type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;

function isIcalComponentInput(value: unknown): value is IcalComponentInput {
	return typeof value === 'string' || Array.isArray(value);
}

export function normalizeExternalCalendarUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return '';
	if (trimmed.startsWith('webcal://')) {
		return `https://${trimmed.slice('webcal://'.length)}`;
	}
	return trimmed;
}

export async function fetchExternalCalendarIcs(
	url: string,
	cached: Pick<ExternalCalendarSourceCache, 'etag' | 'lastModified'> | null,
): Promise<ExternalCalendarFetchResult> {
	const headers: Record<string, string> = {};
	if (cached?.etag) headers['If-None-Match'] = cached.etag;
	if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
	const response = await requestUrl({
		url: normalizeExternalCalendarUrl(url),
		headers,
		throw: false,
	});
	const etag = response.headers['etag']?.trim() || null;
	const lastModified = response.headers['last-modified']?.trim() || null;
	if (response.status === 304) {
		return {
			status: 'notModified',
			etag,
			lastModified,
			body: null,
		};
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`HTTP ${response.status}`);
	}
	return {
		status: 'success',
		etag,
		lastModified,
		body: response.text,
	};
}

/**
 * Outlook can end a DATE series with a UTC DATE-TIME representing its own
 * local midnight. Repair only that proven yearly boundary, in memory, before
 * the normal iterator applies exclusions, additions and exceptions.
 */
function normalizeOutlookAllDayUntil(component: InstanceType<typeof ICAL.Component>): boolean {
	const start = component.getFirstPropertyValue('dtstart');
	const rules = component.getAllProperties('rrule');
	if (!(start instanceof ICAL.Time) || !start.isDate || rules.length !== 1) return false;
	const rule = rules[0].getFirstValue();
	if (!(rule instanceof ICAL.Recur) || rule.freq !== 'YEARLY' || rule.interval !== 1
		|| rule.count !== null || !rule.until || rule.until.isDate
		|| rule.until.zone !== ICAL.Timezone.utcTimezone || start.compare(rule.until) <= 0) return false;
	if (Object.keys(rule.parts).some(key => key !== 'BYMONTH' && key !== 'BYMONTHDAY')) return false;
	if (rule.parts.BYMONTH && (rule.parts.BYMONTH.length !== 1 || rule.parts.BYMONTH[0] !== start.month)) return false;
	if (rule.parts.BYMONTHDAY && (rule.parts.BYMONTHDAY.length !== 1 || rule.parts.BYMONTHDAY[0] !== start.day)) return false;
	const calendar = component.parent;
	if (!calendar || calendar.name !== 'vcalendar') return false;
	const zoneProperties = calendar.getAllProperties('x-wr-timezone');
	if (zoneProperties.length !== 1) return false;
	const zoneName = zoneProperties[0].getFirstValue();
	if (typeof zoneName !== 'string' || !zoneName.trim()) return false;
	const tzid = zoneName.trim();
	try {
		const zones = calendar.getAllSubcomponents('vtimezone')
			.filter(zone => zone.getFirstPropertyValue('tzid') === tzid);
		if (zones.length > 1) return false;
		let parts: number[];
		if (zones.length === 1) {
			// Do not fall back to IANA when an explicit embedded definition is broken.
			const observances = zones[0].getAllSubcomponents()
				.filter(part => part.name === 'standard' || part.name === 'daylight');
			if (!observances.length || observances.some(part => {
				const onset = part.getFirstPropertyValue('dtstart');
				return !(onset instanceof ICAL.Time) || onset.isDate
					|| !(part.getFirstPropertyValue('tzoffsetfrom') instanceof ICAL.UtcOffset)
					|| !(part.getFirstPropertyValue('tzoffsetto') instanceof ICAL.UtcOffset);
			})) return false;
			const zone = calendar.getTimeZoneByID(tzid);
			if (!zone) return false;
			const local = rule.until.convertToZone(zone);
			parts = [local.year, local.month, local.day, local.hour, local.minute, local.second];
		} else {
			// Numeric offsets accepted by newer Intl engines are not IANA names.
			if (/^[+-]/u.test(tzid)) return false;
			const formatted = new Intl.DateTimeFormat('en-GB', {
				timeZone: tzid, calendar: 'gregory', numberingSystem: 'latn',
				year: 'numeric', month: '2-digit', day: '2-digit',
				hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
			}).formatToParts(new Date(rule.until.toUnixTime() * 1000));
			parts = ['year', 'month', 'day', 'hour', 'minute', 'second']
				.map(type => Number(formatted.find(part => part.type === type)?.value));
		}
		if (!parts.every((value, index) => value === [start.year, start.month, start.day, 0, 0, 0][index])) return false;
		const normalized = rule.clone();
		normalized.until = start.clone();
		rules[0].setValue(normalized);
		return true;
	} catch {
		// Unknown/invalid source timezones keep the existing recurrence behavior.
		return false;
	}
}

export function parseExternalCalendarIcsEvents(
	options: ExternalCalendarParseOptions,
): ExternalCalendarCachedEvent[] {
	const jcal: unknown = ICAL.parse(options.body);
	if (!isIcalComponentInput(jcal)) {
		if (options.requireCalendar) throw new Error('Expected a VCALENDAR document');
		return [];
	}
	const root = new ICAL.Component(jcal);
	if (options.requireCalendar && root.name !== 'vcalendar') {
		throw new Error('Expected a VCALENDAR document');
	}
	const vevents = root.getAllSubcomponents('vevent');
	const masters = vevents.filter(component => {
		const event = new ICAL.Event(component);
		return !event.isRecurrenceException();
	});
	const rangeStart = parseDateKey(options.rangeStart);
	const rangeEnd = parseDateKey(options.rangeEnd);
	if (!rangeStart || !rangeEnd) return [];
	const rangeEndExclusive = new Date(rangeEnd.getTime());
	rangeEndExclusive.setDate(rangeEndExclusive.getDate() + 1);
	const items: ExternalCalendarCachedEvent[] = [];

	for (const component of masters) {
		const normalizedOutlookRule = normalizeOutlookAllDayUntil(component);
		const event = new ICAL.Event(component);
		if (event.isRecurring()) {
			const iterator = event.iterator();
			const hasExceptions = Object.keys(event.exceptions ?? {}).length > 0;
			const masterDurationMs = resolveMasterEventDurationMs(event);
			let scannedCount = 0;
			let inRangeCount = 0;
			let previousNormalizedOccurrence: string | null = null;
			// The in-range cap must not be consumed by occurrences before the
			// window, otherwise long-lived frequent series (for example a daily
			// event started years ago) exhaust it before reaching the window and
			// visible occurrences silently disappear. Iteration still starts at
			// the series DTSTART because fast-forwarding the iterator breaks
			// COUNT rules and interval alignment; pre-window occurrences are
			// skipped cheaply instead.
			while (scannedCount < MAX_OCCURRENCE_SCANS_PER_EVENT && inRangeCount < MAX_OCCURRENCES_PER_EVENT) {
				const next = iterator.next();
				if (!next) break;
				scannedCount += 1;
				if (normalizedOutlookRule) {
					// The repaired DTSTART may already be present in RDATE. Keep the
					// recurrence identity once, without changing valid series behavior.
					const occurrenceKey = next.toString();
					if (occurrenceKey === previousNormalizedOccurrence) continue;
					previousNormalizedOccurrence = occurrenceKey;
				}
				const nextJs = next.toJSDate();
				if (nextJs.getTime() >= rangeEndExclusive.getTime()) {
					break;
				}
				// Exceptions can move an occurrence into the window, so the
				// cheap pre-window skip is only safe when the series has none.
				if (!hasExceptions && nextJs.getTime() + masterDurationMs <= rangeStart.getTime()) {
					continue;
				}
				const details = event.getOccurrenceDetails(next);
				if (!details?.startDate || !details?.endDate) continue;
				const startJs = details.startDate.toJSDate();
				const endJs = details.endDate.toJSDate();
				if (!intersectsRange(startJs, endJs, rangeStart, rangeEndExclusive)) {
					continue;
				}
				const normalized = normalizeOccurrence({
					sourceId: options.sourceId,
					event,
					recurrenceId: details.recurrenceId,
					startDate: details.startDate,
					endDate: details.endDate,
				});
				if (normalized) {
					items.push(normalized);
					inRangeCount += 1;
				}
			}
			continue;
		}

		const normalized = normalizeOccurrence({
			sourceId: options.sourceId,
			event,
			recurrenceId: event.recurrenceId || null,
			startDate: event.startDate,
			endDate: event.endDate,
		});
		if (!normalized) continue;
		const eventStart = normalized.isAllDay
			? parseDateKey(normalized.startDate)
			: parseLocalDateTime(normalized.startDateTime);
		const eventEnd = normalized.isAllDay
			? addDays(parseDateKey(normalized.endDate), 1)
			: parseLocalDateTime(normalized.endDateTime);
		if (!eventStart || !eventEnd || !intersectsRange(eventStart, eventEnd, rangeStart, rangeEndExclusive)) {
			continue;
		}
		items.push(normalized);
	}

	items.sort((left, right) => {
		if (left.startDate !== right.startDate) return left.startDate.localeCompare(right.startDate);
		const leftStart = left.startDateTime ?? '';
		const rightStart = right.startDateTime ?? '';
		if (leftStart !== rightStart) return leftStart.localeCompare(rightStart);
		return left.id.localeCompare(right.id);
	});
	return items;
}

function normalizeOccurrence(options: {
	sourceId: string;
	event: IcalEvent;
	recurrenceId: IcalTime | null;
	startDate: IcalTime;
	endDate: IcalTime;
}): ExternalCalendarCachedEvent | null {
	const title = (options.event.summary || '').trim() || '(untitled event)';
	const uid = (options.event.uid || '').trim();
	if (!uid) return null;
	const isAllDay = options.startDate.isDate === true;
	const recurrenceId = options.recurrenceId
		? normalizeRecurrenceId(options.recurrenceId)
		: null;

	if (isAllDay) {
		const start = options.startDate.toJSDate();
		const rawEnd = options.endDate.toJSDate();
		const inclusiveEnd = new Date(rawEnd.getTime());
		inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
		if (inclusiveEnd.getTime() < start.getTime()) {
			inclusiveEnd.setTime(start.getTime());
		}
		const startDate = toLocalDate(start);
		const endDate = toLocalDate(inclusiveEnd);
		return {
			id: buildExternalEventId(options.sourceId, uid, recurrenceId ?? startDate),
			sourceId: options.sourceId,
			uid,
			recurrenceId,
			title,
			isAllDay: true,
			startDate,
			endDate,
			startDateTime: null,
			endDateTime: null,
		};
	}

	const start = options.startDate.toJSDate();
	const end = options.endDate.toJSDate();
	if (end.getTime() <= start.getTime()) return null;
	const startDateTime = toLocalDatetime(start);
	const endDateTime = toLocalDatetime(end);
	return {
		id: buildExternalEventId(options.sourceId, uid, recurrenceId ?? startDateTime),
		sourceId: options.sourceId,
		uid,
		recurrenceId,
		title,
		isAllDay: false,
		startDate: startDateTime.slice(0, 10),
		endDate: endDateTime.slice(0, 10),
		startDateTime,
		endDateTime,
	};
}

function resolveMasterEventDurationMs(event: IcalEvent): number {
	try {
		const start = event.startDate?.toJSDate();
		const end = event.endDate?.toJSDate();
		if (!start || !end) return 0;
		return Math.max(0, end.getTime() - start.getTime());
	} catch {
		return 0;
	}
}

function normalizeRecurrenceId(value: IcalTime | null | undefined): string | null {
	if (!value) return null;
	const jsDate = value.toJSDate();
	return value.isDate === true ? toLocalDate(jsDate) : toLocalDatetime(jsDate);
}

function buildExternalEventId(sourceId: string, uid: string, instanceId: string): string {
	return `external:${sourceId}:${uid}:${instanceId}`;
}

function intersectsRange(
	start: Date,
	end: Date,
	rangeStart: Date,
	rangeEndExclusive: Date,
): boolean {
	return start.getTime() < rangeEndExclusive.getTime() && end.getTime() > rangeStart.getTime();
}

function parseDateKey(dateKey: string | null | undefined): Date | null {
	const trimmed = (dateKey ?? '').trim();
	if (!DATE_RE.test(trimmed)) return null;
	const [year, month, day] = trimmed.split('-').map(Number);
	return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function parseLocalDateTime(value: string | null | undefined): Date | null {
	const trimmed = (value ?? '').trim();
	if (!trimmed) return null;
	const [datePart, timePart] = trimmed.split('T');
	if (!DATE_RE.test(datePart || '') || !timePart) return null;
	const [year, month, day] = datePart.split('-').map(Number);
	const [hours, minutes, seconds] = timePart.split(':').map(Number);
	return new Date(year, month - 1, day, hours || 0, minutes || 0, seconds || 0, 0);
}

function addDays(date: Date | null, deltaDays: number): Date | null {
	if (!date) return null;
	const next = new Date(date.getTime());
	next.setDate(next.getDate() + deltaDays);
	return next;
}
