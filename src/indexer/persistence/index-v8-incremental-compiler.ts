import type { IndexedTaskInstance, IndexData } from '../../types/fields';
import type { PersistedNativePropertySource } from '../native-property-persistence';
import {
	buildIndexV8Manifest,
	buildIndexV8Snapshot,
	deriveIndexV8InstanceKey,
	encodeIndexV8Shard,
	getIndexV8CanonicalInstanceKeys,
	IndexV8CodecError,
	projectIndexDataToV8Sources,
	projectIndexV8Source,
	validateIndexV8Manifest,
	type IndexV8SourceInput,
	type IndexV8SourceStat,
} from './index-v8-codec';
import type {
	IndexManifestV8,
	IndexShardDescriptorV8,
	IndexV8CoherenceBasis,
	IndexV8ShardId,
} from './index-v8-contract';
import {
	getAllIndexV8ShardIds,
	getIndexV8ShardId,
	normalizeIndexV8SourcePath,
} from './index-v8-partition';

export interface IndexV8DirtyBatch {
	sequence: number;
	dirtySourcePaths: ReadonlySet<string>;
	affectedOperonIds: ReadonlySet<string>;
	forceFull: boolean;
}

export interface IndexV8RamSourceIndexes {
	sourceInstanceKeys: ReadonlyMap<string, ReadonlySet<string>>;
	sourcePathsByShard: ReadonlyMap<IndexV8ShardId, ReadonlySet<string>>;
}

/** Minimal persisted-authority membership needed to close dirty duplicate sets. */
export interface IndexV8BaselineMembership {
	sourceOperonIds: ReadonlyMap<string, readonly string[]>;
	sourcePathsByOperonId: ReadonlyMap<string, string | readonly string[]>;
	canonicalSourceByOperonId: ReadonlyMap<string, string>;
}

export interface CompileIndexV8IncrementalInput {
	baseManifestPayload?: string;
	indexData: Readonly<IndexData>;
	sourceStats: ReadonlyMap<string, IndexV8SourceStat>;
	nativeSources?: ReadonlyMap<string, PersistedNativePropertySource>;
	sourceIndexes?: IndexV8RamSourceIndexes;
	baseMembership?: IndexV8BaselineMembership;
	dirtyBatch: IndexV8DirtyBatch;
	committedAt: string;
	lastFullScanAt: string;
	indexSemanticsSignature: string;
	coherenceBasis: IndexV8CoherenceBasis;
}

export interface IndexV8IncrementalCompileResult {
	status: 'changed' | 'unchanged';
	mode: 'full' | 'incremental';
	sequence: number;
	expectedBaseSnapshotId?: string;
	expectedBaseManifestPayload?: string;
	manifest: IndexManifestV8;
	manifestPayload: string;
	changedShardPayloads: Map<IndexV8ShardId, string>;
	dirtyShardIds: IndexV8ShardId[];
	shardsWritten: number;
	shardsReused: number;
	bytesWritten: number;
	baselineMembership: IndexV8BaselineMembership;
}

export type IndexV8IncrementalCompileErrorCode =
	| 'INVALID_DIRTY_BATCH'
	| 'SOURCE_INDEX_INCONSISTENT'
	| 'AUTHORITY_INCONSISTENT';

export class IndexV8IncrementalCompileError extends Error {
	constructor(
		public readonly code: IndexV8IncrementalCompileErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'IndexV8IncrementalCompileError';
	}
}

