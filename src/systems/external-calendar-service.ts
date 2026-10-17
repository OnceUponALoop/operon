import { App, TFile, TFolder, type EventRef } from 'obsidian';
import { externalCalendarSourceAddress, externalCalendarSourceIdentity, isVaultCalendarPath } from '../core/external-calendar-source';
import { localNow, localToday } from '../core/local-time';
import {
	ExternalCalendarCacheStore,
	ExternalCalendarCachedEvent,
	ExternalCalendarSourceCache,
} from '../storage/external-calendar-cache';
import { ExternalCalendarSource } from '../types/settings';
import {
	fetchExternalCalendarIcs,
	parseExternalCalendarIcsEvents,
} from './external-calendar-ics';
import {
	isExternalCalendarCoverageExpanding,
	resolveExternalCalendarRequestedRange,
	shouldPersistExternalCalendarCacheUpdate,
	shouldRunExternalCalendarCoverageCheck,
	shouldSyncExternalCalendarSource,
} from './external-calendar-sync-policy';

const SYNC_RANGE_PAST_DAYS = 30;
const SYNC_RANGE_FUTURE_DAYS = 180;

export class ExternalCalendarService {
	private readonly cacheStore: ExternalCalendarCacheStore;
	private readonly onChange: () => void;
	private sources = new Map<string, ExternalCalendarSource>();
	private caches = new Map<string, ExternalCalendarSourceCache>();
	private syncPromises = new Map<string, Promise<void>>();
	private timers = new Map<string, number>();
	private requestedRangeStart = shiftDateKey(localToday(), -SYNC_RANGE_PAST_DAYS);
	private requestedRangeEnd = shiftDateKey(localToday(), SYNC_RANGE_FUTURE_DAYS);
	private lastCoverageCheckKey: string | null = null;
	private lastCoverageCheckAt = 0;
	private destroyed = false;
	private vaultReady = false;
	private settingsGeneration = 0;
	private revisions = new Map<string, number>();
	private localTimers = new Map<string, number>();
	private syncIdentities = new Map<string, string>();
	private queuedSyncs = new Map<string, { start: string; end: string; forceFetch?: boolean }>();
	private fullFetches = new Set<string>();
	private vaultEvents: EventRef[] = [];

	constructor(
		cacheStore: ExternalCalendarCacheStore,
		onChange: () => void,
		private readonly app?: App,
	) {
		this.cacheStore = cacheStore;
		this.onChange = onChange;
		app?.workspace.onLayoutReady(() => {
			if (this.destroyed) return;
			this.vaultReady = true;
			const changed = (file: TFile | TFolder, oldPath?: string): void => {
				for (const source of this.sources.values()) {
					if (source.sourceKind !== 'vault-file' || !source.enabled) continue;
					const path = source.filePath ?? '';
					const matches = (base: string): boolean => path === base || (file instanceof TFolder && path.startsWith(`${base}/`));
					if (!matches(file.path) && !(oldPath && matches(oldPath))) continue;
					this.revisions.set(source.id, (this.revisions.get(source.id) ?? 0) + 1);
					this.scheduleLocalSync(source.id, 500, true);
				}
			};
			this.vaultEvents = [
				app.vault.on('modify', file => { if (file instanceof TFile) changed(file); }),
				app.vault.on('create', file => { if (file instanceof TFile || file instanceof TFolder) changed(file); }),
				app.vault.on('delete', file => { if (file instanceof TFile || file instanceof TFolder) changed(file); }),
				app.vault.on('rename', (file, oldPath) => { if (file instanceof TFile || file instanceof TFolder) changed(file, oldPath); }),
			];
			for (const source of this.sources.values()) {
				if (source.sourceKind === 'vault-file' && this.isAutoSyncableSource(source)) {
					this.scheduleTimer(source.id);
					void this.syncSource(source.id, this.requestedRangeStart, this.requestedRangeEnd);
				}
			}
		});
		for (const source of cacheStore.getAllSources()) {
			this.caches.set(source.sourceId, source);
		}
	}

