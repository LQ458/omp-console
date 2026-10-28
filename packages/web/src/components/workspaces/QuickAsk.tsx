import type { QuickAskRequest, QuickAskResponse, RoomLinkResponse } from "@omp-console/protocol";
import { ExternalLink, Search, Send, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { GuestClient } from "../../lib/client";
import { recordUsage } from "../../lib/journal";
import { browserStorage } from "../../lib/storage";
import { useGuestSnapshot } from "../../lib/use-guest";
import { Transcript } from "../transcript/Transcript";
import { OmpEquivalent } from "../catalog/OmpEquivalent";
import { OPEN_QUICK_ASK_EVENT } from "./events";
import { useWorkspaces } from "./WorkspaceProvider";
import {
	answerRoomLink,
	isQuickAskShortcut,
	loadSources,
	type QuickSource,
	questionBlocker,
	SOURCE_OPTIONS,
	saveSources,
	toggleSource,
} from "./quick-ask";

export interface QuickAskApi {
	quickAsk(request: QuickAskRequest): Promise<QuickAskResponse>;
	roomLink(sessionId: string): Promise<RoomLinkResponse>;
}

export interface QuickAskHostProps {
	api: Pick<DeckApi, "quickAsk" | "roomLink">;
	/** Daemon-configured sources; only these are offered to the user. */
	allowedSources: readonly QuickSource[];
	/** Guest display name for the answer view. */
	displayName: string;
	/** "Open in main view": select that session in the app. */
	onOpenSession(sessionId: string): void;
}

/**
 * Cmd+J anywhere: a slim question panel; the answer streams into a side sheet that is a second collab guest of the
 * knowledge session (the main view keeps its own session).
 */
export function QuickAskHost({ api, displayName, onOpenSession, allowedSources }: QuickAskHostProps): ReactNode {
	const [open, setOpen] = useState(false);
	const [answerId, setAnswerId] = useState<string | null>(null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (!isQuickAskShortcut(event)) return;
			event.preventDefault();
			setOpen(current => !current);
		};
		const onOpenEvent = (): void => setOpen(true);
		window.addEventListener("keydown", onKey);
		window.addEventListener(OPEN_QUICK_ASK_EVENT, onOpenEvent);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener(OPEN_QUICK_ASK_EVENT, onOpenEvent);
		};
	}, []);

	const close = useCallback(() => setOpen(false), []);
	const sent = useCallback((sessionId: string) => {
		setOpen(false);
		setAnswerId(sessionId);
	}, []);

	return (
		<>
			{open && <QuickAskPanel api={api} allowedSources={allowedSources} onClose={close} onSent={sent} />}
			{answerId !== null && (
				<AnswerSheet
					key={answerId}
					api={api}
					sessionId={answerId}
					displayName={displayName}
					onClose={() => setAnswerId(null)}
					onAskAgain={() => setOpen(true)}
					onOpenInMain={() => {
						onOpenSession(answerId);
						setAnswerId(null);
					}}
				/>
			)}
		</>
	);
}

interface QuickAskPanelProps {
	api: Pick<QuickAskApi, "quickAsk">;
	allowedSources: readonly QuickSource[];
	onClose(): void;
	onSent(sessionId: string): void;
}

