import type { LiveModeStatus, SessionOpV3Result } from "@omp-console/protocol";
import { Mic, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { Sheet } from "../shell/Sheet";
import "./live.css";

const OUTPUT_LIMIT = 50;
const PHASES: readonly LiveModeStatus["phase"][] = ["idle", "connecting", "listening", "speaking", "working", "muted", "error"];

type LiveMessage =
	| { t: "state"; liveMode: LiveModeStatus }
	| { t: "levels"; input: number; output: number }
	| { t: "error"; message: string };

interface LiveResourceSet {
	stream?: MediaStream;
	peer?: RTCPeerConnection;
	socket?: WebSocket;
	context?: AudioContext;
	inputAnalyser?: AnalyserNode;
	outputAnalyser?: AnalyserNode;
	meterFrame?: number;
}

export interface LivePanelProps {
	api: Pick<DeckApi, "sessionOpV3">;
	sessionId: string | undefined;
	readOnly: boolean;
	command?: string;
	onClose(): void;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The live audio session could not start.";
}

function phaseLabel(phase: LiveModeStatus["phase"]): string {
	return phase === "idle" ? "Ready" : phase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLiveMessage(raw: string): LiveMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || typeof value.t !== "string") return undefined;
	if (value.t === "error" && typeof value.message === "string") return { t: "error", message: value.message };
	if (value.t === "levels" && typeof value.input === "number" && typeof value.output === "number") {
		return { t: "levels", input: value.input, output: value.output };
	}
	if (value.t !== "state" || !isRecord(value.liveMode)) return undefined;
	const mode = value.liveMode;
	if (typeof mode.active !== "boolean" || typeof mode.phase !== "string" || !PHASES.includes(mode.phase as LiveModeStatus["phase"])) return undefined;
	if (mode.error !== undefined && typeof mode.error !== "string") return undefined;
	if (mode.transcript !== undefined && (!isRecord(mode.transcript) ||
		(mode.transcript.role !== "user" && mode.transcript.role !== "assistant") ||
		typeof mode.transcript.text !== "string" || typeof mode.transcript.final !== "boolean")) return undefined;
	return { t: "state", liveMode: mode as unknown as LiveModeStatus };
}

function measure(analyser: AnalyserNode | undefined, buffer: Float32Array<ArrayBuffer>): number {
	if (!analyser) return 0;
	analyser.getFloatTimeDomainData(buffer);
	let total = 0;
	for (let index = 0; index < buffer.length; index += 1) total += (buffer[index] ?? 0) ** 2;
	return Math.min(1, Math.sqrt(total / buffer.length));
}

function iceGatheringComplete(peer: RTCPeerConnection): boolean {
	return peer.iceGatheringState === "complete";
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
	if (iceGatheringComplete(peer)) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const onChange = (): void => {
		if (iceGatheringComplete(peer)) resolve();
	};
	const timeout = window.setTimeout(resolve, 5_000);
	peer.addEventListener("icegatheringstatechange", onChange);
	onChange();
	try {
		await promise;
		if (!iceGatheringComplete(peer)) throw new Error("ICE gathering timed out before a complete browser SDP offer was available.");
	} finally {
		window.clearTimeout(timeout);
		peer.removeEventListener("icegatheringstatechange", onChange);
	}
}

function stopDevices(resources: LiveResourceSet, audio: HTMLAudioElement | null): void {
	if (resources.meterFrame !== undefined) cancelAnimationFrame(resources.meterFrame);
	resources.meterFrame = undefined;
	resources.peer?.close();
	resources.peer = undefined;
	for (const track of resources.stream?.getTracks() ?? []) track.stop();
	resources.stream = undefined;
	if (resources.context && resources.context.state !== "closed") void resources.context.close().catch(() => {});
	resources.context = undefined;
	resources.inputAnalyser = undefined;
	resources.outputAnalyser = undefined;
	if (audio) {
		audio.pause();
		audio.srcObject = null;
	}
}

