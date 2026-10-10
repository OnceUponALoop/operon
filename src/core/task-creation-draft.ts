import { normalizeTaskFieldPatch } from './task-field-patch';
import { isEmptyFilePropertyValue } from './raw-yaml-property';
import type { NativePropertyReadOnlyReason } from './task-editor-native-properties';
import type { VaultPropertyValue } from './vault-property-codec';
import { CreationDraftProperties, type CreationDraftFieldInput, type CreationDraftProperty, type CreationDraftPropertyContext } from './task-creation-draft-properties';

export type CreationDraftSource = 'surface' | 'parent' | 'template' | 'default';
export interface CreationDraftSourceToken {
	readonly source: CreationDraftSource;
	readonly sourceId: string;
	readonly revision: number;
}
export interface CreationDraftMember {
	id: string;
	value: string | number;
	source: CreationDraftSource | 'user';
	sourceId: string;
}
export interface CreationDraftContribution {
	source: CreationDraftSource;
	sourceId: string;
	sourceName: string;
	rawValue: unknown;
	value?: VaultPropertyValue;
	members: CreationDraftMember[];
	readOnlyReason?: NativePropertyReadOnlyReason;
}
export interface CreationDraftFieldSnapshot {
	property: CreationDraftProperty;
	state: 'missing' | 'empty' | 'value' | 'removed';
	value?: VaultPropertyValue;
	members: CreationDraftMember[];
	contributions: CreationDraftContribution[];
	userModified: boolean;
	readOnlyReason?: NativePropertyReadOnlyReason;
}
export interface CreationDraftSnapshot {
	revision: number;
	fields: CreationDraftFieldSnapshot[];
	pendingSources: CreationDraftSourceToken[];
	excludedSystemFields: string[];
}

interface SourceState {
	token: CreationDraftSourceToken;
	pending: boolean;
	fields: Map<string, CreationDraftContribution[]>;
	excluded: string[];
}
interface UserField {
	revision: number;
	action?: 'set' | 'remove';
	value?: VaultPropertyValue;
	members: CreationDraftMember[];
	edits: Map<string, CreationDraftMember>;
	removedMembers: Set<string>;
	removedValues: Set<string>;
}
const SOURCE_ORDER: readonly CreationDraftSource[] = ['surface', 'parent', 'template', 'default'];

/**
 * Pure session draft for Creator only. UI adapters, materialization and writers deliberately
 * do not consume it yet. Source replacement is atomic and rejects obsolete async results.
 */
export class TaskCreationDraft {
	private readonly catalog: CreationDraftProperties;
	private readonly properties = new Map<string, CreationDraftProperty>();
	private readonly sources = new Map<CreationDraftSource, SourceState>();
	private readonly users = new Map<string, UserField>();
	private revision = 0;
	private memberSequence = 0;

	constructor(context: CreationDraftPropertyContext) {
		this.catalog = new CreationDraftProperties(context);
	}

	/** A new selection clears only that source. A refresh of the same selection retains its last snapshot while pending. */
	beginSource(source: CreationDraftSource, sourceId: string): CreationDraftSourceToken {
		const previous = this.sources.get(source);
		const token = Object.freeze({ source, sourceId, revision: ++this.revision });
		this.sources.set(source, {
			token, pending: true,
			fields: previous?.token.sourceId === sourceId ? previous.fields : new Map<string, CreationDraftContribution[]>(),
			excluded: previous?.token.sourceId === sourceId ? previous.excluded : [],
		});
		return token;
	}