export function QuickAskPanel({ api, allowedSources, onClose, onSent }: QuickAskPanelProps): ReactNode {
	const [question, setQuestion] = useState("");
	const [sources, setSources] = useState<QuickSource[]>(() => loadSources(browserStorage(), allowedSources));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const blocker = questionBlocker(question, sources);
	// The equivalent omp command runs where deck runs quick-ask: the knowledge workspace's root.
	const knowledgeRoot = useWorkspaces().workspaces.find(workspace => workspace.kind === "knowledge")?.root;

	useEffect(() => {
		inputRef.current?.focus();
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const toggle = (id: QuickSource): void => {
		const next = toggleSource(sources, id);
		setSources(next);
		saveSources(browserStorage(), next);
	};

	const send = async (): Promise<void> => {
		if (blocker !== null || busy) return;
		setBusy(true);
		setError(null);
		try {
			const response = await api.quickAsk({ question: question.trim(), sources });
			recordUsage({ feature: "6.quick-ask", action: "send", outcome: "ok", via: "direct", detail: sources.join("+") });
			onSent(response.sessionId);
		} catch (err) {
			recordUsage({ feature: "6.quick-ask", action: "send", outcome: "error", via: "direct", detail: sources.join("+") });
			setError(err instanceof Error ? err.message : "could not send the question");
			setBusy(false);
		}
	};

	return (
		<div className="ws-quick-root">
			<div className="ws-quick-backdrop" onClick={onClose} />
			<form
				className="ws-quick"
				role="dialog"
				aria-label="ask your notes"
				onSubmit={event => {
					event.preventDefault();
					void send();
				}}
			>
				<div className="ws-quick-head">
					<Search size={14} />
					<span>Ask your notes</span>
					<kbd className="ws-kbd">⌘J</kbd>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close Ask your notes">
						<X size={14} />
					</button>
				</div>
				<textarea
					ref={inputRef}
					className="ws-quick-input"
					value={question}
					onChange={event => setQuestion(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							void send();
						}
					}}
					placeholder="What did I decide about …?"
					rows={3}
					aria-label="question"
					disabled={busy}
				/>
				<fieldset className="ws-sources" disabled={busy}>
					<legend className="ws-sources-legend">Sources</legend>
					{SOURCE_OPTIONS.filter(option => allowedSources.includes(option.id)).map(option => (
						<label key={option.id} className="ws-source" title={option.hint}>
							<input type="checkbox" checked={sources.includes(option.id)} onChange={() => toggle(option.id)} />
							<span>{option.label}</span>
						</label>
					))}
				</fieldset>
				{error && (
					<div className="dk-notice dk-notice-err ws-notice" role="alert">
						<span>{error}</span>
					</div>
				)}
				<div className="ws-row-actions">
					<button type="submit" className="sh-btn sh-btn-primary" disabled={blocker !== null || busy} title={blocker ?? "send (⌘↵)"}>
						<Send size={13} /> {busy ? "Asking…" : "Ask"}
					</button>
					{blocker !== null && question !== "" && <span className="ws-muted">{blocker}</span>}
				</div>
				<OmpEquivalent text={`omp --cwd ${knowledgeRoot ?? "<Notes folder>"}`} actionId="workspace.quick-ask" />
			</form>
		</div>
	);
}

interface AnswerSheetProps {
	api: Pick<QuickAskApi, "roomLink">;
	sessionId: string;
	displayName: string;
	onClose(): void;
	onAskAgain(): void;
	onOpenInMain(): void;
}

type Connection = { phase: "connecting" } | { phase: "ready"; client: GuestClient } | { phase: "failed"; message: string };

export function AnswerSheet({ api, sessionId, displayName, onClose, onAskAgain, onOpenInMain }: AnswerSheetProps): ReactNode {
	const [connection, setConnection] = useState<Connection>({ phase: "connecting" });

	useEffect(() => {
		let cancelled = false;
		let created: GuestClient | null = null;
		setConnection({ phase: "connecting" });
		answerRoomLink(api, sessionId)
			.then(room => {
				if (cancelled) return;
				created = new GuestClient(room.link, displayName);
				created.connect();
				setConnection({ phase: "ready", client: created });
			})
			.catch((err: unknown) => {
				if (!cancelled) setConnection({ phase: "failed", message: err instanceof Error ? err.message : "could not open the answer" });
			});
		return () => {
			cancelled = true;
			created?.close();
		};
	}, [api, sessionId, displayName]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<aside className="ws-answer" role="complementary" aria-label="knowledge answer">
			<header className="ws-answer-head">
				<span className="ws-answer-title">Answer</span>
				<button type="button" className="sh-btn" onClick={onAskAgain}>
					Ask again
				</button>
				<button type="button" className="sh-btn" onClick={onOpenInMain} title="open this session in the main view">
					<ExternalLink size={13} /> Open
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close answer">
					<X size={14} />
				</button>
			</header>
			<div className="ws-answer-body">
				{connection.phase === "connecting" && <div className="ws-empty" role="status">Starting the knowledge session…</div>}
				{connection.phase === "failed" && (
					<div className="dk-notice dk-notice-err ws-notice" role="alert">
						<span>{connection.message}</span>
					</div>
				)}
				{connection.phase === "ready" && <AnswerView client={connection.client} />}
			</div>
		</aside>
	);
}

function AnswerView({ client }: { client: GuestClient }): ReactNode {
	const snap = useGuestSnapshot(client);
	const hasContent = useMemo(() => snap.entries.length > 0 || snap.stream !== null, [snap.entries, snap.stream]);
	return (
		<div className="ws-answer-transcript">
			{!hasContent && <div className="ws-empty" role="status">{snap.phase === "live" ? "Waiting for the answer…" : "Connecting…"}</div>}
			<Transcript
				entries={snap.entries}
				stream={snap.stream}
				streamDone={snap.streamDone}
				activeTools={snap.activeTools}
				working={snap.working}
				phase={snap.phase}
				compact
			/>
		</div>
	);
}
