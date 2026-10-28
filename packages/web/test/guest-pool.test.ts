import { describe, expect, it } from "bun:test";
import type { CreateSessionRequest, RoomLinkResponse, SessionSummary } from "@omp-console/protocol";
import { DeckApiError } from "../src/lib/api";
import { GuestPool } from "../src/lib/guest-pool";
import { promptHistory } from "../src/lib/prompt-history";
import type { SessionClient } from "../src/lib/switcher";

class FakeClient implements SessionClient {
	connects = 0;
	closes = 0;
	reconnects = 0;
	canReconnect = true;
	roomMissing = false;
	canRestartAfterLoss = false;
	restartContext: { cwd: string; prompt: string; model?: string } | null = null;
	readonly #listeners = new Set<() => void>();

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
		return this.canReconnect;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	loseRoom(): void {
		this.roomMissing = true;
		for (const listener of this.#listeners) listener();
	}

	markUnrestorableAfterRestart(): boolean {
		if (!this.roomMissing || this.restartContext === null) return false;
		this.canRestartAfterLoss = true;
		for (const listener of this.#listeners) listener();
		return true;
	}

	hostClosed = false;
	endedAfterHostClose = false;
	endAfterHostClose(): boolean {
		if (!this.roomMissing || !this.hostClosed) return false;
		this.roomMissing = false;
		this.endedAfterHostClose = true;
		return true;
	}

	getRestartContext(): { cwd: string; prompt: string; model?: string } | null {
		return this.canRestartAfterLoss ? this.restartContext : null;
	}
}



interface Rig {
	pool: GuestPool<FakeClient>;
	clients: FakeClient[];
	log: string[];
	roomCalls: string[];
	creates: Array<{ request: CreateSessionRequest; machineId: string | undefined }>;
	stops: string[];
	/** Per-session room handler; override to model a slow or failing daemon. */
	rooms: Map<string, () => Promise<RoomLinkResponse>>;
}


function rig(createSession?: (summary: SessionSummary) => Promise<SessionSummary>): Rig {
	const clients: FakeClient[] = [];
	const log: string[] = [];
	const roomCalls: string[] = [];
	const creates: Array<{ request: CreateSessionRequest; machineId: string | undefined }> = [];
	const stops: string[] = [];
	const rooms = new Map<string, () => Promise<RoomLinkResponse>>();
	let generation = 0;
	const pool = new GuestPool<FakeClient>({
		api: {
			async roomLink(sessionId) {
				roomCalls.push(sessionId);
				const handler = rooms.get(sessionId);
				if (handler) return handler();
				return { roomId: sessionId, link: `link-${sessionId}-${++generation}`, permission: "full" };
			},
			async createSession(request, machineId) {
				creates.push({ request, machineId });
				const summary: SessionSummary = {
					id: `${machineId === undefined ? "" : `${machineId}:`}restarted-${creates.length}`,
					cwd: request.cwd,
					model: request.model,
					state: "idle",
					createdAt: 1,
					lastActivityAt: 1,
					agentCount: 0,
					goalActive: false,
					awaitingAnswer: false,
				};
				return createSession === undefined ? summary : createSession(summary);
			},
			async stopSession(sessionId) {
				stops.push(sessionId);
			},
		},
		createClient(link) {
			const client = new FakeClient(link ?? "cached", log);
			clients.push(client);
			return client;
		},
		name: "tester",
		sleep: async () => {},
	});
	return { pool, clients, log, roomCalls, creates, stops, rooms };
}

/** Lets pending room-link promises settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise(resolve => setTimeout(resolve, 0));
}

describe("GuestPool", () => {
	it("connects several sessions at once", async () => {
		const { pool, clients } = rig();
		pool.sync(["a", "b", "c"]);
		await settle();
		expect([...pool.getSnapshot().clients.keys()].sort()).toEqual(["a", "b", "c"]);
		expect(clients.map(c => c.connects)).toEqual([1, 1, 1]);
		expect(clients.map(c => c.closes)).toEqual([0, 0, 0]);
	});

	it("shares one client and one room-link request when two panes want the same session", async () => {
		const { pool, clients, roomCalls } = rig();
		pool.sync(["a", "a"]);
		pool.sync(["a"]);
		await settle();
		expect(roomCalls).toEqual(["a"]);
		expect(clients).toHaveLength(1);
		// Still wanted by one pane: nothing closes.
		pool.sync(["a"]);
		expect(clients[0]!.closes).toBe(0);
		// No pane wants it: closed exactly once, even if sync repeats.
		pool.sync([]);
		pool.sync([]);
		expect(clients[0]!.closes).toBe(1);
		expect(pool.getSnapshot().clients.size).toBe(0);
	});

	it("closes only the session that left, keeping the others connected", async () => {
		const { pool, clients } = rig();
		pool.sync(["a", "b"]);
		await settle();
		pool.sync(["b"]);
		expect(clients.map(c => c.closes)).toEqual([1, 0]);
		expect([...pool.getSnapshot().clients.keys()]).toEqual(["b"]);
	});

	it("never builds a client for a session dropped while its room link was in flight", async () => {
		const { pool, clients, rooms } = rig();
		const slow = Promise.withResolvers<RoomLinkResponse>();
		rooms.set("a", () => slow.promise);
		pool.sync(["a"]);
		pool.sync([]);
		slow.resolve({ roomId: "a", link: "late", permission: "full" });
		await settle();
		expect(clients).toHaveLength(0);
		expect(pool.getSnapshot().clients.size).toBe(0);
	});

	it("keeps other sessions connected when one room link fails, and retries only on rejoin", async () => {
		const { pool, clients, rooms, roomCalls } = rig();
		rooms.set("bad", async () => {
			throw new DeckApiError("not-found", 404, "no such live session");
		});
		pool.sync(["good", "bad"]);
		await settle();
		expect([...pool.getSnapshot().clients.keys()]).toEqual(["good"]);
		expect(pool.getSnapshot().errors.get("bad")).toBe("no such live session");
		// A later sync does not hammer the daemon for the failed session.
		pool.sync(["good", "bad"]);
		await settle();
		expect(roomCalls.filter(id => id === "bad")).toHaveLength(1);
		// Fixed on the daemon side: rejoin builds the client and clears the error.
		rooms.delete("bad");
		pool.rejoin("bad");
		await settle();
		expect(pool.getSnapshot().errors.size).toBe(0);
		expect(pool.getSnapshot().clients.has("bad")).toBe(true);
		expect(clients).toHaveLength(2);
	});

	it("flags an authorization failure from a room-link request", async () => {
		const { pool, rooms } = rig();
		rooms.set("a", async () => {
			throw new DeckApiError("auth", 401, "owner identity required");
		});
		pool.sync(["a"]);
		await settle();
		expect(pool.getSnapshot().authFailed).toBe(true);
	});

	it("rejoin resumes a live connection in place, and replaces one whose session ended", async () => {
		const { pool, clients } = rig();
		pool.sync(["a"]);
		await settle();
		pool.rejoin("a");
		await settle();
		expect(clients).toHaveLength(1);
		expect(clients[0]!.reconnects).toBe(1);
		clients[0]!.canReconnect = false;
		pool.rejoin("a");
		await settle();
		expect(clients).toHaveLength(2);
		expect(clients[0]!.closes).toBe(1);
		expect(pool.getSnapshot().clients.get("a")).toBe(clients[1]!);
	});
	it("rejoins a saved session by looking up its current room from the session key", async () => {
		const { pool, clients, roomCalls } = rig();
		const key = "studio:saved-session";
		pool.sync([key]);
		await settle();
		const old = clients[0];
		if (!old) throw new Error("initial guest was not created");
		old.loseRoom();
		await settle();

		expect(roomCalls).toEqual([key, key]);
		expect(clients).toHaveLength(2);
		expect(pool.getSnapshot().clients.get(key)).toBe(clients[1]);
		expect(old.closes).toBe(1);
	});

	it("creates a same-model session with the lost prompt as a draft after an unsaved first-turn 404", async () => {
		const { pool, clients, creates, rooms } = rig();
		const key = "studio:first-turn";
		pool.sync([key]);
		await settle();
		const old = clients[0];
		if (!old) throw new Error("initial guest was not created");
		old.restartContext = { cwd: "/work/project", prompt: "repeat the interrupted prompt", model: "stub/stub-model" };
		rooms.set(key, async () => {
			throw new DeckApiError("not-found", 404, "no such live session");
		});
		old.loseRoom();
		await settle();

		expect(pool.getSnapshot().clients.get(key)).toBe(old);
		expect(old.canRestartAfterLoss).toBe(true);
		expect(pool.getSnapshot().errors.has(key)).toBe(false);
		const browser = { location: { hash: "" } };
		const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
		try {
			pool.rejoin(key);
			await settle();

			expect(creates).toEqual([
				{ request: { cwd: "/work/project", model: "stub/stub-model" }, machineId: "studio" },
			]);
			expect(promptHistory.loadDraft("restarted-1")).toBe("repeat the interrupted prompt");
			expect(browser.location.hash).toBe("#session=studio%3Arestarted-1");
		} finally {
			promptHistory.saveDraft("restarted-1", "");
			promptHistory.saveDraft("studio:restarted-1", "");
			pool.dispose();
			if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
			else Reflect.deleteProperty(globalThis, "window");
		}
	});

	it("ends a host-closed session in place when its room lookup finds no session", async () => {
		const { pool, clients, rooms } = rig();
		const key = "studio:ended";
		pool.sync([key]);
		await settle();
		const old = clients[0];
		if (!old) throw new Error("initial guest was not created");
		old.hostClosed = true;
		rooms.set(key, async () => {
			throw new DeckApiError("not-found", 404, "no such live session");
		});
		old.loseRoom();
		await settle();

		expect(old.endedAfterHostClose).toBe(true);
		expect(pool.getSnapshot().clients.get(key)).toBe(old);
		expect(pool.getSnapshot().errors.has(key)).toBe(false);
		expect(old.closes).toBe(0);
	});


	it("starts one replacement session while Start again is pending", async () => {
		const createGate = Promise.withResolvers<SessionSummary>();
		let creating: SessionSummary | null = null;
		const { pool, clients, creates, rooms } = rig(summary => {
			creating = summary;
			return createGate.promise;
		});
		const key = "studio:first-turn";
		pool.sync([key]);
		await settle();
		const old = clients[0];
		if (!old) throw new Error("initial guest was not created");
		old.restartContext = { cwd: "/work/project", prompt: "repeat the interrupted prompt" };
		rooms.set(key, async () => {
			throw new DeckApiError("not-found", 404, "no such live session");
		});
		old.loseRoom();
		await settle();
		const browser = { location: { hash: "" } };
		const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
		try {
			pool.rejoin(key);
			pool.rejoin(key);

			expect(creates).toHaveLength(1);
			if (creating === null) throw new Error("replacement session creation did not start");
			createGate.resolve(creating);
			await settle();
		} finally {
			promptHistory.saveDraft("restarted-1", "");
			promptHistory.saveDraft("studio:restarted-1", "");
			pool.dispose();
			if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
			else Reflect.deleteProperty(globalThis, "window");
		}
	});

	it("stops a replacement session if its pane closes during creation", async () => {
		const createGate = Promise.withResolvers<SessionSummary>();
		let creating: SessionSummary | null = null;
		const { pool, clients, rooms, stops } = rig(summary => {
			creating = summary;
			return createGate.promise;
		});
		const key = "studio:first-turn";
		pool.sync([key]);
		await settle();
		const old = clients[0];
		if (!old) throw new Error("initial guest was not created");
		old.restartContext = { cwd: "/work/project", prompt: "repeat the interrupted prompt" };
		rooms.set(key, async () => {
			throw new DeckApiError("not-found", 404, "no such live session");
		});
		old.loseRoom();
		await settle();

		pool.rejoin(key);
		pool.sync([]);
		if (creating === null) throw new Error("replacement session creation did not start");
		createGate.resolve(creating);
		await settle();

		expect(stops).toEqual(["studio:restarted-1"]);
	});


	it("revive resumes every connection and replaces only the ended ones", async () => {
		const { pool, clients } = rig();
		pool.sync(["a", "b"]);
		await settle();
		clients[1]!.canReconnect = false;
		pool.revive();
		await settle();
		expect(clients).toHaveLength(3);
		expect(pool.getSnapshot().clients.get("a")).toBe(clients[0]!);
		expect(pool.getSnapshot().clients.get("b")).toBe(clients[2]!);
		expect(clients[1]!.closes).toBe(1);
	});

	it("connects a joined link without asking the daemon, and forgets it when no pane shows it", async () => {
		const { pool, clients, roomCalls } = rig();
		const key = pool.registerLink("wss://relay/#secret");
		pool.sync([key]);
		await settle();
		expect(roomCalls).toEqual([]);
		expect(clients[0]!.link).toBe("wss://relay/#secret");
		pool.sync([]);
		expect(clients[0]!.closes).toBe(1);
		// The link is gone with the pane: wanting the key again cannot reconnect with a stale secret.
		pool.sync([key]);
		await settle();
		expect(pool.getSnapshot().errors.has(key)).toBe(true);
		expect(clients).toHaveLength(1);
	});

	it("dispose closes every connection and ignores later work", async () => {
		const { pool, clients, log } = rig();
		pool.sync(["a", "b"]);
		await settle();
		pool.dispose();
		pool.sync(["c"]);
		await settle();
		expect(clients.map(c => c.closes)).toEqual([1, 1]);
		expect(log.filter(entry => entry.startsWith("connect"))).toHaveLength(2);
	});

	it("notifies subscribers when a client appears and when it goes", async () => {
		const { pool } = rig();
		const seen: number[] = [];
		pool.subscribe(() => seen.push(pool.getSnapshot().clients.size));
		pool.sync(["a"]);
		await settle();
		pool.sync([]);
		expect(seen).toEqual([1, 0]);
	});
});