	applySource(token: CreationDraftSourceToken, fields: readonly CreationDraftFieldInput[]): boolean {
		const state = this.sources.get(token.source);
		if (!state || state.token !== token || !state.pending) return false;
		const next = new Map<string, CreationDraftContribution[]>();
		const properties = new Map<string, CreationDraftProperty>();
		const excluded: string[] = [];
		for (const field of fields) {
			const property = this.catalog.resolve(field.sourceName);
			if (property.merge === 'system') { excluded.push(field.sourceName); continue; }
			const read = this.catalog.read(property, field.value);
			const members = this.sourceMembers(property, token, read.value, field.memberKeys);
			const contribution: CreationDraftContribution = {
				source: token.source, sourceId: token.sourceId, sourceName: field.sourceName,
				rawValue: structuredClone(field.value), ...read, members,
			};
			next.set(property.id, [...(next.get(property.id) ?? []), contribution]);
			properties.set(property.id, property);
		}
		for (const [id, property] of properties) this.properties.set(id, property);
		state.fields = next;
		state.excluded = excluded;
		state.pending = false;
		this.revision++;
		return true;
	}

	replaceSource(source: CreationDraftSource, sourceId: string, fields: readonly CreationDraftFieldInput[]): void {
		this.applySource(this.beginSource(source, sourceId), fields);
	}

	removeSource(source: CreationDraftSource): void {
		this.sources.delete(source);
		this.revision++;
	}

	/** Full-field editing is authoritative. Incremental list pickers should use member operations. */
	setValue(sourceName: string, raw: VaultPropertyValue): void {
		const property = this.writable(sourceName);
		const read = this.catalog.read(property, raw);
		if (read.readOnlyReason || read.value === undefined) throw new Error('Invalid creation draft value');
		if (property.merge === 'set' && Array.isArray(read.value)) read.value = [...new Set(read.value)];
		const user = this.emptyUser();
		user.action = 'set';
		user.value = read.value;
		if (Array.isArray(read.value)) user.members = read.value.map(value => this.userMember(value));
		this.users.set(property.id, user);
		this.properties.set(property.id, property);
		this.revision++;
	}

	clearValue(sourceName: string): void {
		const property = this.writable(sourceName);
		this.setValue(sourceName, property.type === 'list' ? [] : property.type === 'text' ? '' : null);
	}

	removeField(sourceName: string): void {
		const property = this.writable(sourceName);
		this.users.set(property.id, { ...this.emptyUser(), action: 'remove' });
		this.properties.set(property.id, property);
		this.revision++;
	}

	appendMember(sourceName: string, value: string | number): void {
		const property = this.listProperty(sourceName);
		const normalized = this.listValue(property, value);
		const user = this.user(property.id);
		this.properties.set(property.id, property);
		if (user.action === 'remove') { user.action = 'set'; user.value = []; }
		if (user.action === 'set' && !Array.isArray(user.value)) user.value = [];
		if (property.merge === 'set') {
			user.removedValues.delete(String(normalized));
			if (user.members.some(member => member.value === normalized)) return;
		}
		user.members.push(this.userMember(normalized));
		this.revision++;
	}

	editMember(sourceName: string, memberId: string, value: string | number): void {
		const property = this.listProperty(sourceName);
		const normalized = this.listValue(property, value);
		const member = this.currentMember(sourceName, memberId);
		const user = this.user(property.id);
		if (property.merge === 'set') {
			this.removeMember(sourceName, memberId);
			this.appendMember(sourceName, normalized);
			return;
		}
		const edited = { ...member, value: normalized, source: 'user' as const };
		const index = user.members.findIndex(item => item.id === memberId);
		if (index >= 0) user.members[index] = edited;
		else user.edits.set(memberId, edited);
		this.revision++;
	}

	removeMember(sourceName: string, memberId: string): void {
		const property = this.listProperty(sourceName);
		const member = this.currentMember(sourceName, memberId);
		const user = this.user(property.id);
		user.members = user.members.filter(item => item.id !== memberId);
		user.edits.delete(memberId);
		user.removedMembers.add(memberId);
		if (property.merge === 'set') user.removedValues.add(String(member.value));
		this.revision++;
	}

	getField(sourceName: string): CreationDraftFieldSnapshot {
		const property = this.catalog.resolve(sourceName);
		const scheduled = ['dateScheduled', 'datetimeStart', 'datetimeEnd', 'estimate', 'repeat', 'datetimeRepeatEnd'].includes(property.canonicalKey ?? '');
		return structuredClone(scheduled ? this.resolvedFields().find(field => field.property.id === property.id) ?? this.resolve(property) : this.resolve(property));
	}

