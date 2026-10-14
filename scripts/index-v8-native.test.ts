import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TFile, parseYaml, type App } from 'obsidian';
import { OperonIndexer } from '../src/indexer/indexer';
import { getNativePropertyIndex, captureNativePropertySource } from '../src/indexer/native-property-index';
import { persistNativePropertySource, restoreNativePropertySource, isPersistedNativePropertySource } from '../src/indexer/native-property-persistence';
import { IndexV8Store } from '../src/indexer/persistence/index-v8-store';
import { IndexV8PersistenceCoordinator } from '../src/indexer/persistence/index-v8-persistence-coordinator';
import { buildOperonStoragePaths } from '../src/storage/operon-storage-paths';
import { DEFAULT_SETTINGS } from '../src/types/settings';
import { IndexV8NodeAdapter } from './index-v8-node-adapter';
import { getTableNativePropertySnapshot } from '../src/ui/table/table-native-property';
import type { TableFilePropertySnapshot } from '../src/ui/table/table-file-property';
import { encodeIndexV8Shard, buildIndexV8Snapshot } from '../src/indexer/persistence/index-v8-codec';
import { getIndexV8ShardId } from '../src/indexer/persistence/index-v8-partition';
import { INDEX_V8_MAX_SHARD_BYTES, INDEX_V8_SHARD_COUNT } from '../src/indexer/persistence/index-v8-contract';
import { compareIndexV8Parity } from '../src/indexer/persistence/index-v8-parity';
import { createSyntheticIndexData, createV8SourcesFromIndexData } from './index-v8-fixtures';

test('native parity detects a value mismatch even when canonical projections agree', async () => {
	const data = createSyntheticIndexData(2), sources = createV8SourcesFromIndexData(data);
	const stamp = '2026-01-02T03:04:05.000Z';
	const stats = new Map(sources.map(source => [source.path, { mtimeMs: source.mtimeMs, sizeBytes: source.sizeBytes }]));
	const snapshot = await buildIndexV8Snapshot({ committedAt: stamp, lastFullScanAt: stamp,
		coherenceBasis: 'verified-full-scan', indexSemanticsSignature: 'native-parity-test', sources });
	const expected = new Map(sources.map(source => [source.path, { rescan: true as const }]));
	const valid = await compareIndexV8Parity(data, snapshot, Date.parse(stamp), stats, expected);
	assert.equal(valid.ok, true);
	const different = new Map<string, import('../src/indexer/native-property-persistence').PersistedNativePropertySource>(expected);
	different.set(sources[0].path, { file: [['Flag', false]], inline: [] });
	const result = await compareIndexV8Parity(data, snapshot, Date.parse(stamp), stats, different);
	assert.equal(result.ok, false);
	assert.deepEqual(result.mismatches.map(mismatch => mismatch.dimension), ['native-properties']);
});

test('native fragment roundtrip preserves source order, JSON values and immutability', () => {
	const raw = { frontmatter: { operonId: 'test001', False: false, Zero: 0, Empty: '', Nil: null,
		List: ['beta', 'alpha', 0, '0', 'alpha'], Nested: { b: [false, null], a: 1 } },
		order: ['operonId', 'False', 'Zero', 'Empty', 'Nil', 'List', 'Nested'],
		inline: [{ lineNumber: 7, operonId: 'test002', fields: [
			{ sourceKey: 'ID', key: 'operonId', value: 'test002', rawValue: 'test002' },
			{ sourceKey: 'Label', key: 'label', value: 'a b', rawValue: 'a\\ b' },
		] }] };
	const saved = persistNativePropertySource(raw);
	assert.ok(isPersistedNativePropertySource(saved));
	assert.deepEqual(restoreNativePropertySource(JSON.parse(JSON.stringify(saved))), raw);
	raw.frontmatter.List.push('later');
	assert.deepEqual(restoreNativePropertySource(saved)!.frontmatter!.List, ['beta', 'alpha', 0, '0', 'alpha']);
	assert.ok(Object.isFrozen(saved));
	assert.ok(!('Missing' in restoreNativePropertySource(saved)!.frontmatter!));
});

