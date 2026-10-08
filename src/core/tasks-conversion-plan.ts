import type { OperonSettings } from '../types/settings';
import type { OperonField, ParsedTask } from '../types/fields';
import { CANONICAL_KEY_MAP } from '../types/keys';
import { localNow } from './local-time';
import { generateUniqueOperonId, generateRepeatSeriesId } from './id-generator';
import { isOperonExcludedPath } from './operon-path-exclusions';
import { parsePlainMarkdownCheckboxLine, parseOperonTaskLineCandidate } from './plain-checkbox-lines';
import { parseTaskLine } from './parser';
import { serializeTask } from './serializer';
import { resolveSubtaskInitialFieldsFromParentValues } from './subtask-inheritance';
import { convertTasksEmojiLineToOperon } from './tasks-emoji-to-operon';
import { planTasksEmojiBatchConversion } from './tasks-emoji-batch';
import { applyTasksEmojiConversionToParsedTask } from './tasks-emoji-application';
import { isTasksConversionPath, tasksConversionProtectedLines } from './tasks-conversion-scope';

export type TasksConversionSettings = Pick<OperonSettings, 'priorities' | 'pipelines' | 'defaultPipelineName'
	| 'defaultPriority' | 'keyMappings' | 'excludedFolders' | 'fileTaskTemplateFolder'>;
export interface TasksConversionScope { files: string[]; folders: string[]; includeSubfolders: boolean }
export interface TasksConversionSource { path: string; content?: string; error?: string }
export interface TasksConversionRow {
	key: string; path: string; lineNumber: number; before: string; input: string;
	status: 'eligible' | 'protected' | 'already_operon' | 'hybrid_unsupported' | 'not_tasks_emoji';
	operonId?: string; repeatSeriesId?: string;
}
export interface TasksConversionScan {
	scope: TasksConversionScope; settings: TasksConversionSettings; timestamp: string;
	files: TasksConversionSource[]; rows: TasksConversionRow[];
}
export interface TasksConversionFileChange { path: string; before: string; after: string }
export interface TasksConversionPreview {
	scan: TasksConversionScan; selectedKeys: string[];
	rows: Array<TasksConversionRow & { selected: boolean; after?: string; warnings: string[]; error?: string }>;
	changes: TasksConversionFileChange[]; operonIds: string[]; repeatSeriesIds: string[];
	errors: string[];
}
export interface TasksConversionFactories {
	now?: () => string; operonId?: (used: Set<string>) => string; repeatSeriesId?: (used: Set<string>) => string;
}

export function serializeTasksConversionSettings(settings: TasksConversionSettings): string {
	return JSON.stringify({ priorities: settings.priorities, pipelines: settings.pipelines,
		defaultPipelineName: settings.defaultPipelineName, defaultPriority: settings.defaultPriority,
		keyMappings: settings.keyMappings, excludedFolders: settings.excludedFolders,
		fileTaskTemplateFolder: settings.fileTaskTemplateFolder });
}

export function tasksConversionSettingsSnapshot(settings: TasksConversionSettings): TasksConversionSettings {
	return JSON.parse(serializeTasksConversionSettings(settings)) as TasksConversionSettings;
}

export function resolveTasksConversionPaths(scope: TasksConversionScope, inventory: readonly string[]): string[] {
	if (typeof scope.includeSubfolders !== 'boolean' || scope.files.some(path => !isTasksConversionPath(path))
		|| scope.folders.some(path => !isTasksConversionPath(path, true))) throw new Error('Invalid Tasks conversion scope');
	const paths = new Set(scope.files);
	for (const path of inventory) {
		if (!isTasksConversionPath(path)) continue;
		if (scope.folders.some(folder => {
			const prefix = folder === '/' ? '' : `${folder}/`;
			if (!path.startsWith(prefix)) return false;
			return scope.includeSubfolders || !path.slice(prefix.length).includes('/');
		})) paths.add(path);
	}
	return [...paths].sort();
}

