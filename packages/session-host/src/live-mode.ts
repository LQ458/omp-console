import { LIVE_AUDIO_EVENT_MAX_CHARS, LIVE_INPUT_MAX_FRAME_BYTES, LIVE_INPUT_SAMPLE_RATE } from "@omp-console/protocol";
import type { LiveModeStatus } from "@omp-console/protocol";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { cfgLiveVoice } from "@oh-my-pi/pi-coding-agent/live/settings";
import { extractVisibleAssistantText } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { RequestError } from "./request-error";

export type LiveSession = Pick<LiveSessionController, "start" | "stop" | "pushAudio">;
export type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSession;

export interface LiveModeOptions {
	session: AgentSession;
	onChanged(): void;
	onAudio?(audio: string): void;
	onLevels?(input: number, output: number): void;
	createSession?: LiveSessionFactory;
}

const TRANSCRIPT_PREVIEW_CHARS = 240;
const LIVE_FRAME_BASE64_CHARS = Math.ceil(LIVE_INPUT_MAX_FRAME_BYTES / 3) * 4;
const FLOAT_AUDIO_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LIVE_OUTPUT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function safeError(cause: unknown): string {
	const raw = cause instanceof Error ? cause.message : String(cause);
	return raw
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)\S+/gi, "$1[redacted]")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.trim()
		.slice(0, TRANSCRIPT_PREVIEW_CHARS);
}

/** Owns one `/live` controller and accepts only bounded browser PCM frames. */
export class LiveModeControllerService {
	readonly #session: AgentSession;
	readonly #onChanged: () => void;
	readonly #onAudio: ((audio: string) => void) | undefined;
	readonly #onLevels: ((input: number, output: number) => void) | undefined;
	readonly #createSession: LiveSessionFactory;
	#status: LiveModeStatus = { active: false, phase: "idle" };
	#controller: LiveSession | undefined;
	#browserAnswer: string | undefined;
	#pendingLevels: { input: number; output: number } | undefined;
	#levelsTimer: Timer | undefined;
	#lastLevelsAt = 0;

	constructor(options: LiveModeOptions) {
		this.#session = options.session;
		this.#onChanged = options.onChanged;
		this.#onAudio = options.onAudio;
		this.#onLevels = options.onLevels;
		this.#createSession = options.createSession ?? (controllerOptions => new LiveSessionController(controllerOptions));
	}

	status(): LiveModeStatus {
		return this.#status.transcript ? { ...this.#status, transcript: { ...this.#status.transcript } } : { ...this.#status };
	}
	browserAnswer(): string | undefined {
		return this.#browserAnswer;
	}

	async run(action: "start" | "stop" | "status", offer?: string, signal?: AbortSignal): Promise<LiveModeStatus> {
		if (action === "status") return this.status();
		if (action === "stop") return this.stop();
		if (offer === undefined) throw new RequestError("bad-request", "Live mode needs the browser WebRTC SDP offer.");
		return this.start(offer, signal);
	}

