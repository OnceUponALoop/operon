import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { TaskCreationDraft, type CreationDraftSource } from '../src/core/task-creation-draft';
import { CreationDraftProperties, creationDraftParentFields, type CreationDraftPropertyContext } from '../src/core/task-creation-draft-properties';
import { DEFAULT_SETTINGS, type KeyMapping } from '../src/types/settings';
import type { InlinePropertyType } from '../src/core/inline-property-definitions';
import type { VaultPropertyValue } from '../src/core/vault-property-codec';

const context: CreationDraftPropertyContext = {
	keyMappings: DEFAULT_SETTINGS.keyMappings,
	propertyTypes: { Client: 'text', Values: 'multitext', Count: 'number', Reviewed: 'checkbox', Published: 'date', Appointment: 'datetime' },
};
const field = (sourceName: string, value: unknown, memberKeys?: string[]) => ({ sourceName, value, memberKeys });
const create = () => new TaskCreationDraft(context);
const put = (draft: TaskCreationDraft, source: CreationDraftSource, name: string, value: unknown, sourceId: string = source) =>
	draft.replaceSource(source, sourceId, [field(name, value)]);
const value = (draft: TaskCreationDraft, name: string) => draft.getField(name).value;
const custom = (key: string, type: InlinePropertyType, alias = key): KeyMapping => ({
	canonicalKey: key, visiblePropertyName: alias, type, enabled: true, sync: 'auto', isSystem: false,
});

test('scalar precedence is source-based, independent of arrival order', () => {
	const orders: CreationDraftSource[][] = [
		['default', 'template', 'parent', 'surface'], ['surface', 'parent', 'template', 'default'],
		['template', 'surface', 'default', 'parent'],
	];
	for (const order of orders) {
		const draft = create();
		for (const source of order) put(draft, source, 'priority', source);
		assert.equal(value(draft, 'priority'), 'surface');
		draft.setValue('priority', 'user');
		put(draft, 'parent', 'priority', 'new parent');
		assert.equal(value(draft, 'priority'), 'user');
		draft.setValue('priority', 'another user value');
		assert.equal(value(draft, 'priority'), 'another user value');
	}
});

test('each scalar tier falls back only when absent or empty', () => {
	const draft = create();
	put(draft, 'default', 'priority', 'default');
	put(draft, 'template', 'priority', 'template');
	put(draft, 'parent', 'priority', 'parent');
	put(draft, 'surface', 'priority', 'surface');
	for (const [source, expected] of [['surface', 'parent'], ['parent', 'template'], ['template', 'default']] as const) {
		put(draft, source, 'priority', '');
		assert.equal(value(draft, 'priority'), expected);
	}
	draft.removeSource('default');
	assert.equal(draft.getField('priority').state, 'empty');
});

test('blank template uses default, but explicit user clear and removal suppress it', () => {
	const draft = create();
	put(draft, 'template', 'priority', '');
	assert.equal(draft.getField('priority').state, 'empty');
	put(draft, 'default', 'priority', 'Medium');
	assert.equal(value(draft, 'priority'), 'Medium');
	draft.clearValue('priority');
	put(draft, 'template', 'priority', 'High');
	assert.equal(value(draft, 'priority'), '');
	draft.removeField('priority');
	put(draft, 'parent', 'priority', 'High');
	assert.equal(draft.getField('priority').state, 'removed');
	draft.setValue('priority', 'Low');
	assert.equal(value(draft, 'priority'), 'Low');
});

const samples: [string, VaultPropertyValue][] = [
	['Client', 'text'], ['Client', ''], ['Client', null], ['Count', 0], ['Count', -0], ['Count', 3.5], ['Count', null],
	['Reviewed', false], ['Reviewed', true], ['Reviewed', null], ['Published', '2024-02-29'],
	['Appointment', '2026-10-10T13:24:59+02:00'], ['Values', null], ['Values', []], ['Values', ['']],
	['Values', [3, '3', 'Ali', 'Ali']], ['Values', ['[[Note|Alias; x]]', '"', '\\', '{{x}}', 'a;b', '\n', '\r\n']],
];
for (const [index, [name, input]] of samples.entries()) test(`native values retain type and exact value ${index}`, () => {
	const draft = create();
	assert.equal(draft.getField(name).state, 'missing');
	put(draft, 'template', name, input);
	assert.deepEqual(value(draft, name), input);
	assert.equal(draft.getField(name).readOnlyReason, undefined);
	for (let cycle = 0; cycle < 20; cycle++) {
		const snapshot = draft.snapshot();
		put(draft, 'template', name, input);
		assert.deepEqual(draft.snapshot().fields, snapshot.fields);
	}
});

