import type { AgentSnapshot, SessionEntry, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { OctagonX, RotateCcw, SendHorizontal, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { AgentGraphStatus } from "../../lib/agent-graph";
import type { DeckApi } from "../../lib/api";
import type { GuestClient } from "../../lib/client";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { decideTranscriptPoll } from "../../lib/transcript-poll";
import type { TranscriptProps } from "../transcript/Transcript";
import { Transcript } from "../transcript/Transcript";
import { ChangeModel } from "./ChangeModel";
import "./agents.css";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const POLL_MS = 1200;
/** Consecutive unchanged polls of a non-running agent before the loop stops. */
const IDLE_POLLS_BEFORE_STOP = 4;
/** After a steer message: poll this often, for this long, whatever the idle state. */
const STEER_POLL_MS = 200;
const STEER_BURST_MS = 4000;

export const AgentDrawer = memo(function AgentDrawer(props: {
	agent: AgentSnapshot;
	progress?: SubagentProgressPayload;
	lifecycle?: SubagentLifecyclePayload;
	client: GuestClient;
	/** View-link guests: hide kill/revive/chat (the host rejects them anyway). */
	readOnly?: boolean;
	/** Forwarded to tool renderers so nested task cards can drill further. */
	host?: TranscriptProps["host"];
	/** Graph status of this agent (finished/failed outcome); the drawer falls back to the registry status. */
	status?: AgentGraphStatus;
	/** Running with no activity for 120 s. */
	stalled?: boolean;
	/** Daemon session id; enables "Change model" (absent for a manually joined link). */
	sessionId?: string;
	api: DeckApi;
	onClose(): void;
}): ReactNode {
	const { agent, progress, lifecycle, client, readOnly, host, status, stalled, sessionId, api, onClose } = props;
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	/** Resumes a stopped poll loop; null while no loop is mounted. */
	const resumePollingRef = useRef<(() => void) | null>(null);
	/** Switches the poll loop to the fast steer cadence; null while no loop is mounted. */
	const steerBurstRef = useRef<(() => void) | null>(null);
	const quiescentRef = useRef(false);
	quiescentRef.current = agent.status !== "running";

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Live transcript: poll the host-side session file while the drawer is
	// open, appending parsed JSONL entries. State resets when the agent
	// changes; the interval and any in-flight reply are dropped on cleanup.
	// Once the agent is not running, no partial JSONL line is pending, and
	// IDLE_POLLS_BEFORE_STOP consecutive polls find the file unchanged, the
	// loop stops; host activity for the agent resumes it (effect below).
	// A frame-level host error is terminal: stop polling and show it (the
	// host replies with an unchanged cursor, so retrying would loop hot).
	useEffect(() => {
		setEntries([]);
		setFetchError(null);
		if (!agent.hasSessionFile) return;
		let disposed = false;
		let failed = false;
		let inFlight = false;
		let cursor = 0;
		let carry = "";
		let acc: readonly SessionEntry[] = [];
		let idlePolls = 0;
		let bursting = false;
		let timer: Timer | null = null;
		const stopPolling = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const poll = async (): Promise<void> => {
			if (disposed || failed || inFlight) return;
			inFlight = true;
			try {
				const reply = await client.fetchTranscript(agent.id, cursor);
				if (disposed) return;
				const decision = decideTranscriptPoll(reply, carry);
				switch (decision.action) {
					case "retry":
						return; // timeout/transient → keep polling from the same cursor
					case "stop":
						failed = true;
						stopPolling();
						setFetchError(decision.message);
						return;
					case "advance": {
						const grew = decision.newSize !== cursor;
						cursor = decision.newSize;
						carry = decision.carry;
						if (decision.fresh.length > 0) {
							acc = [...acc, ...decision.fresh];
							setEntries(acc);
						}
						idlePolls = grew || !quiescentRef.current ? 0 : idlePolls + 1;
						if (carry === "" && idlePolls >= IDLE_POLLS_BEFORE_STOP && !bursting) stopPolling();
						return;
					}
				}
			} finally {
				inFlight = false;
			}
		};
		const startPolling = (intervalMs: number = POLL_MS) => {
			idlePolls = 0;
			stopPolling();
			void poll();
			timer = setInterval(() => {
				void poll();
			}, intervalMs);
		};
		resumePollingRef.current = () => {
			if (!disposed && !failed && timer === null) startPolling();
		};
		// A steer message lands in the transcript when the agent takes it up, so poll fast for a few seconds
		// instead of waiting out the idle interval (rubric #10: p95 <= 500 ms from send to transcript).
		let burstEnd: Timer | null = null;
		steerBurstRef.current = () => {
			if (disposed || failed) return;
			bursting = true;
			startPolling(STEER_POLL_MS);
			if (burstEnd !== null) clearTimeout(burstEnd);
			burstEnd = setTimeout(() => {
				burstEnd = null;
				bursting = false;
				if (!disposed && !failed && timer !== null) startPolling();
			}, STEER_BURST_MS);
		};
		startPolling();
		return () => {
			disposed = true;
			resumePollingRef.current = null;
			steerBurstRef.current = null;
			if (burstEnd !== null) clearTimeout(burstEnd);
			stopPolling();
		};
	}, [agent.id, agent.hasSessionFile, client]);

	// Progress/lifecycle bus frames and status/activity changes for this agent
	// restart a stopped loop; a running loop ignores them.
	useEffect(() => {
		resumePollingRef.current?.();
	}, [progress, lifecycle, agent.status, agent.lastActivity]);

	const sendChat = () => {
		const text = draft.trim();
		if (!text) return;
		client.sendAgentCmd("chat", agent.id, text);
		steerBurstRef.current?.();
		setDraft("");
	};

	const p = progress?.progress;
	const model = p?.resolvedModel;
	const ctxPct =
		p?.contextTokens !== undefined && p.contextWindow
			? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
			: null;
	const shownStatus = stalled ? "stalled" : (status ?? agent.status);
	const canChangeModel =
		sessionId !== undefined && !readOnly && (agent.kind === "main" || agent.status === "running");

	return (
		<aside className="ag-drawer" role="dialog" aria-label={agent.displayName}>
			<header className="ag-drawer-head">
				<div className="ag-drawer-title">
					<span className="ag-drawer-name">{agent.displayName}</span>
					<span className={`ag-chip ag-chip--${shownStatus}`}>
						{stalled ? <TriangleAlert size={10} aria-hidden /> : null}
						{shownStatus}
					</span>
					{model ? <span className="ag-chip ag-chip--model">{model}</span> : null}
				</div>
				<div className="ag-drawer-actions">
					{agent.status === "running" && !readOnly ? (
						<button
							type="button"
							className="ag-btn ag-btn--danger"
							onClick={() => client.sendAgentCmd("kill", agent.id)}
						>
							<OctagonX size={13} aria-hidden />
							kill
						</button>
					) : null}
					{(agent.status === "parked" || agent.status === "aborted") && !readOnly ? (
						<button type="button" className="ag-btn" onClick={() => client.sendAgentCmd("revive", agent.id)}>
							<RotateCcw size={13} aria-hidden />
							revive
						</button>
					) : null}
					<button type="button" className="ag-iconbtn" aria-label="close" onClick={onClose}>
						<X size={15} aria-hidden />
					</button>
				</div>
			</header>
			{p ? (
				<div className="ag-stats">
					<span className="ag-stat">
						<span className="ag-stat-label">tok</span>
						<span className="ag-stat-value">{fmtTokens(p.tokens)}</span>
					</span>
					{ctxPct !== null ? (
						<span className="ag-stat" title={`context ${fmtTokens(p.contextTokens ?? 0)}`}>
							<span className="ag-stat-label">ctx</span>
							<span className="ag-gauge">
								<span
									className={ctxPct > 80 ? "ag-gauge-fill ag-gauge-fill--warn" : "ag-gauge-fill"}
									style={{ width: `${ctxPct}%` }}
								/>
							</span>
						</span>
					) : null}
					<span className="ag-stat">
						<span className="ag-stat-label">cost</span>
						<span className="ag-stat-value">{fmtCost(p.cost)}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-label">tools</span>
						<span className="ag-stat-value">{p.toolCount}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-value">{fmtDuration(p.durationMs)}</span>
					</span>
				</div>
			) : null}
			{canChangeModel && sessionId !== undefined ? (
				<ChangeModel
					sessionId={sessionId}
					agentId={agent.id}
					agentName={agent.displayName}
					currentModel={model}
					api={api}
				/>
			) : null}
			<div className="ag-drawer-body">
				{agent.hasSessionFile ? (
					<>
						<Transcript
							compact
							entries={entries}
							stream={null}
							streamDone={false}
							activeTools={EMPTY_TOOLS}
							working={agent.status === "running" && fetchError === null}
							host={host}
						/>
						{fetchError !== null ? (
							<div className="ag-fetch-error" role="alert">
								transcript unavailable: {fetchError}
							</div>
						) : null}
					</>
				) : (
					<div className="ag-empty">no transcript available</div>
				)}
			</div>
			{!readOnly && (
				<form
					className="ag-chat"
					onSubmit={e => {
						e.preventDefault();
						sendChat();
					}}
				>
					<input
						className="ag-chat-input"
						value={draft}
						placeholder={`message ${agent.displayName}…`}
						onChange={e => setDraft(e.target.value)}
					/>
					<button type="submit" className="ag-iconbtn" aria-label="send" disabled={draft.trim().length === 0}>
						<SendHorizontal size={15} aria-hidden />
					</button>
				</form>
			)}
		</aside>
	);
});
