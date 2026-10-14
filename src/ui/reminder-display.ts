import type { App } from 'obsidian';
import { t } from '../core/i18n';
import { getAppLocale } from '../core/obsidian-app';
import { formatUiDate } from '../core/ui-date-format';
import { toLocalDate } from '../core/local-time';
import {
	parseAbsoluteReminder,
	resolveReminderRule,
	type ParsedReminderRule,
} from '../core/reminder-rules';
import { getVisiblePropertyName } from '../core/yaml-fields';
import type { OperonSettings } from '../types/settings';
import type { ReminderPickerFieldKey } from '../core/reminder-list-mutation';

export type ReminderDisplayState = 'normal' | 'past' | 'unresolved' | 'invalid';

export interface ReminderDisplayItem {
	text: string;
	state: ReminderDisplayState;
	statusText?: string;
	tooltipTitle: string;
	tooltipContent: string;
	ariaLabel: string;
}

export interface FormatReminderDisplayItemInput {
	app?: App | null;
	settings: Pick<OperonSettings, 'timeFormat' | 'keyMappings'> & Partial<Pick<OperonSettings, 'dateDisplayFormat'>>;
	fieldKey: ReminderPickerFieldKey;
	rawValue: string;
	fieldValues: Readonly<Record<string, string | undefined>>;
	nowEpochMs?: number;
}

export function formatReminderDisplayItem(input: FormatReminderDisplayItemInput): ReminderDisplayItem {
	return input.fieldKey === 'reminderDatetimes'
		? formatAbsoluteReminder(input)
		: formatRuleReminder(input);
}

function formatAbsoluteReminder(input: FormatReminderDisplayItemInput): ReminderDisplayItem {
	const parsed = parseAbsoluteReminder(input.rawValue);
	if (!parsed.ok) {
		return buildDisplayItem(input.rawValue, 'invalid', t('reminders', 'invalidReminder'), t('reminders', 'editAbsoluteReminder'));
	}

	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const state: ReminderDisplayState = parsed.value.epochMs <= nowEpochMs ? 'past' : 'normal';
	const statusText = state === 'past' ? t('reminders', 'pastReminder') : undefined;
	const date = new Date(parsed.value.epochMs);
	const time = formatReminderTime(date, input);
	const dateKey = parsed.value.localDatetime.slice(0, 10);
	const text = dateKey === toLocalDate(new Date(nowEpochMs))
		? time
		: formatResolvedReminderTooltip(parsed.value.epochMs, undefined, input);
	return buildDisplayItem(
		text,
		state,
		statusText,
		t('reminders', 'editAbsoluteReminder'),
		formatResolvedReminderTooltip(parsed.value.epochMs, statusText, input),
	);
}

function formatRuleReminder(input: FormatReminderDisplayItemInput): ReminderDisplayItem {
	const resolution = resolveReminderRule(input.rawValue, input.fieldValues);
	if (resolution.status === 'invalid-rule') {
		return buildDisplayItem(input.rawValue, 'invalid', t('reminders', 'invalidReminder'), t('reminders', 'editReminderRule'));
	}

	const rule = resolution.rule;
	const text = formatRuleText(rule, input);
	if (resolution.status === 'missing-anchor' || resolution.status === 'invalid-anchor') {
		return buildDisplayItem(text, 'unresolved', t('reminders', 'unresolvedReminder'), t('reminders', 'editReminderRule'));
	}

	const state: ReminderDisplayState = resolution.epochMs <= (input.nowEpochMs ?? Date.now()) ? 'past' : 'normal';
	return buildDisplayItem(
		text,
		state,
		state === 'past' ? t('reminders', 'pastReminder') : undefined,
		t('reminders', 'editReminderRule'),
		formatResolvedReminderTooltip(
			resolution.epochMs,
			state === 'past' ? t('reminders', 'pastReminder') : undefined,
			input,
		),
	);
}

function formatResolvedReminderTooltip(
	epochMs: number,
	statusText: string | undefined,
	input: FormatReminderDisplayItemInput,
): string {
	const date = new Date(epochMs);
	const dateText = formatUiDate(toLocalDate(date), { dateDisplayFormat: input.settings.dateDisplayFormat ?? 'YYYY-MM-DD' });
	const dateTime = `${dateText} - ${formatReminderTime(date, input)}`;
	return statusText ? `${statusText}\n${dateTime}` : dateTime;
}

function formatReminderTime(date: Date, input: FormatReminderDisplayItemInput): string {
	return new Intl.DateTimeFormat(getAppLocale(input.app), {
		hour: 'numeric',
		minute: '2-digit',
		hour12: input.settings.timeFormat === '12h',
	}).format(date);
}

function formatRuleText(rule: ParsedReminderRule, input: FormatReminderDisplayItemInput): string {
	const anchor = getVisiblePropertyName(rule.anchor, input.settings.keyMappings).trim() || rule.anchor;
	return rule.offset.canonical === '0m'
		? t('reminders', 'atAnchor', { anchor })
		: t('reminders', 'offsetBeforeAnchor', { offset: rule.offset.canonical, anchor });
}

function buildDisplayItem(
	text: string,
	state: ReminderDisplayState,
	statusText: string | undefined,
	actionLabel: string,
	tooltipContent = statusText ?? text,
): ReminderDisplayItem {
	return {
		text,
		state,
		...(statusText ? { statusText } : {}),
		tooltipTitle: t('taskEditor', 'details'),
		tooltipContent,
		ariaLabel: [actionLabel, text, tooltipContent].filter(Boolean).join('. '),
	};
}