export function scanTasksConversionSources(
	scope: TasksConversionScope, sources: readonly TasksConversionSource[], settings: TasksConversionSettings,
	existingIds: ReadonlySet<string>, existingSeriesIds: ReadonlySet<string>, factories: TasksConversionFactories = {},
): TasksConversionScan {
	const used = new Set(existingIds), series = new Set(existingSeriesIds);
	const files: TasksConversionSource[] = [], rows: TasksConversionRow[] = [];
	for (const source of sources) {
		if (isOperonExcludedPath(source.path, settings)) { files.push({ path: source.path, error: 'excluded' }); continue; }
		files.push({ ...source });
		if (source.content === undefined || source.error) continue;
		const protectedLines = tasksConversionProtectedLines(source.content);
		for (const [lineNumber, raw] of source.content.split('\n').entries()) {
			const before = raw.replace(/\r$/u, '');
			const checkbox = parsePlainMarkdownCheckboxLine(before);
			if (!checkbox) continue;
			const input = `${checkbox.indent}- [${checkbox.marker}]${checkbox.postMarkerSpacing}${checkbox.text}`;
			const converted = convertTasksEmojiLineToOperon(input, { priorities: settings.priorities });
			const existing = parseOperonTaskLineCandidate(input, lineNumber, source.path, settings.keyMappings);
			const status = protectedLines.has(lineNumber) ? 'protected' : existing
				? converted.kind === 'converted' || converted.kind === 'hybrid_unsupported' ? 'hybrid_unsupported' : 'already_operon'
				: converted.kind === 'converted' ? 'eligible' : converted.kind;
			const row: TasksConversionRow = { key: `${source.path}:${lineNumber}`, path: source.path, lineNumber, before, input, status };
			if (status === 'eligible') {
				const id = (factories.operonId ?? generateUniqueOperonId)(used);
				if (used.has(id) || !/^[a-z0-9]{7}$/u.test(id)) throw new Error('Invalid or duplicate allocated Operon ID');
				used.add(id); row.operonId = id;
				if (converted.kind === 'converted' && converted.mappedFields.repeat) {
					const repeatId = (factories.repeatSeriesId ?? generateRepeatSeriesId)(series);
					if (series.has(repeatId) || !/^rs[a-z0-9]{5}$/u.test(repeatId)) throw new Error('Invalid or duplicate repeat series ID');
					series.add(repeatId); row.repeatSeriesId = repeatId;
				}
			}
			rows.push(row);
		}
	}
	return { scope: structuredClone(scope), settings: tasksConversionSettingsSnapshot(settings),
		timestamp: (factories.now ?? localNow)(), files, rows };
}

function setField(task: ParsedTask, key: string, value: string): void {
	if (!value) return;
	const field: OperonField = { key, sourceKey: key, value, rawValue: value,
		type: CANONICAL_KEY_MAP.get(key)?.type ?? 'text', isCanonical: CANONICAL_KEY_MAP.has(key),
		containerRange: { from: 0, to: 0 }, valueRange: { from: 0, to: 0 } };
	task.fields.push(field);
	if (key === 'operonId') task.operonId = value;
}

