import { afterEach, describe, expect, it } from "bun:test";
import { packEnvelope, unpackEnvelope } from "../../session-host/test/collab-web/link";
import { type LocalRelay, Relay, startLocalRelay, type RelaySocketData } from "../src/relay";
import { closeAllSockets, socket, until, waitBinary, waitEvent, waitOpen, waitText } from "./ws-helpers";

const ROOM = "RelayRoom_12345";

let relay: LocalRelay | null = null;

function relayHttpUrl(): string {
	if (!relay) throw new Error("relay not started");
	return relay.url.replace(/^ws:/, "http:");
}

function connect(path: string): WebSocket {
	if (!relay) throw new Error("relay not started");
	return socket(relay.url, path);
}

/** A peer that completes the WebSocket handshake and then never reads or answers anything (a vanished phone). */
async function silentPeer(port: number, roomId: string, role: "host" | "guest"): Promise<{ close(): void }> {
	const { promise: upgraded, resolve } = Promise.withResolvers<void>();
	const tcp = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(sock) {
				sock.write(
					`GET /r/${roomId}?role=${role} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
						"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
				);
			},
			data(_sock, chunk) {
				if (new TextDecoder().decode(chunk).startsWith("HTTP/1.1 101")) resolve();
			},
			close() {},
			error() {},
		},
	});
	await upgraded;
	return { close: () => tcp.end() };
}

async function pausedPeer(port: number, roomId: string): Promise<{
	closeFrame: Promise<{ code: number; reason: string }>;
	resume(): void;
	close(): void;
}> {
	const opened = Promise.withResolvers<void>();
	const closeFrame = Promise.withResolvers<{ code: number; reason: string }>();
	let handshake = Buffer.alloc(0);
	let frameBuffer = Buffer.alloc(0);
	let upgraded = false;
	let readingFrames = false;
	const connection = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(sock) {
				sock.write(
					`GET /r/${roomId}?role=guest HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
						"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
				);
			},
			data(sock, chunk) {
				if (!upgraded) {
					handshake = Buffer.concat([handshake, chunk]);
					const end = handshake.indexOf("\r\n\r\n");
					if (end < 0) return;
					if (!handshake.subarray(0, end).toString("utf8").startsWith("HTTP/1.1 101")) {
						opened.reject(new Error("slow guest WebSocket upgrade failed"));
						return;
					}
					upgraded = true;
					sock.pause();
					opened.resolve();
					return;
				}
				if (!readingFrames) return;
				frameBuffer = Buffer.concat([frameBuffer, chunk]);
				for (;;) {
					if (frameBuffer.byteLength < 2) return;
					const opcode = frameBuffer[0]! & 0x0f;
					const marker = frameBuffer[1]! & 0x7f;
					let length = marker;
					let offset = 2;
					if (marker === 126) {
						if (frameBuffer.byteLength < 4) return;
						length = frameBuffer.readUInt16BE(2);
						offset = 4;
					} else if (marker === 127) {
						if (frameBuffer.byteLength < 10) return;
						const wideLength = frameBuffer.readBigUInt64BE(2);
						if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
							closeFrame.reject(new Error("server sent an oversized WebSocket frame"));
							return;
						}
						length = Number(wideLength);
						offset = 10;
					}
					if ((frameBuffer[1]! & 0x80) !== 0) offset += 4;
					if (frameBuffer.byteLength < offset + length) return;
					const payload = frameBuffer.subarray(offset, offset + length);
					frameBuffer = frameBuffer.subarray(offset + length);
					if (opcode === 0x8) {
						const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1005;
						closeFrame.resolve({ code, reason: payload.subarray(2).toString("utf8") });
						return;
					}
				}
			},
			close() {},
			error(_sock, error) {
				opened.reject(error);
				closeFrame.reject(error);
			},
		},
	});
	await opened.promise;
	return {
		closeFrame: closeFrame.promise,
		resume(): void {
			readingFrames = true;
			connection.resume();
		},
		close(): void {
			connection.end();
		},
	};
}


afterEach(() => {
	closeAllSockets();
	relay?.stop();
	relay = null;
});