export function LivePanel({ api, sessionId, command, readOnly, onClose }: LivePanelProps): ReactNode {
	const [status, setStatus] = useState<LiveModeStatus>({ active: false, phase: "idle" });
	const [transcripts, setTranscripts] = useState<Array<{ role: "user" | "assistant"; text: string; final: boolean }>>([]);
	const [levels, setLevels] = useState({ input: 0, output: 0 });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const resources = useRef<LiveResourceSet>({});
	const audio = useRef<HTMLAudioElement>(null);
	const mounted = useRef(true);
	const active = useRef(false);
	const operationStarted = useRef(false);
	const statusRef = useRef(status);

	const applyStatus = useCallback((next: LiveModeStatus): void => {
		if (!mounted.current) return;
		active.current = next.active;
		statusRef.current = next;
		setStatus(next);
		const transcript = next.transcript;
		if (!transcript || transcript.text === "") return;
		setTranscripts(previous => {
			const tail = previous.at(-1);
			if (tail && !tail.final && tail.role === transcript.role) {
				return [...previous.slice(0, -1), transcript].slice(-OUTPUT_LIMIT);
			}
			return [...previous, transcript].slice(-OUTPUT_LIMIT);
		});
	}, []);

	const release = useCallback((closeSocket: boolean): void => {
		const current = resources.current;
		stopDevices(current, audio.current);
		if (closeSocket && current.socket) {
			current.socket.onmessage = null;
			current.socket.onclose = null;
			current.socket.onerror = null;
			if (current.socket.readyState === WebSocket.OPEN || current.socket.readyState === WebSocket.CONNECTING) current.socket.close();
		}
		resources.current = {};
	}, []);

	const stop = useCallback(async (): Promise<void> => {
		active.current = false;
		const shouldStop = operationStarted.current || statusRef.current.active;
		operationStarted.current = false;
		release(true);
		setLevels({ input: 0, output: 0 });
		try {
			if (shouldStop && sessionId && !readOnly) {
				const result = await api.sessionOpV3(sessionId, { op: "live-mode", action: "stop" });
				if ("liveMode" in result) applyStatus(result.liveMode);
			}
		} catch (cause) {
			if (mounted.current) setError(errorMessage(cause));
		}
	}, [api, applyStatus, readOnly, release, sessionId]);

	useEffect(() => {
		let current = true;
		mounted.current = true;
		if (sessionId) {
			void api.sessionOpV3(sessionId, { op: "live-mode", action: "status" }).then(result => {
				if (current && "liveMode" in result) applyStatus(result.liveMode);
			}).catch(cause => {
				if (current) setError(errorMessage(cause));
			});
		}
		const onVisibility = (): void => {
			if (document.visibilityState === "hidden" && (operationStarted.current || active.current || resources.current.stream)) void stop();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			current = false;
			mounted.current = false;
			const shouldStop = !readOnly && (operationStarted.current || active.current);
			operationStarted.current = false;
			active.current = false;
			release(true);
			if (shouldStop && sessionId) void api.sessionOpV3(sessionId, { op: "live-mode", action: "stop" }).catch(() => {});
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [api, applyStatus, readOnly, release, sessionId, stop]);

	const start = async (): Promise<void> => {
		if (!sessionId || busy || active.current || readOnly) return;
		setBusy(true);
		setError(null);
		try {
			if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not provide microphone capture.");
			const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
			if (!mounted.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			resources.current.stream = stream;
			const context = new AudioContext();
			resources.current.context = context;
			await context.resume();
			const inputAnalyser = context.createAnalyser();
			inputAnalyser.fftSize = 256;
			resources.current.inputAnalyser = inputAnalyser;
			context.createMediaStreamSource(stream).connect(inputAnalyser);
			const meterBuffer = new Float32Array(inputAnalyser.fftSize);
			const measureLevels = (): void => {
				if (!mounted.current || !active.current && !operationStarted.current) return;
				const input = measure(resources.current.inputAnalyser, meterBuffer);
				const output = measure(resources.current.outputAnalyser, meterBuffer);
				setLevels({ input, output });
				const previous = statusRef.current;
				if (previous.active && previous.phase !== "working" && previous.phase !== "muted" && previous.phase !== "error") {
					const phase: LiveModeStatus["phase"] = output > 0.015 ? "speaking" : previous.phase === "speaking" ? "listening" : previous.phase;
					if (phase !== previous.phase) {
						const next: LiveModeStatus = { ...previous, phase };
						statusRef.current = next;
						setStatus(next);
					}
				}
				resources.current.meterFrame = requestAnimationFrame(measureLevels);
			};
			resources.current.meterFrame = requestAnimationFrame(measureLevels);

			const peer = new RTCPeerConnection();
			resources.current.peer = peer;
			for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
			peer.createDataChannel("oai-events");
			peer.ontrack = event => {
				if (!mounted.current || !resources.current.context) return;
				const remote = event.streams[0] ?? new MediaStream([event.track]);
				if (audio.current) {
					audio.current.srcObject = remote;
					void audio.current.play().catch(cause => setError(errorMessage(cause)));
				}
				const outputAnalyser = resources.current.context.createAnalyser();
				outputAnalyser.fftSize = 256;
				resources.current.outputAnalyser = outputAnalyser;
				resources.current.context.createMediaStreamSource(remote).connect(outputAnalyser);
			};
			peer.onconnectionstatechange = () => {
				if (peer.connectionState === "failed" && mounted.current) setError("The browser WebRTC connection failed.");
			};
			const offer = await peer.createOffer();
			await peer.setLocalDescription(offer);
			await waitForIceGathering(peer);
			const sdp = peer.localDescription?.sdp;
			if (!sdp) throw new Error("The browser did not produce a WebRTC SDP offer.");

			const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/live/${encodeURIComponent(sessionId)}`);
			resources.current.socket = socket;
			const opened = Promise.withResolvers<void>();
			socket.addEventListener("open", () => opened.resolve(), { once: true });
			socket.addEventListener("error", () => opened.reject(new Error("The live state connection failed.")), { once: true });
			socket.addEventListener("close", () => opened.reject(new Error("The live state connection closed before starting.")), { once: true });
			socket.onclose = () => {
				if (!active.current && !operationStarted.current) return;
				active.current = false;
				const shouldStop = operationStarted.current;
				operationStarted.current = false;
				release(false);
				if (mounted.current) setError("The live state connection closed while voice was active.");
				if (shouldStop && sessionId && !readOnly) void api.sessionOpV3(sessionId, { op: "live-mode", action: "stop" }).catch(() => {});
			};
			socket.onmessage = event => {
				const frame = parseLiveMessage(String(event.data));
				if (!frame) {
					if (mounted.current) setError("The live state connection returned an invalid message.");
					return;
				}
				if (frame.t === "state") applyStatus(frame.liveMode);
				else if (frame.t === "levels") setLevels({ input: frame.input, output: frame.output });
				else setError(frame.message);
			};
			await opened.promise;
			if (!mounted.current) return;
			operationStarted.current = true;
			const result: SessionOpV3Result = await api.sessionOpV3(sessionId, { op: "live-mode", action: "start", offer: sdp });
			if (!operationStarted.current || !mounted.current) return;
			if (!("liveMode" in result) || !result.browserAnswer) throw new Error("The worker returned no authenticated browser SDP answer.");
			await peer.setRemoteDescription({ type: "answer", sdp: result.browserAnswer });
			if (!operationStarted.current || !mounted.current) return;
			active.current = true;
			setTranscripts([]);
			applyStatus(result.liveMode);
		} catch (cause) {
			active.current = false;
			const shouldStop = operationStarted.current;
			operationStarted.current = false;
			release(true);
			if (shouldStop && sessionId && !readOnly) void api.sessionOpV3(sessionId, { op: "live-mode", action: "stop" }).catch(() => {});
			if (mounted.current) setError(errorMessage(cause));
		} finally {
			if (mounted.current) setBusy(false);
		}
	};

	const close = (): void => {
		if (!readOnly && (operationStarted.current || active.current)) void stop();
		onClose();
	};

	const running = status.active || operationStarted.current;
	return (
		<Sheet title="Live" windowKind="live" onClose={close}>
			<div className="live-panel" data-session-id={sessionId ?? "unavailable"}>
				{command === "live" ? <p className="dk-hint">Realtime voice for this session.</p> : null}
				{sessionId === undefined ? <p className="dk-hint" role="status">Open a daemon session to start live voice.</p> : null}
				{readOnly ? <p className="live-warning" role="note">Read-only session: microphone and live-session controls are disabled.</p> : null}
				<div className="live-controls">
					<span className="live-phase" role="status" aria-label={`Live phase: ${phaseLabel(status.phase)}`}>{phaseLabel(status.phase)}</span>
					{running ? <button type="button" className="sh-btn" onClick={() => void stop()} disabled={busy || readOnly}><Square size={14} aria-hidden="true" /> Stop</button> : <button type="button" className="sh-btn sh-btn-primary" onClick={() => void start()} disabled={busy || readOnly || !sessionId}><Mic size={14} aria-hidden="true" /> {busy ? "Connecting…" : "Start live"}</button>}
				</div>
				<div className="live-meters" aria-label="Live audio levels">
					{(["input", "output"] as const).map(kind => <label className="live-meter" key={kind}>
						<span>{kind === "input" ? "Mic" : "Remote"}</span>
						<span className="live-meter-track" role="meter" aria-label={`${kind} audio level`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={levels[kind]}><span style={{ width: `${Math.round(Math.min(1, Math.max(0, levels[kind])) * 100)}%` }} /></span>
					</label>)}
				</div>
				<audio ref={audio} className="live-audio-output" autoPlay controls playsInline aria-label="Assistant voice output" />
				<p className="live-warning" role="note">The browser owns microphone capture and speaker playback. Live capture and the session stop when this page is hidden or the sheet closes.</p>
				{status.error ? <p className="live-error" role="alert">{status.error}</p> : null}
				{error ? <p className="live-error" role="alert">{error}</p> : null}
				<section className="live-transcript" aria-label="Live transcript" aria-live="polite">
					{transcripts.length === 0 ? <p className="dk-hint">Transcript appears here as the conversation is recognized.</p> : transcripts.map((line, index) => <p key={`${index}:${line.role}:${line.text}`}><strong>{line.role === "user" ? "You" : "Assistant"}{line.final ? " · final" : " · live"}</strong><br />{line.text}</p>)}
				</section>
			</div>
		</Sheet>
	);
}
