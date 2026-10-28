import type { ImageContent, SessionEntry, TextContent } from "@oh-my-pi/pi-wire";
import { API_CACHE_NAME } from "./api-cache";
import { IndexedDbOfflineCacheAdapter } from "./idb";
import { offlineCacheEnabled } from "./preference";
import type {
	CacheBudgetEnvironment,
	OfflineCacheAdapter,
	OfflineCacheMetadata,
	OfflineCacheStats,
	OfflineCachedTranscript,
	OfflineSessionStatus,
	OfflineTranscriptCommit,
} from "./types";
import { OFFLINE_CACHE_LIVE_GRACE_MS, OFFLINE_CACHE_TTL_MS, OFFLINE_IMAGE_MAX_BYTES, OFFLINE_SESSION_MAX_BYTES } from "./types";

const MIB = 1024 * 1024;
const PHONE_BUDGET_BYTES = 150 * MIB;
const DESKTOP_BUDGET_BYTES = 300 * MIB;
const WRITE_DEBOUNCE_MS = 2_000;
const IMAGE_PLACEHOLDER: TextContent = { type: "text", text: "[image not cached: exceeds 256 KiB]" };

function browserEnvironment(): CacheBudgetEnvironment {
	return {
		now: () => Date.now(),
		async estimateQuota() {
			try {
				const estimate = await globalThis.navigator?.storage?.estimate();
				return estimate?.quota ?? null;
			} catch {
				return null;
			}
		},
		touchDevice() {
			try {
				return (globalThis.navigator?.maxTouchPoints ?? 0) > 0 || globalThis.matchMedia?.("(pointer: coarse)").matches === true;
			} catch {
				return false;
			}
		},
	};
}

function imageBytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function safeImageBlocks(blocks: (ImageContent | TextContent)[]): (ImageContent | TextContent)[] {
	let changed = false;
	const safe = blocks.map(block => {
		if (block.type !== "image" || imageBytes(block.data) <= OFFLINE_IMAGE_MAX_BYTES) return block;
		changed = true;
		return IMAGE_PLACEHOLDER;
	});
	return changed ? safe : blocks;
}

export function cacheSafeEntry(entry: SessionEntry): SessionEntry {
	if (entry.type === "message" && entry.message.role !== "assistant" && Array.isArray(entry.message.content)) {
		const content = safeImageBlocks(entry.message.content);
		return content === entry.message.content ? entry : { ...entry, message: { ...entry.message, content } };
	}
	if (entry.type === "custom_message" && Array.isArray(entry.content)) {
		const content = safeImageBlocks(entry.content);
		return content === entry.content ? entry : { ...entry, content };
	}
	return entry;
}

export function serializedEntryBytes(entry: SessionEntry): number {
	return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
}

function makeMetadata(
	key: string,
	commit: OfflineTranscriptCommit,
	entryCount: number,
	tailEntryId: string | null,
	bytes: number,
	partial: boolean,
	now: number,
	pruned: boolean,
	existing: OfflineCacheMetadata | null,
): OfflineCacheMetadata {
	// Archive and waiting/unfinished status come from the session list (updateSessionStatuses); the client's guesses
	// must not overwrite them, or eviction would rank an archived session as active until the next list poll.
	const status = existing ?? commit;
	return {
		key,
		title: commit.title,
		cwd: commit.cwd,
		replicaToken: commit.replicaToken,
		entryCount,
		tailEntryId,
		leafId: commit.leafId,
		lastViewedAt: now,
		lastEntryAt: commit.lastEntryAt,
		bytes,
		partial,
		pruned,
		archivedAt: status.archivedAt,
		live: commit.live,
		waitingOnYou: status.waitingOnYou,
		unfinished: status.unfinished,
	};
}