test('zero, false and one empty list member are values, not default requests', () => {
	const draft = create();
	draft.replaceSource('default', 'defaults', [field('Count', 9), field('Reviewed', true), field('Values', ['fallback'])]);
	draft.replaceSource('template', 'template', [field('Count', 0), field('Reviewed', false), field('Values', [''])]);
	assert.equal(value(draft, 'Count'), 0);
	assert.equal(value(draft, 'Reviewed'), false);
	assert.deepEqual(value(draft, 'Values'), ['']);
	assert.equal(draft.getField('Values').state, 'value');
});

for (const name of ['contexts', 'tags']) test(`${name} accumulates once and user removal survives source changes`, () => {
	const draft = create();
	draft.appendMember(name, 'a');
	put(draft, 'parent', name, ['a', 'b']);
	put(draft, 'template', name, ['d', 'e']);
	assert.deepEqual(value(draft, name), ['a', 'b', 'd', 'e']);
	draft.removeMember(name, draft.getField(name).members.find(item => item.value === 'b')!.id);
	put(draft, 'parent', name, ['a', 'b', 'c']);
	put(draft, 'template', name, ['b', 'f']);
	assert.deepEqual(value(draft, name), ['a', 'c', 'f']);
	draft.appendMember(name, 'b');
	assert.deepEqual(value(draft, name), ['a', 'b', 'c', 'f']);
});

test('tag normalization, contexts case sensitivity and authoritative lists', () => {
	const draft = create();
	draft.setValue('tags', ['#work', ' work ', '#Work']);
	assert.deepEqual(value(draft, 'tags'), ['work', 'Work']);
	put(draft, 'parent', 'tags', ['other']);
	assert.deepEqual(value(draft, 'tags'), ['work', 'Work']);
	put(draft, 'template', 'contexts', ['a', 'A', 'a']);
	assert.deepEqual(value(draft, 'contexts'), ['a', 'A']);
});

test('native list appends duplicates and edits/removes only the chosen occurrence', () => {
	const draft = create();
	put(draft, 'template', 'Values', [3, '3', 'Ali', 'Ali']);
	const initial = draft.getField('Values').members;
	draft.appendMember('Values', 'Ali');
	assert.deepEqual(value(draft, 'Values'), [3, '3', 'Ali', 'Ali', 'Ali']);
	draft.editMember('Values', initial[2].id, 'Ece');
	assert.deepEqual(value(draft, 'Values'), [3, '3', 'Ece', 'Ali', 'Ali']);
	draft.removeMember('Values', initial[3].id);
	assert.deepEqual(value(draft, 'Values'), [3, '3', 'Ece', 'Ali']);
	put(draft, 'template', 'Values', [3, '3', 'Ali', 'Ali']);
	assert.deepEqual(value(draft, 'Values'), [3, '3', 'Ece', 'Ali']);
	assert.equal(draft.getField('Values').members[2].source, 'user');
});

test('source member identity follows values on reorder and explicit keys on dynamic updates', () => {
	const draft = create();
	put(draft, 'template', 'Values', ['a', 'b']);
	draft.removeMember('Values', draft.getField('Values').members[0].id);
	put(draft, 'template', 'Values', ['b', 'a']);
	assert.deepEqual(value(draft, 'Values'), ['b']);
	draft.replaceSource('template', 'dynamic', [field('Values', ['old'], ['slot'])]);
	draft.editMember('Values', draft.getField('Values').members[0].id, 'manual');
	draft.replaceSource('template', 'dynamic', [field('Values', ['new'], ['slot'])]);
	assert.deepEqual(value(draft, 'Values'), ['manual']);
});

