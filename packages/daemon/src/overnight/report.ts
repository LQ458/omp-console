import type { OvernightEvent, OvernightPhase, OvernightState } from "@omp-console/protocol";

function durationText(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remaining = seconds % 60;
	return `${hours}h ${minutes}m ${remaining}s`;
}

function count(events: readonly OvernightEvent[], ...kinds: OvernightEvent["kind"][]): number {
	return events.filter(event => kinds.includes(event.kind)).length;
}

const TERMINAL_PHASES: readonly OvernightPhase[] = ["complete", "deadline", "blocked", "stopped"];

/** Builds the durable morning report from controller events and the final assistant text tail. */
export function renderOvernightReport(state: OvernightState, endedAt: number, finalTextTail: string): string {
	const events = state.events;
	const autoAnswers = events.filter(event => event.kind === "auto-answer");
	const blockers = events.filter(event => event.kind === "error" || event.kind === "blocked");
	const finalPhase = TERMINAL_PHASES.includes(state.phase) ? state.phase : "blocked";
	const finalResult =
		finalPhase === "complete" ? "Completed"
			: finalPhase === "deadline" ? "Stopped at the end time"
				: finalPhase === "blocked" ? "Blocked"
					: "Stopped";
	const lines = [
		"# Overnight run report",
		"",
		`- Started: ${new Date(state.startedAt).toLocaleString()}`,
		`- Ended: ${new Date(endedAt).toLocaleString()}`,
		`- Duration: ${durationText(endedAt - state.startedAt)}`,
		`- Result: ${finalResult}`,
		`- Continued work: ${state.continuations}`,
		`- Retries: ${count(events, "retry-wait")}`,
		`- Waits for usage limits: ${count(events, "usage-wait")}`,
		`- Questions answered for you: ${autoAnswers.length}`,
		`- Stalled attempts stopped: ${count(events, "stall-abort")}`,
		`- Session restarts: ${count(events, "worker-restart")}`,
		"",
		"## Questions answered for you",
		...(autoAnswers.length === 0 ? ["- None"] : autoAnswers.map(event => `- ${event.detail}`)),
		"",
		"## Problems found",
		...(blockers.length === 0 ? ["- None recorded"] : blockers.map(event => `- ${event.detail}`)),
		"",
		"## Final response",
		finalTextTail.trim() ? `\n${finalTextTail.trim()}` : "\n(No final response was available.)",
		"",
	];
	return lines.join("\n");
}
