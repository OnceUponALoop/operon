import {
	convertTasksEmojiLineToOperon,
	type TasksEmojiToOperonOptions,
	type TasksEmojiToOperonResult,
} from './tasks-emoji-to-operon';
import { serializeDependencyIdList, validateDependencyEdgeSet } from './dependency-graph';
import { isValidOperonId } from './id-generator';

/** Callers allocate unique IDs and exclude document-level protected blocks before planning. */
export interface TasksEmojiConversionInput {
	sourceKey: string;
	line: string;
	operonId: string;
}

export interface TasksEmojiConversionDiagnostic {
	code: 'invalid-id' | 'duplicate-id' | 'invalid-dependency' | 'unresolved-dependency' | 'self' | 'cycle';
	raw: string;
	message: string;
}

export interface TasksEmojiConversionItem {
	sourceKey: string;
	operonId: string;
	conversion: TasksEmojiToOperonResult;
	diagnostics: TasksEmojiConversionDiagnostic[];
}

export interface TasksEmojiBatchConversionResult {
	items: TasksEmojiConversionItem[];
	idMappings: Array<{ tasksId: string; operonId: string }>;
}

type ConvertedItem = TasksEmojiConversionItem & {
	conversion: Extract<TasksEmojiToOperonResult, { kind: 'converted' }>;
};

function isConverted(item: TasksEmojiConversionItem): item is ConvertedItem {
	return item.conversion.kind === 'converted';
}

function report(item: ConvertedItem, diagnostic: TasksEmojiConversionDiagnostic): void {
	item.diagnostics.push(diagnostic);
	item.conversion.leftovers.push(`${diagnostic.raw} (${diagnostic.message})`);
}

/** Pure, two-pass plan: resolves only the supplied conversion set; never reads or writes a vault. */
export function planTasksEmojiBatchConversion(
	inputs: readonly TasksEmojiConversionInput[],
	options: TasksEmojiToOperonOptions = {},
): TasksEmojiBatchConversionResult {
	const sourceKeys = new Set<string>();
	const operonIds = new Set<string>();
	for (const input of inputs) {
		if (!input.sourceKey.trim() || sourceKeys.has(input.sourceKey)) {
			throw new Error('Tasks conversion requires unique, nonempty source keys.');
		}
		if (!isValidOperonId(input.operonId) || operonIds.has(input.operonId)) {
			throw new Error('Tasks conversion requires unique, preallocated Operon IDs.');
		}
		sourceKeys.add(input.sourceKey);
		operonIds.add(input.operonId);
	}
	const items: TasksEmojiConversionItem[] = inputs.map(input => ({
		sourceKey: input.sourceKey,
		operonId: input.operonId,
		conversion: convertTasksEmojiLineToOperon(input.line, { ...options, legacyCustomCheckboxFallback: false }),
		diagnostics: [],
	}));
	const converted = items.filter(isConverted);
	const owners = new Map<string, ConvertedItem[]>();
	for (const item of converted) {
		for (const fragment of item.conversion.dependencyMetadata ?? []) {
			if (fragment.kind !== 'id' || !fragment.ids) continue;
			const id = fragment.ids[0];
			const list = owners.get(id) ?? [];
			list.push(item);
			owners.set(id, list);
		}
	}
	const idMap = new Map<string, ConvertedItem>();
	for (const item of converted) {
		const metadata = item.conversion.dependencyMetadata ?? [];
		// Standalone callers preserve the originals. Batch callers replace them with diagnostics.
		for (const fragment of metadata) {
			const index = item.conversion.leftovers.indexOf(fragment.raw);
			if (index !== -1) item.conversion.leftovers.splice(index, 1);
		}
		const ids = metadata.filter(fragment => fragment.kind === 'id');
		for (const fragment of ids) {
			if (!fragment.ids) {
				report(item, { code: 'invalid-id', raw: fragment.raw, message: 'invalid Tasks ID' });
			} else if (ids.length !== 1 || owners.get(fragment.ids[0])?.length !== 1) {
				report(item, { code: 'duplicate-id', raw: fragment.raw, message: 'ambiguous or repeated Tasks ID' });
			} else {
				idMap.set(fragment.ids[0], item);
			}
		}
	}
	const edges: Array<{ blocker: ConvertedItem; dependent: ConvertedItem; raw: string }> = [];
	for (const item of converted) {
		for (const fragment of item.conversion.dependencyMetadata ?? []) {
			if (fragment.kind !== 'dependsOn') continue;
			if (!fragment.ids) {
				report(item, { code: 'invalid-dependency', raw: fragment.raw, message: 'invalid Tasks dependency expression' });
				continue;
			}
			for (const id of fragment.ids) {
				const blocker = idMap.get(id);
				if (!blocker) {
					report(item, {
						code: owners.has(id) ? 'duplicate-id' : 'unresolved-dependency',
						raw: fragment.raw,
						message: `${id}: ${owners.has(id) ? 'ambiguous Tasks ID' : 'ID is not available in this conversion set'}`,
					});
					continue;
				}
				edges.push({ blocker, dependent: item, raw: fragment.raw });
			}
		}
	}
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		const targets = outgoing.get(edge.blocker.operonId) ?? [];
		targets.push(edge.dependent.operonId);
		outgoing.set(edge.blocker.operonId, targets);
	}
	const projected = converted.map(item => ({
		operonId: item.operonId,
		fieldValues: { blocking: serializeDependencyIdList(outgoing.get(item.operonId) ?? []) },
	}));
	// Validate the complete projection before removing edges, so no arbitrary cycle break occurs.
	const rejections = validateDependencyEdgeSet(edges.map(edge => ({
		fromId: edge.blocker.operonId, toId: edge.dependent.operonId,
	})), projected);
	const rejected = new Map(rejections.map(edge => [`${edge.fromId}:${edge.toId}`, edge.reason]));
	const blocking = new Map<string, string[]>();
	const blockedBy = new Map<string, string[]>();
	for (const edge of edges) {
		const reason = rejected.get(`${edge.blocker.operonId}:${edge.dependent.operonId}`);
		if (reason) {
			report(edge.dependent, {
				code: reason, raw: edge.raw,
				message: `${edge.blocker.operonId}: ${reason === 'self' ? 'self dependency is not supported' : 'circular dependency is not supported'}`,
			});
			continue;
		}
		const targets = blocking.get(edge.blocker.operonId) ?? [];
		targets.push(edge.dependent.operonId);
		blocking.set(edge.blocker.operonId, targets);
		const sources = blockedBy.get(edge.dependent.operonId) ?? [];
		sources.push(edge.blocker.operonId);
		blockedBy.set(edge.dependent.operonId, sources);
	}
	for (const item of converted) {
		const nextBlocking = serializeDependencyIdList((blocking.get(item.operonId) ?? []).sort());
		const nextBlockedBy = serializeDependencyIdList((blockedBy.get(item.operonId) ?? []).sort());
		if (nextBlocking) item.conversion.mappedFields['blocking'] = nextBlocking;
		if (nextBlockedBy) item.conversion.mappedFields['blockedBy'] = nextBlockedBy;
		item.conversion.leftovers = [...new Set(item.conversion.leftovers)];
	}
	return {
		items,
		idMappings: [...idMap].map(([tasksId, item]) => ({ tasksId, operonId: item.operonId }))
			.sort((left, right) => left.tasksId.localeCompare(right.tasksId)),
	};
}
