import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import ts from 'typescript';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Notice, TFile, type App } from 'obsidian';
import { getTaskDisplayTitle } from '../src/core/task-display-title';
import { isWritableRawYamlPropertyName } from '../src/core/raw-yaml-property';
import { applyYamlTaskFieldValues } from '../src/core/task-writer-yaml';
import { TaskWriter, type TaskWriterIndexerPort } from '../src/core/task-writer';
import { buildMergedFileTaskDraft, parseFrontmatterDocument, splitFrontmatterDocument } from '../src/core/file-task-template-merge';
import { resolveFileTaskDefaults } from '../src/core/file-task-defaults';
import { deriveTaskFilename, filenameSuggestionAfterTitleEdit, sanitizeTaskFilename } from '../src/core/filename-rule';
import { t } from '../src/core/i18n';
import { scanFileWithMappings } from '../src/indexer/file-scanner';
import type { IndexedTask } from '../src/types/fields';
import { DEFAULT_SETTINGS, buildKeyMappingVisiblePropertyNameUpdate, getMissingDefaultKeyMappingCollisions, isChildTaskInheritanceEligibleFieldKey, migrateSettings } from '../src/types/settings';
import { buildLivePropertyCatalogV1 } from '../src/agent-runtime/runtime/catalog-builder';
import { buildTaskPoolSearchText } from '../src/systems/task-pool-search';
import { rankTaskSearchResults } from '../src/systems/task-search';
import { getTableTaskRawValue } from '../src/ui/table/table-value-adapter';
import { createTableValueResolver } from '../src/ui/table/table-value-cache';
import { buildTableTaskSearchMatcher } from '../src/ui/table/table-search';
import { renderFileTaskRenameControls } from '../src/ui/file-task-rename-callout';

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

test('default kebab suggestions preserve Unicode and sanitize filenames', () => {
	for (const [title, expected] of [['Quarterly: Review!', 'quarterly-review'], ['日本語 計画 １２３', '日本語-計画-１２３'], ['خطة العمل ١٢٣', 'خطة-العمل-١٢٣']]) {
		assert.equal(deriveTaskFilename(title), expected);
	}
	assert.equal(sanitizeTaskFilename(' A:B/C\\D*E?F"G<H>I|J \n K '), 'ABCDEFGHIJ K');
});

test('Ask alone suggests a changed filename and retains a fallback for invalid rules', async () => {
	for (const [title, basename, mode, expected] of [
		['New task', 'old-name', 'keep', null],
		['New task', 'old-name', 'ask', { filename: 'new-task' }], ['New task', 'new-task', 'ask', null],
		['  \t ', 'old-name', 'ask', null],
	] as const) assert.deepEqual(await filenameSuggestionAfterTitleEdit(title, basename, mode), expected);
	const empty = await filenameSuggestionAfterTitleEdit('!!!', 'current-name', 'ask');
	assert.equal(empty?.filename, 'current-name');
	assert.match(empty?.error ?? '', /empty filename.*current-name/i);
});

