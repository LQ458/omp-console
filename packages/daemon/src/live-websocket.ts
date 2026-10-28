import type { LiveModeStatus, WorkerStatus } from "@omp-console/protocol";
import { LIVE_AUDIO_EVENT_MAX_CHARS, LIVE_INPUT_MAX_FRAME_BYTES } from "@omp-console/protocol";
import type { RelaySocketData } from "./relay";
import type { Supervisor } from "./supervisor";
import { SupervisorError } from "./supervisor";

const LIVE_PATH_PREFIX = "/live/";
const MAX_INPUT_BASE64_CHARS = Math.ceil(LIVE_INPUT_MAX_FRAME_BYTES / 3) * 4;
const MAX_INPUT_MESSAGE_BYTES = MAX_INPUT_BASE64_CHARS + 32;
const MAX_QUEUED_BYTES = 256 * 1024;
const FRAME_RATE_PER_SECOND = 100;
const FRAME_BURST = 100;
const LIVE_INPUT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface LiveSocketData extends RelaySocketData {
	liveSessionId: string;
	supervisor: Supervisor;
	rateTokens: number;
	rateAt: number;
	rejected?: boolean;
}

function liveSocketData(data: RelaySocketData): LiveSocketData | undefined {
	return "liveSessionId" in data ? (data as LiveSocketData) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function consumeFrameToken(data: LiveSocketData): boolean {
	const now = performance.now();
	const elapsed = Math.max(0, now - data.rateAt);
	data.rateAt = now;
	data.rateTokens = Math.min(FRAME_BURST, data.rateTokens + (elapsed * FRAME_RATE_PER_SECOND) / 1000);
	if (data.rateTokens < 1) return false;
	data.rateTokens -= 1;
	return true;
}

/** Owner-authenticated live audio bridge. It is deliberately separate from the opaque guest/peer collab relay. */
export class LiveSocketHub {
	readonly #sockets = new Map<string, Bun.ServerWebSocket<RelaySocketData>>();

	upgrade(req: Request, server: Bun.Server<RelaySocketData>, supervisor: Supervisor, deviceId?: string): Response | undefined | null {
		const url = new URL(req.url);
		if (!url.pathname.startsWith(LIVE_PATH_PREFIX)) return null;
		const encodedId = url.pathname.slice(LIVE_PATH_PREFIX.length);
		if (!encodedId || encodedId.includes("/") || encodedId.length > 256) {
			return new Response("invalid live session path", { status: 400 });
		}
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(encodedId);
		} catch {
			return new Response("invalid live session id", { status: 400 });
		}
		if (!sessionId || sessionId.length > 256) return new Response("invalid live session id", { status: 400 });
		if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });

		// The routing path is distinct from `/r/` and `/peers/`; the outer daemon auth/site checks run before this.
		const data: LiveSocketData = {
			roomId: "live",
			role: "guest",
			peerId: 0,
			lastSeen: Date.now(),
			liveSessionId: sessionId,
			supervisor,
			rateTokens: FRAME_BURST,
			rateAt: performance.now(),
			...(deviceId === undefined ? {} : { deviceId }),
		};
		return server.upgrade(req, { data }) ? undefined : new Response("websocket upgrade required", { status: 426 });
	}

	open(socket: Bun.ServerWebSocket<RelaySocketData>): void {
		const data = liveSocketData(socket.data);
		if (!data) return;
		const previous = this.#sockets.get(data.liveSessionId);
		if (previous && previous !== socket && previous.readyState === WebSocket.OPEN) {
			data.rejected = true;
			socket.close(4009, "live session already has an owner stream");
			return;
		}
		this.#sockets.set(data.liveSessionId, socket);
		void data.supervisor
			.sessionOp(data.liveSessionId, { op: "live-mode", action: "status" })
			.then(result => {
				if (!("liveMode" in result)) throw new Error("worker returned no live-mode state");
				this.#send(socket, { t: "state", liveMode: result.liveMode });
			})
			.catch(error => {
				this.#send(socket, { t: "error", message: error instanceof SupervisorError ? error.message : "Live session is unavailable." });
				socket.close(1011, "live session unavailable");
			});
	}

	message(socket: Bun.ServerWebSocket<RelaySocketData>, message: string | Buffer): void {
		const data = liveSocketData(socket.data);
		if (!data || data.rejected || this.#sockets.get(data.liveSessionId) !== socket) return;
		if (typeof message !== "string") {
			socket.close(1003, "live audio messages must be JSON text");
			return;
		}
		if (Buffer.byteLength(message) > MAX_INPUT_MESSAGE_BYTES) {
			socket.close(1009, "live audio frame too large");
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(message);
		} catch {
			socket.close(1003, "live audio messages must be JSON");
			return;
		}
		if (!isObject(value) || value.t !== "audio" || typeof value.data !== "string" ||
			value.data.length === 0 || value.data.length > MAX_INPUT_BASE64_CHARS || value.data.length % 4 !== 0 || !LIVE_INPUT_BASE64.test(value.data)) {
			socket.close(1008, "invalid live audio frame");
			return;
		}
		if (!consumeFrameToken(data)) return;
		try {
			data.supervisor.sendLiveAudio(data.liveSessionId, value.data);
		} catch (error) {
			this.#send(socket, { t: "error", message: error instanceof SupervisorError ? error.message : "Live audio frame was rejected." });
			socket.close(1008, "live audio unavailable");
		}
	}

	close(socket: Bun.ServerWebSocket<RelaySocketData>): void {
		const data = liveSocketData(socket.data);
		if (!data || data.rejected || this.#sockets.get(data.liveSessionId) !== socket) return;
		this.#sockets.delete(data.liveSessionId);
		void data.supervisor.sessionOp(data.liveSessionId, { op: "live-mode", action: "stop" }).catch(() => {});
	}

	publishState(sessionId: string, liveMode: LiveModeStatus): void {
		this.#publish(sessionId, { t: "state", liveMode });
	}

	publishAudio(sessionId: string, audio: string): void {
		if (audio.length > LIVE_AUDIO_EVENT_MAX_CHARS) return;
		this.#publish(sessionId, { t: "audio", audio });
	}

	publishLevels(sessionId: string, input: number, output: number): void {
		this.#publish(sessionId, { t: "levels", input, output });
	}

	#send(socket: Bun.ServerWebSocket<RelaySocketData>, frame: Record<string, unknown>): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		const message = JSON.stringify(frame);
		if (socket.getBufferedAmount() + Buffer.byteLength(message) > MAX_QUEUED_BYTES || socket.send(message) === 0) {
			socket.close(1013, "live stream is too slow");
		}
	}

	#publish(sessionId: string, frame: Record<string, unknown>): void {
		const socket = this.#sockets.get(sessionId);
		if (!socket) return;
		this.#send(socket, frame);
	}
}

