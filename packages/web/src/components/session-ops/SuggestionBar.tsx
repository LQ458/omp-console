import type { SessionSummary } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { recordUsage } from "../../lib/journal";
import { sessionSuggestions, type SessionSuggestion } from "../../lib/suggestions";
import "./session-ops.css";

/** How long a suggestion stays up when nobody touches it. */
export const SUGGESTION_VISIBLE_MS = 8_000;

export interface SuggestionBarProps {
	sessionId: string | null;
	summary?: SessionSummary;
	entries: readonly SessionEntry[];
	contextPercent: number | null;
	subagentCount: number;
	working: boolean;
	readOnly: boolean;
	onSetPlanMode(enabled: boolean, via: "direct" | "suggestion"): Promise<void>;
	onOpenGraph(): void;
	onOpenStatus(): void;
	onStopSession(sessionId: string): Promise<void> | void;
}

export function SuggestionBar({ sessionId, summary, entries, contextPercent, subagentCount, working, readOnly, onSetPlanMode, onOpenGraph, onOpenStatus, onStopSession }: SuggestionBarProps): ReactNode {
	const [dismissed, setDismissed] = useState<string[]>(() => loadDismissed(sessionId));
	// Shown once and gone: a suggestion that timed out stays hidden for this session view (not stored, unlike Dismiss).
	const [expired, setExpired] = useState<string[]>([]);
	const [paused, setPaused] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const shown = useRef(new Set<string>());
	const candidates = useMemo(() => sessionSuggestions({ sessionId, summary, entries, contextPercent, subagentCount, working, now }), [sessionId, summary, entries, contextPercent, subagentCount, working, now]);
	const suggestion = readOnly ? undefined : candidates.find(candidate => !dismissed.includes(candidate.id) && !expired.includes(candidate.id));
	const suggestionId = suggestion?.id;
	useEffect(() => {
		// Hover, focus, a running action or an error keep it up; otherwise it leaves after a few seconds.
		if (suggestionId === undefined || paused || busy || error !== null) return;
		const timer = window.setTimeout(() => setExpired(previous => [...previous, suggestionId]), SUGGESTION_VISIBLE_MS);
		return () => window.clearTimeout(timer);
	}, [suggestionId, paused, busy, error]);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);

	useEffect(() => {
		setDismissed(loadDismissed(sessionId));
		setExpired([]);
		setError(null);
	}, [sessionId]);

	useEffect(() => {
		if (!sessionId || !suggestion) return;
		const key = `${sessionId}:${suggestion.id}`;
		if (shown.current.has(key)) return;
		shown.current.add(key);
		recordUsage({ feature: "0.3.suggestions", action: `shown:${suggestion.id}`, outcome: "ok", via: "suggestion", screen: "session", sessionId });
	}, [sessionId, suggestion]);

	const remember = (id: string): void => {
		if (dismissed.includes(id)) return;
		const next = [...dismissed, id];
		storeDismissed(sessionId, next);
		setDismissed(next);
	};

	const dismiss = (): void => {
		if (!sessionId || !suggestion) return;
		recordUsage({ feature: "0.3.suggestions", action: `dismissed:${suggestion.id}`, outcome: "ok", via: "suggestion", screen: "session", sessionId });
		remember(suggestion.id);
	};

	const act = async (): Promise<void> => {
		if (!sessionId || !suggestion || busy) return;
		setBusy(true);
		setError(null);
		try {
			await applySuggestion(suggestion, sessionId, { onSetPlanMode, onOpenGraph, onOpenStatus, onStopSession });
			recordUsage({ feature: "0.3.suggestions", action: `acted:${suggestion.id}`, outcome: "ok", via: "suggestion", screen: "session", sessionId });
			remember(suggestion.id);
		} catch (cause) {
			recordUsage({ feature: "0.3.suggestions", action: `acted:${suggestion.id}`, outcome: "error", via: "suggestion", screen: "session", sessionId });
			setError(cause instanceof Error ? cause.message : "The suggestion action failed.");
		} finally {
			setBusy(false);
		}
	};

	if (!suggestion || !sessionId) return null;
	return (
		// A zero-height host: the card floats over the transcript instead of pushing it down.
		<div className="so-suggestion-host">
			<aside
				className="so-suggestion"
				aria-label="session suggestion"
				role="status"
				onPointerEnter={() => setPaused(true)}
				onPointerLeave={() => setPaused(false)}
				onFocus={() => setPaused(true)}
				onBlur={event => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
				}}
			>
				<div className="so-suggestion-copy">
					<strong>{suggestion.title}</strong>
					<p>{suggestion.description}</p>
					{suggestion.ompEquivalent ? (
						<div className="so-suggestion-equivalent"><span>omp:</span><code>{suggestion.ompEquivalent}</code></div>
					) : <div className="so-suggestion-equivalent">omp console action · no direct omp command</div>}
					{error && <p className="so-error" role="alert">{error}</p>}
				</div>
				<div className="so-suggestion-actions">
					<button type="button" className="dk-wide-btn so-primary" disabled={busy} title={`${suggestion.title}: ${suggestion.actionLabel}`} onClick={() => void act()}>{busy ? "Working…" : suggestion.actionLabel}</button>
					<button type="button" className="dk-tap" disabled={busy} aria-label={`dismiss ${suggestion.title}`} title="dismiss" onClick={dismiss}><X size={15} /></button>
				</div>
			</aside>
		</div>
	);
}

async function applySuggestion(
	suggestion: SessionSuggestion,
	sessionId: string,
	actions: Pick<SuggestionBarProps, "onSetPlanMode" | "onOpenGraph" | "onOpenStatus" | "onStopSession">,
): Promise<void> {
	switch (suggestion.id) {
		case "context-high":
		case "repeated-prompts":
			actions.onOpenStatus();
			return;
		case "agent-graph":
			actions.onOpenGraph();
			return;
		case "plan-for-long-turn":
			await actions.onSetPlanMode(true, "suggestion");
			return;
		case "idle-live-session":
			await actions.onStopSession(sessionId);
	}
}

function loadDismissed(sessionId: string | null): string[] {
	if (!sessionId || typeof window === "undefined") return [];
	try {
		const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(sessionId)) ?? "[]");
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function storeDismissed(sessionId: string | null, ids: readonly string[]): void {
	if (!sessionId || typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey(sessionId), JSON.stringify(ids));
	} catch {
		// Keep the in-memory dismissal when storage is unavailable.
	}
}

function storageKey(sessionId: string): string {
	return `omp-console:suggestions:${sessionId}`;
}
