/**
 * Local collab relay: the contract of `packages/collab-web/scripts/local-relay.ts` (the offline stand-in for
 * `wss://my.omp.sh`), as an importable class that shares one HTTP server with the control API.
 *
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket.
 * - The host creates the room; a second host is rejected with close 4009 and a guest joining a missing
 *   room with close 4004.
 * - Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N targets that guest only.
 * - Guest binary frames: the first 4 envelope bytes are rewritten to the sender's peerId, then forwarded
 *   to the host.
 * - TEXT control to the host: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
 * - Host disconnect: TEXT `{"t":"room-closed"}` to every guest, then close 4001; the room is dropped.
 * - Keepalive (deck addition): every `pingIntervalMs` each socket gets a ping; a socket that produced no
 *   frame (message, ping or pong) for `pongTimeoutMs` is terminated, which runs the normal close path
 *   (peer-left for guests, room-closed for a host). This reaps phone sockets that vanished without FIN.
 *
 * The relay never sees plaintext: payloads stay sealed end to end.
 */
import { readEnvelopePeer, rewriteEnvelopePeer } from "./envelope";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

export const DEFAULT_PING_INTERVAL_MS = 20_000;
export const DEFAULT_PONG_TIMEOUT_MS = 50_000;

export interface RelaySocketData {
	roomId: string;
	role: "host" | "guest";
	/** The authenticated device or worker token owner; used to close sockets on revocation. */
	deviceId?: string;
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
	/** Date.now() of the last frame of any kind received from this socket. */
	lastSeen: number;
	/** Slow-guest rule: since when the backlog has been over the soft limit without draining. */
	backlogSince?: number;
	/** Backlog at the last check and bytes sent since, to measure what drained in between. */
	lastBuffered?: number;
	sentSince?: number;
}

export type RelaySocket = Bun.ServerWebSocket<RelaySocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface RelayOptions {
	pingIntervalMs?: number;
	pongTimeoutMs?: number;
	/** Slow-guest rule (see SOFT_GUEST_BUFFER_BYTES); tests shorten it. */
	slowGuest?: { softBytes?: number; hardBytes?: number; stallMs?: number };
}

const ROOM_CLOSED = JSON.stringify({ t: "room-closed" });
/**
 * Slow guests. A joining guest receives the whole session as a train of ~512 KiB snapshot chunks, so a guest that is
 * reading (a phone over Tailscale) is often several MiB behind for a while; that is fine. A guest is closed when nothing
 * drained from its backlog (over the soft limit) for STALL_MS, when Bun drops a frame for it (its 16 MiB backpressure
 * limit, which bounds memory per guest), or past the hard limit (tests lower it).
 */
const SOFT_GUEST_BUFFER_BYTES = 8 * 1024 * 1024;
const HARD_GUEST_BUFFER_BYTES = 64 * 1024 * 1024;
const GUEST_STALL_MS = 15_000;

export class Relay {
	readonly websocket: Bun.WebSocketHandler<RelaySocketData>;
	readonly #rooms = new Map<string, Room>();
	readonly #pongTimeoutMs: number;
	readonly #softBytes: number;
	readonly #hardBytes: number;
	readonly #stallMs: number;
	#timer: Timer | undefined;

	constructor(options: RelayOptions = {}) {
		const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
		this.#pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
		this.#softBytes = options.slowGuest?.softBytes ?? SOFT_GUEST_BUFFER_BYTES;
		this.#hardBytes = options.slowGuest?.hardBytes ?? HARD_GUEST_BUFFER_BYTES;
		this.#stallMs = options.slowGuest?.stallMs ?? GUEST_STALL_MS;
		this.websocket = {
			open: ws => this.#open(ws),
			message: (ws, message) => this.#message(ws, message),
			close: ws => this.#close(ws),
			ping: ws => {
				ws.data.lastSeen = Date.now();
			},
			pong: ws => {
				ws.data.lastSeen = Date.now();
			},
		};
		this.#timer = setInterval(() => this.#sweep(), pingIntervalMs);
		this.#timer.unref();
	}