export function previewTasksConversion(scan: TasksConversionScan, selection?: readonly string[]): TasksConversionPreview {
	const eligible = scan.rows.filter(row => row.status === 'eligible');
	const eligibleKeys = new Set(eligible.map(row => row.key));
	const selected = new Set(selection ?? eligible.map(row => row.key));
	if ([...selected].some(key => !eligibleKeys.has(key))) throw new Error('Selection contains an ineligible task');
	const batch = planTasksEmojiBatchConversion(eligible.filter(row => selected.has(row.key)).map(row => ({
		sourceKey: row.key, line: row.input, operonId: row.operonId!,
	})), { priorities: scan.settings.priorities });
	const byKey = new Map(batch.items.map(item => [item.sourceKey, item]));
	const patches = new Map<string, Map<number, string>>();
	const errors: string[] = [], operonIds: string[] = [], repeatSeriesIds: string[] = [];
	const defaults = Object.entries(resolveSubtaskInitialFieldsFromParentValues(null, null, scan.settings as OperonSettings));
	const rows: TasksConversionPreview['rows'] = scan.rows.map(row => {
		const result: TasksConversionPreview['rows'][number] = { ...row, selected: selected.has(row.key), warnings: [] };
		if (!result.selected) return result;
		const conversion = byKey.get(row.key)?.conversion;
		if (conversion?.kind !== 'converted') { result.error = 'Task is no longer convertible'; errors.push(row.key); return result; }
		result.warnings = [...conversion.leftovers];
		const indent = /^\s*/u.exec(row.before)?.[0] ?? '';
		const checkbox = conversion.checkbox === 'done' ? 'x' : conversion.checkbox === 'cancelled' ? '-' : ' ';
		const task = parseTaskLine(`${indent}- [${checkbox}] ${conversion.description}`, row.lineNumber, row.path, scan.settings.keyMappings);
		if (!task) throw new Error('Converted Tasks description could not be parsed');
		setField(task, 'operonId', row.operonId!);
		setField(task, 'datetimeCreated', scan.timestamp);
		for (const [key, value] of defaults) if (typeof value === 'string') setField(task, key, value);
		const previousFieldValues = Object.fromEntries(task.fields.map(field => [field.key, field.value]));
		const applied = applyTasksEmojiConversionToParsedTask({ task, tags: conversion.tags,
			mappedFields: conversion.mappedFields, leftovers: conversion.leftovers, previousFieldValues,
			pipelines: scan.settings.pipelines, defaultPipelineName: scan.settings.defaultPipelineName,
			defaultPriority: scan.settings.defaultPriority, repeatSeriesIdFactory: row.repeatSeriesId ? () => row.repeatSeriesId! : undefined });
		if (!applied.ok) { result.error = applied.errorMessage ?? 'Workflow resolution failed'; errors.push(row.key); return result; }
		setField(task, 'datetimeModified', scan.timestamp);
		result.after = serializeTask(task, scan.settings.keyMappings);
		const roundTrip = parseTaskLine(result.after, row.lineNumber, row.path, scan.settings.keyMappings);
		if (roundTrip?.operonId !== row.operonId || result.after.includes('\n')) throw new Error('Invalid Tasks conversion serialization');
		const filePatches = patches.get(row.path) ?? new Map<number, string>();
		filePatches.set(row.lineNumber, result.after); patches.set(row.path, filePatches);
		operonIds.push(row.operonId!); if (row.repeatSeriesId) repeatSeriesIds.push(row.repeatSeriesId);
		return result;
	});
	const changes = scan.files.flatMap(file => {
		const replacements = patches.get(file.path);
		if (!replacements || file.content === undefined) return [];
		const lines = file.content.split('\n');
		for (const [number, after] of replacements) lines[number] = after + (lines[number].endsWith('\r') ? '\r' : '');
		return [{ path: file.path, before: file.content, after: lines.join('\n') }];
	});
	return { scan, selectedKeys: [...selected].sort(), rows, changes, operonIds, repeatSeriesIds, errors };
}

/** A checksum proves intact bytes; this also proves the record describes only admitted task edits. */
export function tasksConversionSnapshotsConsistent(record: {
	changes: TasksConversionFileChange[]; operonIds: string[]; repeatSeriesIds: string[]; keyMappings: OperonSettings['keyMappings'];
}): boolean {
	const ids: string[] = [], series: string[] = [];
	try {
		for (const change of record.changes) {
			const before = change.before.split('\n'), after = change.after.split('\n');
			if (before.length !== after.length) return false;
			const protectedLines = tasksConversionProtectedLines(change.before);
			for (let number = 0; number < before.length; number++) {
				if (before[number] === after[number]) continue;
				if (protectedLines.has(number) || before[number].endsWith('\r') !== after[number].endsWith('\r')) return false;
				const checkbox = parsePlainMarkdownCheckboxLine(before[number].replace(/\r$/u, ''));
				if (!checkbox) return false;
				const input = `${checkbox.indent}- [${checkbox.marker}] ${checkbox.text}`;
				if (parseOperonTaskLineCandidate(input, number, change.path, record.keyMappings)
					|| convertTasksEmojiLineToOperon(input).kind !== 'converted') return false;
				const task = parseTaskLine(after[number].replace(/\r$/u, ''), number, change.path, record.keyMappings);
				const taskIds = task?.fields.filter(field => field.key === 'operonId').map(field => field.value) ?? [];
				const taskSeries = task?.fields.filter(field => field.key === 'repeatSeriesId').map(field => field.value) ?? [];
				if (!task || taskIds.length !== 1 || taskSeries.length > 1 || task.fields.some(field => field.key === 'parentTask')) return false;
				ids.push(...taskIds); series.push(...taskSeries);
			}
		}
		const same = (actual: string[], expected: string[]) => JSON.stringify(actual.sort()) === JSON.stringify([...expected].sort());
		return same(ids, record.operonIds) && same(series, record.repeatSeriesIds);
	} catch { return false; }
}