	snapshot(): CreationDraftSnapshot {
		return structuredClone({
			revision: this.revision,
			fields: this.resolvedFields(),
			pendingSources: [...this.sources.values()].filter(state => state.pending).map(state => state.token),
			excludedSystemFields: [...this.sources.values()].flatMap(state => state.excluded),
		});
	}

	/** Derive companion values without converting source contributions into user edits. */
	private resolvedFields(): CreationDraftFieldSnapshot[] {
		const fields = [...this.properties.values()].map(property => this.resolve(property));
		const keys = ['dateScheduled', 'datetimeStart', 'datetimeEnd', 'estimate', 'repeat', 'datetimeRepeatEnd'];
		const rank = (field: CreationDraftFieldSnapshot): number => {
			if (field.userModified) return SOURCE_ORDER.length;
			const source = field.contributions.find(item => item.value !== undefined && !isEmptyFilePropertyValue(item.value))?.source;
			return source ? SOURCE_ORDER.length - 1 - SOURCE_ORDER.indexOf(source) : -1;
		};
		const inputs = fields.filter(field => keys.includes(field.property.canonicalKey ?? '') && field.state !== 'missing' && !field.readOnlyReason
			&& (field.userModified || !isEmptyFilePropertyValue(field.value)));
		if (!inputs.length) return fields;
		// Existing scheduling rules treat the last changed field as authoritative.
		// Apply weaker sources first so a Calendar/user date wins over template time.
		// Empty automatic contributions are not explicit clear commands; user clears are.
		inputs.sort((a, b) => rank(a) - rank(b)
			|| (this.users.get(a.property.id)?.revision ?? 0) - (this.users.get(b.property.id)?.revision ?? 0));
		const payload = Object.fromEntries(inputs.map(field => [field.property.canonicalKey!, field.state === 'removed' || field.value == null ? '' : String(field.value)]));
		// Seed companion values, then apply each field in authority order. A later
		// estimate must not suppress an earlier, stronger date/start reconciliation.
		let normalized = { ...payload };
		for (const [key, value] of Object.entries(payload)) {
			normalized = { ...normalized, ...normalizeTaskFieldPatch(normalized, { [key]: value }, { deferRepeatIdentity: true }) };
		}
		for (const [key, value] of Object.entries(normalized)) {
			const property = this.catalog.resolve(key);
			const existing = fields.find(field => field.property.id === property.id);
			if (existing?.state === 'removed' || existing?.readOnlyReason || !existing && !value) continue;
			if (existing) {
				if (String(existing.value ?? '') === value) continue;
				existing.value = value;
				existing.state = value ? 'value' : 'empty';
			} else fields.push({ property, state: 'value', value, members: [], contributions: [], userModified: false });
		}
		return fields;
	}

