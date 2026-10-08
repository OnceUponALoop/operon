import { buildCustomFieldUsageSummaries } from '../src/core/managed-task-fields';
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTaskEditorSections, TASK_EDITOR_SECTION_IDS } from '../src/types/task-editor-sections';
import { DEFAULT_SETTINGS, migrateSettings } from '../src/types/settings';
import { buildOperonDataPackageFromSettings, composeOperonSettingsFromDataPackage } from '../src/storage/operon-data-package';
import { OPERON_SETTINGS_SEARCH_REGISTRY } from '../src/ui/settings/settings-search-registry';
import { SETTINGS_BACKUP_COMPATIBILITY_BY_KEY } from '../src/core/settings-backup-compatibility';

test('missing and malformed layouts preserve all default section identities', () => {
 for (const raw of [undefined, null, false, {}, 'notes']) {
  assert.deepEqual(normalizeTaskEditorSections(raw).map(item => item.id), [...TASK_EDITOR_SECTION_IDS]);
 }
 const input = [{ id: 'sessions', name: ' Work\n logs ' }, { id: 'sessions', name: 'Duplicate' }, { id: 'unknown', name: 'Wrong' }, null];
 const result = normalizeTaskEditorSections(input);
 assert.equal(result.length, TASK_EDITOR_SECTION_IDS.length);
 assert.deepEqual(result[0], { id: 'sessions', name: 'Work  logs' });
 assert.equal(result[1].id, 'description');
 assert.deepEqual(normalizeTaskEditorSections(result), result);
 assert.equal(input[0]?.name, ' Work\n logs ');
});

test('blank names fall back and long names are bounded without changing identity', () => {
 assert.equal(normalizeTaskEditorSections([{ id: 'notes', name: '   ' }])[0].name, '');
 assert.equal(normalizeTaskEditorSections([{ id: 'notes', name: 'a'.repeat(200) }])[0].name.length, 80);
});

test('section order and names survive canonical package save and reload', () => {
 const taskEditorSections = normalizeTaskEditorSections([{ id: 'sessions', name: 'Work log' }, { id: 'description', name: 'Summary' }]);
 const settings = migrateSettings({ ...DEFAULT_SETTINGS, taskEditorSections });
 const stored = buildOperonDataPackageFromSettings(settings);
 const restored = composeOperonSettingsFromDataPackage(stored, DEFAULT_SETTINGS);
 assert.deepEqual(restored.taskEditorSections, taskEditorSections);
 assert.deepEqual(restored.taskEditorMobileCoreTools, DEFAULT_SETTINGS.taskEditorMobileCoreTools);
 assert.deepEqual(restored.taskEditorWorkflowPickers, DEFAULT_SETTINGS.taskEditorWorkflowPickers);
 assert.deepEqual(buildOperonDataPackageFromSettings(restored).ui.taskUiPreferences, stored.ui.taskUiPreferences);
});

test('sections are discoverable by Settings Search and belong to backup preferences', () => {
 assert.equal(OPERON_SETTINGS_SEARCH_REGISTRY.find(entry => entry.key === 'taskEditorSections')?.tabId, 'interfaceTaskEditor');
 assert.ok(SETTINGS_BACKUP_COMPATIBILITY_BY_KEY.taskEditorSections);
});

test('property visibility search is owned by Mobile Task Editor', () => {
 assert.equal(OPERON_SETTINGS_SEARCH_REGISTRY.find(entry => entry.id === 'ui.taskEditorWorkflowPickers')?.tabId, 'mobileTaskEditor');
});

test('custom usage includes desktop even when both mobile surfaces hide the property', () => {
 const summaries = buildCustomFieldUsageSummaries({
  keyMappings: [{ canonicalKey: 'customExample', visiblePropertyName: 'Example', type: 'text', isSystem: false, showInEditor: true, sync: 'no', enabled: true }],
  filterSets: [], kanbanPresets: [], tasks: null,
  surfaces: { taskEditorWorkflowPickers: [{ key: 'customExample', visible: false }], taskEditorMobileCoreTools: [{ key: 'customExample', visible: false }] },
 });
 assert.ok(summaries[0].activeSurfaceKeys.includes('editor'));
});