function methods(filename: string, names: string[], dependencies: Record<string, unknown> = {}) {
	const source = readFileSync(filename, 'utf8'), ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
	const klass = ast.statements.find(node => ts.isClassDeclaration(node) && names.every(name => node.members.some(member => member.name?.getText(ast) === name))) as ts.ClassDeclaration;
	assert.ok(klass, `class containing ${names}`);
	const selected = names.map(name => klass.members.find(member => member.name?.getText(ast) === name)!.getText(ast)).join('\n');
	const code = ts.transpileModule(`class Fixture { ${selected} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	return new Function(...Object.keys(dependencies), `${code}; return Fixture;`)(...Object.values(dependencies));
}

const RenameHost = methods('main.ts', [
	'updateTableTaskFieldsAndRefresh', 'commitTableTaskFieldsAndRefresh', 'renameFileTaskFromTitle', 'handleFileTaskTitleChanged',
	'updateTableTaskDescriptionAndRefresh', 'commitTableTaskDescriptionAndRefresh', 'writeYamlTaskInstance',
], { TFile, buildMergedFileTaskDraft, filenameSuggestionAfterTitleEdit, parseFrontmatterDocument, splitFrontmatterDocument,
	resolveFileTaskDefaults, localNow: () => '2026-10-25T02:00:00', generateOperonId: () => 'n000999', t });

type TestScope = TestContext & {
	after(cleanup: () => void): void;
	mock: {
		timers: { enable(options: { apis: string[] }): void; tick(milliseconds: number): void };
		method(target: unknown, name: string, implementation: unknown): void;
	};
};

async function vaultFixture(_context: TestContext) {
	const currentFile = Object.assign(Object.create(TFile.prototype) as TFile, file, { stat: { ...file.stat } });
	let source = '---\noperonId: n000123\ntitle: Original title\nstatus: Task.Todo\n---\nBody content.';
	let current: IndexedTask = { ...task, fieldValues: { operonId: 'n000123', fileTaskDisplayTitle: 'Original title', status: 'Task.Todo' } };
	const settings = migrateSettings({ ...DEFAULT_SETTINGS, fileTaskDisplayTitleEnabled: true, fileTaskDisplayTitleChangeMode: 'ask' });
	const notices: string[] = [], destinations: string[] = [];
	const occupied = new Map<string, string>();
	const state = { ready: true, fullScanAt: '2026-10-26T00:00:00Z', settlement: Promise.resolve(), beforeRename: async () => {} };
	const app = { vault: {
		getAbstractFileByPath: (name: string) => name === currentFile.path ? currentFile : occupied.has(name) ? Object.create(TFile.prototype) : null,
		read: async () => source, cachedRead: async () => source,
		modify: async (_file: TFile, content: string) => { source = content; },
		process: async (_file: TFile, transform: (content: string) => string) => { source = transform(source); },
	}, fileManager: {
		processFrontMatter: async (_file: TFile, mutate: (value: Record<string, unknown>) => void) => {
			const document = splitFrontmatterDocument(source), value = parseYaml(document.frontmatter!);
			mutate(value);
			source = `---\n${stringifyYaml(value).trimEnd()}\n---\n${document.body}`;
		},
		renameFile: async (_file: TFile, destination: string) => {
			await state.beforeRename();
			destinations.push(destination);
			Object.assign(currentFile, { path: destination, name: destination, basename: destination.slice(0, -3) });
		},
	} } as unknown as App;
	const indexer = {
		getTask: () => current, getAllTasks: () => [current], hasDuplicateOperonIdConflict: () => false,
		isTaskSourceTransitionActive: () => false, isPathIndexable: () => true,
		reindexFilePath: async () => {}, reindexFilesBatch: async () => {}, scheduleReindex() {},
		reindexCommittedMutationSources: async () => {
			const scanned = (await scanFileWithMappings(app, currentFile, settings.keyMappings, source)).yamlTask!;
			assert.ok(scanned);
			current = { ...current, description: scanned.description, fieldValues: scanned.fieldValues, primary: { ...current.primary, filePath: currentFile.path } };
		},
	};
	const main = new RenameHost();
	Object.assign(main, { app, indexer, settings, writer: new TaskWriter(app, indexer as unknown as TaskWriterIndexerPort, settings.keyMappings),
		withTableMutationRefresh: (operation: () => Promise<unknown>) => operation(), sanitizeTaskFileName: sanitizeTaskFilename,
		markInternalTaskWrite() {}, getParentLinkExpectedFields: () => null, parentLinkSourceMatches: () => true,
		refreshViews() {}, scheduleProjectSerialIndexReconcile() {}, consumeTableMutationRefresh() {}, refreshAggregateTotalsAfterTaskMutation: async () => {},
	});
	return { app, file: currentFile, settings, state, main, indexer, notices, destinations, occupied,
		task: () => current, source: () => source, frontmatter: () => parseYaml(splitFrontmatterDocument(source).frontmatter!) as Record<string, unknown>,
	};
}

test('title persistence precedes Ask and explicit rename preserves source and task identity', async context => {
	const f = await vaultFixture(context);
	assert.equal(await f.main.updateTableTaskFieldsAndRefresh(task.operonId, { fileTaskDisplayTitle: 'Saved: title' }), true);
	assert.equal(f.frontmatter().title, 'Saved: title');
	assert.equal(f.frontmatter().description, undefined);
	assert.equal(f.file.path, 'old-file.md');
	assert.equal(f.task().description, 'old-file');
	assert.deepEqual(await f.main.handleFileTaskTitleChanged(task.operonId, 'Saved: title'), { filename: 'saved-title' });
	assert.deepEqual(f.destinations, []);
	const saved = f.source();
	await assert.rejects(f.main.renameFileTaskFromTitle(task.operonId, 'invalid/name'), { message: t('taskEditor', 'fileTaskRenameInvalid') });
	await f.main.renameFileTaskFromTitle(task.operonId, 'saved-title');
	assert.equal(f.source(), saved);
	assert.equal(f.task().operonId, task.operonId);
	assert.equal(f.task().description, 'saved-title');
	for (const mode of ['keep'] as const) {
		f.settings.fileTaskDisplayTitleChangeMode = mode;
		assert.equal(await f.main.handleFileTaskTitleChanged(task.operonId, 'Other title'), null);
	}
	assert.deepEqual(f.destinations, ['saved-title.md']);
});

test('disabled display titles retain filename editing and shared collision validation', async context => {
	const f = await vaultFixture(context);
	f.settings.fileTaskDisplayTitleEnabled = false;
	assert.equal(await f.main.handleFileTaskTitleChanged(task.operonId, 'No suggestion'), null);
	f.occupied.set('taken.md', 'Other file');
	assert.equal(await f.main.commitTableTaskDescriptionAndRefresh(f.task(), 'taken'), false);
	assert.equal(await f.main.commitTableTaskDescriptionAndRefresh(f.task(), 'legacy-rename'), true);
	assert.equal(f.file.path, 'legacy-rename.md');
	assert.equal(f.task().description, 'legacy-rename');
	assert.equal(f.frontmatter().title, 'Original title');
	assert.equal(f.task().operonId, task.operonId);
});

class Control {
	children: Control[] = [];
	parentElement: Control | null = null;
	textContent = '';
	value = '';
	disabled = false;
	validity = '';
	listeners = new Map<string, () => void>();
	constructor(readonly tag = 'div') {}
	createEl(tag: string, value?: string | { text?: string; value?: string }) {
		const child = new Control(tag);
		if (typeof value === 'object') { child.textContent = value.text ?? ''; child.value = value.value ?? ''; }
		child.parentElement = this; this.children.push(child); return child;
	}
	createDiv(value?: string | { text?: string }) { return this.createEl('div', value); }
	createSpan(value?: string | { text?: string }) { return this.createEl('span', value); }
	empty() { for (const child of this.children) child.parentElement = null; this.children = []; }
	addEventListener(name: string, action: () => void) { this.listeners.set(name, action); }
	click() { if (!this.disabled) this.listeners.get('click')?.(); }
	setAttribute() {}
	removeAttribute() {}
	toggleAttribute(_name: string, disabled: boolean) { this.disabled = disabled; }
	setCustomValidity(message: string) { this.validity = message; }
	reportValidity() { return !this.validity; }
	focus() {}
	select() {}
	find(tag: string, text?: string): Control {
		const all = this.children.flatMap(child => [child, ...child.descendants()]);
		const found = all.find(child => child.tag === tag && (text === undefined || child.textContent === text));
		assert.ok(found, `${tag} ${text ?? ''}`); return found;
	}
	descendants(): Control[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function renameControls(host: Control, filename: string, rename: (value: string) => Promise<void>, dismiss = () => host.empty()) {
	renderFileTaskRenameControls(host as unknown as HTMLElement, { filename }, { variant: 'editor-row', currentFilename: 'old-file.md', rename, dismiss });
	return { rename: host.find('button', t('taskEditor', 'fileTaskRenameAction')), keep: host.find('button', t('taskEditor', 'fileTaskKeep')) };
}

test('Keep preserves the saved title and repeated Rename commits an edited suggestion once', async context => {
	const f = await vaultFixture(context), host = new Control();
	await f.main.updateTableTaskFieldsAndRefresh(task.operonId, { fileTaskDisplayTitle: 'New name 123' });
	const rename = (name: string) => f.main.renameFileTaskFromTitle(task.operonId, name);
	renameControls(host, 'new-name-123', rename).keep.click();
	assert.deepEqual(f.destinations, []);
	assert.equal(f.frontmatter().title, 'New name 123');
	const actions = renameControls(host, 'new-name-123', rename);
	host.find('button', 'new-name-123').click();
	host.find('input').value = '01-new-name-123';
	actions.rename.click(); actions.rename.click(); await setImmediate();
	assert.deepEqual(f.destinations, ['01-new-name-123.md']);
	assert.equal(f.task().description, '01-new-name-123');
	assert.equal(f.frontmatter().title, 'New name 123');
	assert.equal(f.frontmatter().operonId, task.operonId);
	assert.equal(host.children.length, 0, 'successful Rename dismisses the controls');
});

test('failed rename retains the saved title and controls for correction', async context => {
	const f = await vaultFixture(context), host = new Control(), notices: string[] = [];
	const notice = Notice as unknown as { onNotice: ((message: string) => void) | null };
	const previous = notice.onNotice; notice.onNotice = message => notices.push(message);
	(context as TestScope).after(() => { notice.onNotice = previous; });
	await f.main.updateTableTaskFieldsAndRefresh(task.operonId, { fileTaskDisplayTitle: 'Saved before rename' });
	f.state.beforeRename = async () => { throw new Error('Rename failed'); };
	const actions = renameControls(host, 'saved-before-rename', name => f.main.renameFileTaskFromTitle(task.operonId, name));
	actions.rename.click(); await setImmediate();
	assert.deepEqual(notices, ['Rename failed']);
	assert.equal(actions.rename.disabled, false);
	assert.equal(f.file.path, 'old-file.md');
	assert.equal(f.frontmatter().title, 'Saved before rename');
	assert.equal(f.frontmatter().operonId, task.operonId);
	actions.keep.click(); assert.equal(host.children.length, 0);
});

test('completion and Keep from replaced controls cannot dismiss the current suggestion', async () => {
	const host = new Control(); let release!: () => void, dismissed = 0;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const old = renameControls(host, 'title-a', async () => gate, () => { dismissed++; });
	old.rename.click();
	renameControls(host, 'title-b', async () => {});
	release(); await setImmediate(); old.keep.click();
	assert.equal(dismissed, 0);
	assert.ok(host.find('button', 'title-b'));
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
