import type { OvernightEvent, OvernightEventKind, OvernightState, SessionSummary, StartOvernightRequest } from "@omp-console/protocol";
import { Moon, RefreshCw, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { DeckApiError, type DeckApi } from "../../lib/api";
import { overnightPhaseLabel } from "../../lib/overnight";
import { Markdown } from "../transcript/Markdown";
import { Sheet } from "../shell/Sheet";
import { OvernightSetup } from "./OvernightSetup";
import "./overnight.css";

export interface OvernightSheetProps {
	api: Pick<DeckApi, "getOvernightState" | "startOvernight" | "stopOvernight" | "getOvernightTemplate" | "getOvernightPreflight">;
	sessionId: string | null;
	summary?: SessionSummary;
	initialTask?: string;
	initialCwd?: string | null;
	onClose(): void;
	onRefresh(): void;
}

const EVENT_LABEL: Record<OvernightEventKind, string> = {
	start: "Run started",
	continue: "Continued work",
	"auto-answer": "Question answered automatically",
	error: "Run error",
	"retry-wait": "Waiting to retry",
	"usage-wait": "Waiting for usage reset",
	"stall-abort": "Stalled turn stopped",
	"worker-restart": "Worker restarted",
	"daemon-resume": "Run resumed after daemon restart",
	"wrap-up": "Writing morning report",
	complete: "Run complete",
	deadline: "Deadline reached",
	blocked: "Run blocked",
	stopped: "Overnight run stopped",
};

function errorText(error: unknown): string {
	if (error instanceof DeckApiError && error.kind === "conflict") {
		return `Finish or stop the current turn first. ${error.message}`;
	}
	return error instanceof Error ? error.message : "The Overnight run request failed.";
}

function dateTime(value: number | string): string {
	const date = typeof value === "number" ? new Date(value) : new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function eventDetail(event: OvernightEvent): string {
	if (event.kind === "auto-answer") return event.detail.replace(/\s*(?:→|->)\s*/, " → ");
	return event.detail;
}

function EventRow({ event }: { event: OvernightEvent }): ReactNode {
	return (
		<li className={`dk-overnight-event dk-overnight-event-${event.kind}`}>
			<time dateTime={new Date(event.at).toISOString()}>{dateTime(event.at)}</time>
			<div><strong>{EVENT_LABEL[event.kind]}</strong><p>{eventDetail(event)}</p></div>
		</li>
	);
}

export function OvernightSheet({ api, sessionId, summary, initialTask = "", initialCwd, onClose, onRefresh }: OvernightSheetProps): ReactNode {
	const [state, setState] = useState<OvernightState | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
		if (sessionId === null) {
			setState(null);
			setLoading(false);
			return;
		}
		try {
			const next = await api.getOvernightState(sessionId, signal);
			setState(next);
			setLoadError(null);
		} catch (error) {
			if (signal?.aborted) return;
			if (error instanceof DeckApiError && error.kind === "not-found") {
				setState(null);
				setLoadError(null);
			} else setLoadError(errorText(error));
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		void refresh(controller.signal);
		const timer = window.setInterval(() => void refresh(), 4_000);
		return () => {
			controller.abort();
			window.clearInterval(timer);
		};
	}, [refresh]);

	const start = async (request: StartOvernightRequest): Promise<void> => {
		if (sessionId === null || busy) return;
		setBusy(true);
		setActionError(null);
		try {
			setState(await api.startOvernight(sessionId, request));
			onRefresh();
		} catch (error) {
			setActionError(errorText(error));
			throw error;
		} finally {
			setBusy(false);
		}
	};

	const stop = async (): Promise<void> => {
		if (sessionId === null || busy) return;
		if (!window.confirm("Stop the Overnight run? The session will keep running normally.")) return;
		setBusy(true);
		setActionError(null);
		try {
			setState(await api.stopOvernight(sessionId));
			onRefresh();
		} catch (error) {
			setActionError(errorText(error));
		} finally {
			setBusy(false);
		}
	};

	const terminal = state !== null && ["complete", "deadline", "blocked", "stopped"].includes(state.phase);
	const cwd = initialCwd ?? summary?.cwd ?? null;
	return (
		<Sheet title="Overnight run" size="tall" onClose={onClose}>
			{sessionId === null ? (
				<p className="dk-overnight-error" role="alert">Open an omp-console session before starting an Overnight run.</p>
			) : loading && state === null ? (
				<p className="dk-overnight-note" role="status">Loading Overnight run status…</p>
			) : state !== null ? (
				<section className="dk-overnight-status" aria-label="Overnight run status">
					<div className="dk-overnight-status-head">
						<Moon size={18} aria-hidden="true" />
						<div><strong>{overnightPhaseLabel(state.phase, state)}</strong><span>Deadline {dateTime(state.policy.deadline)}</span></div>
						<button type="button" className="sh-btn sh-btn-icon" title="Refresh Overnight run status" aria-label="Refresh Overnight run status" onClick={() => void refresh()}>
							<RefreshCw size={14} />
						</button>
					</div>
					<div className="dk-overnight-counts"><span>{state.continuations} continuations</span><span>{state.idleContinuations} consecutive idle</span></div>
					{loadError && <p className="dk-overnight-error" role="alert">Status refresh failed: {loadError}</p>}
					{actionError && <p className="dk-overnight-error" role="alert">{actionError}</p>}
					{state.events.length > 0 && (
						<section className="dk-overnight-timeline" aria-label="Overnight run activity">
							<h3>Activity</h3>
							<ol>{[...state.events].reverse().map((event, index) => <EventRow key={`${event.at}:${event.kind}:${index}`} event={event} />)}</ol>
						</section>
					)}
					{state.report && (
						<section className="dk-overnight-report" aria-label="Morning report">
							<h3>Morning report</h3>
							<Markdown text={state.report} />
						</section>
					)}
					{!terminal && (
						<button type="button" className="sh-btn sh-btn-stop dk-overnight-stop" disabled={busy} onClick={() => void stop()}>
							<Square size={13} aria-hidden="true" />
							{busy ? "Stopping…" : "Stop Overnight run"}
						</button>
					)}
				</section>
			) : (
				<>
					{loadError && <p className="dk-overnight-error" role="alert">Could not load Overnight run status: {loadError}</p>}
					<OvernightSetup api={api} cwd={cwd} initialTask={initialTask} busy={busy} startLabel="Start Overnight run" onStart={start} />
				</>
			)}
		</Sheet>
	);
}
