import { errorResponse } from "../api";
import type { RelaySocketData } from "../relay";
import { decodePeerId, peerBaseUrl, type PeerDaemon } from "./types";

const HIGH_WATER_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const DRAIN_POLL_MS = 20;

interface Frame {
	data: string | Uint8Array;
	bytes: number;
}

interface PeerBridgeState {
	peerId: string;
	url: string;
	token: string;
	log: (message: string) => void;
	local: Bun.ServerWebSocket<RelaySocketData> | undefined;
	upstream: WebSocket | undefined;
	toPeer: Frame[];
	toPeerBytes: number;
	toLocal: Frame[];
	toLocalBytes: number;
	peerDrainTimer: Timer | undefined;
	localDrainTimer: Timer | undefined;
	closed: boolean;
}

interface PeerSocketData extends RelaySocketData {
	peerBridge: PeerBridgeState;
}

function stateFor(socket: Bun.ServerWebSocket<RelaySocketData>): PeerBridgeState | undefined {
	if (!("peerBridge" in socket.data)) return undefined;
	return (socket.data as PeerSocketData).peerBridge;
}

function textBytes(text: string): number {
	return Buffer.byteLength(text);
}

function localFrame(message: string | Buffer<ArrayBuffer>): Frame {
	return typeof message === "string"
		? { data: message, bytes: textBytes(message) }
		: { data: message, bytes: message.byteLength };
}

function peerFrame(data: unknown): Frame | undefined {
	if (typeof data === "string") return { data, bytes: textBytes(data) };
	if (data instanceof ArrayBuffer) return { data: new Uint8Array(data), bytes: data.byteLength };
	if (ArrayBuffer.isView(data)) {
		return {
			data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			bytes: data.byteLength,
		};
	}
	return undefined;
}

function closeReason(reason: string): string {
	let result = "";
	let bytes = 0;
	for (const character of reason) {
		const length = textBytes(character);
		if (bytes + length > 123) break;
		result += character;
		bytes += length;
	}
	return result;
}