/** Build the two rebuildable persistence indexes without retaining a second task copy. */
export function buildIndexV8RamSourceIndexes(data: Readonly<IndexData>): IndexV8RamSourceIndexes {
	const sourceInstanceKeys = new Map<string, Set<string>>();
	for (const [instanceKey, instance] of iterateAuthorityInstances(data)) {
		const path = normalizeIndexV8SourcePath(instance.primary.filePath);
		const expectedKey = deriveIndexV8InstanceKey(path, instance.primary.lineNumber, instance.primary.format);
		if (instanceKey !== expectedKey) {
			throw new IndexV8IncrementalCompileError(
				'AUTHORITY_INCONSISTENT',
				'Task instance key does not match its normalized source location',
			);
		}
		const keys = sourceInstanceKeys.get(path) ?? new Set<string>();
		if (keys.has(instanceKey)) {
			throw new IndexV8IncrementalCompileError('AUTHORITY_INCONSISTENT', 'Duplicate task instance key');
		}
		keys.add(instanceKey);
		sourceInstanceKeys.set(path, keys);
	}
	const sourcePathsByShard = new Map<IndexV8ShardId, Set<string>>();
	for (const path of sourceInstanceKeys.keys()) {
		const shardId = getIndexV8ShardId(path);
		const paths = sourcePathsByShard.get(shardId) ?? new Set<string>();
		paths.add(path);
		sourcePathsByShard.set(shardId, paths);
	}
	return { sourceInstanceKeys, sourcePathsByShard };
}

/** Build only IDs and source membership; task payloads are never retained. */
export function buildIndexV8BaselineMembership(data: Readonly<IndexData>): IndexV8BaselineMembership {
	const sourceIdSets = new Map<string, Set<string>>();
	const idSourceSets = new Map<string, Set<string>>();
	for (const [, instance] of iterateAuthorityInstances(data)) {
		const path = normalizeIndexV8SourcePath(instance.primary.filePath);
		const sourceIds = sourceIdSets.get(path) ?? new Set<string>();
		sourceIds.add(instance.operonId);
		sourceIdSets.set(path, sourceIds);
		const idSources = idSourceSets.get(instance.operonId) ?? new Set<string>();
		idSources.add(path);
		idSourceSets.set(instance.operonId, idSources);
	}
	const sourceOperonIds = new Map(Array.from(sourceIdSets, ([path, ids]) => [path, [...ids].sort(compareText)]));
	const sourcePathsByOperonId = new Map(Array.from(idSourceSets, ([operonId, paths]) => {
		const sorted = [...paths].sort(compareText);
		return [operonId, sorted.length === 1 ? sorted[0] : sorted] as const;
	}));
	const canonicalSourceByOperonId = new Map<string, string>();
	for (const [operonId, task] of Object.entries(data.tasks)) {
		if ((idSourceSets.get(operonId)?.size ?? 0) < 2) continue;
		canonicalSourceByOperonId.set(operonId, normalizeIndexV8SourcePath(task.primary.filePath));
	}
	return { sourceOperonIds, sourcePathsByOperonId, canonicalSourceByOperonId };
}

export function collectIndexV8DirtyClosure(
	data: Readonly<IndexData>,
	indexes: IndexV8RamSourceIndexes,
	dirtyBatch: IndexV8DirtyBatch,
	baseMembership?: IndexV8BaselineMembership,
): { sourcePaths: Set<string>; shardIds: Set<IndexV8ShardId>; currentMembership: IndexV8BaselineMembership } {
	if (!Number.isSafeInteger(dirtyBatch.sequence) || dirtyBatch.sequence < 1) {
		throw new IndexV8IncrementalCompileError('INVALID_DIRTY_BATCH', 'Dirty sequence must be a positive safe integer');
	}
	const sourcePaths = new Set<string>();
	const normalizedDirtyPaths = new Set<string>();
	for (const path of dirtyBatch.dirtySourcePaths) {
		const normalized = normalizeIndexV8SourcePath(path);
		normalizedDirtyPaths.add(normalized);
		sourcePaths.add(normalized);
	}
	const currentMembership = buildIndexV8BaselineMembership(data);
	const affectedOperonIds = new Set(dirtyBatch.affectedOperonIds);
	for (const path of normalizedDirtyPaths) {
		for (const operonId of baseMembership?.sourceOperonIds.get(path) ?? []) affectedOperonIds.add(operonId);
		for (const operonId of currentMembership.sourceOperonIds.get(path) ?? []) affectedOperonIds.add(operonId);
	}
	for (const operonId of affectedOperonIds) {
		for (const path of getMembershipPaths(baseMembership?.sourcePathsByOperonId.get(operonId))) sourcePaths.add(path);
		for (const path of getMembershipPaths(currentMembership.sourcePathsByOperonId.get(operonId))) sourcePaths.add(path);
		const previousCanonical = baseMembership?.canonicalSourceByOperonId.get(operonId);
		if (previousCanonical) sourcePaths.add(previousCanonical);
		const currentCanonical = currentMembership.canonicalSourceByOperonId.get(operonId);
		if (currentCanonical) sourcePaths.add(currentCanonical);
	}
	const shardIds = new Set<IndexV8ShardId>();
	for (const path of sourcePaths) shardIds.add(getIndexV8ShardId(path));
	for (const shardId of shardIds) {
		for (const path of indexes.sourcePathsByShard.get(shardId) ?? []) sourcePaths.add(path);
	}
	return { sourcePaths, shardIds, currentMembership };
}

