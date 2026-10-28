import { afterEach, describe, expect, it } from "bun:test";
import { LIVE_AUDIO_EVENT_MAX_CHARS, type LiveModeStatus, type SessionOpV3, type SessionOpV3Result, type WorkerRequestResult } from "@omp-console/protocol";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveModeControllerService } from "../src/live-mode";
import { Fixture, newRoom, type WorkerProcess } from "./harness";

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

let requestId = 0;
async function liveOp(worker: WorkerProcess, operation: Extract<SessionOpV3, { op: "live-mode" }>): Promise<WorkerRequestResult> {
	return worker.request<WorkerRequestResult>({ t: "session-op", id: `live-${++requestId}`, op: operation });
}

function result(reply: WorkerRequestResult): SessionOpV3Result {
	if (reply.t !== "session-op") throw new Error(`expected a live-mode result, got ${JSON.stringify(reply)}`);
	return reply.result;
}

describe("live mode", () => {
	it("bounds browser PCM frames and exposes phase, transcript, levels, audio, and stop transitions", async () => {
		const session = { settings: Settings.isolated() } as unknown as AgentSession;
		let onControllerEvent: LiveSessionControllerOptions["callbacks"] | undefined;
		const received: Float32Array[] = [];
		const relayedAudio: string[] = [];
		const levels: Array<[number, number]> = [];
		const service = new LiveModeControllerService({
			session,
			onChanged() {},
			onAudio(audio) { relayedAudio.push(audio); },
			onLevels(input, output) { levels.push([input, output]); },
			createSession(options) {
				onControllerEvent = options.callbacks;
				return {
					async start() {
						onControllerEvent?.onPhase("listening");
						onControllerEvent?.onTranscript({ role: "user", text: ` ${"x".repeat(300)} `, turn: 1, final: false });
						onControllerEvent?.onLevels(0.4, 0.2);
						onControllerEvent?.onAudio?.("AQID");
						onControllerEvent?.onAudio?.("A".repeat(LIVE_AUDIO_EVENT_MAX_CHARS + 1));
					},
					async stop() {},
					pushAudio(samples) { received.push(samples); },
				};
			},
		});

		expect(() => service.pushAudio(Buffer.alloc(4).toString("base64"))).toThrow("Live mode is not active");
		const started = await service.start();
		expect(started).toMatchObject({ active: true, phase: "listening", transcript: { role: "user", final: false } });
		expect(started.transcript?.text).toHaveLength(240);
		expect(levels).toEqual([[0.4, 0.2]]);
		expect(service.status().active).toBe(true);
		expect(relayedAudio).toEqual(["AQID"]);

		const pcm = Buffer.alloc(8);
		pcm.writeFloatLE(0.25, 0);
		pcm.writeFloatLE(-0.5, 4);
		service.pushAudio(pcm.toString("base64"));
		expect(received).toEqual([new Float32Array([0.25, -0.5])]);
		const invalidPcm = Buffer.alloc(4);
		invalidPcm.writeFloatLE(2, 0);
		expect(() => service.pushAudio(invalidPcm.toString("base64"))).toThrow("between -1 and 1");

		expect(await service.stop()).toEqual({ active: false, phase: "idle" });
		expect(service.status()).toEqual({ active: false, phase: "idle" });
	});

	it("passes the browser SDP offer and signaling answer through the worker service", async () => {
		const session = { settings: Settings.isolated() } as unknown as AgentSession;
		const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=setup:actpass\r\na=sendrecv\r\n";
		const answer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=setup:active\r\na=recvonly\r\n";
		const service = new LiveModeControllerService({
			session,
			onChanged() {},
			createSession(options) {
				expect(options.browserOffer).toBe(offer);
				return {
					async start() {
						options.onBrowserAnswer?.(answer);
						options.callbacks.onPhase("listening");
					},
					async stop() {},
					pushAudio() {},
				};
			},
		});

		expect(await service.run("start", offer)).toMatchObject({ active: true, phase: "listening" });
		expect(service.browserAnswer()).toBe(answer);
		await service.run("stop");
		expect(service.browserAnswer()).toBeUndefined();
	});
	it("returns the browser answer while sideband setup is still pending", async () => {
		const session = { settings: Settings.isolated() } as unknown as AgentSession;
		const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
		const answer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
		const answerDelivered = Promise.withResolvers<void>();
		const sidebandConnected = Promise.withResolvers<void>();
		const startupFinished = Promise.withResolvers<void>();
		const service = new LiveModeControllerService({
			session,
			onChanged() {},
			createSession(options) {
				return {
					async start() {
						options.onBrowserAnswer?.(answer);
						answerDelivered.resolve();
						await sidebandConnected.promise;
						options.callbacks.onPhase("listening");
						startupFinished.resolve();
					},
					async stop() {},
					pushAudio() {},
				};
			},
		});

		let response: LiveModeStatus | undefined;
		let failure: unknown;
		const operation = service.run("start", offer).then(
			value => { response = value; },
			cause => { failure = cause; },
		);
		await answerDelivered.promise;
		for (let index = 0; index < 4; index += 1) await Promise.resolve();
		const returnedBeforeSideband = response !== undefined;
		sidebandConnected.resolve();
		await startupFinished.promise;
		await operation;

		expect(returnedBeforeSideband).toBe(true);
		expect(failure).toBeUndefined();
		expect(response).toMatchObject({ active: true, phase: "connecting" });
		expect(service.browserAnswer()).toBe(answer);
		expect(service.status()).toMatchObject({ active: true, phase: "listening" });
		await service.stop();
	});

	it("rejects a second browser offer while a live session already owns the peer", async () => {
		const session = { settings: Settings.isolated() } as unknown as AgentSession;
		const service = new LiveModeControllerService({
			session,
			onChanged() {},
			createSession(options) {
				return {
					async start() {
						options.onBrowserAnswer?.("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
					},
					async stop() {},
					pushAudio() {},
				};
			},
		});

		await service.run("start", "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
		await expect(service.run("start", "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 112\r\n")).rejects.toMatchObject({ code: "conflict" });
		await service.stop();
	});


	it("serves status through a real worker without opening a realtime connection", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		await worker.ready();

		const reply = result(await liveOp(worker, { op: "live-mode", action: "status" }));
		expect(reply).toMatchObject({ ok: true, liveMode: { active: false, phase: "idle" } });
		worker.send({ t: "stop" });
		await worker.exited;
	});
});
