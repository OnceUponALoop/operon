import { generateRepeatSeriesId } from './id-generator';
import { parseRepeatRule } from './repeat-rule';

export function normalizeRepeatIdentityPayload(
	taskFieldValues: Record<string, string>,
	payload: Record<string, string>,
	getAllSeriesIds: () => Set<string>,
 deferAllocation = false,
): void {
	const merged = {
		...taskFieldValues,
		...payload,
	};
	const repeatValue = (merged['repeat'] ?? '').trim();
	const rule = parseRepeatRule(repeatValue);
	if (rule) {
		const effectiveSeriesId = (merged['repeatSeriesId'] ?? '').trim();
		if (!effectiveSeriesId && !deferAllocation) {
			payload['repeatSeriesId'] = generateRepeatSeriesId(getAllSeriesIds());
		}
		return;
	}

	const hadSeriesId = ('repeatSeriesId' in payload) || !!(taskFieldValues['repeatSeriesId'] ?? '').trim();
	if (hadSeriesId) {
		payload['repeatSeriesId'] = '';
	}
	const hadOccurrenceDate = ('repeatOccurrenceDate' in payload) || !!(taskFieldValues['repeatOccurrenceDate'] ?? '').trim();
	if (hadOccurrenceDate) {
		payload['repeatOccurrenceDate'] = '';
	}
	if ('repeat' in payload && !repeatValue) {
		payload['datetimeRepeatEnd'] = '';
	}
}
