import { TFile, parseYaml, type App } from 'obsidian';
import type { TaskWriter } from '../core/task-writer';
import type { KeyMapping } from '../types/settings';
import type { TasksConversionSettings } from '../core/tasks-conversion-plan';
import { parseTaskLine } from '../core/parser';
import { parsePlainMarkdownCheckboxLine } from '../core/plain-checkbox-lines';
import { getManagedYamlAliases } from '../core/yaml-fields';
import { parseDependencyIdList } from '../core/dependency-graph';
import { tasksConversionProtectedLines } from '../core/tasks-conversion-scope';
import { markdownBodyStartLine } from '../core/markdown-body';
import { iterateMarkdownLinesOutsideFences } from '../core/markdown-fenced-lines';
import type { TasksConversionHost, TasksConversionIdentity, TasksConversionIdentityInventory } from './tasks-conversion-service';
import type { TaskIdRepairOpenSources } from './task-id-repair-markdown';

export function collectTasksConversionIdentities(path: string, content: string, mappings: KeyMapping[]): TasksConversionIdentity[] {
	const identities: TasksConversionIdentity[] = [];
	const add = (lineNumber: number, fields: Array<{ key: string; value: string }>) => {
		const values = (key: string) => fields.filter(field => field.key === key).flatMap(field => parseDependencyIdList(field.value));
		const operonIds = values('operonId'), repeatSeriesIds = values('repeatSeriesId');
		const references = ['parentTask', 'blocking', 'blockedBy', 'related'].flatMap(values);
		if (operonIds.length || repeatSeriesIds.length || references.length) identities.push({ path, lineNumber, operonIds, repeatSeriesIds, references });
	};
	const lines = content.split('\n');
	const body = markdownBodyStartLine(lines);
	if (body === null) throw new Error('Unclosed frontmatter prevents identity verification');
	if (body > 0) {
		const yaml: unknown = parseYaml(lines.slice(1, body - 1).join('\n'));
		if (yaml !== null && yaml !== undefined && (typeof yaml !== 'object' || Array.isArray(yaml))) throw new Error('Invalid identity frontmatter');
		const frontmatter = (yaml ?? {}) as Record<string, unknown>;
		const fields: Array<{ key: string; value: string }> = [];
		for (const key of ['operonId', 'repeatSeriesId', 'parentTask', 'blocking', 'blockedBy', 'related']) {
			for (const alias of getManagedYamlAliases(key, mappings)) {
				const value = frontmatter[alias];
				if (value === null || value === undefined) continue;
				const items = Array.isArray(value) ? value : [value];
				if (items.some(item => typeof item !== 'string' && typeof item !== 'number')) throw new Error('Unsupported identity value');
				fields.push({ key, value: items.map(String).join('; ') });
			}
		}
		add(-1, fields);
	}
	const protectedLines = tasksConversionProtectedLines(content);
	// Identity safety covers the current indexer's legacy scope as well as migration scope.
	const indexedLines = new Set([...iterateMarkdownLinesOutsideFences(content)].map(([number]) => number));
	for (const [number, line] of lines.entries()) {
		if (protectedLines.has(number) && !indexedLines.has(number)) continue;
		const checkbox = parsePlainMarkdownCheckboxLine(line.replace(/\r$/u, ''));
		if (!checkbox) continue;
		const task = parseTaskLine(`${checkbox.indent}- [${checkbox.marker}] ${checkbox.text}`, number, path, mappings);
		if (task) add(number, task.fields);
	}
	return identities;
}

