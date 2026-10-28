/**
 * Guest pool: the live guest connections of every open pane. Framework-free (subscribe/getSnapshot) like
 * `GuestClient` and `SessionSwitcher`; it replaces the switcher's single connection when panes are tiled.
 *
 * The pane model says which sessions are wanted ({@link GuestPool.sync}); the pool makes that so.
 *
 * Invariants:
 * - One client per wanted session, however many panes show it: wanting the same id twice reuses the client
 *   and asks the daemon for one room link.
 * - A client is built, connected and closed exactly once. A session dropped from the wanted set while its room
 *   link is still in flight never gets a client.
 * - A failed room-link request leaves the other sessions connected; the failure is kept per session until
 *   {@link GuestPool.rejoin} retries it.
 * - A joined link (deep link, pasted) is held in memory under a `link:N` key; it is never put in storage.
 */
import type { RoomLinkResponse } from "@omp-console/protocol";
import { DeckApiError } from "./api";
import { roomLinkWhenReady, type SessionClient, type SwitcherApi } from "./switcher";
import { offlineTranscriptCache } from "./offline-cache/cache";
import { sessionIdForSessionKey, splitSessionKey } from "./machines";
import { promptHistory } from "./prompt-history";


export const LINK_KEY_PREFIX = "link:";

export function isLinkKey(key: string): boolean {
	return key.startsWith(LINK_KEY_PREFIX);
}

export interface GuestPoolOptions<C extends SessionClient> {
	api: Pick<SwitcherApi, "roomLink" | "createSession" | "stopSession">;
	/** Builds a not-yet-connected client; throws on an unparsable link. */
	createClient(link: string | null, name: string): C;
	name: string;
	/** Waits between room-link retries while a new worker starts. */
	sleep?(ms: number): Promise<void>;
}


export interface PoolSnapshot<C extends SessionClient> {
	/** Connected (or connecting) clients by session key. */
	clients: ReadonlyMap<string, C>;
	/** Why a wanted session has no client; cleared by a successful (re)join. */
	errors: ReadonlyMap<string, string>;
	/** A room-link request was answered 401/403. */
	authFailed: boolean;
}

interface Entry<C extends SessionClient> {
	client: C | null;
	stopWatching: (() => void) | null;
	rejoinPending: boolean;
}

interface RestartContext {
	cwd: string;
	prompt: string;
	model?: string;
}

interface RestartAwareClient {
	roomMissing?: boolean;
	canRestartAfterLoss?: boolean;
	subscribe?(listener: () => void): () => void;
	getRestartContext?(): RestartContext | null;