test('template switch removes its old members but preserves user edits, additions and parent values', () => {
	const draft = create();
	put(draft, 'parent', 'Values', ['parent']);
	put(draft, 'template', 'Values', ['a', 'b'], 'A');
	draft.editMember('Values', draft.getField('Values').members[1].id, 'manual');
	draft.appendMember('Values', 'extra');
	put(draft, 'template', 'Values', ['c'], 'B');
	assert.deepEqual(value(draft, 'Values'), ['parent', 'c', 'manual', 'extra']);
	draft.removeSource('parent');
	draft.removeSource('template');
	assert.deepEqual(value(draft, 'Values'), ['manual', 'extra']);
});

test('whole-list clear/remove never refills and explicit re-add starts the new user list', () => {
	const draft = create();
	put(draft, 'template', 'Values', ['a']);
	draft.clearValue('Values');
	put(draft, 'template', 'Values', ['b']);
	assert.deepEqual(value(draft, 'Values'), []);
	draft.removeField('Values');
	put(draft, 'parent', 'Values', ['c']);
	assert.equal(draft.getField('Values').state, 'removed');
	draft.appendMember('Values', 'user');
	assert.deepEqual(value(draft, 'Values'), ['user']);
});

test('removing the final list occurrence does not restore the old array or default', () => {
	const draft = create();
	put(draft, 'default', 'Values', ['fallback']);
	put(draft, 'template', 'Values', ['only']);
	draft.removeMember('Values', draft.getField('Values').members[0].id);
	assert.deepEqual(value(draft, 'Values'), []);
	assert.equal(draft.getField('Values').state, 'empty');
});

test('legacy custom lists keep literal quotes, escaped semicolons and duplicate strings', () => {
	const draft = new TaskCreationDraft({ ...context, keyMappings: [custom('Legacy', 'list')] });
	put(draft, 'template', 'Legacy', '"3"; "3"; a\\;b');
	assert.deepEqual(value(draft, 'Legacy'), ['"3"', '"3"', 'a;b']);
	assert.equal(draft.getField('Legacy').property.interpretation, 'legacy-custom');
});

test('native custom alias resolves to one typed field and retains vault-v1 interpretation', () => {
	const draft = new TaskCreationDraft({
		keyMappings: [custom('nativeValues', 'list', 'Values')], propertyTypes: { Values: 'multitext' },
		inlineDefinitions: { version: 1, entries: [{ sourceName: 'Values', type: 'list', encoding: 'vault-v1' }] },
	});
	put(draft, 'template', 'Values', [3, '3']);
	draft.appendMember('nativeValues', 'x');
	assert.equal(draft.snapshot().fields.length, 1);
	assert.deepEqual(value(draft, 'Values'), [3, '3', 'x']);
	assert.equal(draft.getField('Values').property.interpretation, 'native');
});

test('duplicate aliases in the same source preserve both raw values and block editing', () => {
	const draft = new TaskCreationDraft({ ...context, keyMappings: [custom('ClientKey', 'text', 'Client')] });
	draft.replaceSource('template', 'A', [field('Client', 'one'), field('clientkey', 'two')]);
	const result = draft.getField('Client');
	assert.equal(result.readOnlyReason, 'type-conflict');
	assert.deepEqual(result.contributions.map(item => item.rawValue), ['one', 'two']);
	assert.throws(() => draft.setValue('Client', 'overwrite'), /read-only/);
});

test('aliases across different sources resolve to one field, not a conflict', () => {
	const draft = new TaskCreationDraft({ ...context, keyMappings: [custom('ClientKey', 'text', 'Client')] });
	put(draft, 'template', 'Client', 'template');
	put(draft, 'parent', 'CLIENTKEY', 'parent');
	assert.equal(draft.snapshot().fields.length, 1);
	assert.equal(value(draft, 'Client'), 'parent');
	assert.equal(draft.getField('Client').readOnlyReason, undefined);
});