test('non-JSON sources require a real read and cannot silently become empty values', () => {
	const cycle: Record<string, unknown> = {}; cycle.self = cycle;
	for (const value of [undefined, NaN, Infinity, -0, new Date(), cycle, [1, undefined]]) {
		const persisted = persistNativePropertySource({ frontmatter: { Value: value }, order: ['Value'], inline: [] });
		assert.deepEqual(persisted, { rescan: true });
		assert.equal(restoreNativePropertySource(persisted), null);
	}
	for (const malformed of [{}, { rescan: false }, { rescan: true, file: null }, { file: [], inline: [[-1, 'x', []]] },
		{ file: [['pinned', true]], inline: [] }, { file: [['A', 1], ['A', 2]], inline: [] },
		{ file: null, inline: [[0, 'x', [['A', false]]]] }]) assert.equal(isPersistedNativePropertySource(malformed), false);
});

test('32 shards retain the exact decimal five-million-byte boundary', async () => {
	assert.equal(INDEX_V8_MAX_SHARD_BYTES, 5_000_000); assert.equal(INDEX_V8_SHARD_COUNT, 32);
	const source = { path: 'Boundary.md', mtimeMs: 1, sizeBytes: 1, native: { rescan: true as const },
		instances: [{ operonId: 'bound01', description: '', checkbox: 'open' as const, fieldValues: {}, tags: [],
			location: { lineNumber: 0, format: 'inline' as const }, datetimeModified: '' }] };
	const shard = getIndexV8ShardId(source.path), base = await encodeIndexV8Shard(shard, [source]);
	for (const bytes of [3_999_999, 4_000_000, 4_000_001, 4_500_000, 4_999_999, 5_000_000, 5_000_001]) {
		source.instances[0].description = 'x'.repeat(bytes - base.descriptor.bytes);
		if (bytes > INDEX_V8_MAX_SHARD_BYTES) await assert.rejects(encodeIndexV8Shard(shard, [source]), /5000000-byte contract limit/);
		else assert.equal((await encodeIndexV8Shard(shard, [source])).descriptor.bytes, bytes);
	}
});

const base: TableFilePropertySnapshot = { revision: 1, signature: 'test', fields: [],
	getCell: () => ({ present: false, rawValue: undefined, normalizedValue: '' }), getCandidates: () => [] };

