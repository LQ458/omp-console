/** Gate audit helpers (grand-list 9): filtering and labels for the "Actions in your name" table. */
import type { GateAuditEntry, GateStatusResponse } from "@omp-console/protocol";

export type Verdict = GateAuditEntry["verdict"];
export type GateModeName = keyof GateStatusResponse["modes"];
export type GateMode = GateStatusResponse["modes"][GateModeName];

/** `attention` = everything except `allow`: what the gate asked, denied, or would have. */
export type VerdictFilter = "all" | "attention" | Verdict;

export interface AuditFilters {
	verdict: VerdictFilter;
	/** `all` or one of {@link auditKinds}. */
	kind: string;
	/** Case-insensitive match on summary and target. */
	query: string;
	/** Only this session's rows; null for every session. */
	sessionId: string | null;
}

export const NO_FILTERS: AuditFilters = { verdict: "all", kind: "all", query: "", sessionId: null };

export const VERDICT_FILTERS: ReadonlyArray<{ id: VerdictFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "attention", label: "Needs attention" },
	{ id: "would-ask", label: "Would ask" },
	{ id: "would-deny", label: "Would deny" },
	{ id: "ask", label: "Asked" },
	{ id: "deny", label: "Denied" },
	{ id: "allow", label: "Allowed" },
];

export const VERDICT_LABEL: Record<Verdict, string> = {
	allow: "allowed",
	ask: "asked",
	deny: "denied",
	"would-ask": "would ask",
	"would-deny": "would deny",
};

/** Colour role of a verdict chip. */
export function verdictTone(verdict: Verdict): "ok" | "warn" | "err" {
	if (verdict === "allow") return "ok";
	return verdict === "ask" || verdict === "would-ask" ? "warn" : "err";
}

function matchesVerdict(verdict: Verdict, filter: VerdictFilter): boolean {
	if (filter === "all") return true;
	if (filter === "attention") return verdict !== "allow";
	return verdict === filter;
}

/** Newest first, then every active filter applied. */
export function filterAudit(entries: readonly GateAuditEntry[], filters: AuditFilters): GateAuditEntry[] {
	const query = filters.query.trim().toLowerCase();
	return entries
		.filter(entry => matchesVerdict(entry.verdict, filters.verdict))
		.filter(entry => filters.kind === "all" || entry.kinds.includes(filters.kind))
		.filter(entry => filters.sessionId === null || entry.sessionId === filters.sessionId)
		.filter(
			entry => query === "" || entry.summary.toLowerCase().includes(query) || (entry.target ?? "").toLowerCase().includes(query),
		)
		.sort((a, b) => b.at - a.at);
}

/** Distinct action kinds in the log, alphabetical (email, git push, ...). */
export function auditKinds(entries: readonly GateAuditEntry[]): string[] {
	return [...new Set(entries.flatMap(entry => entry.kinds))].sort((a, b) => a.localeCompare(b));
}

export function verdictCounts(entries: readonly GateAuditEntry[]): Record<Verdict, number> {
	const counts: Record<Verdict, number> = { allow: 0, ask: 0, deny: 0, "would-ask": 0, "would-deny": 0 };
	for (const entry of entries) counts[entry.verdict]++;
	return counts;
}

export const MODE_NAMES: readonly GateModeName[] = ["interactive", "subagent", "scheduled"];

export const MODE_TITLE: Record<GateModeName, string> = {
	interactive: "Interactive sessions",
	subagent: "Subagents",
	scheduled: "Scheduled jobs",
};

export const MODE_NOTE: Record<GateMode, string> = {
	shadow: "Logs what it would ask or deny. Blocks nothing.",
	enforce: "Asks before a risky action; Decline is the default.",
	"deny-park": "Refuses without asking.",
};

/** Modes are the gate's own config; omp console shows them and never writes them. */
export const MODES_READ_ONLY_NOTE =
	"Set in the gate's own config, read-only here. omp console keeps shadow everywhere until the numbers justify enforcement.";

/** `12s ago`, `4 min ago`, `3 h ago`, else the date. */
export function auditTime(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
	return new Date(at).toISOString().slice(0, 10);
}