function retainNewest(
	entries: readonly SessionEntry[],
	limit: number,
): { entries: SessionEntry[]; bytes: number; partial: boolean; pruned: boolean } {
	const safe = entries.map(cacheSafeEntry);
	const sizes = safe.map(serializedEntryBytes);
	let start = safe.length;
	let bytes = 0;
	while (start > 0 && bytes + sizes[start - 1]! <= limit) {
		start--;
		bytes += sizes[start]!;
	}
	const pruned = safe.some((entry, index) => index >= start && entry !== entries[index]);
	return { entries: safe.slice(start), bytes, partial: start > 0, pruned };
}

function evictionPriority(record: OfflineCacheMetadata): number {
	if (record.archivedAt !== null) return 0;
	return !record.live && !record.waitingOnYou && !record.unfinished ? 1 : 2;
}

function compareEvictionOrder(a: OfflineCacheMetadata, b: OfflineCacheMetadata): number {
	const priorityDifference = evictionPriority(a) - evictionPriority(b);
	if (priorityDifference !== 0) return priorityDifference;
	const aScore = a.lastViewedAt + (a.live || a.waitingOnYou || a.unfinished ? OFFLINE_CACHE_LIVE_GRACE_MS : 0);
	const bScore = b.lastViewedAt + (b.live || b.waitingOnYou || b.unfinished ? OFFLINE_CACHE_LIVE_GRACE_MS : 0);
	return aScore - bScore || a.lastViewedAt - b.lastViewedAt;
}

export function chooseEvictions(metadata: readonly OfflineCacheMetadata[], budgetBytes: number, pinned: ReadonlySet<string>): string[] {
	let bytes = metadata.reduce((sum, record) => sum + record.bytes, 0);
	const candidates = metadata
		.filter(record => !pinned.has(record.key))
		.sort(compareEvictionOrder);
	const evicted: string[] = [];
	for (const candidate of candidates) {
		if (bytes <= budgetBytes) break;
		evicted.push(candidate.key);
		bytes -= candidate.bytes;
	}
	return evicted;
}

function isQuotaExceeded(error: unknown): boolean {
	return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "QuotaExceededError";
}

export class OfflineTranscriptCache {
	readonly #adapter: OfflineCacheAdapter;
	readonly #environment: CacheBudgetEnvironment;
	readonly #listeners = new Set<() => void>();
	readonly #timers = new Map<string, Timer>();
	readonly #writes = new Map<string, Promise<void>>();
	#clearing = false;
	#pinned = new Set<string>();
	readonly #pinnedByOwner = new Map<string, Set<string>>();
	#startup: Promise<void> | null = null;
	#persistRequested = false;

	constructor(adapter: OfflineCacheAdapter = new IndexedDbOfflineCacheAdapter(), environment: CacheBudgetEnvironment = browserEnvironment()) {
		this.#adapter = adapter;
		this.#environment = environment;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setPinnedKeys(keys: Iterable<string>, owner = "default"): void {
		this.#pinnedByOwner.set(owner, new Set(keys));
		this.#pinned.clear();
		for (const group of this.#pinnedByOwner.values()) {
			for (const key of group) this.#pinned.add(key);
		}
	}

	async initialize(): Promise<void> {
		if (this.#startup) return this.#startup;
		this.#requestPersistentStorage();
		this.#startup = this.#evict().catch(() => {});
		return this.#startup;
	}

	async load(key: string): Promise<OfflineCachedTranscript | null> {
		if (!offlineCacheEnabled() || key.startsWith("link:") || this.#clearing) return null;
		try {
			await this.initialize();
			const record = await this.#adapter.get(key);
			if (!record) return null;
			const now = this.#environment.now();
			if (now - record.metadata.lastViewedAt > OFFLINE_CACHE_TTL_MS) {
				await this.#adapter.delete(key);
				this.#notify();
				return null;
			}
			const metadata = { ...record.metadata, lastViewedAt: now };
			await this.#adapter.updateMetadata(metadata);
			this.#notify();
			return { ...record, metadata };
		} catch {
			return null;
		}
	}

	scheduleWrite(key: string, commit: OfflineTranscriptCommit): void {
		if (!offlineCacheEnabled() || key.startsWith("link:") || this.#clearing) return;
		const prior = this.#timers.get(key);
		if (prior !== undefined) clearTimeout(prior);
		this.#timers.set(key, setTimeout(() => {
			this.#timers.delete(key);
			void this.write(key, commit);
		}, WRITE_DEBOUNCE_MS));
	}

