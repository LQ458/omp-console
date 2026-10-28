import type { DriftSuggestion, WorkspaceKind } from "@omp-console/protocol";
import { FolderGit2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { fmtBytes, shortenPath } from "../../lib/format";
import { recordUsage } from "../../lib/journal";
import { MoveFlow, slugify, undoMove, validateSlug } from "../../lib/move";
import { DriftPoller, shouldPollDrift } from "./drift-poller";
import { MovePanel } from "./MovePanel";
import "./safety.css";

export type DriftApi = Pick<DeckApi, "drift" | "dismissDrift" | "prepareMove" | "confirmMove" | "undoMove">;

interface Entry {
	suggestion: DriftSuggestion;
	flow: MoveFlow;
}

export interface DriftCardProps {
	api: DriftApi;
	sessionId: string;
	/** Kind of the session's workspace; anything but `knowledge` renders nothing and polls nothing. */
	kind: WorkspaceKind | undefined;
	onOpenSession(sessionId: string): void;
}

/**
 * Drift card for a knowledge-workspace session: "this looks like a new project". Facts come from the daemon; the agent's
 * own explanation is shown under an "agent says" label. The move itself is `lib/move.ts`.
 */
export function DriftCard({ api, sessionId, kind, onOpenSession }: DriftCardProps): ReactNode {
	const entryRef = useRef<Entry | null>(null);
	const [entry, setEntryState] = useState<Entry | null>(null);
	const [dismissError, setDismissError] = useState<string | null>(null);
	const polling = shouldPollDrift(kind);

	const setEntry = useCallback((next: Entry | null): void => {
		entryRef.current = next;
		setEntryState(next);
	}, []);

	useEffect(() => {
		if (!polling) return;
		const poller = new DriftPoller({
			api,
			sessionId,
			isVisible: () => document.visibilityState !== "hidden",
			onResult: suggestion => {
				const current = entryRef.current;
				if (suggestion === null) {
					// Keep an in-progress or finished move on screen even after the daemon stops suggesting it.
					if (current !== null && current.flow.getState().phase === "idle") setEntry(null);
					return;
				}
				if (current !== null && (current.suggestion.id === suggestion.id || current.flow.getState().phase !== "idle")) return;
				recordUsage({ feature: "9.drift", action: "shown", outcome: "ok", via: "direct", sessionId });
				setEntry({ suggestion, flow: new MoveFlow({ api }) });
			},
		});
		poller.start();
		return () => poller.stop();
	}, [api, sessionId, polling, setEntry]);

	// A session switch must not carry the previous session's card over.
	useEffect(() => {
		setEntry(null);
	}, [sessionId, setEntry]);

	if (entry === null || !polling) return null;
	const dismiss = async (): Promise<void> => {
		setDismissError(null);
		try {
			await api.dismissDrift(sessionId, entry.suggestion.id);
			recordUsage({ feature: "9.drift", action: "dismiss", outcome: "ok", via: "direct", sessionId });
			setEntry(null);
		} catch (err) {
			setDismissError(err instanceof Error ? err.message : "could not dismiss");
		}
	};
	return (
		<DriftBody
			key={entry.suggestion.id}
			api={api}
			entry={entry}
			sessionId={sessionId}
			onDismiss={() => void dismiss()}
			dismissError={dismissError}
			onOpenSession={onOpenSession}
			onClear={() => setEntry(null)}
		/>
	);
}

interface DriftBodyProps {
	api: DriftApi;
	entry: Entry;
	sessionId: string;
	dismissError: string | null;
	onDismiss(): void;
	onOpenSession(sessionId: string): void;
	onClear(): void;
}

function DriftBody({ api, entry, sessionId, dismissError, onDismiss, onOpenSession, onClear }: DriftBodyProps): ReactNode {
	const { suggestion, flow } = entry;
	const [slug, setSlug] = useState(() => slugify(suggestion.suggestedSlug));
	const [undoNote, setUndoNote] = useState<string | null>(null);
	const [phase, setPhase] = useState(flow.getState().phase);
	useEffect(() => flow.subscribe(() => setPhase(flow.getState().phase)), [flow]);

	const check = validateSlug(slug);
	const prepare = (): void => {
		recordUsage({ feature: "9.move", action: "prepare", outcome: "ok", via: "direct", sessionId });
		void flow.prepare(suggestion, slug);
	};
	const undo = async (moveId: string): Promise<void> => {
		const outcome = await undoMove(api, moveId);
		recordUsage({ feature: "9.move", action: "undo", outcome: outcome.ok ? "ok" : "error", via: "direct", sessionId });
		if (outcome.ok) {
			flow.cancel();
			onClear();
		} else {
			setUndoNote(outcome.message);
		}
	};

	return (
		<section className="sf-drift" aria-label="project drift">
			<header className="sf-drift-head">
				<FolderGit2 size={15} />
				<strong>This looks like a new project</strong>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onDismiss} aria-label="dismiss suggestion" title="Dismiss (mutes this folder)">
					<X size={14} />
				</button>
			</header>
			<dl className="sf-facts">
				<div>
					<dt>Folder</dt>
					<dd>
						<code title={suggestion.sourceRoot}>{shortenPath(suggestion.sourceRoot)}</code>
					</dd>
				</div>
				<div>
					<dt>Markers</dt>
					<dd>
						{suggestion.markers.map(marker => (
							<code key={marker} className="sf-marker">
								{marker}
							</code>
						))}
					</dd>
				</div>
				<div>
					<dt>Files</dt>
					<dd>
						{suggestion.files} · {fmtBytes(suggestion.bytes)}
					</dd>
				</div>
			</dl>
			{suggestion.agentReason && (
				<blockquote className="sf-agent-says">
					<span className="sf-agent-label">agent says</span>
					{suggestion.agentReason}
				</blockquote>
			)}
			{dismissError && (
				<div className="dk-notice dk-notice-err ws-notice" role="alert">
					<span>{dismissError}</span>
				</div>
			)}
			{phase === "idle" && (
				<div className="sf-slug">
					<label className="sh-field">
						<span className="sh-field-label">Folder name in the configured projects root</span>
						<input
							className="sh-input sh-input-mono"
							value={slug}
							onChange={event => setSlug(event.target.value)}
							spellCheck={false}
							autoComplete="off"
							aria-invalid={!check.ok}
						/>
						{!check.ok && <span className="sf-slug-error">{check.message}</span>}
					</label>
					<button type="button" className="sh-btn sh-btn-primary" disabled={!check.ok} onClick={prepare}>
						Preview move
					</button>
				</div>
			)}
			<MovePanel flow={flow} onPrepareAgain={prepare} onOpenSession={onOpenSession} onUndo={id => void undo(id)} undoNote={undoNote} />
		</section>
	);
}
