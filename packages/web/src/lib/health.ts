/** Reduces the daemon health feed to what the UI shows. */
import type { DaemonHealth, SessionSummary, WorkerHealth } from "@omp-console/protocol";
import type { DeckApiError } from "./api";

export type HealthLevel = "ok" | "stalled" | "offline" | "unknown";

export interface HealthView {
	level: HealthLevel;
	/** Tooltip text. */
	title: string;
}

export function workerFor(health: DaemonHealth | null, sessionId: string | null): WorkerHealth | undefined {
	if (!health || sessionId === null) return undefined;
	return health.workers.find(w => w.sessionId === sessionId);
}

/** `listError` set means the daemon (or the network) is unreachable or refusing us. */
export function healthView(
	health: DaemonHealth | null,
	listError: DeckApiError | null,
	sessionId: string | null,
): HealthView {
	if (listError) {
		return {
			level: "offline",
			title: listError.kind === "auth" ? "daemon refused this device" : "daemon unreachable",
		};
	}
	if (!health) return { level: "unknown", title: "health not reported yet" };
	const worker = workerFor(health, sessionId);
	if (worker?.stalled) {
		return {
			level: "stalled",
			title: `session stalled: no event for over ${Math.round(health.stalledAfterMs / 1000)}s while streaming`,
		};
	}
	if (worker) {
		const mb = Math.round(worker.rssBytes / (1024 * 1024));
		return { level: "ok", title: `worker pid ${worker.pid} · ${mb} MB · ${worker.restarts} restarts` };
	}
	return { level: "ok", title: `daemon up · ${health.workers.length} workers · ${health.guests} guests` };
}

export interface HealthRow {
	sessionId: string;
	title: string;
	state: WorkerHealth["state"];
	stalled: boolean;
	restarts: number;
	rssBytes: number;
	pid: number;
	/** Time since the worker's last event. */
	lastEventAgeMs: number;
}

/** One row per worker, stalled and crashed first; titles come from the live session list. */
export function healthRows(
	health: DaemonHealth | null,
	live: readonly SessionSummary[],
	now: number,
): HealthRow[] {
	if (!health) return [];
	const titles = new Map(live.map(session => [session.id, session.title?.trim() || ""]));
	const rows = health.workers.map(worker => ({
		sessionId: worker.sessionId,
		title: titles.get(worker.sessionId) || worker.sessionId.slice(0, 8),
		state: worker.state,
		stalled: worker.stalled,
		restarts: worker.restarts,
		rssBytes: worker.rssBytes,
		pid: worker.pid,
		lastEventAgeMs: Math.max(0, now - worker.lastEventAt),
	}));
	const rank = (row: HealthRow): number => (row.state === "crashed" ? 0 : row.stalled ? 1 : 2);
	return rows.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}