async function fixture() {
	const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'operon-native-layout2-'));
	const configDir = '.test-config';
	const paths = buildOperonStoragePaths(configDir).runtime;
	await fs.mkdir(path.join(root, configDir), { recursive: true });
	await fs.writeFile(path.join(root, configDir, 'types.json'), JSON.stringify({ types: { Flag: 'checkbox', Count: 'number', Empty: 'text', Nil: 'text', Items: 'multitext' } }));
	await fs.writeFile(path.join(root, 'F.md'), '---\noperonId: file001\nFlag: false\nCount: 0\nEmpty: ""\nNil: null\nItems: [beta, alpha, 0, "0", alpha]\n---\nUntouched body.\n');
	await fs.writeFile(path.join(root, 'I.md'), '- [ ] Inline {{operonId:: line001}} {{Flag:: true}} {{Count:: 0}}\n');
	const legacy = `${configDir}/plugins/operon/runtime/index-v8/manifest.json`;
	await fs.mkdir(path.dirname(path.join(root, legacy)), { recursive: true });
	await fs.writeFile(path.join(root, legacy), 'legacy-sentinel');
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.keyMappings = settings.keyMappings.map(mapping => ({ ...mapping, visiblePropertyName: mapping.canonicalKey }));
	const runtimes: Array<{ indexer: OperonIndexer }> = [];
	async function start() {
		const adapter = new IndexV8NodeAdapter(root);
		const files = new Map<string, TFile>();
		for (const name of (await fs.readdir(root)).filter(name => name.endsWith('.md'))) {
			if (!await adapter.exists(name)) continue;
			const stat = (await adapter.stat(name))!;
			const file = new TFile(...([name] as unknown as []));
			Object.assign(file, { path: name, basename: name.slice(0, -3), extension: 'md', stat }); files.set(name, file);
		}
		let reads = 0, registryReads = 0;
		const original = adapter.read.bind(adapter);
		adapter.read = async name => { if (name.endsWith('types.json')) registryReads++; return original(name); };
		const app = { vault: { configDir, adapter, getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: (name: string) => files.get(name) ?? null,
			read: async (file: TFile) => { reads++; return adapter.read(file.path); } },
			metadataCache: { getFileCache: () => ({ listItems: [{ task: ' ' }] }) } } as unknown as App;
		const store = new IndexV8Store(adapter.asDataAdapter(), paths.indexV8);
		const coordinator = new IndexV8PersistenceCoordinator(store);
		const storage = { getSettings: () => settings,
			inspectIndexV8RecoveryRequired: async () => await adapter.exists(paths.indexV8RecoveryRequiredPath) ? 'required' : 'missing',
			markIndexV8RecoveryRequired: async () => { await fs.mkdir(path.dirname(path.join(root, paths.indexV8RecoveryRequiredPath)), { recursive: true }); await adapter.write(paths.indexV8RecoveryRequiredPath, '{"version":1,"required":true}'); },
			clearIndexV8RecoveryRequired: async () => { if (await adapter.exists(paths.indexV8RecoveryRequiredPath)) await adapter.remove(paths.indexV8RecoveryRequiredPath); } };
		const indexer = new OperonIndexer(app, storage as never, coordinator, store);
		const native = getNativePropertyIndex(app);
		const runtime = { app, adapter, files, indexer, native, store, reads: () => reads, registryReads: () => registryReads,
			async edit(name: string, content: string, preserveStat = false) {
				await adapter.write(name, content);
				if (!preserveStat) files.get(name)!.stat = (await adapter.stat(name))!;
			} };
		runtimes.push(runtime); return runtime;
	}
	return { root, paths, legacy, settings, start, async close() { for (const runtime of runtimes) runtime.indexer.destroy(); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const mode of ['initial persistence', 'missing-cache recovery', 'sealed repair']) {
	test(`empty inline identities cannot block ${mode} or cache reload`, async () => {
		const f = await fixture(); try {
			const first = await f.start();
			if (mode === 'sealed repair') await first.indexer.fullReindex();
			const note = (await first.adapter.read('I.md'))
				+ '- [ ] Empty {{operonId:: }} {{Flag:: false}}\n'
				+ '- [ ] Whitespace {{operonId::    }} {{Count:: 3}}\n'
				+ '- [ ] Plain checkbox {{Flag:: true}}\n';
			await first.edit('I.md', note);
			const legacyMarker = f.legacy.replace('index-v8/manifest.json', 'index-v8-recovery-required.json');
			await first.adapter.write(legacyMarker, 'legacy-recovery-sentinel');
			if (mode !== 'initial persistence') {
				await first.adapter.write(f.paths.indexV8RecoveryRequiredPath, '{"version":1,"required":true}');
				assert.equal((await first.indexer.loadCachedIndex()).status, 'missing');
			}
			if (mode === 'sealed repair') assert.equal((await first.indexer.repairIndexV8FromMarkdown()).status, 'applied');
			else await first.indexer.fullReindex();
			assert.equal(await first.adapter.exists(f.paths.indexV8RecoveryRequiredPath), false);
			assert.equal((await first.store.load()).status, 'loaded');
			assert.equal(await first.adapter.read('I.md'), note);
			first.indexer.destroy();

			const next = await f.start();
			next.adapter.write = async name => { assert.fail('Unexpected write: ' + name); };
			next.adapter.process = async name => { assert.fail('Unexpected process: ' + name); };
			assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
			await next.indexer.reconcileV8StartupSources();
			await next.native.ensure(next.indexer.getAllTasks());
			// Preserve existing canonical admission even for a nonempty whitespace identity.
			assert.deepEqual(next.indexer.getAllTasks().map(task => task.operonId).sort(), ['   ', 'file001', 'line001']);
			assert.equal(next.native.getTask(next.indexer.getTask('line001')!).properties.get('flag')?.value, true);
			assert.equal(next.native.getTask(next.indexer.getTask('line001')!).properties.get('count')?.value, 0);
			assert.equal(next.reads(), 0);
			assert.equal(await next.adapter.read(f.legacy), 'legacy-sentinel');
			assert.equal(await next.adapter.read(legacyMarker), 'legacy-recovery-sentinel');
		} finally { await f.close(); }
	});
}

test('clearing an inline identity updates both source projections and survives reload', async () => {
	const f = await fixture(); try {
		const first = await f.start();
		const original = await first.adapter.read('I.md');
		await first.edit('I.md', original + '- [ ] Second {{operonId:: line002}} {{Flag:: false}}\n');
		await first.indexer.fullReindex();
		const note = (await first.adapter.read('I.md')).replace('operonId:: line001', 'operonId:: ');
		await first.edit('I.md', note);
		await first.indexer.reindexFilePath('I.md'); await first.indexer.flushPendingPersist();
		assert.equal(await first.adapter.exists(f.paths.indexV8RecoveryRequiredPath), false);
		first.indexer.destroy();
		const next = await f.start();
		assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		await next.native.ensure(next.indexer.getAllTasks());
		assert.deepEqual(next.indexer.getAllTasks().map(task => task.operonId).sort(), ['file001', 'line002']);
		assert.equal(next.native.getTask(next.indexer.getTask('line002')!).properties.get('flag')?.value, false);
		assert.equal(next.reads(), 0);
		assert.equal(await next.adapter.read('I.md'), note);
	} finally { await f.close(); }
});

test('primary persistence reloads native values with zero source reads and preserves the legacy namespace', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex(); await first.native.ensure(first.indexer.getAllTasks());
		assert.equal(first.reads(), 2); first.indexer.destroy();
		const next = await f.start(); assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		assert.equal(next.native.isReady(next.indexer.getAllTasks()), true);
		const row = next.native.getTask(next.indexer.getTask('file001')!);
		assert.equal(row.available, true);
		for (const [name, value] of Object.entries({ flag: false, count: 0, empty: '', nil: null, items: ['beta', 'alpha', 0, '0', 'alpha'] })) assert.deepEqual(row.properties.get(name)?.value, value);
		assert.equal(row.properties.has('missing'), false);
		assert.ok(!getTableNativePropertySnapshot({}, next.app, base, next.indexer.getAllTasks(), 1, f.settings, () => assert.fail('unexpected loading')).loading);
		await next.native.ensure(next.indexer.getAllTasks()); assert.equal(next.reads(), 0); assert.equal(next.registryReads(), 1);
		assert.equal(await next.adapter.read(f.legacy), 'legacy-sentinel');
	} finally { await f.close(); }
});