for (const [label, settings, name, raw, reason] of [
	['automatic', { ...context, propertyTypes: {} }, 'Unknown', 'text', 'automatic'],
	['unavailable', { ...context, propertyTypes: null }, 'Client', 'text', 'unavailable'],
	['wrong scalar', context, 'Count', 'not a number', 'type-conflict'],
	['nested value', context, 'Client', { child: ['x'] }, 'unsupported'],
	['nested Automatic', { ...context, propertyTypes: {} }, 'Unknown', { child: ['x'] }, 'unsupported'],
	['nested list', context, 'Values', [['x']], 'unsupported'],
	['boolean list', context, 'Values', [false], 'unsupported'],
	['alias collision', { ...context, keyMappings: [custom('a', 'text', 'Client'), custom('b', 'text', 'Client')] }, 'Client', 'x', 'type-conflict'],
	['type registry collision', { ...context, propertyTypes: { Client: 'text', client: 'number' } }, 'Client', 'x', 'type-conflict'],
	['definition mismatch', { ...context, inlineDefinitions: { version: 1, entries: [{ sourceName: 'Count', type: 'text', encoding: 'vault-v1' }] } }, 'Count', 3, 'type-conflict'],
] as const) test(`${label}: raw input is retained, never silently converted`, () => {
	const draft = new TaskCreationDraft(settings as CreationDraftPropertyContext);
	put(draft, 'template', name, raw);
	const result = draft.getField(name);
	assert.equal(result.readOnlyReason, reason);
	assert.deepEqual(result.contributions[0].rawValue, raw);
	assert.throws(() => draft.clearValue(name), /read-only/);
});

test('invalid mutations and invalid member IDs leave the snapshot intact', () => {
	const draft = create();
	const before = draft.snapshot();
	assert.throws(() => draft.setValue('Count', 'bad'));
	assert.throws(() => draft.appendMember('Values', Number.NaN));
	assert.deepEqual(draft.snapshot(), before);
	put(draft, 'template', 'Values', ['a']);
	const next = draft.snapshot();
	assert.throws(() => draft.removeMember('Values', 'missing'));
	assert.deepEqual(draft.snapshot(), next);
});

test('source replacement validates all member identities before publishing', () => {
	const draft = create();
	put(draft, 'template', 'Client', 'old');
	const token = draft.beginSource('template', 'template');
	const before = draft.snapshot();
	assert.throws(() => draft.applySource(token, [field('Client', 'new'), field('Values', ['a', 'b'], ['same', 'same'])]));
	assert.deepEqual(draft.snapshot(), before);
	assert.equal(draft.applySource(token, [field('Client', 'new')]), true);
});

test('stale, replayed and removed-source results cannot replace current data', () => {
	const draft = create();
	const a = draft.beginSource('template', 'A');
	const b = draft.beginSource('template', 'B');
	assert.equal(draft.applySource(b, [field('Client', 'B')]), true);
	assert.equal(draft.applySource(a, [field('Client', 'A')]), false);
	assert.equal(draft.applySource(b, [field('Client', 'replay')]), false);
	const removed = draft.beginSource('parent', 'P');
	draft.removeSource('parent');
	assert.equal(draft.applySource(removed, [field('Client', 'parent')]), false);
	assert.equal(value(draft, 'Client'), 'B');
});

test('source results completing after manual editing preserve the edit', () => {
	const draft = create();
	const token = draft.beginSource('template', 'A');
	draft.setValue('Client', 'manual');
	assert.equal(draft.applySource(token, [field('Client', 'late')]), true);
	assert.equal(value(draft, 'Client'), 'manual');
});

test('all source, context and snapshot inputs are deeply isolated', () => {
	const options = structuredClone(context);
	const draft = new TaskCreationDraft(options);
	options.propertyTypes = {};
	const raw = ['original'];
	put(draft, 'template', 'Values', raw);
	raw.push('external');
	const snapshot = draft.snapshot();
	(snapshot.fields[0].value as string[]).push('snapshot');
	(snapshot.fields[0].contributions[0].rawValue as string[]).push('raw snapshot');
	snapshot.fields[0].members[0].value = 'member snapshot';
	assert.deepEqual(value(draft, 'Values'), ['original']);
});

