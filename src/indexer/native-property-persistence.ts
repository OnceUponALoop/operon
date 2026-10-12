import type { OperonField, ParsedTask } from '../types/fields';

export type NativePropertyField = Pick<OperonField, 'sourceKey' | 'key' | 'value' | 'rawValue'>;
export interface NativePropertyInline {
	operonId: string | null;
	lineNumber: number;
	fields: NativePropertyField[];
}
export interface NativePropertySource {
	frontmatter: Record<string, unknown> | null;
	order: readonly string[];
	inline: readonly NativePropertyInline[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
// Optional slots avoid repeating the common key === sourceKey and value === rawValue cases.
type FieldTuple = [name: string, value: string, raw?: string, key?: string];
type InlineTuple = [line: number, id: string | null, fields: FieldTuple[]];
export type PersistedNativePropertySource = { rescan: true } | {
	file: [string, JsonValue][] | null;
	inline: InlineTuple[];
};
export const NATIVE_SOURCE_RESCAN: PersistedNativePropertySource = Object.freeze({ rescan: true });

export function compactNativeInline(parsed: ParsedTask): NativePropertyInline {
	return { operonId: parsed.operonId, lineNumber: parsed.lineNumber,
		fields: parsed.fields.filter(field => field.key !== 'pinned').map(({ sourceKey, key, value, rawValue }) => ({ sourceKey, key, value, rawValue })) };
}

/** Freeze one source fragment at ingestion, never a mutable view projection or whole note. */
export function persistNativePropertySource(raw: NativePropertySource, retain: (name: string) => boolean = () => true,
 identityAliases: ReadonlySet<string> = new Set(['operonid'])): PersistedNativePropertySource {
	try {
		const file: [string, JsonValue][] | null = raw.frontmatter === null ? null : raw.order
			.filter(name => name.toLowerCase() !== 'pinned' && (retain(name) || identityAliases.has(name.toLowerCase())))
			.map(name => [name, cloneJson(raw.frontmatter![name], new Set())]);
		// Match canonical task admission: incomplete identity fields are not indexed tasks.
		const inline: InlineTuple[] = raw.inline.filter(task => Boolean(task.operonId)).map(task => [task.lineNumber, task.operonId, task.fields.filter(field => field.key === 'operonId' || retain(field.sourceKey)).map(field => {
			const tuple: FieldTuple = [field.sourceKey, field.value];
			if (field.rawValue !== field.value || field.key !== field.sourceKey) tuple.push(field.rawValue);
			if (field.key !== field.sourceKey) tuple.push(field.key);
			return tuple;
		})]);
		return freezeTree({ file, inline });
	} catch {
		// Dates, cycles, non-finite numbers and other non-JSON values retain the real-source path.
		return NATIVE_SOURCE_RESCAN;
	}
}

export function restoreNativePropertySource(value: PersistedNativePropertySource): NativePropertySource | null {
	if ('rescan' in value) return null;
	freezeTree(value);
	return { frontmatter: value.file === null ? null : Object.fromEntries(value.file),
		order: value.file?.map(([name]) => name) ?? [],
		inline: value.inline.map(([lineNumber, operonId, fields]) => ({ lineNumber, operonId,
			fields: fields.map(([sourceKey, value, rawValue = value, key = sourceKey]) => ({ sourceKey, key, value, rawValue })) })) };
}

/** Validate untrusted cache values before publishing either half of the source. */
export function isPersistedNativePropertySource(value: unknown): value is PersistedNativePropertySource {
	if (!record(value)) return false;
	if ('rescan' in value) return value.rescan === true && Object.keys(value).length === 1;
	if (Object.keys(value).length !== 2 || !('file' in value) || !('inline' in value)) return false;
	if (value.file !== null) {
		if (!Array.isArray(value.file)) return false;
		const names = new Set<string>();
		for (const entry of value.file) {
			if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || names.has(entry[0]) || entry[0].toLowerCase() === 'pinned') return false;
			names.add(entry[0]);
			try { assertJson(entry[1], new Set()); } catch { return false; }
		}
	}
	if (!Array.isArray(value.inline)) return false;
	const lines = new Set<number>();
	for (const row of value.inline) {
		if (!Array.isArray(row) || row.length !== 3 || !Number.isSafeInteger(row[0]) || row[0] < 0 || lines.has(row[0] as number)
			|| row[1] !== null && typeof row[1] !== 'string' || !Array.isArray(row[2])) return false;
		lines.add(row[0] as number);
		for (const field of row[2]) {
			if (!Array.isArray(field) || field.length < 2 || field.length > 4 || !field.every(part => typeof part === 'string')
				|| (field[3] ?? field[0]) === 'pinned') return false;
		}
	}
	return true;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertJson(value: unknown, ancestors: Set<object>): asserts value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
	if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Non-JSON native value');
	const prototype: unknown = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Non-JSON native object');
	if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new Error('Non-JSON native key');
	ancestors.add(value);
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length) throw new Error('Sparse native list');
		for (const item of value) assertJson(item, ancestors);
	} else for (const item of Object.values(value)) assertJson(item, ancestors);
	ancestors.delete(value);
}

function cloneJson(value: unknown, ancestors: Set<object>): JsonValue {
	assertJson(value, ancestors);
	return structuredClone(value);
}

function freezeTree<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freezeTree(child);
		Object.freeze(value);
	}
	return value;
}