	async write(key: string, commit: OfflineTranscriptCommit): Promise<void> {
		if (!offlineCacheEnabled() || key.startsWith("link:") || this.#clearing) return;
		const timer = this.#timers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(key);
		}
		const previous = this.#writes.get(key) ?? Promise.resolve();
		const pending = previous.then(() => this.#write(key, commit));
		this.#writes.set(key, pending);
		try {
			await pending;
		} finally {
			if (this.#writes.get(key) === pending) this.#writes.delete(key);
		}
	}

	async #write(key: string, commit: OfflineTranscriptCommit): Promise<void> {
		// Queued writes re-check: turning the cache off or clearing it stops writes already waiting in the queue.
		if (!offlineCacheEnabled() || this.#clearing) return;
		try {
			await this.initialize();
			const now = this.#environment.now();
			const existing = await this.#adapter.getMetadata(key);
			const appended = existing === null ? [] : commit.entries.slice(existing.entryCount);
			const continuesCurrentBranch =
				existing !== null &&
				(appended.length === 0 ? existing.leafId === commit.leafId : appended[0]!.parentId === existing.leafId);
			const canAppend =
				existing !== null &&
				!existing.partial &&
				existing.replicaToken !== null &&
				existing.replicaToken === commit.replicaToken &&
				continuesCurrentBranch &&
				existing.entryCount <= commit.entries.length &&
				(existing.entryCount === 0 || commit.entries[existing.entryCount - 1]?.id === existing.tailEntryId);
			if (canAppend && existing) {
				const safeAppended = appended.map(cacheSafeEntry);
				const pruned = existing.pruned === true || safeAppended.some((entry, index) => entry !== appended[index]);
				const appendedBytes = safeAppended.reduce((sum, entry) => sum + serializedEntryBytes(entry), 0);
				const totalBytes = existing.bytes + appendedBytes;
				const metadata = makeMetadata(
					key,
					commit,
					existing.entryCount + safeAppended.length,
					commit.entries.at(-1)?.id ?? null,
					totalBytes,
					false,
					now,
					pruned,
					existing,
				);
				if (totalBytes <= OFFLINE_SESSION_MAX_BYTES) {
					if (safeAppended.length === 0) await this.#adapter.updateMetadata(metadata);
					else await this.#adapter.append(key, metadata, existing.entryCount, safeAppended);
				} else {
					const current = await this.#adapter.get(key);
					const retained = retainNewest([...(current?.entries ?? []), ...safeAppended], OFFLINE_SESSION_MAX_BYTES);
					await this.#adapter.put({
						metadata: makeMetadata(key, commit, retained.entries.length, retained.entries.at(-1)?.id ?? null, retained.bytes, true, now, pruned || retained.pruned, existing),
						entries: retained.entries,
					});
				}
			} else {
				const retained = retainNewest(commit.entries, OFFLINE_SESSION_MAX_BYTES);
				await this.#adapter.put({
					metadata: makeMetadata(key, commit, retained.entries.length, retained.entries.at(-1)?.id ?? null, retained.bytes, retained.partial, now, retained.pruned, existing),
					entries: retained.entries,
				});
			}
			this.#notify();
			await this.#evict();
		} catch (error) {
			if (!isQuotaExceeded(error)) return;
			try {
				await this.#evictOne(key);
				await this.writeOnce(key, commit);
			} catch {
				// Cache failure is deliberately isolated from the live transcript.
			}
		}
	}

	async stats(): Promise<OfflineCacheStats> {
		try {
			const records = await this.#adapter.listMetadata();
			return { sessions: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0) };
		} catch {
			return { sessions: 0, bytes: 0 };
		}
	}

	/** Forgets one session's saved copy (signed out, or the session is gone); queued writes for it are dropped. */
	async forget(key: string): Promise<void> {
		const timer = this.#timers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(key);
		}
		try {
			await this.#writes.get(key);
			await this.#adapter.delete(key);
			this.#notify();
		} catch {
			// A failed delete leaves the copy; the next sign-in or snapshot replaces it.
		}
	}

	async clear(): Promise<void> {
		if (this.#clearing) return;
		this.#clearing = true;
		try {
			for (const timer of this.#timers.values()) clearTimeout(timer);
			this.#timers.clear();
			await Promise.all(this.#writes.values());
			try {
				await this.#adapter.clear();
			} catch {
				// Clearing an unavailable transcript database must not block clearing the API cache.
			}
			try {
				if (typeof caches !== "undefined") await caches.delete(API_CACHE_NAME);
			} catch {
				// CacheStorage can be unavailable in private browsing.
			}
			this.#notify();
		} finally {
			this.#clearing = false;
		}
	}

	async updateSessionStatuses(statuses: readonly OfflineSessionStatus[]): Promise<void> {
		if (statuses.length === 0) return;
		try {
			const byKey = new Map(statuses.map(status => [status.key, status]));
			for (const metadata of await this.#adapter.listMetadata()) {
				const status = byKey.get(metadata.key);
				if (
					status === undefined ||
					(metadata.archivedAt === status.archivedAt &&
						metadata.live === status.live &&
						metadata.waitingOnYou === status.waitingOnYou &&
						metadata.unfinished === status.unfinished)
				) {
					continue;
				}
				await this.#adapter.updateMetadata({ ...metadata, ...status });
			}
		} catch {
			// Session-list metadata is advisory; a refresh failure cannot break the live session list.
		}
	}

	async #evict(): Promise<void> {
		const now = this.#environment.now();
		const records = await this.#adapter.listMetadata();
		const expired = records.filter(record => now - record.lastViewedAt > OFFLINE_CACHE_TTL_MS && !this.#pinned.has(record.key));
		for (const record of expired) await this.#adapter.delete(record.key);
		const remaining = records.filter(record => !expired.includes(record));
		const quota = await this.#environment.estimateQuota();
		const maxBytes = this.#environment.touchDevice() ? PHONE_BUDGET_BYTES : DESKTOP_BUDGET_BYTES;
		const budget = Math.min(maxBytes, quota === null ? maxBytes : Math.floor(quota * 0.2));
		const evictions = chooseEvictions(remaining, budget, this.#pinned);
		for (const key of evictions) await this.#adapter.delete(key);
		if (expired.length > 0 || evictions.length > 0) this.#notify();
	}

	async #evictOne(except: string): Promise<void> {
		const records = await this.#adapter.listMetadata();
		const candidates = records
			.filter(record => record.key !== except && !this.#pinned.has(record.key))
			.sort(compareEvictionOrder);
		const victim = candidates[0];
		if (victim) {
			await this.#adapter.delete(victim.key);
			this.#notify();
		}
	}

	async writeOnce(key: string, commit: OfflineTranscriptCommit): Promise<void> {
		const now = this.#environment.now();
		const retained = retainNewest(commit.entries, OFFLINE_SESSION_MAX_BYTES);
		const existing = await this.#adapter.getMetadata(key);
		await this.#adapter.put({
			metadata: makeMetadata(key, commit, retained.entries.length, retained.entries.at(-1)?.id ?? null, retained.bytes, retained.partial, now, retained.pruned, existing),
			entries: retained.entries,
		});
		this.#notify();
		await this.#evict();
	}

	#requestPersistentStorage(): void {
		if (this.#persistRequested) return;
		this.#persistRequested = true;
		try {
			const persist = globalThis.navigator?.storage?.persist;
			if (persist) void persist.call(globalThis.navigator.storage).catch(() => {});
		} catch {
			// Persistence is best effort; browser storage may be blocked or unsupported.
		}
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}

export const offlineTranscriptCache = new OfflineTranscriptCache();
