import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Sheet } from "../shell/Sheet";
import "./record.css";

type RecordingState = "idle" | "requesting" | "recording" | "stopping";

interface RecordingHandle {
	recorder: MediaRecorder;
	stream: MediaStream;
	chunks: Blob[];
	startedAt: number;
}

function supportedWebmMimeType(): string | null {
	if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
	return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}

function elapsedLabel(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
	const seconds = (totalSeconds % 60).toString().padStart(2, "0");
	return `${minutes}:${seconds}`;
}

function recordingFilename(date: Date): string {
	const stamp = [date.getFullYear(), (date.getMonth() + 1).toString().padStart(2, "0"), date.getDate().toString().padStart(2, "0"), "-", date.getHours().toString().padStart(2, "0"), date.getMinutes().toString().padStart(2, "0"), date.getSeconds().toString().padStart(2, "0")].join("");
	return `omp-console-recording-${stamp}.webm`;
}
function downloadBlob(blob: Blob, filename: string): string {
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
	} catch (cause) {
		URL.revokeObjectURL(url);
		throw cause;
	}
	return url;
}

export function RecordPanel({ onClose }: { onClose(): void }): ReactNode {
	const [state, setState] = useState<RecordingState>("idle");
	const [elapsed, setElapsed] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);
	const [copied, setCopied] = useState(false);
	const [closeRequested, setCloseRequested] = useState(false);
	const handle = useRef<RecordingHandle | null>(null);
	const mounted = useRef(true);
	const stateRef = useRef(state);
	stateRef.current = state;
	const closeAfterSave = useRef(false);
	const allowDeferredClose = useRef(false);
	const mimeType = supportedWebmMimeType();
	const canRecord = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" && mimeType !== null;

	useEffect(() => {
		if (state !== "recording") return;
		const timer = window.setInterval(() => {
			const active = handle.current;
			if (active) setElapsed(Date.now() - active.startedAt);
		}, 250);
		return () => window.clearInterval(timer);
	}, [state]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const active = handle.current;
			if (!active) return;
			let saved = false;
			const saveDetached = (): void => {
				if (saved) return;
				saved = true;
				for (const track of active.stream.getTracks()) track.stop();
				const blob = new Blob(active.chunks, { type: active.recorder.mimeType || "video/webm" });
				if (blob.size === 0) return;
				try {
					const url = downloadBlob(blob, recordingFilename(new Date()));
					window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
				} catch {
					// The panel is already unmounted; there is no surface on which to report a download failure.
				}
			};
			active.recorder.onstop = saveDetached;
			active.recorder.onerror = () => {
				if (active.recorder.state !== "inactive") {
					try {
						active.recorder.stop();
					} catch {
						saveDetached();
					}
				}
			};
			if (active.recorder.state !== "inactive") {
				try {
					active.recorder.stop();
				} catch {
					saveDetached();
				}
			}
		};
	}, []);

	useEffect(() => () => {
		if (download) URL.revokeObjectURL(download.url);
	}, [download]);

	const finishDeferredClose = (): void => {
		if (!closeAfterSave.current) return;
		closeAfterSave.current = false;
		allowDeferredClose.current = true;
		setCloseRequested(true);
	};

	const stop = (): void => {
		const active = handle.current;
		if (!active || active.recorder.state === "inactive") return;
		setState("stopping");
		try {
			active.recorder.stop();
		} catch (cause) {
			setState("recording");
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const requestClose = (): boolean => {
		if (allowDeferredClose.current) return true;
		if (stateRef.current === "requesting") {
			closeAfterSave.current = true;
			return false;
		}
		if (stateRef.current === "recording" || stateRef.current === "stopping") {
			closeAfterSave.current = true;
			if (stateRef.current === "recording") stop();
			return false;
		}
		return true;
	};

	const start = async (): Promise<void> => {
		if (!canRecord || !mimeType) return;
		setError(null);
		setCopied(false);
		setElapsed(0);
		closeAfterSave.current = false;
		allowDeferredClose.current = false;
		setCloseRequested(false);
		if (download) setDownload(null);
		setState("requesting");
		let stream: MediaStream | null = null;
		try {
			stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
			if (!mounted.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			if (closeAfterSave.current) {
				for (const track of stream.getTracks()) track.stop();
				setState("idle");
				finishDeferredClose();
				return;
			}
			const recorder = new MediaRecorder(stream, { mimeType });
			const chunks: Blob[] = [];
			const active: RecordingHandle = { recorder, stream, chunks, startedAt: Date.now() };
			handle.current = active;
			recorder.ondataavailable = event => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			recorder.onerror = event => {
				setError(event instanceof ErrorEvent ? event.message : "The browser stopped recording unexpectedly.");
				for (const track of stream?.getTracks() ?? []) track.stop();
				handle.current = null;
				closeAfterSave.current = false;
				setState("idle");
			};
			recorder.onstop = () => {
				const finishedAt = new Date();
				const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
				for (const track of stream?.getTracks() ?? []) track.stop();
				handle.current = null;
				setElapsed(Date.now() - active.startedAt);
				setState("idle");
				if (blob.size === 0) {
					setError("The capture ended before the browser produced a recording file.");
					closeAfterSave.current = false;
					return;
				}
				const filename = recordingFilename(finishedAt);
				try {
					const url = downloadBlob(blob, filename);
					setDownload({ url, filename });
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					closeAfterSave.current = false;
					return;
				}
				finishDeferredClose();
			};
			recorder.start(1000);
			setState("recording");
		} catch (cause) {
			for (const track of stream?.getTracks() ?? []) track.stop();
			handle.current = null;
			if (!mounted.current) return;
			setState("idle");
			setError(cause instanceof Error ? cause.message : String(cause));
			if (closeAfterSave.current) finishDeferredClose();
		}
	};

	const copyBrowserAddress = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(window.location.href);
			setCopied(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not copy the page address.");
		}
	};

	return <Sheet title="Record omp console" windowKind="record" onClose={onClose} closeRequested={closeRequested} onCloseRequest={requestClose}>
		<section className="record-panel">
			<p>Capture the omp console window or browser tab as a WebM video. Choose the omp console window in the browser’s screen-share picker; audio is not recorded. Closing during capture stops and downloads the recording automatically.</p>
			{state === "requesting" ? <p className="dk-hint" role="status">Waiting for screen selection…</p> : null}
			{state === "recording" || state === "stopping" ? <div className="record-live" role="status"><span className="record-dot" aria-hidden="true" />{state === "stopping" ? "Saving recording…" : `Recording ${elapsedLabel(elapsed)}`}<button type="button" className="sh-btn" onClick={stop} disabled={state === "stopping"}>Stop</button></div> : null}
			{state === "idle" ? <button type="button" className="sh-btn sh-btn-primary" onClick={() => void start()} disabled={!canRecord}>Start recording</button> : null}
			{!canRecord ? <div className="record-warning" role="status"><strong>Screen recording is unavailable in this browser.</strong><span>This browser must support display capture and WebM MediaRecorder. Open this omp console address in a current desktop browser to record.</span><button type="button" className="sh-btn" onClick={() => void copyBrowserAddress()}>{copied ? "Address copied" : "Copy omp console address"}</button></div> : null}
			{error ? <p className="record-error" role="alert">{error}</p> : null}
			{download ? <p className="record-download">Saved {download.filename}. <a href={download.url} download={download.filename}>Download again</a></p> : null}
		</section>
	</Sheet>;
}