test('mapping ownership changes regenerate retained fragments before the next durable snapshot', async () => {
	const f = await fixture(); try {
		f.settings.keyMappings.push({ canonicalKey: 'count', visiblePropertyName: 'Count', type: 'number', isSystem: false, enabled: true, sync: 'no' });
		const first = await f.start(); await first.indexer.fullReindex();
		f.settings.keyMappings = f.settings.keyMappings.filter(mapping => mapping.canonicalKey !== 'count');
		await first.indexer.fullReindex(); first.indexer.destroy();
		const next = await f.start(); assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		assert.equal(next.native.getTask(next.indexer.getTask('file001')!).properties.get('count')?.value, 0);
		assert.equal(next.native.getTask(next.indexer.getTask('line001')!).properties.get('count')?.value, 0);
		assert.equal(next.reads(), 0);
	} finally { await f.close(); }
});

test('hidden managed aliases remain available as conflict evidence after reload', async () => {
	const f = await fixture(); try {
		f.settings.keyMappings.push({ canonicalKey: 'count', visiblePropertyName: 'Count', type: 'number', isSystem: false, enabled: true, sync: 'no' });
		const first = await f.start();
		await first.edit('F.md', (await first.adapter.read('F.md')).replace('Count: 0', 'Count: 1\nCOUNT: 2'));
		await first.indexer.fullReindex(); await first.native.ensure(first.indexer.getAllTasks());
		const before = first.native.getTask(first.indexer.getTask('file001')!);
		first.indexer.destroy();
		const next = await f.start(); assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		assert.deepEqual(next.native.getTask(next.indexer.getTask('file001')!).properties.get('count'), before.properties.get('count'));
		assert.equal(next.reads(), 0);
	} finally { await f.close(); }
});

