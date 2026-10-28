/**
 * Status stream of the worker: `ready`, `state`, `notify`, `fatal` and `pong` lines for the daemon.
 *
 * `state` is derived, not tracked: every trigger (run state, registry change, dialog open/close, session
 * event) schedules one recomputation; it is emitted only when something other than `lastEventAt` changed,
 * so a burst of tool events costs one line. While a turn streams, a heartbeat re-emits it so the daemon sees
 * `lastEventAt` advance on long silent tool runs.
 */
import type { CleanseStateSummary, LiveModeStatus, LoopModeStatus, VibeModeStatus, WorkerAbortResult, WorkerModelResult, WorkerPong, WorkerRequestResult, WorkerStatus } from "@omp-console/protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { PendingDialogKind } from "./guest-ui";
import type { CollabPendingGuestUiRequest } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";

export type StatusLine = WorkerStatus | WorkerPong | WorkerModelResult | WorkerAbortResult | WorkerRequestResult;

export interface StatusSink {
	emit(line: StatusLine): void;
}

/** Coalesces bursts of triggers into one recomputation. */
const STATE_DEBOUNCE_MS = 50;
/** Re-emit cadence while a turn streams. */
const HEARTBEAT_MS = 2000;
const SUMMARY_LIMIT = 240;
const PENDING_QUESTION_LIMIT = 200;

/** Count of live subagents in the subtree under `rootId`; advisors and finished/parked agents are excluded. */
export function countSubtreeAgents(registry: AgentRegistry, rootId: string): number {
	const refs = registry.list();
	const children = new Map<string, string[]>();
	for (const ref of refs) {
		if (!ref.parentId) continue;
		const siblings = children.get(ref.parentId) ?? [];
		siblings.push(ref.id);
		children.set(ref.parentId, siblings);
	}
	const byId = new Map(refs.map(ref => [ref.id, ref]));
	let count = 0;
	const seen = new Set<string>([rootId]);
	const stack = [rootId];
	while (stack.length > 0) {
		const id = stack.pop()!;
		for (const childId of children.get(id) ?? []) {
			if (seen.has(childId)) continue;
			seen.add(childId);
			stack.push(childId);
			const child = byId.get(childId);
			if (child && child.kind === "sub" && child.status === "running") count++;
		}
	}
	return count;
}

function summarize(text: string | undefined, limit = SUMMARY_LIMIT): string | undefined {
	const flat = text?.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function retryAfterMs(message: string | undefined): number | undefined {
	if (!message) return undefined;
	const absolute = /(?:retry\s+at|resets?\s+at)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))/i.exec(message);
	if (absolute) {
		const resetAt = Date.parse(absolute[1]!);
		if (Number.isFinite(resetAt)) return Math.max(0, resetAt - Date.now());
	}
	const match = /(?:retry[-_\s]*after|resets?\s+(?:in|after)|reset\s+(?:in|after))\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)?/i.exec(message);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return undefined;
	const unit = match[2]?.toLowerCase();
	const multiplier = unit === "ms" || unit?.startsWith("millisecond")
		? 1
		: unit === "m" || unit?.startsWith("min")
			? 60_000
			: unit === "h" || unit?.startsWith("hour")
				? 3_600_000
				: 1000;
	return Math.round(value * multiplier);
}

export interface StateReporterOptions {
	session: AgentSession;
	registry: AgentRegistry;
	rootAgentId: string;
	sink: StatusSink;
	isOvernight?: () => boolean;
}

interface PendingDialogSummary {
	kind: "ask" | "approval";
	question: string;
}

export class StateReporter {
	#session: AgentSession;
	readonly #registry: AgentRegistry;
	readonly #rootAgentId: string;
	readonly #sink: StatusSink;
	readonly #isOvernight: (() => boolean) | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#unsubscribeRunState: (() => void) | undefined;
	readonly #unsubscribeRegistry: () => void;
	#unsubscribePause: (() => void) | undefined;
	readonly #pendingDialogs = new Map<number, PendingDialogSummary>();
	readonly #pendingGuestUi = new Map<number, string>();
	#cleanseStatus: CleanseStateSummary | undefined;
	#nextDialogId = 0;
	#lastEventAt = Date.now();
	#lastSignature = "";
	#debounce: Timer | undefined;
	#heartbeat: Timer | undefined;
	#disposed = false;
	#modeStatusProvider: (() => { loopMode: LoopModeStatus; vibeMode: VibeModeStatus; liveMode: LiveModeStatus }) | undefined;

	constructor(options: StateReporterOptions) {
		this.#session = options.session;
		this.#registry = options.registry;
		this.#rootAgentId = options.rootAgentId;
		this.#sink = options.sink;
		this.#isOvernight = options.isOvernight;
		this.#unsubscribeRegistry = this.#registry.onChange(() => this.schedule());
		this.#attach();
	}