export function withLiveWebSocket(
	base: Bun.WebSocketHandler<RelaySocketData>,
	live: LiveSocketHub,
): Bun.WebSocketHandler<RelaySocketData> {
	return {
		...base,
		open(socket): void | Promise<void> {
			if (liveSocketData(socket.data)) return live.open(socket);
			return base.open?.(socket);
		},
		message(socket, message): void | Promise<void> {
			if (liveSocketData(socket.data)) return live.message(socket, message);
			return base.message(socket, message);
		},
		close(socket, code, reason): void | Promise<void> {
			if (liveSocketData(socket.data)) return live.close(socket);
			return base.close?.(socket, code, reason);
		},
		ping(socket, data): void | Promise<void> {
			if (liveSocketData(socket.data)) return;
			return base.ping?.(socket, data);
		},
		pong(socket, data): void | Promise<void> {
			if (liveSocketData(socket.data)) return;
			return base.pong?.(socket, data);
		},
		drain(socket): void | Promise<void> {
			if (liveSocketData(socket.data)) return;
			return base.drain?.(socket);
		},
	};
}

export function isLiveAudioStatus(value: unknown): value is Extract<WorkerStatus, { t: "live-audio" }> {
	return isObject(value) && value.t === "live-audio" && typeof value.audio === "string" && value.audio.length <= LIVE_AUDIO_EVENT_MAX_CHARS;
}

export function isLiveLevelsStatus(value: unknown): value is Extract<WorkerStatus, { t: "live-levels" }> {
	if (!isObject(value) || value.t !== "live-levels") return false;
	return typeof value.input === "number" && Number.isFinite(value.input) && value.input >= 0 && value.input <= 1 &&
		typeof value.output === "number" && Number.isFinite(value.output) && value.output >= 0 && value.output <= 1;
}
