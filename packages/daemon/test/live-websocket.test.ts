import { afterEach, describe, expect, it } from "bun:test";
import type { SessionOp, SessionOpResult, SessionOpV3, SessionOpV3Result } from "@omp-console/protocol";
import type { RelaySocketData } from "../src/relay";
import { LiveSocketHub } from "../src/live-websocket";
import type { Supervisor } from "../src/supervisor";
import { closeAllSockets, socket, until, waitEvent, waitOpen, waitText } from "./ws-helpers";

let server: Bun.Server<RelaySocketData> | undefined;
let liveHub: LiveSocketHub | undefined;
let deferredClose: Bun.ServerWebSocket<RelaySocketData>[] = [];
let deferClose = false;
let stopped = 0;
let audioFrames = 0;
let receivedMessages = 0;

afterEach(async () => {
	closeAllSockets();
	await server?.stop(true);
	server = undefined;
	liveHub = undefined;
	deferredClose = [];
	deferClose = false;
	stopped = 0;
	audioFrames = 0;
	receivedMessages = 0;
});

function startLiveServer(): void {
	liveHub = new LiveSocketHub();
	stopped = 0;
	audioFrames = 0;
	const hub = liveHub;
	const supervisor = {
		async sessionOp(_sessionId: string, op: SessionOp | SessionOpV3): Promise<SessionOpResult | SessionOpV3Result> {
			if (op.op === "live-mode" && op.action === "stop") stopped += 1;
			if (op.op === "live-mode" && op.action === "status") return { ok: true, liveMode: { active: false, phase: "idle" } };
			return { ok: true };
		},
		sendLiveAudio() {
			audioFrames += 1;
		},
	} as unknown as Supervisor;
	server = Bun.serve<RelaySocketData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			return hub.upgrade(request, srv, supervisor) ?? new Response("not found", { status: 404 });
		},
		websocket: {
			open: socket => hub.open(socket),
			message: (socket, message) => {
				receivedMessages += 1;
				hub.message(socket, message);
			},
			close: socket => {
				if (deferClose) deferredClose.push(socket);
				else hub.close(socket);
			},
		},
	});
}

function connect(sessionId = "session-1"): WebSocket {
	if (!server) throw new Error("live test server is not running");
	return socket(`ws://127.0.0.1:${server.port}`, `/live/${sessionId}`);
}

async function openWithInitialState(ws: WebSocket): Promise<void> {
	await waitOpen(ws);
	const frame = JSON.parse(await waitText(ws, "initial live state")) as { t: string };
	expect(frame.t).toBe("state");
}

describe("live audio WebSocket ownership and frame budget", () => {
	it("does not stop the current stream when a duplicate owner socket is rejected", async () => {
		startLiveServer();
		const owner = connect();
		await openWithInitialState(owner);

		const duplicate = connect();
		const closed = waitEvent<CloseEvent>(duplicate, "close", "duplicate socket rejection");
		duplicate.addEventListener("open", () => duplicate.send(JSON.stringify({ t: "audio", data: Buffer.alloc(4).toString("base64") })), { once: true });
		await waitOpen(duplicate);
		const close = await closed;
		expect(close.code).toBe(4009);
		expect(audioFrames).toBe(0);
		expect(stopped).toBe(0);
		expect(owner.readyState).toBe(WebSocket.OPEN);
	});

	it("ignores a delayed close from a replaced socket and stops only the current owner", async () => {
		startLiveServer();
		const owner = connect();
		await openWithInitialState(owner);
		deferClose = true;
		const ownerClosed = waitEvent<CloseEvent>(owner, "close", "old owner close");
		owner.close();
		await ownerClosed;
		await until(() => deferredClose.length === 1, "deferred old socket close callback");

		deferClose = false;
		const replacement = connect();
		await openWithInitialState(replacement);
		const oldSocket = deferredClose[0];
		if (!oldSocket || !liveHub) throw new Error("server did not retain the old socket for the delayed callback");
		liveHub.close(oldSocket);
		await Bun.sleep(20);
		expect(stopped).toBe(0);

		const replacementClosed = waitEvent<CloseEvent>(replacement, "close", "replacement owner close");
		replacement.close();
		await replacementClosed;
		await until(() => stopped === 1, "current owner stop operation");
	});

	it("drops excess frames above a 2x-rate burst budget without closing the owner socket", async () => {
		startLiveServer();
		const owner = connect();
		await openWithInitialState(owner);
		const frame = JSON.stringify({ t: "audio", data: Buffer.alloc(4).toString("base64") });
		for (let index = 0; index < 250; index += 1) owner.send(frame);
		await until(() => receivedMessages === 250, "all live PCM frames processed");
		expect(audioFrames).toBeGreaterThanOrEqual(100);
		expect(audioFrames).toBeLessThan(receivedMessages);
		expect(owner.readyState).toBe(WebSocket.OPEN);
	});

	it("closes binary live frames with unsupported-data code 1003", async () => {
		startLiveServer();
		const owner = connect();
		await openWithInitialState(owner);
		const closed = waitEvent<CloseEvent>(owner, "close", "binary frame rejection");
		owner.send(new Uint8Array([1, 2, 3]));
		expect((await closed).code).toBe(1003);
		expect(stopped).toBe(1);
	});
});
