import type { App } from 'obsidian';

export type ObsidianPropertyTypeId =
	| 'text'
	| 'multitext'
	| 'number'
	| 'checkbox'
	| 'date'
	| 'datetime'
	| 'aliases'
	| 'tags'
	| 'unknown';

export async function loadPropertyTypeRegistry(
	app: App,
): Promise<Record<string, ObsidianPropertyTypeId>> {
	const path = `${app.vault.configDir}/types.json`;
	if (app.vault.adapter.exists && !await app.vault.adapter.exists(path)) return {};
	const raw = await app.vault.adapter.read(path);
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid property type registry');
	const types = (parsed as { types?: unknown }).types;
	if (!types || typeof types !== 'object' || Array.isArray(types)) throw new Error('Invalid property type registry');
	const resolved: Record<string, ObsidianPropertyTypeId> = {};
	for (const [propertyName, type] of Object.entries(types)) {
		const normalizedType = normalizeObsidianPropertyTypeId(type);
		resolved[propertyName] = normalizedType ?? 'unknown';
	}
	return resolved;
}

function normalizeObsidianPropertyTypeId(value: unknown): ObsidianPropertyTypeId | null {
	if (
		value === 'text'
		|| value === 'multitext'
		|| value === 'number'
		|| value === 'checkbox'
		|| value === 'date'
		|| value === 'datetime'
		|| value === 'aliases'
		|| value === 'tags'
	) return value;
	return null;
}