	async applySettings(sources: ExternalCalendarSource[]): Promise<void> {
		if (this.destroyed) return;
		const generation = ++this.settingsGeneration;
		const previous = this.sources;
		this.sources = new Map(sources.map(source => [source.id, { ...source }]));
		const retainedIds: string[] = [];
		for (const id of new Set([...previous.keys(), ...this.sources.keys(), ...this.caches.keys()])) {
			const before = previous.get(id), after = this.sources.get(id), cache = this.caches.get(id);
			const changed = !!before && !!after && externalCalendarSourceIdentity(before) !== externalCalendarSourceIdentity(after);
			const cacheMismatch = !!after && !!cache && (cache.sourceIdentity
				? cache.sourceIdentity !== externalCalendarSourceIdentity(after)
				: after.sourceKind === 'vault-file');
			if (!after || changed || cacheMismatch) this.caches.delete(id);
			else retainedIds.push(id);
			if (!after || changed || before?.enabled !== after.enabled) {
				this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
				this.clearLocalTimer(id);
				this.queuedSyncs.delete(id);
			}
		}
		await this.cacheStore.removeSourcesExcept(retainedIds);
		if (this.destroyed || generation !== this.settingsGeneration) return;
		for (const sourceId of Array.from(this.timers.keys())) {
			const source = this.sources.get(sourceId);
			if (!source || !this.isAutoSyncableSource(source)) {
				this.clearTimer(sourceId);
			}
		}
		for (const source of sources) {
			if (!this.isAutoSyncableSource(source)) continue;
			this.scheduleTimer(source.id);
			if ((source.sourceKind === 'vault-file' && previous.get(source.id)?.enabled !== true)
				|| (previous.has(source.id) && externalCalendarSourceIdentity(previous.get(source.id)!) !== externalCalendarSourceIdentity(source))
				|| this.shouldSyncSource(source.id, this.requestedRangeStart, this.requestedRangeEnd)) {
				void this.syncSource(source.id, this.requestedRangeStart, this.requestedRangeEnd);
			}
		}
	}

	/**
	 * Returns the shared cached event objects without cloning; callers treat
	 * them as read-only (they are wrapped into fresh CalendarItems downstream
	 * and replaced wholesale on the next sync). This runs on every calendar
	 * render, so per-event clones were pure allocation churn.
	 */
	getCachedEvents(rangeStart: string, rangeEnd: string): ExternalCalendarCachedEvent[] {
		if (this.destroyed) return [];
		this.ensureCoverage(rangeStart, rangeEnd);
		const events: ExternalCalendarCachedEvent[] = [];
		for (const source of this.sources.values()) {
			if (!this.isAutoSyncableSource(source)) continue;
			const cache = this.caches.get(source.id);
			if (!cache) continue;
			for (const event of cache.events) {
				if (event.startDate <= rangeEnd && event.endDate >= rangeStart) {
					events.push(event);
				}
			}
		}
		return events;
	}

	getSourceCache(sourceId: string): ExternalCalendarSourceCache | null {
		const found = this.caches.get(sourceId);
		return found
			? {
				...found,
				events: found.events.map(event => ({ ...event })),
			}
			: null;
	}

	async syncNow(sourceId: string): Promise<'synced' | 'skipped' | 'failed'> {
		if (this.destroyed) return 'skipped';
		const source = this.sources.get(sourceId);
		if (!source || !this.isAutoSyncableSource(source)) return 'skipped';
		const identity = externalCalendarSourceIdentity(source);
		await this.syncSource(sourceId, this.requestedRangeStart, this.requestedRangeEnd, true, true);
		const current = this.sources.get(sourceId);
		if (!current || !this.isAutoSyncableSource(current) || externalCalendarSourceIdentity(current) !== identity) return 'skipped';
		if (!this.destroyed && this.isAutoSyncableSource(source)) {
			this.scheduleTimer(sourceId);
		}
		if (this.destroyed) return 'skipped';
		return this.caches.get(sourceId)?.lastError ? 'failed' : 'synced';
	}

	async syncAllNow(): Promise<{ synced: number; skipped: number; failed: number }> {
		const results = await Promise.all(
			Array.from(this.sources.keys(), sourceId => this.syncNow(sourceId)),
		);
		return results.reduce(
			(summary, result) => {
				summary[result] += 1;
				return summary;
			},
			{ synced: 0, skipped: 0, failed: 0 },
		);
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
		for (const event of this.vaultEvents) this.app?.vault.offref(event);
		this.vaultEvents = [];
		for (const id of this.localTimers.keys()) this.clearLocalTimer(id);
		this.queuedSyncs.clear();
		for (const sourceId of Array.from(this.timers.keys())) {
			this.clearTimer(sourceId);
		}
		const pendingSyncs = Array.from(this.syncPromises.values());
		await Promise.allSettled(pendingSyncs);
		this.syncPromises.clear();
	}