test('prepared template dates are stable; dependent values can refresh unless manually edited', () => {
	const draft = create();
	draft.replaceSource('template', 'A', [field('Published', '2026-10-10'), field('Client', 'Description A')]);
	const captured = draft.snapshot();
	draft.setValue('Client', 'manual');
	draft.replaceSource('template', 'A', [field('Published', '2026-10-10'), field('Client', 'Description B')]);
	assert.equal(value(draft, 'Published'), '2026-10-10');
	assert.equal(value(draft, 'Client'), 'manual');
	assert.equal(captured.fields.find(item => item.property.sourceName === 'Client')?.value, 'Description A');
});

test('system identity/times and their aliases cannot enter the prepared property draft', () => {
	const mappings = [...DEFAULT_SETTINGS.keyMappings.filter(item => item.canonicalKey !== 'operonId'),
		{ canonicalKey: 'operonId', visiblePropertyName: 'ID', type: 'text', enabled: true, sync: 'yes', isSystem: true } as KeyMapping];
	const draft = new TaskCreationDraft({ ...context, keyMappings: mappings });
	draft.replaceSource('template', 'A', [field('ID', 'copied-id'), field('datetimeCreated', '2000-01-01T00:00:00'), field('datetimeModified', '2000-01-01T00:00:00')]);
	assert.equal(draft.snapshot().fields.length, 0);
	assert.equal(draft.snapshot().excludedSystemFields.length, 3);
	assert.throws(() => draft.setValue('ID', 'manual'), /read-only/);
});

test('special relationship lists use whole-field precedence and reject generic member operations', () => {
	const draft = create();
	put(draft, 'template', 'blockedBy', ['template-id']);
	put(draft, 'surface', 'blockedBy', ['surface-id']);
	assert.deepEqual(value(draft, 'blockedBy'), ['surface-id']);
	assert.throws(() => draft.appendMember('blockedBy', 'another'), /dedicated editor/);
});

test('user-managed related references are preserved as a special field', () => {
	const draft = create();
	put(draft, 'template', 'related', ['[[Note]]']);
	assert.deepEqual(value(draft, 'related'), ['[[Note]]']);
	assert.ok(!draft.snapshot().excludedSystemFields.includes('related'));
	draft.setValue('related', ['[[User note]]']);
	assert.deepEqual(value(draft, 'related'), ['[[User note]]']);
	assert.throws(() => draft.appendMember('related', 'another'), /dedicated editor/);
});

test('parent extraction respects enabled inheritance and never labels default priority as parent', () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.childTaskInheritanceFields = ['priority', 'contexts', 'tags'];
	settings.defaultPriority = 'Default';
	const inherited = creationDraftParentFields('parent1', { contexts: 'a; b', taskIcon: 'star' }, ['work'], settings);
	assert.ok(!inherited.some(item => item.sourceName === 'priority' || item.sourceName === 'taskIcon'));
	const draft = create();
	draft.replaceSource('parent', 'parent1', inherited);
	put(draft, 'template', 'priority', 'Template');
	put(draft, 'default', 'priority', 'Default');
	assert.equal(value(draft, 'priority'), 'Template');
	assert.deepEqual(value(draft, 'contexts'), ['a', 'b']);
	assert.deepEqual(value(draft, 'tags'), ['work']);
	assert.deepEqual(creationDraftParentFields(null, { priority: 'High' }, [], settings), []);
});

test('parent status resolves the configured pipeline initial status, not its current status', () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.childTaskInheritanceFields = ['status'];
	const pipeline = settings.pipelines[0];
	assert.ok(pipeline?.statuses.length);
	const status = `${pipeline.name}.${pipeline.statuses.at(-1)!.label}`;
	const inherited = creationDraftParentFields('parent1', { status }, [], settings);
	assert.equal(inherited.find(item => item.sourceName === 'status')?.value, `${pipeline.name}.${pipeline.statuses[0].label}`);
});