/**
 * Compile a full snapshot or only the affected shards against a previously validated manifest.
 * The caller must use full commit for `mode=full` and CAS incremental commit otherwise.
 */
export async function compileIndexV8Incremental(
	input: CompileIndexV8IncrementalInput,
): Promise<IndexV8IncrementalCompileResult> {
	let baseManifest: IndexManifestV8 | null = null;
	if (input.baseManifestPayload) baseManifest = await validateIndexV8Manifest(input.baseManifestPayload);
	const canonicalInstanceKeys = getIndexV8CanonicalInstanceKeys(input.indexData);
	assertAuthorityCanonicalContract(input.indexData, canonicalInstanceKeys);

	let indexes = input.sourceIndexes;
	let indexesTrusted = true;
	if (indexes) indexesTrusted = isSourceIndexShapeConsistent(input.indexData, indexes);
	if (!indexes || !indexesTrusted) indexes = buildIndexV8RamSourceIndexes(input.indexData);

	const forceFull = input.dirtyBatch.forceFull
		|| !baseManifest
		|| !input.baseMembership
		|| baseManifest.coherenceBasis !== 'verified-full-scan'
		|| input.coherenceBasis !== 'verified-full-scan'
		|| baseManifest.indexSemanticsSignature !== input.indexSemanticsSignature
		|| baseManifest.lastFullScanAt !== input.lastFullScanAt
		|| !indexesTrusted;
	if (forceFull) return await compileFull(input, baseManifest, canonicalInstanceKeys);
	if (!baseManifest) {
		throw new IndexV8IncrementalCompileError('SOURCE_INDEX_INCONSISTENT', 'Incremental compile requires a base manifest');
	}

	const closure = collectIndexV8DirtyClosure(input.indexData, indexes, input.dirtyBatch, input.baseMembership);
	const dirtyShardIds = [...closure.shardIds].sort(compareText);
	if (dirtyShardIds.length === 0) {
		return unchangedResult(input, baseManifest, 'incremental', [], closure.currentMembership);
	}
	const normalizedStats = normalizeSourceStats(input.sourceStats);
	assertSourceMetadata(indexes, normalizedStats, input.coherenceBasis);
	const persistedInstances = input.indexData.taskInstances;
	const fallbackInstances = persistedInstances && hasAnyOwnKey(persistedInstances)
		? null
		: new Map(iterateAuthorityInstances(input.indexData));
	const getAuthorityInstance = (instanceKey: string): IndexedTaskInstance | undefined => (
		persistedInstances?.[instanceKey] ?? fallbackInstances?.get(instanceKey)
	);
	const descriptors = baseManifest.shards.map(descriptor => ({ ...descriptor }));
	const changedShardPayloads = new Map<IndexV8ShardId, string>();
	for (const shardId of dirtyShardIds) {
		const records = Array.from(indexes.sourcePathsByShard.get(shardId) ?? [], path => {
			const source = buildSourceInput(path, indexes, getAuthorityInstance, normalizedStats);
			source.native = input.nativeSources?.get(path);
			return projectIndexV8Source(source, canonicalInstanceKeys);
		});
		const encoded = await encodeIndexV8Shard(shardId, records);
		const descriptorIndex = descriptors.findIndex(descriptor => descriptor.shardId === shardId);
		if (descriptorIndex < 0) throw new IndexV8IncrementalCompileError('SOURCE_INDEX_INCONSISTENT', 'Base descriptor is missing');
		if (!sameDescriptor(descriptors[descriptorIndex], encoded.descriptor)) {
			descriptors[descriptorIndex] = encoded.descriptor;
			changedShardPayloads.set(shardId, encoded.payload);
		}
	}
	const totals = countAuthority(indexes);
	const metadataChanged = baseManifest.lastFullScanAt !== input.lastFullScanAt
		|| baseManifest.coherenceBasis !== input.coherenceBasis
		|| baseManifest.indexSemanticsSignature !== input.indexSemanticsSignature
		|| baseManifest.totals.sourceCount !== totals.sourceCount
		|| baseManifest.totals.taskInstanceCount !== totals.taskInstanceCount;
	if (changedShardPayloads.size === 0 && !metadataChanged) {
		return unchangedResult(input, baseManifest, 'incremental', dirtyShardIds, closure.currentMembership);
	}
	const encodedManifest = await buildIndexV8Manifest({
		committedAt: input.committedAt,
		lastFullScanAt: input.lastFullScanAt,
		coherenceBasis: input.coherenceBasis,
		indexSemanticsSignature: input.indexSemanticsSignature,
		totals,
		descriptors,
	});
	return {
		status: 'changed',
		mode: 'incremental',
		sequence: input.dirtyBatch.sequence,
		expectedBaseSnapshotId: baseManifest.snapshotId,
		expectedBaseManifestPayload: input.baseManifestPayload,
		manifest: encodedManifest.manifest,
		manifestPayload: encodedManifest.manifestPayload,
		changedShardPayloads,
		dirtyShardIds,
		shardsWritten: changedShardPayloads.size,
		shardsReused: getAllIndexV8ShardIds().length - changedShardPayloads.size,
		bytesWritten: Array.from(changedShardPayloads, ([shardId, payload]) => (
			descriptors.find(descriptor => descriptor.shardId === shardId)?.bytes ?? new TextEncoder().encode(payload).length
		)).reduce((total, bytes) => total + bytes, 0),
		baselineMembership: closure.currentMembership,
	};
}

