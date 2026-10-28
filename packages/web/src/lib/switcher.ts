/**
 * Session switcher: owns the daemon session list, the health feed, and the single live guest
 * connection. Framework-free (subscribe/getSnapshot) like `GuestClient`.
 *
 * Invariants:
 * - At most one guest client is open. Switching builds the replacement first, then closes the
 *   old one, then connects the new one: each is closed/opened exactly once.
 * - A failed room-link request or a bad link leaves the current session connected.
 * - Overlapping switches resolve to the latest request; a superseded one never connects.
 * - Polling runs only while the page is visible; becoming visible (or online) refreshes
 *   immediately and revives the current connection.
 */
import type {
	CreateSessionRequest,
	DaemonHealth,
	ListSessionsResponse,
	RoomLinkResponse,
	RoomPermission,
	SleepCandidate,
	SessionSummary,
} from "@omp-console/protocol";
import { DeckApiError } from "./api";
import { machineIdForSessionKey } from "./machines";
import { offlineTranscriptCache } from "./offline-cache/cache";
import type { OfflineCachedTranscript } from "./offline-cache/types";
import type { PageLifecycle } from "./lifecycle";
/** The slice of `GuestClient` the switcher drives. */
export interface SessionClient {
	connect(link?: string): void;
	close(): void;
	setOfflineCacheKey?(key: string): void;
	hydrateOfflineTranscript?(record: OfflineCachedTranscript): void;
	/** False when the session has no transport or already ended and needs a new client. */
	reconnect(): boolean;
}

export interface SwitcherApi {
	listSessions(): Promise<ListSessionsResponse>;
	cachedListSessions?(): Promise<ListSessionsResponse | null>;
	health(): Promise<DaemonHealth>;
	createSession(request: CreateSessionRequest, machineId?: string): Promise<SessionSummary>;
	roomLink(sessionId: string, permission?: RoomPermission): Promise<RoomLinkResponse>;
	stopSession(sessionId: string): Promise<void>;
}

export type SessionSwitcherApi = SwitcherApi;

export interface SwitcherOptions<C extends SessionClient> {
	api: SwitcherApi;
	/** Builds a not-yet-connected client; throws on an unparsable link. */
	createClient(link: string | null, name: string): C;
	name: string;
	lifecycle?: PageLifecycle;
	pollMs?: number;
	/** Waits between room-link retries while a new worker starts. */
	sleep?(ms: number): Promise<void>;
}

export interface SwitcherSnapshot<C extends SessionClient> {
	sessions: ListSessionsResponse | null;
	health: DaemonHealth | null;
	/** Last list/health refresh failure; cleared by the next success. */
	listError: DeckApiError | null;
	/** Any request answered 401/403: the UI shows the authorization state. */
	authFailed: boolean;
	/** Daemon session id of the connected session; null for a manual link or nothing. */
	selectedId: string | null;
	client: C | null;
	/** A select/create/resume/fork is in flight. */
	busy: boolean;
	/** Asleep session currently being resumed through its room link, if any. */
	wakingId: string | null;
	/** Failure of the last user action (room link, create, stop). */
	actionError: string | null;
	/**
	 * The last resume failed because the session's saved model can no longer be used (retired or unauthorized). The UI
	 * offers to resume it on another model; omp does not substitute one on its own when `retry.modelFallback` is off.
	 */
	resumeModelRetry: ResumeModelRetry | null;
	/** The original request that can continue after sleeping the daemon's offered candidate. */
	sleepCandidateRetry: SleepCandidateRetry | null;
}

export interface ResumeModelRetry {
	request: CreateSessionRequest;
	machineId?: string;
	/** The saved model omp could not restore, e.g. `anthropic/claude-opus-5`. */
	missingModel: string;
}
export interface SleepCandidateRetry {
	candidate: SleepCandidate;
	request: CreateSessionRequest;
	machineId?: string;
}

const RESTORE_FAILURE_RE = /Could not restore model (\S+)/;

