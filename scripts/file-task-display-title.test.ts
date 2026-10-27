import assert from 'node:assert/strict';

import { test } from 'node:test';

import { TFile, type App } from 'obsidian';

import { getTaskDisplayTitle } from '../src/core/task-display-title';

import { isWritableRawYamlPropertyName } from '../src/core/raw-yaml-property';

import { applyYamlTaskFieldValues } from '../src/core/task-writer-yaml';

import { buildMergedFileTaskDraft, parseFrontmatterDocument } from '../src/core/file-task-template-merge';

import { scanFileWithMappings } from '../src/indexer/file-scanner';

import type { IndexedTask } from '../src/types/fields';

import { DEFAULT_SETTINGS, buildKeyMappingVisiblePropertyNameUpdate, getMissingDefaultKeyMappingCollisions, isChildTaskInheritanceEligibleFieldKey, migrateSettings } from '../src/types/settings';

import { buildLivePropertyCatalogV1 } from '../src/agent-runtime/runtime/catalog-builder';

import { buildTaskPoolSearchText } from '../src/systems/task-pool-search';

import { rankTaskSearchResults } from '../src/systems/task-search';


import { getTableTaskRawValue } from '../src/ui/table/table-value-adapter';

import { createTableValueResolver } from '../src/ui/table/table-value-cache';

import { buildTableTaskSearchMatcher } from '../src/ui/table/table-search';

const file = Object.assign(Object.create(TFile.prototype) as TFile, {
	path: 'old-file.md', name: 'old-file.md', basename: 'old-file', extension: 'md', parent: { path: '' },
	stat: { mtime: 1, ctime: 1, size: 1 },
});

const task: IndexedTask = {
	operonId: 'n000123', description: 'old-file', checkbox: 'open', tags: [],
	fieldValues: { fileTaskDisplayTitle: 'Readable task title' },
	primary: { filePath: file.path, lineNumber: 0, format: 'yaml' }, datetimeModified: '', tier: 'hot',
};

function mappingsFor(name: string) {
	const result = buildKeyMappingVisiblePropertyNameUpdate(DEFAULT_SETTINGS.keyMappings, 'fileTaskDisplayTitle', name);
	assert.equal(result.status, 'updated');
	if (result.status !== 'updated') throw new Error('Expected title mapping');
	return result.keyMappings;
}

test('canonical title hydration follows the mapping and preserves filename identity', async () => {
	const source = '---\noperonId: n000123\ntitle: Readable task title\nlabel: Alternate label\n---\nBody';
	const app = { vault: { read: async () => source } } as unknown as App;
	for (const [mappings, expected] of [[DEFAULT_SETTINGS.keyMappings, 'Readable task title'], [mappingsFor('label'), 'Alternate label']] as const) {
		const scanned = (await scanFileWithMappings(app, file, mappings, source)).yamlTask!;
		assert.equal(scanned.description, 'old-file');
		assert.equal(scanned.fieldValues.title, undefined);
		assert.equal(scanned.fieldValues.fileTaskDisplayTitle, expected);
	}
	assert.equal(isChildTaskInheritanceEligibleFieldKey('fileTaskDisplayTitle', DEFAULT_SETTINGS.keyMappings), false);
});

test('labels use the opt-in title while Table raw identity stays the filename', () => {
	assert.equal(getTaskDisplayTitle(task, false), 'old-file');
	assert.equal(getTaskDisplayTitle(task, true), 'Readable task title');
	assert.equal(getTaskDisplayTitle({ ...task, fieldValues: {} }, true), 'old-file');
	assert.equal(getTaskDisplayTitle({ ...task, primary: { ...task.primary, format: 'inline' } }, true), 'old-file');
	assert.equal(getTableTaskRawValue(task, 'description'), 'old-file');
	for (const enabled of [false, true]) {
		const resolver = createTableValueResolver([task], { keyMappings: DEFAULT_SETTINGS.keyMappings, fileTaskDisplayTitleEnabled: enabled });
		assert.equal(resolver.getDisplayValue(task, 'description'), enabled ? 'Readable task title' : 'old-file');
	}
});

test('Finder, Table and task-pool search use the enabled display title', () => {
	for (const enabled of [false, true]) {
		const results = rankTaskSearchResults({
			tasks: [task, { ...task, operonId: 'n000124', fieldValues: {} }], query: 'readable task',
			includeAllTasks: true, keyMappings: [], displayTitleEnabled: enabled,
		});
		assert.deepEqual(results.map(result => result.task.operonId), enabled ? ['n000123'] : []);
		assert.equal(buildTaskPoolSearchText(task, enabled).includes('Readable task title'), enabled);
	}
	const match = buildTableTaskSearchMatcher([task], { ...DEFAULT_SETTINGS, fileTaskDisplayTitleEnabled: true }, [{ key: 'description', kind: 'task' }]);
	assert.equal(match(task, 'readable task'), true);
});

// Additional approved rendering coverage.
import contextFixtures from './agent-runtime/contracts/fixtures/cases.json';
import { decodeTaskContextV1 } from '../src/agent-runtime/contracts/v1/decode';



