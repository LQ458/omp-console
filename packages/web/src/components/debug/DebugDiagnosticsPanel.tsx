import type { DebugDiagnosticAction, DebugDiagnosticSnapshot, SessionOpV3Result } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";

const ACTIONS: Array<{ action: DebugDiagnosticAction; label: string; mutates: boolean }> = [
	{ action: "artifacts", label: "Session artifacts bundle", mutates: true },
	{ action: "performance-start", label: "Start CPU profile", mutates: true },
	{ action: "performance-stop", label: "Stop and download profile", mutates: true },
	{ action: "work", label: "Work-scheduling profile", mutates: true },
	{ action: "dump", label: "Dump session report", mutates: true },
	{ action: "memory", label: "Memory report", mutates: true },
	{ action: "logs", label: "Recent logs", mutates: false },
	{ action: "raw-sse", label: "Raw SSE stream", mutates: false },
	{ action: "system", label: "System info", mutates: false },
	{ action: "terminal", label: "Terminal state · omp console equivalent", mutates: false },
	{ action: "protocols", label: "Terminal protocols · omp console equivalent", mutates: false },
	{ action: "remote-debugger", label: "Start JS remote debugger", mutates: true },
	{ action: "transcript", label: "Export session transcript", mutates: true },
	{ action: "clear-cache", label: "Clear artifact cache", mutates: true },
];

export interface DebugDiagnosticsPanelProps {
	api: Pick<DeckApi, "sessionOpV3">;
	sessionId: string | undefined;
	readOnly: boolean;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : "The diagnostics operation failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserCapabilities(): string {
	if (typeof navigator === "undefined") return "Browser capability details are unavailable.";
	const mediaDevices: unknown = Reflect.get(navigator, "mediaDevices");
	const microphoneAvailable = isRecord(mediaDevices) && typeof mediaDevices.getUserMedia === "function";
	return [
		`User agent: ${navigator.userAgent}`,
		`WebRTC: ${typeof RTCPeerConnection === "undefined" ? "unavailable" : "available"}`,
		`Microphone API: ${microphoneAvailable ? "available" : "unavailable"}`,
		`AudioWorklet: ${typeof AudioWorkletNode === "undefined" ? "unavailable" : "available"}`,
		`WebSocket: ${typeof WebSocket === "undefined" ? "unavailable" : "available"}`,
		`Page visibility: ${typeof document === "undefined" ? "unknown" : document.visibilityState}`,
	].join("\n");
}

