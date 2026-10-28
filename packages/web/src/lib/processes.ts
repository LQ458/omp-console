import type { ProcessInfo } from "@omp-console/protocol";
import { fmtAge, fmtBytes } from "./format";

export type ProcessAction = "stop" | "ask-stop" | "kill";

export function processKindLabel(kind: ProcessInfo["kind"]): string {
	return kind === "omp-console-worker" ? "omp-console worker" : kind === "omp-terminal" ? "terminal omp" : kind === "omp-lsp" ? "lsp mux" : kind === "omp-broker" ? "broker" : kind === "omp-eval" ? "eval worker" : kind === "omp-browser" ? "browser worker" : kind === "omp-console-daemon" ? "omp-console daemon" : "helper";
}

export function processAction(process: ProcessInfo): ProcessAction | null {
	if (process.kind === "omp-console-worker") return "stop";
	if (process.kind === "omp-terminal") return "ask-stop";
	if (process.state === "orphan") return "kill";
	return null;
}

export function processActionLabel(action: ProcessAction): string {
	return action === "stop" ? "Stop" : action === "ask-stop" ? "Ask to stop (SIGTERM)" : "Kill orphan";
}

export function processMatches(process: ProcessInfo, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (needle === "") return true;
	return [process.kind, processKindLabel(process.kind), process.command, process.cwd, process.sessionId, process.state, process.reason]
		.filter((value): value is string => value !== undefined)
		.some(value => value.toLowerCase().includes(needle));
}

export async function confirmAndStopProcess(
	process: ProcessInfo,
	confirm: (message: string) => boolean,
	stop: (pid: number) => Promise<void>,
): Promise<"cancelled" | "stopped" | "unavailable"> {
	const action = processAction(process);
	if (action === null) return "unavailable";
	const label = processActionLabel(action);
	const detail =
		action === "ask-stop"
			? "This sends SIGTERM to a terminal omp session that omp console did not start."
			: action === "kill"
				? "This sends SIGTERM and may escalate after the grace period."
				: "This stops the omp console worker gracefully.";
	if (!confirm(`${label} PID ${process.pid}? ${detail}`)) return "cancelled";
	await stop(process.pid);
	return "stopped";
}

export function filterProcesses(processes: readonly ProcessInfo[], query: string, state: ProcessInfo["state"] | "all" = "all"): ProcessInfo[] {
	return processes.filter(process => (state === "all" || process.state === state) && processMatches(process, query));
}

export function totalRssBytes(processes: readonly ProcessInfo[]): number {
	return processes.reduce((total, process) => total + Math.max(0, process.rssBytes), 0);
}

export function processAge(process: ProcessInfo, now = Date.now()): string {
	return fmtAge(Math.max(0, now - process.startedAt));
}

export function processRss(process: ProcessInfo): string {
	return fmtBytes(process.rssBytes);
}

export function policyHours(idleStopAfterMs: number | null): string {
	return idleStopAfterMs === null ? "off" : String(idleStopAfterMs / 3_600_000);
}