	private ensureCoverage(rangeStart: string, rangeEnd: string): void {
		if (this.destroyed) return;
		const requestedKey = `${rangeStart}|${rangeEnd}`;
		if (!shouldRunExternalCalendarCoverageCheck({
			requestedKey,
			lastCheckedKey: this.lastCoverageCheckKey,
			lastCheckedAtMs: this.lastCoverageCheckAt,
			nowMs: Date.now(),
		})) {
			return;
		}
		this.lastCoverageCheckKey = requestedKey;
		this.lastCoverageCheckAt = Date.now();
		const nextRange = resolveExternalCalendarRequestedRange({
			currentStart: this.requestedRangeStart,
			currentEnd: this.requestedRangeEnd,
			neededStart: shiftDateKey(rangeStart, -SYNC_RANGE_PAST_DAYS),
			neededEnd: shiftDateKey(rangeEnd, SYNC_RANGE_FUTURE_DAYS),
		});
		this.requestedRangeStart = nextRange.start;
		this.requestedRangeEnd = nextRange.end;
		for (const source of this.sources.values()) {
			if (!this.isAutoSyncableSource(source)) continue;
			if (source.sourceKind === 'vault-file' && this.syncPromises.has(source.id) && isExternalCalendarCoverageExpanding(this.caches.get(source.id) ?? null, this.requestedRangeStart, this.requestedRangeEnd)) {
				this.queuedSyncs.set(source.id, { ...this.queuedSyncs.get(source.id), start: this.requestedRangeStart, end: this.requestedRangeEnd });
				continue;
			}
			if (!this.shouldSyncSource(source.id, this.requestedRangeStart, this.requestedRangeEnd)) continue;
			void this.syncSource(source.id, this.requestedRangeStart, this.requestedRangeEnd);
		}
	}

	private shouldSyncSource(sourceId: string, rangeStart: string, rangeEnd: string): boolean {
		if (this.destroyed) return false;
		if (this.syncPromises.has(sourceId)) return false;
		const source = this.sources.get(sourceId);
		if (!source || !this.isAutoSyncableSource(source)) return false;
		return shouldSyncExternalCalendarSource({
			cache: this.caches.get(sourceId) ?? null,
			refreshIntervalHours: source.refreshIntervalHours,
			rangeStart,
			rangeEnd,
			nowMs: Date.now(),
		});
	}

	private scheduleTimer(sourceId: string): void {
		if (this.destroyed) return;
		this.clearTimer(sourceId);
		const source = this.sources.get(sourceId);
		if (!source || !this.isAutoSyncableSource(source)) return;
		const delayMs = Math.max(1, Math.min(2147483647, Math.round(source.refreshIntervalHours * 3600000)));
		const timer = window.setTimeout(() => {
			this.timers.delete(sourceId);
			if (this.destroyed) return;
			void this.syncSource(sourceId, this.requestedRangeStart, this.requestedRangeEnd)
				.finally(() => {
					if (!this.destroyed) {
						this.scheduleTimer(sourceId);
					}
				});
		}, delayMs);
		this.timers.set(sourceId, timer);
	}

	private clearTimer(sourceId: string): void {
		const timer = this.timers.get(sourceId);
		if (typeof timer === 'number') {
			window.clearTimeout(timer);
		}
		this.timers.delete(sourceId);
	}

	private clearLocalTimer(sourceId: string): void {
		const timer = this.localTimers.get(sourceId);
		if (timer !== undefined) window.clearTimeout(timer);
		this.localTimers.delete(sourceId);
	}

	private scheduleLocalSync(sourceId: string, delay: number, allowRetry: boolean): void {
		this.clearLocalTimer(sourceId);
		this.localTimers.set(sourceId, window.setTimeout(() => {
			this.localTimers.delete(sourceId);
			void this.syncSource(sourceId, this.requestedRangeStart, this.requestedRangeEnd, allowRetry);
		}, delay));
	}

