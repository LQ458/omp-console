import { afterEach, describe, expect, it, vi } from "bun:test";
import type { HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { GuestClient, RESTART_LOST_MESSAGE } from "../src/lib/client";
import { importRoomKey, seal } from "../src/lib/codec";
import { COLLAB_PROTO, encodeBase64Url, packEnvelope, parseCollabLink } from "../src/lib/link";

const NativeWebSocket = globalThis.WebSocket;
const LINK = `transient-network-room#${encodeBase64Url(new Uint8Array(32))}`;
const WELCOME: Extract<HostFrame, { t: "welcome" }> = {
	t: "welcome",
	proto: COLLAB_PROTO,
	header: { type: "session", id: "restarted-session", timestamp: "2026-10-26T00:00:00Z", cwd: "/work" },
	state: {
		isStreaming: false,
		queuedMessageCount: 0,
		cwd: "/work",
		model: { id: "stub-model", name: "Stub model", provider: "stub", contextWindow: null },
		participants: [{ name: "host", role: "host" }],
	},
	agents: [],
	entryCount: 0,
};

async function encryptedWelcome(entries: SessionEntry[] = []): Promise<Uint8Array[]> {
	const parsed = parseCollabLink(LINK);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const frames: HostFrame[] = [{ ...WELCOME, entryCount: entries.length }];
	if (entries.length > 0) frames.push({ t: "snapshot-chunk", entries, final: true });
	return Promise.all(frames.map(async frame => packEnvelope(0, await seal(key, frame))));
}
async function encryptedFrame(frame: HostFrame): Promise<Uint8Array> {
	const parsed = parseCollabLink(LINK);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	return packEnvelope(0, await seal(key, frame));
}


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
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(url: string | URL) {
		this.url = String(url);
		ScriptedWebSocket.instances.push(this);
	}

	send(_data: unknown): void {}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	message(data: string | Uint8Array): void {
		this.onmessage?.(new MessageEvent("message", { data }));
	}

	relayClose(code: number, reason: string): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.relayClose(code, reason);
	}
}

function installScriptedWebSocket(): void {
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
}