async function compileFull(
	input: CompileIndexV8IncrementalInput,
	baseManifest: IndexManifestV8 | null,
	canonicalInstanceKeys: ReadonlySet<string>,
): Promise<IndexV8IncrementalCompileResult> {
	const sources = projectIndexDataToV8Sources(input.indexData, input.sourceStats, input.nativeSources);
	if (input.coherenceBasis === 'verified-full-scan'
		&& sources.some(source => source.mtimeMs <= 0 || source.sizeBytes <= 0)) {
		throw new IndexV8CodecError('Verified full-scan source metadata is incomplete');
	}
	const snapshot = await buildIndexV8Snapshot({
		committedAt: input.committedAt,
		lastFullScanAt: input.lastFullScanAt,
		coherenceBasis: input.coherenceBasis,
		indexSemanticsSignature: input.indexSemanticsSignature,
		sources,
		canonicalInstanceKeys,
	});
	const changedShardPayloads = new Map(snapshot.shardPayloads);
	const baseDescriptors = baseManifest?.shards;
	const changedDescriptorCount = baseDescriptors
		? snapshot.manifest.shards.filter((descriptor, index) => !sameDescriptor(descriptor, baseDescriptors[index])).length
		: snapshot.manifest.shards.length;
	return {
		status: 'changed',
		mode: 'full',
		sequence: input.dirtyBatch.sequence,
		...(baseManifest ? {
			expectedBaseSnapshotId: baseManifest.snapshotId,
			expectedBaseManifestPayload: input.baseManifestPayload,
		} : {}),
		manifest: snapshot.manifest,
		manifestPayload: snapshot.manifestPayload,
		changedShardPayloads,
		dirtyShardIds: getAllIndexV8ShardIds(),
		shardsWritten: changedDescriptorCount,
		shardsReused: getAllIndexV8ShardIds().length - changedDescriptorCount,
		bytesWritten: snapshot.manifest.shards
			.filter((descriptor, index) => !baseManifest || !sameDescriptor(descriptor, baseManifest.shards[index]))
			.reduce((total, descriptor) => total + descriptor.bytes, 0),
		baselineMembership: buildIndexV8BaselineMembership(input.indexData),
	};
}

