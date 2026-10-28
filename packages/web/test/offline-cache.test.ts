import { afterEach, describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { OfflineTranscriptCache, chooseEvictions } from "../src/lib/offline-cache/cache";
import type {
	CacheBudgetEnvironment,
	OfflineCacheAdapter,
	OfflineCacheMetadata,
	OfflineCachedTranscript,
	OfflineTranscriptCommit,
} from "../src/lib/offline-cache/types";
import { OFFLINE_CACHE_TTL_MS, OFFLINE_IMAGE_MAX_BYTES, OFFLINE_SESSION_MAX_BYTES } from "../src/lib/offline-cache/types";
import { offlineCacheEnabled, setOfflineCacheEnabled } from "../src/lib/offline-cache/preference";

let originalLocalStorage: PropertyDescriptor | undefined;
let localStorageCaptured = false;
afterEach(() => {
	setOfflineCacheEnabled(false);
	if (!localStorageCaptured) return;
	if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
	originalLocalStorage = undefined;
	localStorageCaptured = false;
});
function enableCachePreference(): void {
	if (!localStorageCaptured) {
		originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		localStorageCaptured = true;
	}
	const values = new Map<string, string>();
	const storage: Pick<Storage, "getItem" | "setItem"> = {
		getItem: key => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
	};
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
	setOfflineCacheEnabled(true);
}

class MemoryAdapter implements OfflineCacheAdapter {
	readonly records = new Map<string, OfflineCachedTranscript>();
	failPuts = 0;
	puts = 0;
	appends = 0;
	putBarrier: { started(): void; promise: Promise<void> } | null = null;

	async get(key: string): Promise<OfflineCachedTranscript | null> {
		const record = this.records.get(key);
		return record ? { metadata: { ...record.metadata }, entries: [...record.entries] } : null;
	}

	async getMetadata(key: string): Promise<OfflineCacheMetadata | null> {
		const metadata = this.records.get(key)?.metadata;
		return metadata ? { ...metadata } : null;
	}

	async listMetadata(): Promise<OfflineCacheMetadata[]> {
		return [...this.records.values()].map(record => ({ ...record.metadata }));
	}

	async put(record: OfflineCachedTranscript): Promise<void> {
		if (this.failPuts > 0) {
			this.failPuts--;
			throw new DOMException("storage full", "QuotaExceededError");
		}
		const barrier = this.putBarrier;
		if (barrier !== null) {
			this.putBarrier = null;
			barrier.started();
			await barrier.promise;
		}
		this.puts++;
		this.records.set(record.metadata.key, { metadata: { ...record.metadata }, entries: [...record.entries] });
	}

	async append(key: string, metadata: OfflineCacheMetadata, previousCount: number, entries: readonly SessionEntry[]): Promise<void> {
		const current = this.records.get(key);
		if (!current || current.entries.length !== previousCount) throw new Error("append cursor mismatch");
		this.appends++;
		this.records.set(key, { metadata: { ...metadata }, entries: [...current.entries, ...entries] });
	}

	async updateMetadata(metadata: OfflineCacheMetadata): Promise<void> {
		const current = this.records.get(metadata.key);
		if (current) this.records.set(metadata.key, { metadata: { ...metadata }, entries: current.entries });
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}

	async clear(): Promise<void> {
		this.records.clear();
	}
}

function messageEntry(
	id: string,
	content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
	parentId: string | null = null,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-25T00:00:00.000Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

function commit(entries: readonly SessionEntry[], options: Partial<OfflineTranscriptCommit> = {}): OfflineTranscriptCommit {
	return {
		entries,
		title: "Cached session",
		cwd: "/work",
		replicaToken: "replica-cursor",
		leafId: entries.at(-1)?.id ?? null,
		lastEntryAt: 1,
		archivedAt: null,
		live: false,
		waitingOnYou: false,
		unfinished: true,
		...options,
	};
}

function rig(): {
	adapter: MemoryAdapter;
	cache: OfflineTranscriptCache;
	clock: { value: number };
	quota: { value: number | null };
} {
	const adapter = new MemoryAdapter();
	enableCachePreference();
	const clock = { value: 1_800_000_000_000 };
	const quota = { value: 2_000_000_000 as number | null };
	const environment: CacheBudgetEnvironment = {
		now: () => clock.value,
		estimateQuota: async () => quota.value,
		touchDevice: () => false,
	};
	return { adapter, cache: new OfflineTranscriptCache(adapter, environment), clock, quota };
}

function metadata(key: string, options: Partial<OfflineCacheMetadata> = {}): OfflineCacheMetadata {
	return {
		key,
		title: key,
		cwd: "/work",
		replicaToken: "cursor",
		entryCount: 1,
		tailEntryId: `${key}-entry`,
		leafId: `${key}-entry`,
		lastViewedAt: 1_800_000_000_000,
		lastEntryAt: 1_800_000_000_000,
		bytes: 40,
		partial: false,
		archivedAt: null,
		live: false,
		waitingOnYou: false,
		unfinished: false,
		...options,
	};
}

describe("offline transcript cache", () => {
	it("expires a session after sixty days without viewing it", async () => {
		const { adapter, cache, clock } = rig();
		await cache.write("machine:old", commit([messageEntry("old-entry", "old transcript")]));

		clock.value += OFFLINE_CACHE_TTL_MS + 1;
		expect(await cache.load("machine:old")).toBeNull();
		expect(await adapter.getMetadata("machine:old")).toBeNull();
	});

	it("replaces cached entries when the active leaf changes even if the replica tail is unchanged", async () => {
		const { adapter, cache } = rig();
		const entries = [
			messageEntry("root", "root"),
			messageEntry("branch", "old branch"),
			messageEntry("tail", "tail"),
		];
		await cache.write("machine:branch", commit(entries, { leafId: "branch" }));

		const updated = [
			entries[0]!,
			messageEntry("branch", "new branch"),
			entries[2]!,
		];
		await cache.write("machine:branch", commit(updated, { leafId: "tail" }));

		expect(await adapter.get("machine:branch")).toMatchObject({
			metadata: { leafId: "tail" },
			entries: [entries[0], updated[1], entries[2]],
		});
	});

	it("appends child entries without rewriting the cached transcript", async () => {
		const { adapter, cache } = rig();
		const root = messageEntry("root", "root");
		const child = messageEntry("child", "child", root.id);

		await cache.write("machine:append", commit([root]));
		await cache.write("machine:append", commit([root, child]));

		const record = await adapter.get("machine:append");
		expect(record?.entries.map(entry => entry.id)).toEqual(["root", "child"]);
		expect(record?.metadata).toMatchObject({ entryCount: 2, tailEntryId: "child", leafId: "child" });
		expect(adapter.puts).toBe(1);
		expect(adapter.appends).toBe(1);
	});

	it("serializes overlapping writes so an older snapshot cannot overwrite newer entries", async () => {
		const { adapter, cache } = rig();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		adapter.putBarrier = { started: () => started.resolve(), promise: release.promise };
		const root = messageEntry("root", "root");
		const child = messageEntry("child", "child", root.id);

		const olderWrite = cache.write("machine:ordered", commit([root]));
		await started.promise;
		const newerWrite = cache.write("machine:ordered", commit([root, child]));
		release.resolve();
		await Promise.all([olderWrite, newerWrite]);

		expect((await adapter.get("machine:ordered"))?.entries.map(entry => entry.id)).toEqual(["root", "child"]);
	});

	it("clears in-flight writes without allowing a concurrent write to repopulate the cache", async () => {
		const { adapter, cache } = rig();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		adapter.putBarrier = { started: () => started.resolve(), promise: release.promise };
		const writing = cache.write("machine:clear", commit([messageEntry("entry", "visible")]));
		await started.promise;

		const clearing = cache.clear();
		await cache.write("machine:clear", commit([messageEntry("later-entry", "later")]));
		release.resolve();
		await Promise.all([writing, clearing]);

		expect(await adapter.get("machine:clear")).toBeNull();
	});


	it("evicts archived then finished sessions before older active sessions and never evicts the pinned session", () => {
		const candidates = [
			metadata("active-old", { lastViewedAt: 1_700_000_000_000, live: true, unfinished: true }),
			metadata("screen", { lastViewedAt: 1_600_000_000_000, unfinished: true }),
			metadata("finished", { lastViewedAt: 1_750_000_000_000 }),
			metadata("archived", { lastViewedAt: 1_790_000_000_000, archivedAt: 1_790_000_000_000 }),
		];

		expect(chooseEvictions(candidates, 80, new Set(["screen"]))).toEqual(["archived", "finished"]);
	});

	it("applies the fourteen-day activity grace when ranking active sessions", () => {
		const now = 1_800_000_000_000;
		const records = [
			metadata("active", { lastViewedAt: now - 20 * 24 * 60 * 60 * 1000, live: true, unfinished: true }),
			metadata("finished", { lastViewedAt: now - 10 * 24 * 60 * 60 * 1000 }),
		];

		expect(chooseEvictions(records, 40, new Set())).toEqual(["finished"]);
	});

	it("keeps the newest entries under the per-session cap and marks the transcript partial", async () => {
		const { adapter, cache } = rig();
		const entries = Array.from({ length: 8 }, (_, index) => messageEntry(`entry-${index}`, "x".repeat(2 * 1024 * 1024)));

		await cache.write("machine:large", commit(entries));
		const record = await adapter.get("machine:large");
		expect(record?.entries.map(entry => entry.id)).toEqual(["entry-3", "entry-4", "entry-5", "entry-6", "entry-7"]);
		expect(record?.metadata.partial).toBe(true);
		expect(record?.metadata.bytes).toBeLessThanOrEqual(OFFLINE_SESSION_MAX_BYTES);
	});

	it("replaces images larger than 256 KiB with a text placeholder before persistence", async () => {
		const { adapter, cache } = rig();
		const data = "A".repeat(Math.ceil((OFFLINE_IMAGE_MAX_BYTES + 1) * 4 / 3));
		const entry = messageEntry("image-entry", [
			{ type: "text", text: "screenshot" },
			{ type: "image", data, mimeType: "image/png" },
		]);

		await cache.write("machine:image", commit([entry]));
		const record = await adapter.get("machine:image");
		const saved = record?.entries[0];
		if (saved?.type !== "message" || !Array.isArray(saved.message.content)) throw new Error("cached image message is missing");
		expect(saved.message.content[1]).toMatchObject({ type: "text", text: "[image not cached: exceeds 256 KiB]" });
		expect(JSON.stringify(record)).not.toContain(data);
	});

	it("marks a transcript with pruned images so its replica cursor is not reused", async () => {
		const { adapter, cache } = rig();
		const data = "A".repeat(Math.ceil((OFFLINE_IMAGE_MAX_BYTES + 1) * 4 / 3));
		await cache.write("machine:pruned", commit([messageEntry("big", [{ type: "image", data, mimeType: "image/png" }])]));
		expect((await adapter.getMetadata("machine:pruned"))?.pruned).toBe(true);
		await cache.write("machine:plain", commit([messageEntry("small", "hello")]));
		expect((await adapter.getMetadata("machine:plain"))?.pruned).toBe(false);
	});

	it("keeps the session list's archive and waiting status when the client writes", async () => {
		const { adapter, cache } = rig();
		const first = messageEntry("a", "one");
		await cache.write("machine:s", commit([first]));
		await cache.updateSessionStatuses([{ key: "machine:s", archivedAt: 5, live: false, waitingOnYou: false, unfinished: false }]);
		await cache.write("machine:s", commit([first, messageEntry("b", "two", first.id)], { live: true }));
		const saved = await adapter.getMetadata("machine:s");
		expect([saved?.archivedAt, saved?.unfinished, saved?.live]).toEqual([5, false, true]);
	});

	it("keeps an image exactly 256 KiB while dropping larger payloads", async () => {
		const { adapter, cache } = rig();
		const data = `${"A".repeat(Math.ceil(OFFLINE_IMAGE_MAX_BYTES / 3) * 4 - 2)}==`;
		const entry = messageEntry("boundary-image", [
			{ type: "image", data, mimeType: "image/png" },
		]);

		await cache.write("machine:image-boundary", commit([entry]));
		const saved = (await adapter.get("machine:image-boundary"))?.entries[0];
		if (saved?.type !== "message" || !Array.isArray(saved.message.content)) throw new Error("cached image message is missing");
		expect(saved.message.content[0]).toMatchObject({ type: "image", data });
	});

	it("evicts one unpinned record and retries once after a quota failure", async () => {
		const { adapter, cache } = rig();
		await cache.write("machine:old", commit([messageEntry("old", "old")]));
		adapter.failPuts = 1;

		await cache.write("machine:new", commit([messageEntry("new", "new")]));
		expect(await adapter.get("machine:new")).toMatchObject({ metadata: { key: "machine:new" } });
		expect(await adapter.get("machine:old")).toBeNull();
	});

	it("contains a repeated quota failure without damaging the pinned transcript", async () => {
		const { adapter, cache } = rig();
		await cache.write("machine:screen", commit([messageEntry("screen-entry", "visible")]));
		cache.setPinnedKeys(["machine:screen"], "pins");
		adapter.failPuts = 2;

		await cache.write("machine:new", commit([messageEntry("new-entry", "new")]));
		expect(await adapter.get("machine:screen")).toMatchObject({ entries: [{ id: "screen-entry" }] });
		expect(await adapter.get("machine:new")).toBeNull();
	});
});
describe("offline cache preference", () => {
	it("defaults to disabled and remembers explicit enable and disable transitions", () => {
		const values = new Map<string, string>();
		const storage: Pick<Storage, "getItem" | "setItem"> = {
			getItem: key => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		};
		expect(offlineCacheEnabled(storage)).toBe(false);
		setOfflineCacheEnabled(true, storage);
		expect(offlineCacheEnabled(storage)).toBe(true);
		setOfflineCacheEnabled(false, storage);
		expect(offlineCacheEnabled(storage)).toBe(false);
	});

	it("fails closed when preference storage throws", () => {
		const blocked: Pick<Storage, "getItem" | "setItem"> = {
			getItem() {
				throw new Error("storage blocked");
			},
			setItem() {
				throw new Error("storage blocked");
			},
		};
		expect(offlineCacheEnabled(blocked)).toBe(false);
		setOfflineCacheEnabled(true, blocked);
		expect(offlineCacheEnabled(blocked)).toBe(false);
	});
});