	#emitOvernightTurnEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>, text: string | undefined): void {
		let toolCalls = 0;
		let lastAssistant: Extract<AgentSessionEvent, { type: "agent_end" }>["messages"][number] | undefined;
		for (const message of event.messages) {
			if (message.role !== "assistant") continue;
			lastAssistant = message;
			for (const part of message.content) if (part.type === "toolCall") toolCalls++;
		}
		const errorMessage = lastAssistant && "errorMessage" in lastAssistant && typeof lastAssistant.errorMessage === "string"
			? lastAssistant.errorMessage
			: undefined;
		const stopReason = lastAssistant && "stopReason" in lastAssistant && typeof lastAssistant.stopReason === "string"
			? lastAssistant.stopReason
			: "stop";
		const retryAfter = retryAfterMs(errorMessage);
		const lastTurn: Extract<WorkerStatus, { t: "turn-end" }>["lastTurn"] = {
			endedAt: Date.now(),
			stopReason,
			toolCalls,
			textTail: (text ?? "").slice(-500),
			...(errorMessage === undefined ? {} : { errorMessage }),
			...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
		};
		this.#sink.emit({ t: "turn-end", lastTurn });
	}

	#attach(): void {
		const session = this.#session;
		this.#unsubscribePause = agentPauseGate.onChange(() => this.schedule());
		this.#unsubscribeSession = session.subscribe(event => {
			this.#lastEventAt = Date.now();
			if (event.type === "agent_end") {
				this.#sink.emit({
					t: "notify",
					reason: "turn-finished",
					summary: summarize(session.getLastAssistantText()),
				});
				if (event.isTerminal !== false && this.#isOvernight?.()) {
					this.#emitOvernightTurnEnd(event, session.getLastAssistantText());
				}
			}
			this.schedule();
		});
		this.#unsubscribeRunState = session.subscribeRunState(() => this.schedule());
		this.#heartbeat = setInterval(() => {
			if (this.#session.isStreaming) this.#emitState(true);
		}, HEARTBEAT_MS);
		this.#heartbeat.unref();
	}
	setModeStatusProvider(provider: () => { loopMode: LoopModeStatus; vibeMode: VibeModeStatus; liveMode: LiveModeStatus }): void {
		this.#modeStatusProvider = provider;
		this.schedule();
	}

	/** Bind to a different session object (the SDK keeps one; kept for session replacement). */
	rebind(session: AgentSession): void {
		this.#detach();
		this.#session = session;
		this.#attach();
		this.schedule();
	}

	#detach(): void {
		this.#unsubscribeSession?.();
		this.#unsubscribeRunState?.();
		this.#unsubscribePause?.();
		clearInterval(this.#heartbeat);
		this.#unsubscribeSession = undefined;
		this.#unsubscribeRunState = undefined;
		this.#unsubscribePause = undefined;
		this.#heartbeat = undefined;
	}

	/** A guest-facing dialog became pending. */
	dialogOpened(kind: PendingDialogKind, summary: string): number {
		const id = ++this.#nextDialogId;
		this.#pendingDialogs.set(id, { kind: kind === "approval" ? "approval" : "ask", question: summary });
		this.#lastEventAt = Date.now();
		this.#sink.emit({
			t: "notify",
			reason: kind === "approval" ? "needs-approval" : "needs-answer",
			summary: summarize(summary),
		});
		this.schedule();
		return id;
	}

	dialogClosed(id: number): void {
		if (!this.#pendingDialogs.delete(id)) return;
		this.#lastEventAt = Date.now();
		this.schedule();
	}

	/** Keep state reporting aligned with the host's authoritative pending-request set. */
	pendingGuestUiChanged(requests: readonly CollabPendingGuestUiRequest[]): void {
		this.#pendingGuestUi.clear();
		for (const request of requests) this.#pendingGuestUi.set(request.reqId, request.request.title);
		this.#lastEventAt = Date.now();
		this.schedule();
	}

	get pendingDialogs(): number {
		return this.#pendingDialogs.size;
	}
	setCleanseStatus(status: CleanseStateSummary | undefined): void {
		this.#cleanseStatus = status;
		this.schedule();
	}

	schedule(): void {
		if (this.#disposed || this.#debounce) return;
		this.#debounce = setTimeout(() => {
			this.#debounce = undefined;
			this.#emitState(false);
		}, STATE_DEBOUNCE_MS);
	}

	/** Emit the current state immediately (used right after `ready`). */
	flush(): void {
		clearTimeout(this.#debounce);
		this.#debounce = undefined;
		this.#emitState(true);
	}

	#emitState(force: boolean): void {
		if (this.#disposed) return;
		const session = this.#session;
		const modeStatus = this.#modeStatusProvider?.();
		const goal = session.getGoalModeState();
		const model = session.model;
		const pendingDialog = this.#pendingDialogs.values().next().value;
		const pendingGuestQuestion = this.#pendingGuestUi.values().next().value;
		const awaitingAnswer = this.#pendingDialogs.size > 0 || this.#pendingGuestUi.size > 0;
		const status: Extract<WorkerStatus, { t: "state" }> = {
			t: "state",
			state: awaitingAnswer ? "asking" : session.isStreaming ? "streaming" : "idle",
			paused: agentPauseGate.paused,
			pausedAt: agentPauseGate.pausedAt,
			model: model ? `${model.provider}/${model.id}` : undefined,
			thinkingLevel: session.thinkingLevel,
			awaitingAnswer,
			pendingQuestion: summarize(pendingDialog?.question ?? pendingGuestQuestion, PENDING_QUESTION_LIMIT),
			pendingKind: pendingDialog?.kind,
			goalActive: goal?.enabled === true && goal.goal?.status === "active",
			// A paused or budget-limited goal keeps its objective visible; a completed or dropped one is gone.
			goalObjective: goal && goal.goal.status !== "complete" && goal.goal.status !== "dropped" ? goal.goal.objective : undefined,
			agentCount: countSubtreeAgents(this.#registry, this.#rootAgentId),
			lastEventAt: this.#lastEventAt,
			cleanse: this.#cleanseStatus,
			title: session.sessionName,
			loopMode: modeStatus?.loopMode,
			liveMode: modeStatus?.liveMode,
			vibeMode: modeStatus?.vibeMode,
		};
		const { lastEventAt: _lastEventAt, ...rest } = status;
		const signature = JSON.stringify(rest);
		if (!force && signature === this.#lastSignature) return;
		this.#lastSignature = signature;
		this.#sink.emit(status);
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#debounce);
		this.#debounce = undefined;
		this.#detach();
		this.#unsubscribeRegistry();
	}
}