test('native parent override is used only for configured inherited fields', () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.keyMappings.push(custom('Values', 'list'));
	settings.childTaskInheritanceFields = ['Values'];
	const result = creationDraftParentFields('parent1', { Values: 'index projection' }, [], settings,
		new Map<string, VaultPropertyValue>([['Values', [3, '3', 'Ali', 'Ali']], ['Client', 'not inherited']]));
	assert.deepEqual(result.find(item => item.sourceName === 'Values')?.value, [3, '3', 'Ali', 'Ali']);
	assert.ok(!result.some(item => item.sourceName === 'Client'));
});

test('Creation draft remains pure and excluded from low-level writer and Runtime defaults', () => {
	for (const path of ['src/core/task-writer.ts', 'src/agent-runtime/runtime/task-creation-adapter.ts']) {
		assert.doesNotMatch(readFileSync(path, 'utf8'), /from ['"][^'"]*task-creation-draft['"]/);
	}
	const source = readFileSync('src/core/task-creation-draft.ts', 'utf8');
	assert.doesNotMatch(source, /Date\.now|new Date|\.vault\.|saveData|saveSettings|\.adapter\.|Templater/);
});

test('Automatic fields distinguish missing, blank and populated without inferring a writable type', () => {
	const draft = new TaskCreationDraft({ keyMappings: [], propertyTypes: {} });
	assert.equal(draft.getField('Unknown').state, 'missing');
	for (const [raw, state] of [[null, 'empty'], ['', 'empty'], ['value', 'value'], [0, 'value'], [false, 'value'], [[], 'empty'], [[''], 'value']] as const) {
		put(draft, 'template', 'Unknown', raw);
		assert.equal(draft.getField('Unknown').state, state);
		assert.equal(draft.getField('Unknown').readOnlyReason, 'automatic');
	}
});

test('an ambiguous visible alias also blocks mutation through either canonical mapping name', () => {
	const draft = new TaskCreationDraft({ ...context, keyMappings: [custom('a', 'text', 'Client'), custom('b', 'text', 'Client')] });
	for (const name of ['a', 'b', 'Client']) assert.throws(() => draft.setValue(name, 'unsafe'), /read-only/);
});

test('explicit vault declarations conflicting with a legacy custom mapping remain read-only', () => {
	const draft = new TaskCreationDraft({ keyMappings: [custom('ClientKey', 'text', 'Client')], propertyTypes: { Client: 'number' } });
	put(draft, 'template', 'ClientKey', 'text');
	assert.equal(draft.getField('Client').readOnlyReason, 'type-conflict');
	assert.throws(() => draft.setValue('Client', 'text'), /read-only/);
});

test('appending to an explicitly null list creates a user list and still blocks automatic refill', () => {
	const draft = create();
	draft.setValue('Values', null);
	draft.appendMember('Values', 'new');
	put(draft, 'template', 'Values', ['template']);
	assert.deepEqual(value(draft, 'Values'), ['new']);
});

test('explicitly re-adding an inherited context makes it survive removal of that source', () => {
	const draft = create();
	put(draft, 'parent', 'contexts', ['a']);
	draft.appendMember('contexts', 'a');
	draft.removeSource('parent');
	assert.deepEqual(value(draft, 'contexts'), ['a']);
});

for (const blank of [null, '']) test(`review: automatic blank schedule preserves surface start (${blank})`, () => {
 const draft=create();put(draft,'surface','datetimeStart','2026-10-10T09:00:00');put(draft,'template','dateScheduled',blank);
 assert.equal(value(draft,'datetimeStart'),'2026-10-10T09:00:00');assert.equal(value(draft,'dateScheduled'),'2026-10-10');
});
test('review: the latest user scheduling edit wins without losing source contributions', () => {
 const draft=create();draft.setValue('dateScheduled','2026-10-10');draft.setValue('datetimeStart','2026-10-10T09:00:00');draft.setValue('dateScheduled','2026-12-01');
 assert.equal(value(draft,'datetimeStart'),'2026-12-01T09:00:00');assert.equal(value(draft,'dateScheduled'),'2026-12-01');
});