function resumeModelRetryFor(request: CreateSessionRequest, machineId: string | undefined, err: unknown): ResumeModelRetry | null {
	if (request.resumeSessionFile === undefined || request.model !== undefined) return null;
	const missing = RESTORE_FAILURE_RE.exec(describe(err))?.[1];
	return missing ? { request, machineId, missingModel: missing.replace(/[.,;:]+$/, "") } : null;
}
function sleepCandidateRetryFor(request: CreateSessionRequest, machineId: string | undefined, err: unknown): SleepCandidateRetry | null {
	if (!(err instanceof DeckApiError) || err.sleepCandidate === undefined) return null;
	return { candidate: err.sleepCandidate, request, ...(machineId === undefined ? {} : { machineId }) };
}

/** In-place resume for sessions this daemon hosted; a titled copy for terminal sessions. */
function openSavedRequest(saved: SessionSummary, sessionFile: string): CreateSessionRequest {
	if (saved.source !== "terminal") return { cwd: saved.cwd, resumeSessionFile: sessionFile };
	const title = saved.title?.trim();
	return { cwd: saved.cwd, forkFrom: { sessionFile }, ...(title ? { title } : {}) };
}

export const POLL_MS = 3_000;
const READY_RETRIES = 10;
const READY_DELAY_MS = 300;

function withLiveSessionState(
	sessions: ListSessionsResponse | null,
	sessionId: string | null,
	state: SessionSummary["state"],
): ListSessionsResponse | null {
	if (sessions === null || sessionId === null) return sessions;
	let changed = false;
	const live = sessions.live.map(session => {
		if (session.id !== sessionId || session.state === state) return session;
		changed = true;
		return { ...session, state };
	});
	return changed ? { ...sessions, live } : sessions;
}


function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Room link for a session, retrying while its worker is still starting (409). `isCurrent` lets a caller that
 * no longer wants the answer stop the retries.
 */
export async function roomLinkWhenReady(
	api: Pick<SwitcherApi, "roomLink">,
	sessionId: string,
	isCurrent: () => boolean,
	sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<RoomLinkResponse> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await api.roomLink(sessionId, "full");
		} catch (err) {
			// A 409 means "still starting", except at the worker limit (it names a session to sleep): retrying that
			// only delays the offer to sleep one.
			const starting = err instanceof DeckApiError && err.kind === "conflict" && err.sleepCandidate === undefined;
			if (!starting || attempt >= READY_RETRIES || !isCurrent()) throw err;
			await sleep(READY_DELAY_MS);
			if (!isCurrent()) throw err;
		}
	}
}