	pushAudio(data: string): void {
		const encodedLength = data.length;
		if (encodedLength === 0 || encodedLength > LIVE_FRAME_BASE64_CHARS || encodedLength % 4 !== 0 || !FLOAT_AUDIO_BASE64.test(data)) {
			throw new RequestError("bad-request", "Live audio must be one bounded base64 PCM frame.");
		}
		const bytes = Buffer.from(data, "base64");
		if (bytes.byteLength === 0 || bytes.byteLength > LIVE_INPUT_MAX_FRAME_BYTES || bytes.byteLength % 4 !== 0 || bytes.byteLength / 4 > LIVE_INPUT_SAMPLE_RATE / 25) {
			throw new RequestError("bad-request", "Live PCM frames must contain 16 kHz mono Float32 samples within the frame limit.");
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const samples = new Float32Array(bytes.byteLength / 4);
		for (let index = 0; index < samples.length; index += 1) {
			const sample = view.getFloat32(index * 4, true);
			if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
				throw new RequestError("bad-request", "Live PCM samples must be finite Float32 values between -1 and 1.");
			}
			samples[index] = sample;
		}
		if (!this.#controller || !this.#status.active) throw new RequestError("conflict", "Live mode is not active.");
		this.#controller.pushAudio(samples);
	}

	async start(offer?: string, signal?: AbortSignal): Promise<LiveModeStatus> {
		if (this.#controller) {
			if (offer !== undefined) throw new RequestError("conflict", "A live session already owns a browser peer.");
			return this.status();
		}
		if (offer !== undefined && (offer.trim() === "" || offer.length > 64 * 1024)) {
			throw new RequestError("bad-request", "Live mode needs a non-empty browser WebRTC SDP offer of at most 65536 characters.");
		}
		this.#browserAnswer = undefined;
		const browserAnswer = offer === undefined ? undefined : Promise.withResolvers<string>();
		const controller = this.#createSession({
			session: this.#session,
			extractAssistantText: extractVisibleAssistantText,
			voice: cfgLiveVoice.get(this.#session.settings),
			audioInput: "external",
			...(offer === undefined ? {} : { browserOffer: offer }),
			...(signal === undefined ? {} : { signal }),
			...(offer === undefined ? {} : {
				onBrowserAnswer: (answer: string) => {
					if (answer.length > 64 * 1024) throw new Error("Realtime signaling returned an oversized browser SDP answer.");
					this.#browserAnswer = answer;
					browserAnswer?.resolve(answer);
				},
			}),
			callbacks: {
				onPhase: phase => this.#update({ ...this.#status, active: true, phase }),
				onLevels: (input, output) => this.#queueLevels(input, output),
				onTranscript: transcript => {
					if (!transcript) {
						this.#update({ ...this.#status, transcript: undefined });
						return;
					}
					const text = transcript.text.trim();
					this.#update({
						...this.#status,
						transcript: { role: transcript.role, text: text.slice(-TRANSCRIPT_PREVIEW_CHARS), final: transcript.final },
					});
				},
				onAudio: audio => {
					if (audio.length > LIVE_AUDIO_EVENT_MAX_CHARS || !LIVE_OUTPUT_BASE64.test(audio)) return;
					// The browser's WebRTC peer plays remote audio directly; sideband deltas are not relayed.
					if (offer === undefined) this.#onAudio?.(audio);
				},
				onTerminal: error => {
					if (this.#controller !== controller) return;
					this.#browserAnswer = undefined;
					this.#controller = undefined;
					this.#clearLevels();
					this.#update(error
						? { active: false, phase: "error", error: safeError(error) || "Live session failed." }
						: { active: false, phase: "idle" });
				},
			},
		});
		this.#controller = controller;
		this.#update({ active: true, phase: "connecting" });
		const startup = (async (): Promise<RequestError | undefined> => {
			try {
				await controller.start();
				return undefined;
			} catch (cause) {
				if (this.#controller === controller) {
					this.#controller = undefined;
					this.#browserAnswer = undefined;
					this.#clearLevels();
					this.#update({ active: false, phase: "error", error: safeError(cause) || "Live session failed." });
				}
				return new RequestError("bad-request", safeError(cause) || "Live session could not start.");
			}
		})();
		if (browserAnswer) {
			const outcome = await Promise.race([
				browserAnswer.promise.then(() => ({ kind: "answer" as const })),
				startup.then(error => error
					? { kind: "error" as const, error }
					: { kind: "started" as const }),
			]);
			if (outcome.kind === "error") throw outcome.error;
			return this.status();
		}
		const error = await startup;
		if (error) throw error;
		return this.status();
	}

	async stop(): Promise<LiveModeStatus> {
		const controller = this.#controller;
		if (!controller) return this.status();
		try {
			await controller.stop();
		} catch (cause) {
			if (this.#controller === controller) {
				this.#controller = undefined;
				this.#browserAnswer = undefined;
				this.#clearLevels();
				this.#update({ active: false, phase: "error", error: safeError(cause) || "Live session could not stop." });
			}
			throw new RequestError("internal", safeError(cause) || "Live session could not stop.");
		}
		if (this.#controller === controller) {
			this.#controller = undefined;
			this.#browserAnswer = undefined;
			this.#clearLevels();
			this.#update({ active: false, phase: "idle" });
		}
		return this.status();
	}

	#queueLevels(input: number, output: number): void {
		this.#pendingLevels = { input, output };
		const remaining = 100 - (Date.now() - this.#lastLevelsAt);
		if (remaining <= 0) {
			this.#flushLevels();
		} else if (!this.#levelsTimer) {
			this.#levelsTimer = setTimeout(() => this.#flushLevels(), remaining);
			this.#levelsTimer.unref();
		}
	}

	#flushLevels(): void {
		if (this.#levelsTimer) clearTimeout(this.#levelsTimer);
		this.#levelsTimer = undefined;
		const levels = this.#pendingLevels;
		this.#pendingLevels = undefined;
		if (!levels) return;
		this.#lastLevelsAt = Date.now();
		this.#onLevels?.(levels.input, levels.output);
	}

	#clearLevels(): void {
		if (this.#levelsTimer) clearTimeout(this.#levelsTimer);
		this.#levelsTimer = undefined;
		this.#pendingLevels = undefined;
	}

	#update(status: LiveModeStatus): void {
		this.#status = status;
		this.#onChanged();
	}
}
