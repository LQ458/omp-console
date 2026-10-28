export type OvernightQuiet = "normal" | "quiet" | "silent";

export interface OvernightPolicy {
	deadline: string;
	askTimeoutSec: number;
	quiet: OvernightQuiet;
	maxIdleContinuations: number;
	keepAwake: boolean;
}

export type OvernightPhase =
	| "running"
	| "continuing"
	| "waiting-retry"
	| "waiting-usage"
	| "recovering"
	| "wrapping-up"
	| "complete"
	| "deadline"
	| "blocked"
	| "stopped";

export type OvernightEventKind =
	| "start"
	| "continue"
	| "auto-answer"
	| "error"
	| "retry-wait"
	| "usage-wait"
	| "stall-abort"
	| "worker-restart"
	| "daemon-resume"
	| "wrap-up"
	| "complete"
	| "deadline"
	| "blocked"
	| "stopped";

export interface OvernightEvent {
	at: number;
	kind: OvernightEventKind;
	detail: string;
}

export interface OvernightState {
	sessionId: string;
	startedAt: number;
	policy: OvernightPolicy;
	phase: OvernightPhase;
	continuations: number;
	idleContinuations: number;
	nextActionAt?: number;
	events: OvernightEvent[];
	report?: string;
}

export interface OvernightTemplate {
	prompt: string;
	policy: Omit<OvernightPolicy, "deadline"> & { deadlineLocalTime: string };
}

export interface PreflightCheck {
	id: string;
	label: string;
	status: "ok" | "warn" | "fail";
	detail: string;
	fix?: string;
}

export interface StartOvernightRequest {
	task: string;
	policy?: Partial<OvernightPolicy>;
	prompt?: string;
}

export interface WorkerOvernightOptions {
	askTimeoutSec: number;
	quiet: OvernightQuiet;
}

export interface OvernightLastTurn {
	endedAt: number;
	stopReason: string;
	errorMessage?: string;
	toolCalls: number;
	textTail: string;
	retryAfterMs?: number;
}

export interface OvernightAutoAnswer {
	at: number;
	question: string;
	answer: string;
}

export interface OvernightSummary {
	phase: OvernightPhase;
	deadline: string;
	continuations: number;
}

export const OVERNIGHT_COMPLETE_MARKER = "OVERNIGHT-COMPLETE";

export const DEFAULT_OVERNIGHT_POLICY: OvernightTemplate["policy"] = {
	deadlineLocalTime: "09:30",
	askTimeoutSec: 60,
	quiet: "quiet",
	maxIdleContinuations: 3,
	keepAwake: true,
};