test('Runtime TaskContext displayTitle is optional and bounded in UTF-8 bytes', () => {
	const fixture = contextFixtures.cases.find(item => item.schemaId === 'task-context' && item.expected);
	assert.ok(fixture);
	const value = structuredClone(fixture.value);
	const entity = value;
	assert.ok('description' in entity);
	for (const [displayTitle, accepted] of [
		[undefined, true], ['Readable title', true], ['a'.repeat(8192), true], ['a'.repeat(8193), false],
		['é'.repeat(4096), true], ['é'.repeat(4096) + 'a', false], [42, false],
	] as const) {
		if (displayTitle === undefined) Reflect.deleteProperty(entity, 'displayTitle');
		else Reflect.set(entity, 'displayTitle', displayTitle);
		const decoded = decodeTaskContextV1(value);
		assert.equal(decoded.ok, accepted);
		if (decoded.ok) {
			assert.equal(decoded.value.displayTitle, displayTitle);
			assert.equal(Object.prototype.hasOwnProperty.call(decoded.value, 'displayTitle'), displayTitle !== undefined);
			assert.equal(decoded.value.description, entity.description);
		}
	}
});



test('migration preserves custom mappings that collide with the title default', () => {
	for (const [canonicalKey, visiblePropertyName] of [['customDocumentTitle', 'title'], ['fileTaskDisplayTitle', 'customTitle']]) {
		const custom = { canonicalKey, visiblePropertyName, type: 'text' as const, sync: 'yes' as const, enabled: true, isSystem: false };
		const settings = migrateSettings({ ...DEFAULT_SETTINGS, keyMappings: [...DEFAULT_SETTINGS.keyMappings.filter(m => m.canonicalKey !== 'fileTaskDisplayTitle'), custom] });
		const preserved = settings.keyMappings.filter(m => m.canonicalKey === canonicalKey);
		assert.equal(preserved.length, 1);
		assert.equal(preserved[0].visiblePropertyName, visiblePropertyName);
		assert.equal(preserved[0].isSystem, false);
		assert.deepEqual(getMissingDefaultKeyMappingCollisions(settings.keyMappings), ['fileTaskDisplayTitle']);
		if (canonicalKey === 'customDocumentTitle') {
			const catalog = buildLivePropertyCatalogV1(settings);
			assert.ok(catalog.ok);
			assert.equal(catalog.value.fields.find(f => f.canonicalKey === 'fileTaskDisplayTitle')?.mappingStatus, 'unmapped');
		}
	}
});

test('title write permission applies only to the mapped system property', () => {
	for (const [name, mappings] of [['title', DEFAULT_SETTINGS.keyMappings], ['label', mappingsFor('label')]] as const) {
		assert.equal(isWritableRawYamlPropertyName(name, mappings), false);
		assert.equal(isWritableRawYamlPropertyName(name, mappings, 'fileTaskDisplayTitle'), true);
		for (const forbidden of ['notTheMappedTitle', '_title', 'operonId', name === 'label' ? 'title' : 'label']) {
			assert.equal(isWritableRawYamlPropertyName(forbidden, mappings, 'fileTaskDisplayTitle'), false);
		}
	}
	assert.equal(isWritableRawYamlPropertyName('title', [], 'fileTaskDisplayTitle'), false);
});

test('mapped title writes and clears preserve identity; unrelated replace writes preserve the title', () => {
	for (const [name, mappings] of [['title', DEFAULT_SETTINGS.keyMappings], ['label', mappingsFor('label')]] as const) {
		const frontmatter: Record<string, unknown> = { operonId: 'n000123', description: 'old-file', [name]: 'Before' };
		for (const mode of ['merge', 'replace'] as const) {
			applyYamlTaskFieldValues(frontmatter, { operonId: 'n000123', fileTaskDisplayTitle: 'Updated' }, mode, mappings);
			assert.equal(frontmatter[name], 'Updated');
			assert.equal(frontmatter.operonId, 'n000123');
			assert.equal(frontmatter.description, 'old-file');
		}
		applyYamlTaskFieldValues(frontmatter, { operonId: 'n000123', status: 'Task.Doing' }, 'replace', mappings);
		assert.equal(frontmatter[name], 'Updated');
		assert.equal(frontmatter.operonId, 'n000123');
		applyYamlTaskFieldValues(frontmatter, { operonId: 'n000123', fileTaskDisplayTitle: '' }, 'merge', mappings);
		assert.equal(Object.prototype.hasOwnProperty.call(frontmatter, name), false);
		assert.equal(frontmatter.operonId, 'n000123');
		assert.equal(frontmatter.description, 'old-file');
	}
});

test('mapped titles round-trip unsafe text through the scanner', async () => {
	for (const value of ['Rule: Non-title', '@leading', '*alias', '&anchor', '- item', 'true', '123', 'line one\nline two', 'C:\\path\\file']) {
		const draft = buildMergedFileTaskDraft({
			source: {
				description: 'old-file', fieldValues: { operonId: 'n000123', fileTaskDisplayTitle: value },
				frontmatterDocument: parseFrontmatterDocument('---\noperonId: n000123\n---\nbody', DEFAULT_SETTINGS.keyMappings),
			},
			defaults: { operonId: 'n000123', datetimeModified: '2026-10-25T02:00:00' }, keyMappings: DEFAULT_SETTINGS.keyMappings, bodyStrategy: 'preserve-source',
		});
		const app = { vault: { read: async () => draft.content } } as unknown as App;
		const scanned = (await scanFileWithMappings(app, file, DEFAULT_SETTINGS.keyMappings, draft.content)).yamlTask!;
		assert.equal(scanned.fieldValues.fileTaskDisplayTitle, value);
	}
	const draft = buildMergedFileTaskDraft({
		source: { description: 'old-file', fieldValues: {
			operonId: 'n000123', fileTaskDisplayTitle: 'Title: subtitle',
		} },
		defaults: { operonId: 'n000123', datetimeModified: '2026-10-25T02:00:00' }, keyMappings: DEFAULT_SETTINGS.keyMappings, bodyStrategy: 'preserve-source',
	});
	assert.match(draft.content, /title: "Title: subtitle"/u);
});
