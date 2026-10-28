import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	CreateSessionRequest,
	DaemonHealth,
	ListSessionsResponse,
	RoomLinkResponse,
	RoomPermission,
	SessionSummary,
} from "@omp-console/protocol";
import { DeckApiError } from "../src/lib/api";
import type { LifecycleEvent, PageLifecycle } from "../src/lib/lifecycle";
import { type SessionClient, SessionSwitcher, type SwitcherApi } from "../src/lib/switcher";

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		cwd: `/work/${id}`,
		sessionFile: `/work/${id}/s.jsonl`,
		state: "idle",
		createdAt: 1,
		lastActivityAt: 2,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

const HEALTH: DaemonHealth = { version: 1, startedAt: 1, workers: [], guests: 0, stalledAfterMs: 60_000 };

/** Records every connect/close/reconnect so tests assert on what the wire would see. */
class FakeClient implements SessionClient {
	connects = 0;
	closes = 0;
	reconnects = 0;
	/** What reconnect() answers; false models an ended session. */
	canReconnect = true;
	constructor(
		readonly link: string,
		readonly log: string[],
	) {}
	connect(): void {
		this.connects++;
		this.log.push(`connect ${this.link}`);
	}
	close(): void {
		this.closes++;
		this.log.push(`close ${this.link}`);
	}
	reconnect(): boolean {
		this.reconnects++;
		this.log.push(`reconnect ${this.link}`);
		return this.canReconnect;
	}
}

class FakeApi implements SwitcherApi {
	list: ListSessionsResponse | Error = { live: [summary("a"), summary("b")], recent: [summary("old")] };
	cachedList: ListSessionsResponse | null = null;
	healthResult: DaemonHealth | Error = HEALTH;
	/** Per-session room link behavior; a handler may be slow to model a busy daemon. */
	rooms = new Map<string, () => Promise<RoomLinkResponse>>();
	roomCalls: string[] = [];
	roomPermissions: Array<RoomPermission | undefined> = [];
	created: CreateSessionRequest[] = [];
	createTargets: Array<string | undefined> = [];
	stopped: string[] = [];
	createResult: SessionSummary | Error = summary("new");
	stopResult: Error | null = null;

	constructor() {
		for (const id of ["a", "b", "new"]) {
			this.rooms.set(id, async () => ({ roomId: id, link: `link-${id}`, permission: "full" }));
		}
	}
	async listSessions(): Promise<ListSessionsResponse> {
		if (this.list instanceof Error) throw this.list;
		return this.list;
	}
	async cachedListSessions(): Promise<ListSessionsResponse | null> {
		return this.cachedList;
	}
	async health(): Promise<DaemonHealth> {
		if (this.healthResult instanceof Error) throw this.healthResult;
		return this.healthResult;
	}
	async createSession(request: CreateSessionRequest, machineId?: string): Promise<SessionSummary> {
		this.created.push(request);
		this.createTargets.push(machineId);
		if (this.createResult instanceof Error) throw this.createResult;
		return this.createResult;
	}
	async roomLink(sessionId: string, permission?: RoomPermission): Promise<RoomLinkResponse> {
		this.roomCalls.push(sessionId);
		this.roomPermissions.push(permission);
		const handler = this.rooms.get(sessionId);
		if (!handler) throw new DeckApiError("not-found", 404, "no such live session");
		return handler();
	}
	async stopSession(sessionId: string): Promise<void> {
		if (this.stopResult) throw this.stopResult;
		this.stopped.push(sessionId);
	}
}