	private resolve(property: CreationDraftProperty): CreationDraftFieldSnapshot {
		const contributions = SOURCE_ORDER.flatMap(source => this.sources.get(source)?.fields.get(property.id) ?? []);
		const user = this.users.get(property.id);
		const duplicateAlias = SOURCE_ORDER.some(source => (this.sources.get(source)?.fields.get(property.id)?.length ?? 0) > 1);
		const readOnlyReason = duplicateAlias ? 'type-conflict' : contributions.find(item => item.readOnlyReason)?.readOnlyReason ?? property.readOnlyReason;
		const base = { property, contributions, userModified: !!user, readOnlyReason };
		if (user?.action === 'remove') return { ...base, state: 'removed', members: [] };
		if (user?.action === 'set') {
			const value = Array.isArray(user.value) ? user.members.map(member => member.value) : user.value;
			return { ...base, state: isEmptyFilePropertyValue(value) ? 'empty' : 'value', value, members: user.members };
		}
		const valid = contributions.filter(item => item.value !== undefined);
		const candidate = valid.find(item => !isEmptyFilePropertyValue(item.value)) ?? valid[0];
		if (property.merge === 'set' || property.merge === 'sequence') {
			const nonDefault = valid.filter(item => item.source !== 'default');
			const inputs = nonDefault.some(item => !isEmptyFilePropertyValue(item.value)) || user?.members.length || user?.edits.size
				? nonDefault : valid;
			const seenEdits = new Set<string>();
			let members = inputs.flatMap(item => item.members).flatMap(member => {
				if (user?.removedMembers.has(member.id)) return [];
				const edit = user?.edits.get(member.id);
				if (edit) seenEdits.add(member.id);
				return [edit ?? member];
			});
			const orphans = [...(user?.edits.values() ?? [])].filter(member => !seenEdits.has(member.id));
			members = property.merge === 'set'
				? [...(user?.members ?? []), ...members]
				: [...members, ...orphans, ...(user?.members ?? [])];
			if (property.merge === 'set') {
				const seen = new Set<string>();
				members = members.filter(member => {
					const key = String(member.value);
					if (seen.has(key) || user?.removedValues.has(key)) return false;
					seen.add(key); return true;
				});
			}
			const present = contributions.length > 0 || user !== undefined;
			const value = members.length ? members.map(member => member.value)
				: user ? [] : candidate?.value;
			return { ...base, state: !present ? 'missing' : isEmptyFilePropertyValue(value === undefined ? contributions[0]?.rawValue : value) ? 'empty' : 'value', value, members };
		}
		return {
			...base, state: !contributions.length ? 'missing' : isEmptyFilePropertyValue(candidate ? candidate.value : contributions[0].rawValue) ? 'empty' : 'value',
			value: candidate?.value, members: [],
		};
	}

	private sourceMembers(property: CreationDraftProperty, token: CreationDraftSourceToken, value: VaultPropertyValue | undefined, keys?: readonly string[]): CreationDraftMember[] {
		if (!Array.isArray(value) || property.merge !== 'set' && property.merge !== 'sequence') return [];
		if (keys && (keys.length !== value.length || new Set(keys).size !== keys.length || keys.some(key => !key))) throw new Error('Invalid creation draft member keys');
		const counts = new Map<string, number>();
		return value.map((item, index) => {
			const identity = typeof item === 'number' && Object.is(item, -0) ? '-0' : JSON.stringify(item);
			const count = counts.get(identity) ?? 0;
			counts.set(identity, count + 1);
			return {
				id: JSON.stringify([token.source, token.sourceId, property.id, keys ? ['key', keys[index]] : ['value', identity, count]]),
				value: item, source: token.source, sourceId: token.sourceId,
			};
		});
	}

	private writable(sourceName: string): CreationDraftProperty {
		const property = this.catalog.resolve(sourceName);
		if (property.merge === 'system' || this.resolve(property).readOnlyReason) throw new Error('Creation draft property is read-only');
		return property;
	}

	private listProperty(sourceName: string): CreationDraftProperty {
		const property = this.writable(sourceName);
		if (property.merge !== 'set' && property.merge !== 'sequence') throw new Error('Creation draft property requires its dedicated editor');
		return property;
	}

	private listValue(property: CreationDraftProperty, value: string | number): string | number {
		const parsed = this.catalog.read(property, [value]);
		if (parsed.readOnlyReason || !Array.isArray(parsed.value) || parsed.value.length !== 1) throw new Error('Invalid creation draft list member');
		return parsed.value[0];
	}

	private currentMember(sourceName: string, memberId: string): CreationDraftMember {
		const member = this.getField(sourceName).members.find(item => item.id === memberId);
		if (!member) throw new Error('Creation draft member no longer exists');
		return member;
	}

	private userMember(value: string | number): CreationDraftMember {
		return { id: `user:${++this.memberSequence}`, value, source: 'user', sourceId: 'user' };
	}

	private emptyUser(): UserField {
		return { revision: this.revision + 1, members: [], edits: new Map(), removedMembers: new Set(), removedValues: new Set() };
	}

	private user(id: string): UserField {
		let user = this.users.get(id);
		if (!user) { user = this.emptyUser(); this.users.set(id, user); }
		return user;
	}
}