/** Construction is inert. Stage 3 must supply complete workflow references and open-buffer guards. */
export function createTasksConversionHost(
	app: App, writer: Pick<TaskWriter, 'runExclusiveTaskMutation' | 'applyExactMarkdownSourceMutation' | 'waitForMarkdownSources'>,
	settings: () => TasksConversionSettings, openSources: TaskIdRepairOpenSources,
	workflowInventory: (signal?: AbortSignal) => Promise<Pick<TasksConversionIdentityInventory, 'externalReferences' | 'reservedSeriesIds' | 'isCurrent'> & { unavailablePaths?: string[] }>,
 coordinateSources: <T>(paths: readonly string[], operation: (current: () => boolean) => Promise<T>) => Promise<T>
  = (_paths, operation) => operation(() => true),
): TasksConversionHost {
	let witness: { revision: number } | null = null;
	const resolve = (path: string) => {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('Markdown source is missing');
		return file;
	};
	const read = async (path: string) => {
		const content = await app.vault.read(resolve(path));
		if (!openSources.matches(path, content)) throw new Error('Source has unsaved editor changes');
		return content;
	};
	const paths = () => app.vault.getMarkdownFiles().map(file => file.path).sort();
	const identities = async (original: KeyMapping[], signal?: AbortSignal) => {
		const check = () => { if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError'); };
		check();
		const observed = witness, revision = observed?.revision;
		const sources: TasksConversionIdentity[] = [], unavailablePaths: string[] = [];
		const contents = new Map<string, string>();
		const current = settings().keyMappings;
		const initialPaths = paths();
		for (const path of initialPaths) {
			check();
			try {
				const content = await read(path);
				contents.set(path, content);
				const candidates = [...collectTasksConversionIdentities(path, content, original), ...collectTasksConversionIdentities(path, content, current)];
				// Same source can be readable under both old and current mappings.
				const locations = new Map<number, TasksConversionIdentity>();
				for (const candidate of candidates) {
					const previous = locations.get(candidate.lineNumber);
					if (!previous) { locations.set(candidate.lineNumber, candidate); continue; }
					for (const field of ['operonIds', 'repeatSeriesIds', 'references'] as const) {
						// Preserve actual duplicate fields, without double-counting a mapping alias.
						const counts = new Map<string, number>();
						for (const id of candidate[field]) counts.set(id, (counts.get(id) ?? 0) + 1);
						for (const [id, count] of counts) {
							const existing = previous[field].filter(value => value === id).length;
							for (let extra = existing; extra < count; extra++) previous[field].push(id);
						}
					}
				}
				sources.push(...locations.values());
			} catch { unavailablePaths.push(path); }
		}
		check();
		const workflow = await workflowInventory(signal), finalPaths = paths();
		check();
		for (const path of new Set([...initialPaths, ...finalPaths])) {
			if (initialPaths.includes(path) !== finalPaths.includes(path)) unavailablePaths.push(path);
		}
		return { sources, ...workflow, unavailablePaths: [...new Set([...unavailablePaths, ...(workflow.unavailablePaths ?? [])])], isCurrent: () => observed !== null && witness === observed
			&& observed.revision === revision && workflow.isCurrent() && JSON.stringify(paths()) === JSON.stringify(initialPaths)
			&& [...contents].every(([path, content]) => openSources.matches(path, content)) };
	};
	return { settings, paths, read, identities,
		exclusive: async (sourcePaths, operation) => {
			await writer.waitForMarkdownSources(sourcePaths);
			return writer.runExclusiveTaskMutation(permit => coordinateSources(sourcePaths, async sourceCurrent => {
				const observed = { revision: 0 };
				const changed = () => { observed.revision++; };
				const refs = [app.vault.on('modify', changed), app.vault.on('create', changed), app.vault.on('delete', changed), app.vault.on('rename', changed)];
				witness = observed;
				try { return await operation({ read, identities,
				write: async (path, expected, next, allowed) => {
					const result = await writer.applyExactMarkdownSourceMutation(path, expected, next,
						() => sourceCurrent() && allowed() && openSources.matches(path, expected), permit, 'plugin');
					if (result.outcome !== 'committed') throw new Error(`Tasks conversion write: ${result.outcome}`);
					if (!openSources.synchronize(path, expected, next)) throw new Error('Editor changed during conversion write');
				},
				}); } finally { witness = null; for (const ref of refs) app.vault.offref(ref); }
			}));
		},
	};
}