describe("local collab relay contract", () => {
	it("rejects non-relay requests and guests before a host creates the room", async () => {
		relay = startLocalRelay();

		expect((await fetch(`${relayHttpUrl()}/nope`)).status).toBe(404);
		expect((await fetch(`${relayHttpUrl()}/r/${ROOM}?role=host`)).status).toBe(426);
		expect((await fetch(`${relayHttpUrl()}/r/${ROOM}?role=bogus`)).status).toBe(404);

		const guest = connect(`/r/${ROOM}?role=guest`);
		const close = await waitEvent<CloseEvent>(guest, "close", "missing-room guest close");
		expect(close.code).toBe(4004);
		expect(close.reason).toBe("no such room");
	});

	it("routes opaque envelopes without decrypting them", async () => {
		relay = startLocalRelay();
		const host = connect(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const guest1 = connect(`/r/${ROOM}?role=guest`);
		await waitOpen(guest1);
		expect(JSON.parse(await waitText(host, "first peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const guest2 = connect(`/r/${ROOM}?role=guest`);
		await waitOpen(guest2);
		expect(JSON.parse(await waitText(host, "second peer join"))).toEqual({ t: "peer-joined", peer: 2 });

		// The guest claims peer 0 in the envelope; the relay must rewrite it to the real peer id.
		guest1.send(packEnvelope(0, new Uint8Array([1, 2, 3])));
		const fromGuest = unpackEnvelope(await waitBinary(host, "guest envelope"));
		expect(fromGuest?.peerId).toBe(1);
		expect(fromGuest?.payload).toEqual(new Uint8Array([1, 2, 3]));

		const broadcast1 = waitBinary(guest1, "broadcast to guest 1");
		const broadcast2 = waitBinary(guest2, "broadcast to guest 2");
		host.send(packEnvelope(0, new Uint8Array([9])));
		expect(unpackEnvelope(await broadcast1)?.payload).toEqual(new Uint8Array([9]));
		expect(unpackEnvelope(await broadcast2)?.payload).toEqual(new Uint8Array([9]));

		const targeted = waitBinary(guest2, "targeted guest 2 frame");
		host.send(packEnvelope(2, new Uint8Array([7])));
		expect(unpackEnvelope(await targeted)?.payload).toEqual(new Uint8Array([7]));

		const guest1Next = waitBinary(guest1, "next guest 1 broadcast");
		host.send(packEnvelope(0, new Uint8Array([5])));
		expect(unpackEnvelope(await guest1Next)?.payload).toEqual(new Uint8Array([5]));
	});

	it("enforces one host and closes guests when the room host leaves", async () => {
		relay = startLocalRelay();
		const host = connect(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const duplicateHost = connect(`/r/${ROOM}?role=host`);
		const duplicateClose = await waitEvent<CloseEvent>(duplicateHost, "close", "duplicate host close");
		expect(duplicateClose.code).toBe(4009);
		expect(duplicateClose.reason).toBe("a host is already connected for this room");

		// The rejected duplicate must not have torn down the live room.
		const guest = connect(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const closure = waitText(guest, "room close control");
		const guestClose = waitEvent<CloseEvent>(guest, "close", "guest room close");
		host.close(1000);
		expect(JSON.parse(await closure)).toEqual({ t: "room-closed" });
		expect((await guestClose).code).toBe(4001);
		expect(relay.relay.hasRoom(ROOM)).toBe(false);
	});

	it("tells the host when a guest leaves", async () => {
		relay = startLocalRelay();
		const host = connect(`/r/${ROOM}?role=host`);
		await waitOpen(host);
		const guest = connect(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		await waitText(host, "peer join");
		guest.close(1000);
		expect(JSON.parse(await waitText(host, "peer left"))).toEqual({ t: "peer-left", peer: 1 });
	});
});

describe("relay guest counter and keepalive", () => {
	it("counts connected guests across rooms and decrements on leave", async () => {
		relay = startLocalRelay();
		const hostA = connect("/r/RoomAAAAAAAAAA?role=host");
		const hostB = connect("/r/RoomBBBBBBBBBB?role=host");
		await Promise.all([waitOpen(hostA), waitOpen(hostB)]);
		const g1 = connect("/r/RoomAAAAAAAAAA?role=guest");
		const g2 = connect("/r/RoomAAAAAAAAAA?role=guest");
		const g3 = connect("/r/RoomBBBBBBBBBB?role=guest");
		await Promise.all([waitOpen(g1), waitOpen(g2), waitOpen(g3)]);
		await until(() => relay!.relay.guestCount === 3, "three guests counted");
		g2.close(1000);
		await until(() => relay!.relay.guestCount === 2, "guest leave counted");
		expect(hostA.readyState).toBe(WebSocket.OPEN);
	});

	it("reaps a guest that stops answering pings and tells the host; live idle sockets survive", async () => {
		relay = startLocalRelay(0, { pingIntervalMs: 40, pongTimeoutMs: 200 });
		const host = connect(`/r/${ROOM}?role=host`);
		await waitOpen(host);
		const live = connect(`/r/${ROOM}?role=guest`);
		await waitOpen(live);
		expect(JSON.parse(await waitText(host, "live join"))).toEqual({ t: "peer-joined", peer: 1 });

		const port = Number(new URL(relay.url.replace(/^ws:/, "http:")).port);
		const dead = await silentPeer(port, ROOM, "guest");
		expect(JSON.parse(await waitText(host, "dead join"))).toEqual({ t: "peer-joined", peer: 2 });
		expect(relay.relay.guestCount).toBe(2);

		// Dead guest is terminated by the relay; the host learns via peer-left; the live guest stays.
		expect(JSON.parse(await waitText(host, "dead peer-left"))).toEqual({ t: "peer-left", peer: 2 });
		await Bun.sleep(400); // well past pongTimeout: the live (auto-ponging) socket must still be attached
		expect(live.readyState).toBe(WebSocket.OPEN);
		expect(relay.relay.guestCount).toBe(1);
		dead.close();
	});

	it("reaps a silent host and closes its guests with room-closed", async () => {
		relay = startLocalRelay(0, { pingIntervalMs: 40, pongTimeoutMs: 200 });
		const port = Number(new URL(relay.url.replace(/^ws:/, "http:")).port);
		const deadHost = await silentPeer(port, ROOM, "host");
		const guest = connect(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		const closure = waitText(guest, "room-closed after host reaped");
		const guestClose = waitEvent<CloseEvent>(guest, "close", "guest close after host reaped");
		expect(JSON.parse(await closure)).toEqual({ t: "room-closed" });
		expect((await guestClose).code).toBe(4001);
		expect(relay.relay.hasRoom(ROOM)).toBe(false);
		deadHost.close();
	});
});

describe("local relay slow-reader backpressure", () => {
	it("closes only the guest whose buffered output exceeds the limit", async () => {
		// Stopped reading: closed once its backlog stays over the soft limit for the stall window.
		const directRelay = new Relay({ pingIntervalMs: 100, pongTimeoutMs: 60_000, slowGuest: { softBytes: 2 * 1024 * 1024, stallMs: 300 } });
		const base = directRelay.websocket;
		let slowSocket: Bun.ServerWebSocket<RelaySocketData> | undefined;
		const server = Bun.serve<RelaySocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, srv) {
				const response = directRelay.handle(req, srv);
				return response === null ? new Response("not found", { status: 404 }) : response;
			},
			websocket: {
				...base,
				open(socket) {
					if (socket.data.role === "guest" && !slowSocket) slowSocket = socket;
					base.open?.(socket);
				},
			},
		});
		try {
			const host = socket(`ws://127.0.0.1:${server.port}`, `/r/${ROOM}?role=host`);
			await waitOpen(host);
			const slow = await pausedPeer(server.port!, ROOM);
			const fast = socket(`ws://127.0.0.1:${server.port}`, `/r/${ROOM}?role=guest`);
			await waitOpen(fast);
			await waitText(host, "slow guest joined");
			await waitText(host, "fast guest joined");

			const frame = packEnvelope(0, new Uint8Array(1024 * 1024).fill(7));
			for (let index = 0; index < 16; index++) {
				const received = waitBinary(fast, `broadcast ${index + 1}`);
				host.send(frame);
				expect((await received).byteLength).toBe(frame.byteLength);
			}
			if (!slowSocket) throw new Error("slow guest did not upgrade");
			await until(() => slowSocket?.readyState !== WebSocket.OPEN, "slow guest close");
			slow.resume();
			const close = await Promise.race([slow.closeFrame, Bun.sleep(2_000).then(() => undefined)]);
			expect(close).toEqual({ code: 1013, reason: "slow guest buffer limit exceeded" });

			const afterClose = waitBinary(fast, "broadcast after slow guest removal");
			host.send(frame);
			expect((await afterClose).byteLength).toBe(frame.byteLength);
			expect(fast.readyState).toBe(WebSocket.OPEN);
			expect(host.readyState).toBe(WebSocket.OPEN);
		} finally {
			directRelay.stop();
			await server.stop(true);
		}
	});

	it("keeps a guest that falls behind on a snapshot train but keeps reading", async () => {
		const directRelay = new Relay({ pingIntervalMs: 100, pongTimeoutMs: 60_000, slowGuest: { softBytes: 2 * 1024 * 1024, stallMs: 600 } });
		const base = directRelay.websocket;
		let laggingSocket: Bun.ServerWebSocket<RelaySocketData> | undefined;
		const server = Bun.serve<RelaySocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, srv) {
				const response = directRelay.handle(req, srv);
				return response === null ? new Response("not found", { status: 404 }) : response;
			},
			websocket: {
				...base,
				open(socket) {
					if (socket.data.role === "guest" && !laggingSocket) laggingSocket = socket;
					base.open?.(socket);
				},
			},
		});
		try {
			const host = socket(`ws://127.0.0.1:${server.port}`, `/r/${ROOM}?role=host`);
			await waitOpen(host);
			const lagging = await pausedPeer(server.port!, ROOM);
			await waitText(host, "lagging guest joined");
			const chunk = packEnvelope(0, new Uint8Array(512 * 1024).fill(3));
			// 8 MiB of snapshot chunks while the guest is behind (over the 2 MiB soft limit), shorter than the stall window.
			for (let index = 0; index < 16; index++) host.send(chunk);
			await Bun.sleep(250);
			lagging.resume();
			// It drains, so later frames keep it alive well past the stall window.
			for (let index = 0; index < 8; index++) {
				host.send(chunk);
				await Bun.sleep(150);
			}
			expect(laggingSocket?.readyState).toBe(WebSocket.OPEN);
		} finally {
			directRelay.stop();
			await server.stop(true);
		}
	});
});

describe("local relay slow-guest rule (drain measured from the socket)", () => {
	function fakeSocket(role: "host" | "guest", buffered: { bytes: number }, onSend: (bytes: number) => void) {
		const closes: number[] = [];
		const data: RelaySocketData = { roomId: ROOM, role, peerId: 0, lastSeen: Date.now() };
		const ws = {
			data,
			readyState: WebSocket.OPEN,
			getBufferedAmount: () => buffered.bytes,
			send: (message: Buffer | string) => {
				onSend(typeof message === "string" ? message.length : message.byteLength);
				return 1;
			},
			close: (code: number) => {
				closes.push(code);
			},
			ping: () => {
				data.lastSeen = Date.now();
			},
			terminate: () => closes.push(1006),
		};
		return { ws: ws as unknown as Bun.ServerWebSocket<RelaySocketData>, closes };
	}

	async function run(drainsWhatIsSent: boolean): Promise<number[]> {
		const relay = new Relay({ pingIntervalMs: 50, pongTimeoutMs: 60_000, slowGuest: { softBytes: 2 * 1024 * 1024, stallMs: 300 } });
		const host = fakeSocket("host", { bytes: 0 }, () => {});
		const backlog = { bytes: 5 * 1024 * 1024 };
		// Every send adds to the backlog; a reading guest drains 64 KiB per 80 ms (the host's send rate) until caught up.
		const guest = fakeSocket("guest", backlog, bytes => {
			backlog.bytes += bytes;
		});
		const reader = drainsWhatIsSent
			? setInterval(() => {
					backlog.bytes = Math.max(0, backlog.bytes - 64 * 1024);
				}, 80)
			: undefined;
		try {
			relay.websocket.open?.(host.ws);
			relay.websocket.open?.(guest.ws);
			const frame = packEnvelope(0, new Uint8Array(64 * 1024));
			for (let index = 0; index < 12; index++) {
				relay.websocket.message?.(host.ws, Buffer.from(frame));
				await Bun.sleep(80);
			}
			await Bun.sleep(400);
			return [...guest.closes];
		} finally {
			clearInterval(reader);
			relay.stop();
		}
	}

	it("keeps a guest that stays 5 MiB behind but drains as fast as the host sends", async () => {
		expect(await run(true)).toEqual([]);
	});

	it("closes a guest whose backlog only grows (nothing drains) after the stall window", async () => {
		expect(await run(false)).toContain(1013);
	});
});