test('settings changed during a scan cannot relabel its native fragments with a different ownership filter', async () => {
	const f = await fixture(); try {
		const first = await f.start(), original = first.app.vault.read.bind(first.app.vault);
		const originalMappings = structuredClone(f.settings.keyMappings);
		first.app.vault.read = async file => {
			const result = await original(file);
			if (file.path === 'F.md') f.settings.keyMappings.push({ canonicalKey: 'count', visiblePropertyName: 'Count', type: 'number', isSystem: false, enabled: true, sync: 'no' });
			return result;
		};
		await first.indexer.fullReindex(); first.indexer.destroy();
		// The persisted generation belongs to the settings captured at scan start.
		f.settings.keyMappings = originalMappings;
		const next = await f.start(); assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		assert.equal(next.native.getTask(next.indexer.getTask('file001')!).properties.get('count')?.value, 0);
		assert.equal(next.reads(), 0);
	} finally { await f.close(); }
});

test('mapping changes while the type registry loads prevent publication of an obsolete cache', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex(); first.indexer.destroy();
		const next = await f.start(), read = next.adapter.read.bind(next.adapter);
		next.adapter.read = async name => {
			const value = await read(name);
			if (name.endsWith('types.json')) f.settings.keyMappings.push({ canonicalKey: 'count', visiblePropertyName: 'Count', type: 'number', isSystem: false, enabled: true, sync: 'no' });
			return value;
		};
		assert.equal((await next.indexer.loadCachedIndex()).status, 'incompatible');
		assert.equal(next.indexer.getAllTasks().length, 0);
		assert.equal(next.reads(), 0);
	} finally { await f.close(); }
});

test('a failed native commit retains the last manifest and the successfully edited source', async () => {
	for (const boundary of ['shard', 'manifest'] as const) {
		const f = await fixture(); try {
			const first = await f.start(); await first.indexer.fullReindex();
			const saved = await first.adapter.read(f.paths.indexV8.manifestPath);
			const note = (await first.adapter.read('I.md')).replace('Count:: 0', 'Count:: 8');
			await first.edit('I.md', note);
			const write = first.adapter.write.bind(first.adapter), process = first.adapter.process.bind(first.adapter);
			first.adapter.write = async (name, data) => { if (boundary === 'shard' && name.startsWith(f.paths.indexV8.shardsPath)) throw new Error('Injected shard failure'); return write(name, data); };
			first.adapter.process = async (name, fn) => { if (boundary === 'manifest' && name === f.paths.indexV8.manifestPath) throw new Error('Injected manifest failure'); return process(name, fn); };
			await first.indexer.reindexFilePath('I.md'); await first.indexer.flushPendingPersist();
			assert.equal(await first.adapter.read(f.paths.indexV8.manifestPath), saved);
			assert.equal(await first.adapter.read('I.md'), note);
			assert.equal(await first.adapter.read(f.legacy), 'legacy-sentinel');
			first.indexer.destroy();
			const next = await f.start(); await next.indexer.loadCachedIndex();
			await next.native.ensure(next.indexer.getAllTasks()); await next.indexer.flushPendingPersist();
			assert.equal(next.native.getTask(next.indexer.getTask('line001')!).properties.get('count')?.value, 8);
		} finally { await f.close(); }
	}
});

test('unchanged second boot performs no writes and preserves both recovery namespaces', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex(); first.indexer.destroy();
		const legacyMarker = f.legacy.replace('index-v8/manifest.json', 'index-v8-recovery-required.json');
		await first.adapter.write(legacyMarker, 'legacy-recovery-sentinel');
		const next = await f.start();
		next.adapter.write = async name => { assert.fail('Unexpected write: ' + name); };
		next.adapter.process = async name => { assert.fail('Unexpected process: ' + name); };
		assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		await next.indexer.reconcileV8StartupSources(); await next.native.ensure(next.indexer.getAllTasks());
		assert.equal(next.reads(), 0);
		assert.equal(await next.adapter.read(legacyMarker), 'legacy-recovery-sentinel');
	} finally { await f.close(); }
});