function saveDownload(download: NonNullable<DebugDiagnosticSnapshot["download"]>): void {
	if (!download.base64) return;
	const binary = atob(download.base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	const url = URL.createObjectURL(new Blob([bytes], { type: download.mimeType }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = download.filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

export function DebugDiagnosticsPanel({ api, sessionId, readOnly }: DebugDiagnosticsPanelProps): ReactNode {
	const [activeAction, setActiveAction] = useState<DebugDiagnosticAction | null>(null);
	const [snapshot, setSnapshot] = useState<DebugDiagnosticSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [profiling, setProfiling] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const invoke = useCallback(async (action: DebugDiagnosticAction, confirmed?: true): Promise<DebugDiagnosticSnapshot | null> => {
		if (!sessionId) return null;
		setBusy(true);
		setError(null);
		try {
			const result: SessionOpV3Result = await api.sessionOpV3(sessionId, {
				op: "debug-diagnostics",
				action,
				...(confirmed === true ? { confirmed: true } : {}),
			});
			if (!("debugDiagnostic" in result)) throw new Error("The session returned no diagnostics result.");
			setSnapshot(result.debugDiagnostic);
			if (action === "performance-start") setProfiling(true);
			if (action === "performance-stop") setProfiling(false);
			return result.debugDiagnostic;
		} catch (cause) {
			setError(message(cause));
			return null;
		} finally {
			setBusy(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		if (activeAction !== "logs" && activeAction !== "raw-sse") return;
		let current = true;
		let timer: number | undefined;
		let inFlight = false;
		const refresh = async (): Promise<void> => {
			if (!current || inFlight) return;
			inFlight = true;
			await invoke(activeAction);
			inFlight = false;
			if (current) timer = window.setTimeout(() => void refresh(), 1_000);
		};
		void refresh();
		return () => {
			current = false;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [activeAction, invoke]);

	const run = (action: DebugDiagnosticAction): void => {
		setActiveAction(action);
		if (action !== "logs" && action !== "raw-sse") void invoke(action);
	};

	const clearCache = async (confirmed?: true): Promise<void> => {
		setActiveAction("clear-cache");
		await invoke("clear-cache", confirmed);
	};

	const confirmAction = (): void => {
		if (snapshot?.action === "clear-cache") {
			void clearCache(true);
			return;
		}
		if (snapshot?.action === "remote-debugger") void invoke("remote-debugger", true);
	};

	const selected = ACTIONS.find(item => item.action === activeAction);
	const text = snapshot?.text === undefined ? "" : snapshot.text;
	const displayText = activeAction === "terminal" || activeAction === "protocols"
		? `${text}\n\nDeck client capabilities\n${browserCapabilities()}`
		: text;

	return (
		<section className="debug-diagnostics" aria-label="Debug diagnostics">
			<div className="debug-diagnostic-actions" aria-label="Diagnostic actions">
				{ACTIONS.map(item => <button
					type="button"
					className="sh-btn"
					key={item.action}
					onClick={() => item.action === "clear-cache" ? void clearCache() : run(item.action)}
					disabled={busy || !sessionId || (readOnly && item.mutates) || (item.action === "performance-stop" && !profiling)}
				>{item.label}</button>)}
			</div>
			{!sessionId ? <p className="dk-hint" role="status">Open a daemon session to inspect diagnostics.</p> : null}
			{readOnly ? <p className="dk-hint" role="note">Read-only session: profiling, report creation, cache changes and remote debugger startup are disabled.</p> : null}
			{error ? <p className="debug-error" role="alert">{error}</p> : null}
			{selected ? <h3 className="debug-diagnostic-title">{selected.label}{activeAction === "logs" || activeAction === "raw-sse" ? " · live" : ""}</h3> : null}
			{snapshot?.confirmationRequired ? <div className="debug-confirm" role="alert">
				<p>{snapshot.text}</p>
				<button type="button" className="sh-btn" onClick={() => setSnapshot(null)} disabled={busy}>Cancel</button>
				<button type="button" className="sh-btn sh-btn-primary" onClick={confirmAction} disabled={busy || readOnly}>{snapshot.action === "remote-debugger" ? "Start inspector" : "Confirm clear"}</button>
			</div> : null}
			{snapshot?.remoteDebugger ? <div className="debug-remote-url">
				<code>{`ws://${snapshot.remoteDebugger.host}:${snapshot.remoteDebugger.port}`}</code>
				<button type="button" className="sh-btn" disabled title="The runtime does not provide a stop API">Stop unavailable</button>
			</div> : null}
			{displayText ? <pre className="debug-diagnostic-text" aria-live="polite">{displayText}</pre> : null}
			{snapshot?.download ? <div className="debug-diagnostic-download">
				{snapshot.download.base64 ? <button type="button" className="sh-btn sh-btn-primary" onClick={() => saveDownload(snapshot.download!)}>Download {snapshot.download.filename} · {snapshot.download.byteLength.toLocaleString()} bytes</button> : <p className="dk-hint">{snapshot.download.unavailableReason}</p>}
				<small>{snapshot.download.path.startsWith("mock://") ? `Mock-only download location: ${snapshot.download.path}; no daemon file was written.` : `Also written on the daemon: ${snapshot.download.path}`}</small>
			</div> : null}
			{busy ? <p className="dk-hint" role="status">Collecting diagnostics…</p> : null}
		</section>
	);
}