function unchangedResult(
	input: CompileIndexV8IncrementalInput,
	baseManifest: IndexManifestV8,
	mode: 'full' | 'incremental',
	dirtyShardIds: IndexV8ShardId[],
	baselineMembership: IndexV8BaselineMembership,
): IndexV8IncrementalCompileResult {
	return {
		status: 'unchanged',
		mode,
		sequence: input.dirtyBatch.sequence,
		expectedBaseSnapshotId: baseManifest.snapshotId,
		expectedBaseManifestPayload: input.baseManifestPayload,
		manifest: baseManifest,
		manifestPayload: input.baseManifestPayload!,
		changedShardPayloads: new Map(),
		dirtyShardIds,
		shardsWritten: 0,
		shardsReused: getAllIndexV8ShardIds().length,
		bytesWritten: 0,
		baselineMembership,
	};
}

function buildSourceInput(
	path: string,
	indexes: IndexV8RamSourceIndexes,
	getAuthorityInstance: (instanceKey: string) => IndexedTaskInstance | undefined,
	stats: ReadonlyMap<string, IndexV8SourceStat>,
): IndexV8SourceInput {
	const instances = Array.from(indexes.sourceInstanceKeys.get(path) ?? [], instanceKey => {
		const instance = getAuthorityInstance(instanceKey);
		if (!instance) throw new IndexV8IncrementalCompileError('SOURCE_INDEX_INCONSISTENT', 'Source index references a missing instance');
		return instance;
	});
	if (instances.length === 0) throw new IndexV8IncrementalCompileError('SOURCE_INDEX_INCONSISTENT', 'Source index contains an empty source');
	const stat = stats.get(path);
	return { path, mtimeMs: stat?.mtimeMs ?? 0, sizeBytes: stat?.sizeBytes ?? 0, instances };
}

function isSourceIndexShapeConsistent(data: Readonly<IndexData>, indexes: IndexV8RamSourceIndexes): boolean {
	try {
		const seenPaths = new Set<string>();
		const indexedInstanceKeys = new Set<string>();
		for (const [shardId, paths] of indexes.sourcePathsByShard) {
			if (!getAllIndexV8ShardIds().includes(shardId)) return false;
			for (const path of paths) {
				if (normalizeIndexV8SourcePath(path) !== path || getIndexV8ShardId(path) !== shardId || seenPaths.has(path)) return false;
				seenPaths.add(path);
			}
		}
		for (const [path, instanceKeys] of indexes.sourceInstanceKeys) {
			if (instanceKeys.size === 0 || !seenPaths.has(path)) return false;
			for (const instanceKey of instanceKeys) {
				if (indexedInstanceKeys.has(instanceKey)) return false;
				indexedInstanceKeys.add(instanceKey);
			}
		}
		if (seenPaths.size !== indexes.sourceInstanceKeys.size) return false;
		let authorityInstanceCount = 0;
		for (const [instanceKey, instance] of iterateAuthorityInstances(data)) {
			authorityInstanceCount++;
			const path = normalizeIndexV8SourcePath(instance.primary.filePath);
			if (!indexedInstanceKeys.has(instanceKey)
				|| !indexes.sourceInstanceKeys.get(path)?.has(instanceKey)) return false;
		}
		return indexedInstanceKeys.size === authorityInstanceCount;
	} catch {
		return false;
	}
}