test('future layouts are rejected without overwriting the unknown manifest or legacy cache', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex(); first.indexer.destroy();
		const manifest = JSON.parse(await first.adapter.read(f.paths.indexV8.manifestPath)) as Record<string, unknown>;
		manifest.layoutVersion = 99;
		const future = JSON.stringify(manifest);
		await first.adapter.write(f.paths.indexV8.manifestPath, future);
		const next = await f.start(); assert.notEqual((await next.indexer.loadCachedIndex()).status, 'loaded');
		await next.indexer.fullReindex();
		assert.equal(await next.adapter.read(f.paths.indexV8.manifestPath), future);
		assert.equal(await next.adapter.read(f.legacy), 'legacy-sentinel');
		assert.equal(next.indexer.getAllTasks().length, 2);
	} finally { await f.close(); }
});

test('oversized native properties keep the last good snapshot and do not undo note edits', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex();
		const saved = await first.adapter.read(f.paths.indexV8.manifestPath);
		const note = '---\noperonId: file001\nHuge: ' + 'x'.repeat(5_000_001) + '\n---\nBody preserved.\n';
		await first.edit('F.md', note); await first.indexer.reindexFilePath('F.md'); await first.indexer.flushPendingPersist();
		assert.equal(await first.adapter.read(f.paths.indexV8.manifestPath), saved);
		assert.equal(await first.adapter.read('F.md'), note);
		assert.equal(await first.adapter.exists(f.paths.indexV8RecoveryRequiredPath), true);
		assert.equal(await first.adapter.read(f.legacy), 'legacy-sentinel');
	} finally { await f.close(); }
});

test('task identity replacement and duplicate resolution persist native source membership together', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex();
		const original = await first.adapter.read('I.md');
		await first.edit('I.md', original.replace('line001', 'file001'));
		await first.indexer.reindexFilePath('I.md'); await first.indexer.flushPendingPersist();
		assert.equal(first.indexer.getTask('line001'), undefined);
		assert.equal(first.native.getTask(first.indexer.getTask('file001')!).available, false);
		first.indexer.destroy();
		const duplicate = await f.start(); await duplicate.indexer.loadCachedIndex();
		assert.equal(duplicate.native.getTask(duplicate.indexer.getTask('file001')!).available, false);
		await duplicate.edit('I.md', original.replace('line001', 'line002').replace('Count:: 0', 'Count:: 4'));
		await duplicate.indexer.reindexFilePath('I.md'); await duplicate.indexer.flushPendingPersist(); duplicate.indexer.destroy();
		const resolved = await f.start(); await resolved.indexer.loadCachedIndex();
		assert.equal(resolved.indexer.getTask('line001'), undefined);
		assert.equal(resolved.native.getTask(resolved.indexer.getTask('file001')!).available, true);
		assert.equal(resolved.native.getTask(resolved.indexer.getTask('line002')!).properties.get('count')?.value, 4);
		assert.equal(resolved.reads(), 0);
	} finally { await f.close(); }
});

test('rename reconciliation removes the old native source and reloads the moved task without reads', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex(); first.indexer.destroy();
		await fs.rename(path.join(f.root, 'I.md'), path.join(f.root, 'Moved.md'));
		const next = await f.start(); await next.indexer.loadCachedIndex();
		await next.indexer.reconcileV8StartupSources(); await next.indexer.flushPendingPersist(); next.indexer.destroy();
		const reopened = await f.start(); assert.equal((await reopened.indexer.loadCachedIndex()).status, 'loaded');
		assert.equal(reopened.indexer.getTask('line001')!.primary.filePath, 'Moved.md');
		assert.equal(reopened.native.getTask(reopened.indexer.getTask('line001')!).properties.get('count')?.value, 0);
		assert.equal(reopened.reads(), 0);
	} finally { await f.close(); }
});