function peerCloseCode(code: number): number {
	return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

function localCloseCode(code: number): number {
	if (code < 1000 || code > 4999 || code === 1004 || code === 1005 || code === 1006 || code === 1015) return 1011;
	return code;
}

function clearQueues(state: PeerBridgeState): void {
	state.toPeer.length = 0;
	state.toPeerBytes = 0;
	state.toLocal.length = 0;
	state.toLocalBytes = 0;
	if (state.peerDrainTimer) {
		clearTimeout(state.peerDrainTimer);
		state.peerDrainTimer = undefined;
	}
	if (state.localDrainTimer) {
		clearTimeout(state.localDrainTimer);
		state.localDrainTimer = undefined;
	}
}

function sendUpstreamClose(state: PeerBridgeState, code: number, reason: string): void {
	const upstream = state.upstream;
	if (!upstream) return;
	if (upstream.readyState === WebSocket.CONNECTING) {
		upstream.close();
	} else if (upstream.readyState === WebSocket.OPEN) {
		upstream.close(peerCloseCode(code), closeReason(reason));
	}
}

function failBridge(state: PeerBridgeState, code: number, reason: string): void {
	if (state.closed) return;
	state.closed = true;
	clearQueues(state);
	state.log(`peer ${state.peerId} WebSocket bridge closed: ${reason}`);
	if (state.local?.readyState === WebSocket.OPEN) state.local.close(code, closeReason(reason));
	sendUpstreamClose(state, code, reason);
}

function schedulePeerDrain(state: PeerBridgeState): void {
	if (state.peerDrainTimer || state.closed) return;
	state.peerDrainTimer = setTimeout(() => {
		state.peerDrainTimer = undefined;
		flushToPeer(state);
	}, DRAIN_POLL_MS);
}

function scheduleLocalDrain(state: PeerBridgeState): void {
	if (state.localDrainTimer || state.closed) return;
	state.localDrainTimer = setTimeout(() => {
		state.localDrainTimer = undefined;
		flushToLocal(state);
	}, DRAIN_POLL_MS);
}

function flushToPeer(state: PeerBridgeState): void {
	if (state.closed) return;
	const upstream = state.upstream;
	if (upstream?.readyState !== WebSocket.OPEN) return;
	while (state.toPeer.length > 0) {
		if (upstream.bufferedAmount >= HIGH_WATER_BYTES) {
			schedulePeerDrain(state);
			return;
		}
		const frame = state.toPeer[0]!;
		try {
			upstream.send(frame.data);
		} catch {
			failBridge(state, 1011, "peer WebSocket send failed");
			return;
		}
		state.toPeer.shift();
		state.toPeerBytes -= frame.bytes;
	}
}

function flushToLocal(state: PeerBridgeState): void {
	if (state.closed) return;
	const local = state.local;
	if (!local || local.readyState !== WebSocket.OPEN) return;
	while (state.toLocal.length > 0) {
		if (local.getBufferedAmount() >= HIGH_WATER_BYTES) {
			scheduleLocalDrain(state);
			return;
		}
		const frame = state.toLocal[0]!;
		// Bun: -1 = accepted under backpressure (it is sent; wait for drain before more), 0 = dropped.
		const sent = local.send(frame.data);
		if (sent === 0) {
			failBridge(state, 1011, "local WebSocket send failed");
			return;
		}
		state.toLocal.shift();
		state.toLocalBytes -= frame.bytes;
		if (sent === -1) {
			scheduleLocalDrain(state);
			return;
		}
	}
}

function queueToPeer(state: PeerBridgeState, frame: Frame): void {
	if (state.closed) return;
	if (state.toPeerBytes + frame.bytes > MAX_QUEUED_BYTES) {
		failBridge(state, 1013, "peer WebSocket backpressure limit exceeded");
		return;
	}
	state.toPeer.push(frame);
	state.toPeerBytes += frame.bytes;
	flushToPeer(state);
}

function queueToLocal(state: PeerBridgeState, frame: Frame): void {
	if (state.closed) return;
	if (state.toLocalBytes + frame.bytes > MAX_QUEUED_BYTES) {
		failBridge(state, 1013, "local WebSocket backpressure limit exceeded");
		return;
	}
	state.toLocal.push(frame);
	state.toLocalBytes += frame.bytes;
	flushToLocal(state);
}

function openBridge(socket: Bun.ServerWebSocket<RelaySocketData>, state: PeerBridgeState): void {
	state.local = socket;
	try {
		const upstream = Reflect.construct(WebSocket, [state.url, { headers: { authorization: `Bearer ${state.token}` } }]) as WebSocket;
		upstream.binaryType = "arraybuffer";
		state.upstream = upstream;
		upstream.addEventListener("open", () => flushToPeer(state));
		upstream.addEventListener("message", event => {
			const frame = peerFrame(event.data as unknown);
			if (!frame) {
				failBridge(state, 1011, "peer sent an unsupported WebSocket frame");
				return;
			}
			queueToLocal(state, frame);
		});
		upstream.addEventListener("close", event => {
			if (state.closed) return;
			state.closed = true;
			clearQueues(state);
			if (state.local?.readyState === WebSocket.OPEN) {
				state.local.close(localCloseCode(event.code), closeReason(event.reason));
			}
		});
		upstream.addEventListener("error", () => failBridge(state, 1011, "peer WebSocket connection failed"));
	} catch {
		failBridge(state, 1011, "peer WebSocket connection failed");
	}
}

function closeFromLocal(state: PeerBridgeState, code: number, reason: string): void {
	if (state.closed) return;
	state.closed = true;
	clearQueues(state);
	sendUpstreamClose(state, code, reason);
}

export function peerRelayUpgrade(
	req: Request,
	server: Bun.Server<RelaySocketData>,
	peers: readonly PeerDaemon[],
	log: (message: string) => void = () => {},
	deviceId?: string,
): Response | undefined | null {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/peers/")) return null;
	const match = /^\/peers\/([^/]+)\/r\/(.+)$/.exec(url.pathname);
	if (!match) return errorResponse(404, "not-found", "peer relay path not found");

	const peerId = decodePeerId(match[1]!);
	if (!peerId) return errorResponse(400, "bad-request", "invalid peer id");
	const peer = peers.find(candidate => candidate.id === peerId);
	if (!peer) return errorResponse(404, "not-found", `unknown peer ${JSON.stringify(peerId)}`);
	const token = peer.token;
	if (!token) return errorResponse(502, "internal", `peer ${JSON.stringify(peer.name)} has no device token`);

	let target: URL;
	try {
		target = new URL(`/r/${match[2]}`, peerBaseUrl(peer));
		target.search = url.search;
		target.searchParams.set("role", "guest");
	} catch {
		log(`peer ${peer.id} WebSocket URL is invalid`);
		return errorResponse(502, "internal", `peer ${JSON.stringify(peer.name)} is unreachable`);
	}

	const state: PeerBridgeState = {
		peerId: peer.id,
		url: target.href,
		token,
		log,
		local: undefined,
		upstream: undefined,
		toPeer: [],
		toPeerBytes: 0,
		toLocal: [],
		toLocalBytes: 0,
		peerDrainTimer: undefined,
		localDrainTimer: undefined,
		closed: false,
	};
	const data: PeerSocketData = {
		roomId: `peer:${peer.id}`,
		role: "guest",
		peerId: 0,
		lastSeen: Date.now(),
		peerBridge: state,
		...(deviceId === undefined ? {} : { deviceId }),
	};
	if (server.upgrade(req, { data })) return undefined;
	return errorResponse(426, "bad-request", "websocket upgrade required");
}

export function peerRelayWebSocket(
	relay: Bun.WebSocketHandler<RelaySocketData>,
): Bun.WebSocketHandler<RelaySocketData> {
	return {
		...relay,
		open(socket): void | Promise<void> {
			const state = stateFor(socket);
			if (state) return openBridge(socket, state);
			return relay.open?.(socket);
		},
		message(socket, message): void | Promise<void> {
			const state = stateFor(socket);
			if (state) return queueToPeer(state, localFrame(message));
			return relay.message(socket, message);
		},
		close(socket, code, reason): void | Promise<void> {
			const state = stateFor(socket);
			if (state) return closeFromLocal(state, code, reason);
			return relay.close?.(socket, code, reason);
		},
		drain(socket): void | Promise<void> {
			const state = stateFor(socket);
			if (state) return flushToLocal(state);
			return relay.drain?.(socket);
		},
		ping(socket, data): void | Promise<void> {
			if (stateFor(socket)) return;
			return relay.ping?.(socket, data);
		},
		pong(socket, data): void | Promise<void> {
			if (stateFor(socket)) return;
			return relay.pong?.(socket, data);
		},
	};
}