function restoreNativeWebSocket(): void {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

afterEach(() => {
	restoreNativeWebSocket();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("browser guest room recovery", () => {
	it("stays reconnecting while a dropped host recreates the room", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		try {
			client.connect();
			instance(0).open();
			expect(client.getSnapshot().phase).toBe("waiting");

			instance(0).message('{"t":"room-closed"}');
			expect(client.getSnapshot().phase).not.toBe("ended");
			instance(0).relayClose(4001, "room closed");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
			vi.advanceTimersByTime(1_000);
			instance(2).open();
			expect(client.getSnapshot().phase).toBe("reconnecting");
		} finally {
			client.close();
		}
	});
	it("marks an unsaved first turn lost after a previously welcomed socket loses the daemon", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");
		const joined = Promise.withResolvers<void>();
		const stop = client.subscribe(() => {
			if (client.getSnapshot().phase === "live") joined.resolve();
		});

		try {
			client.connect();
			instance(0).open();
			for (const frame of await encryptedWelcome([
				{ type: "model_change", id: "model", parentId: null, timestamp: "2026-10-26T00:00:00Z", model: "stub/stub-model" },
				{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: "2026-10-26T00:00:01Z", thinkingLevel: "high" },
			])) {
				instance(0).message(frame);
			}
			await joined.promise;
			client.sendPrompt("SLOW: interrupted first turn");

			instance(0).relayClose(1006, "daemon restarted");
			expect(client.getSnapshot().phase).toBe("reconnecting");
			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");

			expect(client.roomMissing).toBe(true);
			expect(client.getSnapshot().phase).toBe("reconnecting");
			expect(client.markUnrestorableAfterRestart()).toBe(true);
			expect(client.getSnapshot()).toMatchObject({ phase: "reconnecting", endedReason: RESTART_LOST_MESSAGE });
			expect(client.getRestartContext()).toEqual({ cwd: "/work", prompt: "SLOW: interrupted first turn", model: "stub/stub-model" });
		} finally {
			stop();
			client.close();
		}
	});
	it("uses transcript entries received after sending to distinguish an interrupted saved turn", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");
		const joined = Promise.withResolvers<void>();
		const historyReceived = Promise.withResolvers<void>();
		const stop = client.subscribe(() => {
			const snapshot = client.getSnapshot();
			if (snapshot.phase === "live") joined.resolve();
			if (snapshot.entries.some(entry => entry.id === "assistant-entry")) historyReceived.resolve();
		});

		try {
			client.connect();
			instance(0).open();
			for (const frame of await encryptedWelcome()) instance(0).message(frame);
			await joined.promise;
			client.sendPrompt("SLOW: interrupted first turn");

			const userEntry: SessionEntry = {
				type: "message",
				id: "user-entry",
				parentId: null,
				timestamp: "2026-10-26T00:00:01Z",
				message: { role: "user", content: "first prompt", timestamp: 1 },
			};
			const assistantEntry: SessionEntry = {
				type: "message",
				id: "assistant-entry",
				parentId: "user-entry",
				timestamp: "2026-10-26T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial response" }],
					model: "stub/stub-model",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				},
			};
			instance(0).message(await encryptedFrame({ t: "entry", entry: userEntry }));
			instance(0).message(await encryptedFrame({ t: "entry", entry: assistantEntry }));
			await historyReceived.promise;

			instance(0).relayClose(1006, "daemon restarted");
			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");

			expect(client.roomMissing).toBe(true);
			expect(client.markUnrestorableAfterRestart()).toBe(false);
			expect(client.getSnapshot()).toMatchObject({ phase: "reconnecting", endedReason: null });
		} finally {
			stop();
			client.close();
		}
	});


	it("does not label a saved turn as unrestorable when its room disappears", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");
		const joined = Promise.withResolvers<void>();
		const stop = client.subscribe(() => {
			if (client.getSnapshot().phase === "live") joined.resolve();
		});

		try {
			client.connect();
			instance(0).open();
			const savedPrompt: SessionEntry = {
				type: "custom_message",
				id: "saved-prompt",
				parentId: null,
				timestamp: "2026-10-26T00:00:00Z",
				customType: "prompt",
				content: "Earlier saved turn",
				display: true,
			};
			for (const frame of await encryptedWelcome([savedPrompt])) instance(0).message(frame);
			await joined.promise;
			client.sendPrompt("SLOW: another turn");

			instance(0).relayClose(1006, "daemon restarted");
			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");

			expect(client.roomMissing).toBe(true);
			expect(client.markUnrestorableAfterRestart()).toBe(false);
			expect(client.getSnapshot()).toMatchObject({ phase: "reconnecting", endedReason: null });
		} finally {
			stop();
			client.close();
		}
	});
	it("after a host close, a vanished room ends normally only once the room lookup finds no session", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");
		const joined = Promise.withResolvers<void>();
		const stop = client.subscribe(() => {
			if (client.getSnapshot().phase === "live") joined.resolve();
		});

		try {
			client.connect();
			instance(0).open();
			for (const frame of await encryptedWelcome()) instance(0).message(frame);
			await joined.promise;
			client.sendPrompt("SLOW: interrupted first turn");

			instance(0).relayClose(4001, "room closed");
			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");

			// A graceful daemon shutdown also closes 4001 first, so the client waits for the pool's room lookup.
			expect(client.roomMissing).toBe(true);
			expect(client.getSnapshot().phase).toBe("reconnecting");
			expect(client.markUnrestorableAfterRestart()).toBe(false);
			expect(client.endAfterHostClose()).toBe(true);
			expect(client.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "no such room" });
		} finally {
			stop();
			client.close();
		}
	});


	it("ends an initial join when the room does not exist", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		client.connect();
		instance(0).open();
		instance(0).relayClose(4004, "no such room");

		expect(client.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "no such room" });
		vi.advanceTimersByTime(30_000);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
	});
	it("replaces a socket stuck in CONNECTING when the network comes back", () => {
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		client.connect();
		const connecting = instance(0);
		client.reconnect();

		expect(ScriptedWebSocket.instances).toHaveLength(2);
		expect(connecting.readyState).toBe(ScriptedWebSocket.CLOSED);
		client.close();
	});

});