class FakeLifecycle implements PageLifecycle {
	hidden = false;
	#listeners = new Set<(event: LifecycleEvent) => void>();
	isHidden(): boolean {
		return this.hidden;
	}
	subscribe(listener: (event: LifecycleEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	emit(event: LifecycleEvent): void {
		this.hidden = event === "hidden";
		for (const listener of this.#listeners) listener(event);
	}
	get listenerCount(): number {
		return this.#listeners.size;
	}
}

interface Rig {
	api: FakeApi;
	switcher: SessionSwitcher<FakeClient>;
	clients: FakeClient[];
	log: string[];
	lifecycle: FakeLifecycle;
}

function rig(options: { throwOnLink?: string } = {}): Rig {
	const api = new FakeApi();
	const clients: FakeClient[] = [];
	const log: string[] = [];
	const lifecycle = new FakeLifecycle();
	const switcher = new SessionSwitcher<FakeClient>({
		api,
		name: "me",
		lifecycle,
		sleep: () => Promise.resolve(),
		createClient: link => {
			if (link !== null && link === options.throwOnLink) throw new Error("bad link");
			const client = new FakeClient(link ?? "cached", log);
			clients.push(client);
			return client;
		},
	});
	return { api, switcher, clients, log, lifecycle };
}

/** Lets chained promise continuations (allSettled, async API stubs) run; fake timers do not touch microtasks. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("session list refresh", () => {
	it("publishes list and health together", async () => {
		const { switcher } = rig();
		await switcher.refresh();
		const snap = switcher.getSnapshot();
		expect(snap.sessions?.live.map(s => s.id)).toEqual(["a", "b"]);
		expect(snap.sessions?.recent.map(s => s.id)).toEqual(["old"]);
		expect(snap.health).toEqual(HEALTH);
		expect(snap.listError).toBeNull();
	});
	it("shows the cached list during revalidation but removes it after a fresh auth failure", async () => {
		const { api, switcher } = rig();
		const cached: ListSessionsResponse = { live: [summary("cached")], recent: [] };
		api.cachedList = cached;
		const { promise, reject } = Promise.withResolvers<ListSessionsResponse>();
		api.listSessions = () => promise;

		const refresh = switcher.refresh();
		await settle();
		expect(switcher.getSnapshot().sessions).toEqual(cached);

		reject(new DeckApiError("auth", 401, "owner identity required"));
		await refresh;
		expect(switcher.getSnapshot().sessions).toBeNull();
		expect(switcher.getSnapshot().authFailed).toBe(true);
		switcher.dispose();
	});

	it("keeps the last list on a failed refresh, reports the error, and clears it on recovery", async () => {
		const { api, switcher } = rig();
		await switcher.refresh();
		api.list = new DeckApiError("network", 0, "daemon unreachable");
		await switcher.refresh();
		expect(switcher.getSnapshot().sessions?.live.map(session => session.id)).toEqual(["a", "b"]);
		expect(switcher.getSnapshot().sessions?.recent.map(session => session.id)).toEqual(["old"]);
		expect(switcher.getSnapshot().listError?.kind).toBe("network");
		expect(switcher.getSnapshot().authFailed).toBe(false);

		api.list = { live: [summary("a")], recent: [] };
		await switcher.refresh();
		expect(switcher.getSnapshot().listError).toBeNull();
		expect(switcher.getSnapshot().sessions?.live.map(session => session.id)).toEqual(["a"]);
		expect(switcher.getSnapshot().sessions?.recent).toEqual([]);
	});

	it("flags an authorization failure until a list request succeeds again", async () => {
		const { api, switcher } = rig();
		api.list = new DeckApiError("auth", 401, "owner identity required");
		await switcher.refresh();
		expect(switcher.getSnapshot().authFailed).toBe(true);
		expect(switcher.getSnapshot().listError?.kind).toBe("auth");

		api.list = { live: [], recent: [] };
		await switcher.refresh();
		expect(switcher.getSnapshot().authFailed).toBe(false);
	});

	it("a failing health endpoint does not hide the session list", async () => {
		const { api, switcher } = rig();
		api.healthResult = new DeckApiError("server", 500, "boom");
		await switcher.refresh();
		expect(switcher.getSnapshot().sessions?.live).toHaveLength(2);
		expect(switcher.getSnapshot().listError).toBeNull();
	});
});

describe("selecting a session", () => {
	it("requests the room link, then opens exactly one guest connection", async () => {
		const { switcher, api, log, clients } = rig();
		await switcher.select("a");
		expect(api.roomCalls).toEqual(["a"]);
		expect(api.roomPermissions).toEqual(["full"]);
		expect(log).toEqual(["connect link-a"]);
		expect(switcher.getSnapshot()).toMatchObject({ selectedId: "a", client: clients[0], busy: false });
	});

	it("shows the row as waking while a resumed room link is pending", async () => {
		const { switcher, api } = rig();
		await switcher.select("a");
		api.list = { live: [summary("a", { state: "asleep" })], recent: [] };
		await switcher.refresh();
		const room = Promise.withResolvers<RoomLinkResponse>();
		api.rooms.set("a", () => room.promise);

		const opening = switcher.select("a");
		expect(switcher.getSnapshot()).toMatchObject({ busy: true, wakingId: "a" });
		expect(switcher.getSnapshot().sessions?.live.find(session => session.id === "a")?.state).toBe("waking");
		await settle();
		expect(api.roomCalls).toEqual(["a", "a"]);
		room.resolve({ roomId: "a", link: "link-a", permission: "full" });
		await opening;
		expect(switcher.getSnapshot()).toMatchObject({ busy: false, wakingId: null, selectedId: "a" });
		expect(switcher.getSnapshot().sessions?.live.find(session => session.id === "a")?.state).toBe("idle");
	});

	it("switching closes the old guest exactly once and opens the new one exactly once", async () => {
		const { switcher, log, clients } = rig();
		await switcher.select("a");
		await switcher.select("b");
		expect(log).toEqual(["connect link-a", "close link-a", "connect link-b"]);
		expect(clients.map(c => [c.connects, c.closes])).toEqual([
			[1, 1],
			[1, 0],
		]);
		expect(switcher.getSnapshot().selectedId).toBe("b");
	});

	it("a failed room-link request leaves the current session connected and reports the error", async () => {
		const { switcher, api, log, clients } = rig();
		await switcher.select("a");
		api.rooms.set("b", async () => {
			throw new DeckApiError("server", 500, "worker exploded");
		});
		await switcher.select("b");
		expect(log).toEqual(["connect link-a"]);
		expect(clients[0]!.closes).toBe(0);
		const snap = switcher.getSnapshot();
		expect(snap).toMatchObject({ selectedId: "a", client: clients[0], busy: false, actionError: "worker exploded" });
	});

	it("a link the client rejects leaves the current session connected", async () => {
		const { switcher, log } = rig({ throwOnLink: "link-b" });
		await switcher.select("a");
		await switcher.select("b");
		expect(log).toEqual(["connect link-a"]);
		expect(switcher.getSnapshot()).toMatchObject({ selectedId: "a", actionError: "bad link" });
	});

	it("an authorization failure on the room link surfaces the auth state", async () => {
		const { switcher, api } = rig();
		api.rooms.set("a", async () => {
			throw new DeckApiError("auth", 403, "forbidden");
		});
		await switcher.select("a");
		expect(switcher.getSnapshot()).toMatchObject({ authFailed: true, client: null });
	});

	it("overlapping selections resolve to the latest; the superseded one never connects", async () => {
		const { switcher, api, log } = rig();
		const slow = Promise.withResolvers<RoomLinkResponse>();
		api.rooms.set("a", () => slow.promise);
		const first = switcher.select("a");
		await switcher.select("b");
		slow.resolve({ roomId: "a", link: "link-a", permission: "full" });
		await first;
		expect(log).toEqual(["connect link-b"]);
		expect(switcher.getSnapshot().selectedId).toBe("b");
	});

	it("waits out a worker that is still starting (409) and then connects once", async () => {
		const { switcher, api, log } = rig();
		let attempts = 0;
		api.rooms.set("a", async () => {
			if (++attempts <= 3) throw new DeckApiError("conflict", 409, "worker starting");
			return { roomId: "a", link: "link-a", permission: "full" };
		});
		await switcher.select("a");
		expect(attempts).toBe(4);
		expect(log).toEqual(["connect link-a"]);
	});

	it("gives up on a worker that never becomes ready and keeps the current session", async () => {
		const { switcher, api, log } = rig();
		await switcher.select("a");
		api.rooms.set("b", async () => {
			throw new DeckApiError("conflict", 409, "worker starting");
		});
		await switcher.select("b");
		expect(log).toEqual(["connect link-a"]);
		expect(switcher.getSnapshot().actionError).toBe("worker starting");
	});

	it("selecting the connected session revives it instead of opening a second guest", async () => {
		const { switcher, api, clients } = rig();
		await switcher.select("a");
		await switcher.select("a");
		expect(api.roomCalls).toEqual(["a"]);
		expect(clients).toHaveLength(1);
		expect(clients[0]!.reconnects).toBe(1);
	});

	it("selecting an ended session fetches a fresh room link and replaces the dead guest", async () => {
		const { switcher, api, log, clients } = rig();
		await switcher.select("a");
		clients[0]!.canReconnect = false;
		await switcher.select("a");
		expect(api.roomCalls).toEqual(["a", "a"]);
		expect(log).toEqual(["connect link-a", "reconnect link-a", "close link-a", "connect link-a"]);
	});
});

describe("session actions", () => {
	it("create starts the session and connects to the room it returns", async () => {
		const { switcher, api, log } = rig();
		await switcher.create({ cwd: "/work/new", model: "opus" });
		expect(api.created).toEqual([{ cwd: "/work/new", model: "opus" }]);
		expect(log).toEqual(["connect link-new"]);
		expect(switcher.getSnapshot().selectedId).toBe("new");
	});

	it("a failed create keeps the current session and shows the daemon's message", async () => {
		const { switcher, api, log } = rig();
		await switcher.select("a");
		api.createResult = new DeckApiError("bad-request", 400, "cwd does not exist");
		await switcher.create({ cwd: "/nope" });
		expect(log).toEqual(["connect link-a"]);
		expect(switcher.getSnapshot()).toMatchObject({ selectedId: "a", actionError: "cwd does not exist" });
	});

	it("continues a session this daemon hosted in place, but opens a terminal session as a titled copy", async () => {
		const { switcher, api } = rig();
		await switcher.resume(summary("old"));
		await switcher.resume(summary("term", { source: "terminal", title: "Fix the login form" }));
		expect(api.created).toEqual([
			{ cwd: "/work/old", resumeSessionFile: "/work/old/s.jsonl" },
			{ cwd: "/work/term", forkFrom: { sessionFile: "/work/term/s.jsonl" }, title: "Fix the login form" },
		]);
	});

	it("fork sends the source file; a never-saved session cannot be forked and nothing is requested", async () => {
		const { switcher, api } = rig();
		await switcher.fork(summary("a"));
		expect(api.created).toEqual([{ cwd: "/work/a", forkFrom: { sessionFile: "/work/a/s.jsonl" } }]);

		await switcher.fork(summary("b", { sessionFile: undefined }));
		expect(api.created).toHaveLength(1);
		expect(switcher.getSnapshot().actionError).toContain("never saved");
	});

	it("routes saved-session opens and forks to the source machine", async () => {
		const { switcher, api } = rig();
		await switcher.resume(summary("old", { source: "terminal" }), "vps");
		await switcher.fork(summary("a"), "vps");
		expect(api.created).toEqual([
			{ cwd: "/work/old", forkFrom: { sessionFile: "/work/old/s.jsonl" } },
			{ cwd: "/work/a", forkFrom: { sessionFile: "/work/a/s.jsonl" } },
		]);
		expect(api.createTargets).toEqual(["vps", "vps"]);
	});

	it("stopping the connected session closes its guest and clears the selection", async () => {
		const { switcher, api, log } = rig();
		await switcher.select("a");
		await switcher.stop("a");
		expect(api.stopped).toEqual(["a"]);
		expect(log).toEqual(["connect link-a", "close link-a"]);
		expect(switcher.getSnapshot()).toMatchObject({ selectedId: null, client: null });
	});

	it("stopping a background session leaves the connected one alone; a failed stop is reported", async () => {
		const { switcher, api, log } = rig();
		await switcher.select("a");
		await switcher.stop("b");
		expect(log).toEqual(["connect link-a"]);
		api.stopResult = new DeckApiError("server", 500, "cannot stop");
		await switcher.stop("b");
		expect(switcher.getSnapshot().actionError).toBe("cannot stop");
	});
});

describe("polling and page lifecycle", () => {
	it("polls every 3 s while visible, stops while hidden, and refreshes at once when visible again", async () => {
		vi.useFakeTimers();
		const { switcher, api, lifecycle } = rig();
		let lists = 0;
		const original = api.listSessions.bind(api);
		api.listSessions = async () => {
			lists++;
			return original();
		};
		switcher.start();
		expect(lists).toBe(1);
		await settle();

		vi.advanceTimersByTime(3_000);
		await settle();
		vi.advanceTimersByTime(3_000);
		await settle();
		expect(lists).toBe(3);

		lifecycle.emit("hidden");
		vi.advanceTimersByTime(30_000);
		await settle();
		expect(lists).toBe(3);

		lifecycle.emit("visible");
		expect(lists).toBe(4);
		await settle();
		vi.advanceTimersByTime(3_000);
		await settle();
		expect(lists).toBe(5);
		switcher.dispose();
	});

	it("starting while the page is hidden does not poll", async () => {
		vi.useFakeTimers();
		const { switcher, api, lifecycle } = rig();
		let lists = 0;
		const original = api.listSessions.bind(api);
		api.listSessions = async () => {
			lists++;
			return original();
		};
		lifecycle.hidden = true;
		switcher.start();
		vi.advanceTimersByTime(10_000);
		await settle();
		expect(lists).toBe(1);
		await settle();
		switcher.dispose();
	});

	it("page visible or network back revives the connected guest once per signal", async () => {
		const { switcher, clients, lifecycle } = rig();
		await switcher.select("a");
		switcher.start();
		lifecycle.emit("visible");
		expect(clients[0]!.reconnects).toBe(1);
		lifecycle.emit("online");
		expect(clients[0]!.reconnects).toBe(2);
		expect(clients).toHaveLength(1);
		switcher.dispose();
	});

	it("an ended session on resume is replaced from a fresh room link", async () => {
		const { switcher, api, clients, log, lifecycle } = rig();
		await switcher.select("a");
		switcher.start();
		clients[0]!.canReconnect = false;
		lifecycle.emit("visible");
		await settle();
		expect(clients).toHaveLength(2);
		expect(api.roomCalls).toEqual(["a", "a"]);
		expect(log.filter(entry => entry === "connect link-a")).toHaveLength(2);
		expect(clients[0]!.closes).toBe(1);
		switcher.dispose();
	});

	it("dispose closes the guest, stops polling and detaches the lifecycle listeners", async () => {
		vi.useFakeTimers();
		const { switcher, clients, lifecycle, api } = rig();
		await switcher.select("a");
		switcher.start();
		switcher.dispose();
		expect(clients[0]!.closes).toBe(1);
		expect(lifecycle.listenerCount).toBe(0);
		const before = api.roomCalls.length;
		vi.advanceTimersByTime(10_000);
		await settle();
		expect(api.roomCalls.length).toBe(before);
	});
});

describe("spawn (pane host opens the session itself)", () => {
	it("creates the session and returns its summary without connecting a guest", async () => {
		const { switcher, api, clients } = rig();
		const summary = await switcher.spawn({ cwd: "/work/new" });
		expect(summary?.id).toBe("new");
		expect(api.created).toEqual([{ cwd: "/work/new" }]);
		expect(api.roomCalls).toEqual([]);
		expect(clients).toHaveLength(0);
		expect(switcher.getSnapshot()).toMatchObject({ client: null, selectedId: null, busy: false, actionError: null });
	});

	it("returns null and records the error when the daemon refuses", async () => {
		const { switcher, api } = rig();
		api.createResult = new DeckApiError("auth", 401, "owner identity required");
		expect(await switcher.spawn({ cwd: "/work/x" })).toBeNull();
		expect(switcher.getSnapshot()).toMatchObject({ busy: false, actionError: "owner identity required", authFailed: true });
	});
	it("keeps the original create request and target machine with a worker-limit sleep candidate", async () => {
		const { switcher, api } = rig();
		const request: CreateSessionRequest = {
			cwd: "/work/new",
			createDirectory: true,
			model: "openai-codex/gpt-6-luna",
		};
		const candidate = { id: "old/idle", title: "Oldest idle session", idleMinutes: 12 };
		api.createResult = new DeckApiError("conflict", 409, "worker limit reached", candidate);

		expect(await switcher.spawn(request, "vps")).toBeNull();
		expect(switcher.getSnapshot().sleepCandidateRetry).toEqual({
			candidate,
			request,
			machineId: "vps",
		});
	});

	it("waking an asleep session at the worker limit offers the sleep candidate at once, as a resume of its file", async () => {
		const { switcher, api } = rig();
		api.list = { live: [summary("studio:a", { state: "asleep", sessionFile: "/sessions/a.jsonl" })], recent: [] };
		await switcher.refresh();
		const candidate = { id: "idle-old", title: "Oldest idle session", idleMinutes: 30 };
		api.rooms.set("studio:a", async () => {
			throw new DeckApiError("conflict", 409, "worker limit reached", candidate);
		});

		await switcher.select("studio:a");
		expect(api.roomCalls).toEqual(["studio:a"]);
		expect(switcher.getSnapshot().sleepCandidateRetry).toEqual({
			candidate,
			request: { cwd: "/work/studio:a", resumeSessionFile: "/sessions/a.jsonl" },
			machineId: "studio",
		});
	});

	it("recent session opens and forks require a saved file and never call the daemon without one", async () => {
		const { switcher, api } = rig();
		expect(await switcher.spawnResume(summary("x", { sessionFile: undefined }))).toBeNull();
		expect(switcher.getSnapshot().actionError).toContain("no session file to open");
		expect(await switcher.spawnFork(summary("x", { sessionFile: undefined }))).toBeNull();
		expect(switcher.getSnapshot().actionError).toContain("cannot be forked");
		expect(api.created).toEqual([]);
		await switcher.spawnResume(summary("old", { source: "terminal" }));
		await switcher.spawnFork(summary("a"));
		expect(api.created).toEqual([
			{ cwd: "/work/old", forkFrom: { sessionFile: "/work/old/s.jsonl" } },
			{ cwd: "/work/a", forkFrom: { sessionFile: "/work/a/s.jsonl" } },
		]);
	});

	it("keeps the saved-model retry for explicit daemon resume requests", async () => {
		const { switcher, api } = rig();
		api.createResult = new DeckApiError("server", 500, "Could not restore model anthropic/claude-opus-5");
		expect(await switcher.spawn({ cwd: "/work/old", resumeSessionFile: "/work/old/s.jsonl" })).toBeNull();
		expect(switcher.getSnapshot().resumeModelRetry).toMatchObject({ missingModel: "anthropic/claude-opus-5" });
		api.createResult = summary("old");
		await switcher.retryResumeWithModel("anthropic/claude-sonnet-5-5:xhigh");
		expect(api.created.at(-1)).toEqual({ cwd: "/work/old", resumeSessionFile: "/work/old/s.jsonl", model: "anthropic/claude-sonnet-5-5:xhigh" });
		expect(switcher.getSnapshot().resumeModelRetry).toBeNull();
	});

	it("does not offer the model retry for other failures or for a new session", async () => {
		const { switcher, api } = rig();
		api.createResult = new DeckApiError("server", 500, "cwd does not exist");
		await switcher.spawnResume(summary("old"));
		expect(switcher.getSnapshot().resumeModelRetry).toBeNull();
		api.createResult = new DeckApiError("server", 500, "Could not restore model x/y");
		await switcher.spawn({ cwd: "/work/new" });
		expect(switcher.getSnapshot().resumeModelRetry).toBeNull();
	});
});