	private syncSource(sourceId: string, rangeStart: string, rangeEnd: string, allowRetry = true, forceFetch = false): Promise<void> {
		const source = this.sources.get(sourceId);
		if (this.destroyed || !source || !this.isAutoSyncableSource(source)) return Promise.resolve();
		const existing = this.syncPromises.get(sourceId);
		if (existing) {
			if (source.sourceKind === 'vault-file' || this.syncIdentities.get(sourceId) !== externalCalendarSourceIdentity(source)
				|| (forceFetch && !this.fullFetches.has(sourceId))) {
				this.queuedSyncs.set(sourceId, {
					start: rangeStart, end: rangeEnd,
					forceFetch: forceFetch || this.queuedSyncs.get(sourceId)?.forceFetch,
				});
			}
			return existing;
		}
		this.clearLocalTimer(sourceId);
		this.syncIdentities.set(sourceId, externalCalendarSourceIdentity(source));
		const run = (async () => {
			do {
				this.queuedSyncs.delete(sourceId);
				await this.syncSourceInternal(sourceId, rangeStart, rangeEnd, forceFetch);
				const queued = this.queuedSyncs.get(sourceId);
				if (queued) { rangeStart = queued.start; rangeEnd = queued.end; forceFetch = queued.forceFetch ?? false; }
			} while (!this.destroyed && this.queuedSyncs.has(sourceId));
		})().finally(() => {
			if (this.syncPromises.get(sourceId) !== run) return;
			this.syncPromises.delete(sourceId);
			this.syncIdentities.delete(sourceId);
			this.fullFetches.delete(sourceId);
			const current = this.sources.get(sourceId);
			if (!this.destroyed && allowRetry && current?.sourceKind === 'vault-file'
				&& this.isAutoSyncableSource(current) && this.caches.get(sourceId)?.lastError
				&& !this.localTimers.has(sourceId)) this.scheduleLocalSync(sourceId, 1000, false);
		});
		this.syncPromises.set(sourceId, run);
		return run;
	}

	private async syncSourceInternal(
		sourceId: string,
		rangeStart: string,
		rangeEnd: string,
		forceFetch: boolean,
	): Promise<void> {
		if (this.destroyed) return;
		const source = this.sources.get(sourceId);
		if (!source) return;
		if (!this.isAutoSyncableSource(source)) return;
		const revision = this.revisions.get(sourceId) ?? 0;
		const identity = externalCalendarSourceIdentity(source);
		const isCurrent = (): boolean => !this.destroyed && this.sources.get(sourceId)?.enabled === true
			&& (this.revisions.get(sourceId) ?? 0) === revision
			&& externalCalendarSourceIdentity(this.sources.get(sourceId)!) === identity;
		const cache = this.caches.get(sourceId) ?? {
			sourceId,
			syncedAt: null,
			lastAttemptAt: null,
			etag: null,
			lastModified: null,
			coveredRangeStart: null,
			coveredRangeEnd: null,
			lastError: null,
			events: [],
		};
		const attemptAt = localNow();
		try {
			// A 304 keeps the previously parsed events, which only cover the old
			// range; validators are safe only while the requested range stays
			// inside the covered range.
			const canUseCacheValidators = !isExternalCalendarCoverageExpanding(cache, rangeStart, rangeEnd);
			const requestCache = !forceFetch && canUseCacheValidators ? cache : null;
			const fullFetch = !requestCache?.etag && !requestCache?.lastModified;
			if (fullFetch) this.fullFetches.add(sourceId);
			else this.fullFetches.delete(sourceId);
			const response = source.sourceKind === 'vault-file'
				? await this.readVaultCalendar(source)
				: await fetchExternalCalendarIcs(source.url, requestCache);
			if (!isCurrent()) return;
			if (response.status === 'notModified') {
				if (fullFetch) throw new Error('Unexpected HTTP 304 for a full calendar refresh');
				// The feed body is unchanged, so previously covered coverage is
				// still valid; keep the union with the requested range.
				const nextCache: ExternalCalendarSourceCache = {
					...cache,
					sourceIdentity: identity,
					lastAttemptAt: attemptAt,
					syncedAt: attemptAt,
					etag: response.etag ?? cache.etag,
					lastModified: response.lastModified ?? cache.lastModified,
					coveredRangeStart: cache.coveredRangeStart && cache.coveredRangeStart < rangeStart
						? cache.coveredRangeStart
						: rangeStart,
					coveredRangeEnd: cache.coveredRangeEnd && cache.coveredRangeEnd > rangeEnd
						? cache.coveredRangeEnd
						: rangeEnd,
					lastError: null,
				};
				await this.commitSourceCache(sourceId, cache, nextCache, isCurrent);
				return;
			}
			const events = parseExternalCalendarIcsEvents({
				sourceId,
				url: source.url,
				requireCalendar: source.sourceKind === 'vault-file',
				body: response.body ?? '',
				rangeStart,
				rangeEnd,
			});
			const nextCache: ExternalCalendarSourceCache = {
				sourceId,
				sourceIdentity: identity,
				syncedAt: attemptAt,
				lastAttemptAt: attemptAt,
				etag: response.etag,
				lastModified: response.lastModified,
				coveredRangeStart: rangeStart,
				coveredRangeEnd: rangeEnd,
				lastError: null,
				events,
			};
			await this.commitSourceCache(sourceId, cache, nextCache, isCurrent);
		} catch (error) {
			if (!isCurrent()) return;
			const message = error instanceof Error ? error.message : String(error);
			const nextCache: ExternalCalendarSourceCache = {
				...cache,
				sourceIdentity: identity,
				lastAttemptAt: attemptAt,
				lastError: message,
			};
			await this.commitSourceCache(sourceId, cache, nextCache, isCurrent);
		}
	}