	/** Number of guest sockets currently connected across all rooms. */
	get guestCount(): number {
		let count = 0;
		for (const room of this.#rooms.values()) count += room.guests.size;
		return count;
	}

	hasRoom(roomId: string): boolean {
		return this.#rooms.has(roomId);
	}

	hasGuests(roomId: string): boolean {
		return (this.#rooms.get(roomId)?.guests.size ?? 0) > 0;
	}

	/**
	 * Handles a request when it targets `/r/<roomId>`: returns `undefined` after a successful upgrade, a
	 * Response for a rejected request, and `null` when the path is not a relay path at all.
	 */
	handle(req: Request, server: Bun.Server<RelaySocketData>, deviceId?: string): Response | undefined | null {
		const url = new URL(req.url);
		if (!url.pathname.startsWith("/r/")) return null;
		const match = ROOM_PATH_RE.exec(url.pathname);
		const role = url.searchParams.get("role");
		if (!match || (role !== "host" && role !== "guest")) {
			return new Response("not found", { status: 404 });
		}
		const data: RelaySocketData = {
			roomId: match[1]!,
			role,
			peerId: 0,
			lastSeen: Date.now(),
			...(deviceId === undefined ? {} : { deviceId }),
		};
		if (server.upgrade(req, { data })) return undefined;
		return new Response("websocket upgrade required", { status: 426 });
	}

	/** Closes every room and stops keepalive. Idempotent. */
	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		for (const room of this.#rooms.values()) {
			for (const guest of room.guests.values()) {
				guest.send(ROOM_CLOSED);
				guest.close(4001, "room closed");
			}
			room.host.close(1001, "relay shutting down");
		}
		this.#rooms.clear();
	}

	#sweep(): void {
		const now = Date.now();
		for (const room of this.#rooms.values()) {
			// Copy: terminate() runs the close handler synchronously and mutates the guest map.
			for (const socket of [room.host, ...room.guests.values()]) {
				if (now - socket.data.lastSeen > this.#pongTimeoutMs) socket.terminate();
				else if (socket.data.role === "guest" && this.#stalled(socket, now)) socket.close(1013, "slow guest buffer limit exceeded");
				else socket.ping();
			}
		}
	}

	#open(ws: RelaySocket): void {
		const { roomId, role } = ws.data;
		if (role === "host") {
			if (this.#rooms.has(roomId)) {
				ws.close(4009, "a host is already connected for this room");
				return;
			}
			this.#rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
			return;
		}
		const room = this.#rooms.get(roomId);
		if (!room) {
			ws.close(4004, "no such room");
			return;
		}
		const peerId = room.nextPeerId++;
		ws.data.peerId = peerId;
		room.guests.set(peerId, ws);
		room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
	}

	/**
	 * True when this guest stopped draining: its backlog is over the soft limit and nothing left its buffer for the stall
	 * window. Drained bytes are measured directly (last backlog + bytes sent since - backlog now), so a guest that reads
	 * slowly or exactly as fast as the host sends counts as reading even if its backlog never shrinks.
	 */
	#stalled(guest: RelaySocket, now: number): boolean {
		const data = guest.data;
		const buffered = guest.getBufferedAmount();
		const drained = (data.lastBuffered ?? buffered) + (data.sentSince ?? 0) - buffered;
		data.lastBuffered = buffered;
		data.sentSince = 0;
		if (buffered <= this.#softBytes) data.backlogSince = undefined;
		else if (drained > 0 || data.backlogSince === undefined) data.backlogSince = now;
		return data.backlogSince !== undefined && now - data.backlogSince > this.#stallMs;
	}

	#sendToGuest(guest: RelaySocket, message: Buffer): void {
		if (guest.readyState !== WebSocket.OPEN) return;
		if (guest.getBufferedAmount() + message.byteLength > this.#hardBytes || this.#stalled(guest, Date.now())) {
			guest.close(1013, "slow guest buffer limit exceeded");
			return;
		}
		// Bun drops a frame (returns 0) once the socket passes its backpressure limit (16 MiB): a guest that lost a frame
		// has a broken stream, so it is closed and reconnects with a fresh snapshot instead of continuing silently.
		const sent = guest.send(message);
		if (sent === 0) {
			guest.close(1013, "slow guest buffer limit exceeded");
			return;
		}
		guest.data.sentSince = (guest.data.sentSince ?? 0) + message.byteLength;
	}

	#message(ws: RelaySocket, message: string | Buffer): void {
		ws.data.lastSeen = Date.now();
		if (typeof message === "string") return; // clients never send TEXT
		const room = this.#rooms.get(ws.data.roomId);
		if (!room) return;
		if (ws.data.role === "host") {
			if (room.host !== ws) return;
			const peerId = readEnvelopePeer(message);
			if (peerId === null) return;
			if (peerId === 0) {
				for (const guest of room.guests.values()) this.#sendToGuest(guest, message);
			} else {
				const guest = room.guests.get(peerId);
				if (guest) this.#sendToGuest(guest, message);
			}
			return;
		}
		if (message.byteLength < 4 || room.guests.get(ws.data.peerId) !== ws) return;
		rewriteEnvelopePeer(message, ws.data.peerId);
		room.host.send(message);
	}

	#close(ws: RelaySocket): void {
		const { roomId, role, peerId } = ws.data;
		const room = this.#rooms.get(roomId);
		if (!room) return;
		if (role === "host") {
			// Rejected second host: the live room is not ours to tear down.
			if (room.host !== ws) return;
			this.#rooms.delete(roomId);
			for (const guest of room.guests.values()) {
				guest.send(ROOM_CLOSED);
				guest.close(4001, "room closed");
			}
			room.guests.clear();
			return;
		}
		if (room.guests.get(peerId) === ws) {
			room.guests.delete(peerId);
			room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
		}
	}
}

export interface LocalRelay {
	/** ws://127.0.0.1:<port> — append `/r/<roomId>?role=…` to connect. */
	url: string;
	relay: Relay;
	/** Closes every room and stops the server. Idempotent. */
	stop(): void;
}

/** Standalone relay server (no control API), the shape the upstream relay tests exercise. */
export function startLocalRelay(port = 0, options: RelayOptions = {}): LocalRelay {
	const relay = new Relay(options);
	const server = Bun.serve<RelaySocketData>({
		hostname: "127.0.0.1",
		port,
		fetch(req, srv): Response | undefined {
			const result = relay.handle(req, srv);
			return result === null ? new Response("not found", { status: 404 }) : result;
		},
		websocket: relay.websocket,
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		relay,
		stop(): void {
			relay.stop();
			server.stop(true);
		},
	};
}