function assertAuthorityCanonicalContract(data: Readonly<IndexData>, canonicalKeys: ReadonlySet<string>): void {
	const memberships = new Map<string, Set<string>>();
	for (const [instanceKey, instance] of iterateAuthorityInstances(data)) {
		const keys = memberships.get(instance.operonId) ?? new Set<string>();
		keys.add(instanceKey);
		memberships.set(instance.operonId, keys);
	}
	for (const [operonId, instanceKeys] of memberships) {
		const task = data.tasks[operonId];
		if (!task) throw new IndexV8IncrementalCompileError('AUTHORITY_INCONSISTENT', 'Canonical task is missing');
		const canonicalKey = deriveIndexV8InstanceKey(task.primary.filePath, task.primary.lineNumber, task.primary.format);
		if (!instanceKeys.has(canonicalKey)) {
			throw new IndexV8IncrementalCompileError('AUTHORITY_INCONSISTENT', 'Canonical task is not a member of its instance set');
		}
		if (instanceKeys.size > 1 && !canonicalKeys.has(canonicalKey)) {
			throw new IndexV8IncrementalCompileError('AUTHORITY_INCONSISTENT', 'Duplicate canonical marker is missing');
		}
	}
	if (Object.keys(data.tasks).length !== memberships.size) {
		throw new IndexV8IncrementalCompileError('AUTHORITY_INCONSISTENT', 'Canonical task and instance memberships differ');
	}
}

function assertSourceMetadata(
	indexes: IndexV8RamSourceIndexes,
	stats: ReadonlyMap<string, IndexV8SourceStat>,
	basis: IndexV8CoherenceBasis,
): void {
	if (basis !== 'verified-full-scan') return;
	for (const path of indexes.sourceInstanceKeys.keys()) {
		const stat = stats.get(path);
		if (!stat || !Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= 0
			|| !Number.isInteger(stat.sizeBytes) || stat.sizeBytes <= 0) {
			throw new IndexV8CodecError('Verified full-scan source metadata is incomplete');
		}
	}
}

function normalizeSourceStats(stats: ReadonlyMap<string, IndexV8SourceStat>): Map<string, IndexV8SourceStat> {
	const normalized = new Map<string, IndexV8SourceStat>();
	for (const [path, stat] of stats) normalized.set(normalizeIndexV8SourcePath(path), { ...stat });
	return normalized;
}

function countAuthority(indexes: IndexV8RamSourceIndexes): IndexManifestV8['totals'] {
	let taskInstanceCount = 0;
	for (const keys of indexes.sourceInstanceKeys.values()) taskInstanceCount += keys.size;
	return { sourceCount: indexes.sourceInstanceKeys.size, taskInstanceCount };
}

function* iterateAuthorityInstances(data: Readonly<IndexData>): IterableIterator<[string, IndexedTaskInstance]> {
	const persisted = Object.entries(data.taskInstances ?? {});
	if (persisted.length > 0) {
		yield* persisted;
		return;
	}
	for (const task of Object.values(data.tasks)) {
		const instanceKey = deriveIndexV8InstanceKey(task.primary.filePath, task.primary.lineNumber, task.primary.format);
		yield [instanceKey, { ...task, instanceKey }];
	}
}

function sameDescriptor(left: IndexShardDescriptorV8, right: IndexShardDescriptorV8 | undefined): boolean {
	return right !== undefined
		&& left.shardId === right.shardId
		&& left.path === right.path
		&& left.sha256 === right.sha256
		&& left.bytes === right.bytes
		&& left.sourceCount === right.sourceCount
		&& left.taskInstanceCount === right.taskInstanceCount;
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function hasAnyOwnKey(value: Readonly<Record<string, unknown>>): boolean {
	return Object.keys(value).length > 0;
}

function getMembershipPaths(value: string | readonly string[] | undefined): readonly string[] {
	if (value === undefined) return [];
	return typeof value === 'string' ? [value] : value;
}
