import { afterEach, describe, expect, it, vi } from "bun:test";
import type { HostFrame, SessionEntry, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { importRoomKey, open } from "../src/lib/codec";
import { browserLifecycle, type VisibilityTarget } from "../src/lib/lifecycle";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink, unpackEnvelope } from "../src/lib/link";
import { SessionSwitcher, type SwitcherApi } from "../src/lib/switcher";
import type { OfflineCachedTranscript } from "../src/lib/offline-cache/types";
import { offlineCachedEntriesPartial } from "../src/lib/offline-cache/view";

const NativeWebSocket = globalThis.WebSocket;
const KEY = encodeBase64Url(new Uint8Array(32));
const LINK = `resume-room-0001#${KEY}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readonly sent: Uint8Array[] = [];
	readyState = ScriptedWebSocket.CONNECTING;
	closedByClient = false;

	constructor(url: string | URL) {
		this.url = String(url);
		ScriptedWebSocket.instances.push(this);
	}
	send(data: unknown): void {
		if (!(data instanceof Uint8Array)) throw new TypeError("expected encrypted websocket bytes");
		this.sent.push(data);
	}
	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}
	/** The relay or network closes the socket. */
	relayClose(code: number, reason: string): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}
	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.closedByClient = true;
		this.relayClose(code, reason);
	}
}

function entry(id: string, text: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-06-12T00:00:01Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function cachedTranscript(entries: SessionEntry[], leafId: string | null): OfflineCachedTranscript {
	return {
		metadata: {
			key: "machine:s1",
			title: "Cached transcript",
			cwd: "/work",
			replicaToken: "replica-cache",
			entryCount: entries.length,
			tailEntryId: entries.at(-1)?.id ?? null,
			leafId,
			lastViewedAt: Date.now(),
			lastEntryAt: Date.parse("2026-06-12T00:00:01Z"),
			bytes: 128,
			partial: false,
			archivedAt: null,
			live: false,
			waitingOnYou: false,
			unfinished: true,
		},
		entries,
	};
}

async function firstSentBytes(socket: ScriptedWebSocket): Promise<Uint8Array> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const sent = socket.sent[0];
		if (sent) return sent;
		await Bun.sleep(1);
	}
	throw new Error("guest hello was not sent");
}

function welcome(entryCount: number): HostFrame {
	return { t: "welcome", proto: COLLAB_PROTO, header: HEADER, state: STATE, agents: [], entryCount };
}

function ids(client: GuestClient): string[] {
	return client.getSnapshot().entries.map(e => e.id);
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

/** A page: a document with a mutable `hidden`, and a window. Plain EventTargets stand in for them. */
function page(): {
	doc: EventTarget & { hidden: boolean };
	win: EventTarget;
	show(): void;
	hide(): void;
	online(): void;
	offline(): void;
} {
	const doc = Object.assign(new EventTarget(), { hidden: false });
	const win = new EventTarget();
	return {
		doc,
		win,
		show: () => {
			doc.hidden = false;
			doc.dispatchEvent(new Event("visibilitychange"));
		},
		hide: () => {
			doc.hidden = true;
			doc.dispatchEvent(new Event("visibilitychange"));
		},
		online: () => win.dispatchEvent(new Event("online")),
		offline: () => win.dispatchEvent(new Event("offline")),
	};
}

describe("browser lifecycle network signals", () => {
	it("publishes offline and online transitions in order", () => {
		const p = page();
		const events: string[] = [];
		const unsubscribe = browserLifecycle(p.doc as VisibilityTarget, p.win).subscribe(event => events.push(event));

		p.offline();
		p.online();
		unsubscribe();

		expect(events).toEqual(["offline", "online"]);
	});
});

/** A switcher driving a real GuestClient over scripted sockets, connected to one session. */
async function connectedRig(): Promise<{
	client: GuestClient;
	switcher: SessionSwitcher<GuestClient>;
	p: ReturnType<typeof page>;
}> {
	const p = page();
	const api: SwitcherApi = {
		listSessions: async () => ({ live: [], recent: [] }),
		health: async () => ({ version: 1, startedAt: 1, workers: [], guests: 0, stalledAfterMs: 60_000 }),
		createSession: async () => {
			throw new Error("unused");
		},
		roomLink: async () => ({ roomId: "resume-room-0001", link: LINK, permission: "full" }),
		stopSession: async () => {},
	};
	const switcher = new SessionSwitcher<GuestClient>({
		api,
		name: "me",
		lifecycle: browserLifecycle(p.doc as VisibilityTarget, p.win, () => true),
		createClient: (link, name) => new GuestClient(link, name),
	});
	await switcher.select("s1");
	switcher.start();
	const client = switcher.getSnapshot().client;
	if (!client) throw new Error("no client");
	instance(0).open();
	client.applyFrameForTest(welcome(3));
	client.applyFrameForTest({
		t: "snapshot-chunk",
		entries: [entry("e1", "one"), entry("e2", "two"), entry("e3", "three")],
		final: true,
	});
	return { client, switcher, p };
}

function installScriptedWebSocket(): void {
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
}

afterEach(() => {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("resuming a backgrounded page", () => {
	it("replaces a socket that died silently, once, and resyncs without duplicating entries", async () => {
		installScriptedWebSocket();
		const { client, switcher, p } = await connectedRig();
		expect(client.getSnapshot().phase).toBe("live");
		expect(ids(client)).toEqual(["e1", "e2", "e3"]);

		// iOS suspended the tab: no close event ever arrives for instance 0.
		p.hide();
		p.show();
		p.online(); // both signals fire back to back on resume
		expect(ScriptedWebSocket.instances).toHaveLength(2);
		expect(instance(0).closedByClient).toBe(true);
		expect(client.getSnapshot().phase).toBe("reconnecting");

		// The host replays the whole transcript, plus an entry written while we were away.
		instance(1).open();
		expect(client.getSnapshot().phase).toBe("reconnecting");
		client.applyFrameForTest(welcome(4));
		// A live entry racing the snapshot is also contained in the snapshot.
		client.applyFrameForTest({ t: "entry", entry: entry("e4", "four") });
		client.applyFrameForTest({
			t: "snapshot-chunk",
			entries: [entry("e1", "one"), entry("e2", "two"), entry("e3", "three"), entry("e4", "four")],
			final: true,
		});
		expect(client.getSnapshot().phase).toBe("live");
		expect(ids(client)).toEqual(["e1", "e2", "e3", "e4"]);

		// The host re-broadcasts an entry we already show.
		client.applyFrameForTest({ t: "entry", entry: entry("e4", "four") });
		expect(ids(client)).toEqual(["e1", "e2", "e3", "e4"]);
		expect(ScriptedWebSocket.instances).toHaveLength(2);
		switcher.dispose();
	});

	it("keeps the transcript on screen while resyncing", async () => {
		installScriptedWebSocket();
		const { client, switcher, p } = await connectedRig();
		p.show();
		instance(1).open();
		client.applyFrameForTest(welcome(3));
		expect(ids(client)).toEqual(["e1", "e2", "e3"]);
		expect(client.getSnapshot().loading).toEqual({ received: 0, total: 3 });
		switcher.dispose();
	});

	it("does not open a socket while the page stays hidden", async () => {
		installScriptedWebSocket();
		const { switcher, p } = await connectedRig();
		p.hide();
		expect(ScriptedWebSocket.instances).toHaveLength(1);
		switcher.dispose();
	});

	it("network back skips the remaining backoff delay", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const { client, switcher, p } = await connectedRig();

		instance(0).relayClose(1006, "");
		expect(client.getSnapshot().phase).toBe("reconnecting");
		expect(ScriptedWebSocket.instances).toHaveLength(1); // waiting out the 1 s backoff

		p.online();
		expect(ScriptedWebSocket.instances).toHaveLength(2);

		// The cancelled retry timer must not open a third socket.
		vi.advanceTimersByTime(60_000);
		expect(ScriptedWebSocket.instances).toHaveLength(2);
		switcher.dispose();
	});

	it("backs off exponentially across repeated failures", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const { switcher } = await connectedRig();

		instance(0).relayClose(1006, "");
		vi.advanceTimersByTime(999);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(ScriptedWebSocket.instances).toHaveLength(2);

		instance(1).relayClose(1006, "");
		vi.advanceTimersByTime(1_999);
		expect(ScriptedWebSocket.instances).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(ScriptedWebSocket.instances).toHaveLength(3);
		switcher.dispose();
	});

	it("sends the cached replica cursor and reconciles the host delta without a full snapshot", async () => {
		installScriptedWebSocket();
		const cachedEntry = entry("cached-entry", "persisted");
		const client = new GuestClient(null, "tester");
		client.setOfflineCacheKey("machine:s1");
		client.hydrateOfflineTranscript(cachedTranscript([cachedEntry], cachedEntry.id));
		client.connect(LINK);
		const socket = instance(0);
		socket.open();

		try {
			const envelope = unpackEnvelope(await firstSentBytes(socket));
			if (!envelope) throw new Error("guest hello envelope is malformed");
			const parsed = parseCollabLink(LINK);
			if ("error" in parsed) throw new Error(parsed.error);
			const hello = await open(await importRoomKey(parsed.key), envelope.payload);
			expect(hello).toMatchObject({
				t: "hello",
				resume: { token: "replica-cache", entryId: "cached-entry", count: 1 },
			});
			expect(client.getSnapshot()).toMatchObject({ cached: true, phase: "reconnecting", entries: [cachedEntry] });

			const deltaWelcome = welcome(1);
			if (deltaWelcome.t !== "welcome") throw new Error("expected welcome frame");
			client.applyFrameForTest({
				...deltaWelcome,
				replicaToken: "replica-cache",
				resumeBase: 1,
				state: { ...STATE, leafId: "new-entry" },
			});
			client.applyFrameForTest({
				t: "snapshot-chunk",
				entries: [entry("new-entry", "new message", cachedEntry.id)],
				final: true,
			});

			expect(ScriptedWebSocket.instances).toHaveLength(1);
			expect(ids(client)).toEqual(["cached-entry", "new-entry"]);
			expect(client.getSnapshot()).toMatchObject({ cached: false, phase: "live" });
		} finally {
			client.close();
		}
	});
	it("hides the cached transcript notice after an unchanged resume goes live", () => {
		const cachedEntry = entry("cached-entry", "persisted");
		const client = new GuestClient(null, "tester");
		client.hydrateOfflineTranscript(cachedTranscript([cachedEntry], cachedEntry.id));
		expect(offlineCachedEntriesPartial(client.getSnapshot().entries)).toBe(false);

		const resumeWelcome = welcome(0);
		if (resumeWelcome.t !== "welcome") throw new Error("expected welcome frame");
		client.applyFrameForTest({
			...resumeWelcome,
			replicaToken: "replica-cache",
			resumeBase: 1,
			state: { ...STATE, leafId: cachedEntry.id },
		});

		expect(client.getSnapshot()).toMatchObject({ cached: false, phase: "live", entries: [cachedEntry] });
		expect(offlineCachedEntriesPartial(client.getSnapshot().entries)).toBeUndefined();
		client.close();
	});
	it("applies a different active leaf from a valid resumed branch delta", () => {
		const root = entry("root", "root");
		const cachedTip = entry("cached-tip", "old branch", root.id);
		const client = new GuestClient(null, "tester");
		client.hydrateOfflineTranscript(cachedTranscript([root, cachedTip], cachedTip.id));
		const deltaWelcome = welcome(1);
		if (deltaWelcome.t !== "welcome") throw new Error("expected welcome frame");
		client.applyFrameForTest({
			...deltaWelcome,
			replicaToken: "replica-cache",
			resumeBase: 2,
			state: { ...STATE, leafId: "new-tip" },
		});
		client.applyFrameForTest({
			t: "snapshot-chunk",
			entries: [entry("new-tip", "new branch", root.id)],
			final: true,
		});

		expect(ids(client)).toEqual(["root", "new-tip"]);
		expect(client.getSnapshot()).toMatchObject({ cached: false, phase: "live" });
		client.close();
	});

	it("replaces cached branch entries when the host reports a different leaf", () => {
		const cachedEntry = entry("cached-tip", "old branch");
		const client = new GuestClient(null, "tester");
		client.hydrateOfflineTranscript(cachedTranscript([cachedEntry], cachedEntry.id));
		const resumeWelcome = welcome(1);
		if (resumeWelcome.t !== "welcome") throw new Error("expected welcome frame");
		client.applyFrameForTest({ ...resumeWelcome, resumeBase: 1, state: { ...STATE, leafId: "new-tip" } });

		const fullWelcome = welcome(1);
		if (fullWelcome.t !== "welcome") throw new Error("expected welcome frame");
		client.applyFrameForTest({ ...fullWelcome, replicaToken: "replica-new", state: { ...STATE, leafId: "new-tip" } });
		client.applyFrameForTest({ t: "snapshot-chunk", entries: [entry("new-tip", "new branch")], final: true });

		expect(ids(client)).toEqual(["new-tip"]);
		expect(client.getSnapshot()).toMatchObject({ cached: false, phase: "live" });
		client.close();
	});

	it("an ended session is not revived by the socket; the switcher opens a new guest", async () => {
		installScriptedWebSocket();
		const { client, switcher, p } = await connectedRig();
		client.applyFrameForTest({ t: "bye", reason: "host stopped" });
		expect(client.getSnapshot().phase).toBe("ended");
		expect(client.reconnect()).toBe(false);

		p.show();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		const replacement = switcher.getSnapshot().client;
		expect(replacement).not.toBe(client);
		switcher.dispose();
	});
});