	private async commitSourceCache(
		sourceId: string,
		previousCache: ExternalCalendarSourceCache,
		nextCache: ExternalCalendarSourceCache,
		isCurrent: () => boolean,
	): Promise<void> {
		if (!isCurrent()) return;
		const renderedEventsChanged = !areExternalCalendarEventListsEqual(previousCache.events, nextCache.events);
		this.caches.set(sourceId, nextCache);
		// Bookkeeping-only updates (syncedAt / lastAttemptAt) live in memory;
		// rewriting the whole multi-source cache file for them cost a disk
		// write per refresh interval and per failed attempt.
		if (previousCache.sourceIdentity !== nextCache.sourceIdentity || shouldPersistExternalCalendarCacheUpdate(previousCache, nextCache, renderedEventsChanged)) {
			await this.cacheStore.upsertSource(nextCache);
			if (this.destroyed) return;
		}
		if (isCurrent() && (renderedEventsChanged || previousCache.lastError !== nextCache.lastError)) this.onChange();
	}

	private async readVaultCalendar(source: ExternalCalendarSource) {
		const path = source.filePath ?? '';
		if (!this.app || !isVaultCalendarPath(path, this.app.vault.configDir)) throw new Error('Invalid vault ICS path');
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error('Vault ICS file not found');
		const body = await this.app.vault.read(file);
		return { status: 'success' as const, body, etag: null, lastModified: null };
	}

	private isAutoSyncableSource(source: ExternalCalendarSource): boolean {
		return source.enabled && externalCalendarSourceAddress(source).trim().length > 0
			&& (source.sourceKind !== 'vault-file' || this.vaultReady);
	}
}

function areExternalCalendarEventListsEqual(
	left: ExternalCalendarCachedEvent[],
	right: ExternalCalendarCachedEvent[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (!areExternalCalendarEventsEqual(left[index], right[index])) return false;
	}
	return true;
}

function areExternalCalendarEventsEqual(
	left: ExternalCalendarCachedEvent,
	right: ExternalCalendarCachedEvent,
): boolean {
	return left.id === right.id
		&& left.sourceId === right.sourceId
		&& left.uid === right.uid
		&& left.recurrenceId === right.recurrenceId
		&& left.title === right.title
		&& left.isAllDay === right.isAllDay
		&& left.startDate === right.startDate
		&& left.endDate === right.endDate
		&& left.startDateTime === right.startDateTime
		&& left.endDateTime === right.endDateTime;
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
	const [year, month, day] = dateKey.split('-').map(Number);
	const date = new Date(year, month - 1, day, 12, 0, 0, 0);
	date.setDate(date.getDate() + deltaDays);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