	markUnrestorableAfterRestart?(): boolean;
	endAfterHostClose?(): boolean;
	setRestartError?(message: string): void;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class GuestPool<C extends SessionClient> {
	readonly #opts: GuestPoolOptions<C>;
	readonly #listeners = new Set<() => void>();
	readonly #entries = new Map<string, Entry<C>>();
	readonly #links = new Map<string, string>();
	#nextLink = 1;
	#snapshot: PoolSnapshot<C> = { clients: new Map(), errors: new Map(), authFailed: false };
	#disposed = false;

	constructor(opts: GuestPoolOptions<C>) {
		this.#opts = opts;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): PoolSnapshot<C> {
		return this.#snapshot;
	}

	/** Holds a joined link in memory and returns the key a pane refers to it by. */
	registerLink(link: string): string {
		const key = `${LINK_KEY_PREFIX}${this.#nextLink++}`;
		this.#links.set(key, link);
		return key;
	}

	/** Connects the wanted sessions that are not connected and closes the ones no pane shows any more. */
	sync(wanted: Iterable<string>): void {
		if (this.#disposed) return;
		const want = new Set(wanted);
		offlineTranscriptCache.setPinnedKeys([...want].filter(key => !isLinkKey(key)), "guest-pool");
		let changed = false;
		for (const [key, entry] of this.#entries) {
			if (want.has(key)) continue;
			this.#entries.delete(key);
			this.#links.delete(key);
			entry.stopWatching?.();
			entry.client?.close();
			changed = true;
		}
		const errors = new Map(this.#snapshot.errors);
		for (const key of errors.keys()) {
			if (!want.has(key)) {
				errors.delete(key);
				changed = true;
			}
		}
		for (const key of want) {
			if (this.#entries.has(key) || errors.has(key)) continue;
			this.#open(key);
		}
		if (changed) this.#commit({ errors });
	}

	/** Revives one session: the live connection if it can resume, else a fresh room link and client. */
	rejoin(key: string): void {
		if (this.#disposed) return;
		const entry = this.#entries.get(key);
		if (entry?.client) {
			const recovery = entry.client as C & RestartAwareClient;
			if (recovery.canRestartAfterLoss) {
				void this.#startAgain(key, entry, recovery);
				return;
			}
			if (recovery.roomMissing) {
				if (!entry.rejoinPending) {
					entry.rejoinPending = true;
					void this.#rejoinMissing(key, entry, entry.client);
				}
				return;
			}
			if (entry.client.reconnect()) return;
		}
		entry?.stopWatching?.();
		entry?.client?.close();
		this.#entries.delete(key);
		const errors = new Map(this.#snapshot.errors);
		errors.delete(key);
		this.#commit({ errors });
		this.#open(key);
	}

	/** Page visible or network back: recover missing rooms, leave lost sessions for explicit user action. */
	revive(): void {
		for (const [key, entry] of [...this.#entries]) {
			const recovery = entry.client as (C & RestartAwareClient) | null;
			if (recovery?.canRestartAfterLoss) continue;
			if (recovery?.roomMissing) {
				if (!entry.rejoinPending) {
					entry.rejoinPending = true;
					void this.#rejoinMissing(key, entry, entry.client as C);
				}
			} else if (entry.client && !entry.client.reconnect()) {
				this.rejoin(key);
			}
		}
		for (const key of [...this.#snapshot.errors.keys()]) this.rejoin(key);
	}

	/** Closes every connection. */
	dispose(): void {
		this.#disposed = true;
		offlineTranscriptCache.setPinnedKeys([], "guest-pool");
		for (const entry of this.#entries.values()) {
			entry.stopWatching?.();
			entry.client?.close();
		}
		this.#entries.clear();
		this.#links.clear();
		this.#snapshot = { clients: new Map(), errors: new Map(), authFailed: false };
		this.#listeners.clear();
	}

	#open(key: string): void {
		const entry: Entry<C> = { client: null, stopWatching: null, rejoinPending: false };
		this.#entries.set(key, entry);
		void this.#connect(key, entry);
	}

	async #connect(key: string, entry: Entry<C>): Promise<void> {
		const stillWanted = (): boolean => this.#entries.get(key) === entry && !this.#disposed;
		let client: C | null = null;
		if (!isLinkKey(key)) {
			try {
				const cached = await offlineTranscriptCache.load(key);
				if (!stillWanted()) return;
				if (cached !== null) {
					const restored = this.#opts.createClient(null, this.#opts.name);
					if (restored.hydrateOfflineTranscript) {
						restored.setOfflineCacheKey?.(key);
						restored.hydrateOfflineTranscript(cached);
						client = restored;
						entry.client = restored;
						this.#watchClient(key, entry, restored);
						this.#commit({});
					} else {
						restored.close();
					}
				}
			} catch {
				// Cache failures fall through to the live room-link path.
			}
		}
		let link: string;
		try {
			link = await this.#linkFor(key, stillWanted);
		} catch (err) {
			if (!stillWanted()) return;
			// Offline (the daemon or peer cannot be reached): keep showing the saved copy. Any answer from the daemon
			// (signed out, session gone) wins over the saved copy: drop it and report the failure as without a cache.
			const unreachable =
				err instanceof DeckApiError && (err.kind === "network" || (err.status === 502 && /unreachable/.test(err.message)));
			if (client !== null && unreachable) return;
			entry.stopWatching?.();
			client?.close();
			if (!unreachable && !isLinkKey(key)) void offlineTranscriptCache.forget(key);
			this.#entries.delete(key);
			this.#fail(key, err);
			return;
		}
		if (!stillWanted()) return;
		const cachedClient = client;
		let openingClient: C | null = null;
		try {
			openingClient = cachedClient ?? this.#opts.createClient(link, this.#opts.name);
			if (!isLinkKey(key)) openingClient.setOfflineCacheKey?.(key);
			if (cachedClient === null) {
				entry.client = openingClient;
				this.#watchClient(key, entry, openingClient);
				this.#commit({});
			}
			openingClient.connect(cachedClient === null ? undefined : link);
		} catch (err) {
			if (cachedClient !== null) return;
			entry.stopWatching?.();
			entry.stopWatching = null;
			this.#entries.delete(key);
			openingClient?.close();
			this.#fail(key, err);
		}
	}

	#watchClient(key: string, entry: Entry<C>, client: C): void {
		const recovery = client as C & RestartAwareClient;
		if (recovery.subscribe === undefined) return;
		entry.stopWatching = recovery.subscribe(() => {
			if (this.#entries.get(key) !== entry || !recovery.roomMissing || entry.rejoinPending) return;
			entry.rejoinPending = true;
			void this.#rejoinMissing(key, entry, client);
		});
	}

	async #rejoinMissing(key: string, entry: Entry<C>, client: C): Promise<void> {
		const recovery = client as C & RestartAwareClient;
		const stillWanted = (): boolean => this.#entries.get(key) === entry && entry.client === client && !this.#disposed;
		let link: string;
		try {
			link = await this.#linkFor(key, stillWanted);
		} catch (err) {
			if (!stillWanted()) return;
			if (
				err instanceof DeckApiError &&
				err.status === 404 &&
				(recovery.markUnrestorableAfterRestart?.() || recovery.endAfterHostClose?.())
			) {
				entry.stopWatching?.();
				entry.stopWatching = null;
				entry.rejoinPending = false;
				const errors = new Map(this.#snapshot.errors);
				errors.delete(key);
				this.#commit({ errors });
				return;
			}
			if (err instanceof DeckApiError && (err.kind === "network" || (err.status === 502 && /unreachable/.test(err.message)))) {
				entry.stopWatching?.();
				entry.stopWatching = null;
				entry.rejoinPending = false;
				this.#fail(key, err);
				return;
			}
			entry.stopWatching?.();
			entry.stopWatching = null;
			entry.rejoinPending = false;
			this.#entries.delete(key);
			client.close();
			if (!isLinkKey(key)) void offlineTranscriptCache.forget(key);
			this.#fail(key, err);
			return;
		}
		if (!stillWanted()) return;

		let replacement: C | null = null;
		try {
			replacement = this.#opts.createClient(link, this.#opts.name);
			if (!isLinkKey(key)) replacement.setOfflineCacheKey?.(key);
			replacement.connect();
		} catch (err) {
			replacement?.close();
			entry.stopWatching?.();
			entry.stopWatching = null;
			entry.rejoinPending = false;
			this.#fail(key, err);
			return;
		}

		entry.stopWatching?.();
		entry.client = replacement;
		entry.rejoinPending = false;
		this.#watchClient(key, entry, replacement);
		const errors = new Map(this.#snapshot.errors);
		errors.delete(key);
		this.#commit({ errors });
		client.close();
	}

	async #startAgain(key: string, entry: Entry<C>, recovery: RestartAwareClient): Promise<void> {
		if (entry.rejoinPending) return;
		const context = recovery.getRestartContext?.();
		if (context === null || context === undefined) return;
		const parts = splitSessionKey(key);
		if (parts.link) return;
		entry.rejoinPending = true;
		try {
			const summary = await this.#opts.api.createSession(
				{ cwd: context.cwd, ...(context.model === undefined ? {} : { model: context.model }) },
				parts.machineId ?? undefined,
			);
			if (this.#disposed || this.#entries.get(key) !== entry) {
				await this.#opts.api.stopSession(summary.id);
				return;
			}
			promptHistory.saveDraft(sessionIdForSessionKey(summary.id), context.prompt);
			window.location.hash = `#session=${encodeURIComponent(summary.id)}`;
		} catch (err) {
			if (this.#entries.get(key) === entry) recovery.setRestartError?.(describe(err));
		} finally {
			entry.rejoinPending = false;
		}
	}


	async #linkFor(key: string, stillWanted: () => boolean): Promise<string> {
		if (isLinkKey(key)) {
			const link = this.#links.get(key);
			if (link === undefined) throw new Error("this joined room is no longer available");
			return link;
		}
		const room: RoomLinkResponse = await roomLinkWhenReady(this.#opts.api, key, stillWanted, this.#opts.sleep);
		return room.link;
	}

	#fail(key: string, err: unknown): void {
		const errors = new Map(this.#snapshot.errors);
		errors.set(key, describe(err));
		this.#commit({
			errors,
			authFailed: this.#snapshot.authFailed || (err instanceof DeckApiError && err.kind === "auth"),
		});
	}

	#commit(partial: Partial<Omit<PoolSnapshot<C>, "clients">>): void {
		if (this.#disposed) return;
		// A client that left the entry table (closed by sync/rejoin) must not stay in the published map.
		const clients = new Map<string, C>();
		for (const [key, entry] of this.#entries) if (entry.client) clients.set(key, entry.client);
		this.#snapshot = { ...this.#snapshot, ...partial, clients };
		for (const listener of this.#listeners) listener();
	}
}