test('explicit rescan fragments reread only the exceptional source using the existing parser', async () => {
	const f = await fixture(); try {
		const first = await f.start(), persist = first.native.persistSource.bind(first.native);
		first.native.persistSource = raw => raw.frontmatter ? { rescan: true } : persist(raw);
		await first.indexer.fullReindex(); first.indexer.destroy();
		const next = await f.start(); assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		await next.native.ensure(next.indexer.getAllTasks());
		assert.equal(next.reads(), 1);
		assert.equal(next.native.getTask(next.indexer.getTask('file001')!).properties.get('flag')?.value, false);
		assert.equal(next.native.getTask(next.indexer.getTask('line001')!).properties.get('count')?.value, 0);
	} finally { await f.close(); }
});

test('native-only same-stat edits change the durable snapshot and survive reopening', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex();
		const before = await first.store.load(); assert.equal(before.status, 'loaded');
		await first.edit('I.md', (await first.adapter.read('I.md')).replace('Count:: 0', 'Count:: 9'), true);
		await first.indexer.reindexFilePath('I.md'); await first.indexer.flushPendingPersist();
		const after = await first.store.load(); assert.equal(after.status, 'loaded');
		if (before.status !== 'loaded' || after.status !== 'loaded') throw new Error('missing snapshot');
		assert.notEqual(before.manifest.snapshotId, after.manifest.snapshotId);
		assert.equal(after.manifest.shards.filter((shard, i) => shard.sha256 !== before.manifest.shards[i].sha256).length, 1);
		const stamp = first.files.get('I.md')!.stat; first.indexer.destroy();
		const next = await f.start(); next.files.get('I.md')!.stat = stamp;
		assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		assert.equal(next.native.getTask(next.indexer.getTask('line001')!).properties.get('count')?.value, 9);
		assert.equal(next.reads(), 0);
	} finally { await f.close(); }
});

test('cached source stamps cannot make a newer source look ready; concurrent consumers share reindex', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex(); first.indexer.destroy();
		const next = await f.start(); await next.edit('I.md', (await next.adapter.read('I.md')).replace('Count:: 0', 'Count:: 22'));
		assert.equal((await next.indexer.loadCachedIndex()).status, 'loaded');
		const task = next.indexer.getTask('line001')!;
		await Promise.all([next.native.ensure([task]), next.native.ensure([task])]);
		assert.equal(next.reads(), 1);
		assert.equal(next.native.getTask(next.indexer.getTask('line001')!).properties.get('count')?.value, 22);
		await next.indexer.flushPendingPersist();
	} finally { await f.close(); }
});

test('registry changes reinterpret cached raw data without source reads; deleted properties remain absent', async () => {
	const f = await fixture(); try {
		const first = await f.start(); await first.indexer.fullReindex(); first.indexer.destroy();
		const next = await f.start(); await next.indexer.loadCachedIndex();
		next.native.setTypes({ Flag: 'number', Count: 'text' });
		assert.equal(next.native.getTask(next.indexer.getTask('file001')!).properties.get('flag')?.reason, 'type-conflict');
		assert.equal(next.reads(), 0);
		await next.edit('F.md', (await next.adapter.read('F.md')).replace('Flag: false\n', ''));
		await next.indexer.reindexFilePath('F.md'); await next.indexer.flushPendingPersist(); next.indexer.destroy();
		const final = await f.start(); await final.indexer.loadCachedIndex();
		assert.equal(final.native.getTask(final.indexer.getTask('file001')!).properties.has('flag'), false);
	} finally { await f.close(); }
});

test('captured file fragments preserve unsupported objects without making them writable', () => {
	const raw = captureNativePropertySource('---\noperonId: file001\nObject: {nested: [1, false]}\n---\nbody', [], true);
	const restored = restoreNativePropertySource(persistNativePropertySource(raw));
	assert.deepEqual(restored?.frontmatter, parseYaml('operonId: file001\nObject: {nested: [1, false]}'));
});
