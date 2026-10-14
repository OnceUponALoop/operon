import {
	cloneTablePreset,
	type TablePreset,
	type TablePresetFileBinding,
	type TablePresetPackageSettings,
	type TablePresetProjectionSettings,
} from '../types/table';

export const TABLE_PRESET_MANIFEST_VERSION = 4;
export type TablePresetBootstrapAction = 'none' | 'adopt-existing' | 'seed-default';

export interface AvailableTablePresetFileAuthority {
	id: string;
	path: string;
}

export interface ReconciledTablePresetFileAuthority {
	presetIds: string[];
	fileBindings: TablePresetFileBinding[];
	tableDefaultPresetId: string | null;
	initialized: boolean;
}

export function resolveTablePresetBootstrapAction(input: {
	initialized: boolean;
	registryEntryCount: number;
	bindingCount: number;
}): TablePresetBootstrapAction {
	if (input.initialized) return 'none';
	if (input.registryEntryCount > 0 || input.bindingCount > 0) return 'adopt-existing';
	return 'seed-default';
}

export function buildTablePresetPackageManifest(
	settings: TablePresetProjectionSettings,
): TablePresetPackageSettings & { version: number } {
	return {
		version: TABLE_PRESET_MANIFEST_VERSION,
		presetIds: normalizeTablePresetOrderIds(settings.tablePresetOrderIds, settings.tablePresets),
		fileBindings: (settings.tablePresetFileBindings ?? []).map(binding => ({ ...binding })),
		initialized: settings.tablePresetFileInitialized,
		tableDefaultPresetId: settings.tableDefaultPresetId,
		tableDefaultFolder: settings.tableDefaultFolder,
		tableEmbedVisibleRows: settings.tableEmbedVisibleRows,
		tableEmbedDefaultWidthPercent: settings.tableEmbedDefaultWidthPercent,
		tableShowLineNumbers: settings.tableShowLineNumbers,
		tableShowTaskIcon: settings.tableShowTaskIcon,
		tableShowTaskDataTypeIcon: settings.tableShowTaskDataTypeIcon,
	};
}

export function pickTablePresetProjectionSettings(
	settings: TablePresetProjectionSettings,
): TablePresetProjectionSettings {
	return {
		tablePresets: settings.tablePresets.map(cloneTablePreset),
		tablePresetOrderIds: normalizeTablePresetOrderIds(settings.tablePresetOrderIds, settings.tablePresets),
		tablePresetFileBindings: (settings.tablePresetFileBindings ?? []).map(binding => ({ ...binding })),
		tablePresetFileInitialized: settings.tablePresetFileInitialized,
		tableDefaultPresetId: settings.tableDefaultPresetId,
		tableDefaultFolder: settings.tableDefaultFolder,
		tableEmbedVisibleRows: settings.tableEmbedVisibleRows,
		tableEmbedDefaultWidthPercent: settings.tableEmbedDefaultWidthPercent,
		tableShowLineNumbers: settings.tableShowLineNumbers,
		tableShowTaskIcon: settings.tableShowTaskIcon,
		tableShowTaskDataTypeIcon: settings.tableShowTaskDataTypeIcon,
	};
}

export function normalizeTablePresetOrderIds(value: unknown, tablePresets: readonly TablePreset[]): string[] {
	const ids = normalizePresetIds(value);
	const seen = new Set(ids);
	for (const preset of tablePresets) {
		const id = preset.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

export function mergeTablePresetRegistryOrder(
	currentOrder: readonly string[],
	registryIds: readonly string[],
): string[] {
	const nextOrder: string[] = [];
	const seen = new Set<string>();
	for (const id of [...currentOrder, ...registryIds]) {
		const normalized = id.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		nextOrder.push(normalized);
	}
	return nextOrder;
}

/** Preserve the chosen default through temporary file unavailability. */
export function resolveTablePresetDefaultAfterRegistrySync(
	currentDefaultId: string | null,
	orderedPresetIds: readonly string[],
	availablePresetIds: readonly string[],
): string | null {
	const available = new Set(availablePresetIds);
	if (currentDefaultId && orderedPresetIds.includes(currentDefaultId)) return currentDefaultId;
	for (const presetId of orderedPresetIds) {
		if (available.has(presetId)) return presetId;
	}
	return availablePresetIds[0] ?? null;
}

/**
 * Discover usable files without treating temporary absence as user deletion.
 * Retain known file bindings and their order/default until explicitly removed;
 * unavailable files remain unavailable in the registry, never editable snapshots.
 */
export function reconcileTablePresetFileAuthority(input: {
	currentPresetIds: readonly string[];
	currentDefaultPresetId: string | null;
	currentInitialized: boolean;
	currentFileBindings?: readonly TablePresetFileBinding[];
	availableFiles: readonly AvailableTablePresetFileAuthority[];
}): ReconciledTablePresetFileAuthority {
	const availableById = new Map<string, AvailableTablePresetFileAuthority>();
	const claimedPaths = new Set<string>();
	const boundPaths = new Map((input.currentFileBindings ?? [])
		.map(binding => [binding.path.trim().toLocaleLowerCase('en-US'), binding.id]));
	for (const candidate of [...input.availableFiles].sort(compareAvailableTableFiles)) {
		const id = candidate.id.trim();
		const path = candidate.path.trim();
		const pathKey = path.toLocaleLowerCase('en-US');
		if (!id || !path || availableById.has(id) || claimedPaths.has(pathKey)) continue;
		// A different id at a bound path is a registry conflict, not a new preset.
		if (boundPaths.has(pathKey) && boundPaths.get(pathKey) !== id) continue;
		availableById.set(id, { id, path });
		claimedPaths.add(pathKey);
	}

	// A scan cannot prove deletion: startup, sync, partial writes and read failures
	// can all hide a previously known file. Explicit deletion removes its binding.
	for (const binding of input.currentFileBindings ?? []) {
		if (!availableById.has(binding.id)) availableById.set(binding.id, { ...binding });
	}

	const presetIds: string[] = [];
	const seen = new Set<string>();
	for (const rawId of input.currentPresetIds) {
		const id = rawId.trim();
		if (!id || seen.has(id) || !availableById.has(id)) continue;
		seen.add(id);
		presetIds.push(id);
	}
	for (const id of availableById.keys()) {
		if (seen.has(id)) continue;
		seen.add(id);
		presetIds.push(id);
	}

	const tableDefaultPresetId = input.currentDefaultPresetId
		&& availableById.has(input.currentDefaultPresetId)
		? input.currentDefaultPresetId
		: presetIds[0] ?? null;
	return {
		presetIds,
		fileBindings: presetIds.map(id => ({ id, path: availableById.get(id)!.path })),
		tableDefaultPresetId,
		initialized: input.currentInitialized || presetIds.length > 0,
	};
}

function compareAvailableTableFiles(
	left: AvailableTablePresetFileAuthority,
	right: AvailableTablePresetFileAuthority,
): number {
	return left.path.localeCompare(right.path, 'en', { sensitivity: 'base' })
		|| left.path.localeCompare(right.path, 'en')
		|| left.id.localeCompare(right.id, 'en');
}

function normalizePresetIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const entry of value) {
		const id = typeof entry === 'string' ? entry.trim() : '';
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}