export class SessionSwitcher<C extends SessionClient> {
	readonly #opts: SwitcherOptions<C>;
	readonly #listeners = new Set<() => void>();
	#snapshot: SwitcherSnapshot<C> = {
		sessions: null,
		health: null,
		listError: null,
		authFailed: false,
		selectedId: null,
		client: null,
		busy: false,
		wakingId: null,
		actionError: null,
		resumeModelRetry: null,
		sleepCandidateRetry: null,
	};
	/** Bumped by every switch/leave/stop; an async step that sees a newer value is superseded. */
	#epoch = 0;
	#refreshing: Promise<void> | null = null;
	#pollTimer: Timer | undefined;
	#unsubscribeLifecycle: (() => void) | null = null;
	#disposed = false;
	#cachedListLookupStarted = false;

	constructor(opts: SwitcherOptions<C>) {
		this.#opts = opts;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): SwitcherSnapshot<C> {
		return this.#snapshot;
	}

	/** Starts polling (while visible) and the visibility/online reactions. Idempotent. */
	start(): void {
		if (this.#disposed || this.#unsubscribeLifecycle) return;
		const lifecycle = this.#opts.lifecycle;
		if (lifecycle) {
			this.#unsubscribeLifecycle = lifecycle.subscribe(event => {
				if (event === "hidden") this.#stopPolling();
				else this.#resume();
			});
		} else {
			this.#unsubscribeLifecycle = () => {};
		}
		void this.refresh();
		if (!lifecycle?.isHidden()) this.#startPolling();
	}

	/** Stops polling and closes the live connection. */
	dispose(): void {
		this.#disposed = true;
		this.#epoch++;
		this.#stopPolling();
		this.#unsubscribeLifecycle?.();
		this.#unsubscribeLifecycle = null;
		this.#snapshot.client?.close();
		offlineTranscriptCache.setPinnedKeys([], "session-switcher");
		this.#snapshot = { ...this.#snapshot, client: null, selectedId: null, busy: false, wakingId: null };
		this.#listeners.clear();
	}

	/** Refreshes list and health together; concurrent calls share one request pair. */
	refresh(): Promise<void> {
		if (!this.#cachedListLookupStarted) {
			this.#cachedListLookupStarted = true;
			if (this.#opts.api.cachedListSessions && this.#snapshot.sessions === null && !this.#snapshot.authFailed) {
				void this.#opts.api.cachedListSessions().then(cached => {
					if (cached === null || this.#disposed || this.#snapshot.sessions !== null || this.#snapshot.authFailed) return;
					this.#commit({ ...this.#snapshot, sessions: cached });
				}).catch(() => {});
			}
		}
		this.#refreshing ??= this.#refresh().finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}

	async #refresh(): Promise<void> {
		const [list, health] = await Promise.allSettled([this.#opts.api.listSessions(), this.#opts.api.health()]);
		if (this.#disposed) return;
		const next: SwitcherSnapshot<C> = { ...this.#snapshot };
		let authFailed = false;
		if (list.status === "fulfilled") {
			next.sessions = list.value;
			next.listError = null;
		} else {
			next.listError = this.#asApiError(list.reason);
			if (next.listError.kind === "auth") next.sessions = null;
			authFailed ||= next.listError.kind === "auth";
		}
		if (health.status === "fulfilled") {
			next.health = health.value;
		} else if (health.reason instanceof DeckApiError && health.reason.kind === "auth") {
			authFailed = true;
		}
		// Only a successful list clears the auth state: health alone cannot prove authorization.
		next.authFailed = list.status === "fulfilled" ? false : authFailed || this.#snapshot.authFailed;
		this.#commit(next);
	}

	async select(sessionId: string): Promise<void> {
		const current = this.#snapshot;
		const asleep = current.sessions?.live.some(session => session.id === sessionId && session.state === "asleep") ?? false;
		if (current.selectedId === sessionId && current.client?.reconnect() && !asleep) return;
		const epoch = ++this.#epoch;
		this.#patch({
			busy: true,
			actionError: null,
			resumeModelRetry: null,
			sleepCandidateRetry: null,
			wakingId: asleep ? sessionId : null,
			sessions: asleep ? withLiveSessionState(current.sessions, sessionId, "waking") : current.sessions,
		});
		offlineTranscriptCache.setPinnedKeys(current.selectedId === null ? [sessionId] : [current.selectedId, sessionId], "session-switcher");
		let candidate: C | null = null;
		let cachedClient: C | null = null;
		try {
			const cached = current.client !== null && current.selectedId === sessionId ? null : await offlineTranscriptCache.load(sessionId);
			if (epoch !== this.#epoch) return;
			if (cached !== null) {
				candidate = this.#opts.createClient(null, this.#opts.name);
				if (candidate.hydrateOfflineTranscript) {
					candidate.setOfflineCacheKey?.(sessionId);
					candidate.hydrateOfflineTranscript(cached);
					cachedClient = candidate;
					candidate = null;
					this.#snapshot.client?.close();
					offlineTranscriptCache.setPinnedKeys([sessionId], "session-switcher");
					this.#commit({ ...this.#snapshot, client: cachedClient, selectedId: sessionId, busy: true, actionError: null });
				} else {
					candidate.close();
					candidate = null;
				}
			}
		} catch {
			candidate?.close();
		}
		let room: RoomLinkResponse;
		try {
			room = await this.#roomLinkWhenReady(sessionId, epoch);
		} catch (err) {
			// Waking an asleep session at the worker limit: offer to sleep the candidate, then resume this one by file
			// (the daemon wakes it under the same id).
			const row = current.sessions?.live.find(session => session.id === sessionId);
			const retry =
				asleep && row?.sessionFile !== undefined
					? sleepCandidateRetryFor(
							{ cwd: row.cwd, resumeSessionFile: row.sessionFile },
							machineIdForSessionKey(sessionId) ?? undefined,
							err,
						)
					: null;
			this.#failAction(epoch, err, null, retry);
			return;
		}
		if (epoch !== this.#epoch) return;
		this.#attach(room.link, sessionId, epoch, cachedClient ?? undefined);
	}

	/** Joins an arbitrary collab link (deep link or pasted), outside the daemon's session list. */
	connectLink(link: string): void {
		const epoch = ++this.#epoch;
		this.#attach(link, null, epoch);
	}

	/** Creates a new, resumed, or forked session and connects to its room. */
	async create(request: CreateSessionRequest, machineId?: string): Promise<void> {
		const epoch = ++this.#epoch;
		const waking = this.#snapshot.sessions?.live.find(
			session => session.state === "asleep" && session.sessionFile === request.resumeSessionFile,
		);
		this.#patch({
			busy: true,
			actionError: null,
			resumeModelRetry: null,
			sleepCandidateRetry: null,
			wakingId: waking?.id ?? null,
			sessions: waking ? withLiveSessionState(this.#snapshot.sessions, waking.id, "waking") : this.#snapshot.sessions,
		});
		let summary: SessionSummary;
		try {
			summary = await this.#opts.api.createSession(request, machineId);
		} catch (err) {
			this.#failAction(
				epoch,
				err,
				resumeModelRetryFor(request, machineId, err),
				sleepCandidateRetryFor(request, machineId, err),
			);
			return;
		}
		if (epoch !== this.#epoch) {
			void this.refresh();
			return;
		}
		void this.refresh();
		let room: RoomLinkResponse;
		try {
			room = await this.#roomLinkWhenReady(summary.id, epoch);
		} catch (err) {
			this.#failAction(epoch, err);
			return;
		}
		if (epoch !== this.#epoch) return;
		this.#attach(room.link, summary.id, epoch);
	}

	/**
	 * Opens a saved session. One this daemon hosted continues in place; a terminal session (`source: "terminal"`, which
	 * terminal omp may still be writing) opens as a copy that keeps its title, and the source JSONL is never touched.
	 */
	resume(recent: SessionSummary, machineId?: string): Promise<void> {
		if (!recent.sessionFile) return this.#reject("this session has no session file to open");
		return this.create(openSavedRequest(recent, recent.sessionFile), machineId);
	}

	fork(source: SessionSummary, machineId?: string): Promise<void> {
		if (!source.sessionFile) return this.#reject("this session was never saved, so it cannot be forked");
		return this.create({ cwd: source.cwd, forkFrom: { sessionFile: source.sessionFile } }, machineId);
	}

	/**
	 * Creates, resumes or forks a session without connecting to it: the pane host decides which pane shows it.
	 * Null on failure (the error is in `actionError`).
	 */
	async spawn(request: CreateSessionRequest, machineId?: string): Promise<SessionSummary | null> {
		this.#patch({ busy: true, actionError: null, resumeModelRetry: null, sleepCandidateRetry: null });
		try {
			const summary = await this.#opts.api.createSession(request, machineId);
			void this.refresh();
			this.#patch({ busy: false });
			return summary;
		} catch (err) {
			this.#patch({
				busy: false,
				actionError: describe(err),
				authFailed: this.#snapshot.authFailed || this.#isAuth(err),
				resumeModelRetry: resumeModelRetryFor(request, machineId, err),
				sleepCandidateRetry: sleepCandidateRetryFor(request, machineId, err),
			});
			return null;
		}
	}

	/** Repeats the resume in {@link SwitcherSnapshot.resumeModelRetry} with `model` (a selector the user chose). */
	retryResumeWithModel(model: string): Promise<SessionSummary | null> {
		const retry = this.#snapshot.resumeModelRetry;
		if (retry === null) return Promise.resolve(null);
		return this.spawn({ ...retry.request, model }, retry.machineId);
	}

	/** Opens a saved session without connecting (in place, or as a copy for terminal sessions); see {@link resume}. */
	spawnResume(recent: SessionSummary, machineId?: string): Promise<SessionSummary | null> {
		if (!recent.sessionFile) return this.#reject("this session has no session file to open").then(() => null);
		return this.spawn(openSavedRequest(recent, recent.sessionFile), machineId);
	}
	spawnFork(source: SessionSummary, machineId?: string): Promise<SessionSummary | null> {
		if (!source.sessionFile) return this.#reject("this session was never saved, so it cannot be forked").then(() => null);
		return this.spawn({ cwd: source.cwd, forkFrom: { sessionFile: source.sessionFile } }, machineId);
	}

	/** Ends a session; false (with `actionError` set) when the daemon refused. */
	async stop(sessionId: string): Promise<boolean> {
		try {
			await this.#opts.api.stopSession(sessionId);
		} catch (err) {
			this.#patch({ actionError: describe(err), authFailed: this.#snapshot.authFailed || this.#isAuth(err) });
			return false;
		}
		if (this.#snapshot.selectedId === sessionId) this.leave();
		void this.refresh();
		return true;
	}

	/** Closes the live connection and clears the selection. */
	leave(): void {
		this.#epoch++;
		const prev = this.#snapshot.client;
		prev?.close();
		offlineTranscriptCache.setPinnedKeys([], "session-switcher");
		this.#commit({ ...this.#snapshot, client: null, selectedId: null, busy: false, wakingId: null });
	}

	/** Page visible or network back: revive the connection, refresh, restart polling. */
	#resume(): void {
		const { client, selectedId } = this.#snapshot;
		if (client && !client.reconnect() && selectedId !== null) void this.select(selectedId);
		void this.refresh();
		this.#startPolling();
	}

	#attach(link: string, sessionId: string | null, epoch: number, restored?: C): void {
		let next = restored;
		try {
			next ??= this.#opts.createClient(link, this.#opts.name);
			if (sessionId !== null) next.setOfflineCacheKey?.(sessionId);
			if (next !== this.#snapshot.client) this.#snapshot.client?.close();
			next.connect(restored === undefined ? undefined : link);
		} catch (err) {
			if (next !== undefined && next !== this.#snapshot.client) next.close();
			this.#failAction(epoch, err);
			return;
		}
		offlineTranscriptCache.setPinnedKeys(sessionId === null ? [] : [sessionId], "session-switcher");
		const pendingWakingId = this.#snapshot.wakingId;
		const wakingId = pendingWakingId === sessionId ? pendingWakingId : null;
		const sessions = withLiveSessionState(this.#snapshot.sessions, wakingId, "idle");
		this.#commit({ ...this.#snapshot, sessions, client: next, selectedId: sessionId, busy: false, actionError: null, wakingId: null, sleepCandidateRetry: null });
		if (pendingWakingId !== null && pendingWakingId !== sessionId) void this.refresh();
	}

	#roomLinkWhenReady(sessionId: string, epoch: number): Promise<RoomLinkResponse> {
		return roomLinkWhenReady(this.#opts.api, sessionId, () => epoch === this.#epoch, this.#opts.sleep);
	}

	#failAction(
		epoch: number,
		err: unknown,
		resumeModelRetry: ResumeModelRetry | null = null,
		sleepCandidateRetry: SleepCandidateRetry | null = null,
	): void {
		if (epoch !== this.#epoch) return;
		const selectedId = this.#snapshot.selectedId;
		offlineTranscriptCache.setPinnedKeys(selectedId === null ? [] : [selectedId], "session-switcher");
		const wakingId = this.#snapshot.wakingId;
		const sessions = withLiveSessionState(this.#snapshot.sessions, wakingId, "asleep");
		this.#patch({
			sessions,
			busy: false,
			actionError: describe(err),
			authFailed: this.#snapshot.authFailed || this.#isAuth(err),
			resumeModelRetry,
			sleepCandidateRetry,
			wakingId: null,
		});
		if (wakingId !== null) void this.refresh();
	}

	#reject(message: string): Promise<void> {
		this.#patch({ actionError: message });
		return Promise.resolve();
	}

	#isAuth(err: unknown): boolean {
		return err instanceof DeckApiError && err.kind === "auth";
	}

	#asApiError(err: unknown): DeckApiError {
		return err instanceof DeckApiError ? err : new DeckApiError("network", 0, describe(err));
	}

	#startPolling(): void {
		if (this.#disposed || this.#pollTimer !== undefined) return;
		this.#pollTimer = setInterval(() => void this.refresh(), this.#opts.pollMs ?? POLL_MS);
	}

	#stopPolling(): void {
		if (this.#pollTimer === undefined) return;
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	#patch(partial: Partial<SwitcherSnapshot<C>>): void {
		this.#commit({ ...this.#snapshot, ...partial });
	}

	#commit(next: SwitcherSnapshot<C>): void {
		if (this.#disposed) return;
		this.#snapshot = next;
		for (const listener of this.#listeners) listener();
	}
}
